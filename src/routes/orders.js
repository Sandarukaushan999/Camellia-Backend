import express from "express";
import bcrypt from "bcrypt";
import auth from "../middleware/auth.js";
import authorize from "../middleware/authorize.js";
import pool from "../db.js";
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

function formatInvoiceNumber(orderId) {
  const parsed = Number.parseInt(orderId, 10);
  const safeId = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  return `VOXO${String(safeId).padStart(6, "0")}`;
}

function parseBranchId(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeApprovalPin(value) {
  return String(value || "")
    .replace(/[^\d]/g, "")
    .slice(0, 12);
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 50);
}

async function resolveActiveBranchId(client, requestedBranchId = 1) {
  const branchId = parseBranchId(requestedBranchId, 1);
  const branchRes = await client.query(
    `SELECT id
     FROM branches
     WHERE id = $1
       AND is_active = TRUE
     LIMIT 1`,
    [branchId]
  );
  if (branchRes.rows[0]) {
    return Number(branchRes.rows[0].id);
  }

  const fallbackRes = await client.query(
    `SELECT id
     FROM branches
     WHERE is_active = TRUE
     ORDER BY id ASC
     LIMIT 1`
  );
  return Number(fallbackRes.rows[0]?.id || 1);
}

async function resolveSensitiveActionApproval(client, req) {
  const requestedById = req.user?.id ? String(req.user.id) : null;
  const requestedByRole = req.user?.role ? String(req.user.role) : null;
  const managerPin = normalizeApprovalPin(req.body?.manager_pin);
  const managerUsername = normalizeUsername(req.body?.manager_username);

  if (requestedByRole === "ADMIN" && !managerPin) {
    return {
      ok: true,
      approval_mode: "ADMIN_SESSION",
      approved_by: requestedById,
      approved_by_username: req.user?.username || null,
      requested_by: requestedById,
      requested_by_role: requestedByRole,
    };
  }

  if (!managerPin || managerPin.length < 4) {
    return {
      ok: false,
      status: 400,
      message: "manager_pin must be at least 4 digits",
    };
  }

  const params = [];
  let whereSql = `WHERE role = 'ADMIN' AND "isActive" = TRUE`;
  if (managerUsername) {
    params.push(managerUsername);
    whereSql += ` AND LOWER(username) = $${params.length}`;
  }

  const adminUsersRes = await client.query(
    `SELECT
       id::text AS id,
       username,
       approval_pin_hash
     FROM users
     ${whereSql}
     ORDER BY id ASC`,
    params
  );
  const adminUsers = adminUsersRes.rows;

  for (const admin of adminUsers) {
    const hash = String(admin.approval_pin_hash || "").trim();
    if (!hash) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const isMatch = await bcrypt.compare(managerPin, hash);
    if (isMatch) {
      return {
        ok: true,
        approval_mode: "MANAGER_PIN",
        approved_by: String(admin.id),
        approved_by_username: admin.username,
        requested_by: requestedById,
        requested_by_role: requestedByRole,
      };
    }
  }

  const envPinHash = String(process.env.MANAGER_APPROVAL_PIN_HASH || "").trim();
  if (envPinHash) {
    const isEnvHashMatch = await bcrypt.compare(managerPin, envPinHash);
    if (isEnvHashMatch) {
      return {
        ok: true,
        approval_mode: "ENV_MANAGER_PIN_HASH",
        approved_by: null,
        approved_by_username: managerUsername || null,
        requested_by: requestedById,
        requested_by_role: requestedByRole,
      };
    }
  }

  const envPin = normalizeApprovalPin(process.env.MANAGER_APPROVAL_PIN);
  if (envPin && managerPin === envPin) {
    return {
      ok: true,
      approval_mode: "ENV_MANAGER_PIN",
      approved_by: null,
      approved_by_username: managerUsername || null,
      requested_by: requestedById,
      requested_by_role: requestedByRole,
    };
  }

  return {
    ok: false,
    status: 403,
    message: "Manager PIN approval failed",
  };
}

