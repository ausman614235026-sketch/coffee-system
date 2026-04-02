-- ============================================================
--  CAFE POS — Supabase Schema
--  รันใน Supabase SQL Editor ทีละ section
-- ============================================================

-- 1. Menu items
CREATE TABLE menu_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  category   TEXT NOT NULL,
  price      INTEGER NOT NULL,
  icon       TEXT DEFAULT '☕',
  active     BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Orders
CREATE TABLE orders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number   TEXT NOT NULL UNIQUE,
  total          INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','done','cancelled')),
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- 3. Order items
CREATE TABLE order_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID REFERENCES menu_items(id),
  quantity     INTEGER NOT NULL,
  unit_price   INTEGER NOT NULL,
  subtotal     INTEGER NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
--  Indexes
-- ============================================================
CREATE INDEX idx_orders_status     ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- ============================================================
--  Seed menu
-- ============================================================
INSERT INTO menu_items (name, category, price, icon) VALUES
  ('Espresso',       'กาแฟร้อน', 55,  '☕'),
  ('Americano ร้อน', 'กาแฟร้อน', 60,  '☕'),
  ('Latte ร้อน',     'กาแฟร้อน', 70,  '☕'),
  ('Cappuccino',     'กาแฟร้อน', 70,  '☕'),
  ('Flat White',     'กาแฟร้อน', 75,  '☕'),
  ('Americano เย็น', 'กาแฟเย็น', 65,  '🧊'),
  ('Latte เย็น',     'กาแฟเย็น', 75,  '🧊'),
  ('Cold Brew',      'กาแฟเย็น', 85,  '🧊'),
  ('Iced Mocha',     'กาแฟเย็น', 85,  '🧊'),
  ('Caramel Latte',  'กาแฟเย็น', 80,  '🧊'),
  ('ชาไทยเย็น',      'ชา/อื่นๆ', 55,  '🍵'),
  ('มัทฉะลาเต้',     'ชา/อื่นๆ', 85,  '🍵'),
  ('โอเลี้ยง',        'ชา/อื่นๆ', 50,  '🍵'),
  ('เลมอนโซดา',      'ชา/อื่นๆ', 60,  '🥤'),
  ('ครัวซองต์',      'ของกิน',   65,  '🥐'),
  ('บาเกล+ครีมชีส',  'ของกิน',   80,  '🥯'),
  ('เค้กช็อกโกแลต',  'ของกิน',   75,  '🍰'),
  ('Banana Bread',   'ของกิน',   65,  '🍞');

-- ============================================================
--  Row Level Security (อนุญาตทุก request จาก service key)
-- ============================================================
ALTER TABLE menu_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_all" ON menu_items  FOR ALL USING (true);
CREATE POLICY "service_all" ON orders      FOR ALL USING (true);
CREATE POLICY "service_all" ON order_items FOR ALL USING (true);
