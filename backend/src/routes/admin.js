import express from "express";
import multer from "multer";
import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import auth from "../middleware/auth.js";
import authorize, { authorizePermissions } from "../middleware/authorize.js";
import pool from "../db.js";
import { runBackupValidationJob } from "../services/backupJobs.js";
import {
  PERMISSION_DEFINITIONS,
  getDefaultPermissionKeysForBaseRole,
  normalizePermissionKeys,
} from "../config/accessControl.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const BUSINESS_TIMEZONE = String(process.env.APP_TIMEZONE || "Asia/Colombo").trim() || "Asia/Colombo";

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
  "qr_customer_requests",
  "cash_shifts",
  "expenses",
  "suppliers",
  "purchase_orders",
  "purchase_order_items",
  "goods_receipts",
  "goods_receipt_items",
  "branches",
  "branch_users",
  "branch_inventory",
  "branch_products",
  "stock_batches",
  "stock_movements",
  "stock_transfers",
  "stock_transfer_items",
  "purchase_requisitions",
  "purchase_requisition_items",
  "stock_count_sessions",
  "stock_count_items",
  "employees",
  "attendance_logs",
  "report_templates",
  "forecast_snapshots",
  "report_export_jobs",
  "backup_jobs",
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
  "qr_customer_requests",
  "cash_shifts",
  "expenses",
  "goods_receipts",
  "branches",
  "stock_transfers",
  "product_ingredients",
  "inventory_alerts",
  "branch_inventory",
  "branch_products",
  "stock_batches",
  "stock_movements",
  "purchase_requisitions",
  "employees",
  "stock_count_sessions",
  "purchase_order_items",
  "goods_receipt_items",
  "stock_transfer_items",
  "purchase_requisition_items",
  "stock_count_items",
  "attendance_logs",
  "report_templates",
  "forecast_snapshots",
  "report_export_jobs",
  "backup_jobs",
  "audit_logs",
  "customer_contacts",
  "customer_notes",
  "customer_tag_map",
  "customer_loyalty_txns",
  "branch_users",
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
  "stock_transfer_items",
  "stock_transfers",
  "stock_movements",
  "stock_batches",
  "purchase_requisition_items",
  "purchase_requisitions",
  "stock_count_items",
  "stock_count_sessions",
  "branch_inventory",
  "branch_products",
  "branch_users",
  "attendance_logs",
  "employees",
  "report_templates",
  "forecast_snapshots",
  "report_export_jobs",
  "purchase_order_items",
  "purchase_orders",
  "suppliers",
  "expenses",
  "cash_shifts",
  "audit_logs",
  "customer_tags",
  "customers",
  "products",
  "backup_jobs",
  "held_orders",
  "qr_customer_requests",
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

function parseOptionalMoney(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  const parsed = parseMoney(raw, NaN);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return NaN;
  }
  return parsed;
}

function normalizeProductPricing(payload = {}) {
  const smallPrice = parseOptionalMoney(payload?.small_price);
  const largePrice = parseOptionalMoney(payload?.large_price);
  const unitPrice = parseOptionalMoney(payload?.price);
  const requestedPortionMode =
    payload?.has_portions === true ||
    String(payload?.pricing_mode || "")
      .trim()
      .toUpperCase() === "PORTION";
  const hasAnyPortionInput = smallPrice !== null || largePrice !== null;
  const usePortionMode = requestedPortionMode || hasAnyPortionInput;

  if (Number.isNaN(smallPrice) || Number.isNaN(largePrice) || Number.isNaN(unitPrice)) {
    return {
      error: "Price values must be valid non-negative numbers",
    };
  }

  if (usePortionMode && smallPrice === null && largePrice === null) {
    return {
      error: "Provide small_price and/or large_price for portion pricing",
    };
  }

  const resolvedSmallPrice =
    usePortionMode && smallPrice === null ? largePrice : smallPrice;
  const resolvedLargePrice =
    usePortionMode && largePrice === null ? smallPrice : largePrice;
  const hasPortionPrices =
    usePortionMode &&
    (Number.isFinite(resolvedSmallPrice) || Number.isFinite(resolvedLargePrice));

  const resolvedSmallValue = Number.isFinite(resolvedSmallPrice)
    ? Number(resolvedSmallPrice)
    : 0;
  const resolvedLargeValue = Number.isFinite(resolvedLargePrice)
    ? Number(resolvedLargePrice)
    : 0;

  if (hasPortionPrices && resolvedSmallValue <= 0 && resolvedLargeValue <= 0) {
    return {
      error: "Small/Large prices must be greater than zero",
    };
  }

  const fallbackPrice = hasPortionPrices
    ? resolvedSmallValue > 0
      ? resolvedSmallPrice
      : resolvedLargePrice
    : null;
  const effectivePrice = unitPrice !== null ? unitPrice : fallbackPrice;

  return {
    smallPrice: hasPortionPrices ? resolvedSmallPrice : null,
    largePrice: hasPortionPrices ? resolvedLargePrice : null,
    price: effectivePrice,
    hasPortions: hasPortionPrices,
  };
}

function parseBranchId(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizePhone(value) {
  return String(value || "")
    .replace(/[^\d+]/g, "")
    .trim()
    .slice(0, 30);
}

const USER_BASE_ROLES = new Set(["ADMIN", "CASHIER"]);

function normalizeBaseRole(value, fallback = null) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (USER_BASE_ROLES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeUsername(value) {
  const username = String(value || "").trim().slice(0, 50);
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) {
    return null;
  }
  return username;
}

function normalizeRoleName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function parseOptionalRoleId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return NaN;
  }
  return parsed;
}

function normalizeUserId(value) {
  const userId = String(value || "").trim();
  if (!userId || userId.length > 80) {
    return null;
  }
  if (!/^[A-Za-z0-9-]+$/.test(userId)) {
    return null;
  }
  return userId;
}

function mapAccessRoleRow(row) {
  const permissions = normalizePermissionKeys(row?.permissions || []);
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description || "",
    base_role: String(row.base_role || "ADMIN").toUpperCase(),
    is_system: row.is_system === true,
    is_active: row.is_active !== false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    permissions,
    assigned_user_count: Number(row.assigned_user_count || 0),
  };
}

function mapUserAccessRow(row) {
  const hasCustomRole =
    Number.isFinite(Number(row.custom_role_id)) &&
    row.custom_role_is_active !== false;
  const effectivePermissions = hasCustomRole
    ? normalizePermissionKeys(row.custom_permissions)
    : getDefaultPermissionKeysForBaseRole(row.role);
  return {
    id: row.id,
    username: row.username,
    role: String(row.role || "").toUpperCase(),
    is_active: row.is_active !== false,
    is_super_admin: row.is_super_admin === true,
    custom_role_id: row.custom_role_id ? Number(row.custom_role_id) : null,
    custom_role_name: row.custom_role_name || null,
    permissions: effectivePermissions,
  };
}

async function fetchAccessRoleById(client, roleId) {
  const { rows } = await client.query(
    `SELECT
       ar.id,
       ar.name,
       ar.description,
       ar.base_role,
       ar.is_system,
       ar.is_active,
       ar.created_at,
       ar.updated_at,
       COALESCE(
         ARRAY_AGG(DISTINCT arp.permission_key) FILTER (WHERE arp.permission_key IS NOT NULL),
         ARRAY[]::text[]
       ) AS permissions,
       COUNT(DISTINCT u.id) AS assigned_user_count
     FROM access_roles ar
     LEFT JOIN access_role_permissions arp ON arp.role_id = ar.id
     LEFT JOIN users u ON u.custom_role_id = ar.id
     WHERE ar.id = $1
     GROUP BY ar.id`,
    [roleId]
  );
  return rows[0] ? mapAccessRoleRow(rows[0]) : null;
}

async function listAccessRoles(client) {
  const { rows } = await client.query(
    `SELECT
       ar.id,
       ar.name,
       ar.description,
       ar.base_role,
       ar.is_system,
       ar.is_active,
       ar.created_at,
       ar.updated_at,
       COALESCE(
         ARRAY_AGG(DISTINCT arp.permission_key) FILTER (WHERE arp.permission_key IS NOT NULL),
         ARRAY[]::text[]
       ) AS permissions,
       COUNT(DISTINCT u.id) AS assigned_user_count
     FROM access_roles ar
     LEFT JOIN access_role_permissions arp ON arp.role_id = ar.id
     LEFT JOIN users u ON u.custom_role_id = ar.id
     GROUP BY ar.id
     ORDER BY ar.is_system DESC, ar.base_role ASC, ar.name ASC`
  );
  return rows.map(mapAccessRoleRow);
}

