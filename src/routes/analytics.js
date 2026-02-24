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

function toDateKey(date) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

router.get("/forecast/sales", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 60, 14, 3650);
    const horizon = parsePositiveInt(req.query.horizon, 14, 1, 180);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const saveSnapshot = String(req.query.save || "").toLowerCase() === "true";
    const hasBranchFilter = Number.isFinite(branchId);

    const rows = (
      await pool.query(
        `SELECT
           DATE(created_at) AS day,
           COALESCE(SUM(total), 0) AS total
         FROM orders
         WHERE created_at >= CURRENT_DATE - (($1::text || ' days')::interval)
           ${hasBranchFilter ? "AND COALESCE(branch_id, 1) = $2" : ""}
         GROUP BY DATE(created_at)
         ORDER BY day ASC`,
        hasBranchFilter ? [days, branchId] : [days]
      )
    ).rows;

    const dailyMap = new Map(
      rows.map((row) => [String(row.day).slice(0, 10), parseFloat(row.total || 0)])
    );

    const today = new Date();
    const history = [];
    const weekdayBuckets = new Map();
    let sumTotal = 0;
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      d.setUTCDate(d.getUTCDate() - i);
      const key = toDateKey(d);
      const value = dailyMap.get(key) || 0;
      history.push({ day: key, total: value });
      sumTotal += value;
      const weekday = d.getUTCDay();
      const bucket = weekdayBuckets.get(weekday) || { sum: 0, count: 0 };
      bucket.sum += value;
      bucket.count += 1;
      weekdayBuckets.set(weekday, bucket);
    }

    const globalAvg = days > 0 ? sumTotal / days : 0;
    const forecast = [];
    for (let i = 1; i <= horizon; i += 1) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      d.setUTCDate(d.getUTCDate() + i);
      const weekday = d.getUTCDay();
      const bucket = weekdayBuckets.get(weekday);
      const predicted =
        bucket && bucket.count > 0 ? bucket.sum / bucket.count : globalAvg;
      forecast.push({
        day: toDateKey(d),
        predicted_total: Math.round(predicted * 100) / 100,
      });
    }

    let snapshotId = null;
    if (saveSnapshot) {
      const snapshotRes = await pool.query(
        `INSERT INTO forecast_snapshots (model, branch_id, horizon_days, payload, generated_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id`,
        [
          "weekday-average-v1",
          hasBranchFilter ? branchId : null,
          horizon,
          JSON.stringify({ days, history, forecast }),
          String(req.user?.id || ""),
        ]
      );
      snapshotId = snapshotRes.rows[0]?.id || null;
    }

    return res.json({
      model: "weekday-average-v1",
      branch_id: hasBranchFilter ? branchId : null,
      history_days: days,
      horizon_days: horizon,
      average_daily_sales: Math.round(globalAvg * 100) / 100,
      history,
      forecast,
      snapshot_id: snapshotId,
    });
  } catch (err) {
    console.error("Failed to generate sales forecast:", err);
    return res.status(500).json({ message: "Failed to generate sales forecast" });
  }
});

router.get("/report-templates", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const module = req.query?.module
      ? String(req.query.module).trim().slice(0, 60)
      : null;
    const { rows } = await pool.query(
      `SELECT id, name, module, config, is_default, created_by, created_at, updated_at
       FROM report_templates
       WHERE ($1::text IS NULL OR module = $1)
       ORDER BY is_default DESC, updated_at DESC`,
      [module]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Failed to fetch report templates:", err);
    return res.status(500).json({ message: "Failed to fetch report templates" });
  }
});

router.post("/report-templates", auth, authorize("ADMIN"), async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 120);
  const module = String(req.body?.module || "").trim().slice(0, 60);
  const config =
    req.body?.config && typeof req.body.config === "object" && !Array.isArray(req.body.config)
      ? req.body.config
      : {};
  const isDefault = req.body?.is_default === true;

  if (!name || !module) {
    return res.status(400).json({ message: "name and module are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isDefault) {
      await client.query(
        `UPDATE report_templates
         SET is_default = FALSE
         WHERE module = $1`,
        [module]
      );
    }
    const insertRes = await client.query(
      `INSERT INTO report_templates (name, module, config, is_default, created_by, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, NOW(), NOW())
       RETURNING *`,
      [name, module, JSON.stringify(config), isDefault, String(req.user.id)]
    );
    const template = insertRes.rows[0];

    await writeAuditLog(client, {
      action: "REPORT_TEMPLATE_CREATE",
      entity_type: "report_template",
      entity_id: template.id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: { module, is_default: isDefault },
    });

    await client.query("COMMIT");
    return res.status(201).json(template);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to create report template:", err);
    return res.status(500).json({ message: "Failed to create report template" });
  } finally {
    client.release();
  }
});