let productIngredientQuantityExprPromise = null;

async function getProductIngredientQuantityExpr(clientOrPool = pool) {
  if (!productIngredientQuantityExprPromise) {
    productIngredientQuantityExprPromise = (async () => {
      const { rows } = await clientOrPool.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'product_ingredients'`
      );
      const columns = new Set(rows.map((row) => row.column_name));
      if (columns.has("quantity_required")) {
        return "pi.quantity_required";
      }
      if (columns.has("quantity")) {
        return "pi.quantity";
      }
      return "0";
    })();
  }
  return productIngredientQuantityExprPromise;
}

async function adjustInventoryInTransaction(client, items, direction = "DEDUCT") {
  const quantityExpr = await getProductIngredientQuantityExpr(client);
  const sign = direction === "RESTOCK" ? 1 : -1;

  for (const item of items) {
    const productId = String(item?.product_id || item?.id || "").trim();
    const orderQty = Number.parseFloat(item?.qty || 0);
    if (!productId || !Number.isFinite(orderQty) || orderQty <= 0) {
      continue;
    }

    const { rows: ingredients } = await client.query(
      `SELECT inventory_item_id, ${quantityExpr} AS quantity
       FROM product_ingredients pi
       WHERE pi.product_id::text = $1`,
      [productId]
    );

    for (const ing of ingredients) {
      const qtyPerProduct = Number.parseFloat(ing.quantity || 0);
      if (!Number.isFinite(qtyPerProduct) || qtyPerProduct <= 0) {
        continue;
      }
      const delta = parseMoney(qtyPerProduct * orderQty * sign, 0);
      if (!Number.isFinite(delta) || delta === 0) {
        continue;
      }

      if (direction === "RESTOCK") {
        await client.query(
          `UPDATE inventory_items
           SET current_stock = COALESCE(current_stock, 0) + $1,
               updated_at = NOW()
           WHERE id = $2`,
          [Math.abs(delta), ing.inventory_item_id]
        );
      } else {
        await client.query(
          `UPDATE inventory_items
           SET current_stock = GREATEST(0, COALESCE(current_stock, 0) - $1),
               updated_at = NOW()
           WHERE id = $2`,
          [Math.abs(delta), ing.inventory_item_id]
        );
      }
    }
  }
}

async function writeOrderAudit(clientOrPool, user, action, entityId, payload = {}) {
  await clientOrPool.query(
    `INSERT INTO audit_logs (action, entity_type, entity_id, actor_id, actor_role, payload)
     VALUES ($1, 'order', $2, $3, $4, $5::jsonb)`,
    [
      String(action || "ORDER_ACTION").slice(0, 80),
      String(entityId || ""),
      user?.id ? String(user.id) : null,
      user?.role ? String(user.role) : null,
      JSON.stringify(payload),
    ]
  );
}

function parsePositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function formatHeldInvoiceNumber(heldOrderId) {
  const parsed = Number.parseInt(heldOrderId, 10);
  const safeId = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  return `VOXO${String(safeId).padStart(6, "0")}`;
}

function normalizeHeldItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      const productId = Number.parseInt(item?.product_id ?? item?.id, 10);
      const qty = Number.parseFloat(item?.qty);
      const price = parseMoney(item?.price, NaN);
      const name = String(item?.name || "").trim().slice(0, 120);
      const category = item?.category
        ? String(item.category).trim().slice(0, 50)
        : null;

      if (!Number.isFinite(productId) || !Number.isFinite(qty) || qty <= 0) {
        return null;
      }
      if (!Number.isFinite(price) || price < 0) {
        return null;
      }

      return {
        product_id: productId,
        name: name || `Item ${productId}`,
        qty: Math.round(qty * 1000) / 1000,
        price,
        category: category || null,
      };
    })
    .filter(Boolean);
}

function normalizeHeldMeta(metaInput) {
  if (!metaInput || typeof metaInput !== "object" || Array.isArray(metaInput)) {
    return {};
  }

  return {
    payment_method: metaInput.payment_method
      ? String(metaInput.payment_method).trim().toUpperCase().slice(0, 20)
      : null,
    discount_type: metaInput.discount_type
      ? String(metaInput.discount_type).trim().toUpperCase().slice(0, 20)
      : null,
    discount_value: parseMoney(metaInput.discount_value, 0),
    note: metaInput.note ? String(metaInput.note).trim().slice(0, 500) : null,
  };
}

function mapHeldOrderRow(row) {
  const meta =
    row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
      ? row.meta
      : {};
  const heldId = Number(row.id || 0) || row.id;
  const invoiceNumber =
    String(meta.invoice_number || "").trim() || formatHeldInvoiceNumber(heldId);

  return {
    id: row.id,
    branch_id: row.branch_id ? Number(row.branch_id) : null,
    order_type: row.order_type,
    table_number: row.table_number,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    invoice_number: invoiceNumber,
    items: Array.isArray(row.items) ? row.items : [],
    meta,
    source: meta.source ? String(meta.source).trim().toUpperCase() : null,
    payment_method: meta.payment_method || null,
    note: meta.note || null,
    reference: meta.reference || null,
    created_at: row.created_at,
    created_by: row.created_by,
    created_by_username: row.created_by_username || null,
  };
}

// Held orders list (both ADMIN and CASHIER)
router.get("/held", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 50, 1, 200);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const hasBranchFilter = Number.isFinite(branchId);
    const { rows } = await pool.query(
      `SELECT
         ho.id,
         ho.branch_id,
         ho.order_type,
         ho.table_number,
         ho.customer_name,
         ho.customer_phone,
         ho.items,
         ho.meta,
         ho.created_at,
         ho.created_by,
         u.username AS created_by_username
       FROM held_orders ho
       LEFT JOIN users u ON u.id::text = ho.created_by
       ${hasBranchFilter ? "WHERE COALESCE(ho.branch_id, 1) = $2" : ""}
       ORDER BY ho.created_at DESC
       LIMIT $1`,
      hasBranchFilter ? [limit, branchId] : [limit]
    );

    return res.json(rows.map(mapHeldOrderRow));
  } catch (err) {
    console.error("Held order list failed:", err);
    return res.status(500).json({ message: "Failed to load held orders" });
  }
});

// Create held order (both ADMIN and CASHIER)
router.post("/held", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderType = toSafeOrderType(req.body?.order_type);
    const branchId = await resolveActiveBranchId(client, req.body?.branch_id);
    const tableNumber = req.body?.table_number
      ? String(req.body.table_number).trim().slice(0, 50)
      : null;
    const customerName = req.body?.customer_name
      ? String(req.body.customer_name).trim().slice(0, 120)
      : null;
    const customerPhone = normalizePhone(req.body?.customer_phone) || null;
    const items = normalizeHeldItems(req.body?.items);
    const meta = normalizeHeldMeta(req.body?.meta);
    const createdBy = req.user?.id ? String(req.user.id).trim() : null;

    if (items.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "At least one valid item is required to hold an order" });
    }

    const { rows } = await client.query(
      `INSERT INTO held_orders (
         branch_id,
         order_type,
         table_number,
         customer_name,
         customer_phone,
         items,
         meta,
         created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
       RETURNING id, branch_id, order_type, table_number, customer_name, customer_phone, items, meta, created_at, created_by`,
      [
        branchId,
        orderType,
        tableNumber || null,
        customerName || null,
        customerPhone,
        JSON.stringify(items),
        JSON.stringify(meta),
        createdBy || null,
      ]
    );

    await writeOrderAudit(client, req.user, "ORDER_HELD", rows[0]?.id, {
      branch_id: branchId,
      order_type: orderType,
      items_count: items.length,
    });

    await client.query("COMMIT");
    return res.status(201).json(mapHeldOrderRow(rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Held order create failed:", err);
    return res.status(500).json({ message: "Failed to hold order" });
  } finally {
    client.release();
  }
});

// Recall held order and remove it from held queue
router.post(
  "/held/:id/recall",
  auth,
  authorize("ADMIN", "CASHIER"),
  async (req, res) => {
    const heldId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(heldId) || heldId <= 0) {
      return res.status(400).json({ message: "Invalid held order id" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT
           ho.id,
           ho.branch_id,
           ho.order_type,
           ho.table_number,
           ho.customer_name,
           ho.customer_phone,
           ho.items,
           ho.meta,
           ho.created_at,
           ho.created_by,
           (
             SELECT u.username
             FROM users u
             WHERE u.id::text = ho.created_by
             LIMIT 1
           ) AS created_by_username
         FROM held_orders ho
         WHERE ho.id = $1
         FOR UPDATE`,
        [heldId]
      );

      if (!rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Held order not found" });
      }

      await client.query("DELETE FROM held_orders WHERE id = $1", [heldId]);
      await writeOrderAudit(client, req.user, "ORDER_HELD_RECALL", heldId, {
        branch_id: rows[0]?.branch_id ? Number(rows[0].branch_id) : null,
      });
      await client.query("COMMIT");
      return res.json({ held_order: mapHeldOrderRow(rows[0]) });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Held order recall failed:", err);
      return res.status(500).json({ message: "Failed to recall held order" });
    } finally {
      client.release();
    }
  }
);

// Delete held order without recalling
router.delete("/held/:id", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  const heldId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(heldId) || heldId <= 0) {
    return res.status(400).json({ message: "Invalid held order id" });
  }

  try {
    const { rowCount } = await pool.query("DELETE FROM held_orders WHERE id = $1", [heldId]);
    if (rowCount === 0) {
      return res.status(404).json({ message: "Held order not found" });
    }
    await writeOrderAudit(pool, req.user, "ORDER_HELD_DELETE", heldId, {});
    return res.json({ message: "Held order deleted" });
  } catch (err) {
    console.error("Held order delete failed:", err);
    return res.status(500).json({ message: "Failed to delete held order" });
  }
});

