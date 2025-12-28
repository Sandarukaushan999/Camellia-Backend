import express from "express";
import auth from "../middleware/auth.js";
import authorize from "../middleware/authorize.js";
import pool from "../db.js";

const router = express.Router();

// Test route to verify inventory routes are working
router.get("/test", (_req, res) => {
  return res.json({ message: "Inventory routes are working" });
});

// Get all inventory items
router.get("/items", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, unit, current_stock, min_stock, expiry_date, category, "isActive", 
       created_at, updated_at 
       FROM inventory_items 
       ORDER BY name`
    );
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching inventory items:", err);
    return res.status(500).json({ message: "Failed to fetch inventory items", error: err.message });
  }
});

// Get inventory item by ID
router.get("/items/:id", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT id, name, unit, current_stock, min_stock, expiry_date, category, "isActive" 
       FROM inventory_items WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Inventory item not found" });
    }
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch inventory item" });
  }
});

// Create inventory item
router.post("/items", auth, authorize("ADMIN"), async (req, res) => {
  const { name, unit = "g", current_stock = 0, min_stock = 0, expiry_date, category } = req.body;
  
  if (!name) {
    return res.status(400).json({ message: "Name is required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO inventory_items (name, unit, current_stock, min_stock, expiry_date, category) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, name, unit, current_stock, min_stock, expiry_date, category, "isActive"`,
      [name, unit, current_stock, min_stock, expiry_date || null, category || null]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ message: "Inventory item with this name already exists" });
    }
    console.error("Error creating inventory item:", err);
    return res.status(500).json({ message: "Failed to create inventory item", error: err.message });
  }
});

