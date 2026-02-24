CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  "passwordHash" TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'CASHIER')),
  "isActive" BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  category VARCHAR(50),
  "isActive" BOOLEAN DEFAULT TRUE,
  stock INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  total NUMERIC(10,2) NOT NULL,
  payment_method VARCHAR(20) NOT NULL,
  customer_id TEXT,
  customer_name VARCHAR(120),
  customer_phone VARCHAR(30),
  order_type VARCHAR(20) DEFAULT 'DINE-IN',
  channel VARCHAR(20) DEFAULT 'POS',
  loyalty_points_redeemed INT DEFAULT 0,
  loyalty_discount_amount NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id),
  qty INT NOT NULL,
  price NUMERIC(10,2) NOT NULL
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

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_id TEXT,
  ADD COLUMN IF NOT EXISTS customer_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(30),
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20),
  ADD COLUMN IF NOT EXISTS loyalty_points_redeemed INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loyalty_discount_amount NUMERIC(10,2) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(LOWER(full_name));
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_loyalty_customer_id ON customer_loyalty_txns(customer_id);


