import express from "express";
import multer from "multer";
import auth from "../middleware/auth.js";
import authorize from "../middleware/authorize.js";
import pool from "../db.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const BACKUP_TABLES = [
  "products",
  "inventory_items",
  "product_ingredients",
  "inventory_alerts",
  "customers",
  "customer_contacts",
  "customer_notes",
  "customer_tags",
  "customer_tag_map",
  "customer_loyalty_txns",
  "customer_campaigns",
  "held_orders",
  "cash_shifts",
  "expenses",
  "suppliers",
  "purchase_orders",
  "purchase_order_items",
  "goods_receipts",
  "goods_receipt_items",
  "audit_logs",
  "orders",
  "order_items",
];

const RESTORE_ORDER = [
  "products",
  "inventory_items",
  "customers",
  "customer_tags",
  "customer_campaigns",
  "suppliers",
  "purchase_orders",
  "orders",
  "held_orders",
  "cash_shifts",
  "expenses",
  "goods_receipts",
  "product_ingredients",
  "inventory_alerts",
  "purchase_order_items",
  "goods_receipt_items",
  "audit_logs",
  "customer_contacts",
  "customer_notes",
  "customer_tag_map",
  "customer_loyalty_txns",
  "order_items",
];

const RESETTABLE_TABLES = [
  "order_items",
  "orders",
  "product_ingredients",
  "inventory_alerts",
  "inventory_items",
  "customer_contacts",
  "customer_notes",
  "customer_tag_map",
  "customer_loyalty_txns",
  "customer_campaigns",
  "goods_receipt_items",
  "goods_receipts",
  "purchase_order_items",
  "purchase_orders",
  "suppliers",
  "expenses",
  "cash_shifts",
  "audit_logs",
  "customer_tags",
  "customers",
  "products",
  "held_orders",
];

function parsePositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseMoney(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.round(parsed * 100) / 100;
}

function normalizeProductImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  // Keep payload size bounded since data URLs can be very large.
  if (raw.length > 900000) {
    return null;
  }

  // Allow local upload data URLs and hosted image URLs.
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(raw)) {
    return raw;
  }
  if (/^https?:\/\//i.test(raw) || raw.startsWith("/")) {
    return raw;
  }

  return null;
}

function normalizeOrderType(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  const allowed = new Set(["DINE-IN", "TAKEAWAY", "DELIVERY", "OTHER"]);
  return allowed.has(normalized) ? normalized : null;
}

function normalizePaymentMethod(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  const allowed = new Set(["CASH", "CARD", "QR", "ONLINE", "OTHER"]);
  return allowed.has(normalized) ? normalized : null;
}

function buildReportFilter(reqQuery = {}) {
  const days = parsePositiveInt(reqQuery.days, 30, 1, 3650);
  const orderType = normalizeOrderType(reqQuery.orderType);
  const paymentMethod = normalizePaymentMethod(reqQuery.paymentMethod);
  const params = [days];
  const conditions = [
    "created_at >= CURRENT_DATE - (($1::text || ' days')::interval)",
  ];

  if (orderType) {
    params.push(orderType);
    conditions.push(`order_type = $${params.length}`);
  }
  if (paymentMethod) {
    params.push(paymentMethod);
    conditions.push(`payment_method = $${params.length}`);
  }

  return {
    days,
    params,
    whereSql: conditions.join(" AND "),
  };
}

async function writeAuditLog(clientOrPool, payload) {
  const source = clientOrPool || pool;
  const action = String(payload?.action || "").trim().slice(0, 80) || "UNKNOWN";
  const entityType =
    String(payload?.entity_type || "").trim().slice(0, 80) || "UNKNOWN";
  const entityId =
    payload?.entity_id === undefined || payload?.entity_id === null
      ? null
      : String(payload.entity_id).trim().slice(0, 120);
  const actorId =
    payload?.actor_id === undefined || payload?.actor_id === null
      ? null
      : String(payload.actor_id).trim().slice(0, 120);
  const actorRole = payload?.actor_role
    ? String(payload.actor_role).trim().slice(0, 40)
    : null;
  const meta =
    payload?.payload && typeof payload.payload === "object"
      ? payload.payload
      : {};

  await source.query(
    `INSERT INTO audit_logs (action, entity_type, entity_id, actor_id, actor_role, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [action, entityType, entityId, actorId, actorRole, JSON.stringify(meta)]
  );
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function getExistingTables(client, tableNames) {
  const { rows } = await client.query(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename = ANY($1::text[])`,
    [tableNames]
  );

  return new Set(rows.map((row) => row.tablename));
}

