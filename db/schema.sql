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





