import express from "express";
import { randomUUID } from "crypto";
import auth from "../middleware/auth.js";
import authorize from "../middleware/authorize.js";
import pool from "../db.js";
import {
  LOYALTY_EARN_STEP,
  LOYALTY_MAX_REDEEM_PERCENT,
  LOYALTY_MIN_REDEEM_POINTS,
  LOYALTY_POINT_VALUE,
  computeMaxRedeemablePoints,
} from "../config/loyalty.js";

const router = express.Router();

const allowedOrderTypes = new Set(["DINE-IN", "TAKEAWAY", "DELIVERY", "OTHER"]);
const allowedChannels = new Set(["POS", "PHONE", "WHATSAPP", "WEB", "OTHER"]);
const allowedCampaignStatus = new Set(["DRAFT", "SCHEDULED", "ACTIVE", "PAUSED", "SENT"]);

const SEGMENT_CASE_SQL = `CASE
  WHEN c.last_order_at IS NULL THEN 'NEW'
  WHEN c.last_order_at >= NOW() - INTERVAL '14 days' AND COALESCE(c.total_orders, 0) >= 5 THEN 'LOYAL'
  WHEN c.last_order_at >= NOW() - INTERVAL '30 days' THEN 'ACTIVE'
  WHEN c.last_order_at >= NOW() - INTERVAL '90 days' THEN 'AT_RISK'
  ELSE 'DORMANT'
END`;

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "").trim();
}

function parsePositiveInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function parseNonNegativeNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseIntArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => Number.parseInt(v, 10))
      .filter((v) => Number.isFinite(v) && v > 0);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((v) => Number.parseInt(v.trim(), 10))
      .filter((v) => Number.isFinite(v) && v > 0);
  }
  return [];
}

function normalizeSegment(value) {
  const segment = String(value || "")
    .trim()
    .toUpperCase();
  const allowed = new Set(["ALL", "NEW", "LOYAL", "ACTIVE", "AT_RISK", "DORMANT"]);
  return allowed.has(segment) ? segment : "ALL";
}

function normalizeAudienceFilter(input = {}) {
  const filter = typeof input === "object" && input !== null ? input : {};
  const includeInactive =
    String(filter.include_inactive || "false") === "true" || filter.include_inactive === true;
  return {
    segment: normalizeSegment(filter.segment),
    min_orders: parsePositiveInt(filter.min_orders, 0, 0, 100000),
    min_spent: parseNonNegativeNumber(filter.min_spent, 0),
    last_order_before_days: parsePositiveInt(filter.last_order_before_days, 0, 0, 3650),
    include_inactive: includeInactive,
    tag_ids: Array.from(new Set(parseIntArray(filter.tag_ids))).slice(0, 30),
  };
}

function buildCustomerAudienceWhere(filterInput) {
  const filter = normalizeAudienceFilter(filterInput);
  const clauses = [];
  const params = [];

  if (!filter.include_inactive) {
    clauses.push("c.is_active = true");
  }

  if (filter.segment !== "ALL") {
    params.push(filter.segment);
    clauses.push(`${SEGMENT_CASE_SQL} = $${params.length}`);
  }

  if (filter.min_orders > 0) {
    params.push(filter.min_orders);
    clauses.push(`COALESCE(c.total_orders, 0) >= $${params.length}`);
  }

  if (filter.min_spent > 0) {
    params.push(filter.min_spent);
    clauses.push(`COALESCE(c.total_spent, 0) >= $${params.length}`);
  }

  if (filter.last_order_before_days > 0) {
    params.push(filter.last_order_before_days);
    clauses.push(
      `(c.last_order_at IS NULL OR c.last_order_at <= NOW() - (($${params.length}::text || ' days')::interval))`
    );
  }

  if (filter.tag_ids.length > 0) {
    params.push(filter.tag_ids);
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM customer_tag_map ctm
        WHERE ctm.customer_id = c.id
          AND ctm.tag_id = ANY($${params.length}::int[])
      )`
    );
  }

  return {
    filter,
    params,
    whereSql: clauses.length > 0 ? clauses.join(" AND ") : "true",
  };
}

async function recalcCustomerMetrics(client, customerId) {
  await client.query(
    `UPDATE customers c
     SET total_orders = stats.total_orders,
         total_spent = stats.total_spent,
         last_order_at = stats.last_order_at,
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
    [customerId]
  );
}

