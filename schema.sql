-- ============================================================
--  PSIF (Plant Safety Improvement Form) — Cloudflare D1 schema
--  Apply with:  wrangler d1 execute psif-db --file=./schema.sql
--  (or paste into the D1 console in the Cloudflare dashboard)
-- ============================================================

-- ---------- master: employees ----------
CREATE TABLE IF NOT EXISTS employees (
  id        TEXT PRIMARY KEY,          -- employee code, e.g. L-1827
  name      TEXT NOT NULL,
  vsm       TEXT DEFAULT '',           -- unit / VSM / department
  role      TEXT DEFAULT 'user',       -- 'user' | 'safety' | 'admin'
  active    INTEGER DEFAULT 1
);

-- ---------- master: areas / machines ----------
CREATE TABLE IF NOT EXISTS areas (
  id        TEXT PRIMARY KEY,          -- slug / code
  name      TEXT NOT NULL,
  vsm       TEXT DEFAULT '',
  active    INTEGER DEFAULT 1
);

-- ---------- master: PSIF categories ----------
CREATE TABLE IF NOT EXISTS categories (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  active    INTEGER DEFAULT 1
);

-- ---------- master: annual target (stories / person / year) ----------
CREATE TABLE IF NOT EXISTS targets (
  year              INTEGER PRIMARY KEY,
  per_person_target INTEGER NOT NULL DEFAULT 6
);

-- ---------- admin issuance: opens the "in-progress" step per VSM/year ----------
-- req #6: an item can only enter 'inprogress' after admin issues a PSIF No.
CREATE TABLE IF NOT EXISTS issuances (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vsm           TEXT NOT NULL,
  year          INTEGER NOT NULL,
  requested_by  TEXT DEFAULT '',
  requested_at  TEXT DEFAULT (datetime('now'))
);