// Update inventory item
router.put("/items/:id", auth, authorize("ADMIN"), async (req, res) => {
  const { id } = req.params;
  const { name, unit, current_stock, min_stock, expiry_date, category, isActive } = req.body;

  if (!name) {
    return res.status(400).json({ message: "Name is required" });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE inventory_items 
       SET name = $1, unit = COALESCE($2, unit), current_stock = COALESCE($3, current_stock), 
           min_stock = COALESCE($4, min_stock), expiry_date = $5, category = $6, 
           "isActive" = COALESCE($7, "isActive"), updated_at = NOW()
       WHERE id = $8 
       RETURNING id, name, unit, current_stock, min_stock, expiry_date, category, "isActive"`,
      [name, unit, current_stock, min_stock, expiry_date || null, category || null, isActive, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("Error updating inventory item:", err);
    return res.status(500).json({ message: "Failed to update inventory item", error: err.message });
  }
});

// Delete inventory item
router.delete("/items/:id", auth, authorize("ADMIN"), async (req, res) => {
  const { id } = req.params;

  try {
    const { rowCount } = await pool.query("DELETE FROM inventory_items WHERE id = $1", [id]);

    if (rowCount === 0) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    return res.json({ message: "Inventory item deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Failed to delete inventory item" });
  }
});

// Get product ingredients
router.get("/products/:productId/ingredients", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const { productId } = req.params;
    const { rows } = await pool.query(
      `SELECT pi.id, pi.product_id, pi.inventory_item_id, pi.quantity,
       ii.name as inventory_item_name, ii.unit, ii.current_stock
       FROM product_ingredients pi
       JOIN inventory_items ii ON pi.inventory_item_id = ii.id
       WHERE pi.product_id = $1`,
      [productId]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching product ingredients:", err);
    return res.status(500).json({ message: "Failed to fetch product ingredients" });
  }
});

// Add/Update product ingredients
router.post("/products/:productId/ingredients", auth, authorize("ADMIN"), async (req, res) => {
  const { productId } = req.params;
  const { ingredients } = req.body; // Array of {inventory_item_id, quantity}

  if (!Array.isArray(ingredients)) {
    return res.status(400).json({ message: "Ingredients must be an array" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Delete existing ingredients
    await client.query("DELETE FROM product_ingredients WHERE product_id = $1", [productId]);

    // Insert new ingredients
    for (const ing of ingredients) {
      if (ing.inventory_item_id && ing.quantity > 0) {
        await client.query(
          `INSERT INTO product_ingredients (product_id, inventory_item_id, quantity) 
           VALUES ($1, $2, $3)
           ON CONFLICT (product_id, inventory_item_id) 
           DO UPDATE SET quantity = $3`,
          [productId, ing.inventory_item_id, ing.quantity]
        );
      }
    }

    await client.query("COMMIT");
    return res.json({ message: "Product ingredients updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating product ingredients:", err);
    return res.status(500).json({ message: "Failed to update product ingredients" });
  } finally {
    client.release();
  }
});

// Get alerts (low stock, expiry)
router.get("/alerts", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    // Check if inventory_items table exists
    const tableCheck = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'inventory_items'
      )`
    );

    if (!tableCheck.rows[0].exists) {
      // Table doesn't exist yet, return empty alerts
      return res.json({
        lowStock: [],
        nearExpiry: [],
        expired: []
      });
    }

    const now = new Date();
    const threeDaysFromNow = new Date(now);
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

    // Low stock alerts
    const lowStockItems = await pool.query(
      `SELECT id, name, unit, current_stock, min_stock 
       FROM inventory_items 
       WHERE "isActive" = true AND current_stock <= min_stock AND current_stock > 0`
    );

    // Near expiry alerts (within 3 days)
    const nearExpiryItems = await pool.query(
      `SELECT id, name, unit, current_stock, expiry_date 
       FROM inventory_items 
       WHERE "isActive" = true 
       AND expiry_date IS NOT NULL 
       AND expiry_date <= $1 
       AND expiry_date >= $2`,
      [threeDaysFromNow, now]
    );

    // Expired items
    const expiredItems = await pool.query(
      `SELECT id, name, unit, current_stock, expiry_date 
       FROM inventory_items 
       WHERE "isActive" = true 
       AND expiry_date IS NOT NULL 
       AND expiry_date < $1`,
      [now]
    );

    return res.json({
      lowStock: lowStockItems.rows.map(item => ({
        ...item,
        alertType: "LOW_STOCK",
        message: `${item.name} is low stock (${item.current_stock} ${item.unit} remaining, minimum: ${item.min_stock} ${item.unit})`
      })),
      nearExpiry: nearExpiryItems.rows.map(item => ({
        ...item,
        alertType: "EXPIRY",
        message: `${item.name} expires on ${new Date(item.expiry_date).toLocaleDateString()}`
      })),
      expired: expiredItems.rows.map(item => ({
        ...item,
        alertType: "EXPIRED",
        message: `${item.name} has expired on ${new Date(item.expiry_date).toLocaleDateString()}`
      }))
    });
  } catch (err) {
    console.error("Error fetching alerts:", err);
    console.error("Error stack:", err.stack);
    // Return empty alerts instead of error to prevent UI issues
    return res.json({
      lowStock: [],
      nearExpiry: [],
      expired: []
    });
  }
});

// Deduct inventory for an order (called from orders route)
export async function deductInventoryForOrder(orderId, items) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const item of items) {
      // Get product ingredients
      const { rows: ingredients } = await client.query(
        `SELECT inventory_item_id, quantity 
         FROM product_ingredients 
         WHERE product_id = $1`,
        [item.product_id]
      );

      // Deduct each ingredient
      for (const ing of ingredients) {
        const totalDeduction = ing.quantity * item.qty;
        await client.query(
          `UPDATE inventory_items 
           SET current_stock = GREATEST(0, current_stock - $1), updated_at = NOW()
           WHERE id = $2`,
          [totalDeduction, ing.inventory_item_id]
        );
      }
    }

    await client.query("COMMIT");
    return { success: true };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error deducting inventory:", err);
    throw err;
  } finally {
    client.release();
  }
}

export default router;

