import fs from "fs/promises";
import path from "path";
import pool from "../db.js";

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

function normalizeBranchId(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "";
  }
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    const raw = String(value ?? "");
    return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => escape(row[header])).join(","));
  }
  return lines.join("\n");
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

async function buildReportRows(reportType, filters = {}) {
  const type = String(reportType || "").trim().toUpperCase();
  const days = parsePositiveInt(filters.days, 30, 1, 3650);
  const branchId = normalizeBranchId(filters.branch_id);

  if (type === "SALES") {
    const { rows } = await pool.query(
      `SELECT
         id,
         created_at,
         order_type,
         payment_method,
         total,
         refunded_amount,
         status,
         customer_name,
         customer_phone,
         branch_id
       FROM orders
       WHERE created_at >= NOW() - (($1::text || ' days')::interval)
         ${branchId ? "AND COALESCE(branch_id, 1) = $2" : ""}
       ORDER BY created_at DESC
       LIMIT 5000`,
      branchId ? [days, branchId] : [days]
    );
    return rows.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      order_type: row.order_type,
      payment_method: row.payment_method,
      total: parseMoney(row.total, 0),
      refunded_amount: parseMoney(row.refunded_amount, 0),
      status: row.status,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      branch_id: row.branch_id,
    }));
  }

  if (type === "PRODUCTS") {
    const { rows } = await pool.query(
      `SELECT
         p.id::text AS product_id,
         p.name,
         p.category,
         COALESCE(SUM(oi.qty), 0) AS qty_sold,
         COALESCE(SUM(oi.qty * oi.price), 0) AS gross_revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE o.created_at >= NOW() - (($1::text || ' days')::interval)
         AND COALESCE(o.status, 'COMPLETED') <> 'VOIDED'
         ${branchId ? "AND COALESCE(o.branch_id, 1) = $2" : ""}
       GROUP BY p.id, p.name, p.category
       ORDER BY gross_revenue DESC, qty_sold DESC
       LIMIT 5000`,
      branchId ? [days, branchId] : [days]
    );
    return rows.map((row) => ({
      product_id: row.product_id,
      name: row.name,
      category: row.category,
      qty_sold: parseMoney(row.qty_sold, 0),
      gross_revenue: parseMoney(row.gross_revenue, 0),
    }));
  }

  if (type === "PAYMENT") {
    const { rows } = await pool.query(
      `SELECT
         payment_method,
         COUNT(*)::int AS orders,
         COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0) AS net_sales
       FROM orders
       WHERE created_at >= NOW() - (($1::text || ' days')::interval)
         AND COALESCE(status, 'COMPLETED') <> 'VOIDED'
         ${branchId ? "AND COALESCE(branch_id, 1) = $2" : ""}
       GROUP BY payment_method
       ORDER BY net_sales DESC`,
      branchId ? [days, branchId] : [days]
    );
    return rows.map((row) => ({
      payment_method: row.payment_method || "UNKNOWN",
      orders: parseInt(row.orders || 0, 10),
      net_sales: parseMoney(row.net_sales, 0),
    }));
  }

  if (type === "PROFIT") {
    const salesRes = await pool.query(
      `SELECT
         COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0) AS net_sales
       FROM orders
       WHERE created_at >= NOW() - (($1::text || ' days')::interval)
         AND COALESCE(status, 'COMPLETED') <> 'VOIDED'
         ${branchId ? "AND COALESCE(branch_id, 1) = $2" : ""}`,
      branchId ? [days, branchId] : [days]
    );

    const expenseRes = await pool.query(
      `SELECT
         category,
         description,
         amount,
         incurred_at,
         branch_id
       FROM expenses
       WHERE incurred_at >= NOW() - (($1::text || ' days')::interval)
         ${branchId ? "AND COALESCE(branch_id, 1) = $2" : ""}
       ORDER BY incurred_at DESC
       LIMIT 5000`,
      branchId ? [days, branchId] : [days]
    );

    const netSales = parseMoney(salesRes.rows[0]?.net_sales, 0);
    const totalExpenses = expenseRes.rows.reduce(
      (sum, row) => sum + parseMoney(row.amount, 0),
      0
    );

    return [
      {
        metric: "net_sales",
        value: netSales,
      },
      {
        metric: "total_expenses",
        value: parseMoney(totalExpenses, 0),
      },
      {
        metric: "estimated_profit",
        value: parseMoney(netSales - totalExpenses, 0),
      },
      ...expenseRes.rows.map((row) => ({
        metric: "expense",
        category: row.category,
        description: row.description,
        amount: parseMoney(row.amount, 0),
        incurred_at: row.incurred_at,
        branch_id: row.branch_id,
      })),
    ];
  }

  if (type === "INVENTORY") {
    const { rows } = await pool.query(
      `SELECT
         ii.id::text AS inventory_item_id,
         ii.name,
         ii.category,
         ii.unit,
         COALESCE(ii.current_stock, 0) AS current_stock,
         COALESCE(ii.min_stock, 0) AS min_stock,
         ii.expiry_date
       FROM inventory_items ii
       WHERE ii."isActive" = TRUE
       ORDER BY ii.name ASC
       LIMIT 5000`
    );

    return rows.map((row) => {
      const current = parseMoney(row.current_stock, 0);
      const minStock = parseMoney(row.min_stock, 0);
      let status = "IN_STOCK";
      if (current <= 0) {
        status = "OUT_OF_STOCK";
      } else if (current <= minStock) {
        status = "LOW_STOCK";
      }
      return {
        inventory_item_id: row.inventory_item_id,
        name: row.name,
        category: row.category,
        unit: row.unit,
        current_stock: current,
        min_stock: minStock,
        expiry_date: row.expiry_date,
        stock_status: status,
      };
    });
  }

  if (type === "FORECAST") {
    const { rows } = await pool.query(
      `SELECT
         DATE(created_at) AS day,
         COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE created_at >= CURRENT_DATE - (($1::text || ' days')::interval)
         ${branchId ? "AND COALESCE(branch_id, 1) = $2" : ""}
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      branchId ? [days, branchId] : [days]
    );
    return rows.map((row) => ({
      day: row.day,
      total: parseMoney(row.total, 0),
    }));
  }

  if (type === "CUSTOMERS") {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(NULLIF(o.customer_id, ''), NULLIF(o.customer_phone, ''), NULLIF(o.customer_name, ''), CONCAT('ORDER_', o.id::text)) AS customer_key,
         MAX(o.customer_id) AS customer_id,
         MAX(o.customer_name) AS customer_name,
         MAX(o.customer_phone) AS customer_phone,
         COUNT(*)::int AS order_count,
         COALESCE(SUM(COALESCE(o.total, 0) - COALESCE(o.refunded_amount, 0)), 0) AS net_spend,
         MAX(o.created_at) AS last_order_at
       FROM orders o
       WHERE o.created_at >= NOW() - (($1::text || ' days')::interval)
         AND COALESCE(o.status, 'COMPLETED') <> 'VOIDED'
         ${branchId ? "AND COALESCE(o.branch_id, 1) = $2" : ""}
         AND (
           NULLIF(o.customer_id, '') IS NOT NULL
           OR NULLIF(o.customer_phone, '') IS NOT NULL
           OR NULLIF(o.customer_name, '') IS NOT NULL
         )
       GROUP BY COALESCE(NULLIF(o.customer_id, ''), NULLIF(o.customer_phone, ''), NULLIF(o.customer_name, ''), CONCAT('ORDER_', o.id::text))
       ORDER BY net_spend DESC
       LIMIT 5000`,
      branchId ? [days, branchId] : [days]
    );
    return rows.map((row) => ({
      customer_key: row.customer_key,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      order_count: parseInt(row.order_count || 0, 10),
      net_spend: parseMoney(row.net_spend, 0),
      last_order_at: row.last_order_at,
    }));
  }

  const rawFilters = filters && typeof filters === "object" ? JSON.stringify(filters) : "{}";
  return [
    {
      report_type: type || "UNKNOWN",
      message: "Unsupported report type for worker export",
      filters: rawFilters,
    },
  ];
}

