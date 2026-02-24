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
  "orders",
  "order_items",
];

const RESTORE_ORDER = [
  "products",
  "inventory_items",
  "customers",
  "customer_tags",
  "customer_campaigns",
  "orders",
  "product_ingredients",
  "inventory_alerts",
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
  "customer_tags",
  "customers",
  "products",
];

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
      'SELECT id, name, price, category, "isActive" as is_active, stock FROM products ORDER BY name'
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
      'SELECT id, name, price, category FROM products WHERE "isActive" = true ORDER BY category, name'
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
      'INSERT INTO products (name, price, category, "isActive", stock) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, price, category, "isActive" as is_active',
      [name, priceNum, category || null, isActive, 0]
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

  if (!name) {
    return res.status(400).json({ message: "Name is required" });
  }

  try {
    const { rows } = await pool.query(
      'UPDATE products SET name = $1, price = $2, category = $3, "isActive" = $4, stock = COALESCE($5, stock) WHERE id = $6 RETURNING id, name, price, category, "isActive" as is_active, stock',
      [name, price || null, category || null, isActive !== undefined ? isActive : true, stock, id]
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

    // Net profit (assuming 30% margin for demo)
    const netProfit = todayTotal * 0.3;

    return res.json({
      todaySales: todayTotal.toFixed(2),
      salesChange: parseFloat(salesChange),
      totalOrders: orderCount,
      avgOrderValue: avgOrderValue.toFixed(2),
      netProfit: netProfit.toFixed(2),
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
    const { days = 30, orderType, paymentMethod } = req.query;
    const daysInt = parseInt(days) || 30;
    
    let query = `
      SELECT DATE(created_at) as day, SUM(total) as total, COUNT(*) as order_count
      FROM orders 
      WHERE created_at >= CURRENT_DATE - INTERVAL '${daysInt} days'
    `;
    
    const params = [];
    let paramCount = 1;
    
    if (orderType && orderType !== "ALL") {
      // Note: orderType would need to be stored in orders table
      // For now, we'll just filter by date
    }
    
    if (paymentMethod && paymentMethod !== "ALL") {
      query += ` AND payment_method = $${paramCount}`;
      params.push(paymentMethod);
      paramCount++;
    }
    
    query += ` GROUP BY DATE(created_at) ORDER BY day DESC`;
    
    const { rows } = await pool.query(query, params);
    return res.json(rows.map(r => ({
      day: r.day,
      total: parseFloat(r.total || 0),
      orderCount: parseInt(r.order_count || 0),
    })));
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch sales reports" });
  }
});

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
    process.env.SYSTEM_RESET_SECRET ||
      process.env.RESET_SECRET_CODE ||
      process.env.JWT_SECRET ||
      ""
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
