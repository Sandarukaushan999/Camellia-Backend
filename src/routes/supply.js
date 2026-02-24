import express from "express";
import auth from "../middleware/auth.js";
import authorize from "../middleware/authorize.js";
import pool from "../db.js";

const router = express.Router();

const MANUAL_MOVEMENT_RULES = {
  RECEIPT: 1,
  ISSUE: -1,
  ADJUSTMENT_IN: 1,
  ADJUSTMENT_OUT: -1,
  RETURN_IN: 1,
  WASTAGE: -1,
};

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

function normalizeEntityId(value) {
  return String(value || "").trim().slice(0, 120);
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

async function resolveActiveBranchId(client, requestedBranchId = 1) {
  const branchId = parsePositiveInt(requestedBranchId, 1, 1, 1_000_000);
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

async function adjustBranchInventory(client, branchId, inventoryItemId, deltaQty) {
  const qty = parseMoney(deltaQty, 0);
  if (!Number.isFinite(qty) || qty === 0) {
    return;
  }

  const stockRes = await client.query(
    `SELECT id, current_stock, min_stock
     FROM branch_inventory
     WHERE branch_id = $1
       AND inventory_item_id = $2
     FOR UPDATE`,
    [branchId, normalizeEntityId(inventoryItemId)]
  );

  if (!stockRes.rows[0]) {
    if (qty < 0) {
      throw new Error("Insufficient branch stock");
    }
    await client.query(
      `INSERT INTO branch_inventory (branch_id, inventory_item_id, current_stock, min_stock, updated_at)
       VALUES ($1, $2, $3, 0, NOW())`,
      [branchId, normalizeEntityId(inventoryItemId), qty]
    );
    return;
  }

  const current = parseMoney(stockRes.rows[0].current_stock, 0);
  const next = parseMoney(current + qty, 0);
  if (next < -0.0001) {
    throw new Error("Insufficient branch stock");
  }
  await client.query(
    `UPDATE branch_inventory
     SET current_stock = $3,
         updated_at = NOW()
     WHERE branch_id = $1
       AND inventory_item_id = $2`,
    [branchId, normalizeEntityId(inventoryItemId), Math.max(0, next)]
  );
}

router.get("/stock-movements", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 200, 1, 1000);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const inventoryItemId = normalizeEntityId(req.query.inventory_item_id);

    const params = [limit];
    const conditions = [];
    if (Number.isFinite(branchId)) {
      params.push(branchId);
      conditions.push(`sm.branch_id = $${params.length}`);
    }
    if (inventoryItemId) {
      params.push(inventoryItemId);
      conditions.push(`sm.inventory_item_id = $${params.length}`);
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `SELECT
         sm.id,
         sm.branch_id,
         b.code AS branch_code,
         b.name AS branch_name,
         sm.inventory_item_id,
         ii.name AS inventory_item_name,
         sm.movement_type,
         sm.quantity,
         sm.unit_cost,
         sm.reference_type,
         sm.reference_id,
         sm.note,
         sm.created_by,
         sm.created_at
       FROM stock_movements sm
       LEFT JOIN branches b ON b.id = sm.branch_id
       LEFT JOIN inventory_items ii ON ii.id::text = sm.inventory_item_id
       ${whereSql}
       ORDER BY sm.created_at DESC
       LIMIT $1`,
      params
    );
    return res.json(
      rows.map((row) => ({
        ...row,
        quantity: parseFloat(row.quantity || 0),
        unit_cost: parseFloat(row.unit_cost || 0),
      }))
    );
  } catch (err) {
    console.error("Failed to fetch stock movements:", err);
    return res.status(500).json({ message: "Failed to fetch stock movements" });
  }
});

