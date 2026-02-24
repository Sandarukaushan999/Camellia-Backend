import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pool from "../db.js";
import createRateLimiter from "../middleware/rateLimit.js";
import {
  getDefaultPermissionKeysForBaseRole,
  normalizePermissionKeys,
} from "../config/accessControl.js";

const router = express.Router();

const loginLimiter = createRateLimiter({
  windowMs: Number(process.env.AUTH_LOGIN_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS || 8),
  keyGenerator: (req) => {
    const username = String(req.body?.username || "")
      .trim()
      .toLowerCase();
    return `${req.ip || "unknown"}:${username || "-"}`;
  },
  message: "Too many login attempts. Please wait before trying again.",
});

router.post("/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: "Username and password required" });
  }

  try {
    const { rows } = await pool.query(
      `WITH target_user AS (
         SELECT
           u.id,
           u.username,
           u."passwordHash",
           u.role,
           u.custom_role_id,
           COALESCE(u.is_super_admin, FALSE) AS is_super_admin
         FROM users u
         WHERE LOWER(u.username) = LOWER($1)
           AND u."isActive" = TRUE
         ORDER BY
           CASE WHEN u.username = $1 THEN 0 ELSE 1 END,
           u.id::text ASC
         LIMIT 1
       )
       SELECT
         tu.id::text AS id,
         tu.username,
         tu."passwordHash" AS password,
         tu.role,
         tu.custom_role_id,
         tu.is_super_admin,
         ar.name AS custom_role_name,
         ar.base_role AS custom_role_base_role,
         ar.is_active AS custom_role_is_active,
         COALESCE(
           ARRAY_AGG(arp.permission_key) FILTER (WHERE arp.permission_key IS NOT NULL),
           ARRAY[]::text[]
         ) AS custom_permissions
       FROM target_user tu
       LEFT JOIN access_roles ar ON ar.id = tu.custom_role_id
       LEFT JOIN access_role_permissions arp ON arp.role_id = ar.id
       GROUP BY
         tu.id,
         tu.username,
         tu."passwordHash",
         tu.role,
         tu.custom_role_id,
         tu.is_super_admin,
         ar.name,
         ar.base_role,
         ar.is_active`,
      [username]
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const hasCustomRole =
      Number.isFinite(Number(user.custom_role_id)) &&
      user.custom_role_is_active !== false;
    const permissionKeys = hasCustomRole
      ? (() => {
          const customPermissionKeys = normalizePermissionKeys(user.custom_permissions);
          if (customPermissionKeys.length > 0) {
            return customPermissionKeys;
          }
          return getDefaultPermissionKeysForBaseRole(
            user.custom_role_base_role || user.role
          );
        })()
      : getDefaultPermissionKeysForBaseRole(user.role);
    const customRole =
      hasCustomRole && user.custom_role_name
        ? {
            id: Number(user.custom_role_id),
            name: user.custom_role_name,
            base_role: user.custom_role_base_role || user.role,
          }
        : null;
    const isSuperAdmin = user.is_super_admin === true;

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        is_super_admin: isSuperAdmin,
        permissions: permissionKeys,
        custom_role_id: customRole?.id || null,
        custom_role_name: customRole?.name || null,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "30m" }
    );

    return res.json({
      token,
      id: user.id,
      username: user.username,
      role: user.role,
      is_super_admin: isSuperAdmin,
      isSuperAdmin,
      permissions: permissionKeys,
      customRole,
    });
  } catch (err) {
    // Avoid leaking internals
    return res.status(500).json({ message: "Login failed" });
  }
});

export default router;