async function fetchCustomerTags(customerId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.color
     FROM customer_tag_map m
     JOIN customer_tags t ON t.id = m.tag_id
     WHERE m.customer_id = $1
     ORDER BY t.name`,
    [customerId]
  );
  return rows;
}

// Lookup customer by phone (used by POS checkout)
router.get("/customers/lookup", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone) {
      return res.status(400).json({ message: "Phone is required" });
    }

    const { rows } = await pool.query(
      `SELECT id, full_name, phone, email, address, loyalty_points, total_orders, total_spent, last_order_at
       FROM customers
       WHERE phone = $1 AND is_active = true
       LIMIT 1`,
      [phone]
    );

    return res.json({ customer: rows[0] || null });
  } catch (err) {
    console.error("CRM lookup failed:", err);
    return res.status(500).json({ message: "Failed to lookup customer" });
  }
});

// Quick create customer (used by POS checkout)
router.post("/customers/quick-create", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  const fullName = String(req.body.full_name || "").trim();
  const phone = normalizePhone(req.body.phone);
  const email = req.body.email ? String(req.body.email).trim() : null;
  const address = req.body.address ? String(req.body.address).trim() : null;

  if (!fullName || !phone) {
    return res.status(400).json({ message: "Customer name and phone are required" });
  }

  try {
    const existing = await pool.query(
      `SELECT id, full_name, phone, email, address, loyalty_points, total_orders, total_spent, last_order_at
       FROM customers
       WHERE phone = $1
       LIMIT 1`,
      [phone]
    );
    if (existing.rows[0]) {
      return res.json({ customer: existing.rows[0], created: false });
    }

    const id = randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO customers (id, full_name, phone, email, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, full_name, phone, email, address, loyalty_points, total_orders, total_spent, last_order_at`,
      [id, fullName, phone, email, address]
    );
    return res.status(201).json({ customer: rows[0], created: true });
  } catch (err) {
    if (err.code === "23505") {
      const { rows } = await pool.query(
        `SELECT id, full_name, phone, email, address, loyalty_points, total_orders, total_spent, last_order_at
         FROM customers
         WHERE phone = $1
         LIMIT 1`,
        [phone]
      );
      return res.json({ customer: rows[0] || null, created: false });
    }
    console.error("CRM quick create failed:", err);
    return res.status(500).json({ message: "Failed to create customer" });
  }
});

// Customer list
router.get("/customers", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const query = String(req.query.query || "").trim().toLowerCase();
    const limit = parsePositiveInt(req.query.limit, 50, 1, 200);
    const offset = parsePositiveInt(req.query.offset, 0, 0, 100000);
    const includeInactive = String(req.query.include_inactive || "false") === "true";
    const searchPattern = `%${query}%`;

    const { rows } = await pool.query(
      `SELECT
         id,
         full_name,
         phone,
         email,
         address,
         is_active,
         total_orders,
         total_spent,
         loyalty_points,
         last_order_at,
         created_at,
         updated_at
       FROM customers
       WHERE ($1 = '' OR LOWER(full_name) LIKE $2 OR LOWER(phone) LIKE $2 OR LOWER(COALESCE(email, '')) LIKE $2)
         AND ($3::boolean OR is_active = true)
       ORDER BY created_at DESC
       LIMIT $4
       OFFSET $5`,
      [query, searchPattern, includeInactive, limit, offset]
    );

    return res.json(rows);
  } catch (err) {
    console.error("CRM customers list failed:", err);
    return res.status(500).json({ message: "Failed to fetch customers" });
  }
});

// Create customer (admin)
router.post("/customers", auth, authorize("ADMIN"), async (req, res) => {
  const fullName = String(req.body.full_name || "").trim();
  const phone = normalizePhone(req.body.phone);
  const email = req.body.email ? String(req.body.email).trim() : null;
  const address = req.body.address ? String(req.body.address).trim() : null;
  const birthDate = req.body.birth_date || null;
  const gender = req.body.gender ? String(req.body.gender).trim() : null;
  const isActive = req.body.is_active !== false;

  if (!fullName || !phone) {
    return res.status(400).json({ message: "Customer name and phone are required" });
  }

  try {
    const id = randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO customers (id, full_name, phone, email, address, birth_date, gender, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, fullName, phone, email, address, birthDate, gender, isActive]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ message: "Customer with this phone already exists" });
    }
    console.error("CRM create customer failed:", err);
    return res.status(500).json({ message: "Failed to create customer" });
  }
});

