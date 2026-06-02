# PSIF — ระบบบันทึก & ติดตามความปลอดภัย

เว็บแอป (ไฟล์เดียว) สำหรับบันทึก PSIF (Plant Safety Improvement Form) พร้อมระบบติดตาม 4 ขั้นตอน,
รูปภาพบังคับ, Safety ตรวจสอบ, ตรวจเรื่องซ้ำ, รายงานรายคน/ภาพรวม, แดชบอร์ด, ล็อกอินด้วยรหัสพนักงาน,
เป้าหมาย และคำนวณโบนัส — สแต็กเดียวกับ VSM4 (Cloudflare Worker + D1 + R2)

## 🌐 เปิดใช้งาน (Live)
**https://topmaha.github.io/PSIF/**  ← แตะเปิดได้เลย (มือถือ/คอม)

สแกนเพื่อเปิดในมือถือ:

<img src="qr.png" alt="QR เปิดแอป PSIF" width="200">

> ✅ **เชื่อมฐานข้อมูลออนไลน์แล้ว** — แอปต่อกับ API `https://psif-api.wiphawas-sketchup.workers.dev`
> (Cloudflare D1 + เก็บรูปบน R2) ทุกคนที่เปิดลิงก์จะเห็น/แก้ไขข้อมูลชุดเดียวกันทันที
> ไม่ต้องตั้งค่าอะไร — เปลี่ยน API ได้ที่ ⚙️ ตั้งค่า (ถ้าต้องการ)

## ไฟล์ในโปรเจกต์
| ไฟล์ | หน้าที่ |
|------|---------|
| `index.html` | ตัวแอปทั้งหมด (HTML+CSS+JS) เปิดในมือถือ/คอม ได้เลย |
| `worker.js`  | Cloudflare Worker = API เชื่อม D1 + R2 |
| `schema.sql` | โครงสร้างตาราง D1 + ข้อมูลตั้งต้น (พนักงาน 49 คน, ประเภท, พื้นที่) |

---

## โหมดทดลอง (ไม่ต้องตั้งเซิร์ฟเวอร์)
เปิด `index.html` ได้ทันที → ข้อมูลเก็บในเครื่องนั้น (localStorage) เท่านั้น ไม่แชร์กับคนอื่น
เหมาะกับลองใช้งานก่อน รหัสตัวอย่าง: `G-260` (Admin), `PST742` (Safety), `L-1827` (พนักงาน)
รหัส Admin (ปลดล็อกเมนูตั้งค่า) = `admin1234` (แก้ได้ในโค้ด ตัวแปร `ADMIN_PASSWORD`)

---

## ทำให้เป็นฐานข้อมูลออนไลน์ (ทุกคนเห็นข้อมูลเดียวกัน)

> เครื่องนี้ deploy Worker ไม่ได้ (Node เก่า/ไม่มี wrangler) — ทำตามขั้นตอนด้านล่างบนเครื่องที่มี
> Node 18+ หรือทำผ่านหน้าเว็บ Cloudflare Dashboard

### A. ติดตั้ง wrangler (เครื่องที่ deploy)
```bash
npm install -g wrangler
wrangler login
```

### B. สร้าง D1 + R2
```bash
wrangler d1 create psif-db
wrangler r2 bucket create psif-photos
wrangler d1 execute psif-db --remote --file=./schema.sql
```
คัดลอก `database_id` ที่ได้จากคำสั่งแรกไปใส่ `wrangler.toml`

### C. สร้าง `wrangler.toml` (วางไว้โฟลเดอร์เดียวกับ `worker.js`)
```toml
name = "psif-api"
main = "worker.js"
compatibility_date = "2024-09-01"

[[d1_databases]]
binding = "DB"
database_name = "psif-db"
database_id = "<<วาง database_id ที่ได้จากขั้น B>>"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "psif-photos"

# (ไม่บังคับ) ถ้าเปิด Public access / Custom domain ให้ R2 แล้ว
# ใส่ URL ฐานไว้ตรงนี้ เพื่อให้รูปโหลดตรงจาก R2 (ลดภาระ Worker)
# [vars]
# R2_PUBLIC_BASE = "https://pub-xxxxxxxx.r2.dev"
```

