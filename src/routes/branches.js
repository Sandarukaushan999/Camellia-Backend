import express from "express";
import auth from "../middleware/auth.js";
import authorize from "../middleware/authorize.js";
import pool from "../db.js";

const router = express.Router();

function parsePositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 40);
}

function normalizeEntityId(value) {
  return String(value || "").trim().slice(0, 120);
}

function parseMoney(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.round(parsed * 100) / 100;
}

async function writeAuditLog(clientOrPool, payload) {
  const source = clientOrPool || pool;
  await source.query(
    `INSERT INTO audit_logs (action, entity_type, entity_id, actor_id, actor_role, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      String(payload?.action || "UNKNOWN").slice(0, 80),
      String(payload?.entity_type || "UNKNOWN").slice(0, 80),
      payload?.entity_id === undefined || payload?.entity_id === null
        ? null
        : String(payload.entity_id).slice(0, 120),
      payload?.actor_id ? String(payload.actor_id).slice(0, 120) : null,
      payload?.actor_role ? String(payload.actor_role).slice(0, 40) : null,
      JSON.stringify(payload?.payload || {}),
    ]
  );
}

router.get("/", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  try {
    const includeInactive = String(req.query.include_inactive || "").toLowerCase() === "true";
    const { rows } = await pool.query(
      `SELECT id, code, name, address, timezone, is_active, created_at, updated_at
       FROM branches
       WHERE ($1::boolean = TRUE OR is_active = TRUE)
       ORDER BY id ASC`,
      [includeInactive]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Failed to fetch branches:", err);
    return res.status(500).json({ message: "Failed to fetch branches" });
  }
});

router.get("/me/default", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  try {
    const userId = String(req.user?.id || "");
    const assigned = await pool.query(
      `SELECT b.id, b.code, b.name, b.address, b.timezone, b.is_active
       FROM branch_users bu
       JOIN branches b ON b.id = bu.branch_id
       WHERE bu.user_id = $1
         AND bu.is_active = TRUE
         AND b.is_active = TRUE
       ORDER BY bu.id ASC
       LIMIT 1`,
      [userId]
    );
    if (assigned.rows[0]) {
      return res.json({ branch: assigned.rows[0] });
    }

    const fallback = await pool.query(
      `SELECT id, code, name, address, timezone, is_active
       FROM branches
       WHERE is_active = TRUE
       ORDER BY id ASC
       LIMIT 1`
    );
    return res.json({ branch: fallback.rows[0] || null });
  } catch (err) {
    console.error("Failed to fetch default branch:", err);
    return res.status(500).json({ message: "Failed to fetch default branch" });
  }
});

router.post("/", auth, authorize("ADMIN"), async (req, res) => {
  const codeInput = normalizeCode(req.body?.code);
  const name = String(req.body?.name || "").trim().slice(0, 120);
  const address = req.body?.address ? String(req.body.address).trim().slice(0, 500) : null;
  const timezone = req.body?.timezone
    ? String(req.body.timezone).trim().slice(0, 80)
    : "UTC";
  const isActive = req.body?.is_active !== false;

  if (!name) {
    return res.status(400).json({ message: "name is required" });
  }
  const generatedCode = codeInput || normalizeCode(name.replace(/\s+/g, "_"));
  if (!generatedCode) {
    return res.status(400).json({ message: "code is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const insertRes = await client.query(
      `INSERT INTO branches (code, name, address, timezone, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, code, name, address, timezone, is_active, created_at, updated_at`,
      [generatedCode, name, address, timezone, isActive]
    );
    const branch = insertRes.rows[0];

    await writeAuditLog(client, {
      action: "BRANCH_CREATE",
      entity_type: "branch",
      entity_id: branch.id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: { code: branch.code, name: branch.name },
    });
    await client.query("COMMIT");
    return res.status(201).json(branch);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err?.code === "23505") {
      return res.status(409).json({ message: "Branch code already exists" });
    }
    console.error("Failed to create branch:", err);
    return res.status(500).json({ message: "Failed to create branch" });
  } finally {
    client.release();
  }
});

router.get("/product-overrides/matrix", auth, authorize("ADMIN"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         b.id AS branch_id,
         b.code AS branch_code,
         b.name AS branch_name,
         p.id::text AS product_id,
         p.name AS product_name,
         p.category AS product_category,
         p.price AS base_price,
         p."isActive" AS base_active,
         (bp.id IS NOT NULL) AS has_override,
         bp.price_override,
         bp.is_active AS branch_is_active,
         bp.updated_at AS override_updated_at,
         COALESCE(bp.price_override, p.price) AS effective_price,
         CASE
           WHEN bp.id IS NULL THEN p."isActive"
           ELSE bp.is_active
         END AS effective_active
       FROM products p
       CROSS JOIN branches b
       LEFT JOIN branch_products bp
         ON bp.branch_id = b.id
        AND bp.product_id = p.id::text
       WHERE b.is_active = TRUE
       ORDER BY p.category NULLS LAST, p.name ASC, b.id ASC`
    );

    const branchMap = new Map();
    const productMap = new Map();

    for (const row of rows) {
      const branchId = Number(row.branch_id);
      const productId = String(row.product_id);

      if (!branchMap.has(branchId)) {
        branchMap.set(branchId, {
          id: branchId,
          code: row.branch_code,
          name: row.branch_name,
        });
      }

      if (!productMap.has(productId)) {
        productMap.set(productId, {
          product_id: productId,
          name: row.product_name,
          category: row.product_category,
          base_price: parseFloat(row.base_price || 0),
          base_active: row.base_active === true,
          overrides: {},
        });
      }

      const product = productMap.get(productId);
      product.overrides[String(branchId)] = {
        branch_id: branchId,
        branch_code: row.branch_code,
        branch_name: row.branch_name,
        has_override: row.has_override === true,
        price_override:
          row.price_override === null ? null : parseFloat(row.price_override || 0),
        branch_is_active:
          row.branch_is_active === null ? null : row.branch_is_active === true,
        effective_price: parseFloat(row.effective_price || 0),
        effective_active: row.effective_active === true,
        override_updated_at: row.override_updated_at || null,
      };
    }

    return res.json({
      branches: Array.from(branchMap.values()),
      products: Array.from(productMap.values()),
    });
  } catch (err) {
    console.error("Failed to fetch branch product override matrix:", err);
    return res.status(500).json({ message: "Failed to fetch branch product override matrix" });
  }
});