async function truncateBusinessTables(client) {
  const existingTables = await getExistingTables(client, RESETTABLE_TABLES);
  const tablesToTruncate = RESETTABLE_TABLES.filter((tableName) =>
    existingTables.has(tableName)
  );

  if (tablesToTruncate.length === 0) {
    return [];
  }

  await client.query(
    `TRUNCATE TABLE ${tablesToTruncate
      .map((tableName) => quoteIdentifier(tableName))
      .join(", ")} RESTART IDENTITY CASCADE`
  );

  return tablesToTruncate;
}

async function buildBackupCsv(client) {
  const existingTables = await getExistingTables(client, BACKUP_TABLES);
  const lines = ["table,id,data_base64"];
  let totalRows = 0;

  for (const tableName of BACKUP_TABLES) {
    if (!existingTables.has(tableName)) {
      continue;
    }

    const { rows } = await client.query(
      `SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY 1 ASC`
    );

    rows.forEach((row, index) => {
      const encodedRow = Buffer.from(JSON.stringify(row), "utf8").toString(
        "base64"
      );
      lines.push(`${tableName},${index + 1},${encodedRow}`);
      totalRows += 1;
    });
  }

  return { csv: lines.join("\n"), totalRows };
}

function parseBackupCsv(rawContent) {
  const lines = String(rawContent || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("Backup file is empty");
  }

  if (lines[0] !== "table,id,data_base64") {
    throw new Error("Invalid backup file format");
  }

  const parsedRows = new Map();

  for (let i = 1; i < lines.length; i += 1) {
    const [tableName, _rowNumber, encodedRow] = lines[i].split(",", 3);

    if (!tableName || !encodedRow) {
      throw new Error(`Invalid backup row at line ${i + 1}`);
    }

    let rowData;
    try {
      const decoded = Buffer.from(encodedRow, "base64").toString("utf8");
      rowData = JSON.parse(decoded);
    } catch (_decodeErr) {
      throw new Error(`Corrupted backup row at line ${i + 1}`);
    }

    if (!parsedRows.has(tableName)) {
      parsedRows.set(tableName, []);
    }
    parsedRows.get(tableName).push(rowData);
  }

  return parsedRows;
}

async function insertRows(client, tableName, rows) {
  for (const row of rows) {
    const columns = Object.keys(row);
    if (columns.length === 0) {
      continue;
    }

    const query = `INSERT INTO ${quoteIdentifier(tableName)} (${columns
      .map((column) => quoteIdentifier(column))
      .join(", ")})
      VALUES (${columns.map((_column, idx) => `$${idx + 1}`).join(", ")})`;

    const values = columns.map((column) => row[column]);
    await client.query(query, values);
  }
}

async function syncTableSequence(client, tableName) {
  const { rows } = await client.query(
    "SELECT pg_get_serial_sequence($1, 'id') AS sequence_name",
    [tableName]
  );
  const sequenceName = rows[0]?.sequence_name;

  if (!sequenceName) {
    return;
  }

  const { rows: maxRows } = await client.query(
    `SELECT MAX(id) AS max_id FROM ${quoteIdentifier(tableName)}`
  );
  const maxId = Number(maxRows[0]?.max_id || 0);

  if (maxId > 0) {
    await client.query("SELECT setval($1, $2, true)", [sequenceName, maxId]);
    return;
  }

  await client.query("SELECT setval($1, 1, false)", [sequenceName]);
}

async function restoreFromParsedRows(client, parsedRows) {
  const existingTables = await getExistingTables(client, RESTORE_ORDER);
  let restoredRows = 0;

  for (const tableName of RESTORE_ORDER) {
    if (!existingTables.has(tableName)) {
      continue;
    }

    const rows = parsedRows.get(tableName) || [];
    if (rows.length === 0) {
      continue;
    }

    await insertRows(client, tableName, rows);
    restoredRows += rows.length;
  }

  for (const tableName of RESTORE_ORDER) {
    if (!existingTables.has(tableName)) {
      continue;
    }
    await syncTableSequence(client, tableName);
  }

  return restoredRows;
}