// Customer detail + 360 view pieces
router.get("/customers/:id", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const { id } = req.params;

    const customerRes = await pool.query(`SELECT * FROM customers WHERE id = $1`, [id]);
    if (!customerRes.rows[0]) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const [ordersRes, notesRes, loyaltyRes, tagsRes] = await Promise.all([
      pool.query(
        `SELECT id, total, payment_method, order_type, channel, loyalty_points_redeemed, loyalty_discount_amount, created_at
         FROM orders
         WHERE customer_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [id]
      ),
      pool.query(
        `SELECT n.id, n.note, n.created_at, COALESCE(u.username, n.created_by) AS created_by
         FROM customer_notes n
         LEFT JOIN users u ON u.id::text = n.created_by
         WHERE n.customer_id = $1
         ORDER BY n.created_at DESC
         LIMIT 50`,
        [id]
      ),
      pool.query(
        `SELECT id, points_change, reason, order_id, created_at
         FROM customer_loyalty_txns
         WHERE customer_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [id]
      ),
      pool.query(
        `SELECT t.id, t.name, t.color
         FROM customer_tag_map m
         JOIN customer_tags t ON t.id = m.tag_id
         WHERE m.customer_id = $1
         ORDER BY t.name`,
        [id]
      ),
    ]);

    return res.json({
      customer: customerRes.rows[0],
      recentOrders: ordersRes.rows,
      notes: notesRes.rows,
      loyalty: loyaltyRes.rows,
      tags: tagsRes.rows,
    });
  } catch (err) {
    console.error("CRM customer detail failed:", err);
    return res.status(500).json({ message: "Failed to fetch customer details" });
  }
});