router.put("/product-overrides/matrix", auth, authorize("ADMIN"), async (req, res) => {
  const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  if (updates.length === 0) {
    return res.status(400).json({ message: "updates array is required" });
  }
  if (updates.length > 2000) {
    return res.status(400).json({ message: "Too many updates in one request (max 2000)" });
  }

  const normalized = [];
  const errors = [];

  for (let index = 0; index < updates.length; index += 1) {
    const entry = updates[index] || {};
    const branchId = parsePositiveInt(entry.branch_id, NaN, 1, 1_000_000);
    const productId = normalizeEntityId(entry.product_id);
    const deleteOverride = entry.delete_override === true;
    const hasIsActive = Object.prototype.hasOwnProperty.call(entry, "is_active");
    const hasPriceOverride = Object.prototype.hasOwnProperty.call(entry, "price_override");
    const priceOverrideRaw = entry.price_override;
    const parsedPrice = parseMoney(priceOverrideRaw, NaN);
    const normalizedPrice =
      !hasPriceOverride || priceOverrideRaw === null || String(priceOverrideRaw).trim() === ""
        ? null
        : parsedPrice;
    const clearOverride = entry.clear_override === true || normalizedPrice === null;
    const isActive = hasIsActive ? entry.is_active === true : null;

    if (!Number.isFinite(branchId)) {
      errors.push(`Row ${index + 1}: invalid branch_id`);
      continue;
    }
    if (!productId) {
      errors.push(`Row ${index + 1}: invalid product_id`);
      continue;
    }
    if (
      hasPriceOverride &&
      normalizedPrice !== null &&
      (!Number.isFinite(normalizedPrice) || normalizedPrice < 0)
    ) {
      errors.push(`Row ${index + 1}: price_override must be a non-negative number`);
      continue;
    }
    if (!deleteOverride && !hasIsActive && !hasPriceOverride && !clearOverride) {
      errors.push(`Row ${index + 1}: no editable fields provided`);
      continue;
    }

    normalized.push({
      branch_id: branchId,
      product_id: productId,
      delete_override: deleteOverride,
      has_is_active: hasIsActive,
      is_active: isActive,
      has_price_override: hasPriceOverride,
      clear_override: clearOverride,
      price_override: normalizedPrice,
    });
  }

  if (errors.length > 0) {
    return res.status(400).json({
      message: "Invalid bulk matrix payload",
      errors: errors.slice(0, 8),
    });
  }

  const branchIds = [...new Set(normalized.map((item) => item.branch_id))];
  const productIds = [...new Set(normalized.map((item) => item.product_id))];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const activeBranchRows = (
      await client.query(
        `SELECT id
         FROM branches
         WHERE is_active = TRUE
           AND id = ANY($1::int[])`,
        [branchIds]
      )
    ).rows;
    const activeBranchSet = new Set(activeBranchRows.map((row) => Number(row.id)));
    const missingBranches = branchIds.filter((id) => !activeBranchSet.has(id));
    if (missingBranches.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "Some branch ids are invalid or inactive",
        missing_branch_ids: missingBranches,
      });
    }

    const productRows = (
      await client.query(
        `SELECT id::text AS id
         FROM products
         WHERE id::text = ANY($1::text[])`,
        [productIds]
      )
    ).rows;
    const productSet = new Set(productRows.map((row) => String(row.id)));
    const missingProducts = productIds.filter((id) => !productSet.has(String(id)));
    if (missingProducts.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "Some product ids are invalid",
        missing_product_ids: missingProducts.slice(0, 30),
      });
    }

    let upserted = 0;
    let deleted = 0;
    for (const item of normalized) {
      if (item.delete_override) {
        const deleteRes = await client.query(
          `DELETE FROM branch_products
           WHERE branch_id = $1
             AND product_id = $2
           RETURNING id`,
          [item.branch_id, item.product_id]
        );
        if (deleteRes.rows[0]) {
          deleted += 1;
        }
        continue;
      }

      const updateRes = await client.query(
        `UPDATE branch_products
         SET price_override = CASE
               WHEN $3::boolean THEN NULL
               WHEN $4::boolean THEN $5
               ELSE price_override
             END,
             is_active = CASE
               WHEN $6::boolean THEN $7
               ELSE is_active
             END,
             updated_at = NOW()
         WHERE branch_id = $1
           AND product_id = $2
         RETURNING *`,
        [
          item.branch_id,
          item.product_id,
          item.clear_override,
          item.has_price_override,
          item.price_override,
          item.has_is_active,
          item.is_active,
        ]
      );

      if (!updateRes.rows[0]) {
        await client.query(
          `INSERT INTO branch_products (
             branch_id,
             product_id,
             price_override,
             is_active,
             updated_at
           )
           VALUES ($1, $2, $3, $4, NOW())`,
          [
            item.branch_id,
            item.product_id,
            item.clear_override ? null : item.price_override,
            item.has_is_active ? item.is_active : true,
          ]
        );
      }
      upserted += 1;
    }

    await writeAuditLog(client, {
      action: "BRANCH_PRODUCT_MATRIX_BULK_UPDATE",
      entity_type: "branch_product_matrix",
      entity_id: null,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        requested_rows: normalized.length,
        upserted,
        deleted,
      },
    });

    await client.query("COMMIT");
    return res.json({
      message: "Branch override matrix updated",
      requested_rows: normalized.length,
      upserted,
      deleted,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to bulk update branch product matrix:", err);
    return res.status(500).json({ message: "Failed to bulk update branch product matrix" });
  } finally {
    client.release();
  }
});

