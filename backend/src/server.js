import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomBytes } from "crypto";
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
    .split(/[\s,;]+/)
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
function getStartupJwtSecret() {
  const configured = String(process.env.JWT_SECRET || "").trim();
  if (configured) {
    return configured;
  }

  const isRailwayRuntime = Boolean(
    String(process.env.RAILWAY_PROJECT_ID || "").trim() ||
      String(process.env.RAILWAY_ENVIRONMENT_ID || "").trim() ||
      String(process.env.RAILWAY_SERVICE_ID || "").trim()
  );
  if (!isRailwayRuntime) {
    return "";
  }

  const generated = randomBytes(48).toString("hex");
  process.env.JWT_SECRET = generated;
  console.warn(
    "JWT_SECRET is not set. Generated temporary secret for this Railway deployment. Set JWT_SECRET variable for stable sessions."
  );
  return generated;
}


const configuredOrigins = parseCsv(
  process.env.CORS_ORIGIN || process.env.CORS_ORIGINS
).map(normalizeOrigin);
const hasWildcardConfigured = configuredOrigins.includes("*");
const allowedOrigins = Array.from(
  new Set([...defaultAllowedOrigins, ...configuredOrigins].map(normalizeOrigin))
).filter(Boolean);
const allowAllOrigins = isTrueFlag(process.env.CORS_ALLOW_ALL);
const allowVercelPreviews = isTrueFlag(process.env.CORS_ALLOW_VERCEL_PREVIEWS);
const allowLocalDevOrigins = (() => {
  const raw = String(process.env.CORS_ALLOW_LOCALHOST || "")
    .trim()
    .toLowerCase();
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return String(process.env.NODE_ENV || "").trim().toLowerCase() !== "production";
})();

function isLocalDevOrigin(origin) {
  try {
    const parsed = new URL(origin);
    const host = String(parsed.hostname || "").trim().toLowerCase();
    return (
      parsed.protocol === "http:" &&
      (host === "localhost" || host === "127.0.0.1" || host === "::1")
    );
  } catch {
    return false;
  }
}

function isOriginAllowed(origin) {
  if (!origin) {
    return true;
  }
  if (allowAllOrigins || hasWildcardConfigured) {
    return true;
  }
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }
  if (allowLocalDevOrigins && isLocalDevOrigin(normalizedOrigin)) {
    return true;
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

const corsOptions = {
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
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "1mb" }));
app.use((err, _req, res, next) => {
  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ message: "CORS origin denied" });
  }
  if (err instanceof SyntaxError && err?.status === 400 && "body" in err) {
    return res.status(400).json({ message: "Invalid JSON payload" });
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
app.use("/api/public", publicRoutes);

const port = process.env.PORT || 4000;

function parseDatabaseTarget() {
  const fallback = { host: "localhost", port: 5432 };
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  if (!connectionString) {
    return fallback;
  }

  try {
    const parsed = new URL(connectionString);
    const host = parsed.hostname || fallback.host;
    const portValue = Number(parsed.port) || fallback.port;
    return { host, port: portValue };
  } catch {
    return fallback;
  }
}

function collectNetworkCodes(error) {
  const nested = Array.isArray(error?.errors) ? error.errors : [];
  return [error, ...nested]
    .map((entry) => String(entry?.code || "").trim().toUpperCase())
    .filter(Boolean);
}

function isDatabaseUnavailable(error) {
  const networkCodes = collectNetworkCodes(error);
  return networkCodes.some((code) =>
    ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND"].includes(
      code
    )
  );
}

async function startServer() {
  try {
    const jwtSecret = getStartupJwtSecret();
    if (!jwtSecret) {
      throw new Error("JWT_SECRET is required");
    }
    if (isWeakJwtSecret(jwtSecret)) {
      const warningMessage =
        "JWT_SECRET appears weak. Use a long random value (32+ chars).";
      if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
        throw new Error(warningMessage);
      }
      console.warn(warningMessage);
    }

    await runAppMigrations();
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
    if (isDatabaseUnavailable(err)) {
      const dbTarget = parseDatabaseTarget();
      console.error(
        `Database is unreachable at ${dbTarget.host}:${dbTarget.port}.`
      );
      console.error(
        "Start PostgreSQL, then run the backend again. If you use Docker Desktop, run `docker compose up -d` from the project root."
      );
      process.exit(1);
    }
    console.error("Failed to start backend:", err);
    process.exit(1);
  }
}

startServer();