// Update customer
router.put("/customers/:id", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const { id } = req.params;

    const fullName = req.body.full_name ? String(req.body.full_name).trim() : null;
    const phone = req.body.phone ? normalizePhone(req.body.phone) : null;
    const email = req.body.email === undefined ? undefined : req.body.email ? String(req.body.email).trim() : null;
    const address = req.body.address === undefined ? undefined : req.body.address ? String(req.body.address).trim() : null;
    const birthDate = req.body.birth_date === undefined ? undefined : req.body.birth_date || null;
    const gender = req.body.gender === undefined ? undefined : req.body.gender ? String(req.body.gender).trim() : null;
    const isActive = req.body.is_active;

    if (fullName !== null && !fullName) {
      return res.status(400).json({ message: "Customer name cannot be empty" });
    }
    if (phone !== null && !phone) {
      return res.status(400).json({ message: "Phone cannot be empty" });
    }

    const existingRes = await pool.query(`SELECT * FROM customers WHERE id = $1`, [id]);
    if (!existingRes.rows[0]) {
      return res.status(404).json({ message: "Customer not found" });
    }
    const existing = existingRes.rows[0];

    const nextFullName = fullName ?? existing.full_name;
    const nextPhone = phone ?? existing.phone;
    const nextEmail = email === undefined ? existing.email : email;
    const nextAddress = address === undefined ? existing.address : address;
    const nextBirthDate = birthDate === undefined ? existing.birth_date : birthDate;
    const nextGender = gender === undefined ? existing.gender : gender;
    const nextActive = isActive === undefined ? existing.is_active : isActive;

    const { rows } = await pool.query(
      `UPDATE customers
       SET
         full_name = $1,
         phone = $2,
         email = $3,
         address = $4,
         birth_date = $5,
         gender = $6,
         is_active = $7,
         updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [nextFullName, nextPhone, nextEmail, nextAddress, nextBirthDate, nextGender, nextActive, id]
    );

    return res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ message: "Another customer already uses this phone" });
    }
    console.error("CRM update customer failed:", err);
    return res.status(500).json({ message: "Failed to update customer" });
  }
});

// Add note to customer
router.post("/customers/:id/notes", auth, authorize("ADMIN"), async (req, res) => {
  const note = String(req.body.note || "").trim();
  if (!note) {
    return res.status(400).json({ message: "Note is required" });
  }

  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `INSERT INTO customer_notes (customer_id, note, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, customer_id, note, created_at`,
      [id, note, req.user.id]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error("CRM add note failed:", err);
    return res.status(500).json({ message: "Failed to add note" });
  }
});

// Manual loyalty adjustment
router.post("/customers/:id/loyalty", auth, authorize("ADMIN"), async (req, res) => {
  const pointsChange = parseInt(req.body.points_change, 10);
  const reason = String(req.body.reason || "MANUAL_ADJUSTMENT").trim().slice(0, 120);
  if (!Number.isFinite(pointsChange) || pointsChange === 0) {
    return res.status(400).json({ message: "points_change must be a non-zero integer" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const customerRes = await client.query(
      `SELECT id, loyalty_points
       FROM customers
       WHERE id = $1
       FOR UPDATE`,
      [req.params.id]
    );
    if (!customerRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Customer not found" });
    }

    await client.query(
      `INSERT INTO customer_loyalty_txns (customer_id, points_change, reason)
       VALUES ($1, $2, $3)`,
      [req.params.id, pointsChange, reason]
    );
    await client.query(
      `UPDATE customers
       SET loyalty_points = GREATEST(0, COALESCE(loyalty_points, 0) + $2),
           updated_at = NOW()
       WHERE id = $1`,
      [req.params.id, pointsChange]
    );

    await client.query("COMMIT");
    return res.json({ message: "Loyalty updated" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CRM loyalty adjustment failed:", err);
    return res.status(500).json({ message: "Failed to update loyalty points" });
  } finally {
    client.release();
  }
});

// Loyalty redemption preview for POS
router.get(
  "/customers/:id/loyalty/redeem-preview",
  auth,
  authorize("ADMIN", "CASHIER"),
  async (req, res) => {
    try {
      const orderTotal = parseNonNegativeNumber(req.query.order_total, null);
      if (orderTotal === null || orderTotal <= 0) {
        return res.status(400).json({ message: "order_total must be a positive number" });
      }

      const customerRes = await pool.query(
        `SELECT id, full_name, loyalty_points
         FROM customers
         WHERE id = $1 AND is_active = true`,
        [req.params.id]
      );
      if (!customerRes.rows[0]) {
        return res.status(404).json({ message: "Customer not found" });
      }

      const customer = customerRes.rows[0];
      const availablePoints = parsePositiveInt(customer.loyalty_points, 0, 0, 100000000);
      const maxRedeemablePoints = computeMaxRedeemablePoints(availablePoints, orderTotal);
      const maxDiscount = Number((maxRedeemablePoints * LOYALTY_POINT_VALUE).toFixed(2));

      return res.json({
        customer_id: customer.id,
        customer_name: customer.full_name,
        available_points: availablePoints,
        max_redeemable_points: maxRedeemablePoints,
        max_discount: maxDiscount,
        min_redeem_points: LOYALTY_MIN_REDEEM_POINTS,
        earn_step: LOYALTY_EARN_STEP,
        discount_per_point: LOYALTY_POINT_VALUE,
        max_redeem_percent: Number((LOYALTY_MAX_REDEEM_PERCENT * 100).toFixed(0)),
      });
    } catch (err) {
      console.error("CRM redeem preview failed:", err);
      return res.status(500).json({ message: "Failed to calculate loyalty redemption preview" });
    }
  }
);

// Tags list
router.get("/tags", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         t.id,
         t.name,
         t.color,
         COUNT(m.customer_id)::int AS customers_count
       FROM customer_tags t
       LEFT JOIN customer_tag_map m ON m.tag_id = t.id
       GROUP BY t.id
       ORDER BY t.name`
    );
    return res.json(rows);
  } catch (err) {
    console.error("CRM tags list failed:", err);
    return res.status(500).json({ message: "Failed to fetch tags" });
  }
});