-- ---------- the PSIF record ----------
CREATE TABLE IF NOT EXISTS psif (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  no            TEXT DEFAULT '',          -- PSIF No. (issued by admin; blank until then)
  reporter_id   TEXT NOT NULL,
  reporter_name TEXT DEFAULT '',
  vsm           TEXT DEFAULT '',
  area_id       TEXT DEFAULT '',
  machine       TEXT DEFAULT '',
  category      TEXT DEFAULT '',
  title         TEXT NOT NULL,
  detail        TEXT DEFAULT '',
  suggestion    TEXT DEFAULT '',
  -- workflow: recorded -> safety -> inprogress -> done
  status        TEXT DEFAULT 'recorded',
  safety_result TEXT DEFAULT 'pending',   -- pending | approved | rejected
  safety_note   TEXT DEFAULT '',
  safety_by     TEXT DEFAULT '',
  safety_at     TEXT DEFAULT '',
  done_detail   TEXT DEFAULT '',
  done_by       TEXT DEFAULT '',
  done_at       TEXT DEFAULT '',
  year          INTEGER NOT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_psif_reporter ON psif(reporter_id);
CREATE INDEX IF NOT EXISTS idx_psif_status   ON psif(status);
CREATE INDEX IF NOT EXISTS idx_psif_year     ON psif(year);
CREATE INDEX IF NOT EXISTS idx_psif_vsm      ON psif(vsm);

-- ---------- photos (R2 object keys) ----------
-- req #2: a 'before' photo is required to create; an 'after' photo to close.
CREATE TABLE IF NOT EXISTS psif_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  psif_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL,             -- before | after
  r2_key      TEXT NOT NULL,
  uploaded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_psif ON psif_photos(psif_id);

-- ---------- notifications: alert the reporter when anyone acts on their record ----------
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL,             -- who receives (the reporter)
  psif_id     INTEGER,                   -- related PSIF record (may be deleted)
  message     TEXT NOT NULL,
  by_id       TEXT DEFAULT '',           -- who did the action
  by_name     TEXT DEFAULT '',
  is_read     INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_emp ON notifications(employee_id, is_read);

-- ============================================================
--  SEED DATA
-- ============================================================

-- default target for the current year
INSERT OR IGNORE INTO targets (year, per_person_target) VALUES (2025, 6);
INSERT OR IGNORE INTO targets (year, per_person_target) VALUES (2026, 6);

-- PSIF categories — fixed at exactly 3 types (PSIF / Near miss / Behavior)
INSERT OR IGNORE INTO categories (id, name) VALUES
  ('psif',      'PSIF'),
  ('near_miss', 'Near miss'),
  ('behavior',  'Behavior');

-- areas / machines (sample — manage in the app's Settings)
INSERT OR IGNORE INTO areas (id, name, vsm) VALUES
  ('vsm4_zone1', 'VSM4 - Zone 1', 'VSM4'),
  ('vsm4_zone2', 'VSM4 - Zone 2', 'VSM4'),
  ('vsm4_zone3', 'VSM4 - Zone 3', 'VSM4'),
  ('warehouse',  'คลังสินค้า / Warehouse', 'Logistics'),
  ('office',     'สำนักงาน / Office', 'Office'),
  ('common',     'พื้นที่ส่วนกลาง', 'Common');

-- employees (seeded from the existing VSM4 app)
INSERT OR IGNORE INTO employees (id, name, vsm, role) VALUES
  ('G-260','น.ส.เพชรลดา พรมมา','VSM4','admin'),
  ('L-1827','นายสุทิศ ภูถมดี','VSM4','user'),
  ('L-2101','นายนพรัตน์ พวงพันธ์','VSM4','user'),
  ('L-3501','นายสุภัค โจนรัมย์','VSM4','user'),
  ('L-1928','นายกันยา สวนธิ','VSM4','user'),
  ('L-3096','นายบรรหาญ แสงอ่อน','VSM4','user'),
  ('L-2480','นายสมคิด ทรทึก','VSM4','user'),
  ('L-3582','นายกิตติภพ บัวองค์','VSM4','user'),
  ('L-3012','นายจีราวัฒน์ บวรเกษมพงศ์','VSM4','user'),
  ('PST742','นางสาวจีรนันท์ ลดาพัน','VSM4','safety'),
  ('S-067','นายจำเนียร ทาเทพ','VSM4','user'),
  ('L-603','นายรุ่งโรจน์ วรรณสุทธะ','VSM4','user'),
  ('L-1101','นายเดชา คำพิมูล','VSM4','user'),
  ('PST802','นายวรรณชัย โพธิ์หล้า','VSM4','user'),
  ('L-3591','นายณัฐพงษ์ สีสันงาม','VSM4','user'),
  ('PST709','นายวัชรินทร์ ยอดดี','VSM4','user'),
  ('L-3609','นายภคินัย สาผม','VSM4','user'),
  ('Temp117','นายคมกริช มุ่งงาม','VSM4','user'),
  ('S-057','นายวิภาวัส จันทะคาม','VSM4','user'),
  ('S-059','นายเกรียงไกร โพธิ์ศรี','VSM4','user'),
  ('L-1879','นายวิฑูรย์ สุขเลิศ','VSM4','user'),
  ('T-204','นายวิรัตน์ หวังชอบ','VSM4','user'),
  ('PST759','นายเอกชัย โก้พิมาย','VSM4','user'),
  ('L-3610','นายวัชรินทร์ คำศรี','VSM4','user'),
  ('L-2488','นายสราวุฒิ ปานทอง','VSM4','user'),
  ('L-3527','นายเกียรติศักดิ์ หล้ามณี','VSM4','user'),
  ('S-046','นายสมศักดิ์ เครือลัดดา','VSM4','user'),
  ('L-2499','นายทรงศักดิ์ สืบเสระ','VSM4','user'),
  ('L-3608','นายประเวท กิ่งพุ่ม','VSM4','user'),
  ('T-441','นายธนาศักดิ์ สุกระวัน','VSM4','user'),
  ('L-2935','นายพิสิษฐ์ อิ่มเพ็ง','VSM4','user'),
  ('L-1058','นายสรศักดิ์ สุริยะ','VSM4','user'),
  ('L-3378','นายจักรพันธ์ เทียนหอม','VSM4','user'),
  ('L-2677','นายชาคริต บุญศิริกร','VSM4','user'),
  ('L-3583','นายวันทนา สอนไชย','VSM4','user'),
  ('S-038','นายณรงค์ งิ้วเขียว','VSM4','user'),
  ('L-2929','นายสุวรรณ สุขสถิตย์','VSM4','user'),
  ('PST755','นายอำนาจ ดำรงกิจ','VSM4','user'),
  ('L-2634','นายภูณัทกิจ อ่อนวิมล','VSM4','user'),
  ('L-3374','นายปัญญา ประวันนา','VSM4','user'),
  ('L-3431','นายกฤษณ์ ซื้อจริง','VSM4','user'),
  ('L-2659','นายณรงค์ จอดพิมาย','VSM4','user'),
  ('L-2658','น.ส.มาลิณี จอดพิมาย','VSM4','user'),
  ('L-1763','นายสมชาย พรมชาติ','VSM4','user'),
  ('L-3062','นายอภิวัฒน์ หาดจันทร์','VSM4','user'),
  ('L-1598','นายสัญญา คิดโสดา','VSM4','user'),
  ('L-3015','นายวิรุต การุณรัตน์','VSM4','user'),
  ('L-3035','นายจักรินทร์ นิสสัยดี','VSM4','user'),
  ('L-3611','นายธีรพัฒน์ อินทร์สีดา','VSM4','user');
