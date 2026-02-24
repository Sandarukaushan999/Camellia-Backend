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

router.get("/employees", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const includeInactive = String(req.query.include_inactive || "").toLowerCase() === "true";
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const params = [];
    const conditions = [];
    if (!includeInactive) {
      conditions.push("e.is_active = TRUE");
    }
    if (Number.isFinite(branchId)) {
      params.push(branchId);
      conditions.push(`e.branch_id = $${params.length}`);
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT
         e.id,
         e.branch_id,
         b.code AS branch_code,
         b.name AS branch_name,
         e.user_id,
         u.username,
         e.full_name,
         e.role,
         e.phone,
         e.is_active,
         e.created_at,
         e.updated_at
       FROM employees e
       LEFT JOIN branches b ON b.id = e.branch_id
       LEFT JOIN users u ON u.id::text = e.user_id
       ${whereSql}
       ORDER BY e.created_at DESC`,
      params
    );
    return res.json(rows);
  } catch (err) {
    console.error("Failed to fetch employees:", err);
    return res.status(500).json({ message: "Failed to fetch employees" });
  }
});

router.post("/employees", auth, authorize("ADMIN"), async (req, res) => {
  const fullName = String(req.body?.full_name || "").trim().slice(0, 120);
  const role = String(req.body?.role || "STAFF").trim().toUpperCase().slice(0, 40);
  const phone = req.body?.phone ? String(req.body.phone).trim().slice(0, 40) : null;
  const userId = req.body?.user_id ? String(req.body.user_id).trim().slice(0, 120) : null;
  const isActive = req.body?.is_active !== false;
  if (!fullName) {
    return res.status(400).json({ message: "full_name is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const branchId = await resolveActiveBranchId(client, req.body?.branch_id);
    if (userId) {
      const userRes = await client.query(
        `SELECT id::text AS id
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
    }

    const insertRes = await client.query(
      `INSERT INTO employees (branch_id, user_id, full_name, role, phone, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING *`,
      [branchId, userId, fullName, role, phone, isActive]
    );
    const employee = insertRes.rows[0];

    await writeAuditLog(client, {
      action: "EMPLOYEE_CREATE",
      entity_type: "employee",
      entity_id: employee.id,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {
        branch_id: branchId,
        full_name: fullName,
        role,
      },
    });

    await client.query("COMMIT");
    return res.status(201).json(employee);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to create employee:", err);
    return res.status(500).json({ message: "Failed to create employee" });
  } finally {
    client.release();
  }
});

router.put("/employees/:id", auth, authorize("ADMIN"), async (req, res) => {
  const employeeId = parsePositiveInt(req.params.id, NaN, 1, 1_000_000);
  if (!Number.isFinite(employeeId)) {
    return res.status(400).json({ message: "Invalid employee id" });
  }

  const fullName = req.body?.full_name
    ? String(req.body.full_name).trim().slice(0, 120)
    : null;
  const role = req.body?.role
    ? String(req.body.role).trim().toUpperCase().slice(0, 40)
    : null;
  const phone = req.body?.phone ? String(req.body.phone).trim().slice(0, 40) : null;
  const userId = req.body?.user_id ? String(req.body.user_id).trim().slice(0, 120) : null;
  const isActive = req.body?.is_active;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updateRes = await client.query(
      `UPDATE employees
       SET full_name = COALESCE($2, full_name),
           role = COALESCE($3, role),
           phone = COALESCE($4, phone),
           user_id = COALESCE($5, user_id),
           is_active = COALESCE($6, is_active),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [employeeId, fullName, role, phone, userId, isActive]
    );
    if (!updateRes.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Employee not found" });
    }

    await writeAuditLog(client, {
      action: "EMPLOYEE_UPDATE",
      entity_type: "employee",
      entity_id: employeeId,
      actor_id: req.user.id,
      actor_role: req.user.role,
      payload: {},
    });

    await client.query("COMMIT");
    return res.json(updateRes.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Failed to update employee:", err);
    return res.status(500).json({ message: "Failed to update employee" });
  } finally {
    client.release();
  }
});

router.get("/attendance", auth, authorize("ADMIN"), async (req, res) => {
  try {
    const days = parsePositiveInt(req.query.days, 30, 1, 3650);
    const limit = parsePositiveInt(req.query.limit, 200, 1, 1000);
    const branchId = parsePositiveInt(req.query.branch_id, NaN, 1, 1_000_000);
    const employeeId = parsePositiveInt(req.query.employee_id, NaN, 1, 1_000_000);
    const params = [days, limit];
    const conditions = [
      "al.clock_in_at >= NOW() - (($1::text || ' days')::interval)",
    ];
    if (Number.isFinite(branchId)) {
      params.push(branchId);
      conditions.push(`al.branch_id = $${params.length}`);
    }
    if (Number.isFinite(employeeId)) {
      params.push(employeeId);
      conditions.push(`al.employee_id = $${params.length}`);
    }
    const { rows } = await pool.query(
      `SELECT
         al.id,
         al.employee_id,
         e.full_name AS employee_name,
         al.branch_id,
         b.code AS branch_code,
         b.name AS branch_name,
         al.clock_in_at,
         al.clock_out_at,
         al.note,
         al.created_by,
         CASE
           WHEN al.clock_out_at IS NULL THEN NULL
           ELSE EXTRACT(EPOCH FROM (al.clock_out_at - al.clock_in_at)) / 60
         END AS minutes_worked
       FROM attendance_logs al
       LEFT JOIN employees e ON e.id = al.employee_id
       LEFT JOIN branches b ON b.id = al.branch_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY al.clock_in_at DESC
       LIMIT $2`,
      params
    );
    return res.json(
      rows.map((row) => ({
        ...row,
        minutes_worked:
          row.minutes_worked === null ? null : parseFloat(row.minutes_worked || 0),
      }))
    );
  } catch (err) {
    console.error("Failed to fetch attendance logs:", err);
    return res.status(500).json({ message: "Failed to fetch attendance logs" });
  }
});

router.post(
  "/attendance/clock-in",
  auth,
  authorize("ADMIN", "CASHIER"),
  async (req, res) => {
    const employeeId = parsePositiveInt(req.body?.employee_id, NaN, 1, 1_000_000);
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
    if (!Number.isFinite(employeeId)) {
      return res.status(400).json({ message: "employee_id is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const empRes = await client.query(
        `SELECT id, branch_id, user_id, is_active
         FROM employees
         WHERE id = $1
         FOR UPDATE`,
        [employeeId]
      );
      const employee = empRes.rows[0];
      if (!employee || employee.is_active === false) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Active employee not found" });
      }
      if (
        req.user?.role === "CASHIER" &&
        String(employee.user_id || "") !== String(req.user.id)
      ) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Cashier cannot clock in another employee" });
      }

      const openRes = await client.query(
        `SELECT id
         FROM attendance_logs
         WHERE employee_id = $1
           AND clock_out_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        [employeeId]
      );
      if (openRes.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Employee already has an active clock-in" });
      }

      const branchId = await resolveActiveBranchId(
        client,
        req.body?.branch_id || employee.branch_id
      );
      const insertRes = await client.query(
        `INSERT INTO attendance_logs (employee_id, branch_id, clock_in_at, note, created_by)
         VALUES ($1, $2, NOW(), $3, $4)
         RETURNING *`,
        [employeeId, branchId, note, String(req.user.id)]
      );
      const log = insertRes.rows[0];

      await writeAuditLog(client, {
        action: "ATTENDANCE_CLOCK_IN",
        entity_type: "attendance_log",
        entity_id: log.id,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: { employee_id: employeeId, branch_id: branchId },
      });

      await client.query("COMMIT");
      return res.status(201).json(log);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Failed to clock in:", err);
      return res.status(500).json({ message: "Failed to clock in" });
    } finally {
      client.release();
    }
  }
);