// List products (ADMIN only for management) - includes stock for inventory
router.get("/products", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, price, category, image_url, "isActive" as is_active, stock FROM products ORDER BY name'
    );
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching products:", err);
    console.error("Error stack:", err.stack);
    return res.status(500).json({ message: "Failed to fetch products", error: err.message });
  }
});

// Get active products for POS (both ADMIN and CASHIER)
router.get("/products/pos", auth, authorize("ADMIN", "CASHIER"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, price, category, image_url FROM products WHERE "isActive" = true ORDER BY category, name'
    );
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching POS products:", err);
    console.error("Error stack:", err.stack);
    return res.status(500).json({ message: "Failed to fetch products", error: err.message });
  }
});

// Create product
router.post("/products", auth, authorize("ADMIN"), async (req, res) => {
  const { name, price, category, is_active: isActive = true } = req.body;
  const imageUrl = normalizeProductImageUrl(req.body?.image_url);
  if (!name || price === undefined) {
    return res.status(400).json({ message: "Name and price are required" });
  }

  // Ensure price is a number
  const priceNum = parseFloat(price);
  if (isNaN(priceNum) || priceNum < 0) {
    return res.status(400).json({ message: "Price must be a valid positive number" });
  }

  try {
    const { rows } = await pool.query(
      'INSERT INTO products (name, price, category, image_url, "isActive", stock) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, price, category, image_url, "isActive" as is_active',
      [name, priceNum, category || null, imageUrl, isActive, 0]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Error creating product:", err);
    console.error("Error message:", err.message);
    console.error("Error code:", err.code);
    console.error("Error detail:", err.detail);
    console.error("Error stack:", err.stack);
    return res.status(500).json({ message: "Failed to create product", error: err.message });
  }
});

// Update product
router.put("/products/:id", auth, authorize("ADMIN"), async (req, res) => {
  const { id } = req.params;
  const { name, price, category, is_active: isActive, stock } = req.body;
  const hasImageUrl = Object.prototype.hasOwnProperty.call(
    req.body || {},
    "image_url"
  );
  const imageUrl = hasImageUrl
    ? normalizeProductImageUrl(req.body?.image_url)
    : null;

  if (!name) {
    return res.status(400).json({ message: "Name is required" });
  }

  try {
    const { rows } = await pool.query(
      'UPDATE products SET name = $1, price = $2, category = $3, image_url = CASE WHEN $4 THEN $5 ELSE image_url END, "isActive" = $6, stock = COALESCE($7, stock) WHERE id = $8 RETURNING id, name, price, category, image_url, "isActive" as is_active, stock',
      [
        name,
        price || null,
        category || null,
        hasImageUrl,
        imageUrl,
        isActive !== undefined ? isActive : true,
        stock,
        id,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("Error updating product:", err);
    return res.status(500).json({ message: "Failed to update product", error: err.message });
  }
});

// Delete product
router.delete("/products/:id", auth, authorize("ADMIN"), async (req, res) => {
  const { id } = req.params;

  try {
    const { rowCount } = await pool.query("DELETE FROM products WHERE id = $1", [id]);

    if (rowCount === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.json({ message: "Product deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Failed to delete product" });
  }
});

// Dashboard stats
router.get("/dashboard/stats", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Today's sales
    const todaySales = await pool.query(
      "SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count FROM orders WHERE created_at >= $1",
      [today]
    );

    // Yesterday's sales for comparison
    const yesterdaySales = await pool.query(
      "SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE created_at >= $1 AND created_at < $2",
      [yesterday, today]
    );

    const todayTotal = parseFloat(todaySales.rows[0].total || 0);
    const yesterdayTotal = parseFloat(yesterdaySales.rows[0].total || 0);
    const orderCount = parseInt(todaySales.rows[0].count || 0);
    const avgOrderValue = orderCount > 0 ? todayTotal / orderCount : 0;
    const salesChange = yesterdayTotal > 0 ? ((todayTotal - yesterdayTotal) / yesterdayTotal * 100).toFixed(1) : 0;

    // Active orders (last 30 minutes)
    const activeOrders = await pool.query(
      "SELECT COUNT(*) as count FROM orders WHERE created_at >= NOW() - INTERVAL '30 minutes'"
    );

    // Approximate net profit based on today's recorded expenses.
    const expenseRes = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE incurred_at >= $1",
      [today]
    );
    const expensesToday = parseFloat(expenseRes.rows[0]?.total || 0);
    const netProfit = todayTotal - expensesToday;

    return res.json({
      todaySales: todayTotal.toFixed(2),
      salesChange: parseFloat(salesChange),
      totalOrders: orderCount,
      avgOrderValue: avgOrderValue.toFixed(2),
      netProfit: netProfit.toFixed(2),
      expensesToday: expensesToday.toFixed(2),
      activeOrders: parseInt(activeOrders.rows[0].count || 0),
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch dashboard stats" });
  }
});

// Dashboard sales chart
router.get("/dashboard/sales-chart", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const requestedDays = parseInt(req.query.days, 10);
    const days = Number.isFinite(requestedDays)
      ? Math.min(Math.max(requestedDays, 7), 365)
      : 7;

    const { rows } = await pool.query(
      `SELECT DATE(created_at) as day, COALESCE(SUM(total), 0) as total 
       FROM orders 
       WHERE created_at >= CURRENT_DATE - (($1 || ' days')::interval)
       GROUP BY DATE(created_at) 
       ORDER BY day ASC`,
      [days]
    );
    return res.json(rows.map(r => ({ day: r.day, total: parseFloat(r.total || 0) })));
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch sales chart" });
  }
});

// Order breakdown by type
router.get("/dashboard/order-breakdown", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const { rows } = await pool.query(
      `SELECT payment_method, COUNT(*) as count, SUM(total) as total 
       FROM orders 
       WHERE created_at >= $1 
       GROUP BY payment_method`,
      [today]
    );

    const total = rows.reduce((sum, r) => sum + parseInt(r.count), 0);
    const breakdown = rows.map(r => ({
      type: r.payment_method,
      count: parseInt(r.count),
      percentage: total > 0 ? ((parseInt(r.count) / total) * 100).toFixed(0) : 0,
      total: parseFloat(r.total || 0),
    }));

    return res.json(breakdown);
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch order breakdown" });
  }
});

