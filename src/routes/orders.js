import express from "express";
import auth from "../middleware/auth.js";
import authorize from "../middleware/authorize.js";
import pool from "../db.js";
import { deductInventoryForOrder } from "./inventory.js";
import {
  LOYALTY_MIN_REDEEM_POINTS,
  LOYALTY_POINT_VALUE,
  computeEarnedPoints,
  computeMaxRedeemablePoints,
} from "../config/loyalty.js";

const router = express.Router();

const allowedOrderTypes = new Set(["DINE-IN", "TAKEAWAY", "DELIVERY", "OTHER"]);
const allowedChannels = new Set(["POS", "PHONE", "WHATSAPP", "WEB", "OTHER"]);

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "").trim();
}

function toSafeOrderType(orderType) {
  const normalized = String(orderType || "DINE-IN").trim().toUpperCase();
  return allowedOrderTypes.has(normalized) ? normalized : "OTHER";
}

function toSafeChannel(channel) {
  const normalized = String(channel || "POS").trim().toUpperCase();
  return allowedChannels.has(normalized) ? normalized : "OTHER";
}

function parseMoney(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.round(parsed * 100) / 100;
}

// POS order creation (both ADMIN and CASHIER)
router.post("/", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  const {
    total,
    payment_method: paymentMethod,
    items = [],
    customer_id: customerIdRaw,
    customer_name: customerNameRaw,
    customer_phone: customerPhoneRaw,
    order_type: orderTypeRaw,
    channel: channelRaw,
    loyalty_points_redeemed: loyaltyPointsRedeemedRaw = 0,
    total_before_loyalty: totalBeforeLoyaltyRaw,
  } = req.body;

  const parsedTotal = parseMoney(total, NaN);
  if (!Number.isFinite(parsedTotal) || parsedTotal < 0) {
    return res.status(400).json({ message: "Total must be a valid amount" });
  }
  if (!paymentMethod || !Array.isArray(items) || items.length === 0) {
    return res
      .status(400)
      .json({ message: "Payment method and items are required" });
  }

  const requestedRedeemPoints = Number.parseInt(loyaltyPointsRedeemedRaw, 10);
  if (!Number.isFinite(requestedRedeemPoints) || requestedRedeemPoints < 0) {
    return res.status(400).json({ message: "Invalid loyalty points redemption" });
  }

  let totalBeforeLoyalty = parseMoney(totalBeforeLoyaltyRaw, parsedTotal);
  if (totalBeforeLoyalty < parsedTotal) {
    totalBeforeLoyalty = parsedTotal;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let customerId = customerIdRaw ? String(customerIdRaw).trim() : null;
    let customerName = customerNameRaw ? String(customerNameRaw).trim() : null;
    let customerPhone = normalizePhone(customerPhoneRaw);
    const orderType = toSafeOrderType(orderTypeRaw);
    const channel = toSafeChannel(channelRaw);

    let loyaltyPointsRedeemed = 0;
    let loyaltyDiscountAmount = 0;
    let pointsEarned = 0;

    if (customerId) {
      const customerRes = await client.query(
        `SELECT id, full_name, phone, loyalty_points
         FROM customers
         WHERE id = $1 AND is_active = true
         FOR UPDATE`,
        [customerId]
      );
      if (!customerRes.rows[0]) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: "Selected customer does not exist or is inactive" });
      }

      const customer = customerRes.rows[0];
      if (!customerName) {
        customerName = customer.full_name;
      }
      if (!customerPhone) {
        customerPhone = customer.phone;
      }

      if (requestedRedeemPoints > 0) {
        if (requestedRedeemPoints < LOYALTY_MIN_REDEEM_POINTS) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            message: `Minimum ${LOYALTY_MIN_REDEEM_POINTS} points required for redemption`,
          });
        }

        const availablePoints = Number.parseInt(customer.loyalty_points || 0, 10);
        const maxRedeemable = computeMaxRedeemablePoints(
          availablePoints,
          totalBeforeLoyalty
        );

        if (requestedRedeemPoints > availablePoints) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "Customer does not have enough loyalty points" });
        }
        if (requestedRedeemPoints > maxRedeemable) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            message: `Only ${maxRedeemable} points can be redeemed for this bill`,
            max_redeemable_points: maxRedeemable,
          });
        }

        loyaltyPointsRedeemed = requestedRedeemPoints;
        loyaltyDiscountAmount = parseMoney(loyaltyPointsRedeemed * LOYALTY_POINT_VALUE);
      }
    } else if (requestedRedeemPoints > 0) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ message: "Select a customer before redeeming loyalty points" });
    }

    const computedTotal = parseMoney(totalBeforeLoyalty - loyaltyDiscountAmount);
    if (Math.abs(computedTotal - parsedTotal) > 0.11) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "Order total does not match loyalty redemption calculation",
      });
    }

    pointsEarned = customerId ? computeEarnedPoints(computedTotal) : 0;

    const orderResult = await client.query(
      `INSERT INTO orders
        (
          total,
          payment_method,
          customer_id,
          customer_name,
          customer_phone,
          order_type,
          channel,
          loyalty_points_redeemed,
          loyalty_discount_amount
        )
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        computedTotal,
        paymentMethod,
        customerId,
        customerName,
        customerPhone || null,
        orderType,
        channel,
        loyaltyPointsRedeemed,
        loyaltyDiscountAmount,
      ]
    );
    const orderId = orderResult.rows[0].id;

    const insertItems = items.map((item) =>
      client.query(
        "INSERT INTO order_items (order_id, product_id, qty, price) VALUES ($1, $2, $3, $4)",
        [orderId, item.product_id, item.qty, item.price]
      )
    );
    await Promise.all(insertItems);

    if (customerId) {
      if (loyaltyPointsRedeemed > 0) {
        await client.query(
          `INSERT INTO customer_loyalty_txns (customer_id, order_id, points_change, reason)
           VALUES ($1, $2, $3, $4)`,
          [customerId, orderId, -loyaltyPointsRedeemed, "ORDER_REDEEMED"]
        );
      }
      if (pointsEarned > 0) {
        await client.query(
          `INSERT INTO customer_loyalty_txns (customer_id, order_id, points_change, reason)
           VALUES ($1, $2, $3, $4)`,
          [customerId, orderId, pointsEarned, "ORDER_EARNED"]
        );
      }

      await client.query(
        `UPDATE customers c
         SET total_orders = stats.total_orders,
             total_spent = stats.total_spent,
             last_order_at = stats.last_order_at,
             loyalty_points = GREATEST(0, COALESCE(c.loyalty_points, 0) - $2 + $3),
             updated_at = NOW()
         FROM (
           SELECT
             COUNT(*)::int AS total_orders,
             COALESCE(SUM(total), 0)::numeric(12,2) AS total_spent,
             MAX(created_at) AS last_order_at
           FROM orders
           WHERE customer_id = $1
         ) stats
         WHERE c.id = $1`,
        [customerId, loyaltyPointsRedeemed, pointsEarned]
      );
    }

    await client.query("COMMIT");

    // Deduct inventory automatically
    try {
      await deductInventoryForOrder(orderId, items);
    } catch (invErr) {
      console.error("Inventory deduction failed (non-critical):", invErr);
      // Don't fail the order if inventory deduction fails
    }

    return res.status(201).json({
      id: orderId,
      total: computedTotal,
      loyalty_points_redeemed: loyaltyPointsRedeemed,
      loyalty_points_earned: pointsEarned,
      loyalty_discount_amount: loyaltyDiscountAmount,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Order create failed:", err);
    return res.status(500).json({ message: "Could not create order" });
  } finally {
    client.release();
  }
});

export default router;