async function resolveDefaultSystemRoleId(client, baseRole) {
  const normalizedBaseRole = String(baseRole || "").toUpperCase();
  const preferredName =
    normalizedBaseRole === "ADMIN"
      ? "Admin Default"
      : normalizedBaseRole === "CASHIER"
      ? "Cashier Default"
      : null;
  if (preferredName) {
    const preferredRes = await client.query(
      `SELECT id
       FROM access_roles
       WHERE is_system = TRUE
         AND is_active = TRUE
         AND base_role = $1
         AND name = $2
       ORDER BY id ASC
       LIMIT 1`,
      [normalizedBaseRole, preferredName]
    );
    if (preferredRes.rows[0]?.id) {
      return Number(preferredRes.rows[0].id);
    }
  }

  const fallbackRes = await client.query(
    `SELECT id
     FROM access_roles
     WHERE is_system = TRUE
       AND is_active = TRUE
       AND base_role = $1
     ORDER BY id ASC
     LIMIT 1`,
    [normalizedBaseRole]
  );
  return fallbackRes.rows[0]?.id ? Number(fallbackRes.rows[0].id) : null;
}

async function resolveAssignableRole(client, roleId, expectedBaseRole) {
  const { rows } = await client.query(
    `SELECT id, name, base_role, is_system, is_active
     FROM access_roles
     WHERE id = $1
     LIMIT 1`,
    [roleId]
  );
  const role = rows[0];
  if (!role) {
    return { error: "Role not found", status: 404 };
  }
  if (role.is_active === false) {
    return { error: "Role is inactive", status: 409 };
  }
  if (String(role.base_role || "").toUpperCase() !== expectedBaseRole) {
    return { error: "Role base does not match selected user role", status: 400 };
  }
  return {
    id: Number(role.id),
    name: role.name,
    base_role: String(role.base_role || "").toUpperCase(),
    is_system: role.is_system === true,
    is_active: role.is_active !== false,
  };
}

async function resolveSystemRoleIdByName(client, roleName, fallbackBaseRole = "ADMIN") {
  const { rows } = await client.query(
    `SELECT id
     FROM access_roles
     WHERE is_system = TRUE
       AND is_active = TRUE
       AND name = $1
     ORDER BY id ASC
     LIMIT 1`,
    [roleName]
  );
  if (rows[0]?.id) {
    return Number(rows[0].id);
  }
  return resolveDefaultSystemRoleId(client, fallbackBaseRole);
}

async function fetchUserSecurityContext(client, userId, lockRow = false) {
  const { rows } = await client.query(
    `SELECT
       id::text AS id,
       username,
       role,
       "isActive" AS is_active,
       custom_role_id,
       COALESCE(is_super_admin, FALSE) AS is_super_admin
     FROM users
     WHERE id::text = $1
     LIMIT 1
     ${lockRow ? "FOR UPDATE" : ""}`,
    [String(userId)]
  );
  return rows[0] || null;
}

function normalizeApprovalPin(value) {
  return String(value || "")
    .replace(/[^\d]/g, "")
    .slice(0, 12);
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
  const branchId = parsePositiveInt(
    reqQuery.branch_id ?? reqQuery.branchId,
    NaN,
    1,
    1_000_000
  );
  const params = [days];
  const conditions = [
    "created_at >= DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')",
    "created_at < NOW()",
  ];

  if (orderType) {
    params.push(orderType);
    conditions.push(`order_type = $${params.length}`);
  }
  if (paymentMethod) {
    params.push(paymentMethod);
    conditions.push(`payment_method = $${params.length}`);
  }
  if (Number.isFinite(branchId)) {
    params.push(branchId);
    conditions.push(`COALESCE(branch_id, 1) = $${params.length}`);
  }

  return {
    days,
    branchId: Number.isFinite(branchId) ? branchId : null,
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
router.get("/products", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const hasBranchFilter = Number.isFinite(branchId);
    const { rows } = await pool.query(
      hasBranchFilter
        ? `SELECT
             p.id,
             p.name,
             p.price,
             p.small_price,
             p.large_price,
             CASE
               WHEN COALESCE(p.small_price, 0) > 0 OR COALESCE(p.large_price, 0) > 0
                 THEN TRUE
               ELSE FALSE
             END AS has_portions,
             p.category,
             p.image_url,
             p."isActive" AS is_active,
             p.stock,
             bp.price_override,
             bp.is_active AS branch_is_active,
             COALESCE(bp.price_override, p.price) AS effective_price,
             CASE
               WHEN bp.id IS NULL THEN p."isActive"
               ELSE bp.is_active
             END AS effective_active
           FROM products p
           LEFT JOIN branch_products bp
             ON bp.branch_id = $1
            AND bp.product_id = p.id::text
           ORDER BY p.name`
        : `SELECT
             id,
             name,
             price,
             small_price,
             large_price,
             CASE
               WHEN COALESCE(small_price, 0) > 0 OR COALESCE(large_price, 0) > 0
                 THEN TRUE
               ELSE FALSE
             END AS has_portions,
             category,
             image_url,
             "isActive" as is_active,
             stock
           FROM products
           ORDER BY name`,
      hasBranchFilter ? [branchId] : []
    );
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching products:", err);
    console.error("Error stack:", err.stack);
    return res.status(500).json({ message: "Failed to fetch products", error: err.message });
  }
});