// Top selling items
router.get("/dashboard/top-items", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { rows } = await pool.query(
      `SELECT p.name, SUM(oi.qty) as total_qty, SUM(oi.qty * oi.price) as revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       WHERE o.created_at >= $1
       GROUP BY p.name
       ORDER BY total_qty DESC
       LIMIT 5`,
      [today]
    );

    return res.json(rows.map(r => ({
      name: r.name,
      qty: parseInt(r.total_qty || 0),
      revenue: parseFloat(r.revenue || 0).toFixed(2),
    })));
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch top items" });
  }
});

// Recent orders
router.get("/dashboard/recent-orders", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, total, payment_method, created_at 
       FROM orders 
       ORDER BY created_at DESC 
       LIMIT 10`
    );

    return res.json(rows.map(r => ({
      id: r.id,
      total: parseFloat(r.total || 0).toFixed(2),
      paymentMethod: r.payment_method,
      createdAt: r.created_at,
    })));
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch recent orders" });
  }
});

// Sales reports with filters
router.get("/reports/sales", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const { whereSql, params } = buildReportFilter(req.query);
    const { rows } = await pool.query(
      `SELECT DATE(created_at) AS day, SUM(total) AS total, COUNT(*) AS order_count
       FROM orders
       WHERE ${whereSql}
       GROUP BY DATE(created_at)
       ORDER BY day DESC`,
      params
    );
    return res.json(rows.map(r => ({
      day: r.day,
      total: parseFloat(r.total || 0),
      orderCount: parseInt(r.order_count || 0),
    })));
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch sales reports" });
  }
});

// Detailed sales records
router.get("/reports/sales/details", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 200, 1, 1000);
    const offset = parsePositiveInt(req.query.offset, 0, 0, 1000000);
    const { whereSql, params } = buildReportFilter(req.query);
    params.push(limit);
    params.push(offset);
    const limitParam = params.length - 1;
    const offsetParam = params.length;

    const { rows } = await pool.query(
      `SELECT
         id,
         total,
         payment_method,
         order_type,
         channel,
         loyalty_points_redeemed,
         loyalty_discount_amount,
         status,
         refunded_amount,
         created_at
       FROM orders
       WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${limitParam}
       OFFSET $${offsetParam}`,
      params
    );

    return res.json(
      rows.map((row) => ({
        id: row.id,
        total: parseFloat(row.total || 0),
        paymentMethod: row.payment_method,
        orderType: row.order_type,
        channel: row.channel,
        loyaltyPointsRedeemed: parseInt(row.loyalty_points_redeemed || 0, 10),
        loyaltyDiscountAmount: parseFloat(row.loyalty_discount_amount || 0),
        status: row.status || "COMPLETED",
        refundedAmount: parseFloat(row.refunded_amount || 0),
        createdAt: row.created_at,
      }))
    );
  } catch (err) {
    console.error("Failed to fetch detailed sales:", err);
    return res.status(500).json({ message: "Failed to fetch detailed sales" });
  }
});

// Report breakdown by payment method
router.get(
  "/reports/payment-breakdown",
  auth,
  authorize("ADMIN"),
  async (req, res) => {
    try {
      const { whereSql, params } = buildReportFilter(req.query);
      const { rows } = await pool.query(
        `SELECT payment_method, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
         FROM orders
         WHERE ${whereSql}
         GROUP BY payment_method
         ORDER BY total DESC`,
        params
      );
      const totalCount = rows.reduce(
        (sum, row) => sum + parseInt(row.count || 0, 10),
        0
      );
      return res.json(
        rows.map((row) => {
          const count = parseInt(row.count || 0, 10);
          return {
            method: row.payment_method,
            count,
            total: parseFloat(row.total || 0),
            percentage:
              totalCount > 0 ? Number(((count / totalCount) * 100).toFixed(2)) : 0,
          };
        })
      );
    } catch (err) {
      console.error("Failed to fetch payment breakdown:", err);
      return res.status(500).json({ message: "Failed to fetch payment breakdown" });
    }
  }
);

// Report breakdown by order type
router.get("/reports/order-type-breakdown", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const { whereSql, params } = buildReportFilter(req.query);
    const { rows } = await pool.query(
      `SELECT order_type, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE ${whereSql}
       GROUP BY order_type
       ORDER BY total DESC`,
      params
    );
    const totalCount = rows.reduce(
      (sum, row) => sum + parseInt(row.count || 0, 10),
      0
    );
    return res.json(
      rows.map((row) => {
        const count = parseInt(row.count || 0, 10);
        return {
          type: row.order_type || "OTHER",
          count,
          total: parseFloat(row.total || 0),
          percentage:
            totalCount > 0 ? Number(((count / totalCount) * 100).toFixed(2)) : 0,
        };
      })
    );
  } catch (err) {
    console.error("Failed to fetch order type breakdown:", err);
    return res.status(500).json({ message: "Failed to fetch order type breakdown" });
  }
});

// Shift management
router.get("/shifts/current", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT *
       FROM cash_shifts
       WHERE status = 'OPEN'
       ORDER BY opened_at DESC
       LIMIT 1`
    );
    return res.json({ shift: rows[0] || null });
  } catch (err) {
    console.error("Failed to fetch current shift:", err);
    return res.status(500).json({ message: "Failed to fetch current shift" });
  }
});

