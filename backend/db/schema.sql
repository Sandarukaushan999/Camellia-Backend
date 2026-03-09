CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  "passwordHash" TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'CASHIER')),
  "isActive" BOOLEAN DEFAULT TRUE,
  is_super_admin BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  small_price NUMERIC(10,2),
  large_price NUMERIC(10,2),
  category VARCHAR(50),
  image_url TEXT,
  "isActive" BOOLEAN DEFAULT TRUE,
  stock INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  invoice_number VARCHAR(20),
  total NUMERIC(10,2) NOT NULL,
  payment_method VARCHAR(20) NOT NULL,
  customer_id TEXT,
  customer_name VARCHAR(120),
  customer_phone VARCHAR(30),
  order_type VARCHAR(20) DEFAULT 'DINE-IN',
  channel VARCHAR(20) DEFAULT 'POS',
  loyalty_points_redeemed INT DEFAULT 0,
  loyalty_discount_amount NUMERIC(10,2) DEFAULT 0,
  manual_discount_amount NUMERIC(10,2) DEFAULT 0,
  total_discount_amount NUMERIC(10,2) DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'COMPLETED',
  refunded_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  void_reason TEXT,
  refund_reason TEXT,
  parent_order_id INT REFERENCES orders(id),
  created_at TIMESTAMP DEFAULT NOW()
);

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
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id),
  qty INT NOT NULL,
  price NUMERIC(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id TEXT,
  actor_id TEXT,
  actor_role VARCHAR(40),
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

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
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  category VARCHAR(80) NOT NULL,
  description TEXT,
  amount NUMERIC(12,2) NOT NULL,
  incurred_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_by TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(40),
  email VARCHAR(120),
  address TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  supplier_id TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  note TEXT,
  ordered_at TIMESTAMP DEFAULT NOW(),
  expected_at TIMESTAMP,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id SERIAL PRIMARY KEY,
  purchase_order_id INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  inventory_item_id INT REFERENCES inventory_items(id) ON DELETE SET NULL,
  qty NUMERIC(12,2) NOT NULL,
  unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id SERIAL PRIMARY KEY,
  purchase_order_id INT REFERENCES purchase_orders(id) ON DELETE SET NULL,
  received_at TIMESTAMP DEFAULT NOW(),
  received_by TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id SERIAL PRIMARY KEY,
  goods_receipt_id INT NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  inventory_item_id INT REFERENCES inventory_items(id) ON DELETE SET NULL,
  qty_received NUMERIC(12,2) NOT NULL,
  unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- Inventory Items Table
CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  unit VARCHAR(20) NOT NULL DEFAULT 'g',
  current_stock NUMERIC(10,2) DEFAULT 0,
  min_stock NUMERIC(10,2) DEFAULT 0,
  expiry_date DATE,
  category VARCHAR(50),
  "isActive" BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Product Ingredients Table (Links products to inventory items)
CREATE TABLE IF NOT EXISTS product_ingredients (
  id SERIAL PRIMARY KEY,
  product_id INT REFERENCES products(id) ON DELETE CASCADE,
  inventory_item_id INT REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity NUMERIC(10,2) NOT NULL,
  UNIQUE(product_id, inventory_item_id)
);

-- Inventory Alerts Table (Track alert history)
CREATE TABLE IF NOT EXISTS inventory_alerts (
  id SERIAL PRIMARY KEY,
  inventory_item_id INT REFERENCES inventory_items(id) ON DELETE CASCADE,
  alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('LOW_STOCK', 'EXPIRY', 'EXPIRED')),
  message TEXT NOT NULL,
  is_resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- CRM Tables
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
);

CREATE TABLE IF NOT EXISTS customer_contacts (
  id SERIAL PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  contact_type VARCHAR(30) NOT NULL,
  contact_value VARCHAR(200) NOT NULL,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_notes (
  id SERIAL PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  color VARCHAR(20) DEFAULT 'slate',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_tag_map (
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id INT NOT NULL REFERENCES customer_tags(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (customer_id, tag_id)
);

CREATE TABLE IF NOT EXISTS customer_loyalty_txns (
  id SERIAL PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id TEXT,
  points_change INT NOT NULL,
  reason VARCHAR(120) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

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
);

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
);

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
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(20),
  ADD COLUMN IF NOT EXISTS customer_id TEXT,
  ADD COLUMN IF NOT EXISTS customer_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(30),
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20),
  ADD COLUMN IF NOT EXISTS loyalty_points_redeemed INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loyalty_discount_amount NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_discount_amount NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_discount_amount NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status VARCHAR(24) DEFAULT 'COMPLETED',
  ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS refund_reason TEXT,
  ADD COLUMN IF NOT EXISTS parent_order_id INT;

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,2) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(LOWER(full_name));
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_invoice_number_unique ON orders(invoice_number);
CREATE INDEX IF NOT EXISTS idx_loyalty_customer_id ON customer_loyalty_txns(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_segments_active_updated ON customer_segments(is_active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_followups_customer_status_due ON customer_followups(customer_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_customer_followups_due_status ON customer_followups(due_at, status);
CREATE INDEX IF NOT EXISTS idx_held_orders_created_at ON held_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_held_orders_created_by ON held_orders(created_by);
CREATE INDEX IF NOT EXISTS idx_expenses_incurred_at ON expenses(incurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_shifts_status ON cash_shifts(status);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);
