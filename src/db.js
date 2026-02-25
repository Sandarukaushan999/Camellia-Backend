import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();

const { Pool } = pkg;
const configuredTimezone = String(process.env.APP_TIMEZONE || "Asia/Colombo").trim();
const appTimezone = /^[A-Za-z0-9_+\-/]+$/.test(configuredTimezone)
  ? configuredTimezone
  : "Asia/Colombo";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("connect", (client) => {
  client
    .query(`SET TIME ZONE '${appTimezone.replace(/'/g, "''")}'`)
    .catch((err) => {
      console.error("Failed to set DB session timezone:", err);
    });
});

export default pool;