router.post("/shifts/open", auth, authorize("ADMIN"), async (req, res) => {
  const openingCash = parseMoney(req.body?.opening_cash, NaN);
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
  if (!Number.isFinite(openingCash) || openingCash < 0) {
    return res.status(400).json({ message: "opening_cash must be a valid non-negative amount" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT id FROM cash_shifts WHERE status = 'OPEN' LIMIT 1 FOR UPDATE`
    );
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "An open shift already exists" });
    }

    const { rows } = await client.query(
      `INSERT INTO cash_shifts (opened_by, opening_cash, note, status)
       VALUES ($1, $2, $3, 'OPEN')
       RETURNING *`,
      [String(req.user.id), openingCash, note]
    );

    await writeAuditLog(client, {
      action: "SHIFT_OPEN",
      entity_type: "cash_shift",
      entity_id: rows[0].id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: { opening_cash: openingCash, note },
    });

    await client.query("COMMIT");
    return res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to open shift:", err);
    return res.status(500).json({ message: "Failed to open shift" });
  } finally {
    client.release();
  }
});

router.post("/shifts/:id/close", auth, authorize("ADMIN"), async (req, res) => {
  const shiftId = parsePositiveInt(req.params.id, NaN, 1, 10_000_000);
  const closingDeclared = parseMoney(req.body?.closing_cash_declared, NaN);
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;

  if (!Number.isFinite(shiftId)) {
    return res.status(400).json({ message: "Invalid shift id" });
  }
  if (!Number.isFinite(closingDeclared) || closingDeclared < 0) {
    return res.status(400).json({ message: "closing_cash_declared must be valid non-negative amount" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shiftRes = await client.query(
      `SELECT *
       FROM cash_shifts
       WHERE id = $1
       FOR UPDATE`,
      [shiftId]
    );
    const shift = shiftRes.rows[0];
    if (!shift) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Shift not found" });
    }
    if (shift.status !== "OPEN") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Shift is already closed" });
    }

    const salesRes = await client.query(
      `SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0) AS cash_sales
       FROM orders
       WHERE payment_method = 'CASH'
         AND created_at >= $1
         AND status <> 'VOIDED'`,
      [shift.opened_at]
    );
    const expectedCash =
      parseFloat(shift.opening_cash || 0) +
      parseFloat(salesRes.rows[0]?.cash_sales || 0);
    const variance = closingDeclared - expectedCash;

    const closed = await client.query(
      `UPDATE cash_shifts
       SET status = 'CLOSED',
           closed_by = $2,
           closing_cash_declared = $3,
           closing_cash_expected = $4,
           variance = $5,
           note = COALESCE($6, note),
           closed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [shiftId, String(req.user.id), closingDeclared, expectedCash, variance, note]
    );

    await writeAuditLog(client, {
      action: "SHIFT_CLOSE",
      entity_type: "cash_shift",
      entity_id: shiftId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        closing_cash_declared: closingDeclared,
        closing_cash_expected: expectedCash,
        variance,
        note,
      },
    });

    await client.query("COMMIT");
    return res.json(closed.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to close shift:", err);
    return res.status(500).json({ message: "Failed to close shift" });
  } finally {
    client.release();
  }
});