// Order detail
router.get("/:id", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  const orderId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000_000);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ message: "Invalid order id" });
  }

  try {
    const orderRes = await pool.query(
      `SELECT
         id,
         invoice_number,
         total,
         payment_method,
         customer_id,
         customer_name,
        customer_phone,
        branch_id,
        order_type,
        channel,
        loyalty_points_redeemed,
        loyalty_discount_amount,
        manual_discount_amount,
        total_discount_amount,
        status,
        refunded_amount,
        void_reason,
        refund_reason,
         created_at
       FROM orders
       WHERE id = $1`,
      [orderId]
    );
    const order = orderRes.rows[0];
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const itemsRes = await pool.query(
      `SELECT oi.id, oi.product_id, p.name, oi.qty, oi.price
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.id ASC`,
      [orderId]
    );

    return res.json({
      ...order,
      invoice_number:
        String(order.invoice_number || "").trim() || formatInvoiceNumber(order.id),
      branch_id: order.branch_id ? Number(order.branch_id) : null,
      total: parseFloat(order.total || 0),
      refunded_amount: parseFloat(order.refunded_amount || 0),
      loyalty_discount_amount: parseFloat(order.loyalty_discount_amount || 0),
      manual_discount_amount: parseFloat(order.manual_discount_amount || 0),
      total_discount_amount: parseFloat(order.total_discount_amount || 0),
      items: itemsRes.rows.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        name: item.name || `Item ${item.product_id}`,
        qty: parseFloat(item.qty || 0),
        price: parseFloat(item.price || 0),
      })),
    });
  } catch (err) {
    console.error("Order detail fetch failed:", err);
    return res.status(500).json({ message: "Failed to fetch order details" });
  }
});

