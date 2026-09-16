-- ============================================================
--  v2.8 (2026-09-17) — ปุ่ม "Add Job to Imp." บนใบ PSIF (Con)
--
--  ที่มา: ใบ PSIF (Con) บางใบเข้าข่ายงาน Improvement อยู่แล้ว เดิมต้องไปพิมพ์ซ้ำ
--    อีกรอบในระบบ Improvement พร้อมอัปโหลดรูปใหม่ทั้งชุด
--    ตั้งแต่ v2.8: Super Admin กดปุ่มเดียว ระบบเปิด "งานใหม่" ให้ที่
--    https://topmaha.github.io/Improvement-TENNECO/ พร้อมยกรูปก่อนแก้ไขไปด้วย
--    และเมื่องานนั้นถูก "ปิดงาน" ฝั่งโน้น ใบ PSIF นี้จะถูกปิดตาม + ดึงรูปหลังแก้ไขกลับมา
--
--  4 คอลัมน์นี้คือ "เส้นเชื่อม" ระหว่างใบ PSIF กับงาน Improvement
--
--  รันครั้งเดียว:
--    wrangler d1 execute psif-db --remote --file=./migrate-2026-09-17-improvement.sql
--
--  ถ้ารันซ้ำจะได้ error "duplicate column name: imp_job_id" — ไม่เป็นไร แปลว่าเคยรันไปแล้ว
--  (worker.js มีทางหนีไว้: ถ้ายังไม่ได้รันไฟล์นี้ ระบบ PSIF ทำงานได้ครบทุกอย่างเหมือนเดิม
--   แค่ปุ่ม "Add Job to Imp." จะตอบกลับว่ายังไม่ได้เตรียมฐานข้อมูล)
--
--  หมายเหตุ: ต้องผูก binding IMP_DB / IMP_BUCKET ใน wrangler.toml ด้วย ไม่งั้นปุ่มจะยังใช้ไม่ได้
-- ============================================================

ALTER TABLE psif ADD COLUMN imp_job_id INTEGER DEFAULT 0;   -- jobs.id ฝั่ง improvement-db (0 = ยังไม่ได้ส่ง)
ALTER TABLE psif ADD COLUMN imp_code   TEXT DEFAULT '';     -- เลขงาน IMP-YYMM-NN
ALTER TABLE psif ADD COLUMN imp_status TEXT DEFAULT '';     -- submitted | in_progress | done | rejected | gone
ALTER TABLE psif ADD COLUMN imp_at     TEXT DEFAULT '';     -- วัน-เวลาที่กดส่งเข้าระบบ Improvement

-- ใบที่ผูกกับงาน Improvement มีไม่กี่ใบเมื่อเทียบกับทั้งตาราง — partial index ให้รอบ sync
-- (ไล่ถามสถานะงานฝั่งโน้น) หาเจอเร็วโดยไม่ต้องสแกนทั้งตาราง
CREATE INDEX IF NOT EXISTS idx_psif_imp ON psif(imp_job_id) WHERE imp_job_id > 0;