// Expense tracking
router.get("/expenses", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 30, 1, 3650);
    const limit = parsePositiveInt(req.query.limit, 200, 1, 1000);
    const { rows } = await pool.query(
      `SELECT id, category, description, amount, incurred_at, created_by, created_at
       FROM expenses
       WHERE incurred_at >= NOW() - (($1::text || ' days')::interval)
       ORDER BY incurred_at DESC
       LIMIT $2`,
      [days, limit]
    );
    return res.json(
      rows.map((row) => ({
        ...row,
        amount: parseFloat(row.amount || 0),
      }))
    );
  } catch (err) {
    console.error("Failed to fetch expenses:", err);
    return res.status(500).json({ message: "Failed to fetch expenses" });
  }
});

router.post("/expenses", auth, authorize("ADMIN"), async (req, res) => {
  const category = String(req.body?.category || "").trim().slice(0, 80);
  const description = req.body?.description
    ? String(req.body.description).trim().slice(0, 500)
    : null;
  const amount = parseMoney(req.body?.amount, NaN);
  const incurredAt = req.body?.incurred_at || null;

  if (!category) {
    return res.status(400).json({ message: "category is required" });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: "amount must be a positive number" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO expenses (category, description, amount, incurred_at, created_by)
       VALUES ($1, $2, $3, COALESCE($4, NOW()), $5)
       RETURNING *`,
      [category, description, amount, incurredAt, String(req.user.id)]
    );

    await writeAuditLog(client, {
      action: "EXPENSE_CREATE",
      entity_type: "expense",
      entity_id: rows[0].id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: { category, amount, incurred_at: rows[0].incurred_at },
    });

    await client.query("COMMIT");
    return res.status(201).json({
      ...rows[0],
      amount: parseFloat(rows[0].amount || 0),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to create expense:", err);
    return res.status(500).json({ message: "Failed to create expense" });
  } finally {
    client.release();
  }
});

// Suppliers
router.get("/suppliers", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, phone, email, address, is_active, created_at
       FROM suppliers
       ORDER BY name`
    );
    return res.json(rows);
  } catch (err) {
    console.error("Failed to fetch suppliers:", err);
    return res.status(500).json({ message: "Failed to fetch suppliers" });
  }
});