// Void order
router.post("/:id/void", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  const orderId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000_000);
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 500) : null;
  const restock = req.body?.restock === true;
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ message: "Invalid order id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query(
      `SELECT id, total, status, refunded_amount
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId]
    );
    const order = orderRes.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order not found" });
    }
    if (String(order.status || "").toUpperCase() === "VOIDED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Order is already voided" });
    }

    const approval = await resolveSensitiveActionApproval(client, req);
    if (!approval.ok) {
      await client.query("ROLLBACK");
      return res.status(approval.status || 403).json({ message: approval.message });
    }

    const itemsRes = await client.query(
      `SELECT product_id, qty, price
       FROM order_items
       WHERE order_id = $1`,
      [orderId]
    );

    if (restock) {
      await adjustInventoryInTransaction(client, itemsRes.rows, "RESTOCK");
    }

    const refundFull = parseMoney(order.total || 0, 0);
    const { rows } = await client.query(
      `UPDATE orders
       SET status = 'VOIDED',
           refunded_amount = GREATEST(COALESCE(refunded_amount, 0), $2),
           void_reason = COALESCE($3, void_reason)
       WHERE id = $1
       RETURNING id, status, refunded_amount, void_reason`,
      [orderId, refundFull, reason]
    );

    await writeOrderAudit(client, req.user, "ORDER_VOID", orderId, {
      reason,
      restocked: restock,
      refunded_amount: refundFull,
      approval_mode: approval.approval_mode,
      approved_by: approval.approved_by,
      approved_by_username: approval.approved_by_username,
      requested_by: approval.requested_by,
      requested_by_role: approval.requested_by_role,
    });

    await client.query("COMMIT");
    return res.json({
      message: "Order voided successfully",
      order: {
        ...rows[0],
        refunded_amount: parseFloat(rows[0]?.refunded_amount || 0),
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Order void failed:", err);
    return res.status(500).json({ message: "Failed to void order" });
  } finally {
    client.release();
  }
});

// Refund order (partial/full)
router.post("/:id/refund", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  const orderId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000_000);
  const amount = parseMoney(req.body?.amount, NaN);
  const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 500) : null;
  const restock = req.body?.restock === true;

  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ message: "Invalid order id" });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: "amount must be a positive number" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query(
      `SELECT id, total, status, refunded_amount
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId]
    );
    const order = orderRes.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order not found" });
    }
    if (String(order.status || "").toUpperCase() === "VOIDED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Voided orders cannot be refunded" });
    }

    const approval = await resolveSensitiveActionApproval(client, req);
    if (!approval.ok) {
      await client.query("ROLLBACK");
      return res.status(approval.status || 403).json({ message: approval.message });
    }

    const orderTotal = parseMoney(order.total, 0);
    const refundedBefore = parseMoney(order.refunded_amount, 0);
    const refundableRemaining = parseMoney(orderTotal - refundedBefore, 0);
    if (amount > refundableRemaining) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "Refund amount exceeds remaining refundable value",
        refundable_remaining: refundableRemaining,
      });
    }

    if (restock) {
      const itemsRes = await client.query(
        `SELECT product_id, qty, price
         FROM order_items
         WHERE order_id = $1`,
        [orderId]
      );
      await adjustInventoryInTransaction(client, itemsRes.rows, "RESTOCK");
    }

    const refundedAfter = parseMoney(refundedBefore + amount, 0);
    const isFull = refundedAfter >= orderTotal - 0.009;
    const nextStatus = isFull ? "FULLY_REFUNDED" : "PARTIALLY_REFUNDED";

    const { rows } = await client.query(
      `UPDATE orders
       SET refunded_amount = $2,
           status = $3,
           refund_reason = COALESCE($4, refund_reason)
       WHERE id = $1
       RETURNING id, total, refunded_amount, status, refund_reason`,
      [orderId, refundedAfter, nextStatus, reason]
    );

    await writeOrderAudit(client, req.user, "ORDER_REFUND", orderId, {
      amount,
      refunded_before: refundedBefore,
      refunded_after: refundedAfter,
      reason,
      restocked: restock,
      approval_mode: approval.approval_mode,
      approved_by: approval.approved_by,
      approved_by_username: approval.approved_by_username,
      requested_by: approval.requested_by,
      requested_by_role: approval.requested_by_role,
    });

    await client.query("COMMIT");
    return res.json({
      message: isFull ? "Order fully refunded" : "Order partially refunded",
      order: {
        ...rows[0],
        total: parseFloat(rows[0]?.total || 0),
        refunded_amount: parseFloat(rows[0]?.refunded_amount || 0),
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Order refund failed:", err);
    return res.status(500).json({ message: "Failed to refund order" });
  } finally {
    client.release();
  }
});