router.post("/stock-movements", auth, authorize("ADMIN"), async (req, res) => {
  const movementType = String(req.body?.movement_type || "")
    .trim()
    .toUpperCase();
  const direction = MANUAL_MOVEMENT_RULES[movementType];
  const inventoryItemId = normalizeEntityId(req.body?.inventory_item_id);
  const qty = parseMoney(req.body?.quantity, NaN);
  const unitCost = parseMoney(req.body?.unit_cost, 0);
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
  const referenceType = req.body?.reference_type
    ? String(req.body.reference_type).trim().slice(0, 40)
    : "MANUAL";
  const referenceId = req.body?.reference_id
    ? String(req.body.reference_id).trim().slice(0, 120)
    : null;
  const lotCode = req.body?.lot_code ? String(req.body.lot_code).trim().slice(0, 80) : null;
  const expiryDate = req.body?.expiry_date || null;

  if (!direction) {
    return res.status(400).json({ message: "Unsupported movement_type for manual movement" });
  }
  if (!inventoryItemId) {
    return res.status(400).json({ message: "inventory_item_id is required" });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ message: "quantity must be a positive number" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const branchId = await resolveActiveBranchId(client, req.body?.branch_id);
    const delta = parseMoney(qty * direction, 0);

    const itemRes = await client.query(
      `SELECT id::text AS id, current_stock
       FROM inventory_items
       WHERE id::text = $1
       FOR UPDATE`,
      [inventoryItemId]
    );
    if (!itemRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Inventory item not found" });
    }

    const currentStock = parseMoney(itemRes.rows[0].current_stock, 0);
    const nextStock = parseMoney(currentStock + delta, 0);
    if (nextStock < -0.0001) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Insufficient stock for this movement" });
    }

    await client.query(
      `UPDATE inventory_items
       SET current_stock = $2,
           updated_at = NOW()
       WHERE id::text = $1`,
      [inventoryItemId, Math.max(0, nextStock)]
    );
    await adjustBranchInventory(client, branchId, inventoryItemId, delta);

    const movementRes = await client.query(
      `INSERT INTO stock_movements (
         branch_id,
         inventory_item_id,
         movement_type,
         quantity,
         unit_cost,
         reference_type,
         reference_id,
         note,
         created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        branchId,
        String(inventoryItemId),
        movementType,
        qty,
        unitCost,
        referenceType,
        referenceId,
        note,
        String(req.user.id),
      ]
    );
    const movement = movementRes.rows[0];

    if (direction > 0) {
      await client.query(
        `INSERT INTO stock_batches (
           branch_id,
           inventory_item_id,
           lot_code,
           expiry_date,
           qty_on_hand,
           unit_cost,
           source_type,
           source_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          branchId,
          String(inventoryItemId),
          lotCode,
          expiryDate,
          qty,
          unitCost,
          referenceType,
          referenceId,
        ]
      );
    }

    await writeAuditLog(client, {
      action: "STOCK_MOVEMENT_CREATE",
      entity_type: "stock_movement",
      entity_id: movement.id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        branch_id: branchId,
        inventory_item_id: inventoryItemId,
        movement_type: movementType,
        quantity: qty,
      },
    });

    await client.query("COMMIT");
    return res.status(201).json({
      ...movement,
      quantity: parseFloat(movement.quantity || 0),
      unit_cost: parseFloat(movement.unit_cost || 0),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    if (String(err?.message || "").includes("Insufficient branch stock")) {
      return res.status(400).json({ message: "Insufficient branch stock" });
    }
    console.error("Failed to create stock movement:", err);
    return res.status(500).json({ message: "Failed to create stock movement" });
  } finally {
    client.release();
  }
});

router.get("/transfers", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 200, 1, 1000);
    const status = req.query?.status
      ? String(req.query.status).trim().toUpperCase().slice(0, 24)
      : null;

    const params = [limit];
    const statusFilter = status ? "WHERE st.status = $2" : "";
    if (status) {
      params.push(status);
    }

    const { rows } = await pool.query(
      `SELECT
         st.id,
         st.from_branch_id,
         fb.code AS from_branch_code,
         fb.name AS from_branch_name,
         st.to_branch_id,
         tb.code AS to_branch_code,
         tb.name AS to_branch_name,
         st.status,
         st.note,
         st.requested_by,
         st.approved_by,
         st.shipped_by,
         st.received_by,
         st.requested_at,
         st.approved_at,
         st.shipped_at,
         st.received_at,
         COALESCE(
           json_agg(
             DISTINCT jsonb_build_object(
               'id', sti.id,
               'inventory_item_id', sti.inventory_item_id,
               'inventory_item_name', ii.name,
               'quantity', sti.quantity
             )
           ) FILTER (WHERE sti.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM stock_transfers st
       LEFT JOIN branches fb ON fb.id = st.from_branch_id
       LEFT JOIN branches tb ON tb.id = st.to_branch_id
       LEFT JOIN stock_transfer_items sti ON sti.transfer_id = st.id
       LEFT JOIN inventory_items ii ON ii.id::text = sti.inventory_item_id
       ${statusFilter}
       GROUP BY st.id, fb.code, fb.name, tb.code, tb.name
       ORDER BY st.requested_at DESC
       LIMIT $1`,
      params
    );
    return res.json(rows);
  } catch (err) {
    console.error("Failed to fetch stock transfers:", err);
    return res.status(500).json({ message: "Failed to fetch stock transfers" });
  }
});

