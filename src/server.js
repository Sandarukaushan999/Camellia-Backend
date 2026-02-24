import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth.js";
import orderRoutes from "./routes/orders.js";
import adminRoutes from "./routes/admin.js";
import inventoryRoutes from "./routes/inventory.js";
import crmRoutes from "./routes/crm.js";
import printingRoutes from "./routes/printing.js";
import { runAppMigrations } from "./dbMigrate.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", version: "1.0.0" })
);

app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/crm", crmRoutes);
app.use("/api/printing", printingRoutes);

const port = process.env.PORT || 4000;

async function startServer() {
  try {
    await runAppMigrations();
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`Backend listening on port ${port}`);
    });
  } catch (err) {
    console.error("Failed to start backend:", err);
    process.exit(1);
  }
}

startServer();



