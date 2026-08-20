-- ============================================================
--  ซ่อมข้อมูลเก่า: หน่วยงานบนใบ PSIF ไม่ตรงกับแผนกปัจจุบันของเจ้าของเรื่อง
--  (2026-08-20 · v2.3)
--
--  อาการ: แดชบอร์ดขึ้นแผนกที่ "ไม่มีแล้ว" (Program / Lean / Engineer) พร้อมตัวเลข
--         ส่วนแผนกจริง (Sales / CI / Engineering) ขึ้น 0 ทั้งที่หน้า "รายคน" มีข้อมูล
--  เหตุ:  psif.vsm ถูกคัดลอกไว้ตอนส่งเรื่อง พอพนักงานย้ายแผนก/แผนกเปลี่ยนชื่อ
--         ใบเก่าจึงค้างอยู่แผนกเดิม  →  แดชบอร์ดนับเข้ากลุ่มที่ไม่มีแล้ว
--                                    →  Admin แผนกใหม่มองไม่เห็นใบเก่า (backend scope ที่ vsm=?)
--                                    →  ประตู "เปิดดำเนินการ" (issuances) ไปถามหาแผนกเดิม
--  แก้ต่อไป: worker.js v2.3 ย้ายใบตามให้อัตโนมัติทุกครั้งที่แก้แผนกพนักงาน (syncPsifVsm)
--            ไฟล์นี้ใช้ล้างของเก่าที่ค้างอยู่ก่อนหน้านั้น รันซ้ำได้ ไม่มีผลข้างเคียง
--
--  รัน:  wrangler d1 execute psif-db --remote --file=./migrate-2026-08-20-resync-psif-vsm.sql
--  ดูก่อนรัน (ไม่แก้อะไร):
--    wrangler d1 execute psif-db --remote --command "SELECT TRIM(COALESCE(p.vsm,'')) old_vsm, TRIM(COALESCE(e.vsm,'')) new_vsm, COUNT(*) n FROM psif p JOIN employees e ON e.id=p.reporter_id COLLATE NOCASE WHERE TRIM(COALESCE(p.vsm,''))<>TRIM(COALESCE(e.vsm,'')) GROUP BY 1,2"
--
--  หมายเหตุ: ใบที่ "ไม่พบรหัสผู้ส่งในทะเบียนพนักงาน" จะไม่ถูกแตะ (JOIN ไม่ติด)
--            — พวกนี้ต้องเพิ่มรายชื่อในเมนูตั้งค่าก่อน แล้วค่อยรันไฟล์นี้ซ้ำ
-- ============================================================

UPDATE psif
   SET vsm = (SELECT TRIM(COALESCE(e.vsm,'')) FROM employees e
               WHERE e.id = psif.reporter_id COLLATE NOCASE),
       updated_at = datetime('now')
 WHERE EXISTS (SELECT 1 FROM employees e
                WHERE e.id = psif.reporter_id COLLATE NOCASE
                  AND TRIM(COALESCE(e.vsm,'')) <> TRIM(COALESCE(psif.vsm,'')));

-- ตรวจผล: ต้องได้ 0 แถว
-- SELECT COUNT(*) AS still_mismatched FROM psif p JOIN employees e ON e.id=p.reporter_id COLLATE NOCASE
--  WHERE TRIM(COALESCE(p.vsm,'')) <> TRIM(COALESCE(e.vsm,''));