router.post("/transfers", auth, authorize("ADMIN"), async (req, res) => {
  const fromBranchId = parsePositiveInt(req.body?.from_branch_id, NaN, 1, 1_000_000);
  const toBranchId = parsePositiveInt(req.body?.to_branch_id, NaN, 1, 1_000_000);
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const normalizedItems = items
    .map((item) => ({
      inventory_item_id: normalizeEntityId(item?.inventory_item_id),
      quantity: parseMoney(item?.quantity, NaN),
    }))
    .filter(
      (item) =>
        Boolean(item.inventory_item_id) &&
        Number.isFinite(item.quantity) &&
        item.quantity > 0
    );

  if (!Number.isFinite(fromBranchId) || !Number.isFinite(toBranchId)) {
    return res.status(400).json({ message: "from_branch_id and to_branch_id are required" });
  }
  if (fromBranchId === toBranchId) {
    return res.status(400).json({ message: "from_branch_id and to_branch_id must differ" });
  }
  if (normalizedItems.length === 0) {
    return res.status(400).json({ message: "At least one transfer item is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const branchCheck = await client.query(
      `SELECT id
       FROM branches
       WHERE id = ANY($1::int[])
         AND is_active = TRUE`,
      [[fromBranchId, toBranchId]]
    );
    if (branchCheck.rows.length < 2) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Both branches must be active and valid" });
    }

    const transferRes = await client.query(
      `INSERT INTO stock_transfers (
         from_branch_id,
         to_branch_id,
         status,
         note,
         requested_by,
         requested_at
       )
       VALUES ($1, $2, 'PENDING', $3, $4, NOW())
       RETURNING *`,
      [fromBranchId, toBranchId, note, String(req.user.id)]
    );
    const transfer = transferRes.rows[0];

    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO stock_transfer_items (transfer_id, inventory_item_id, quantity)
         VALUES ($1, $2, $3)`,
        [transfer.id, item.inventory_item_id, item.quantity]
      );
    }

    await writeAuditLog(client, {
      action: "STOCK_TRANSFER_CREATE",
      entity_type: "stock_transfer",
      entity_id: transfer.id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        from_branch_id: fromBranchId,
        to_branch_id: toBranchId,
        item_count: normalizedItems.length,
      },
    });

    await client.query("COMMIT");
    return res.status(201).json(transfer);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to create stock transfer:", err);
    return res.status(500).json({ message: "Failed to create stock transfer" });
  } finally {
    client.release();
  }
});

router.post("/transfers/:id/approve", auth, authorize("ADMIN"), async (req, res) => {
  const transferId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(transferId)) {
    return res.status(400).json({ message: "Invalid transfer id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transferRes = await client.query(
      `SELECT id, status
       FROM stock_transfers
       WHERE id = $1
       FOR UPDATE`,
      [transferId]
    );
    const transfer = transferRes.rows[0];
    if (!transfer) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Transfer not found" });
    }
    if (String(transfer.status || "").toUpperCase() !== "PENDING") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Only pending transfers can be approved" });
    }

    const updateRes = await client.query(
      `UPDATE stock_transfers
       SET status = 'APPROVED',
           approved_by = $2,
           approved_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [transferId, String(req.user.id)]
    );

    await writeAuditLog(client, {
      action: "STOCK_TRANSFER_APPROVE",
      entity_type: "stock_transfer",
      entity_id: transferId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {},
    });
    await client.query("COMMIT");
    return res.json(updateRes.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to approve stock transfer:", err);
    return res.status(500).json({ message: "Failed to approve stock transfer" });
  } finally {
    client.release();
  }
});

router.post("/transfers/:id/ship", auth, authorize("ADMIN"), async (req, res) => {
  const transferId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(transferId)) {
    return res.status(400).json({ message: "Invalid transfer id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transferRes = await client.query(
      `SELECT *
       FROM stock_transfers
       WHERE id = $1
       FOR UPDATE`,
      [transferId]
    );
    const transfer = transferRes.rows[0];
    if (!transfer) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Transfer not found" });
    }
    if (String(transfer.status || "").toUpperCase() !== "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Transfer must be approved before shipping" });
    }

    const itemsRes = await client.query(
      `SELECT inventory_item_id, quantity
       FROM stock_transfer_items
       WHERE transfer_id = $1`,
      [transferId]
    );
    const items = itemsRes.rows;
    if (items.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Transfer has no items" });
    }

    for (const item of items) {
      const qty = parseMoney(item.quantity, 0);
      if (qty <= 0) {
        continue;
      }
      await adjustBranchInventory(
        client,
        Number(transfer.from_branch_id),
        String(item.inventory_item_id),
        -qty
      );
      await client.query(
        `INSERT INTO stock_movements (
           branch_id,
           inventory_item_id,
           movement_type,
           quantity,
           unit_cost,
           reference_type,
           reference_id,
           note,
           created_by
         )
         VALUES ($1, $2, 'TRANSFER_OUT', $3, 0, 'TRANSFER', $4, $5, $6)`,
        [
          Number(transfer.from_branch_id),
          String(item.inventory_item_id),
          qty,
          String(transferId),
          transfer.note || null,
          String(req.user.id),
        ]
      );
    }

    const updateRes = await client.query(
      `UPDATE stock_transfers
       SET status = 'IN_TRANSIT',
           shipped_by = $2,
           shipped_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [transferId, String(req.user.id)]
    );

    await writeAuditLog(client, {
      action: "STOCK_TRANSFER_SHIP",
      entity_type: "stock_transfer",
      entity_id: transferId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {},
    });

    await client.query("COMMIT");
    return res.json(updateRes.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (String(err?.message || "").includes("Insufficient branch stock")) {
      return res.status(400).json({ message: "Insufficient branch stock to ship transfer" });
    }
    console.error("Failed to ship stock transfer:", err);
    return res.status(500).json({ message: "Failed to ship stock transfer" });
  } finally {
    client.release();
  }
});

router.post("/transfers/:id/receive", auth, authorize("ADMIN"), async (req, res) => {
  const transferId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(transferId)) {
    return res.status(400).json({ message: "Invalid transfer id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transferRes = await client.query(
      `SELECT *
       FROM stock_transfers
       WHERE id = $1
       FOR UPDATE`,
      [transferId]
    );
    const transfer = transferRes.rows[0];
    if (!transfer) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Transfer not found" });
    }
    if (String(transfer.status || "").toUpperCase() !== "IN_TRANSIT") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Only in-transit transfers can be received" });
    }

    const itemsRes = await client.query(
      `SELECT inventory_item_id, quantity
       FROM stock_transfer_items
       WHERE transfer_id = $1`,
      [transferId]
    );
    const items = itemsRes.rows;
    if (items.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Transfer has no items" });
    }

    for (const item of items) {
      const qty = parseMoney(item.quantity, 0);
      if (qty <= 0) {
        continue;
      }
      await adjustBranchInventory(
        client,
        Number(transfer.to_branch_id),
        String(item.inventory_item_id),
        qty
      );
      await client.query(
        `INSERT INTO stock_movements (
           branch_id,
           inventory_item_id,
           movement_type,
           quantity,
           unit_cost,
           reference_type,
           reference_id,
           note,
           created_by
         )
         VALUES ($1, $2, 'TRANSFER_IN', $3, 0, 'TRANSFER', $4, $5, $6)`,
        [
          Number(transfer.to_branch_id),
          String(item.inventory_item_id),
          qty,
          String(transferId),
          transfer.note || null,
          String(req.user.id),
        ]
      );
    }

    const updateRes = await client.query(
      `UPDATE stock_transfers
       SET status = 'RECEIVED',
           received_by = $2,
           received_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [transferId, String(req.user.id)]
    );

    await writeAuditLog(client, {
      action: "STOCK_TRANSFER_RECEIVE",
      entity_type: "stock_transfer",
      entity_id: transferId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {},
    });

    await client.query("COMMIT");
    return res.json(updateRes.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to receive stock transfer:", err);
    return res.status(500).json({ message: "Failed to receive stock transfer" });
  } finally {
    client.release();
  }
});