// Get active products for POS (both ADMIN and CASHIER)
router.get("/products/pos", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  try {
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const hasBranchFilter = Number.isFinite(branchId);
    const { rows } = await pool.query(
      hasBranchFilter
        ? `SELECT
             p.id,
             p.name,
             COALESCE(bp.price_override, p.price) AS price,
             p.small_price,
             p.large_price,
             CASE
               WHEN COALESCE(p.small_price, 0) > 0 OR COALESCE(p.large_price, 0) > 0
                 THEN TRUE
               ELSE FALSE
             END AS has_portions,
             p.category,
             p.image_url,
             p.price AS base_price,
             bp.price_override,
             CASE
               WHEN bp.id IS NULL THEN p."isActive"
               ELSE bp.is_active
             END AS is_active
           FROM products p
           LEFT JOIN branch_products bp
             ON bp.branch_id = $1
            AND bp.product_id = p.id::text
           WHERE p."isActive" = TRUE
             AND (bp.id IS NULL OR bp.is_active = TRUE)
           ORDER BY p.category, p.name`
        : `SELECT
             id,
             name,
             price,
             small_price,
             large_price,
             CASE
               WHEN COALESCE(small_price, 0) > 0 OR COALESCE(large_price, 0) > 0
                 THEN TRUE
               ELSE FALSE
             END AS has_portions,
             category,
             image_url
           FROM products
           WHERE "isActive" = true
           ORDER BY category, name`,
      hasBranchFilter ? [branchId] : []
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
  const { name, category, is_active: isActive = true } = req.body;
  const imageUrl = normalizeProductImageUrl(req.body?.image_url);
  const pricing = normalizeProductPricing(req.body || {});
  if (!name) {
    return res.status(400).json({ message: "Name is required" });
  }
  if (pricing.error) {
    return res.status(400).json({ message: pricing.error });
  }
  if (pricing.price === null) {
    return res.status(400).json({ message: "Price is required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO products (name, price, small_price, large_price, category, image_url, "isActive", stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING
         id,
         name,
         price,
         small_price,
         large_price,
         CASE
           WHEN COALESCE(small_price, 0) > 0 OR COALESCE(large_price, 0) > 0
             THEN TRUE
           ELSE FALSE
         END AS has_portions,
         category,
         image_url,
         "isActive" as is_active`,
      [
        name,
        pricing.price,
        pricing.smallPrice,
        pricing.largePrice,
        category || null,
        imageUrl,
        isActive,
        0,
      ]
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
  const { name, category, is_active: isActive, stock } = req.body;
  const hasImageUrl = Object.prototype.hasOwnProperty.call(
    req.body || {},
    "image_url"
  );
  const imageUrl = hasImageUrl
    ? normalizeProductImageUrl(req.body?.image_url)
    : null;
  const pricing = normalizeProductPricing(req.body || {});

  if (!name) {
    return res.status(400).json({ message: "Name is required" });
  }
  if (pricing.error) {
    return res.status(400).json({ message: pricing.error });
  }
  if (pricing.price === null) {
    return res.status(400).json({ message: "Price is required" });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE products
       SET name = $1,
           price = $2,
           small_price = $3,
           large_price = $4,
           category = $5,
           image_url = CASE WHEN $6 THEN $7 ELSE image_url END,
           "isActive" = $8,
           stock = COALESCE($9, stock)
       WHERE id::text = $10
       RETURNING
         id,
         name,
         price,
         small_price,
         large_price,
         CASE
           WHEN COALESCE(small_price, 0) > 0 OR COALESCE(large_price, 0) > 0
             THEN TRUE
           ELSE FALSE
         END AS has_portions,
         category,
         image_url,
         "isActive" as is_active,
         stock`,
      [
        name,
        pricing.price,
        pricing.smallPrice,
        pricing.largePrice,
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
  const normalizedId = String(id || "").trim();
  if (!normalizedId) {
    return res.status(400).json({ message: "Invalid product id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingRes = await client.query(
      `SELECT id::text AS id
       FROM products
       WHERE id::text = $1
       LIMIT 1
       FOR UPDATE`,
      [normalizedId]
    );
    if (existingRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }

    // Keep branch override table clean even if product cannot be hard-deleted.
    await client.query("DELETE FROM branch_products WHERE product_id = $1", [normalizedId]);

    const { rowCount } = await client.query(
      "DELETE FROM products WHERE id::text = $1",
      [normalizedId]
    );

    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }

    await client.query("COMMIT");
    return res.json({ message: "Product deleted successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    const errCode = String(err?.code || "").trim();
    const errMessage = String(err?.message || "").toLowerCase();
    const isConstraintError =
      errCode.startsWith("23") ||
      errMessage.includes("violates foreign key constraint") ||
      errMessage.includes("is still referenced");
    if (isConstraintError) {
      try {
        const deactivateRes = await pool.query(
          `UPDATE products
           SET "isActive" = FALSE
           WHERE id::text = $1
           RETURNING id`,
          [normalizedId]
        );
        if (deactivateRes.rowCount > 0) {
          return res.status(409).json({
            message:
              "Product is linked to existing records. It was deactivated instead of deleted.",
            deactivated: true,
          });
        }
      } catch (deactivateErr) {
        console.error("Failed to deactivate product after FK delete conflict:", deactivateErr);
      }
      return res.status(409).json({
        message: "Product is linked to existing records and cannot be deleted.",
      });
    }
    console.error("Error deleting product:", {
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
    });
    const payload = { message: "Failed to delete product" };
    if (String(process.env.NODE_ENV || "").toLowerCase() !== "production") {
      payload.error_code = errCode || null;
      payload.error_detail = err?.message || null;
    }
    return res.status(500).json(payload);
  } finally {
    client.release();
  }
});

// Dashboard stats
router.get("/dashboard/stats", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 1, 1, 3650);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const hasBranchFilter = Number.isFinite(branchId);

    // Current period sales
    const currentSales = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS count
       FROM orders
       WHERE created_at >= DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')
         AND created_at < NOW()
         AND COALESCE(status, 'COMPLETED') <> 'VOIDED'
         ${hasBranchFilter ? "AND COALESCE(branch_id, 1) = $2" : ""}`,
      hasBranchFilter ? [days, branchId] : [days]
    );

    // Previous period sales for comparison
    const previousSales = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE created_at >= DATE_TRUNC('day', NOW()) - (($1::int * 2 - 1) * INTERVAL '1 day')
         AND created_at < DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')
         AND COALESCE(status, 'COMPLETED') <> 'VOIDED'
         ${hasBranchFilter ? "AND COALESCE(branch_id, 1) = $2" : ""}`,
      hasBranchFilter ? [days, branchId] : [days]
    );

    const periodSalesTotal = parseFloat(currentSales.rows[0].total || 0);
    const previousSalesTotal = parseFloat(previousSales.rows[0].total || 0);
    const orderCount = parseInt(currentSales.rows[0].count || 0, 10);
    const avgOrderValue = orderCount > 0 ? periodSalesTotal / orderCount : 0;
    const salesChange =
      previousSalesTotal > 0
        ? ((periodSalesTotal - previousSalesTotal) / previousSalesTotal) * 100
        : periodSalesTotal > 0
        ? 100
        : 0;

    // Active orders (last 30 minutes)
    const activeOrders = await pool.query(
      `SELECT COUNT(*) AS count
       FROM orders
       WHERE created_at >= NOW() - INTERVAL '30 minutes'
         ${hasBranchFilter ? "AND COALESCE(branch_id, 1) = $1" : ""}`,
      hasBranchFilter ? [branchId] : []
    );

    // Approximate net profit based on expenses in the selected period.
    const expenseRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM expenses
       WHERE incurred_at >= DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')
         AND incurred_at < NOW()
         ${hasBranchFilter ? "AND COALESCE(branch_id, 1) = $2" : ""}`,
      hasBranchFilter ? [days, branchId] : [days]
    );
    const periodExpenses = parseFloat(expenseRes.rows[0]?.total || 0);
    const netProfit = periodSalesTotal - periodExpenses;

    const periodBoundaryRes = await pool.query(
      `SELECT
         DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day') AS period_start,
         NOW() AS period_end,
         DATE_TRUNC('day', NOW()) - (($1::int * 2 - 1) * INTERVAL '1 day') AS comparison_start,
         DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day') AS comparison_end`,
      [days]
    );
    const periodBoundaries = periodBoundaryRes.rows[0] || {};

    return res.json({
      todaySales: periodSalesTotal.toFixed(2),
      salesTotal: periodSalesTotal.toFixed(2),
      salesChange: Number.isFinite(salesChange)
        ? Math.round(salesChange * 10) / 10
        : 0,
      totalOrders: orderCount,
      avgOrderValue: avgOrderValue.toFixed(2),
      netProfit: netProfit.toFixed(2),
      expensesToday: periodExpenses.toFixed(2),
      expensesTotal: periodExpenses.toFixed(2),
      activeOrders: parseInt(activeOrders.rows[0].count || 0),
      periodDays: days,
      periodStart: periodBoundaries.period_start || null,
      periodEnd: periodBoundaries.period_end || null,
      comparisonStart: periodBoundaries.comparison_start || null,
      comparisonEnd: periodBoundaries.comparison_end || null,
      timezone: BUSINESS_TIMEZONE,
      branchId: hasBranchFilter ? branchId : null,
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch dashboard stats" });
  }
});

// Dashboard sales chart
router.get("/dashboard/sales-chart", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 30, 1, 365);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const hasBranchFilter = Number.isFinite(branchId);

    const { rows } = await pool.query(
      `SELECT DATE(created_at) AS day, COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE created_at >= DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')
         AND created_at < NOW()
         AND COALESCE(status, 'COMPLETED') <> 'VOIDED'
         ${hasBranchFilter ? "AND COALESCE(branch_id, 1) = $2" : ""}
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      hasBranchFilter ? [days, branchId] : [days]
    );
    return res.json(rows.map(r => ({ day: r.day, total: parseFloat(r.total || 0) })));
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch sales chart" });
  }
});

// Order breakdown by type
router.get("/dashboard/order-breakdown", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 1, 1, 3650);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const hasBranchFilter = Number.isFinite(branchId);

    const { rows } = await pool.query(
      `SELECT payment_method, COUNT(*) AS count, SUM(total) AS total
       FROM orders
       WHERE created_at >= DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')
         AND created_at < NOW()
         AND COALESCE(status, 'COMPLETED') <> 'VOIDED'
         ${hasBranchFilter ? "AND COALESCE(branch_id, 1) = $2" : ""}
       GROUP BY payment_method`,
      hasBranchFilter ? [days, branchId] : [days]
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
router.get("/dashboard/top-items", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 1, 1, 3650);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const hasBranchFilter = Number.isFinite(branchId);

    const { rows } = await pool.query(
      `SELECT
         COALESCE(p.name, CONCAT('Item ', oi.product_id::text)) AS name,
         SUM(oi.qty) AS total_qty,
         SUM(oi.qty * oi.price) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE o.created_at >= DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')
         AND o.created_at < NOW()
         AND COALESCE(o.status, 'COMPLETED') <> 'VOIDED'
         ${hasBranchFilter ? "AND COALESCE(o.branch_id, 1) = $2" : ""}
       GROUP BY COALESCE(p.name, CONCAT('Item ', oi.product_id::text))
       ORDER BY total_qty DESC
       LIMIT 5`,
      hasBranchFilter ? [days, branchId] : [days]
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

// Item-wise sales chart for selected period
router.get("/dashboard/item-sales-monthly", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 30, 1, 3650);
    const limit = parsePositiveInt(req.query.limit, 12, 1, 50);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const hasBranchFilter = Number.isFinite(branchId);
    const params = [days];

    if (hasBranchFilter) {
      params.push(branchId);
    }
    params.push(limit);
    const limitParam = params.length;

    const { rows } = await pool.query(
      `SELECT
         COALESCE(p.name, CONCAT('Item ', oi.product_id::text)) AS name,
         COALESCE(SUM(oi.qty), 0) AS qty,
         COALESCE(SUM(oi.qty * oi.price), 0) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE o.created_at >= DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')
         AND o.created_at < NOW()
         AND COALESCE(o.status, 'COMPLETED') <> 'VOIDED'
         ${hasBranchFilter ? "AND COALESCE(o.branch_id, 1) = $2" : ""}
       GROUP BY COALESCE(p.name, CONCAT('Item ', oi.product_id::text))
       ORDER BY qty DESC, revenue DESC
       LIMIT $${limitParam}`,
      params
    );

    return res.json(
      rows.map((row) => ({
        name: row.name,
        qty: parseFloat(row.qty || 0),
        revenue: parseFloat(row.revenue || 0),
      }))
    );
  } catch (err) {
    console.error("Failed to fetch monthly item sales:", err);
    return res.status(500).json({ message: "Failed to fetch monthly item sales" });
  }
});

// Recent orders
router.get("/dashboard/recent-orders", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 1, 1, 3650);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const hasBranchFilter = Number.isFinite(branchId);
    const params = [days];

    if (hasBranchFilter) {
      params.push(branchId);
    }

    const { rows } = await pool.query(
      `SELECT id, total, payment_method, created_at 
       FROM orders 
       WHERE created_at >= DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')
         AND created_at < NOW()
       ${hasBranchFilter ? "AND COALESCE(branch_id, 1) = $2" : ""}
       ORDER BY created_at DESC 
       LIMIT 10`,
      params
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

// Branch sales comparison
router.get("/dashboard/branch-comparison", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 30, 1, 3650);
    const limit = parsePositiveInt(req.query.limit, 20, 1, 200);
    const { rows } = await pool.query(
      `SELECT
         b.id AS branch_id,
         b.code AS branch_code,
         b.name AS branch_name,
         COUNT(o.id) AS order_count,
         COALESCE(SUM(o.total), 0) AS sales_total,
         COALESCE(AVG(o.total), 0) AS avg_order_value
       FROM branches b
      LEFT JOIN orders o
        ON COALESCE(o.branch_id, 1) = b.id
        AND o.created_at >= DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')
        AND o.created_at < NOW()
        AND COALESCE(o.status, 'COMPLETED') <> 'VOIDED'
       GROUP BY b.id, b.code, b.name
       ORDER BY sales_total DESC
       LIMIT $2`,
      [days, limit]
    );
    return res.json(
      rows.map((row) => ({
        branch_id: Number(row.branch_id),
        branch_code: row.branch_code,
        branch_name: row.branch_name,
        order_count: parseInt(row.order_count || 0, 10),
        sales_total: parseFloat(row.sales_total || 0),
        avg_order_value: parseFloat(row.avg_order_value || 0),
      }))
    );
  } catch (err) {
    console.error("Failed to fetch branch comparison:", err);
    return res.status(500).json({ message: "Failed to fetch branch comparison" });
  }
});

// Sales ledger with invoice numbers + item details
router.get("/sales", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 30, 1, 3650);
    const limit = parsePositiveInt(req.query.limit, 200, 1, 1000);
    const offset = parsePositiveInt(req.query.offset, 0, 0, 1_000_000);
    const branchId = parsePositiveInt(
      req.query.branch_id ?? req.query.branchId,
      NaN,
      1,
      1_000_000
    );
    const paymentMethod = normalizePaymentMethod(
      req.query.payment_method ?? req.query.paymentMethod
    );
    const search = String(req.query.search || "")
      .trim()
      .slice(0, 80);

    const params = [days];
    const where = [
      "o.created_at >= DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')",
      "o.created_at < NOW()",
    ];

    if (Number.isFinite(branchId)) {
      params.push(branchId);
      where.push(`COALESCE(o.branch_id, 1) = $${params.length}`);
    }

    if (paymentMethod) {
      params.push(paymentMethod);
      where.push(`o.payment_method = $${params.length}`);
    }

    if (search) {
      const escaped = search.replace(/[\\%_]/g, "\\$&");
      params.push(`%${escaped}%`);
      where.push(`(
        COALESCE(o.invoice_number, '') ILIKE $${params.length} ESCAPE '\\'
        OR COALESCE(o.customer_name, '') ILIKE $${params.length} ESCAPE '\\'
        OR COALESCE(o.customer_phone, '') ILIKE $${params.length} ESCAPE '\\'
      )`);
    }

    params.push(limit);
    const limitParam = params.length;
    params.push(offset);
    const offsetParam = params.length;

    const { rows } = await pool.query(
      `SELECT
         o.id,
         COALESCE(o.invoice_number, CONCAT('VOXO', LPAD(o.id::text, 6, '0'))) AS invoice_number,
         o.created_at,
         o.customer_name,
         o.customer_phone,
         o.total,
         o.payment_method,
         o.loyalty_points_redeemed,
         o.loyalty_discount_amount,
         o.manual_discount_amount,
         o.total_discount_amount,
         o.status,
         o.refunded_amount,
         COALESCE(
           json_agg(
             jsonb_build_object(
               'product_id', oi.product_id,
               'name', COALESCE(p.name, CONCAT('Item ', oi.product_id::text)),
               'qty', oi.qty,
               'unit_price', oi.price,
               'line_total', (COALESCE(oi.qty::numeric, 0) * COALESCE(oi.price, 0))
             )
             ORDER BY oi.id
           ) FILTER (WHERE oi.id IS NOT NULL),
           '[]'::json
         ) AS items,
         COALESCE(SUM(COALESCE(oi.qty::numeric, 0) * COALESCE(oi.price, 0)), 0) AS gross_items_total
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE ${where.join(" AND ")}
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT $${limitParam}
       OFFSET $${offsetParam}`,
      params
    );

    return res.json(
      rows.map((row) => {
        const items = Array.isArray(row.items) ? row.items : [];
        return {
          id: Number(row.id),
          invoice_number: row.invoice_number,
          created_at: row.created_at,
          customer_name: row.customer_name || null,
          customer_phone: row.customer_phone || null,
          total: parseFloat(row.total || 0),
          payment_method: row.payment_method || "OTHER",
          discount_amount: parseFloat(
            row.total_discount_amount ?? row.loyalty_discount_amount ?? 0
          ),
          manual_discount_amount: parseFloat(row.manual_discount_amount || 0),
          loyalty_discount_amount: parseFloat(row.loyalty_discount_amount || 0),
          loyalty_points_redeemed: parseInt(row.loyalty_points_redeemed || 0, 10),
          status: row.status || "COMPLETED",
          refunded_amount: parseFloat(row.refunded_amount || 0),
          gross_items_total: parseFloat(row.gross_items_total || 0),
          items: items.map((item) => ({
            product_id: item.product_id,
            name: item.name,
            qty: parseFloat(item.qty || 0),
            unit_price: parseFloat(item.unit_price || 0),
            line_total: parseFloat(item.line_total || 0),
          })),
        };
      })
    );
  } catch (err) {
    console.error("Failed to fetch sales ledger:", err);
    return res.status(500).json({ message: "Failed to fetch sales ledger" });
  }
});

// QR customer intake requests (admin approval flow)
router.get("/qr-customer-requests", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const statusInput = String(req.query.status || "PENDING")
      .trim()
      .toUpperCase();
    const status = ["ALL", "PENDING", "APPROVED", "REJECTED"].includes(statusInput)
      ? statusInput
      : "PENDING";
    const limit = parsePositiveInt(req.query.limit, 200, 1, 1000);
    const branchId = parsePositiveInt(
      req.query.branch_id ?? req.query.branchId,
      NaN,
      1,
      1_000_000
    );
    const search = String(req.query.search || "")
      .trim()
      .slice(0, 80);

    const params = [limit];
    const where = ["true"];

    if (status !== "ALL") {
      params.push(status);
      where.push(`qcr.status = $${params.length}`);
    }
    if (Number.isFinite(branchId)) {
      params.push(branchId);
      where.push(`COALESCE(qcr.branch_id, 1) = $${params.length}`);
    }
    if (search) {
      const escaped = search.replace(/[\\%_]/g, "\\$&");
      params.push(`%${escaped}%`);
      where.push(`(
        COALESCE(qcr.customer_name, '') ILIKE $${params.length} ESCAPE '\\'
        OR COALESCE(qcr.customer_phone, '') ILIKE $${params.length} ESCAPE '\\'
        OR COALESCE(ho.meta->>'invoice_number', '') ILIKE $${params.length} ESCAPE '\\'
      )`);
    }

    const { rows } = await pool.query(
      `SELECT
         qcr.id,
         qcr.branch_id,
         qcr.held_order_id,
         qcr.source,
         qcr.customer_name,
         qcr.customer_phone,
         qcr.customer_email,
         qcr.customer_address,
         qcr.status,
         qcr.request_count,
         qcr.meta,
         qcr.requested_at,
         qcr.last_order_at,
         qcr.reviewed_at,
         qcr.reviewed_by,
         qcr.review_note,
         qcr.approved_customer_id,
         qcr.created_at,
         qcr.updated_at,
         c.full_name AS approved_customer_name,
         ho.meta->>'invoice_number' AS invoice_number,
         ho.meta->>'reference' AS reference
       FROM qr_customer_requests qcr
       LEFT JOIN customers c ON c.id = qcr.approved_customer_id
       LEFT JOIN held_orders ho ON ho.id = qcr.held_order_id
       WHERE ${where.join(" AND ")}
       ORDER BY qcr.requested_at DESC
       LIMIT $1`,
      params
    );

    return res.json(
      rows.map((row) => ({
        ...row,
        branch_id: row.branch_id ? Number(row.branch_id) : null,
        held_order_id: row.held_order_id ? Number(row.held_order_id) : null,
        request_count: Number(row.request_count || 0),
        meta:
          row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
            ? row.meta
            : {},
      }))
    );
  } catch (err) {
    console.error("Failed to fetch QR customer requests:", err);
    return res.status(500).json({ message: "Failed to fetch QR customer requests" });
  }
});

router.post(
  "/qr-customer-requests/:id/approve",
  auth,
  authorize("ADMIN"),
  async (req, res) => {
    const requestId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000_000);
    if (!Number.isFinite(requestId)) {
      return res.status(400).json({ message: "Invalid request id" });
    }

    const reviewNote = req.body?.review_note
      ? String(req.body.review_note).trim().slice(0, 500)
      : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const requestRes = await client.query(
        `SELECT *
         FROM qr_customer_requests
         WHERE id = $1
         FOR UPDATE`,
        [requestId]
      );
      const request = requestRes.rows[0];
      if (!request) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Customer request not found" });
      }
      if (String(request.status || "").toUpperCase() !== "PENDING") {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Only pending requests can be approved" });
      }

      const phone = normalizePhone(request.customer_phone);
      if (!phone) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Request does not contain a valid phone number" });
      }

      const name = String(request.customer_name || "").trim().slice(0, 120) || "QR Customer";
      const email = request.customer_email
        ? String(request.customer_email).trim().slice(0, 120)
        : null;
      const address = request.customer_address
        ? String(request.customer_address).trim().slice(0, 500)
        : null;

      const existingCustomerRes = await client.query(
        `SELECT id, full_name, phone, email, address
         FROM customers
         WHERE phone = $1
         LIMIT 1
         FOR UPDATE`,
        [phone]
      );

      let customer = existingCustomerRes.rows[0] || null;
      if (customer) {
        const { rows } = await client.query(
          `UPDATE customers
           SET full_name = COALESCE(NULLIF($2, ''), full_name),
               email = COALESCE(NULLIF($3, ''), email),
               address = COALESCE(NULLIF($4, ''), address),
               is_active = TRUE,
               updated_at = NOW()
           WHERE id = $1
           RETURNING id, full_name, phone, email, address`,
          [customer.id, name, email || "", address || ""]
        );
        customer = rows[0] || customer;
      } else {
        const customerId = randomUUID();
        const { rows } = await client.query(
          `INSERT INTO customers (id, full_name, phone, email, address, is_active)
           VALUES ($1, $2, $3, $4, $5, TRUE)
           RETURNING id, full_name, phone, email, address`,
          [customerId, name, phone, email, address]
        );
        customer = rows[0];
      }

      let updatedRequest = null;
      try {
        const requestUpdateRes = await client.query(
          `UPDATE qr_customer_requests
           SET status = 'APPROVED',
               reviewed_at = NOW(),
               reviewed_by = $2,
               review_note = COALESCE($3, review_note),
               approved_customer_id = $4,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [requestId, String(req.user.id), reviewNote, customer.id]
        );
        updatedRequest = requestUpdateRes.rows[0];
      } catch (updateErr) {
        const looksLikeApprovedCustomerColumnIssue = /approved_customer_id/i.test(
          String(updateErr?.message || "")
        );
        if (!looksLikeApprovedCustomerColumnIssue) {
          throw updateErr;
        }
        const fallbackRes = await client.query(
          `UPDATE qr_customer_requests
           SET status = 'APPROVED',
               reviewed_at = NOW(),
               reviewed_by = $2,
               review_note = COALESCE($3, review_note),
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [requestId, String(req.user.id), reviewNote]
        );
        updatedRequest = fallbackRes.rows[0] || null;
      }

      if (updatedRequest?.held_order_id) {
        await client.query(
          `UPDATE held_orders
           SET customer_name = COALESCE(customer_name, $2),
               customer_phone = COALESCE(customer_phone, $3),
               meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(
                 'crm_customer_id', $4,
                 'crm_customer_status', 'APPROVED'
               )
           WHERE id = $1`,
          [updatedRequest.held_order_id, customer.full_name, customer.phone, customer.id]
        );
      }

      await writeAuditLog(client, {
        action: "QR_CUSTOMER_REQUEST_APPROVE",
        entity_type: "qr_customer_request",
        entity_id: String(requestId),
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: {
          approved_customer_id: customer.id,
          held_order_id: updatedRequest?.held_order_id || null,
        },
      });

      await client.query("COMMIT");
      return res.json({
        message: "Customer request approved",
        request: updatedRequest,
        customer,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
      console.error("Failed to approve QR customer request:", err);
      return res.status(500).json({ message: "Failed to approve customer request" });
    } finally {
      client.release();
    }
  }
);

router.post(
  "/qr-customer-requests/:id/reject",
  auth,
  authorize("ADMIN"),
  async (req, res) => {
    const requestId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000_000);
    if (!Number.isFinite(requestId)) {
      return res.status(400).json({ message: "Invalid request id" });
    }
    const reviewNote = String(req.body?.review_note || "").trim().slice(0, 500);
    if (!reviewNote) {
      return res.status(400).json({ message: "Rejection reason is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const requestRes = await client.query(
        `SELECT *
         FROM qr_customer_requests
         WHERE id = $1
         FOR UPDATE`,
        [requestId]
      );
      const request = requestRes.rows[0];
      if (!request) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Customer request not found" });
      }
      if (String(request.status || "").toUpperCase() !== "PENDING") {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Only pending requests can be rejected" });
      }

      const { rows } = await client.query(
        `UPDATE qr_customer_requests
         SET status = 'REJECTED',
             reviewed_at = NOW(),
             reviewed_by = $2,
             review_note = $3,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [requestId, String(req.user.id), reviewNote]
      );
      const updatedRequest = rows[0];

      if (updatedRequest?.held_order_id) {
        await client.query(
          `UPDATE held_orders
           SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(
             'crm_customer_status', 'REJECTED'
           )
           WHERE id = $1`,
          [updatedRequest.held_order_id]
        );
      }

      await writeAuditLog(client, {
        action: "QR_CUSTOMER_REQUEST_REJECT",
        entity_type: "qr_customer_request",
        entity_id: String(requestId),
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: {
          held_order_id: updatedRequest?.held_order_id || null,
          review_note: reviewNote,
        },
      });

      await client.query("COMMIT");
      return res.json({ message: "Customer request rejected", request: updatedRequest });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Failed to reject QR customer request:", err);
      return res.status(500).json({ message: "Failed to reject customer request" });
    } finally {
      client.release();
    }
  }
);

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
         branch_id,
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
        branchId: row.branch_id ? Number(row.branch_id) : null,
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

// Manager approval PIN (used for refund/void approval)
router.post("/security/approval-pin", auth, authorize("ADMIN"), async (req, res) => {
  const pin = normalizeApprovalPin(req.body?.pin);
  const confirmPin = normalizeApprovalPin(req.body?.confirm_pin);

  if (!pin || pin.length < 4) {
    return res.status(400).json({ message: "pin must be at least 4 digits" });
  }
  if (confirmPin && confirmPin !== pin) {
    return res.status(400).json({ message: "confirm_pin does not match pin" });
  }

  const hash = await bcrypt.hash(pin, 10);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updateRes = await client.query(
      `UPDATE users
       SET approval_pin_hash = $1,
           approval_pin_updated_at = NOW()
       WHERE id::text = $2
       RETURNING id::text AS id`,
      [hash, String(req.user.id)]
    );
    if (!updateRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found" });
    }

    await writeAuditLog(client, {
      action: "SECURITY_APPROVAL_PIN_SET",
      entity_type: "user",
      entity_id: updateRes.rows[0].id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {},
    });

    await client.query("COMMIT");
    return res.json({ message: "Approval PIN updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to set approval pin:", err);
    return res.status(500).json({ message: "Failed to update approval pin" });
  } finally {
    client.release();
  }
});

router.delete("/security/approval-pin", auth, authorize("ADMIN"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updateRes = await client.query(
      `UPDATE users
       SET approval_pin_hash = NULL,
           approval_pin_updated_at = NOW()
       WHERE id::text = $1
       RETURNING id::text AS id`,
      [String(req.user.id)]
    );
    if (!updateRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found" });
    }

    await writeAuditLog(client, {
      action: "SECURITY_APPROVAL_PIN_CLEAR",
      entity_type: "user",
      entity_id: updateRes.rows[0].id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {},
    });

    await client.query("COMMIT");
    return res.json({ message: "Approval PIN removed" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to clear approval pin:", err);
    return res.status(500).json({ message: "Failed to clear approval pin" });
  } finally {
    client.release();
  }
});

// Access permissions catalog
router.get(
  "/access/permissions",
  auth,
  authorize("ADMIN"),
  authorizePermissions("users.view"),
  async (_req, res) => {
    return res.json(PERMISSION_DEFINITIONS);
  }
);

// Custom roles
router.get(
  "/access/roles",
  auth,
  authorize("ADMIN"),
  authorizePermissions("users.view"),
  async (_req, res) => {
    try {
      const roles = await listAccessRoles(pool);
      return res.json(roles);
    } catch (err) {
      console.error("Failed to fetch access roles:", err);
      return res.status(500).json({ message: "Failed to fetch access roles" });
    }
  }
);

router.post(
  "/access/roles",
  auth,
  authorize("ADMIN"),
  authorizePermissions("roles.manage"),
  async (req, res) => {
    const name = normalizeRoleName(req.body?.name);
    const description = req.body?.description
      ? String(req.body.description).trim().slice(0, 500)
      : null;
    const baseRole = normalizeBaseRole(req.body?.base_role, null);

    if (!name || name.length < 3) {
      return res.status(400).json({ message: "Role name must be at least 3 characters" });
    }
    if (!baseRole) {
      return res.status(400).json({ message: "base_role must be ADMIN or CASHIER" });
    }
    if (!Array.isArray(req.body?.permissions)) {
      return res.status(400).json({ message: "permissions must be an array" });
    }

    const permissions = normalizePermissionKeys(req.body.permissions);
    if (permissions.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one permission is required" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const roleRes = await client.query(
        `INSERT INTO access_roles (name, description, base_role, is_system, is_active, updated_at)
         VALUES ($1, $2, $3, FALSE, TRUE, NOW())
         RETURNING id`,
        [name, description, baseRole]
      );
      const roleId = Number(roleRes.rows[0]?.id || 0);

      for (const permission of permissions) {
        await client.query(
          `INSERT INTO access_role_permissions (role_id, permission_key)
           VALUES ($1, $2)
           ON CONFLICT (role_id, permission_key) DO NOTHING`,
          [roleId, permission]
        );
      }

      await writeAuditLog(client, {
        action: "ACCESS_ROLE_CREATE",
        entity_type: "access_role",
        entity_id: roleId,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: {
          name,
          base_role: baseRole,
          permission_count: permissions.length,
        },
      });

      const createdRole = await fetchAccessRoleById(client, roleId);
      await client.query("COMMIT");
      return res.status(201).json(createdRole);
    } catch (err) {
      await client.query("ROLLBACK");
      if (String(err?.code) === "23505") {
        return res.status(409).json({ message: "A role with this name already exists" });
      }
      console.error("Failed to create access role:", err);
      return res.status(500).json({ message: "Failed to create access role" });
    } finally {
      client.release();
    }
  }
);

router.put(
  "/access/roles/:id",
  auth,
  authorize("ADMIN"),
  authorizePermissions("roles.manage"),
  async (req, res) => {
    const roleId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
    if (!Number.isFinite(roleId)) {
      return res.status(400).json({ message: "Invalid role id" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
    const hasBaseRole = Object.prototype.hasOwnProperty.call(body, "base_role");
    const hasIsActive = Object.prototype.hasOwnProperty.call(body, "is_active");
    const hasPermissions = Object.prototype.hasOwnProperty.call(body, "permissions");

    if (hasPermissions && !Array.isArray(body.permissions)) {
      return res.status(400).json({ message: "permissions must be an array" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentRes = await client.query(
        `SELECT id, name, description, base_role, is_system, is_active
         FROM access_roles
         WHERE id = $1
         FOR UPDATE`,
        [roleId]
      );
      const current = currentRes.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Role not found" });
      }
      if (current.is_system === true) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "System roles cannot be modified" });
      }

      const nextName = hasName ? normalizeRoleName(body.name) : current.name;
      const nextDescription = hasDescription
        ? String(body.description || "").trim().slice(0, 500) || null
        : current.description;
      const nextBaseRole = hasBaseRole
        ? normalizeBaseRole(body.base_role, null)
        : String(current.base_role || "").toUpperCase();
      const nextIsActive = hasIsActive ? body.is_active !== false : current.is_active !== false;

      if (!nextName || nextName.length < 3) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Role name must be at least 3 characters" });
      }
      if (!nextBaseRole) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "base_role must be ADMIN or CASHIER" });
      }
      if (!nextIsActive) {
        const assignedRes = await client.query(
          `SELECT COUNT(*) AS count
           FROM users
           WHERE custom_role_id = $1`,
          [roleId]
        );
        const assignedCount = Number(assignedRes.rows[0]?.count || 0);
        if (assignedCount > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            message: "Cannot deactivate a role that is assigned to users",
          });
        }
      }

      await client.query(
        `UPDATE access_roles
         SET name = $2,
             description = $3,
             base_role = $4,
             is_active = $5,
             updated_at = NOW()
         WHERE id = $1`,
        [roleId, nextName, nextDescription, nextBaseRole, nextIsActive]
      );

      if (hasPermissions) {
        const permissions = normalizePermissionKeys(body.permissions);
        if (permissions.length === 0) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ message: "At least one permission is required" });
        }
        await client.query(
          `DELETE FROM access_role_permissions
           WHERE role_id = $1`,
          [roleId]
        );
        for (const permission of permissions) {
          await client.query(
            `INSERT INTO access_role_permissions (role_id, permission_key)
             VALUES ($1, $2)
             ON CONFLICT (role_id, permission_key) DO NOTHING`,
            [roleId, permission]
          );
        }
      }

      await writeAuditLog(client, {
        action: "ACCESS_ROLE_UPDATE",
        entity_type: "access_role",
        entity_id: roleId,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: {
          name: nextName,
          base_role: nextBaseRole,
          is_active: nextIsActive,
          permissions_updated: hasPermissions,
        },
      });

      const updatedRole = await fetchAccessRoleById(client, roleId);
      await client.query("COMMIT");
      return res.json(updatedRole);
    } catch (err) {
      await client.query("ROLLBACK");
      if (String(err?.code) === "23505") {
        return res.status(409).json({ message: "A role with this name already exists" });
      }
      console.error("Failed to update access role:", err);
      return res.status(500).json({ message: "Failed to update access role" });
    } finally {
      client.release();
    }
  }
);