// Create tag
router.post("/tags", auth, authorize("ADMIN"), async (req, res) => {
  const name = String(req.body.name || "").trim();
  const color = String(req.body.color || "slate")
    .trim()
    .toLowerCase()
    .slice(0, 20);

  if (!name) {
    return res.status(400).json({ message: "Tag name is required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO customer_tags (name, color)
       VALUES ($1, $2)
       RETURNING id, name, color, created_at`,
      [name, color || "slate"]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ message: "Tag already exists" });
    }
    console.error("CRM create tag failed:", err);
    return res.status(500).json({ message: "Failed to create tag" });
  }
});

// Replace customer tags
router.put("/customers/:id/tags", auth, authorize("ADMIN"), async (req, res) => {
  const tagIds = Array.from(new Set(parseIntArray(req.body.tag_ids))).slice(0, 30);
  const { id: customerId } = req.params;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const customerRes = await client.query(
      `SELECT id
       FROM customers
       WHERE id = $1`,
      [customerId]
    );
    if (!customerRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Customer not found" });
    }

    if (tagIds.length > 0) {
      const { rows: existingTags } = await client.query(
        `SELECT id
         FROM customer_tags
         WHERE id = ANY($1::int[])`,
        [tagIds]
      );
      if (existingTags.length !== tagIds.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "One or more tag IDs are invalid" });
      }
    }

    await client.query(`DELETE FROM customer_tag_map WHERE customer_id = $1`, [customerId]);
    for (const tagId of tagIds) {
      await client.query(
        `INSERT INTO customer_tag_map (customer_id, tag_id)
         VALUES ($1, $2)`,
        [customerId, tagId]
      );
    }

    await client.query("COMMIT");
    const tags = await fetchCustomerTags(customerId);
    return res.json({ customer_id: customerId, tags });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CRM set customer tags failed:", err);
    return res.status(500).json({ message: "Failed to update customer tags" });
  } finally {
    client.release();
  }
});

// Attach existing order to customer
router.post("/orders/:orderId/attach-customer", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  const { orderId } = req.params;
  const customerId = String(req.body.customer_id || "").trim();
  if (!customerId) {
    return res.status(400).json({ message: "customer_id is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderRes = await client.query(
      `SELECT id, total, loyalty_points_redeemed
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId]
    );
    if (!orderRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order not found" });
    }

    const customerRes = await client.query(
      `SELECT id, full_name, phone
       FROM customers
       WHERE id = $1 AND is_active = true`,
      [customerId]
    );
    if (!customerRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Customer not found" });
    }

    const customer = customerRes.rows[0];
    await client.query(
      `UPDATE orders
       SET customer_id = $2,
           customer_name = COALESCE(customer_name, $3),
           customer_phone = COALESCE(customer_phone, $4)
       WHERE id = $1`,
      [orderId, customer.id, customer.full_name, customer.phone]
    );

    const pointsEarned = Math.max(0, Math.floor(parseFloat(orderRes.rows[0].total || 0) / LOYALTY_EARN_STEP));
    if (pointsEarned > 0) {
      await client.query(
        `INSERT INTO customer_loyalty_txns (customer_id, order_id, points_change, reason)
         VALUES ($1, $2, $3, $4)`,
        [customer.id, orderId, pointsEarned, "ORDER_EARNED"]
      );
      await client.query(
        `UPDATE customers
         SET loyalty_points = COALESCE(loyalty_points, 0) + $2,
             updated_at = NOW()
         WHERE id = $1`,
        [customer.id, pointsEarned]
      );
    }

    await recalcCustomerMetrics(client, customer.id);

    await client.query("COMMIT");
    return res.json({ message: "Order attached to customer", points_earned: pointsEarned });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CRM attach order failed:", err);
    return res.status(500).json({ message: "Failed to attach customer to order" });
  } finally {
    client.release();
  }
});

// Segment list with filters
router.get("/segments/rfm", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const audienceWhere = buildCustomerAudienceWhere({
      segment: req.query.segment,
      min_orders: req.query.min_orders,
      min_spent: req.query.min_spent,
      last_order_before_days: req.query.last_order_before_days,
      include_inactive: req.query.include_inactive,
      tag_ids: req.query.tag_ids,
    });

    const limit = parsePositiveInt(req.query.limit, 300, 1, 1000);
    const params = [...audienceWhere.params, limit];

    const { rows } = await pool.query(
      `SELECT
         c.id,
         c.full_name,
         c.phone,
         c.total_orders,
         c.total_spent,
         c.last_order_at,
         ${SEGMENT_CASE_SQL} AS segment,
         COALESCE(
           json_agg(
             DISTINCT jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color)
           ) FILTER (WHERE t.id IS NOT NULL),
           '[]'::json
         ) AS tags
       FROM customers c
       LEFT JOIN customer_tag_map m ON m.customer_id = c.id
       LEFT JOIN customer_tags t ON t.id = m.tag_id
       WHERE ${audienceWhere.whereSql}
       GROUP BY c.id
       ORDER BY c.total_spent DESC, c.last_order_at DESC NULLS LAST
       LIMIT $${params.length}`,
      params
    );
    return res.json(rows);
  } catch (err) {
    console.error("CRM segment query failed:", err);
    return res.status(500).json({ message: "Failed to fetch segments" });
  }
});