router.get("/reorder-suggestions", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 50, 1, 500);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const hasBranchFilter = Number.isFinite(branchId);

    if (hasBranchFilter) {
      const { rows } = await pool.query(
        `SELECT
           ii.id::text AS inventory_item_id,
           ii.name,
           ii.unit,
           COALESCE(bi.current_stock, 0) AS current_stock,
           COALESCE(NULLIF(bi.min_stock, 0), ii.min_stock, 0) AS min_stock,
           GREATEST(
             0,
             COALESCE(NULLIF(bi.min_stock, 0), ii.min_stock, 0) - COALESCE(bi.current_stock, 0)
           ) AS reorder_qty
         FROM inventory_items ii
         LEFT JOIN branch_inventory bi
           ON bi.branch_id = $1
          AND bi.inventory_item_id = ii.id::text
         WHERE ii."isActive" = TRUE
           AND GREATEST(
             0,
             COALESCE(NULLIF(bi.min_stock, 0), ii.min_stock, 0) - COALESCE(bi.current_stock, 0)
           ) > 0
         ORDER BY reorder_qty DESC, min_stock DESC
         LIMIT $2`,
        [branchId, limit]
      );
      return res.json(
        rows.map((row) => ({
          ...row,
          current_stock: parseFloat(row.current_stock || 0),
          min_stock: parseFloat(row.min_stock || 0),
          reorder_qty: parseFloat(row.reorder_qty || 0),
          branch_id: branchId,
        }))
      );
    }

    const { rows } = await pool.query(
      `SELECT
         ii.id::text AS inventory_item_id,
         ii.name,
         ii.unit,
         COALESCE(ii.current_stock, 0) AS current_stock,
         COALESCE(ii.min_stock, 0) AS min_stock,
         GREATEST(0, COALESCE(ii.min_stock, 0) - COALESCE(ii.current_stock, 0)) AS reorder_qty
       FROM inventory_items ii
       WHERE ii."isActive" = TRUE
         AND GREATEST(0, COALESCE(ii.min_stock, 0) - COALESCE(ii.current_stock, 0)) > 0
       ORDER BY reorder_qty DESC, min_stock DESC
       LIMIT $1`,
      [limit]
    );
    return res.json(
      rows.map((row) => ({
        ...row,
        current_stock: parseFloat(row.current_stock || 0),
        min_stock: parseFloat(row.min_stock || 0),
        reorder_qty: parseFloat(row.reorder_qty || 0),
      }))
    );
  } catch (err) {
    console.error("Failed to fetch reorder suggestions:", err);
    return res.status(500).json({ message: "Failed to fetch reorder suggestions" });
  }
});

