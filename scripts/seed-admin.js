import dotenv from "dotenv";
import bcrypt from "bcrypt";
import pool from "../src/db.js";

dotenv.config();

async function main() {
  const username = process.env.SEED_ADMIN_USER || "admin";
  const password = process.env.SEED_ADMIN_PASS || "admin123";
  const hash = await bcrypt.hash(password, 10);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      'INSERT INTO users (username, "passwordHash", role, "isActive") VALUES ($1, $2, $3, true) ON CONFLICT (username) DO NOTHING',
      [username, hash, "ADMIN"]
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