// POS order creation (both ADMIN and CASHIER)
router.post("/", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  const {
    total,
    payment_method: paymentMethod,
    items = [],
    customer_id: customerIdRaw,
    customer_name: customerNameRaw,
    customer_phone: customerPhoneRaw,
    branch_id: branchIdRaw,
    order_type: orderTypeRaw,
    channel: channelRaw,
    loyalty_points_redeemed: loyaltyPointsRedeemedRaw = 0,
    total_before_loyalty: totalBeforeLoyaltyRaw,
    manual_discount_amount: manualDiscountAmountRaw = 0,
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
  const manualDiscountAmount = parseMoney(manualDiscountAmountRaw, 0);
  if (!Number.isFinite(manualDiscountAmount) || manualDiscountAmount < 0) {
    return res.status(400).json({ message: "Invalid manual discount amount" });
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
    const branchId = await resolveActiveBranchId(client, branchIdRaw);
    const orderType = toSafeOrderType(orderTypeRaw);
    const channel = toSafeChannel(channelRaw);

    let loyaltyPointsRedeemed = 0;
    let loyaltyDiscountAmount = 0;
    let totalDiscountAmount = 0;
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
    totalDiscountAmount = parseMoney(manualDiscountAmount + loyaltyDiscountAmount, 0);

    pointsEarned = customerId ? computeEarnedPoints(computedTotal) : 0;

    const orderResult = await client.query(
      `INSERT INTO orders
        (
          total,
          payment_method,
          customer_id,
          customer_name,
          customer_phone,
          branch_id,
          order_type,
          channel,
          loyalty_points_redeemed,
          loyalty_discount_amount,
          manual_discount_amount,
          total_discount_amount
        )
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        computedTotal,
        paymentMethod,
        customerId,
        customerName,
        customerPhone || null,
        branchId,
        orderType,
        channel,
        loyaltyPointsRedeemed,
        loyaltyDiscountAmount,
        manualDiscountAmount,
        totalDiscountAmount,
      ]
    );
    const orderId = orderResult.rows[0].id;
    const invoiceNumber = formatInvoiceNumber(orderId);

    await client.query(
      `UPDATE orders
       SET invoice_number = $2
       WHERE id = $1`,
      [orderId, invoiceNumber]
    );

    const insertItems = items.map((item) =>
      client.query(
        "INSERT INTO order_items (order_id, product_id, qty, price) VALUES ($1, $2, $3, $4)",
        [orderId, item.product_id, item.qty, item.price]
      )
    );
    await Promise.all(insertItems);
    await adjustInventoryInTransaction(client, items, "DEDUCT");

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

    await writeOrderAudit(client, req.user, "ORDER_CREATE", orderId, {
      total: computedTotal,
      payment_method: paymentMethod,
      branch_id: branchId,
      order_type: orderType,
      channel,
      items_count: items.length,
    });
    await client.query("COMMIT");

    return res.status(201).json({
      id: orderId,
      invoice_number: invoiceNumber,
      total: computedTotal,
      branch_id: branchId,
      status: "COMPLETED",
      loyalty_points_redeemed: loyaltyPointsRedeemed,
      loyalty_points_earned: pointsEarned,
      loyalty_discount_amount: loyaltyDiscountAmount,
      manual_discount_amount: manualDiscountAmount,
      total_discount_amount: totalDiscountAmount,
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