router.get("/cycle-counts", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 100, 1, 500);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const status = req.query?.status
      ? String(req.query.status).trim().toUpperCase().slice(0, 20)
      : null;

    const params = [limit];
    const conditions = [];
    if (Number.isFinite(branchId)) {
      params.push(branchId);
      conditions.push(`scs.branch_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`scs.status = $${params.length}`);
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `SELECT
         scs.id,
         scs.branch_id,
         b.code AS branch_code,
         b.name AS branch_name,
         scs.status,
         scs.note,
         scs.created_by,
         scs.created_at,
         scs.closed_at,
         COUNT(sci.id) AS item_count,
         COUNT(*) FILTER (WHERE sci.counted_qty IS NULL) AS pending_count
       FROM stock_count_sessions scs
       LEFT JOIN branches b ON b.id = scs.branch_id
       LEFT JOIN stock_count_items sci ON sci.session_id = scs.id
       ${whereSql}
       GROUP BY scs.id, b.code, b.name
       ORDER BY scs.created_at DESC
       LIMIT $1`,
      params
    );
    return res.json(
      rows.map((row) => ({
        ...row,
        item_count: parseInt(row.item_count || 0, 10),
        pending_count: parseInt(row.pending_count || 0, 10),
      }))
    );
  } catch (err) {
    console.error("Failed to fetch cycle count sessions:", err);
    return res.status(500).json({ message: "Failed to fetch cycle count sessions" });
  }
});

router.post("/cycle-counts", auth, authorize("ADMIN"), async (req, res) => {
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
  const itemIdsRaw = Array.isArray(req.body?.inventory_item_ids)
    ? req.body.inventory_item_ids
    : [];
  const itemIds = [...new Set(itemIdsRaw.map((value) => normalizeEntityId(value)).filter(Boolean))];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const branchId = await resolveActiveBranchId(client, req.body?.branch_id);

    const sessionRes = await client.query(
      `INSERT INTO stock_count_sessions (branch_id, status, note, created_by)
       VALUES ($1, 'OPEN', $2, $3)
       RETURNING *`,
      [branchId, note, String(req.user.id)]
    );
    const session = sessionRes.rows[0];

    let inventoryRows = [];
    if (itemIds.length > 0) {
      inventoryRows = (
        await client.query(
          `SELECT
             ii.id::text AS inventory_item_id,
             COALESCE(bi.current_stock, ii.current_stock, 0) AS expected_qty
           FROM inventory_items ii
           LEFT JOIN branch_inventory bi
             ON bi.branch_id = $1
            AND bi.inventory_item_id = ii.id::text
           WHERE ii.id::text = ANY($2::text[])`,
          [branchId, itemIds]
        )
      ).rows;
    } else {
      inventoryRows = (
        await client.query(
          `SELECT
             ii.id::text AS inventory_item_id,
             COALESCE(bi.current_stock, ii.current_stock, 0) AS expected_qty
           FROM inventory_items ii
           LEFT JOIN branch_inventory bi
             ON bi.branch_id = $1
            AND bi.inventory_item_id = ii.id::text
           WHERE ii."isActive" = TRUE
           ORDER BY ii.name ASC`,
          [branchId]
        )
      ).rows;
    }

    for (const row of inventoryRows) {
      await client.query(
        `INSERT INTO stock_count_items (session_id, inventory_item_id, expected_qty, counted_qty, variance_qty)
         VALUES ($1, $2, $3, NULL, 0)`,
        [session.id, String(row.inventory_item_id), parseMoney(row.expected_qty, 0)]
      );
    }

    await writeAuditLog(client, {
      action: "CYCLE_COUNT_SESSION_CREATE",
      entity_type: "stock_count_session",
      entity_id: session.id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        branch_id: branchId,
        item_count: inventoryRows.length,
      },
    });

    await client.query("COMMIT");
    return res.status(201).json({
      ...session,
      item_count: inventoryRows.length,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to create cycle count session:", err);
    return res.status(500).json({ message: "Failed to create cycle count session" });
  } finally {
    client.release();
  }
});

router.post("/cycle-counts/:id/submit", auth, authorize("ADMIN"), async (req, res) => {
  const sessionId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  const countsRaw = Array.isArray(req.body?.counts) ? req.body.counts : [];
  const counts = new Map();
  for (const entry of countsRaw) {
    const key = normalizeEntityId(entry?.inventory_item_id);
    const countedQty = parseMoney(entry?.counted_qty, NaN);
    if (key && Number.isFinite(countedQty) && countedQty >= 0) {
      counts.set(key, countedQty);
    }
  }

  if (!Number.isFinite(sessionId)) {
    return res.status(400).json({ message: "Invalid cycle count session id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionRes = await client.query(
      `SELECT *
       FROM stock_count_sessions
       WHERE id = $1
       FOR UPDATE`,
      [sessionId]
    );
    const session = sessionRes.rows[0];
    if (!session) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Cycle count session not found" });
    }
    if (String(session.status || "").toUpperCase() !== "OPEN") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Only OPEN sessions can be submitted" });
    }

    const itemsRes = await client.query(
      `SELECT id, inventory_item_id, expected_qty, counted_qty
       FROM stock_count_items
       WHERE session_id = $1
       FOR UPDATE`,
      [sessionId]
    );
    const items = itemsRes.rows;
    if (items.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Session has no items to submit" });
    }

    let adjustedItems = 0;
    for (const item of items) {
      const itemId = String(item.inventory_item_id);
      const expectedQty = parseMoney(item.expected_qty, 0);
      const countedQty = counts.has(itemId)
        ? counts.get(itemId)
        : Number.isFinite(parseMoney(item.counted_qty, NaN))
        ? parseMoney(item.counted_qty, 0)
        : expectedQty;
      const varianceQty = parseMoney(countedQty - expectedQty, 0);

      await client.query(
        `UPDATE stock_count_items
         SET counted_qty = $2,
             variance_qty = $3
         WHERE id = $1`,
        [item.id, countedQty, varianceQty]
      );

      await client.query(
        `INSERT INTO branch_inventory (branch_id, inventory_item_id, current_stock, min_stock, updated_at)
         VALUES ($1, $2, $3, 0, NOW())
         ON CONFLICT (branch_id, inventory_item_id)
         DO UPDATE
           SET current_stock = EXCLUDED.current_stock,
               updated_at = NOW()`,
        [Number(session.branch_id), itemId, countedQty]
      );

      if (Math.abs(varianceQty) > 0.0001) {
        const invRes = await client.query(
          `SELECT id::text AS id
           FROM inventory_items
           WHERE id::text = $1
           LIMIT 1`,
          [itemId]
        );
        if (invRes.rows[0]) {
          await client.query(
            `UPDATE inventory_items
             SET current_stock = GREATEST(0, COALESCE(current_stock, 0) + $2),
                 updated_at = NOW()
             WHERE id::text = $1`,
            [itemId, varianceQty]
          );
        }
      }

      await client.query(
        `INSERT INTO stock_movements (
           branch_id,
           inventory_item_id,
           movement_type,
           quantity,
           unit_cost,
           reference_type,
           reference_id,
           note,
           created_by
         )
         VALUES ($1, $2, 'CYCLE_COUNT_ADJUSTMENT', $3, 0, 'CYCLE_COUNT', $4, $5, $6)`,
        [
          Number(session.branch_id),
          itemId,
          varianceQty,
          String(sessionId),
          "Cycle count reconciliation",
          String(req.user.id),
        ]
      );
      adjustedItems += 1;
    }

    const closeRes = await client.query(
      `UPDATE stock_count_sessions
       SET status = 'CLOSED',
           closed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [sessionId]
    );

    await writeAuditLog(client, {
      action: "CYCLE_COUNT_SESSION_SUBMIT",
      entity_type: "stock_count_session",
      entity_id: sessionId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        branch_id: Number(session.branch_id),
        adjusted_items: adjustedItems,
      },
    });

    await client.query("COMMIT");
    return res.json({
      message: "Cycle count submitted successfully",
      session: closeRes.rows[0],
      adjusted_items: adjustedItems,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to submit cycle count:", err);
    return res.status(500).json({ message: "Failed to submit cycle count" });
  } finally {
    client.release();
  }
});