async function setJobStatus(client, jobId, status, values = {}) {
  const {
    filePath = null,
    errorMessage = null,
    actorId = null,
  } = values;

  const { rows } = await client.query(
    `UPDATE report_export_jobs
     SET status = $2,
         file_path = CASE WHEN $3::text IS NULL THEN file_path ELSE $3 END,
         error_message = $4,
         generated_at = CASE WHEN $2 = 'SUCCESS' THEN NOW() ELSE generated_at END,
         generated_by = COALESCE($5, generated_by),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [jobId, status, filePath, errorMessage, actorId]
  );
  return rows[0] || null;
}

async function claimNextQueuedJob(actorId = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `WITH next_job AS (
         SELECT id
         FROM report_export_jobs
         WHERE status = 'QUEUED'
           AND scheduled_for <= NOW()
         ORDER BY scheduled_for ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE report_export_jobs j
       SET status = 'PROCESSING',
           generated_by = COALESCE($1, j.generated_by),
           updated_at = NOW()
       FROM next_job
       WHERE j.id = next_job.id
       RETURNING j.*`,
      [actorId]
    );
    await client.query("COMMIT");
    return rows[0] || null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function processClaimedJob(job) {
  const jobId = Number(job?.id);
  if (!Number.isFinite(jobId)) {
    return null;
  }

  const actorId = job?.generated_by ? String(job.generated_by) : null;
  const filters =
    job?.filters && typeof job.filters === "object" && !Array.isArray(job.filters)
      ? job.filters
      : {};

  const outputDir = String(
    process.env.REPORT_EXPORT_OUTPUT_DIR || process.env.BACKUP_OUTPUT_DIR || ""
  ).trim();

  const client = await pool.connect();
  try {
    const rows = await buildReportRows(job.report_type, filters);
    const csv = toCsv(rows);
    let filePath = null;

    if (outputDir) {
      await fs.mkdir(outputDir, { recursive: true });
      const safeType = String(job.report_type || "report")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .slice(0, 60);
      const fileName = `report-export-${jobId}-${safeType}-${Date.now()}.csv`;
      filePath = path.join(outputDir, fileName);
      await fs.writeFile(filePath, csv, "utf8");
    }

    await client.query("BEGIN");
    const updated = await setJobStatus(client, jobId, "SUCCESS", {
      filePath,
      errorMessage: null,
      actorId,
    });
    await writeAuditLog(client, {
      action: "REPORT_EXPORT_JOB_SUCCESS",
      entity_type: "report_export_job",
      entity_id: jobId,
      actor_id: actorId,
      actor_role: "SYSTEM",
      payload: {
        report_type: job.report_type,
        rows: rows.length,
        file_path: filePath,
      },
    });
    await client.query("COMMIT");
    return updated;
  } catch (err) {
    try {
      await client.query("BEGIN");
      const updated = await setJobStatus(client, jobId, "FAILED", {
        errorMessage: String(err?.message || err).slice(0, 2000),
        actorId,
      });
      await writeAuditLog(client, {
        action: "REPORT_EXPORT_JOB_FAILED",
        entity_type: "report_export_job",
        entity_id: jobId,
        actor_id: actorId,
        actor_role: "SYSTEM",
        payload: {
          report_type: job?.report_type,
          error: String(err?.message || err),
        },
      });
      await client.query("COMMIT");
      return updated;
    } catch (rollbackErr) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      console.error("Failed to mark report export job as FAILED:", rollbackErr);
      return null;
    }
  } finally {
    client.release();
  }
}

export async function processOneDueReportExportJob() {
  try {
    const job = await claimNextQueuedJob("SYSTEM_WORKER");
    if (!job) {
      return null;
    }
    return await processClaimedJob(job);
  } catch (err) {
    console.error("Report export worker failed to claim/process job:", err);
    return null;
  }
}

export function startReportExportScheduler() {
  const enabled =
    String(process.env.REPORT_EXPORT_SCHEDULER_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    return () => {};
  }

  const tickMs = Math.max(
    10_000,
    Number.parseInt(process.env.REPORT_EXPORT_TICK_MS || "30000", 10) || 30_000
  );
  const batchSize = Math.max(
    1,
    Number.parseInt(process.env.REPORT_EXPORT_BATCH_SIZE || "3", 10) || 3
  );

  let running = false;

  const runBatch = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      for (let i = 0; i < batchSize; i += 1) {
        const result = await processOneDueReportExportJob();
        if (!result) {
          break;
        }
      }
    } catch (err) {
      console.error("Report export scheduler batch failed:", err);
    } finally {
      running = false;
    }
  };

  if (String(process.env.REPORT_EXPORT_RUN_ON_START || "true").toLowerCase() === "true") {
    void runBatch();
  }

  const timer = setInterval(() => {
    void runBatch();
  }, tickMs);

  return () => clearInterval(timer);
}