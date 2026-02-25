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
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "1mb" }));
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
app.use("/api/public", publicRoutes);

const port = process.env.PORT || 4000;

async function startServer() {
  try {
    const jwtSecret = String(process.env.JWT_SECRET || "").trim();
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
    console.error("Failed to start backend:", err);
    process.exit(1);
  }
}

startServer();