router.get("/requisitions", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 100, 1, 500);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const status = req.query?.status
      ? String(req.query.status).trim().toUpperCase().slice(0, 24)
      : null;

    const params = [limit];
    const conditions = [];
    if (Number.isFinite(branchId)) {
      params.push(branchId);
      conditions.push(`pr.branch_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`pr.status = $${params.length}`);
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `SELECT
         pr.id,
         pr.branch_id,
         b.code AS branch_code,
         b.name AS branch_name,
         pr.status,
         pr.purchase_order_id,
         pr.note,
         pr.requested_by,
         pr.approved_by,
         pr.approved_at,
         pr.created_at,
         pr.updated_at,
         po.status AS purchase_order_status,
         s.name AS supplier_name,
         COALESCE(
           json_agg(
             DISTINCT jsonb_build_object(
               'id', pri.id,
               'inventory_item_id', pri.inventory_item_id,
               'inventory_item_name', ii.name,
               'requested_qty', pri.requested_qty,
               'suggested_qty', pri.suggested_qty,
               'min_stock_snapshot', pri.min_stock_snapshot,
               'current_stock_snapshot', pri.current_stock_snapshot
             )
           ) FILTER (WHERE pri.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM purchase_requisitions pr
       LEFT JOIN branches b ON b.id = pr.branch_id
       LEFT JOIN purchase_orders po ON po.id = pr.purchase_order_id
       LEFT JOIN suppliers s ON s.id::text = po.supplier_id
       LEFT JOIN purchase_requisition_items pri ON pri.requisition_id = pr.id
       LEFT JOIN inventory_items ii ON ii.id::text = pri.inventory_item_id
       ${whereSql}
       GROUP BY pr.id, b.code, b.name, po.status, s.name
       ORDER BY pr.created_at DESC
       LIMIT $1`,
      params
    );
    return res.json(
      rows.map((row) => ({
        ...row,
        items: Array.isArray(row.items)
          ? row.items.map((item) => ({
              ...item,
              requested_qty: parseFloat(item?.requested_qty || 0),
              suggested_qty: item?.suggested_qty === null ? null : parseFloat(item?.suggested_qty || 0),
              min_stock_snapshot:
                item?.min_stock_snapshot === null ? null : parseFloat(item?.min_stock_snapshot || 0),
              current_stock_snapshot:
                item?.current_stock_snapshot === null
                  ? null
                  : parseFloat(item?.current_stock_snapshot || 0),
            }))
          : [],
      }))
    );
  } catch (err) {
    console.error("Failed to fetch purchase requisitions:", err);
    return res.status(500).json({ message: "Failed to fetch purchase requisitions" });
  }
});

router.post("/requisitions", auth, authorize("ADMIN"), async (req, res) => {
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
  const inputItems = Array.isArray(req.body?.items) ? req.body.items : [];

  const normalizedItems = inputItems
    .map((item) => ({
      inventory_item_id: normalizeEntityId(item?.inventory_item_id),
      requested_qty: parseMoney(item?.requested_qty ?? item?.qty, NaN),
      suggested_qty: parseMoney(item?.suggested_qty, NaN),
      min_stock_snapshot: parseMoney(item?.min_stock_snapshot, NaN),
      current_stock_snapshot: parseMoney(item?.current_stock_snapshot, NaN),
    }))
    .filter(
      (item) =>
        Boolean(item.inventory_item_id) &&
        Number.isFinite(item.requested_qty) &&
        item.requested_qty > 0
    );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const branchId = await resolveActiveBranchId(client, req.body?.branch_id);

    let finalItems = normalizedItems;
    if (finalItems.length === 0) {
      const suggestionRows = (
        await client.query(
          `SELECT
             ii.id::text AS inventory_item_id,
             COALESCE(bi.current_stock, ii.current_stock, 0) AS current_stock,
             COALESCE(NULLIF(bi.min_stock, 0), ii.min_stock, 0) AS min_stock
           FROM inventory_items ii
           LEFT JOIN branch_inventory bi
             ON bi.branch_id = $1
            AND bi.inventory_item_id = ii.id::text
           WHERE ii."isActive" = TRUE
             AND COALESCE(NULLIF(bi.min_stock, 0), ii.min_stock, 0) > COALESCE(bi.current_stock, ii.current_stock, 0)
           ORDER BY ii.name ASC
           LIMIT 300`,
          [branchId]
        )
      ).rows;

      finalItems = suggestionRows
        .map((row) => {
          const minStock = parseMoney(row.min_stock, 0);
          const currentStock = parseMoney(row.current_stock, 0);
          const requestedQty = parseMoney(minStock - currentStock, 0);
          if (requestedQty <= 0) {
            return null;
          }
          return {
            inventory_item_id: String(row.inventory_item_id),
            requested_qty: requestedQty,
            suggested_qty: requestedQty,
            min_stock_snapshot: minStock,
            current_stock_snapshot: currentStock,
          };
        })
        .filter(Boolean);
    }

    if (finalItems.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No valid requisition items found" });
    }

    const reqRes = await client.query(
      `INSERT INTO purchase_requisitions (
         branch_id,
         status,
         note,
         requested_by,
         created_at,
         updated_at
       )
       VALUES ($1, 'DRAFT', $2, $3, NOW(), NOW())
       RETURNING *`,
      [branchId, note, String(req.user.id)]
    );
    const requisition = reqRes.rows[0];

    for (const item of finalItems) {
      await client.query(
        `INSERT INTO purchase_requisition_items (
           requisition_id,
           inventory_item_id,
           requested_qty,
           suggested_qty,
           min_stock_snapshot,
           current_stock_snapshot
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          requisition.id,
          String(item.inventory_item_id),
          parseMoney(item.requested_qty, 0),
          Number.isFinite(item.suggested_qty) ? parseMoney(item.suggested_qty, 0) : null,
          Number.isFinite(item.min_stock_snapshot) ? parseMoney(item.min_stock_snapshot, 0) : null,
          Number.isFinite(item.current_stock_snapshot)
            ? parseMoney(item.current_stock_snapshot, 0)
            : null,
        ]
      );
    }

    await writeAuditLog(client, {
      action: "PURCHASE_REQUISITION_CREATE",
      entity_type: "purchase_requisition",
      entity_id: requisition.id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        branch_id: branchId,
        item_count: finalItems.length,
      },
    });

    await client.query("COMMIT");
    return res.status(201).json({
      ...requisition,
      item_count: finalItems.length,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to create purchase requisition:", err);
    return res.status(500).json({ message: "Failed to create purchase requisition" });
  } finally {
    client.release();
  }
});

