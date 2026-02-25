import pool from "./db.js";
import bcrypt from "bcrypt";
import {
  getDefaultPermissionKeysForBaseRole,
  normalizePermissionKeys,
} from "./config/accessControl.js";

async function addColumnIfMissing(client, tableName, columnName, definition) {
  await client.query(
    `ALTER TABLE ${tableName}
     ADD COLUMN IF NOT EXISTS ${columnName} ${definition}`
  );
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function dropForeignKeysOnColumn(client, tableName, columnName) {
  const { rows } = await client.query(
    `SELECT tc.constraint_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = 'public'
       AND tc.table_name = $1
       AND tc.constraint_type = 'FOREIGN KEY'
       AND kcu.column_name = $2`,
    [tableName, columnName]
  );

  for (const row of rows) {
    const sql = `ALTER TABLE ${quoteIdentifier(tableName)} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(row.constraint_name)}`;
    await client.query(sql);
  }
}

async function ensureTextColumn(client, tableName, columnName) {
  await addColumnIfMissing(client, tableName, columnName, "TEXT");
  await dropForeignKeysOnColumn(client, tableName, columnName);
  await client.query(
    `ALTER TABLE ${quoteIdentifier(tableName)}
     ALTER COLUMN ${quoteIdentifier(columnName)} TYPE TEXT
     USING ${quoteIdentifier(columnName)}::TEXT`
  );
}

export async function runAppMigrations() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        full_name VARCHAR(120) NOT NULL,
        phone VARCHAR(30) NOT NULL UNIQUE,
        email VARCHAR(120),
        birth_date DATE,
        gender VARCHAR(20),
        address TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        total_orders INT DEFAULT 0,
        total_spent NUMERIC(12,2) DEFAULT 0,
        loyalty_points INT DEFAULT 0,
        last_order_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_contacts (
        id SERIAL PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        contact_type VARCHAR(30) NOT NULL,
        contact_value VARCHAR(200) NOT NULL,
        is_primary BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_notes (
        id SERIAL PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_tags (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        color VARCHAR(20) DEFAULT 'slate',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_tag_map (
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        tag_id INT NOT NULL REFERENCES customer_tags(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (customer_id, tag_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_loyalty_txns (
        id SERIAL PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        order_id TEXT,
        points_change INT NOT NULL,
        reason VARCHAR(120) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_campaigns (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        channel VARCHAR(20) DEFAULT 'SMS',
        audience_filter JSONB DEFAULT '{}'::jsonb,
        message TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'DRAFT',
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        scheduled_at TIMESTAMP,
        sent_at TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_segments (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL UNIQUE,
        description TEXT,
        filter JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by TEXT,
        updated_by TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_followups (
        id SERIAL PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        title VARCHAR(160) NOT NULL,
        note TEXT,
        channel VARCHAR(20) NOT NULL DEFAULT 'PHONE',
        priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
        status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
        due_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_by TEXT,
        updated_by TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS held_orders (
        id SERIAL PRIMARY KEY,
        order_type VARCHAR(20) NOT NULL DEFAULT 'DINE-IN',
        table_number VARCHAR(50),
        customer_name VARCHAR(120),
        customer_phone VARCHAR(30),
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        action VARCHAR(80) NOT NULL,
        entity_type VARCHAR(80) NOT NULL,
        entity_id TEXT,
        actor_id TEXT,
        actor_role VARCHAR(40),
        payload JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cash_shifts (
        id SERIAL PRIMARY KEY,
        opened_by TEXT NOT NULL,
        closed_by TEXT,
        opening_cash NUMERIC(12,2) NOT NULL DEFAULT 0,
        closing_cash_declared NUMERIC(12,2),
        closing_cash_expected NUMERIC(12,2),
        variance NUMERIC(12,2),
        status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
        note TEXT,
        opened_at TIMESTAMP DEFAULT NOW(),
        closed_at TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        title VARCHAR(120) NOT NULL DEFAULT 'Expense',
        category VARCHAR(80) NOT NULL,
        description TEXT,
        amount NUMERIC(12,2) NOT NULL,
        incurred_at TIMESTAMP NOT NULL DEFAULT NOW(),
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        phone VARCHAR(40),
        email VARCHAR(120),
        address TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id SERIAL PRIMARY KEY,
        supplier_id TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
        note TEXT,
        ordered_at TIMESTAMP DEFAULT NOW(),
        expected_at TIMESTAMP,
        created_by TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id SERIAL PRIMARY KEY,
        purchase_order_id INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        inventory_item_id INT REFERENCES inventory_items(id) ON DELETE SET NULL,
        qty NUMERIC(12,2) NOT NULL,
        unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS goods_receipts (
        id SERIAL PRIMARY KEY,
        purchase_order_id INT REFERENCES purchase_orders(id) ON DELETE SET NULL,
        received_at TIMESTAMP DEFAULT NOW(),
        received_by TEXT,
        note TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS goods_receipt_items (
        id SERIAL PRIMARY KEY,
        goods_receipt_id INT NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
        inventory_item_id INT REFERENCES inventory_items(id) ON DELETE SET NULL,
        qty_received NUMERIC(12,2) NOT NULL,
        unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id SERIAL PRIMARY KEY,
        code VARCHAR(40) NOT NULL UNIQUE,
        name VARCHAR(120) NOT NULL,
        address TEXT,
        timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS branch_users (
        id SERIAL PRIMARY KEY,
        branch_id INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role_override VARCHAR(20),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (branch_id, user_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS access_roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(80) NOT NULL UNIQUE,
        description TEXT,
        base_role VARCHAR(20) NOT NULL DEFAULT 'ADMIN',
        is_system BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS access_role_permissions (
        role_id INT NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE,
        permission_key VARCHAR(80) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (role_id, permission_key)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS branch_inventory (
        id SERIAL PRIMARY KEY,
        branch_id INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        inventory_item_id TEXT NOT NULL,
        current_stock NUMERIC(12,2) NOT NULL DEFAULT 0,
        min_stock NUMERIC(12,2) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (branch_id, inventory_item_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS branch_products (
        id SERIAL PRIMARY KEY,
        branch_id INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        price_override NUMERIC(10,2),
        is_active BOOLEAN DEFAULT TRUE,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (branch_id, product_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_batches (
        id SERIAL PRIMARY KEY,
        branch_id INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        inventory_item_id TEXT NOT NULL,
        lot_code VARCHAR(80),
        expiry_date DATE,
        qty_on_hand NUMERIC(12,2) NOT NULL DEFAULT 0,
        unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
        source_type VARCHAR(40),
        source_id TEXT,
        received_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id SERIAL PRIMARY KEY,
        branch_id INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        inventory_item_id TEXT NOT NULL,
        movement_type VARCHAR(40) NOT NULL,
        quantity NUMERIC(12,2) NOT NULL,
        unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
        reference_type VARCHAR(40),
        reference_id TEXT,
        note TEXT,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_transfers (
        id SERIAL PRIMARY KEY,
        from_branch_id INT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
        to_branch_id INT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
        status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
        note TEXT,
        requested_by TEXT,
        approved_by TEXT,
        shipped_by TEXT,
        received_by TEXT,
        requested_at TIMESTAMP DEFAULT NOW(),
        approved_at TIMESTAMP,
        shipped_at TIMESTAMP,
        received_at TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_transfer_items (
        id SERIAL PRIMARY KEY,
        transfer_id INT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
        inventory_item_id TEXT NOT NULL,
        quantity NUMERIC(12,2) NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_requisitions (
        id SERIAL PRIMARY KEY,
        branch_id INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
        purchase_order_id INT,
        note TEXT,
        requested_by TEXT,
        approved_by TEXT,
        approved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_requisition_items (
        id SERIAL PRIMARY KEY,
        requisition_id INT NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
        inventory_item_id TEXT NOT NULL,
        requested_qty NUMERIC(12,2) NOT NULL,
        suggested_qty NUMERIC(12,2),
        min_stock_snapshot NUMERIC(12,2),
        current_stock_snapshot NUMERIC(12,2)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS backup_jobs (
        id SERIAL PRIMARY KEY,
        trigger_source VARCHAR(40) NOT NULL DEFAULT 'MANUAL',
        status VARCHAR(20) NOT NULL,
        backup_path TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_count_sessions (
        id SERIAL PRIMARY KEY,
        branch_id INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
        note TEXT,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        closed_at TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_count_items (
        id SERIAL PRIMARY KEY,
        session_id INT NOT NULL REFERENCES stock_count_sessions(id) ON DELETE CASCADE,
        inventory_item_id TEXT NOT NULL,
        expected_qty NUMERIC(12,2) NOT NULL DEFAULT 0,
        counted_qty NUMERIC(12,2),
        variance_qty NUMERIC(12,2) DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        branch_id INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        user_id TEXT,
        full_name VARCHAR(120) NOT NULL,
        role VARCHAR(40) NOT NULL DEFAULT 'STAFF',
        phone VARCHAR(40),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance_logs (
        id SERIAL PRIMARY KEY,
        employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        branch_id INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        clock_in_at TIMESTAMP NOT NULL DEFAULT NOW(),
        clock_out_at TIMESTAMP,
        note TEXT,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS report_templates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        module VARCHAR(60) NOT NULL,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_default BOOLEAN DEFAULT FALSE,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS forecast_snapshots (
        id SERIAL PRIMARY KEY,
        model VARCHAR(80) NOT NULL,
        branch_id INT REFERENCES branches(id) ON DELETE SET NULL,
        horizon_days INT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        generated_by TEXT,
        generated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS report_export_jobs (
        id SERIAL PRIMARY KEY,
        report_type VARCHAR(60) NOT NULL,
        filters JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
        scheduled_for TIMESTAMP NOT NULL DEFAULT NOW(),
        generated_at TIMESTAMP,
        generated_by TEXT,
        file_path TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      INSERT INTO branches (code, name, address, timezone, is_active)
      SELECT 'HQ', 'Main Branch', NULL, 'Asia/Colombo', TRUE
      WHERE NOT EXISTS (SELECT 1 FROM branches)
    `);
    await client.query(`
      UPDATE branches
      SET timezone = 'Asia/Colombo'
      WHERE timezone IS NULL
         OR TRIM(timezone) = ''
         OR UPPER(TRIM(timezone)) = 'UTC'
    `);

    await ensureTextColumn(client, "customer_notes", "created_by");
    await ensureTextColumn(client, "customer_campaigns", "created_by");
    await ensureTextColumn(client, "customer_loyalty_txns", "order_id");
    await ensureTextColumn(client, "customer_segments", "created_by");
    await ensureTextColumn(client, "customer_segments", "updated_by");
    await ensureTextColumn(client, "customer_followups", "created_by");
    await ensureTextColumn(client, "customer_followups", "updated_by");
    await ensureTextColumn(client, "held_orders", "created_by");
    await ensureTextColumn(client, "expenses", "created_by");
    await ensureTextColumn(client, "purchase_orders", "supplier_id");

    await addColumnIfMissing(client, "orders", "customer_id", "TEXT");
    await addColumnIfMissing(client, "orders", "customer_name", "VARCHAR(120)");
    await addColumnIfMissing(client, "orders", "customer_phone", "VARCHAR(30)");
    await addColumnIfMissing(client, "orders", "order_type", "VARCHAR(20)");
    await addColumnIfMissing(client, "orders", "channel", "VARCHAR(20)");
    await addColumnIfMissing(client, "orders", "loyalty_points_redeemed", "INT DEFAULT 0");
    await addColumnIfMissing(client, "orders", "loyalty_discount_amount", "NUMERIC(10,2) DEFAULT 0");
    await addColumnIfMissing(client, "orders", "manual_discount_amount", "NUMERIC(10,2) DEFAULT 0");
    await addColumnIfMissing(client, "orders", "total_discount_amount", "NUMERIC(10,2) DEFAULT 0");
    await addColumnIfMissing(client, "orders", "status", "VARCHAR(24) DEFAULT 'COMPLETED'");
    await addColumnIfMissing(client, "orders", "refunded_amount", "NUMERIC(10,2) DEFAULT 0");
    await addColumnIfMissing(client, "orders", "void_reason", "TEXT");
    await addColumnIfMissing(client, "orders", "refund_reason", "TEXT");
    await addColumnIfMissing(client, "orders", "parent_order_id", "INT");
    await addColumnIfMissing(client, "orders", "invoice_number", "VARCHAR(20)");
    await addColumnIfMissing(client, "orders", "branch_id", "INT DEFAULT 1");
    await addColumnIfMissing(client, "cash_shifts", "branch_id", "INT DEFAULT 1");
    await addColumnIfMissing(client, "held_orders", "branch_id", "INT DEFAULT 1");
    await addColumnIfMissing(client, "users", "approval_pin_hash", "TEXT");
    await addColumnIfMissing(client, "users", "approval_pin_updated_at", "TIMESTAMP");
    await addColumnIfMissing(client, "users", "custom_role_id", "INT");
    await addColumnIfMissing(client, "users", "is_super_admin", "BOOLEAN DEFAULT FALSE");
    await addColumnIfMissing(client, "inventory_items", "unit_cost", "NUMERIC(12,2) DEFAULT 0");
    await addColumnIfMissing(client, "products", "image_url", "TEXT");
    await addColumnIfMissing(client, "customer_segments", "description", "TEXT");
    await addColumnIfMissing(client, "customer_segments", "filter", "JSONB DEFAULT '{}'::jsonb");
    await addColumnIfMissing(client, "customer_segments", "is_active", "BOOLEAN DEFAULT TRUE");
    await addColumnIfMissing(client, "customer_segments", "updated_by", "TEXT");
    await addColumnIfMissing(client, "customer_segments", "updated_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "customer_followups", "note", "TEXT");
    await addColumnIfMissing(client, "customer_followups", "channel", "VARCHAR(20) DEFAULT 'PHONE'");
    await addColumnIfMissing(client, "customer_followups", "priority", "VARCHAR(20) DEFAULT 'MEDIUM'");
    await addColumnIfMissing(client, "customer_followups", "status", "VARCHAR(20) DEFAULT 'OPEN'");
    await addColumnIfMissing(client, "customer_followups", "due_at", "TIMESTAMP");
    await addColumnIfMissing(client, "customer_followups", "completed_at", "TIMESTAMP");
    await addColumnIfMissing(client, "customer_followups", "updated_by", "TEXT");
    await addColumnIfMissing(client, "customer_followups", "updated_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "expenses", "title", "VARCHAR(120)");
    await addColumnIfMissing(client, "expenses", "incurred_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "expenses", "branch_id", "INT DEFAULT 1");
    await addColumnIfMissing(client, "branch_inventory", "branch_id", "INT");
    await addColumnIfMissing(client, "branch_inventory", "inventory_item_id", "TEXT");
    await addColumnIfMissing(client, "branch_inventory", "current_stock", "NUMERIC(12,2) DEFAULT 0");
    await addColumnIfMissing(client, "branch_inventory", "min_stock", "NUMERIC(12,2) DEFAULT 0");
    await addColumnIfMissing(client, "branch_inventory", "updated_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "branch_products", "branch_id", "INT");
    await addColumnIfMissing(client, "branch_products", "product_id", "TEXT");
    await addColumnIfMissing(client, "branch_products", "is_active", "BOOLEAN DEFAULT TRUE");
    await addColumnIfMissing(client, "branch_products", "updated_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "stock_batches", "branch_id", "INT");
    await addColumnIfMissing(client, "stock_batches", "inventory_item_id", "TEXT");
    await addColumnIfMissing(client, "stock_batches", "qty_on_hand", "NUMERIC(12,2) DEFAULT 0");
    await addColumnIfMissing(client, "stock_batches", "created_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "stock_movements", "branch_id", "INT");
    await addColumnIfMissing(client, "stock_movements", "inventory_item_id", "TEXT");
    await addColumnIfMissing(client, "stock_movements", "movement_type", "VARCHAR(40)");
    await addColumnIfMissing(client, "stock_movements", "quantity", "NUMERIC(12,2) DEFAULT 0");
    await addColumnIfMissing(client, "stock_movements", "created_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "stock_transfers", "from_branch_id", "INT");
    await addColumnIfMissing(client, "stock_transfers", "to_branch_id", "INT");
    await addColumnIfMissing(client, "stock_transfers", "status", "VARCHAR(24) DEFAULT 'PENDING'");
    await addColumnIfMissing(client, "stock_transfers", "requested_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "stock_transfer_items", "transfer_id", "INT");
    await addColumnIfMissing(client, "stock_transfer_items", "inventory_item_id", "TEXT");
    await addColumnIfMissing(client, "stock_transfer_items", "quantity", "NUMERIC(12,2) DEFAULT 0");
    await addColumnIfMissing(client, "purchase_requisitions", "branch_id", "INT");
    await addColumnIfMissing(client, "purchase_requisitions", "status", "VARCHAR(24) DEFAULT 'DRAFT'");
    await addColumnIfMissing(client, "purchase_requisitions", "purchase_order_id", "INT");
    await addColumnIfMissing(client, "purchase_requisitions", "note", "TEXT");
    await addColumnIfMissing(client, "purchase_requisitions", "requested_by", "TEXT");
    await addColumnIfMissing(client, "purchase_requisitions", "approved_by", "TEXT");
    await addColumnIfMissing(client, "purchase_requisitions", "approved_at", "TIMESTAMP");
    await addColumnIfMissing(client, "purchase_requisitions", "created_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "purchase_requisitions", "updated_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "purchase_requisition_items", "requisition_id", "INT");
    await addColumnIfMissing(client, "purchase_requisition_items", "inventory_item_id", "TEXT");
    await addColumnIfMissing(client, "purchase_requisition_items", "requested_qty", "NUMERIC(12,2) DEFAULT 0");
    await addColumnIfMissing(client, "purchase_requisition_items", "suggested_qty", "NUMERIC(12,2)");
    await addColumnIfMissing(client, "purchase_requisition_items", "min_stock_snapshot", "NUMERIC(12,2)");
    await addColumnIfMissing(client, "purchase_requisition_items", "current_stock_snapshot", "NUMERIC(12,2)");
    await addColumnIfMissing(client, "backup_jobs", "trigger_source", "VARCHAR(40) DEFAULT 'MANUAL'");
    await addColumnIfMissing(client, "backup_jobs", "status", "VARCHAR(20)");
    await addColumnIfMissing(client, "backup_jobs", "details", "JSONB DEFAULT '{}'::jsonb");
    await addColumnIfMissing(client, "backup_jobs", "created_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "stock_count_sessions", "branch_id", "INT");
    await addColumnIfMissing(client, "stock_count_sessions", "status", "VARCHAR(20) DEFAULT 'OPEN'");
    await addColumnIfMissing(client, "stock_count_sessions", "created_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "stock_count_items", "session_id", "INT");
    await addColumnIfMissing(client, "stock_count_items", "inventory_item_id", "TEXT");
    await addColumnIfMissing(client, "stock_count_items", "expected_qty", "NUMERIC(12,2) DEFAULT 0");
    await addColumnIfMissing(client, "stock_count_items", "counted_qty", "NUMERIC(12,2)");
    await addColumnIfMissing(client, "stock_count_items", "variance_qty", "NUMERIC(12,2) DEFAULT 0");
    await addColumnIfMissing(client, "employees", "branch_id", "INT");
    await addColumnIfMissing(client, "employees", "user_id", "TEXT");
    await addColumnIfMissing(client, "employees", "full_name", "VARCHAR(120)");
    await addColumnIfMissing(client, "employees", "role", "VARCHAR(40) DEFAULT 'STAFF'");
    await addColumnIfMissing(client, "employees", "phone", "VARCHAR(40)");
    await addColumnIfMissing(client, "employees", "is_active", "BOOLEAN DEFAULT TRUE");
    await addColumnIfMissing(client, "employees", "created_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "employees", "updated_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "attendance_logs", "employee_id", "INT");
    await addColumnIfMissing(client, "attendance_logs", "branch_id", "INT");
    await addColumnIfMissing(client, "attendance_logs", "clock_in_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "attendance_logs", "clock_out_at", "TIMESTAMP");
    await addColumnIfMissing(client, "attendance_logs", "note", "TEXT");
    await addColumnIfMissing(client, "attendance_logs", "created_by", "TEXT");
    await addColumnIfMissing(client, "attendance_logs", "created_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "report_templates", "name", "VARCHAR(120)");
    await addColumnIfMissing(client, "report_templates", "module", "VARCHAR(60)");
    await addColumnIfMissing(client, "report_templates", "config", "JSONB DEFAULT '{}'::jsonb");
    await addColumnIfMissing(client, "report_templates", "is_default", "BOOLEAN DEFAULT FALSE");
    await addColumnIfMissing(client, "report_templates", "created_by", "TEXT");
    await addColumnIfMissing(client, "report_templates", "created_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "report_templates", "updated_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "forecast_snapshots", "model", "VARCHAR(80)");
    await addColumnIfMissing(client, "forecast_snapshots", "branch_id", "INT");
    await addColumnIfMissing(client, "forecast_snapshots", "horizon_days", "INT");
    await addColumnIfMissing(client, "forecast_snapshots", "payload", "JSONB DEFAULT '{}'::jsonb");
    await addColumnIfMissing(client, "forecast_snapshots", "generated_by", "TEXT");
    await addColumnIfMissing(client, "forecast_snapshots", "generated_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "report_export_jobs", "report_type", "VARCHAR(60)");
    await addColumnIfMissing(client, "report_export_jobs", "filters", "JSONB DEFAULT '{}'::jsonb");
    await addColumnIfMissing(client, "report_export_jobs", "status", "VARCHAR(20) DEFAULT 'QUEUED'");
    await addColumnIfMissing(client, "report_export_jobs", "scheduled_for", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "report_export_jobs", "generated_at", "TIMESTAMP");
    await addColumnIfMissing(client, "report_export_jobs", "generated_by", "TEXT");
    await addColumnIfMissing(client, "report_export_jobs", "file_path", "TEXT");
    await addColumnIfMissing(client, "report_export_jobs", "error_message", "TEXT");
    await addColumnIfMissing(client, "report_export_jobs", "created_at", "TIMESTAMP DEFAULT NOW()");
    await addColumnIfMissing(client, "report_export_jobs", "updated_at", "TIMESTAMP DEFAULT NOW()");
    await ensureTextColumn(client, "stock_count_items", "inventory_item_id");
    await ensureTextColumn(client, "employees", "user_id");
    await ensureTextColumn(client, "attendance_logs", "created_by");
    await ensureTextColumn(client, "report_templates", "created_by");
    await ensureTextColumn(client, "forecast_snapshots", "generated_by");
    await ensureTextColumn(client, "branch_users", "user_id");
    await ensureTextColumn(client, "branch_inventory", "inventory_item_id");
    await ensureTextColumn(client, "branch_products", "product_id");
    await ensureTextColumn(client, "stock_batches", "inventory_item_id");
    await ensureTextColumn(client, "stock_movements", "inventory_item_id");
    await ensureTextColumn(client, "stock_transfer_items", "inventory_item_id");
    await ensureTextColumn(client, "purchase_requisitions", "requested_by");
    await ensureTextColumn(client, "purchase_requisitions", "approved_by");
    await ensureTextColumn(client, "purchase_requisition_items", "inventory_item_id");
    await ensureTextColumn(client, "report_export_jobs", "generated_by");

    const systemAccessRoleSeeds = [
      {
        name: "Super Admin",
        description: "Full access to all POS modules and settings.",
        baseRole: "ADMIN",
        permissions: getDefaultPermissionKeysForBaseRole("ADMIN"),
      },
      {
        name: "Admin Default",
        description: "Standard admin access for day-to-day management.",
        baseRole: "ADMIN",
        permissions: getDefaultPermissionKeysForBaseRole("ADMIN"),
      },
      {
        name: "Cashier Default",
        description: "Checkout-focused access for cashier operations.",
        baseRole: "CASHIER",
        permissions: getDefaultPermissionKeysForBaseRole("CASHIER"),
      },
    ];

    for (const roleSeed of systemAccessRoleSeeds) {
      const roleRes = await client.query(
        `INSERT INTO access_roles (name, description, base_role, is_system, is_active, updated_at)
         VALUES ($1, $2, $3, TRUE, TRUE, NOW())
         ON CONFLICT (name) DO UPDATE
         SET description = EXCLUDED.description,
             base_role = EXCLUDED.base_role,
             is_system = TRUE,
             is_active = TRUE,
             updated_at = NOW()
         RETURNING id`,
        [roleSeed.name, roleSeed.description, roleSeed.baseRole]
      );
      const roleId = Number(roleRes.rows[0]?.id || 0);
      if (!Number.isFinite(roleId) || roleId <= 0) {
        continue;
      }

      await client.query(
        `DELETE FROM access_role_permissions
         WHERE role_id = $1`,
        [roleId]
      );

      const permissionKeys = normalizePermissionKeys(roleSeed.permissions);
      for (const permissionKey of permissionKeys) {
        await client.query(
          `INSERT INTO access_role_permissions (role_id, permission_key)
           VALUES ($1, $2)
           ON CONFLICT (role_id, permission_key) DO NOTHING`,
          [roleId, permissionKey]
        );
      }
    }

    await client.query(`
      ALTER TABLE users
      ALTER COLUMN is_super_admin SET DEFAULT FALSE
    `);
    await client.query(`
      UPDATE users
      SET is_super_admin = FALSE
      WHERE is_super_admin IS NULL
    `);
    await client.query(`
      ALTER TABLE users
      ALTER COLUMN is_super_admin SET NOT NULL
    `);

    const superAdminUsernameRaw = String(
      process.env.SUPER_ADMIN_USERNAME || "VOXO"
    ).trim();
    const superAdminUsername = superAdminUsernameRaw || "VOXO";
    const superAdminPassword = String(
      process.env.SUPER_ADMIN_PASSWORD || "VOXO@123"
    );
    const superAdminPasswordHash = await bcrypt.hash(superAdminPassword, 10);
    const superRoleRes = await client.query(
      `SELECT id
       FROM access_roles
       WHERE name = 'Super Admin'
         AND is_system = TRUE
         AND is_active = TRUE
       ORDER BY id ASC
       LIMIT 1`
    );
    const superAdminRoleId = Number(superRoleRes.rows[0]?.id || 0) || null;
    const existingSuperAdminRes = await client.query(
      `SELECT id::text AS id
       FROM users
       WHERE LOWER(username) = LOWER($1)
       ORDER BY
         CASE WHEN username = $1 THEN 0 ELSE 1 END,
         id::text ASC
       LIMIT 1
       FOR UPDATE`,
      [superAdminUsername]
    );

    let superAdminId = existingSuperAdminRes.rows[0]?.id || null;
    if (superAdminId) {
      await client.query(
        `UPDATE users
         SET username = $2,
             "passwordHash" = $3,
             role = 'ADMIN',
             "isActive" = TRUE,
             custom_role_id = COALESCE($4, custom_role_id),
             is_super_admin = TRUE
         WHERE id::text = $1`,
        [superAdminId, superAdminUsername, superAdminPasswordHash, superAdminRoleId]
      );
    } else {
      const insertSuperAdminRes = await client.query(
        `INSERT INTO users (username, "passwordHash", role, "isActive", custom_role_id, is_super_admin)
         VALUES ($1, $2, 'ADMIN', TRUE, $3, TRUE)
         RETURNING id::text AS id`,
        [superAdminUsername, superAdminPasswordHash, superAdminRoleId]
      );
      superAdminId = insertSuperAdminRes.rows[0]?.id || null;
    }

    if (superAdminId) {
      await client.query(
        `UPDATE users
         SET is_super_admin = FALSE
         WHERE id::text <> $1
           AND is_super_admin = TRUE`,
        [superAdminId]
      );
    }

    await client.query(`
      UPDATE orders
      SET order_type = 'DINE-IN'
      WHERE order_type IS NULL
    `);
    await client.query(`
      UPDATE orders
      SET channel = 'POS'
      WHERE channel IS NULL
    `);
    await client.query(`
      UPDATE orders
      SET loyalty_points_redeemed = 0
      WHERE loyalty_points_redeemed IS NULL
    `);
    await client.query(`
      UPDATE orders
      SET loyalty_discount_amount = 0
      WHERE loyalty_discount_amount IS NULL
    `);
    await client.query(`
      UPDATE orders
      SET manual_discount_amount = 0
      WHERE manual_discount_amount IS NULL
    `);
    await client.query(`
      UPDATE orders
      SET total_discount_amount = COALESCE(manual_discount_amount, 0) + COALESCE(loyalty_discount_amount, 0)
      WHERE total_discount_amount IS NULL
         OR total_discount_amount <> COALESCE(manual_discount_amount, 0) + COALESCE(loyalty_discount_amount, 0)
    `);
    await client.query(`
      UPDATE orders
      SET status = 'COMPLETED'
      WHERE status IS NULL
    `);
    await client.query(`
      UPDATE orders
      SET refunded_amount = 0
      WHERE refunded_amount IS NULL
    `);
    await client.query(`
      UPDATE orders
      SET branch_id = 1
      WHERE branch_id IS NULL
    `);
    await client.query(`
      UPDATE orders
      SET invoice_number = CONCAT('VOXO', LPAD(id::text, 6, '0'))
      WHERE invoice_number IS DISTINCT FROM CONCAT('VOXO', LPAD(id::text, 6, '0'))
    `);
    await client.query(`
      UPDATE cash_shifts
      SET branch_id = 1
      WHERE branch_id IS NULL
    `);
    await client.query(`
      UPDATE held_orders
      SET branch_id = 1
      WHERE branch_id IS NULL
    `);
    await client.query(`
      WITH role_ids AS (
        SELECT
          MAX(CASE WHEN name = 'Super Admin' THEN id END) AS super_admin_role_id,
          MAX(CASE WHEN name = 'Admin Default' THEN id END) AS admin_default_role_id,
          MAX(CASE WHEN base_role = 'CASHIER' THEN id END) AS cashier_role_id
        FROM access_roles
        WHERE is_system = TRUE
          AND is_active = TRUE
      )
      UPDATE users u
      SET custom_role_id = CASE
        WHEN COALESCE(u.is_super_admin, FALSE) = TRUE THEN COALESCE(role_ids.super_admin_role_id, role_ids.admin_default_role_id, u.custom_role_id)
        WHEN u.role = 'ADMIN' THEN COALESCE(role_ids.admin_default_role_id, role_ids.super_admin_role_id, u.custom_role_id)
        WHEN u.role = 'CASHIER' THEN COALESCE(role_ids.cashier_role_id, u.custom_role_id)
        ELSE u.custom_role_id
      END
      FROM role_ids
      WHERE u.custom_role_id IS NULL
        AND (
          COALESCE(u.is_super_admin, FALSE) = TRUE
          OR u.role IN ('ADMIN', 'CASHIER')
        )
    `);
    await client.query(`
      WITH role_ids AS (
        SELECT
          MAX(CASE WHEN name = 'Super Admin' THEN id END) AS super_admin_role_id,
          MAX(CASE WHEN name = 'Admin Default' THEN id END) AS admin_default_role_id
        FROM access_roles
        WHERE is_system = TRUE
          AND is_active = TRUE
      )
      UPDATE users u
      SET custom_role_id = role_ids.admin_default_role_id
      FROM role_ids
      WHERE u.role = 'ADMIN'
        AND COALESCE(u.is_super_admin, FALSE) = FALSE
        AND role_ids.admin_default_role_id IS NOT NULL
        AND (
          u.custom_role_id IS NULL
          OR u.custom_role_id = role_ids.super_admin_role_id
        )
    `);
    await client.query(`
      UPDATE expenses
      SET branch_id = 1
      WHERE branch_id IS NULL
    `);
    await client.query(`
      UPDATE expenses
      SET title = COALESCE(NULLIF(TRIM(title), ''), NULLIF(TRIM(category), ''), 'Expense')
      WHERE title IS NULL
         OR TRIM(title) = ''
    `);
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'expenses'
            AND column_name = 'expense_date'
        ) THEN
          UPDATE expenses
          SET incurred_at = COALESCE(incurred_at, expense_date::timestamp, created_at)
          WHERE incurred_at IS NULL;
        END IF;
      END$$;
    `);
    await client.query(`
      UPDATE expenses
      SET incurred_at = COALESCE(incurred_at, created_at, NOW())
      WHERE incurred_at IS NULL
    `);
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'inventory_items'
            AND column_name = 'cost_per_unit'
        ) THEN
          UPDATE inventory_items
          SET unit_cost = COALESCE(NULLIF(unit_cost, 0), cost_per_unit, 0)
          WHERE (unit_cost IS NULL OR unit_cost = 0)
            AND cost_per_unit IS NOT NULL;
        END IF;
      END$$;
    `);
    await client.query(`
      UPDATE orders o
      SET customer_id = NULL
      WHERE customer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM customers c
          WHERE c.id = o.customer_id
        )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'orders_customer_id_fk'
        ) THEN
          ALTER TABLE orders
          ADD CONSTRAINT orders_customer_id_fk
          FOREIGN KEY (customer_id)
          REFERENCES customers(id)
          ON DELETE SET NULL;
        END IF;
      END$$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'expenses_branch_id_fk'
        ) THEN
          ALTER TABLE expenses
          ADD CONSTRAINT expenses_branch_id_fk
          FOREIGN KEY (branch_id)
          REFERENCES branches(id)
          ON DELETE SET NULL;
        END IF;
      END$$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'orders_branch_id_fk'
        ) THEN
          ALTER TABLE orders
          ADD CONSTRAINT orders_branch_id_fk
          FOREIGN KEY (branch_id)
          REFERENCES branches(id)
          ON DELETE SET NULL;
        END IF;
      END$$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'cash_shifts_branch_id_fk'
        ) THEN
          ALTER TABLE cash_shifts
          ADD CONSTRAINT cash_shifts_branch_id_fk
          FOREIGN KEY (branch_id)
          REFERENCES branches(id)
          ON DELETE SET NULL;
        END IF;
      END$$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'held_orders_branch_id_fk'
        ) THEN
          ALTER TABLE held_orders
          ADD CONSTRAINT held_orders_branch_id_fk
          FOREIGN KEY (branch_id)
          REFERENCES branches(id)
          ON DELETE SET NULL;
        END IF;
      END$$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'users_custom_role_id_fk'
        ) THEN
          ALTER TABLE users
          ADD CONSTRAINT users_custom_role_id_fk
          FOREIGN KEY (custom_role_id)
          REFERENCES access_roles(id)
          ON DELETE SET NULL;
        END IF;
      END$$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'purchase_requisitions_branch_id_fk'
        ) THEN
          ALTER TABLE purchase_requisitions
          ADD CONSTRAINT purchase_requisitions_branch_id_fk
          FOREIGN KEY (branch_id)
          REFERENCES branches(id)
          ON DELETE CASCADE;
        END IF;
      END$$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'purchase_requisitions_purchase_order_id_fk'
        ) THEN
          ALTER TABLE purchase_requisitions
          ADD CONSTRAINT purchase_requisitions_purchase_order_id_fk
          FOREIGN KEY (purchase_order_id)
          REFERENCES purchase_orders(id)
          ON DELETE SET NULL;
        END IF;
      END$$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'purchase_requisition_items_requisition_id_fk'
        ) THEN
          ALTER TABLE purchase_requisition_items
          ADD CONSTRAINT purchase_requisition_items_requisition_id_fk
          FOREIGN KEY (requisition_id)
          REFERENCES purchase_requisitions(id)
          ON DELETE CASCADE;
        END IF;
      END$$;
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(LOWER(full_name))`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_loyalty_customer_id ON customer_loyalty_txns(customer_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_customer_segments_active_updated ON customer_segments(is_active, updated_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_customer_followups_customer_status_due ON customer_followups(customer_id, status, due_at)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_customer_followups_due_status ON customer_followups(due_at, status)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_users_custom_role_id ON users(custom_role_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_access_roles_base_role_active ON access_roles(base_role, is_active)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_access_role_permissions_role_id ON access_role_permissions(role_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_access_role_permissions_permission_key ON access_role_permissions(permission_key)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_orders_branch_id ON orders(branch_id)`
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_invoice_number_unique ON orders(invoice_number)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_held_orders_created_at ON held_orders(created_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_held_orders_created_by ON held_orders(created_by)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_held_orders_branch_id ON held_orders(branch_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_cash_shifts_branch_id ON cash_shifts(branch_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_expenses_incurred_at ON expenses(incurred_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_expenses_branch_id ON expenses(branch_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_cash_shifts_status ON cash_shifts(status)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_branches_code ON branches(code)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_branch_inventory_branch_item ON branch_inventory(branch_id, inventory_item_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_stock_batches_branch_item ON stock_batches(branch_id, inventory_item_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_stock_batches_expiry_date ON stock_batches(expiry_date)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_stock_movements_branch_created ON stock_movements(branch_id, created_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_stock_movements_item_created ON stock_movements(inventory_item_id, created_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_stock_transfers_status ON stock_transfers(status)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_purchase_requisitions_branch_status ON purchase_requisitions(branch_id, status, created_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_purchase_requisitions_purchase_order_id ON purchase_requisitions(purchase_order_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_purchase_requisition_items_requisition_id ON purchase_requisition_items(requisition_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_purchase_requisition_items_inventory_item_id ON purchase_requisition_items(inventory_item_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_backup_jobs_created_at ON backup_jobs(created_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_stock_count_sessions_branch_status ON stock_count_sessions(branch_id, status)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_stock_count_items_session ON stock_count_items(session_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_employees_branch_active ON employees(branch_id, is_active)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_attendance_logs_employee_clock_in ON attendance_logs(employee_id, clock_in_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_attendance_logs_branch_clock_in ON attendance_logs(branch_id, clock_in_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_report_templates_module ON report_templates(module, is_default)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_generated_at ON forecast_snapshots(generated_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_report_export_jobs_status_scheduled ON report_export_jobs(status, scheduled_for)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_report_export_jobs_created_at ON report_export_jobs(created_at DESC)`
    );

    await client.query("COMMIT");
    console.log("Database migrations completed");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Database migration failed:", err);
    throw err;
  } finally {
    client.release();
  }
}