// Campaign audience preview
router.post("/campaigns/audience-preview", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const audienceFilter = normalizeAudienceFilter(req.body.audience_filter || req.body || {});
    const audienceWhere = buildCustomerAudienceWhere(audienceFilter);
    const limit = parsePositiveInt(req.body.limit, 100, 1, 500);

    const customerParams = [...audienceWhere.params, limit];
    const countParams = [...audienceWhere.params];

    const [countRes, customersRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM customers c
         WHERE ${audienceWhere.whereSql}`,
        countParams
      ),
      pool.query(
        `SELECT
           c.id,
           c.full_name,
           c.phone,
           c.total_orders,
           c.total_spent,
           c.last_order_at,
           ${SEGMENT_CASE_SQL} AS segment
         FROM customers c
         WHERE ${audienceWhere.whereSql}
         ORDER BY c.total_spent DESC, c.last_order_at DESC NULLS LAST
         LIMIT $${customerParams.length}`,
        customerParams
      ),
    ]);

    return res.json({
      filter: audienceFilter,
      total: countRes.rows[0]?.total || 0,
      customers: customersRes.rows,
    });
  } catch (err) {
    console.error("CRM campaign audience preview failed:", err);
    return res.status(500).json({ message: "Failed to preview campaign audience" });
  }
});

// Campaign list
router.get("/campaigns", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, channel, audience_filter, message, status, created_at, scheduled_at, sent_at
       FROM customer_campaigns
       ORDER BY created_at DESC`
    );
    return res.json(rows);
  } catch (err) {
    console.error("CRM campaign list failed:", err);
    return res.status(500).json({ message: "Failed to fetch campaigns" });
  }
});

