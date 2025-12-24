import express from "express";
import multer from "multer";
import auth from "../middleware/auth.js";
import authorize from "../middleware/authorize.js";
import pool from "../db.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

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

// Dashboard sales chart (last 7 days)
router.get("/dashboard/sales-chart", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DATE(created_at) as day, COALESCE(SUM(total), 0) as total 
       FROM orders 
       WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
       GROUP BY DATE(created_at) 
       ORDER BY day ASC`
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

// Backup stub
router.post("/backup", auth, authorize("ADMIN"), async (_req, res) => {
  // In production, run pg_dump and stream file; here we just acknowledge.
  return res.json({ message: "Backup triggered (stub)" });
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
    // In production, feed file buffer to psql; here we just acknowledge.
    return res.json({ message: "Restore received (stub)" });
  }
);

export default router;