router.post("/requisitions/:id/convert-to-po", auth, authorize("ADMIN"), async (req, res) => {
  const requisitionId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(requisitionId)) {
    return res.status(400).json({ message: "Invalid requisition id" });
  }

  const supplierIdRaw = parsePositiveInt(req.body?.supplier_id, NaN, 1, 1_000_000);
  const expectedAt = req.body?.expected_at || null;
  const noteSuffix = req.body?.note ? String(req.body.note).trim().slice(0, 400) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reqRes = await client.query(
      `SELECT *
       FROM purchase_requisitions
       WHERE id = $1
       FOR UPDATE`,
      [requisitionId]
    );
    const requisition = reqRes.rows[0];
    if (!requisition) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Requisition not found" });
    }

    if (String(requisition.status || "").toUpperCase() !== "APPROVED") {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ message: "Only APPROVED requisitions can be converted to purchase orders" });
    }

    if (requisition.purchase_order_id) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "Requisition is already linked to a purchase order",
        purchase_order_id: Number(requisition.purchase_order_id),
      });
    }

    let supplierRow = null;
    if (Number.isFinite(supplierIdRaw)) {
      const supplierRes = await client.query(
        `SELECT id, name
         FROM suppliers
         WHERE id = $1
           AND is_active = TRUE
         LIMIT 1`,
        [supplierIdRaw]
      );
      supplierRow = supplierRes.rows[0] || null;
    } else {
      const supplierRes = await client.query(
        `SELECT id, name
         FROM suppliers
         WHERE is_active = TRUE
         ORDER BY id ASC
         LIMIT 1`
      );
      supplierRow = supplierRes.rows[0] || null;
    }

    if (!supplierRow) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "No active supplier found. Create/activate a supplier before converting requisitions.",
      });
    }

    const itemRows = (
      await client.query(
        `SELECT inventory_item_id, requested_qty
         FROM purchase_requisition_items
         WHERE requisition_id = $1`,
        [requisitionId]
      )
    ).rows;

    const normalizedItems = itemRows
      .map((item) => ({
        inventory_item_id: parsePositiveInt(item?.inventory_item_id, NaN, 1, 1_000_000),
        qty: parseMoney(item?.requested_qty, NaN),
      }))
      .filter(
        (item) =>
          Number.isFinite(item.inventory_item_id) &&
          Number.isFinite(item.qty) &&
          item.qty > 0
      );

    if (normalizedItems.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Requisition has no valid items to convert" });
    }

    const inventoryIds = [...new Set(normalizedItems.map((item) => item.inventory_item_id))];
    const unitCostRows = (
      await client.query(
        `SELECT id, unit_cost
         FROM inventory_items
         WHERE id = ANY($1::int[])`,
        [inventoryIds]
      )
    ).rows;
    const unitCostMap = new Map(
      unitCostRows.map((row) => [Number(row.id), parseMoney(row.unit_cost, 0)])
    );

    const noteParts = [`Auto-converted from requisition #${requisitionId}`];
    if (noteSuffix) {
      noteParts.push(noteSuffix);
    }
    const poNote = noteParts.join(" | ").slice(0, 500);

    const poRes = await client.query(
      `INSERT INTO purchase_orders (supplier_id, status, note, expected_at, created_by)
       VALUES ($1, 'PLACED', $2, $3, $4)
       RETURNING *`,
      [String(supplierRow.id), poNote, expectedAt, String(req.user.id)]
    );
    const purchaseOrder = poRes.rows[0];

    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, qty, unit_cost)
         VALUES ($1, $2, $3, $4)`,
        [
          purchaseOrder.id,
          item.inventory_item_id,
          item.qty,
          parseMoney(unitCostMap.get(item.inventory_item_id), 0),
        ]
      );
    }

    await client.query(
      `UPDATE purchase_requisitions
       SET purchase_order_id = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [requisitionId, purchaseOrder.id]
    );

    await writeAuditLog(client, {
      action: "PURCHASE_REQUISITION_CONVERT_TO_PO",
      entity_type: "purchase_requisition",
      entity_id: requisitionId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        purchase_order_id: purchaseOrder.id,
        supplier_id: Number(supplierRow.id),
        item_count: normalizedItems.length,
      },
    });

    await client.query("COMMIT");
    return res.status(201).json({
      message: "Purchase order created from requisition",
      requisition_id: requisitionId,
      purchase_order_id: Number(purchaseOrder.id),
      supplier_id: Number(supplierRow.id),
      supplier_name: supplierRow.name,
      item_count: normalizedItems.length,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to convert requisition to purchase order:", err);
    return res.status(500).json({ message: "Failed to convert requisition to purchase order" });
  } finally {
    client.release();
  }
});

