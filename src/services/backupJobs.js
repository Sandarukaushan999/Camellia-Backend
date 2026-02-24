import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import pool from "../db.js";

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
  "orders",
  "order_items",
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

async function buildBackupCsv(client) {
  const existingTables = await getExistingTables(client, BACKUP_TABLES);
  const lines = ["table,id,data_base64"];
  const includedTables = [];
  let totalRows = 0;

  for (const tableName of BACKUP_TABLES) {
    if (!existingTables.has(tableName)) {
      continue;
    }
    includedTables.push(tableName);
    const { rows } = await client.query(
      `SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY 1 ASC`
    );
    rows.forEach((row, index) => {
      const encoded = Buffer.from(JSON.stringify(row), "utf8").toString("base64");
      lines.push(`${tableName},${index + 1},${encoded}`);
      totalRows += 1;
    });
  }

  return {
    csv: lines.join("\n"),
    totalRows,
    includedTables,
  };
}

function validateBackupCsv(rawContent) {
  const lines = String(rawContent || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error("Backup file is empty");
  }
  if (lines[0] !== "table,id,data_base64") {
    throw new Error("Invalid backup header");
  }

  let decodedRows = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const [tableName, _rowNumber, encoded] = lines[i].split(",", 3);
    if (!tableName || !encoded) {
      throw new Error(`Malformed backup row at line ${i + 1}`);
    }
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    JSON.parse(decoded);
    decodedRows += 1;
  }
  return decodedRows;
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

export async function runBackupValidationJob({
  triggerSource = "SCHEDULED_DAILY",
  actorId = null,
  actorRole = null,
} = {}) {
  const client = await pool.connect();
  let backupPath = null;
  try {
    await client.query("BEGIN");
    const { csv, totalRows, includedTables } = await buildBackupCsv(client);
    const decodedRows = validateBackupCsv(csv);
    if (decodedRows !== totalRows) {
      throw new Error(
        `Backup validation mismatch: expected ${totalRows}, decoded ${decodedRows}`
      );
    }

    const backupOutputDir = String(process.env.BACKUP_OUTPUT_DIR || "").trim();
    if (backupOutputDir) {
      await fs.mkdir(backupOutputDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = `camellia-scheduled-backup-${timestamp}.csv`;
      backupPath = path.join(backupOutputDir, fileName);
      await fs.writeFile(backupPath, csv, "utf8");
    }

    const checksum = crypto.createHash("sha256").update(csv).digest("hex");
    const details = {
      rows: totalRows,
      decoded_rows: decodedRows,
      table_count: includedTables.length,
      tables: includedTables,
      checksum_sha256: checksum,
      file_size_bytes: Buffer.byteLength(csv, "utf8"),
    };

    const backupJobRes = await client.query(
      `INSERT INTO backup_jobs (trigger_source, status, backup_path, details)
       VALUES ($1, 'SUCCESS', $2, $3::jsonb)
       RETURNING id, trigger_source, status, backup_path, details, created_at`,
      [String(triggerSource || "MANUAL").slice(0, 40), backupPath, JSON.stringify(details)]
    );
    const backupJob = backupJobRes.rows[0];

    await writeAuditLog(client, {
      action: "BACKUP_VALIDATE_SUCCESS",
      entity_type: "backup_job",
      entity_id: backupJob.id,
      actor_id: actorId,
      actor_role: actorRole,
      payload: {
        trigger_source: backupJob.trigger_source,
        rows: totalRows,
        table_count: includedTables.length,
        backup_path: backupPath,
      },
    });

    await client.query("COMMIT");
    return backupJob;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures
    }

    const details = {
      error: String(err?.message || err),
      backup_path: backupPath,
    };
    const failedRes = await pool.query(
      `INSERT INTO backup_jobs (trigger_source, status, backup_path, details)
       VALUES ($1, 'FAILED', $2, $3::jsonb)
       RETURNING id, trigger_source, status, backup_path, details, created_at`,
      [String(triggerSource || "MANUAL").slice(0, 40), backupPath, JSON.stringify(details)]
    );
    const backupJob = failedRes.rows[0];
    await writeAuditLog(pool, {
      action: "BACKUP_VALIDATE_FAILED",
      entity_type: "backup_job",
      entity_id: backupJob.id,
      actor_id: actorId,
      actor_role: actorRole,
      payload: details,
    });
    return backupJob;
  } finally {
    client.release();
  }
}

export function startDailyBackupScheduler() {
  const enabled =
    String(process.env.BACKUP_DAILY_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    return () => {};
  }

  const hourUtc = Math.max(
    0,
    Math.min(23, Number.parseInt(process.env.BACKUP_DAILY_HOUR_UTC || "2", 10) || 2)
  );
  const minuteUtc = Math.max(
    0,
    Math.min(
      59,
      Number.parseInt(process.env.BACKUP_DAILY_MINUTE_UTC || "15", 10) || 15
    )
  );
  const tickMs = Math.max(
    30_000,
    Number.parseInt(process.env.BACKUP_DAILY_TICK_MS || "60000", 10) || 60_000
  );

  let lastRunDateKey = "";
  let running = false;

  const runIfDue = async () => {
    if (running) {
      return;
    }
    const now = new Date();
    const dateKey = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
    ].join("-");

    if (now.getUTCHours() !== hourUtc || now.getUTCMinutes() < minuteUtc) {
      return;
    }
    if (lastRunDateKey === dateKey) {
      return;
    }

    running = true;
    try {
      const result = await runBackupValidationJob({
        triggerSource: "SCHEDULED_DAILY",
      });
      if (String(result?.status || "").toUpperCase() === "SUCCESS") {
        lastRunDateKey = dateKey;
      }
    } catch (err) {
      // continue scheduler loop even if a run fails unexpectedly
      console.error("Scheduled backup validation failed:", err);
    } finally {
      running = false;
    }
  };

  if (String(process.env.BACKUP_RUN_ON_START || "").toLowerCase() === "true") {
    void runBackupValidationJob({ triggerSource: "STARTUP" });
  }

  void runIfDue();
  const timer = setInterval(() => {
    void runIfDue();
  }, tickMs);

  return () => clearInterval(timer);
}
