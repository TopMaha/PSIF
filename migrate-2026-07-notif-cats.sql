-- Migration 2026-07: notifications table + fix categories to exactly 3 types
-- Run:  npx wrangler d1 execute psif-db --remote --file=./migrate-2026-07-notif-cats.sql

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL,
  psif_id     INTEGER,
  message     TEXT NOT NULL,
  by_id       TEXT DEFAULT '',
  by_name     TEXT DEFAULT '',
  is_read     INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_emp ON notifications(employee_id, is_read);

-- categories: keep only the 3 fixed types
DELETE FROM categories;
INSERT OR IGNORE INTO categories (id, name, active) VALUES
  ('psif',      'PSIF',      1),
  ('near_miss', 'Near miss', 1),
  ('behavior',  'Behavior',  1);

-- remap old category values on existing records into the 3 types
UPDATE psif SET category='Near miss' WHERE category LIKE '%near miss%' OR category LIKE '%เกือบ%';
UPDATE psif SET category='Behavior'  WHERE category LIKE '%unsafe act%' OR category LIKE '%กระทำ%' OR category LIKE '%พฤติกรรม%';
UPDATE psif SET category='PSIF'      WHERE category<>'' AND category NOT IN ('PSIF','Near miss','Behavior');