router.delete(
  "/access/roles/:id",
  auth,
  authorize("ADMIN"),
  authorizePermissions("roles.manage"),
  async (req, res) => {
    const roleId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
    if (!Number.isFinite(roleId)) {
      return res.status(400).json({ message: "Invalid role id" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const roleRes = await client.query(
        `SELECT id, name, is_system
         FROM access_roles
         WHERE id = $1
         FOR UPDATE`,
        [roleId]
      );
      const role = roleRes.rows[0];
      if (!role) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Role not found" });
      }
      if (role.is_system === true) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "System roles cannot be deleted" });
      }

      const usageRes = await client.query(
        `SELECT COUNT(*) AS count
         FROM users
         WHERE custom_role_id = $1`,
        [roleId]
      );
      const usageCount = Number(usageRes.rows[0]?.count || 0);
      if (usageCount > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: "Role is assigned to users. Reassign users before deleting role.",
        });
      }

      await client.query(
        `DELETE FROM access_roles
         WHERE id = $1`,
        [roleId]
      );

      await writeAuditLog(client, {
        action: "ACCESS_ROLE_DELETE",
        entity_type: "access_role",
        entity_id: roleId,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: { name: role.name },
      });

      await client.query("COMMIT");
      return res.json({ message: "Role deleted successfully" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Failed to delete access role:", err);
      return res.status(500).json({ message: "Failed to delete access role" });
    } finally {
      client.release();
    }
  }
);

