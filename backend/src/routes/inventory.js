import express from "express";
import auth from "../middleware/auth.js";
import authorize from "../middleware/authorize.js";
import pool from "../db.js";

const router = express.Router();

let productIngredientsSchemaPromise = null;

async function getProductIngredientsSchema(clientOrPool = pool) {
  if (!productIngredientsSchemaPromise) {
    productIngredientsSchemaPromise = (async () => {
      const { rows } = await clientOrPool.query(
        `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'product_ingredients'`
      );

      const byColumn = Object.fromEntries(rows.map((row) => [row.column_name, row]));

      return {
        hasQuantity: Boolean(byColumn.quantity),
        hasQuantityRequired: Boolean(byColumn.quantity_required),
        hasUnit: Boolean(byColumn.unit),
        requiresUnitExplicit:
          Boolean(byColumn.unit) &&
          byColumn.unit.is_nullable === "NO" &&
          !byColumn.unit.column_default,
      };
    })();
  }

  return productIngredientsSchemaPromise;
}

function getRecipeQuantityExpression(schema, alias = "pi") {
  if (schema.hasQuantityRequired) {
    return `${alias}.quantity_required`;
  }
  if (schema.hasQuantity) {
    return `${alias}.quantity`;
  }
  return "0";
}

async function resolveProductId(clientOrPool, productIdParam) {
  const { rows } = await clientOrPool.query(
    `SELECT id
     FROM products
     WHERE id::text = $1
     LIMIT 1`,
    [String(productIdParam)]
  );
  return rows[0]?.id || null;
}

async function resolveInventoryItemId(clientOrPool, itemIdParam) {
  const { rows } = await clientOrPool.query(
    `SELECT id
     FROM inventory_items
     WHERE id::text = $1
     LIMIT 1`,
    [String(itemIdParam)]
  );
  return rows[0]?.id || null;
}

function buildIngredientUpsertStatement(schema, productId, inventoryItemId, quantity) {
  const columns = ["product_id", "inventory_item_id"];
  const values = [productId, inventoryItemId];
  const updates = [];

  if (schema.hasQuantityRequired) {
    columns.push("quantity_required");
    values.push(quantity);
    updates.push("quantity_required = EXCLUDED.quantity_required");
  }

  if (schema.hasQuantity) {
    columns.push("quantity");
    values.push(quantity);
    updates.push("quantity = EXCLUDED.quantity");
  }

  if (schema.requiresUnitExplicit) {
    columns.push("unit");
    values.push("g");
    updates.push("unit = EXCLUDED.unit");
  }

  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
  const updateClause =
    updates.length > 0 ? updates.join(", ") : "product_id = EXCLUDED.product_id";

  return {
    text: `INSERT INTO product_ingredients (${columns.join(", ")})
           VALUES (${placeholders})
           ON CONFLICT (product_id, inventory_item_id)
           DO UPDATE SET ${updateClause}`,
    values,
  };
}

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
    const resolvedProductId = await resolveProductId(pool, productId);
    if (!resolvedProductId) {
      return res.status(404).json({ message: "Product not found" });
    }

    const schema = await getProductIngredientsSchema(pool);
    const quantityExpr = getRecipeQuantityExpression(schema, "pi");

    const { rows } = await pool.query(
      `SELECT pi.id, pi.product_id, pi.inventory_item_id, ${quantityExpr} as quantity,
       ii.name as inventory_item_name, ii.unit, ii.current_stock
       FROM product_ingredients pi
       JOIN inventory_items ii ON pi.inventory_item_id = ii.id
       WHERE pi.product_id = $1`,
      [resolvedProductId]
    );
    return res.json(
      rows.map((row) => ({
        ...row,
        quantity: parseFloat(row.quantity || 0),
      }))
    );
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
    const resolvedProductId = await resolveProductId(client, productId);
    if (!resolvedProductId) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }

    const schema = await getProductIngredientsSchema(client);

    // Delete existing ingredients
    await client.query("DELETE FROM product_ingredients WHERE product_id = $1", [resolvedProductId]);

    // Insert new ingredients
    for (const ing of ingredients) {
      const inventoryItemId = parseInt(ing.inventory_item_id, 10);
      const quantity = parseFloat(ing.quantity);

      if (Number.isFinite(inventoryItemId) && Number.isFinite(quantity) && quantity > 0) {
        const statement = buildIngredientUpsertStatement(
          schema,
          resolvedProductId,
          inventoryItemId,
          quantity
        );
        await client.query(statement.text, statement.values);
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

// Get all products and their link quantity for one inventory item
router.get("/items/:itemId/product-links", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const { itemId } = req.params;
    const resolvedItemId = await resolveInventoryItemId(pool, itemId);
    if (!resolvedItemId) {
      return res.status(404).json({ message: "Inventory item not found" });
    }

    const schema = await getProductIngredientsSchema(pool);
    const quantityExpr = getRecipeQuantityExpression(schema, "pi");

    const { rows } = await pool.query(
      `SELECT
        p.id,
        p.name,
        p.category,
        p.price,
        p."isActive" as is_active,
        COALESCE(${quantityExpr}, 0) as quantity
      FROM products p
      LEFT JOIN product_ingredients pi
        ON pi.product_id = p.id
       AND pi.inventory_item_id = $1
      ORDER BY p.name`,
      [resolvedItemId]
    );

    return res.json(rows.map((row) => ({
      ...row,
      quantity: parseFloat(row.quantity || 0),
    })));
  } catch (err) {
    console.error("Error fetching inventory item product links:", err);
    return res.status(500).json({ message: "Failed to fetch product links" });
  }
});

