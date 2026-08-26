-- ============================================================
--  v2.6 — ดัชนีเพิ่มความเร็วเมื่อข้อมูลเยอะขึ้น (2026-08-26)
--  รันครั้งเดียวกับฐานข้อมูลที่ใช้งานอยู่:
--    wrangler d1 execute psif-db --remote --file=./migrate-2026-08-26-perf-indexes.sql
--  ปลอดภัย: สร้างเฉพาะดัชนี ไม่แตะข้อมูล และรันซ้ำได้ (IF NOT EXISTS)
-- ============================================================

-- หน้าติดตาม/แดชบอร์ดดึงด้วย  ... ORDER BY created_at DESC  ทุกครั้ง
-- ไม่มีดัชนีนี้ SQLite ต้องเรียงทั้งตารางใหม่ทุกคำขอ (ยิ่งเรื่องเยอะยิ่งช้า)
CREATE INDEX IF NOT EXISTS idx_psif_created_at ON psif(created_at DESC);

-- Admin แผนก / Manager ถูก scope เป็น  WHERE vsm=? ... ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_psif_vsm_created ON psif(vsm, created_at DESC);

-- รายงานรายคน / แดชบอร์ด กรองด้วยปีเป็นหลัก
CREATE INDEX IF NOT EXISTS idx_psif_year_vsm ON psif(year, vsm);

-- กระดิ่งแจ้งเตือน: WHERE employee_id=? ORDER BY id DESC LIMIT 50 (ถูกเรียกทุก 60 วินาที/คน)
CREATE INDEX IF NOT EXISTS idx_notif_emp_id ON notifications(employee_id, id DESC);

-- อัปเดตสถิติให้ตัววางแผนคำสั่งเลือกดัชนีได้ถูก
ANALYZE;