// User management
router.get(
  "/users",
  auth,
  authorize("ADMIN"),
  authorizePermissions("users.view"),
  async (req, res) => {
    const includeInactive =
      String(req.query.include_inactive || "")
        .trim()
        .toLowerCase() === "true";
    try {
      const { rows } = await pool.query(
        `SELECT
           u.id::text AS id,
           u.username,
           u.role,
           u."isActive" AS is_active,
           COALESCE(u.is_super_admin, FALSE) AS is_super_admin,
           u.custom_role_id,
           ar.name AS custom_role_name,
           ar.is_active AS custom_role_is_active,
           COALESCE(
             ARRAY_AGG(DISTINCT arp.permission_key) FILTER (WHERE arp.permission_key IS NOT NULL),
             ARRAY[]::text[]
           ) AS custom_permissions
         FROM users u
         LEFT JOIN access_roles ar ON ar.id = u.custom_role_id
         LEFT JOIN access_role_permissions arp ON arp.role_id = ar.id
         ${includeInactive ? "" : 'WHERE u."isActive" = TRUE'}
         GROUP BY
           u.id,
           u.username,
           u.role,
           u."isActive",
           u.is_super_admin,
           u.custom_role_id,
           ar.name,
           ar.is_active
         ORDER BY u.id ASC`
      );
      return res.json(rows.map(mapUserAccessRow));
    } catch (err) {
      console.error("Failed to fetch users:", err);
      return res.status(500).json({ message: "Failed to fetch users" });
    }
  }
);

