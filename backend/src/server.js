import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth.js";
import orderRoutes from "./routes/orders.js";
import adminRoutes from "./routes/admin.js";
import inventoryRoutes from "./routes/inventory.js";
import crmRoutes from "./routes/crm.js";
import printingRoutes from "./routes/printing.js";
import branchRoutes from "./routes/branches.js";
import supplyRoutes from "./routes/supply.js";
import operationsRoutes from "./routes/operations.js";
import analyticsRoutes from "./routes/analytics.js";
import publicRoutes from "./routes/public.js";
import { runAppMigrations } from "./dbMigrate.js";
import { startDailyBackupScheduler } from "./services/backupJobs.js";
import { startReportExportScheduler } from "./services/reportExportJobs.js";

dotenv.config();

const app = express();

const defaultAllowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "https://camellia-frontend.vercel.app",
];

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

function isTrueFlag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function isWeakJwtSecret(secret) {
  const normalized = String(secret || "").trim();
  if (!normalized) {
    return true;
  }
  if (normalized.length < 32) {
    return true;
  }
  return /change_me|changeme|default|secret|admin123|password/i.test(normalized);
}

const configuredOrigins = parseCsv(
  process.env.CORS_ORIGIN || process.env.CORS_ORIGINS
).map(normalizeOrigin);
const allowedOrigins = (
  configuredOrigins.length > 0 ? configuredOrigins : defaultAllowedOrigins
)
  .map(normalizeOrigin)
  .filter(Boolean);
const allowAllOrigins = isTrueFlag(process.env.CORS_ALLOW_ALL);
const allowVercelPreviews = isTrueFlag(process.env.CORS_ALLOW_VERCEL_PREVIEWS);

function isOriginAllowed(origin) {
  if (!origin) {
    return true;
  }
  if (allowAllOrigins) {
    return true;
  }
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }
  if (allowedOrigins.includes(normalizedOrigin)) {
    return true;
  }
  if (allowVercelPreviews) {
    try {
      const parsed = new URL(normalizedOrigin);
      return (
        parsed.protocol === "https:" && parsed.hostname.endsWith(".vercel.app")
      );
    } catch {
      return false;
    }
  }
  return false;
}

app.disable("x-powered-by");
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "1mb" }));

const publicCors = cors({
  origin: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
  optionsSuccessStatus: 204,
});

app.use("/api/public", publicCors, publicRoutes);
app.use(
  cors({
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    optionsSuccessStatus: 204,
  })
);
app.use((err, _req, res, next) => {
  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ message: "CORS origin denied" });
  }
  return next(err);
});

app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", version: "1.0.0" })
);

app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/crm", crmRoutes);
app.use("/api/printing", printingRoutes);
app.use("/api/branches", branchRoutes);
app.use("/api/supply", supplyRoutes);
app.use("/api/operations", operationsRoutes);
app.use("/api/analytics", analyticsRoutes);

const port = process.env.PORT || 4000;
const retryableDbErrorCodes = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "57P03", // cannot_connect_now
]);

function toInteger(value, fallbackValue) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDatabaseEndpointSummary() {
  const rawDatabaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!rawDatabaseUrl) {
    return {
      target: "missing DATABASE_URL",
      hint:
        "Set DATABASE_URL in your backend environment variables before deployment.",
    };
  }

  try {
    const parsed = new URL(rawDatabaseUrl);
    const host = parsed.hostname || "unknown-host";
    const portFromUrl = parsed.port || "5432";
    const isPrivateIpv4 =
      /^10\.\d+\.\d+\.\d+$/.test(host) ||
      /^127\.\d+\.\d+\.\d+$/.test(host) ||
      /^192\.168\.\d+\.\d+$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(host);
    const isLocalHost = host === "localhost";

    if (isLocalHost || isPrivateIpv4) {
      return {
        target: `${host}:${portFromUrl}`,
        hint:
          "DATABASE_URL points to a local/private host. Use a public or same-network PostgreSQL endpoint for this deployment target.",
      };
    }

    return { target: `${host}:${portFromUrl}`, hint: "" };
  } catch {
    return {
      target: "invalid DATABASE_URL",
      hint:
        "DATABASE_URL is malformed. Use format: postgres://user:pass@host:5432/dbname",
    };
  }
}

function formatStartupError(err) {
  const code = err?.code ? ` (${err.code})` : "";
  const severity = err?.severity ? ` [${String(err.severity)}]` : "";
  const message = err?.message || String(err);
  return `${message}${code}${severity}`;
}

function isRetryableDbError(err) {
  return retryableDbErrorCodes.has(String(err?.code || "").toUpperCase());
}

async function runMigrationsWithRetry() {
  const maxAttempts = toInteger(process.env.DB_CONNECT_RETRY_ATTEMPTS, 60);
  const baseDelayMs = toInteger(process.env.DB_CONNECT_RETRY_DELAY_MS, 3000);
  const maxDelayMs = toInteger(process.env.DB_CONNECT_RETRY_MAX_DELAY_MS, 15000);
  const maxWaitMs = toInteger(process.env.DB_CONNECT_MAX_WAIT_MS, 300000);
  const { target, hint } = getDatabaseEndpointSummary();
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runAppMigrations();
      return;
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, maxWaitMs - elapsedMs);
      const retryable = isRetryableDbError(err);
      const shouldRetry =
        retryable && attempt < maxAttempts && remainingMs > 0;
      console.error(
        `Database startup check failed (attempt ${attempt}/${maxAttempts}) for ${target}: ${formatStartupError(
          err
        )}`
      );
      if (hint) {
        console.error(hint);
      }
      if (!shouldRetry) {
        if (retryable && remainingMs <= 0) {
          console.error(
            `Database did not become ready within ${maxWaitMs}ms.`
          );
        }
        if (retryable && attempt >= maxAttempts && remainingMs > 0) {
          console.error(
            `Database startup retries reached max attempts (${maxAttempts}) before readiness.`
          );
        }
        throw err;
      }

      const exponentialFactor = 2 ** Math.min(attempt - 1, 8);
      const plannedDelayMs = Math.min(baseDelayMs * exponentialFactor, maxDelayMs);
      const backoffDelayMs = Math.max(
        250,
        Math.min(plannedDelayMs, remainingMs)
      );
      console.error(
        `Retrying database connection in ${backoffDelayMs}ms (${Math.ceil(
          remainingMs / 1000
        )}s remaining in startup wait window)...`
      );
      await sleep(backoffDelayMs);
    }
  }
}

async function startServer() {
  try {
    const jwtSecret = String(process.env.JWT_SECRET || "").trim();
    const databaseUrl = String(process.env.DATABASE_URL || "").trim();
    if (!jwtSecret) {
      throw new Error("JWT_SECRET is required");
    }
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required");
    }
    if (isWeakJwtSecret(jwtSecret)) {
      const warningMessage =
        "JWT_SECRET appears weak. Use a long random value (32+ chars).";
      if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
        throw new Error(warningMessage);
      }
      console.warn(warningMessage);
    }

    await runMigrationsWithRetry();
    const server = app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`Backend listening on port ${port}`);
      startDailyBackupScheduler();
      startReportExportScheduler();
    });
    server.on("error", (err) => {
      if (err?.code === "EADDRINUSE") {
        console.error(
          `Port ${port} is already in use. Stop the existing backend process before starting a new one.`
        );
        process.exit(1);
      }
      console.error("Server failed to start:", err);
      process.exit(1);
    });
  } catch (err) {
    console.error("Failed to start backend:", formatStartupError(err));
    process.exit(1);
  }
}

startServer();
