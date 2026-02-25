import dotenv from "dotenv";
import bcrypt from "bcrypt";
import pool from "../src/db.js";

dotenv.config();

async function main() {
  const username =
    process.env.SEED_ADMIN_USER || process.env.SUPER_ADMIN_USERNAME || "VOXO";
  const password =
    process.env.SEED_ADMIN_PASS || process.env.SUPER_ADMIN_PASSWORD || "VOXO@123";
  const hash = await bcrypt.hash(password, 10);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id
       FROM access_roles
       WHERE name = 'Super Admin'
         AND is_system = TRUE
         AND is_active = TRUE
       ORDER BY id ASC
       LIMIT 1`
    );
    const superRoleId = Number(rows[0]?.id || 0) || null;

    await client.query(
      `INSERT INTO users (username, "passwordHash", role, "isActive", custom_role_id, is_super_admin)
       VALUES ($1, $2, $3, TRUE, $4, TRUE)
       ON CONFLICT (username) DO UPDATE
       SET "passwordHash" = EXCLUDED."passwordHash",
           role = EXCLUDED.role,
           "isActive" = TRUE,
           custom_role_id = COALESCE(EXCLUDED.custom_role_id, users.custom_role_id),
           is_super_admin = TRUE`,
      [username, hash, "ADMIN", superRoleId]
    );
    await client.query(
      `UPDATE users
       SET is_super_admin = FALSE
       WHERE LOWER(username) <> LOWER($1)
         AND is_super_admin = TRUE`,
      [username]
    );
    await client.query("COMMIT");
    // eslint-disable-next-line no-console
    console.log(`Seeded admin user: ${username}`);
  } catch (err) {
    await client.query("ROLLBACK");
    // eslint-disable-next-line no-console
    console.error("Failed to seed admin", err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