router.post(
  "/attendance/clock-out",
  auth,
  authorize("ADMIN", "CASHIER"),
  async (req, res) => {
    const attendanceId = parsePositiveInt(req.body?.attendance_id, NaN, 1, 1_000_000);
    const employeeId = parsePositiveInt(req.body?.employee_id, NaN, 1, 1_000_000);
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let logRow = null;
      if (Number.isFinite(attendanceId)) {
        const byId = await client.query(
          `SELECT al.*, e.user_id
           FROM attendance_logs al
           LEFT JOIN employees e ON e.id = al.employee_id
           WHERE al.id = $1
           FOR UPDATE`,
          [attendanceId]
        );
        logRow = byId.rows[0] || null;
      } else if (Number.isFinite(employeeId)) {
        const byEmp = await client.query(
          `SELECT al.*, e.user_id
           FROM attendance_logs al
           LEFT JOIN employees e ON e.id = al.employee_id
           WHERE al.employee_id = $1
             AND al.clock_out_at IS NULL
           ORDER BY al.clock_in_at DESC
           LIMIT 1
           FOR UPDATE`,
          [employeeId]
        );
        logRow = byEmp.rows[0] || null;
      } else {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "attendance_id or employee_id is required" });
      }

      if (!logRow) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Open attendance log not found" });
      }
      if (logRow.clock_out_at) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Attendance already clocked out" });
      }
      if (
        req.user?.role === "CASHIER" &&
        String(logRow.user_id || "") !== String(req.user.id)
      ) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Cashier cannot clock out another employee" });
      }

      const updateRes = await client.query(
        `UPDATE attendance_logs
         SET clock_out_at = NOW(),
             note = COALESCE($2, note)
         WHERE id = $1
         RETURNING *,
           EXTRACT(EPOCH FROM (clock_out_at - clock_in_at)) / 60 AS minutes_worked`,
        [logRow.id, note]
      );
      const updated = updateRes.rows[0];

      await writeAuditLog(client, {
        action: "ATTENDANCE_CLOCK_OUT",
        entity_type: "attendance_log",
        entity_id: updated.id,
        actor_id: req.user.id,
        actor_role: req.user.role,
        payload: { employee_id: updated.employee_id, branch_id: updated.branch_id },
      });

      await client.query("COMMIT");
      return res.json({
        ...updated,
        minutes_worked: parseFloat(updated.minutes_worked || 0),
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Failed to clock out:", err);
      return res.status(500).json({ message: "Failed to clock out" });
    } finally {
      client.release();
    }
  }
);

export default router;