// Campaign create
router.post("/campaigns", auth, authorize("ADMIN"), async (req, res) => {
  const name = String(req.body.name || "").trim();
  const channel = String(req.body.channel || "SMS").trim().toUpperCase();
  const message = String(req.body.message || "").trim();
  const audienceFilter = normalizeAudienceFilter(req.body.audience_filter || {});
  const status = String(req.body.status || "DRAFT").trim().toUpperCase();
  const scheduledAt = req.body.scheduled_at || null;

  if (!name || !message) {
    return res.status(400).json({ message: "name and message are required" });
  }
  if (!allowedChannels.has(channel)) {
    return res.status(400).json({ message: "Invalid channel" });
  }
  if (!allowedCampaignStatus.has(status)) {
    return res.status(400).json({ message: "Invalid campaign status" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO customer_campaigns
         (name, channel, audience_filter, message, status, created_by, scheduled_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       RETURNING *`,
      [name, channel, JSON.stringify(audienceFilter), message, status, req.user.id, scheduledAt]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error("CRM campaign create failed:", err);
    return res.status(500).json({ message: "Failed to create campaign" });
  }
});

// Retention and LTV metrics
router.get("/reports/retention-ltv", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 90, 30, 3650);

    const [summaryRes, topCustomersRes, cohortRes, avgOrderRes] = await Promise.all([
      pool.query(
        `WITH base AS (
           SELECT
             COUNT(*) FILTER (WHERE is_active = true) AS active_customers,
             COUNT(*) FILTER (WHERE is_active = true AND total_orders > 0) AS purchasing_customers,
             COUNT(*) FILTER (WHERE is_active = true AND total_orders > 1) AS repeat_customers,
             COUNT(*) FILTER (
               WHERE is_active = true
                 AND total_orders > 0
                 AND (last_order_at IS NULL OR last_order_at < NOW() - INTERVAL '60 days')
             ) AS churn_risk_customers,
             COUNT(*) FILTER (
               WHERE is_active = true
                 AND created_at >= NOW() - (($1::text || ' days')::interval)
             ) AS new_customers_in_period,
             COUNT(*) FILTER (
               WHERE is_active = true
                 AND total_orders > 0
                 AND last_order_at >= NOW() - (($1::text || ' days')::interval)
             ) AS active_in_period,
             COALESCE(AVG(total_spent) FILTER (WHERE is_active = true AND total_orders > 0), 0)::numeric(12,2) AS avg_ltv,
             COALESCE(AVG(total_orders) FILTER (WHERE is_active = true AND total_orders > 0), 0)::numeric(12,2) AS avg_visit_frequency
           FROM customers
         )
         SELECT
           active_customers,
           purchasing_customers,
           repeat_customers,
           churn_risk_customers,
           new_customers_in_period,
           active_in_period,
           avg_ltv,
           avg_visit_frequency,
           CASE
             WHEN purchasing_customers = 0 THEN 0
             ELSE ROUND((repeat_customers::numeric / purchasing_customers::numeric) * 100, 2)
           END AS repeat_rate
         FROM base`,
        [days]
      ),
      pool.query(
        `SELECT
           id,
           full_name,
           phone,
           total_orders,
           total_spent,
           loyalty_points,
           last_order_at
         FROM customers
         WHERE is_active = true
           AND total_orders > 0
         ORDER BY total_spent DESC, total_orders DESC
         LIMIT 10`
      ),
      pool.query(
        `SELECT
           DATE_TRUNC('month', created_at)::date AS cohort_month,
           COUNT(*)::int AS customers,
           COUNT(*) FILTER (WHERE last_order_at >= created_at + INTERVAL '30 days')::int AS retained_30d
         FROM customers
         WHERE created_at >= NOW() - INTERVAL '12 months'
         GROUP BY DATE_TRUNC('month', created_at)::date
         ORDER BY cohort_month DESC`
      ),
      pool.query(
        `SELECT COALESCE(AVG(total), 0)::numeric(12,2) AS avg_order_value
         FROM orders
         WHERE customer_id IS NOT NULL`
      ),
    ]);

    const summary = summaryRes.rows[0] || {};
    return res.json({
      period_days: days,
      summary: {
        active_customers: parsePositiveInt(summary.active_customers, 0, 0, 1000000000),
        purchasing_customers: parsePositiveInt(summary.purchasing_customers, 0, 0, 1000000000),
        repeat_customers: parsePositiveInt(summary.repeat_customers, 0, 0, 1000000000),
        repeat_rate: Number(summary.repeat_rate || 0),
        churn_risk_customers: parsePositiveInt(summary.churn_risk_customers, 0, 0, 1000000000),
        new_customers_in_period: parsePositiveInt(summary.new_customers_in_period, 0, 0, 1000000000),
        active_in_period: parsePositiveInt(summary.active_in_period, 0, 0, 1000000000),
        avg_ltv: Number(summary.avg_ltv || 0),
        avg_visit_frequency: Number(summary.avg_visit_frequency || 0),
        avg_order_value: Number(avgOrderRes.rows[0]?.avg_order_value || 0),
      },
      top_customers: topCustomersRes.rows,
      cohorts: cohortRes.rows.map((row) => ({
        ...row,
        retention_30d_rate:
          row.customers > 0 ? Number(((row.retained_30d / row.customers) * 100).toFixed(2)) : 0,
      })),
    });
  } catch (err) {
    console.error("CRM retention/LTV report failed:", err);
    return res.status(500).json({ message: "Failed to fetch retention and LTV metrics" });
  }
});

// Loyalty configuration
router.get("/loyalty/config", auth, authorize("ADMIN", "CASHIER"), async (_req, res) => {
  return res.json({
    earn_step: LOYALTY_EARN_STEP,
    discount_per_point: LOYALTY_POINT_VALUE,
    min_redeem_points: LOYALTY_MIN_REDEEM_POINTS,
    max_redeem_percent: Number((LOYALTY_MAX_REDEEM_PERCENT * 100).toFixed(0)),
  });
});

// Utility endpoint: normalize order metadata options
router.get("/meta/order-options", auth, authorize("ADMIN", "CASHIER"), async (_req, res) => {
  return res.json({
    orderTypes: Array.from(allowedOrderTypes),
    channels: Array.from(allowedChannels),
  });
});

export default router;
