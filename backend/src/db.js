import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();

const { Pool } = pkg;
const configuredTimezone = String(process.env.APP_TIMEZONE || "Asia/Colombo").trim();
const appTimezone = /^[A-Za-z0-9_+\-/]+$/.test(configuredTimezone)
  ? configuredTimezone
  : "Asia/Colombo";
const databaseUrl = String(process.env.DATABASE_URL || "").trim();

function isTrueFlag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function toInteger(value, fallbackValue) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function shouldUseSsl(urlValue) {
  if (isTrueFlag(process.env.DATABASE_SSL) || isTrueFlag(process.env.DB_SSL)) {
    return true;
  }

  const rawSslMode = String(process.env.PGSSLMODE || "").trim().toLowerCase();
  if (
    rawSslMode === "require" ||
    rawSslMode === "verify-ca" ||
    rawSslMode === "verify-full"
  ) {
    return true;
  }

  if (!urlValue) {
    return false;
  }

  try {
    const parsed = new URL(urlValue);
    const sslModeFromUrl = String(
      parsed.searchParams.get("sslmode") || ""
    ).toLowerCase();
    return (
      sslModeFromUrl === "require" ||
      sslModeFromUrl === "verify-ca" ||
      sslModeFromUrl === "verify-full"
    );
  } catch {
    return false;
  }
}

const poolConfig = {
  connectionString: databaseUrl,
  connectionTimeoutMillis: toInteger(
    process.env.DATABASE_CONNECTION_TIMEOUT_MS,
    10000
  ),
};

if (shouldUseSsl(databaseUrl)) {
  poolConfig.ssl = {
    rejectUnauthorized: !isTrueFlag(process.env.DATABASE_SSL_ALLOW_SELF_SIGNED),
  };
}

const pool = new Pool(poolConfig);

pool.on("connect", (client) => {
  client
    .query(`SET TIME ZONE '${appTimezone.replace(/'/g, "''")}'`)
    .catch((err) => {
      console.error("Failed to set DB session timezone:", err);
    });
});

export default pool;