router.post(
  "/users",
  auth,
  authorize("ADMIN"),
  authorizePermissions("users.manage"),
  async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const rawPassword = String(req.body?.password || "");
    const role = normalizeBaseRole(req.body?.role, "CASHIER");
    const isActive = req.body?.is_active !== false;
    const customRoleInput = parseOptionalRoleId(req.body?.custom_role_id);

    if (!username) {
      return res.status(400).json({
        message:
          "username is required and must be 3-50 characters (letters, numbers, ., _, -)",
      });
    }
    if (rawPassword.length < 6) {
      return res.status(400).json({ message: "password must be at least 6 characters" });
    }
    if (Number.isNaN(customRoleInput)) {
      return res.status(400).json({ message: "custom_role_id is invalid" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let customRoleId = null;
      if (Number.isFinite(customRoleInput)) {
        const roleValidation = await resolveAssignableRole(
          client,
          customRoleInput,
          role
        );
        if (roleValidation?.error) {
          await client.query("ROLLBACK");
          return res.status(roleValidation.status).json({ message: roleValidation.error });
        }
        customRoleId = roleValidation.id;
      } else {
        customRoleId = await resolveDefaultSystemRoleId(client, role);
      }

      const duplicateUserRes = await client.query(
        `SELECT id::text AS id
         FROM users
         WHERE LOWER(username) = LOWER($1)
         LIMIT 1`,
        [username]
      );
      if (duplicateUserRes.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Username already exists" });
      }

      const passwordHash = await bcrypt.hash(rawPassword, 10);
      const insertRes = await client.query(
        `INSERT INTO users (username, "passwordHash", role, "isActive", custom_role_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id::text AS id`,
        [username, passwordHash, role, isActive, customRoleId]
      );
      const userId = insertRes.rows[0]?.id;

      const createdUserRes = await client.query(
        `SELECT
           u.id::text AS id,
           u.username,
           u.role,
           u."isActive" AS is_active,
           COALESCE(u.is_super_admin, FALSE) AS is_super_admin,
           u.custom_role_id,
           ar.name AS custom_role_name,
           ar.is_active AS custom_role_is_active,
           COALESCE(
             ARRAY_AGG(DISTINCT arp.permission_key) FILTER (WHERE arp.permission_key IS NOT NULL),
             ARRAY[]::text[]
           ) AS custom_permissions
         FROM users u
         LEFT JOIN access_roles ar ON ar.id = u.custom_role_id
         LEFT JOIN access_role_permissions arp ON arp.role_id = ar.id
         WHERE u.id::text = $1
         GROUP BY
           u.id,
           u.username,
           u.role,
           u."isActive",
           u.is_super_admin,
           u.custom_role_id,
           ar.name,
           ar.is_active`,
        [String(userId)]
      );

      await writeAuditLog(client, {
        action: "USER_CREATE",
        entity_type: "user",
        entity_id: userId,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: {
          username,
          role,
          is_active: isActive,
          custom_role_id: customRoleId,
        },
      });

      await client.query("COMMIT");
      return res.status(201).json(mapUserAccessRow(createdUserRes.rows[0]));
    } catch (err) {
      await client.query("ROLLBACK");
      if (String(err?.code) === "23505") {
        return res.status(409).json({ message: "Username already exists" });
      }
      console.error("Failed to create user:", err);
      return res.status(500).json({ message: "Failed to create user" });
    } finally {
      client.release();
    }
  }
);

router.put(
  "/users/:id",
  auth,
  authorize("ADMIN"),
  authorizePermissions("users.manage"),
  async (req, res) => {
    const userId = normalizeUserId(req.params.id);
    if (!userId) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const hasUsername = Object.prototype.hasOwnProperty.call(body, "username");
    const hasRole = Object.prototype.hasOwnProperty.call(body, "role");
    const hasActive = Object.prototype.hasOwnProperty.call(body, "is_active");
    const hasCustomRole = Object.prototype.hasOwnProperty.call(body, "custom_role_id");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await fetchUserSecurityContext(client, req.user.id, false);
      if (!actor) {
        await client.query("ROLLBACK");
        return res.status(401).json({ message: "Invalid user context" });
      }
      const current = await fetchUserSecurityContext(client, userId, true);
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "User not found" });
      }
      const actorIsSuperAdmin = actor.is_super_admin === true;
      const targetIsSuperAdmin = current.is_super_admin === true;
      if (targetIsSuperAdmin && !actorIsSuperAdmin) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          message: "Only Super Admin can modify Super Admin credentials",
        });
      }

      const nextRole = hasRole
        ? normalizeBaseRole(body.role, null)
        : String(current.role || "").toUpperCase();
      if (!nextRole) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "role must be ADMIN or CASHIER" });
      }

      const nextUsername = hasUsername ? normalizeUsername(body.username) : current.username;
      if (hasUsername && !nextUsername) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message:
            "username must be 3-50 characters (letters, numbers, ., _, -)",
        });
      }
      if (
        hasUsername &&
        String(nextUsername || "").toLowerCase() !==
          String(current.username || "").toLowerCase()
      ) {
        const duplicateUserRes = await client.query(
          `SELECT id::text AS id
           FROM users
           WHERE LOWER(username) = LOWER($1)
             AND id::text <> $2
           LIMIT 1`,
          [nextUsername, current.id]
        );
        if (duplicateUserRes.rows[0]) {
          await client.query("ROLLBACK");
          return res.status(409).json({ message: "Username already exists" });
        }
      }

      const nextIsActive = hasActive ? body.is_active !== false : current.is_active !== false;
      if (String(req.user.id) === String(current.id) && !nextIsActive) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "You cannot deactivate your own account" });
      }
      if (String(req.user.id) === String(current.id) && nextRole !== "ADMIN") {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: "You cannot remove your own admin access" });
      }
      if (targetIsSuperAdmin && nextRole !== "ADMIN") {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Super Admin role cannot be changed" });
      }
      if (targetIsSuperAdmin && !nextIsActive) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Super Admin cannot be deactivated" });
      }

      let nextCustomRoleId = current.custom_role_id
        ? Number(current.custom_role_id)
        : null;
      if (targetIsSuperAdmin) {
        nextCustomRoleId = await resolveSystemRoleIdByName(client, "Super Admin", "ADMIN");
      } else if (hasCustomRole || hasRole) {
        const parsedCustomRole = hasCustomRole
          ? parseOptionalRoleId(body.custom_role_id)
          : parseOptionalRoleId(current.custom_role_id);
        if (Number.isNaN(parsedCustomRole)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "custom_role_id is invalid" });
        }

        if (Number.isFinite(parsedCustomRole)) {
          const roleValidation = await resolveAssignableRole(
            client,
            parsedCustomRole,
            nextRole
          );
          if (roleValidation?.error) {
            await client.query("ROLLBACK");
            return res.status(roleValidation.status).json({ message: roleValidation.error });
          }
          nextCustomRoleId = roleValidation.id;
        } else {
          nextCustomRoleId = await resolveDefaultSystemRoleId(client, nextRole);
        }
      }

      await client.query(
        `UPDATE users
         SET username = $2,
             role = $3,
             "isActive" = $4,
             custom_role_id = $5
         WHERE id::text = $1`,
        [userId, nextUsername, nextRole, nextIsActive, nextCustomRoleId]
      );

      const updatedUserRes = await client.query(
        `SELECT
           u.id::text AS id,
           u.username,
           u.role,
           u."isActive" AS is_active,
           COALESCE(u.is_super_admin, FALSE) AS is_super_admin,
           u.custom_role_id,
           ar.name AS custom_role_name,
           ar.is_active AS custom_role_is_active,
           COALESCE(
             ARRAY_AGG(DISTINCT arp.permission_key) FILTER (WHERE arp.permission_key IS NOT NULL),
             ARRAY[]::text[]
           ) AS custom_permissions
         FROM users u
         LEFT JOIN access_roles ar ON ar.id = u.custom_role_id
         LEFT JOIN access_role_permissions arp ON arp.role_id = ar.id
         WHERE u.id::text = $1
         GROUP BY
           u.id,
           u.username,
           u.role,
           u."isActive",
           u.is_super_admin,
           u.custom_role_id,
           ar.name,
           ar.is_active`,
        [userId]
      );

      await writeAuditLog(client, {
        action: "USER_UPDATE",
        entity_type: "user",
        entity_id: userId,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: {
          username: nextUsername,
          role: nextRole,
          is_active: nextIsActive,
          custom_role_id: nextCustomRoleId,
        },
      });

      await client.query("COMMIT");
      return res.json(mapUserAccessRow(updatedUserRes.rows[0]));
    } catch (err) {
      await client.query("ROLLBACK");
      if (String(err?.code) === "23505") {
        return res.status(409).json({ message: "Username already exists" });
      }
      console.error("Failed to update user:", err);
      return res.status(500).json({ message: "Failed to update user" });
    } finally {
      client.release();
    }
  }
);