router.post("/suppliers", auth, authorize("ADMIN"), async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 120);
  const phone = req.body?.phone ? String(req.body.phone).trim().slice(0, 40) : null;
  const email = req.body?.email ? String(req.body.email).trim().slice(0, 120) : null;
  const address = req.body?.address ? String(req.body.address).trim().slice(0, 500) : null;
  if (!name) {
    return res.status(400).json({ message: "name is required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO suppliers (name, phone, email, address)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, phone, email, address]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Failed to create supplier:", err);
    return res.status(500).json({ message: "Failed to create supplier" });
  }
});

// Purchase orders
router.get("/purchase-orders", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 200, 1, 1000);
    const { rows } = await pool.query(
      `SELECT
         po.id,
         po.supplier_id,
         s.name AS supplier_name,
         po.status,
         po.note,
         po.ordered_at,
         po.expected_at,
         po.created_by,
         COALESCE(
           json_agg(
             DISTINCT jsonb_build_object(
               'id', poi.id,
               'inventory_item_id', poi.inventory_item_id,
               'qty', poi.qty,
               'unit_cost', poi.unit_cost
             )
           ) FILTER (WHERE poi.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id::text = po.supplier_id
       LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       GROUP BY po.id, s.name
       ORDER BY po.ordered_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Failed to fetch purchase orders:", err);
    return res.status(500).json({ message: "Failed to fetch purchase orders" });
  }
});

router.post("/purchase-orders", auth, authorize("ADMIN"), async (req, res) => {
  const supplierId = String(req.body?.supplier_id || "").trim().slice(0, 120);
  const expectedAt = req.body?.expected_at || null;
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  const normalizedItems = items
    .map((item) => ({
      inventory_item_id: parsePositiveInt(item?.inventory_item_id, NaN, 1, 1_000_000),
      qty: parseMoney(item?.qty, NaN),
      unit_cost: parseMoney(item?.unit_cost, 0),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.inventory_item_id) &&
        Number.isFinite(item.qty) &&
        item.qty > 0
    );

  if (!supplierId) {
    return res.status(400).json({ message: "supplier_id is required" });
  }
  if (normalizedItems.length === 0) {
    return res.status(400).json({ message: "At least one valid purchase order item is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const supplierRes = await client.query(
      `SELECT id
       FROM suppliers
       WHERE id::text = $1
       LIMIT 1`,
      [supplierId]
    );
    if (supplierRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid supplier_id" });
    }
    const normalizedSupplierId = String(supplierRes.rows[0].id);

    const poRes = await client.query(
      `INSERT INTO purchase_orders (supplier_id, status, note, expected_at, created_by)
       VALUES ($1, 'PLACED', $2, $3, $4)
       RETURNING *`,
      [normalizedSupplierId, note, expectedAt, String(req.user.id)]
    );
    const po = poRes.rows[0];

    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, qty, unit_cost)
         VALUES ($1, $2, $3, $4)`,
        [po.id, item.inventory_item_id, item.qty, item.unit_cost]
      );
    }

    await writeAuditLog(client, {
      action: "PURCHASE_ORDER_CREATE",
      entity_type: "purchase_order",
      entity_id: po.id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        supplier_id: normalizedSupplierId,
        item_count: normalizedItems.length,
      },
    });

    await client.query("COMMIT");
    return res.status(201).json(po);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to create purchase order:", err);
    return res.status(500).json({ message: "Failed to create purchase order" });
  } finally {
    client.release();
  }
});