// Set product link quantities for one inventory item
router.post("/items/:itemId/product-links", auth, authorize("ADMIN"), async (req, res) => {
  const { itemId } = req.params;
  const { links } = req.body;

  if (!Array.isArray(links)) {
    return res.status(400).json({ message: "Links must be an array" });
  }

  const normalizedLinks = links
    .map((link) => ({
      product_id: String(link.product_id || "").trim(),
      quantity: parseFloat(link.quantity),
    }))
    .filter(
      (link) =>
        link.product_id.length > 0 &&
        Number.isFinite(link.quantity) &&
        link.quantity > 0
    );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resolvedItemId = await resolveInventoryItemId(client, itemId);
    if (!resolvedItemId) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Inventory item not found" });
    }

    const schema = await getProductIngredientsSchema(client);

    // Replace all existing links for this inventory item
    await client.query("DELETE FROM product_ingredients WHERE inventory_item_id = $1", [resolvedItemId]);

    for (const link of normalizedLinks) {
      const resolvedProductId = await resolveProductId(client, link.product_id);
      if (!resolvedProductId) {
        continue;
      }

      const statement = buildIngredientUpsertStatement(
        schema,
        resolvedProductId,
        resolvedItemId,
        link.quantity
      );
      await client.query(statement.text, statement.values);
    }

    await client.query("COMMIT");
    return res.json({ message: "Product links updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating inventory item product links:", err);
    return res.status(500).json({ message: "Failed to update product links" });
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
    const schema = await getProductIngredientsSchema(client);
    const quantityExpr = getRecipeQuantityExpression(schema, "pi");

    for (const item of items) {
      // Get product ingredients
      const { rows: ingredients } = await client.query(
        `SELECT inventory_item_id, ${quantityExpr} as quantity
         FROM product_ingredients pi
         WHERE pi.product_id::text = $1`,
        [String(item.product_id)]
      );

      // Deduct each ingredient
      for (const ing of ingredients) {
        const quantityPerProduct = parseFloat(ing.quantity || 0);
        const orderQty = parseFloat(item.qty || 0);
        const totalDeduction = quantityPerProduct * orderQty;

        if (!Number.isFinite(totalDeduction) || totalDeduction <= 0) {
          continue;
        }

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