router.post(
  "/users/:id/reset-password",
  auth,
  authorize("ADMIN"),
  authorizePermissions("users.manage"),
  async (req, res) => {
    const userId = normalizeUserId(req.params.id);
    const password = String(req.body?.password || req.body?.new_password || "");
    const confirm = String(req.body?.confirm_password || "");

    if (!userId) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "password must be at least 6 characters" });
    }
    if (confirm && confirm !== password) {
      return res.status(400).json({ message: "confirm_password does not match" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await fetchUserSecurityContext(client, req.user.id, false);
      if (!actor) {
        await client.query("ROLLBACK");
        return res.status(401).json({ message: "Invalid user context" });
      }
      const existing = await fetchUserSecurityContext(client, userId, true);
      if (!existing) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "User not found" });
      }
      if (existing.is_super_admin === true && actor.is_super_admin !== true) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          message: "Only Super Admin can reset Super Admin credentials",
        });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await client.query(
        `UPDATE users
         SET "passwordHash" = $2
         WHERE id::text = $1`,
        [userId, passwordHash]
      );

      await writeAuditLog(client, {
        action: "USER_PASSWORD_RESET",
        entity_type: "user",
        entity_id: userId,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: { username: existing.username },
      });

      await client.query("COMMIT");
      return res.json({ message: "Password reset successfully" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Failed to reset user password:", err);
      return res.status(500).json({ message: "Failed to reset password" });
    } finally {
      client.release();
    }
  }
);