### D. Deploy
```bash
wrangler deploy
```
จะได้ URL เช่น `https://psif-api.<ชื่อบัญชี>.workers.dev`

### E. เชื่อมแอปกับ API
เปิดแอป → เมนู **⚙️ ตั้งค่า → ฐานข้อมูลออนไลน์ (API)** → วาง URL → **บันทึก & เชื่อมต่อ**
ทุกคนที่ใส่ URL เดียวกันจะเห็น/แก้ไขข้อมูลร่วมกัน

> **ทางเลือกผ่าน Dashboard (ไม่ใช้ command line):** Cloudflare → Workers & Pages → Create Worker →
> วางโค้ด `worker.js` → ในแท็บ Settings ผูก Binding ชื่อ `DB` (D1) และ `BUCKET` (R2) →
> รัน `schema.sql` ในหน้า D1 Console → Deploy

---

## โฮสต์ตัวแอป (index.html)
แค่ไฟล์ static ไฟล์เดียว วางที่ไหนก็ได้:
- **Cloudflare Pages / GitHub Pages / Netlify** — อัปโหลด `index.html`
- หรือเปิดจากไฟล์ตรง ๆ ก็ได้ (ตั้งค่า API URL ในแอป)

---

## 📷 การเก็บรูปภาพ (ประหยัดพื้นที่)
- **ไฟล์รูปจริงเก็บบน Cloudflare R2** — ฐานข้อมูล D1 เก็บแค่ "คีย์" (ข้อความสั้น เช่น
  `psif/12/after-….jpg`) ไม่ได้เก็บไฟล์รูป → D1 เล็กมาก ไม่บวม
- **ย่อรูปอัตโนมัติฝั่งผู้ใช้** ก่อนอัปโหลด (≤ 1280px, JPEG) ลดขนาดไฟล์/ค่าเก็บข้อมูล
- **ลบรูปออกจาก R2 อัตโนมัติ** เมื่อ Admin ลบรายการ (`DELETE /psif`)
- เสิร์ฟรูป 2 แบบ:
  1. ผ่าน Worker `GET /photo/:key` (ค่าเริ่มต้น — ใช้ได้เลย, รูปเป็นส่วนตัว)
  2. ตรงจาก R2 public/custom domain — ตั้ง `R2_PUBLIC_BASE` (ดูขั้น C) เพื่อลดภาระ/ค่า request ของ Worker
- โหมดทดลอง (ยังไม่ตั้งค่า API): รูปเก็บแบบ base64 ในเครื่อง (localStorage) ชั่วคราวเท่านั้น —
  พอเชื่อม API/deploy Worker แล้ว รูปจะไปอยู่บน R2 ทันที

---

## การทำงานของ 4 ขั้นตอน (ข้อ 1)
1. **บันทึกเข้าระบบ** — พนักงานกรอกฟอร์ม + แนบรูป "ก่อนแก้ไข" (บังคับ)
2. **Safety อนุมัติ/ไม่อนุมัติ** — เจ้าหน้าที่ Safety/Admin ตรวจเนื้อหา + ดูเรื่องซ้ำ
3. **กำลังดำเนินการ** — เริ่มได้เมื่อ **Admin "เปิดดำเนินการ"** ของหน่วยงานนั้น (ข้อ 6) แล้วใส่เลข No.PSIF
4. **เสร็จ** — ปิดงานพร้อมแนบรูป "หลังแก้ไข" (บังคับ)

## สิทธิ์ผู้ใช้
- `user` — บันทึก/ปิดงานของตัวเอง
- `safety` — อนุมัติ Safety
- `admin` — ทุกอย่าง + จัดการข้อมูลหลัก + เปิดดำเนินการ + ตั้งเป้าหมาย/โบนัส

## โบนัส (ข้อ 13) — คิดจากจำนวนเรื่องที่ "เสร็จ" ต่อปี
| เรื่องเสร็จ | โบนัส |
|-----------|------|
| 4 | 5% |
| 5 | 7.5% |
| 6 ขึ้นไป | 10% |

ปรับเป้าหมาย/คน/ปี ได้ที่ เมนูตั้งค่า (Admin)