router.get("/:id/users", auth, authorize("ADMIN"), async (req, res) => {
  const branchId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(branchId)) {
    return res.status(400).json({ message: "Invalid branch id" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT
         bu.id,
         bu.branch_id,
         bu.user_id,
         bu.role_override,
         bu.is_active,
         bu.created_at,
         u.username,
         u.role AS user_role
       FROM branch_users bu
       LEFT JOIN users u ON u.id::text = bu.user_id
       WHERE bu.branch_id = $1
       ORDER BY bu.id ASC`,
      [branchId]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Failed to fetch branch users:", err);
    return res.status(500).json({ message: "Failed to fetch branch users" });
  }
});

router.post("/:id/users", auth, authorize("ADMIN"), async (req, res) => {
  const branchId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  const userId = String(req.body?.user_id || "").trim().slice(0, 120);
  const roleOverride = req.body?.role_override
    ? String(req.body.role_override).trim().toUpperCase().slice(0, 20)
    : null;
  const isActive = req.body?.is_active !== false;

  if (!Number.isFinite(branchId)) {
    return res.status(400).json({ message: "Invalid branch id" });
  }
  if (!userId) {
    return res.status(400).json({ message: "user_id is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const branchRes = await client.query(
      `SELECT id FROM branches WHERE id = $1 LIMIT 1`,
      [branchId]
    );
    if (!branchRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Branch not found" });
    }

    const userRes = await client.query(
      `SELECT id::text AS id, username, role
       FROM users
       WHERE id::text = $1
         AND "isActive" = TRUE
       LIMIT 1`,
      [userId]
    );
    if (!userRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invalid active user_id" });
    }

    const upsertRes = await client.query(
      `INSERT INTO branch_users (branch_id, user_id, role_override, is_active)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (branch_id, user_id)
       DO UPDATE
         SET role_override = EXCLUDED.role_override,
             is_active = EXCLUDED.is_active
       RETURNING *`,
      [branchId, userId, roleOverride, isActive]
    );

    await writeAuditLog(client, {
      action: "BRANCH_USER_ASSIGN",
      entity_type: "branch",
      entity_id: branchId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        user_id: userId,
        role_override: roleOverride,
        is_active: isActive,
      },
    });

    await client.query("COMMIT");
    return res.status(201).json(upsertRes.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to assign branch user:", err);
    return res.status(500).json({ message: "Failed to assign branch user" });
  } finally {
    client.release();
  }
});

router.delete("/:id/users/:userId", auth, authorize("ADMIN"), async (req, res) => {
  const branchId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  const userId = String(req.params.userId || "").trim().slice(0, 120);

  if (!Number.isFinite(branchId)) {
    return res.status(400).json({ message: "Invalid branch id" });
  }
  if (!userId) {
    return res.status(400).json({ message: "Invalid user id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updateRes = await client.query(
      `UPDATE branch_users
       SET is_active = FALSE
       WHERE branch_id = $1
         AND user_id = $2
       RETURNING id`,
      [branchId, userId]
    );
    if (!updateRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Assignment not found" });
    }

    await writeAuditLog(client, {
      action: "BRANCH_USER_UNASSIGN",
      entity_type: "branch",
      entity_id: branchId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: { user_id: userId },
    });
    await client.query("COMMIT");
    return res.json({ message: "Branch assignment removed" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to remove branch assignment:", err);
    return res.status(500).json({ message: "Failed to remove branch assignment" });
  } finally {
    client.release();
  }
});

router.get("/:id/products", auth, authorize("ADMIN"), async (req, res) => {
  const branchId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(branchId)) {
    return res.status(400).json({ message: "Invalid branch id" });
  }

  try {
    const branchRes = await pool.query(`SELECT id FROM branches WHERE id = $1 LIMIT 1`, [branchId]);
    if (!branchRes.rows[0]) {
      return res.status(404).json({ message: "Branch not found" });
    }

    const { rows } = await pool.query(
      `SELECT
         p.id::text AS product_id,
         p.name,
         p.category,
         p.price AS base_price,
         p."isActive" AS base_active,
         bp.price_override,
         bp.is_active AS branch_is_active,
         bp.updated_at AS override_updated_at,
         (bp.id IS NOT NULL) AS has_override,
         COALESCE(bp.price_override, p.price) AS effective_price,
         CASE
           WHEN bp.id IS NULL THEN p."isActive"
           ELSE bp.is_active
         END AS effective_active
       FROM products p
       LEFT JOIN branch_products bp
         ON bp.branch_id = $1
        AND bp.product_id = p.id::text
       ORDER BY p.category NULLS LAST, p.name ASC`,
      [branchId]
    );

    return res.json(
      rows.map((row) => ({
        ...row,
        base_price: parseFloat(row.base_price || 0),
        price_override:
          row.price_override === null ? null : parseFloat(row.price_override || 0),
        effective_price: parseFloat(row.effective_price || 0),
      }))
    );
  } catch (err) {
    console.error("Failed to fetch branch product overrides:", err);
    return res.status(500).json({ message: "Failed to fetch branch product overrides" });
  }
});

router.put("/:id/products/:productId", auth, authorize("ADMIN"), async (req, res) => {
  const branchId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  const productId = normalizeEntityId(req.params.productId);
  const hasPriceOverride = Object.prototype.hasOwnProperty.call(req.body || {}, "price_override");
  const hasIsActive = Object.prototype.hasOwnProperty.call(req.body || {}, "is_active");
  const clearOverride = req.body?.clear_override === true;
  const priceOverrideRaw = req.body?.price_override;
  const parsedPrice = parseMoney(priceOverrideRaw, NaN);
  const normalizedPrice =
    !hasPriceOverride || priceOverrideRaw === null || String(priceOverrideRaw).trim() === ""
      ? null
      : parsedPrice;
  const normalizedIsActive = hasIsActive ? req.body?.is_active === true : null;

  if (!Number.isFinite(branchId)) {
    return res.status(400).json({ message: "Invalid branch id" });
  }
  if (!productId) {
    return res.status(400).json({ message: "Invalid product id" });
  }
  if (!hasPriceOverride && !hasIsActive && !clearOverride) {
    return res.status(400).json({
      message: "Provide price_override and/or is_active, or set clear_override=true",
    });
  }
  if (hasPriceOverride && normalizedPrice !== null && (!Number.isFinite(normalizedPrice) || normalizedPrice < 0)) {
    return res.status(400).json({ message: "price_override must be a valid non-negative number" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const branchRes = await client.query(`SELECT id FROM branches WHERE id = $1 LIMIT 1`, [branchId]);
    if (!branchRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Branch not found" });
    }
    const productRes = await client.query(
      `SELECT id::text AS id
       FROM products
       WHERE id::text = $1
       LIMIT 1`,
      [productId]
    );
    if (!productRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }

    if (clearOverride && !hasIsActive && !hasPriceOverride) {
      await client.query(
        `DELETE FROM branch_products
         WHERE branch_id = $1
           AND product_id = $2`,
        [branchId, productId]
      );
      await writeAuditLog(client, {
        action: "BRANCH_PRODUCT_OVERRIDE_CLEAR",
        entity_type: "branch_product",
        entity_id: `${branchId}:${productId}`,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: { branch_id: branchId, product_id: productId },
      });
      await client.query("COMMIT");
      return res.json({ message: "Branch product override cleared" });
    }

    const updateRes = await client.query(
      `UPDATE branch_products
       SET price_override = CASE
             WHEN $3::boolean THEN NULL
             WHEN $4::boolean THEN $5
             ELSE price_override
           END,
           is_active = CASE
             WHEN $6::boolean THEN $7
             ELSE is_active
           END,
           updated_at = NOW()
       WHERE branch_id = $1
         AND product_id = $2
       RETURNING *`,
      [
        branchId,
        productId,
        clearOverride,
        hasPriceOverride,
        normalizedPrice,
        hasIsActive,
        normalizedIsActive,
      ]
    );

    let row = updateRes.rows[0];
    if (!row) {
      const insertRes = await client.query(
        `INSERT INTO branch_products (
           branch_id,
           product_id,
           price_override,
           is_active,
           updated_at
         )
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING *`,
        [
          branchId,
          productId,
          clearOverride ? null : normalizedPrice,
          hasIsActive ? normalizedIsActive : true,
        ]
      );
      row = insertRes.rows[0];
    }

    await writeAuditLog(client, {
      action: "BRANCH_PRODUCT_OVERRIDE_UPSERT",
      entity_type: "branch_product",
      entity_id: `${branchId}:${productId}`,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        branch_id: branchId,
        product_id: productId,
        price_override: row.price_override,
        is_active: row.is_active,
      },
    });
    await client.query("COMMIT");
    return res.json({
      ...row,
      price_override:
        row.price_override === null ? null : parseFloat(row.price_override || 0),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to upsert branch product override:", err);
    return res.status(500).json({ message: "Failed to update branch product override" });
  } finally {
    client.release();
  }
});

router.delete("/:id/products/:productId", auth, authorize("ADMIN"), async (req, res) => {
  const branchId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  const productId = normalizeEntityId(req.params.productId);
  if (!Number.isFinite(branchId)) {
    return res.status(400).json({ message: "Invalid branch id" });
  }
  if (!productId) {
    return res.status(400).json({ message: "Invalid product id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deleteRes = await client.query(
      `DELETE FROM branch_products
       WHERE branch_id = $1
         AND product_id = $2
       RETURNING id`,
      [branchId, productId]
    );
    if (!deleteRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Branch product override not found" });
    }

    await writeAuditLog(client, {
      action: "BRANCH_PRODUCT_OVERRIDE_DELETE",
      entity_type: "branch_product",
      entity_id: `${branchId}:${productId}`,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        branch_id: branchId,
        product_id: productId,
      },
    });
    await client.query("COMMIT");
    return res.json({ message: "Branch product override deleted" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to delete branch product override:", err);
    return res.status(500).json({ message: "Failed to delete branch product override" });
  } finally {
    client.release();
  }
});

export default router;