router.delete(
  "/users/:id",
  auth,
  authorize("ADMIN"),
  authorizePermissions("users.manage"),
  async (req, res) => {
    const userId = normalizeUserId(req.params.id);
    if (!userId) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await fetchUserSecurityContext(client, req.user.id, false);
      if (!actor) {
        await client.query("ROLLBACK");
        return res.status(401).json({ message: "Invalid user context" });
      }
      const target = await fetchUserSecurityContext(client, userId, true);
      if (!target) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "User not found" });
      }
      if (String(actor.id) === String(target.id)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "You cannot delete your own account" });
      }
      if (target.is_super_admin === true) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Super Admin cannot be deleted" });
      }

      await client.query(`DELETE FROM branch_users WHERE user_id = $1`, [target.id]);
      await client.query(
        `UPDATE employees
         SET user_id = NULL,
             updated_at = NOW()
         WHERE user_id = $1`,
        [target.id]
      );
      await client.query(
        `DELETE FROM users
         WHERE id::text = $1`,
        [target.id]
      );

      await writeAuditLog(client, {
        action: "USER_DELETE",
        entity_type: "user",
        entity_id: target.id,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: {
          username: target.username,
          role: target.role,
        },
      });

      await client.query("COMMIT");
      return res.json({ message: "User deleted successfully" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Failed to delete user:", err);
      return res.status(500).json({ message: "Failed to delete user" });
    } finally {
      client.release();
    }
  }
);

// Shift management
router.get("/shifts/current", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const branchId = parseBranchId(req.query.branch_id, 1);
    const { rows } = await pool.query(
      `SELECT *
       FROM cash_shifts
       WHERE status = 'OPEN'
         AND COALESCE(branch_id, 1) = $1
       ORDER BY opened_at DESC
       LIMIT 1`,
      [branchId]
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
    const branchId = await resolveActiveBranchId(client, req.body?.branch_id);
    const existing = await client.query(
      `SELECT id
       FROM cash_shifts
       WHERE status = 'OPEN'
         AND COALESCE(branch_id, 1) = $1
       LIMIT 1
       FOR UPDATE`,
      [branchId]
    );
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "An open shift already exists for this branch" });
    }

    const { rows } = await client.query(
      `INSERT INTO cash_shifts (opened_by, opening_cash, note, status, branch_id)
       VALUES ($1, $2, $3, 'OPEN', $4)
       RETURNING *`,
      [String(req.user.id), openingCash, note, branchId]
    );

    await writeAuditLog(client, {
      action: "SHIFT_OPEN",
      entity_type: "cash_shift",
      entity_id: rows[0].id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: { opening_cash: openingCash, note, branch_id: branchId },
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
          AND status <> 'VOIDED'
          AND COALESCE(branch_id, 1) = $2`,
      [shift.opened_at, Number(shift.branch_id || 1)]
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
        branch_id: Number(shift.branch_id || 1),
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
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const hasBranchFilter = Number.isFinite(branchId);
    const { rows } = await pool.query(
      `SELECT id, title, category, description, amount, incurred_at, created_by, branch_id, created_at
       FROM expenses
       WHERE incurred_at >= DATE_TRUNC('day', NOW()) - (($1::int - 1) * INTERVAL '1 day')
         AND incurred_at < NOW()
         ${hasBranchFilter ? "AND COALESCE(branch_id, 1) = $2" : ""}
       ORDER BY incurred_at DESC
       LIMIT $${hasBranchFilter ? 3 : 2}`,
      hasBranchFilter ? [days, branchId, limit] : [days, limit]
    );
    return res.json(
      rows.map((row) => ({
        ...row,
        amount: parseFloat(row.amount || 0),
        branch_id: row.branch_id ? Number(row.branch_id) : null,
      }))
    );
  } catch (err) {
    console.error("Failed to fetch expenses:", err);
    return res.status(500).json({ message: "Failed to fetch expenses" });
  }
});

router.post("/expenses", auth, authorize("ADMIN"), async (req, res) => {
  const category = String(req.body?.category || "").trim().slice(0, 80);
  const title = String(req.body?.title || category || "").trim().slice(0, 120);
  const description = req.body?.description
    ? String(req.body.description).trim().slice(0, 500)
    : null;
  const amount = parseMoney(req.body?.amount, NaN);
  const incurredAt = req.body?.incurred_at || null;
  const branchIdRaw = parsePositiveInt(req.body?.branch_id, NaN, 1, 1_000_000);

  if (!category) {
    return res.status(400).json({ message: "category is required" });
  }
  if (!title) {
    return res.status(400).json({ message: "title is required" });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ message: "amount must be a positive number" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const branchId = await resolveActiveBranchId(client, branchIdRaw);
    const { rows } = await client.query(
      `INSERT INTO expenses (title, category, description, amount, incurred_at, created_by, branch_id)
       VALUES ($1, $2, $3, $4, COALESCE($5, NOW()), $6, $7)
       RETURNING *`,
      [title, category, description, amount, incurredAt, String(req.user.id), branchId]
    );

    await writeAuditLog(client, {
      action: "EXPENSE_CREATE",
      entity_type: "expense",
      entity_id: rows[0].id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        category,
        amount,
        incurred_at: rows[0].incurred_at,
        branch_id: branchId,
      },
    });

    await client.query("COMMIT");
    return res.status(201).json({
      ...rows[0],
      amount: parseFloat(rows[0].amount || 0),
      branch_id: rows[0].branch_id ? Number(rows[0].branch_id) : branchId,
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
router.get("/backup/csv", auth, authorize("ADMIN"), async (req, res) => {
  const client = await pool.connect();
  try {
    const { csv, totalRows } = await buildBackupCsv(client);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `camellia-backup-${timestamp}.csv`;

    await writeAuditLog(client, {
      action: "BACKUP_CSV_EXPORT",
      entity_type: "backup",
      entity_id: fileName,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: { rows: totalRows },
    });

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
      await writeAuditLog(client, {
        action: "BACKUP_CSV_RESTORE",
        entity_type: "backup_restore",
        entity_id: null,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: {
          restored_rows: restoredRows,
          truncated_tables: truncatedTables,
        },
      });
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

router.get("/backup/jobs", auth, authorize("ADMIN"), async (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 100, 1, 500);
  try {
    const { rows } = await pool.query(
      `SELECT id, trigger_source, status, backup_path, details, created_at
       FROM backup_jobs
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Failed to fetch backup jobs:", err);
    return res.status(500).json({ message: "Failed to fetch backup jobs" });
  }
});

router.post("/backup/validate", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const result = await runBackupValidationJob({
      triggerSource: "MANUAL_API",
      actorId: req.user?.id ? String(req.user.id) : null,
      actorRole: req.user?.role ? String(req.user.role) : null,
    });
    if (String(result?.status || "").toUpperCase() !== "SUCCESS") {
      return res.status(500).json({
        message: "Backup validation failed",
        job: result,
      });
    }
    return res.status(201).json(result);
  } catch (err) {
    console.error("Failed to run backup validation job:", err);
    return res.status(500).json({ message: "Failed to run backup validation job" });
  }
});

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
    const userCountBeforeRes = await client.query(
      `SELECT COUNT(*)::int AS total
       FROM users`
    );
    const preservedUserCount = Number(userCountBeforeRes.rows[0]?.total || 0);
    const truncatedTables = await truncateBusinessTables(client);
    await writeAuditLog(client, {
      action: "SYSTEM_RESET",
      entity_type: "system",
      entity_id: null,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        truncated_tables: truncatedTables,
        preserved_users: preservedUserCount,
      },
    });
    await client.query("COMMIT");
    return res.json({
      message:
        "System reset completed successfully. User/admin credentials were preserved.",
      truncatedTables,
      preserved: {
        users: preservedUserCount,
        credentials: true,
      },
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
