import pool from "./db.js";

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

    await ensureTextColumn(client, "customer_notes", "created_by");
    await ensureTextColumn(client, "customer_campaigns", "created_by");
    await ensureTextColumn(client, "customer_loyalty_txns", "order_id");
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
    await addColumnIfMissing(client, "orders", "status", "VARCHAR(24) DEFAULT 'COMPLETED'");
    await addColumnIfMissing(client, "orders", "refunded_amount", "NUMERIC(10,2) DEFAULT 0");
    await addColumnIfMissing(client, "orders", "void_reason", "TEXT");
    await addColumnIfMissing(client, "orders", "refund_reason", "TEXT");
    await addColumnIfMissing(client, "orders", "parent_order_id", "INT");
    await addColumnIfMissing(client, "inventory_items", "unit_cost", "NUMERIC(12,2) DEFAULT 0");
    await addColumnIfMissing(client, "products", "image_url", "TEXT");
    await addColumnIfMissing(client, "expenses", "incurred_at", "TIMESTAMP DEFAULT NOW()");

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
      SET status = 'COMPLETED'
      WHERE status IS NULL
    `);
    await client.query(`
      UPDATE orders
      SET refunded_amount = 0
      WHERE refunded_amount IS NULL
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
      `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_held_orders_created_at ON held_orders(created_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_held_orders_created_by ON held_orders(created_by)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_expenses_incurred_at ON expenses(incurred_at DESC)`
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
