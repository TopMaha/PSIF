-- ============================================================
--  Migration 2026-07-15 — กันบันทึกซ้ำ (ข้อ 1: idempotency)
--  รันครั้งเดียวกับฐานข้อมูลจริง:
--    wrangler d1 execute psif-db --remote --file=./migrate-2026-07-15-idempotency.sql
--  (ทดสอบ local: ตัด --remote ออก)
--
--  * ไม่กระทบข้อมูลเดิม: เพิ่มคอลัมน์เปล่า + index เท่านั้น
--  * ถ้ารันซ้ำ ALTER TABLE จะ error "duplicate column name" = migrate ไปแล้ว ข้ามได้เลย
--  * บทบาทใหม่ dept_admin (ข้อ 3) ไม่ต้อง migrate — คอลัมน์ employees.role เป็น TEXT อยู่แล้ว
--    ตั้งค่าได้จากหน้า ตั้งค่า → พนักงาน → สิทธิ์ "Admin แผนก" (Super Admin เท่านั้น)
-- ============================================================

-- requestId (UUID) ที่ client ส่งมากับการบันทึก — ใช้ dedupe การกดซ้ำ/ยิงซ้ำ
ALTER TABLE psif ADD COLUMN request_id TEXT DEFAULT '';

-- unique กันซ้ำระดับข้อมูล (partial index: ข้ามแถวเก่า/แถว import ที่ request_id ว่าง)
CREATE UNIQUE INDEX IF NOT EXISTS idx_psif_request_id ON psif(request_id) WHERE request_id <> '';