router.put("/report-templates/:id", auth, authorize("ADMIN"), async (req, res) => {
  const id = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "Invalid template id" });
  }

  const name = req.body?.name ? String(req.body.name).trim().slice(0, 120) : null;
  const module = req.body?.module ? String(req.body.module).trim().slice(0, 60) : null;
  const hasConfig = Object.prototype.hasOwnProperty.call(req.body || {}, "config");
  const config =
    hasConfig && req.body?.config && typeof req.body.config === "object" && !Array.isArray(req.body.config)
      ? req.body.config
      : null;
  const isDefault = Object.prototype.hasOwnProperty.call(req.body || {}, "is_default")
    ? req.body?.is_default === true
    : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingRes = await client.query(
      `SELECT id, module
       FROM report_templates
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Template not found" });
    }
    const nextModule = module || existing.module;

    if (isDefault === true) {
      await client.query(
        `UPDATE report_templates
         SET is_default = FALSE
         WHERE module = $1
           AND id <> $2`,
        [nextModule, id]
      );
    }

    const updateRes = await client.query(
      `UPDATE report_templates
       SET name = COALESCE($2, name),
           module = COALESCE($3, module),
           config = CASE WHEN $4 THEN $5::jsonb ELSE config END,
           is_default = COALESCE($6, is_default),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, name, module, hasConfig, JSON.stringify(config || {}), isDefault]
    );
    const updated = updateRes.rows[0];

    await writeAuditLog(client, {
      action: "REPORT_TEMPLATE_UPDATE",
      entity_type: "report_template",
      entity_id: id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {},
    });

    await client.query("COMMIT");
    return res.json(updated);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to update report template:", err);
    return res.status(500).json({ message: "Failed to update report template" });
  } finally {
    client.release();
  }
});

router.delete("/report-templates/:id", auth, authorize("ADMIN"), async (req, res) => {
  const id = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "Invalid template id" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deleteRes = await client.query(
      `DELETE FROM report_templates
       WHERE id = $1
       RETURNING id`,
      [id]
    );
    if (!deleteRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Template not found" });
    }

    await writeAuditLog(client, {
      action: "REPORT_TEMPLATE_DELETE",
      entity_type: "report_template",
      entity_id: id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {},
    });

    await client.query("COMMIT");
    return res.json({ message: "Template deleted" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to delete report template:", err);
    return res.status(500).json({ message: "Failed to delete report template" });
  } finally {
    client.release();
  }
});

router.get("/segments/customers", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 180, 30, 3650);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const limit = parsePositiveInt(req.query.limit, 300, 1, 2000);
    const hasBranchFilter = Number.isFinite(branchId);

    const { rows } = await pool.query(
      `SELECT
         COALESCE(NULLIF(o.customer_id, ''), NULLIF(o.customer_phone, ''), NULLIF(o.customer_name, ''), CONCAT('ORDER_', o.id::text)) AS customer_key,
         MAX(o.customer_id) AS customer_id,
         MAX(o.customer_name) AS customer_name,
         MAX(o.customer_phone) AS customer_phone,
         COUNT(*)::int AS order_count,
         COALESCE(SUM(COALESCE(o.total, 0) - COALESCE(o.refunded_amount, 0)), 0) AS net_spend,
         MIN(o.created_at) AS first_order_at,
         MAX(o.created_at) AS last_order_at
       FROM orders o
       WHERE o.created_at >= NOW() - (($1::text || ' days')::interval)
         AND COALESCE(o.status, 'COMPLETED') <> 'VOIDED'
         AND (
           NULLIF(o.customer_id, '') IS NOT NULL
           OR NULLIF(o.customer_phone, '') IS NOT NULL
           OR NULLIF(o.customer_name, '') IS NOT NULL
         )
         ${hasBranchFilter ? "AND COALESCE(o.branch_id, 1) = $2" : ""}
       GROUP BY COALESCE(NULLIF(o.customer_id, ''), NULLIF(o.customer_phone, ''), NULLIF(o.customer_name, ''), CONCAT('ORDER_', o.id::text))
       ORDER BY net_spend DESC, order_count DESC
       LIMIT $${hasBranchFilter ? 3 : 2}`,
      hasBranchFilter ? [days, branchId, limit] : [days, limit]
    );

    const now = Date.now();
    const customers = rows.map((row) => {
      const firstOrderAt = row.first_order_at ? new Date(row.first_order_at) : null;
      const lastOrderAt = row.last_order_at ? new Date(row.last_order_at) : null;
      const orderCount = parseInt(row.order_count || 0, 10);
      const netSpend = parseFloat(row.net_spend || 0);
      const daysSinceLast = lastOrderAt
        ? Math.floor((now - lastOrderAt.getTime()) / (1000 * 60 * 60 * 24))
        : null;
      const daysSinceFirst = firstOrderAt
        ? Math.floor((now - firstOrderAt.getTime()) / (1000 * 60 * 60 * 24))
        : null;

      let segment = "REGULAR";
      if ((netSpend >= 100000 && orderCount >= 10) || orderCount >= 40) {
        segment = "VIP";
      } else if (daysSinceLast !== null && daysSinceLast >= 45) {
        segment = "AT_RISK";
      } else if (daysSinceFirst !== null && daysSinceFirst <= 30 && orderCount <= 3) {
        segment = "NEW";
      } else if (orderCount >= 10 || netSpend >= 35000) {
        segment = "LOYAL";
      }

      return {
        customer_key: row.customer_key,
        customer_id: row.customer_id || null,
        customer_name: row.customer_name || null,
        customer_phone: row.customer_phone || null,
        order_count: orderCount,
        net_spend: Math.round(netSpend * 100) / 100,
        first_order_at: row.first_order_at,
        last_order_at: row.last_order_at,
        days_since_last: daysSinceLast,
        segment,
      };
    });

    const summary = customers.reduce(
      (acc, customer) => {
        acc.total_customers += 1;
        acc.total_net_spend += customer.net_spend;
        acc.segments[customer.segment] = (acc.segments[customer.segment] || 0) + 1;
        return acc;
      },
      {
        total_customers: 0,
        total_net_spend: 0,
        segments: {
          VIP: 0,
          LOYAL: 0,
          REGULAR: 0,
          NEW: 0,
          AT_RISK: 0,
        },
      }
    );
    summary.total_net_spend = Math.round(summary.total_net_spend * 100) / 100;

    return res.json({
      days,
      branch_id: hasBranchFilter ? branchId : null,
      summary,
      customers,
    });
  } catch (err) {
    console.error("Failed to build customer segments:", err);
    return res.status(500).json({ message: "Failed to build customer segments" });
  }
});