router.post(
  "/purchase-orders/:id/receive",
  auth,
  authorize("ADMIN"),
  async (req, res) => {
    const poId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
    if (!Number.isFinite(poId)) {
      return res.status(400).json({ message: "Invalid purchase order id" });
    }

    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const poRes = await client.query(
        `SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`,
        [poId]
      );
      const po = poRes.rows[0];
      if (!po) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Purchase order not found" });
      }

      const itemsRes = await client.query(
        `SELECT inventory_item_id, qty, unit_cost
         FROM purchase_order_items
         WHERE purchase_order_id = $1`,
        [poId]
      );
      const poItems = itemsRes.rows;
      if (poItems.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Purchase order has no items to receive" });
      }

      const grnRes = await client.query(
        `INSERT INTO goods_receipts (purchase_order_id, received_by, note)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [poId, String(req.user.id), note]
      );
      const grn = grnRes.rows[0];

      for (const item of poItems) {
        const qty = parseFloat(item.qty || 0);
        const unitCost = parseFloat(item.unit_cost || 0);
        if (!Number.isFinite(qty) || qty <= 0) {
          continue;
        }

        await client.query(
          `INSERT INTO goods_receipt_items (goods_receipt_id, inventory_item_id, qty_received, unit_cost)
           VALUES ($1, $2, $3, $4)`,
          [grn.id, item.inventory_item_id, qty, unitCost]
        );

        await client.query(
          `UPDATE inventory_items
           SET current_stock = COALESCE(current_stock, 0) + $1,
               unit_cost = CASE
                 WHEN $2 > 0 THEN $2
                 ELSE COALESCE(unit_cost, 0)
               END,
               updated_at = NOW()
           WHERE id = $3`,
          [qty, unitCost, item.inventory_item_id]
        );
      }

      await client.query(
        `UPDATE purchase_orders
         SET status = 'RECEIVED'
         WHERE id = $1`,
        [poId]
      );

      await writeAuditLog(client, {
        action: "PURCHASE_ORDER_RECEIVE",
        entity_type: "purchase_order",
        entity_id: poId,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: { goods_receipt_id: grn.id, item_count: poItems.length },
      });

      await client.query("COMMIT");
      return res.json({ message: "Purchase order received", goods_receipt: grn });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Failed to receive purchase order:", err);
      return res.status(500).json({ message: "Failed to receive purchase order" });
    } finally {
      client.release();
    }
  }
);

// CSV backup download
router.get("/backup/csv", auth, authorize("ADMIN"), async (_req, res) => {
  const client = await pool.connect();
  try {
    const { csv, totalRows } = await buildBackupCsv(client);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `camellia-backup-${timestamp}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("X-Backup-Rows", String(totalRows));
    return res.status(200).send(csv);
  } catch (err) {
    console.error("Backup generation failed:", err);
    return res.status(500).json({ message: "Failed to generate CSV backup" });
  } finally {
    client.release();
  }
});

// Restore from CSV backup
router.post(
  "/restore/csv",
  auth,
  authorize("ADMIN"),
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "CSV backup file is required" });
    }

    let parsedRows;
    try {
      parsedRows = parseBackupCsv(req.file.buffer.toString("utf8"));
    } catch (err) {
      return res.status(400).json({
        message:
          err?.message ||
          "Invalid backup file. Please use a CSV downloaded from this system.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const truncatedTables = await truncateBusinessTables(client);
      const restoredRows = await restoreFromParsedRows(client, parsedRows);
      await client.query("COMMIT");

      return res.json({
        message: "System restored successfully from CSV backup",
        restoredRows,
        truncatedTables,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Restore failed:", err);
      return res.status(500).json({
        message:
          "Restore failed. Please verify the backup file and try again.",
      });
    } finally {
      client.release();
    }
  }
);

// Reset all business data (users are preserved)
router.post("/reset", auth, authorize("ADMIN"), async (req, res) => {
  const providedSecret = String(req.body?.secretCode || "").trim();
  const configuredSecret = String(
    process.env.SYSTEM_RESET_SECRET || process.env.RESET_SECRET_CODE || ""
  ).trim();

  if (!configuredSecret) {
    return res.status(500).json({
      message:
        "System reset secret is not configured. Set SYSTEM_RESET_SECRET in backend .env.",
    });
  }

  if (!providedSecret) {
    return res.status(400).json({ message: "Reset secret code is required" });
  }

  if (providedSecret !== configuredSecret) {
    return res.status(403).json({ message: "Invalid reset secret code" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const truncatedTables = await truncateBusinessTables(client);
    await client.query("COMMIT");
    return res.json({
      message: "System reset completed successfully",
      truncatedTables,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("System reset failed:", err);
    return res.status(500).json({ message: "System reset failed" });
  } finally {
    client.release();
  }
});

// Backup stub
router.post("/backup", auth, authorize("ADMIN"), async (_req, res) => {
  return res.json({
    message: "Backup is available through the CSV download action.",
  });
});

// Restore stub
router.post(
  "/restore",
  auth,
  authorize("ADMIN"),
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "Backup file is required" });
    }
    return res.json({
      message: "Restore is available through the CSV restore action.",
    });
  }
);


export default router;