router.post("/requisitions/:id/submit", auth, authorize("ADMIN"), async (req, res) => {
  const requisitionId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(requisitionId)) {
    return res.status(400).json({ message: "Invalid requisition id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = (
      await client.query(
        `UPDATE purchase_requisitions
         SET status = 'SUBMITTED',
             updated_at = NOW()
         WHERE id = $1
           AND status IN ('DRAFT', 'REJECTED')
         RETURNING *`,
        [requisitionId]
      )
    ).rows;
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Only DRAFT/REJECTED requisitions can be submitted" });
    }

    await writeAuditLog(client, {
      action: "PURCHASE_REQUISITION_SUBMIT",
      entity_type: "purchase_requisition",
      entity_id: requisitionId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {},
    });

    await client.query("COMMIT");
    return res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to submit requisition:", err);
    return res.status(500).json({ message: "Failed to submit requisition" });
  } finally {
    client.release();
  }
});

router.post("/requisitions/:id/approve", auth, authorize("ADMIN"), async (req, res) => {
  const requisitionId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(requisitionId)) {
    return res.status(400).json({ message: "Invalid requisition id" });
  }

  const approvalNote = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = (
      await client.query(
        `UPDATE purchase_requisitions
         SET status = 'APPROVED',
             approved_by = $2,
             approved_at = NOW(),
             note = CASE
               WHEN $3::text IS NULL OR LENGTH(TRIM($3::text)) = 0 THEN note
               WHEN note IS NULL OR LENGTH(TRIM(note)) = 0 THEN $3
               ELSE CONCAT(note, E'\n', $3)
             END,
             updated_at = NOW()
         WHERE id = $1
           AND status IN ('SUBMITTED', 'DRAFT')
         RETURNING *`,
        [requisitionId, String(req.user.id), approvalNote]
      )
    ).rows;
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ message: "Only SUBMITTED/DRAFT requisitions can be approved" });
    }

    await writeAuditLog(client, {
      action: "PURCHASE_REQUISITION_APPROVE",
      entity_type: "purchase_requisition",
      entity_id: requisitionId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: { note: approvalNote || null },
    });

    await client.query("COMMIT");
    return res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to approve requisition:", err);
    return res.status(500).json({ message: "Failed to approve requisition" });
  } finally {
    client.release();
  }
});

router.post("/requisitions/:id/reject", auth, authorize("ADMIN"), async (req, res) => {
  const requisitionId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(requisitionId)) {
    return res.status(400).json({ message: "Invalid requisition id" });
  }

  const rejectNote = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = (
      await client.query(
        `UPDATE purchase_requisitions
         SET status = 'REJECTED',
             note = CASE
               WHEN $2::text IS NULL OR LENGTH(TRIM($2::text)) = 0 THEN note
               WHEN note IS NULL OR LENGTH(TRIM(note)) = 0 THEN $2
               ELSE CONCAT(note, E'\n', $2)
             END,
             updated_at = NOW()
         WHERE id = $1
           AND status IN ('SUBMITTED', 'DRAFT')
         RETURNING *`,
        [requisitionId, rejectNote]
      )
    ).rows;
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ message: "Only SUBMITTED/DRAFT requisitions can be rejected" });
    }

    await writeAuditLog(client, {
      action: "PURCHASE_REQUISITION_REJECT",
      entity_type: "purchase_requisition",
      entity_id: requisitionId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: { note: rejectNote || null },
    });

    await client.query("COMMIT");
    return res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to reject requisition:", err);
    return res.status(500).json({ message: "Failed to reject requisition" });
  } finally {
    client.release();
  }
});

export default router;