router.get("/report-exports", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 100, 1, 1000);
    const status = req.query?.status
      ? String(req.query.status).trim().toUpperCase().slice(0, 20)
      : null;
    const { rows } = await pool.query(
      `SELECT
         id,
         report_type,
         filters,
         status,
         scheduled_for,
         generated_at,
         generated_by,
         file_path,
         error_message,
         created_at,
         updated_at
       FROM report_export_jobs
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [status, limit]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Failed to fetch report export jobs:", err);
    return res.status(500).json({ message: "Failed to fetch report export jobs" });
  }
});

router.post("/report-exports", auth, authorize("ADMIN"), async (req, res) => {
  const reportType = String(req.body?.report_type || "").trim().slice(0, 60);
  const filters =
    req.body?.filters && typeof req.body.filters === "object" && !Array.isArray(req.body.filters)
      ? req.body.filters
      : {};
  const scheduledFor = req.body?.scheduled_for || null;

  if (!reportType) {
    return res.status(400).json({ message: "report_type is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const insertRes = await client.query(
      `INSERT INTO report_export_jobs (
         report_type,
         filters,
         status,
         scheduled_for,
         generated_by,
         created_at,
         updated_at
       )
       VALUES ($1, $2::jsonb, 'QUEUED', COALESCE($3, NOW()), $4, NOW(), NOW())
       RETURNING *`,
      [reportType, JSON.stringify(filters), scheduledFor, String(req.user.id)]
    );
    const job = insertRes.rows[0];

    await writeAuditLog(client, {
      action: "REPORT_EXPORT_JOB_CREATE",
      entity_type: "report_export_job",
      entity_id: job.id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: { report_type: reportType },
    });

    await client.query("COMMIT");
    return res.status(201).json(job);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to create report export job:", err);
    return res.status(500).json({ message: "Failed to create report export job" });
  } finally {
    client.release();
  }
});

router.post("/report-exports/:id/run", auth, authorize("ADMIN"), async (req, res) => {
  const id = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "Invalid export job id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updateRes = await client.query(
      `UPDATE report_export_jobs
       SET status = 'QUEUED',
           scheduled_for = NOW(),
           generated_at = NULL,
           generated_by = COALESCE($2, generated_by),
           file_path = NULL,
           error_message = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND status <> 'CANCELLED'
       RETURNING *`,
      [id, String(req.user.id)]
    );
    if (!updateRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Export job not found" });
    }
    await writeAuditLog(client, {
      action: "REPORT_EXPORT_JOB_RUN",
      entity_type: "report_export_job",
      entity_id: id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {},
    });
    await client.query("COMMIT");
    return res.json(updateRes.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to run report export job:", err);
    return res.status(500).json({ message: "Failed to run report export job" });
  } finally {
    client.release();
  }
});

router.post("/report-exports/:id/cancel", auth, authorize("ADMIN"), async (req, res) => {
  const id = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "Invalid export job id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updateRes = await client.query(
      `UPDATE report_export_jobs
       SET status = 'CANCELLED',
           updated_at = NOW()
       WHERE id = $1
         AND status IN ('QUEUED', 'FAILED')
       RETURNING *`,
      [id]
    );
    if (!updateRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Only QUEUED/FAILED jobs can be cancelled" });
    }
    await writeAuditLog(client, {
      action: "REPORT_EXPORT_JOB_CANCEL",
      entity_type: "report_export_job",
      entity_id: id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {},
    });
    await client.query("COMMIT");
    return res.json(updateRes.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to cancel report export job:", err);
    return res.status(500).json({ message: "Failed to cancel report export job" });
  } finally {
    client.release();
  }
});

export default router;
