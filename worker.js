/* ============================================================
 *  PSIF API — Cloudflare Worker
 *  Bindings (set in wrangler.toml / dashboard):
 *    DB     -> D1 database  (schema.sql)
 *    BUCKET -> R2 bucket     (photos)        [optional]
 *  Convention: every JSON response is { ok:true, ... } or { ok:false, error }.
 * ============================================================ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Emp-Id',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
const ok  = (extra = {}) => json({ ok: true, ...extra });
const err = (msg, status = 400) => json({ ok: false, error: String(msg) }, status);

const nowISO = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/* ---------------- actor & roles (ข้อ 3/6: เช็คสิทธิ์ที่ backend) ----------------
 * ตัวตนผู้เรียก: header X-Emp-Id (client ใหม่) → ?by= (DELETE เดิม) → fallbackId
 * (body._by ของ PATCH เดิม / reporter_id ตอนสร้าง) เพื่อไม่ให้ client เก่าที่ค้าง cache พัง
 * สำคัญ: role/แผนก อ่านจากตาราง employees ฝั่ง server เสมอ — ไม่เชื่อ role ที่ client ส่งมา */
async function getActor(env, request, fallbackId) {
  let id = request.headers.get('X-Emp-Id') || '';
  try { id = decodeURIComponent(id); } catch (_) { /* ค่าไม่ใช่ URI-encoded ก็ใช้ตามนั้น */ }
  if (!id) id = new URL(request.url).searchParams.get('by') || '';
  if (!id) id = fallbackId || '';
  id = String(id).trim();
  if (!id) return null;
  const emp = await env.DB.prepare(
    'SELECT id,name,vsm,role,active FROM employees WHERE id=? COLLATE NOCASE'
  ).bind(id).first();
  return (emp && emp.active !== 0) ? emp : null;
}

/* v2.5: Manager = สิทธิ์เท่ากับ Admin แผนก (ติดตาม/ดำเนินการ PSIF เฉพาะแผนกตัวเอง · เข้าเมนูตั้งค่าไม่ได้)
   รวมไว้จุดเดียว — เพิ่ม/ลด role ที่นี่ที่เดียว จะได้ไม่หลุดสิทธิ์บาง endpoint */
const DEPT_ADMIN_ROLES = ['dept_admin', 'manager'];
const isDeptAdminRole = r => DEPT_ADMIN_ROLES.includes(r);
/* ตั้งค่า/ข้อมูลหลักทั้งหมด = เฉพาะ Super Admin (role 'admin') — Safety/Dept Admin ถูกกันที่นี่ */
async function requireSuperAdmin(env, request, body) {
  const a = await getActor(env, request, body && body._by);
  if (!a) return err('ไม่ทราบตัวตนผู้ใช้ — โปรดรีเฟรชหน้าแอปแล้วเข้าสู่ระบบใหม่', 401);
  if (a.role !== 'admin') return err('เฉพาะ Super Admin เท่านั้น (เมนูตั้งค่า/ข้อมูลหลัก)', 403);
  return null;
}

/* ข้อ 2: ประเภทที่บังคับแนบรูป = PSIF (Con) เท่านั้น (ค่าใน DB คือ 'PSIF') */
const catIsCon = v => {
  v = String(v || '').trim().toLowerCase();
  return v === 'psif' || v === 'psif (con)' || v === 'psif(con)';
};
const hasRealPhoto = (ph, kind) => Array.isArray(ph) && ph.some(p => {
  const k = p && (p.key || p.r2_key);
  return k && !String(k).startsWith('data:') && (!kind || (p.kind || kind) === kind);
});
async function hasPhotoRow(env, id, kind) {
  const n = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM psif_photos WHERE psif_id=? AND kind=?').bind(id, kind).first();
  return !!(n && n.n);
}

/* v2.4 — "ส่งกลับให้แก้ไข" (status='returned')
 *  ข้อมูลเก่า/นำเข้าจาก Excel ไม่เคยมีรูปมาแต่ต้น จึงไม่ถูกกฎรูปบังคับ (ต้องตรงกับ isLegacyItem ใน index.html) */
const LEGACY_MAX_ID = 1702, PHOTO_RULE_SINCE = '2026-07-16';
const isLegacyRow = r => {
  if (!r) return true;
  if (/^import-/i.test(String(r.request_id || ''))) return true;
  if (+r.id && +r.id <= LEGACY_MAX_ID) return true;
  const d = String(r.created_at || '').slice(0, 10);
  return !d || d < PHOTO_RULE_SINCE;
};
/* ส่งกลับได้เฉพาะช่วงก่อนเริ่มงานจริง — เริ่มทำ/ปิดงานไปแล้วย้อนไปถ่าย "ก่อนแก้ไข" ไม่ได้ ใช้ระบบตามเก็บย้อนหลังแทน */
const RETURNABLE_STATUS = ['recorded', 'safety'];
const RETURN_REASON_CON = 'Safety เปลี่ยนประเภทเป็น PSIF (Con) — ประเภทนี้ต้องมีรูป "ก่อนแก้ไข" กรุณาไปถ่ายรูปจุดเดิมแล้วแนบเข้ามาใหม่';

/* ข้อ 4: "นับผลงาน" เฉพาะรายการที่ Safety อนุมัติ และ ดำเนินการจนจบ เท่านั้น */
const isCounted = r => r && r.safety_result === 'approved' && r.status === 'done';

/* ข้อ 1: idempotency — หา record จาก request_id (คอลัมน์อาจยังไม่ migrate → ถือว่าไม่ซ้ำ) */
async function findByRequestId(env, reqId) {
  try {
    return await env.DB.prepare('SELECT * FROM psif WHERE request_id=?').bind(reqId).first();
  } catch (_) { return null; }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const seg = url.pathname.replace(/^\/+|\/+$/g, '').split('/'); // e.g. ['psif','12']
    const head = seg[0] || '';
    try {
      // ---- photo serving is binary, handle before JSON router ----
      if (head === 'photo' && request.method === 'GET' && seg[1]) {
        return await servePhoto(env, decodeURIComponent(seg.slice(1).join('/')));
      }
      if (head === 'photo' && request.method === 'POST') {
        return await uploadPhoto(env, request);
      }

      switch (head) {
        case '':
        case 'health':    return ok({ service: 'psif', version: '2.5', time: nowISO() });
        case 'bootstrap': return await bootstrap(env);
        case 'psif':      return await psifRoute(env, request, seg);
        case 'employees':
          // ย้ายข้อมูล PSIF ระหว่างรหัสพนักงาน (เปลี่ยนรหัส / ลาออก) — ต้องมาก่อน CRUD ปกติ
          if (seg[1] === 'transfer') return await empTransferRoute(env, request);
          // วางรายชื่อจาก Excel ทีเดียวหลายคน (เพิ่ม/แก้ไข · ลาออก · เปลี่ยนรหัส)
          if (seg[1] === 'bulk')     return await empBulkRoute(env, request);
          return await crudRoute(env, request, seg, 'employees');
        case 'areas':     return await crudRoute(env, request, seg, 'areas');
        case 'categories':return await crudRoute(env, request, seg, 'categories');
        case 'targets':   return await targetsRoute(env, request);
        case 'issuances': return await issuancesRoute(env, request, seg);
        case 'dupe':      return await dupeRoute(env, url);
        case 'report':    return await reportRoute(env, url, seg);
        case 'import':    return await importRoute(env, request);
        case 'notifications': return await notifRoute(env, request, url, seg);
        default:          return err('not found: /' + head, 404);
      }
    } catch (e) {
      return err(e && e.message ? e.message : e, 500);
    }
  },
};

/* ---------------- bulk import (Admin: paste legacy Excel data, no photos) ---------------- */
async function importRoute(env, request) {
  if (request.method !== 'POST') return err('method not allowed', 405);
  const b = await request.json();
  const deny = await requireSuperAdmin(env, request, b);   // ข้อ 3/6: นำเข้าข้อมูล = Super Admin เท่านั้น
  if (deny) return deny;
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return err('no rows');
  const now = nowISO();
  // 2026-08-10: ติดป้ายให้แถวที่ "นำเข้า" (request_id ขึ้นต้นด้วย import-) — ข้อมูลย้ายระบบไม่มีรูป
  // มาแต่ต้น แอปจะได้ไม่ไปเตือนว่า "PSIF (Con) ขาดรูป" กับข้อมูลชุดนี้ (ดู isLegacyItem ใน index.html)
  const stamp = 'import-' + Date.now().toString(36);
  let n = 0;
  for (const r of rows) {
    const title = (r.title || (r.detail || '').slice(0, 120) || '(นำเข้าข้อมูล)');
    if (!(r.detail || r.title)) continue;
    const vals = [
      r.no || '', r.reporter_id || '', r.reporter_name || '', r.vsm || '', r.area_id || '', r.machine || '', r.category || '',
      title, r.detail || '', r.suggestion || '',
      r.status || 'recorded', r.safety_result || 'pending', r.safety_note || '', r.safety_at || '',
      r.done_detail || '', r.done_by || '', r.done_at || '',
      +r.year || new Date().getFullYear(), r.created_at || now, now,
    ];
    try {
      await env.DB.prepare(
        `INSERT INTO psif (no,reporter_id,reporter_name,vsm,area_id,machine,category,title,detail,suggestion,
           status,safety_result,safety_note,safety_at,done_detail,done_by,done_at,year,created_at,updated_at,request_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(...vals, `${stamp}-${n}`).run();
    } catch (e) {
      // ยังไม่ได้ run migration request_id → นำเข้าแบบเดิม (ยังกันด้วยวันที่/ช่วง id ฝั่งแอปอยู่)
      if (!/no such column/i.test(String((e && e.message) || e))) throw e;
      await env.DB.prepare(
        `INSERT INTO psif (no,reporter_id,reporter_name,vsm,area_id,machine,category,title,detail,suggestion,
           status,safety_result,safety_note,safety_at,done_detail,done_by,done_at,year,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(...vals).run();
    }
    n++;
  }
  return ok({ imported: n });
}

/* ---------------- bootstrap (one round-trip on app load) ---------------- */
async function bootstrap(env) {
  const [emp, areas, cats, tgts, iss] = await Promise.all([
    env.DB.prepare('SELECT * FROM employees ORDER BY id').all(),
    env.DB.prepare('SELECT * FROM areas WHERE active=1 ORDER BY name').all(),
    env.DB.prepare('SELECT * FROM categories WHERE active=1 ORDER BY rowid').all(),
    env.DB.prepare('SELECT * FROM targets ORDER BY year').all(),
    env.DB.prepare('SELECT * FROM issuances ORDER BY year, vsm').all(),
  ]);
  return ok({
    employees: emp.results, areas: areas.results, categories: cats.results,
    targets: tgts.results, issuances: iss.results,
  });
}

/* ---------------- PSIF records ---------------- */
async function psifRoute(env, request, seg) {
  const id = seg[1];

  if (request.method === 'GET' && !id) {
    const u = new URL(request.url);
    const where = [], bind = [];
    for (const f of ['status', 'reporter_id', 'vsm', 'category', 'safety_result']) {
      const v = u.searchParams.get(f);
      if (v) { where.push(`${f}=?`); bind.push(v); }
    }
    const year = u.searchParams.get('year');
    if (year) { where.push('year=?'); bind.push(+year); }
    // ข้อ 3: Admin แผนก / Manager เห็นเฉพาะแผนกตัวเอง — กรองที่ query ไม่ใช่แค่ซ่อน UI
    // (เรียกแบบไม่ระบุตัวตน เช่นตอนยังไม่ล็อกอิน = ไม่กรอง เหมือนเดิม เพื่อไม่ให้ bootstrap/login พัง)
    const actor = await getActor(env, request);
    if (actor && isDeptAdminRole(actor.role)) { where.push('vsm=?'); bind.push(actor.vsm || ''); }
    const sql = 'SELECT * FROM psif' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
                ' ORDER BY created_at DESC';
    const rows = (await env.DB.prepare(sql).bind(...bind).all()).results;
    await attachPhotos(env, rows);
    return ok({ items: rows });
  }

  if (request.method === 'GET' && id) {
    const row = await env.DB.prepare('SELECT * FROM psif WHERE id=?').bind(id).first();
    if (!row) return err('not found', 404);
    const actor = await getActor(env, request);
    if (actor && isDeptAdminRole(actor.role) &&
        (row.vsm || '').trim() !== (actor.vsm || '').trim() && row.reporter_id !== actor.id)
      return err('Admin แผนก / Manager เข้าถึงได้เฉพาะรายการของแผนกตัวเอง', 403);
    await attachPhotos(env, [row]);
    return ok({ item: row });
  }

  if (request.method === 'POST') {
    const b = await request.json();
    if (!b.reporter_id) return err('reporter_id required');
    // ข้อ 2: PSIF (Con) เท่านั้นที่บังคับแนบรูปก่อนแก้ไข — เช็คซ้ำฝั่ง server (อย่าเชื่อ frontend อย่างเดียว)
    if (catIsCon(b.category) && !hasRealPhoto(b.photos, 'before'))
      return err('ประเภท PSIF (Con) ต้องแนบรูปก่อนแก้ไข (บังคับ)');
    // title field was removed from the form — derive it from the detail
    const title = (b.title || (b.detail || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(ไม่มีหัวข้อ)');
    const year = b.year || new Date().getFullYear();
    const reqId = String(b.request_id || '').slice(0, 64);

    // ข้อ 1: idempotency — requestId เดิมถูกบันทึกไปแล้ว (double-click/retry) → คืน record เดิม ไม่สร้างซ้ำ
    if (reqId) {
      const dup = await findByRequestId(env, reqId);
      if (dup) {
        // 2026-08-10: เดิมคืนแถวเดิมเฉย ๆ — ถ้ารอบก่อนบันทึกแถวสำเร็จแต่ผูกรูปไม่สำเร็จ
        // (แล้วผู้ใช้กดบันทึกซ้ำ) แถวนั้นจะไม่มีรูปตลอดไป → ผูกรูปที่ส่งมารอบนี้ให้ครบก่อนคืน
        await attachMissingPhotos(env, dup.id, b.photos);
        await attachPhotos(env, [dup]); return ok({ item: dup, duplicate: true });
      }
    }

    const commonBind = [
      b.no || '', b.reporter_id, b.reporter_name || '', b.vsm || '', b.area_id || '',
      b.machine || '', b.category || '', title, b.detail || '', b.suggestion || '', year,
    ];
    let newId = null;
    try {
      const r = await env.DB.prepare(
        `INSERT INTO psif (no,reporter_id,reporter_name,vsm,area_id,machine,category,title,detail,suggestion,year,status,request_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'recorded', ?,?,?)`
      ).bind(...commonBind, reqId, nowISO(), nowISO()).run();
      newId = r.meta.last_row_id;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (reqId && /UNIQUE|constraint/i.test(msg)) {
        // สอง request ยิงพร้อมกันเป๊ะ — unique index (DB ชั้นสุดท้าย) กันไว้ → คืนแถวที่สำเร็จไปแล้ว
        const dup = await findByRequestId(env, reqId);
        if (dup) { await attachPhotos(env, [dup]); return ok({ item: dup, duplicate: true }); }
        throw e;
      } else if (/no such column/i.test(msg)) {
        // ยังไม่ได้ run migration (request_id) — insert แบบเดิมไปก่อน ไม่ให้ระบบล่ม (ควรรีบ run migration)
        const r = await env.DB.prepare(
          `INSERT INTO psif (no,reporter_id,reporter_name,vsm,area_id,machine,category,title,detail,suggestion,year,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?, 'recorded', ?,?)`
        ).bind(...commonBind, nowISO(), nowISO()).run();
        newId = r.meta.last_row_id;
      } else throw e;
    }
    // attach any photos already uploaded (req #2: before-photo)
    if (Array.isArray(b.photos)) {
      for (const p of b.photos) {
        const k = p && (p.key || p.r2_key);
        if (k && !k.startsWith('data:')) await addPhoto(env, newId, p.kind || 'before', k);
      }
    }
    // แจ้งกลุ่มผู้ดูแลเมื่อมีเรื่องใหม่: Super Admin + Safety ทุกคน และ Admin แผนก/Manager ของหน่วยงานนั้น (ข้อ 3)
    try {
      const mgrs = (await env.DB.prepare(
        "SELECT id FROM employees WHERE active=1 AND (role IN ('admin','safety') OR (role IN ('dept_admin','manager') AND vsm=?))"
      ).bind(b.vsm || '').all()).results;
      const rn = b.reporter_name || b.reporter_id;
      const t = title.slice(0, 40);
      for (const m of mgrs) {
        if (m.id === b.reporter_id) continue;
        await notify(env, m.id, newId, `🆕 เรื่องใหม่จาก ${rn}: "${t}"`, b.reporter_id, b.reporter_name || '');
      }
    } catch (_) { /* notifications table missing — don't break the create */ }
    const row = await env.DB.prepare('SELECT * FROM psif WHERE id=?').bind(newId).first();
    await attachPhotos(env, [row]);
    return ok({ item: row });
  }

  if (request.method === 'PATCH' && id) {
    const b = await request.json();
    const oldRow = await env.DB.prepare('SELECT * FROM psif WHERE id=?').bind(id).first();
    if (!oldRow) return err('not found', 404);

    /* ---- ข้อ 3/6: สิทธิ์แก้ไขเช็คที่ backend (role จากตาราง employees ไม่ใช่จาก client) ----
     *  Super Admin ('admin')  : ทุกฟิลด์ ทุกแผนก
     *  Dept Admin / Manager   : เนื้อหา + workflow (ออกเลข/ปิดงาน) เฉพาะแผนกตัวเอง — ห้ามแตะผลตรวจ Safety
     *  Safety                 : ผลตรวจ + แก้เนื้อหา (ตามสิทธิ์เดิม) — ห้ามออกเลข/ปิดงานของคนอื่น
     *  ผู้รายงานเอง            : ปิดงานเรื่องของตัวเองเท่านั้น */
    const actor = await getActor(env, request, b._by);
    if (!actor) return err('ไม่ทราบตัวตนผู้ใช้ — โปรดรีเฟรชหน้าแอปแล้วเข้าสู่ระบบใหม่', 401);
    const superA = actor.role === 'admin';
    const sameDept = (oldRow.vsm || '').trim() === (actor.vsm || '').trim();
    const deptA = isDeptAdminRole(actor.role) && sameDept;
    const safeA = actor.role === 'safety' || superA;
    const isReporter = actor.id === oldRow.reporter_id;
    if (isDeptAdminRole(actor.role) && !sameDept && !isReporter)
      return err('Admin แผนก / Manager จัดการได้เฉพาะรายการของแผนกตัวเอง', 403);

    const CONTENT_FIELDS = ['no','reporter_name','vsm','area_id','machine','category','title','detail','suggestion'];
    const SAFETY_FIELDS  = ['safety_result','safety_note','safety_by','safety_at'];
    const CLOSE_FIELDS   = ['done_detail','done_by','done_at'];
    // v2.4: เหตุผลที่ส่งกลับ — Safety เป็นคนเขียน · ผู้รายงาน/Admin แผนก ล้างได้ตอนส่งกลับเข้าระบบ
    const RETURN_FIELDS  = ['return_reason'];
    const ALL_FIELDS     = [...CONTENT_FIELDS, ...SAFETY_FIELDS, ...CLOSE_FIELDS, ...RETURN_FIELDS, 'status'];
    const permitted = new Set();
    if (superA)     ALL_FIELDS.forEach(k => permitted.add(k));
    if (deptA)      [...CONTENT_FIELDS, ...CLOSE_FIELDS, ...RETURN_FIELDS, 'status'].forEach(k => permitted.add(k));
    if (safeA)      [...CONTENT_FIELDS, ...SAFETY_FIELDS, ...RETURN_FIELDS, 'status'].forEach(k => permitted.add(k));
    if (isReporter) [...CLOSE_FIELDS, ...RETURN_FIELDS, 'status'].forEach(k => permitted.add(k));
    for (const k of ALL_FIELDS)
      if (k in b && !permitted.has(k)) return err(`สิทธิ์ไม่พอสำหรับแก้ไขข้อมูลนี้ (${k})`, 403);
    if ('status' in b) {
      const st = b.status;
      // v2.4: 'returned' = Safety ส่งกลับ · กลับเข้าคิวเป็น 'recorded' ได้เฉพาะเรื่องที่ถูกส่งกลับอยู่
      const backToQueue = st === 'recorded' && oldRow.status === 'returned';
      const okStatus = superA
        || (deptA && (['inprogress', 'done'].includes(st) || backToQueue))
        || (safeA && (['safety', 'returned'].includes(st) || backToQueue))
        || (isReporter && (st === 'done' || backToQueue));
      if (!okStatus) return err(`สิทธิ์ไม่พอสำหรับเปลี่ยนสถานะเป็น "${st}"`, 403);
    }

    /* ---- v2.4: เรื่องที่ถูกส่งกลับถูกบล็อกไว้ — ออกได้ทางเดียวคือกลับเข้าคิว Safety ('recorded') ---- */
    if (oldRow.status === 'returned') {
      if ('safety_result' in b && b.safety_result !== 'pending')
        return err('เรื่องนี้ถูกส่งกลับให้ผู้รายงานแก้ไข — ต้องส่งกลับเข้าระบบก่อนจึงจะบันทึกผลตรวจได้');
      if ('status' in b && b.status !== 'returned') {
        if (b.status !== 'recorded')
          return err('เรื่องนี้ถูกส่งกลับให้ผู้รายงานแก้ไข — ยังเดินงานต่อไม่ได้จนกว่าจะส่งกลับเข้าระบบ');
        // ผู้รายงาน/Admin แผนก จะส่งกลับเข้าระบบได้ต่อเมื่อรูปที่ขาดครบแล้ว
        // (Safety/Super Admin ยกเลิกการส่งกลับเองได้ ไม่ต้องรอรูป — เผื่อกดส่งกลับผิดเรื่อง)
        if (!safeA && catIsCon(b.category ?? oldRow.category) && !isLegacyRow(oldRow)
            && !hasRealPhoto(b.photos, 'before') && !(await hasPhotoRow(env, id, 'before')))
          return err('ต้องแนบรูป "ก่อนแก้ไข" ก่อน จึงจะส่งเรื่องกลับเข้าระบบได้');
      }
    }

    /* ---- v2.4: เปลี่ยนประเภทเป็น PSIF (Con) แล้วไม่มีรูป "ก่อนแก้ไข" → ส่งกลับให้ไปถ่ายมาใหม่ ----
     *  บังคับที่ backend ด้วย ไม่ใช่แค่หน้าจอ — Admin แผนก (ที่ตั้งสถานะ 'returned' เองไม่ได้)
     *  หรือ client รุ่นเก่า ก็ต้องไม่ทำให้เกิดเรื่อง PSIF (Con) ไร้รูปก่อนหลุดเข้าคิวอนุมัติ */
    if ('category' in b && catIsCon(b.category) && !catIsCon(oldRow.category) && !isLegacyRow(oldRow)
        && RETURNABLE_STATUS.includes(b.status ?? oldRow.status)
        && !hasRealPhoto(b.photos, 'before') && !(await hasPhotoRow(env, id, 'before'))) {
      b.status = 'returned';
      if (!b.return_reason) b.return_reason = RETURN_REASON_CON;
      b.safety_result = 'pending'; b.safety_note = '';
      b.safety_by = actor.id; b.safety_at = nowISO();
    }

    // ข้อ 2: ปิดงานประเภท PSIF (Con) ต้องมีรูปหลังแก้ไข (มีอยู่แล้วใน DB หรือแนบมากับคำขอนี้)
    if (b.status === 'done' && oldRow.status !== 'done' && catIsCon(b.category ?? oldRow.category)) {
      const hasNewAfter = hasRealPhoto(b.photos, 'after');
      if (!hasNewAfter) {
        const n = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM psif_photos WHERE psif_id=? AND kind='after'").bind(id).first();
        if (!n || !n.n) return err('ประเภท PSIF (Con) ต้องแนบรูปหลังแก้ไขก่อนปิดงาน');
      }
    }

    const sets = [], bind = [];
    for (const k of ALL_FIELDS) {
      if (k in b) { sets.push(`${k}=?`); bind.push(b[k]); }
    }
    if (sets.length) {
      sets.push('updated_at=?'); bind.push(nowISO());
      bind.push(id);
      try {
        await env.DB.prepare(`UPDATE psif SET ${sets.join(',')} WHERE id=?`).bind(...bind).run();
      } catch (e) {
        // ยังไม่ได้รัน migrate-2026-08-23-return-reason.sql — เขียนฟิลด์อื่นให้ผ่านไปก่อน อย่าให้ทั้ง PATCH ล่ม
        if (!/return_reason/i.test(String(e && e.message))) throw e;
        const keys = ALL_FIELDS.filter(k => k in b && k !== 'return_reason');
        const s2 = keys.map(k => `${k}=?`), b2 = keys.map(k => b[k]);
        if (s2.length) {
          s2.push('updated_at=?'); b2.push(nowISO()); b2.push(id);
          await env.DB.prepare(`UPDATE psif SET ${s2.join(',')} WHERE id=?`).bind(...b2).run();
        }
      }
    }
    // req: notify the reporter whenever someone else acts on their record
    if (oldRow.reporter_id && actor.id !== oldRow.reporter_id) {
      for (const m of notifMessages(oldRow, b)) {
        await notify(env, oldRow.reporter_id, +id, m, actor.id, b._by_name || actor.name || '');
      }
    }
    /* v2.4: เรื่องที่ส่งกลับไป ถ้าผู้รายงานแก้แล้วส่งกลับเข้าระบบ ต้องบอกคน Safety ที่ส่งกลับด้วย
       ไม่งั้นเรื่องจะไปนอนอยู่ท้ายคิวโดยไม่มีใครรู้ว่ามันกลับมาแล้ว */
    if (oldRow.status === 'returned' && b.status === 'recorded'
        && oldRow.safety_by && oldRow.safety_by !== actor.id) {
      await notify(env, oldRow.safety_by, +id,
        `📨 ${oldRow.reporter_name || oldRow.reporter_id} แก้ไขและส่งเรื่อง "${(oldRow.title || '').slice(0, 40)}" กลับเข้าระบบแล้ว — รอตรวจอีกครั้ง`,
        actor.id, b._by_name || actor.name || '');
    }
    // 2026-08-10: แนบรูป (รวม "แนบย้อนหลัง" ของ PSIF (Con) ที่รูปขาด) —
    // เดิมไม่เช็คสิทธิ์เลย ตอนนี้จำกัดที่ เจ้าของเรื่อง · Admin แผนกนั้น · Safety · Super Admin
    if (Array.isArray(b.photos) && b.photos.length) {
      if (!(superA || deptA || safeA || isReporter))
        return err('สิทธิ์ไม่พอสำหรับแนบรูปของรายการนี้', 403);
      let added = 0;
      for (const p of b.photos) {
        const k = p && (p.key || p.r2_key);
        if (!k || String(k).startsWith('data:')) continue;
        await addPhoto(env, id, (p.kind === 'before' ? 'before' : 'after'), k);
        added++;
      }
      // แนบรูปอย่างเดียวโดยไม่แก้ฟิลด์อื่น ก็ถือว่ารายการถูกแก้ไข — ขยับ updated_at ให้ตรงความจริง
      if (added && !sets.length)
        await env.DB.prepare('UPDATE psif SET updated_at=? WHERE id=?').bind(nowISO(), id).run();
    }
    const row = await env.DB.prepare('SELECT * FROM psif WHERE id=?').bind(id).first();
    if (!row) return err('not found', 404);
    await attachPhotos(env, [row]);
    return ok({ item: row });
  }

  if (request.method === 'DELETE' && id) {
    const u = new URL(request.url);
    // ข้อ 3: ลบรายการ = Super Admin เท่านั้น (เดิม backend ไม่เช็คเลย)
    const actor = await getActor(env, request);
    if (!actor) return err('ไม่ทราบตัวตนผู้ใช้ — โปรดรีเฟรชหน้าแอปแล้วเข้าสู่ระบบใหม่', 401);
    if (actor.role !== 'admin') return err('เฉพาะ Super Admin เท่านั้นที่ลบรายการได้', 403);
    const row = await env.DB.prepare('SELECT reporter_id,title FROM psif WHERE id=?').bind(id).first();
    const photos = (await env.DB.prepare('SELECT r2_key FROM psif_photos WHERE psif_id=?').bind(id).all()).results;
    if (env.BUCKET) { for (const p of photos) { try { await env.BUCKET.delete(p.r2_key); } catch (_) {} } }
    await env.DB.prepare('DELETE FROM psif_photos WHERE psif_id=?').bind(id).run();
    await env.DB.prepare('DELETE FROM psif WHERE id=?').bind(id).run();
    if (row && row.reporter_id && actor.id !== row.reporter_id) {
      await notify(env, row.reporter_id, +id,
        `🗑️ เรื่อง "${(row.title || '').slice(0, 40)}" ถูกลบออกจากระบบ`,
        actor.id, u.searchParams.get('by_name') || actor.name || '');
    }
    return ok({ deleted: id });
  }
  return err('method not allowed', 405);
}

/* ---------------- notifications (req: alert the reporter on any action) ---------------- */
function notifMessages(oldRow, b) {
  const t = (oldRow.title || '').slice(0, 40);
  const msgs = [];
  if (b.safety_result === 'approved' && oldRow.safety_result !== 'approved')
    msgs.push(`✅ Safety อนุมัติเรื่อง "${t}"${b.safety_note ? ' — ' + b.safety_note : ''}`);
  if (b.safety_result === 'not_cardinal' && oldRow.safety_result !== 'not_cardinal')
    msgs.push(`⚠️ Safety: เรื่อง "${t}" ไม่เข้าข่าย PSIF Cardinal rules${b.safety_note ? ' — ' + b.safety_note : ''}`);
  if (b.safety_result === 'duplicate' && oldRow.safety_result !== 'duplicate')
    msgs.push(`🔁 Safety: เรื่อง "${t}" เป็นเรื่องซ้ำ${b.safety_note ? ' — ' + b.safety_note : ''}`);
  if (b.safety_result === 'rejected' && oldRow.safety_result !== 'rejected')
    msgs.push(`❌ Safety ไม่อนุมัติเรื่อง "${t}"${b.safety_note ? ' — ' + b.safety_note : ''}`);
  // v2.4: ส่งกลับให้แก้ไข — ข้อความนี้คือสิ่งที่บอกพนักงานว่า "ต้องไปถ่ายรูปมาใหม่"
  const justReturned = b.status === 'returned' && oldRow.status !== 'returned';
  if (justReturned)
    msgs.push(`↩️ Safety ส่งเรื่อง "${t}" กลับให้แก้ไข${b.return_reason ? ' — ' + b.return_reason : ''}`);
  if (b.status === 'recorded' && oldRow.status === 'returned')
    msgs.push(`📨 เรื่อง "${t}" ถูกส่งกลับเข้าระบบแล้ว — รอ Safety ตรวจอีกครั้ง`);
  if (b.status === 'inprogress' && oldRow.status !== 'inprogress')
    msgs.push(`🚀 เรื่อง "${t}" เริ่มดำเนินการแล้ว${b.no ? ' (No.' + b.no + ')' : ''}`);
  if (b.status === 'done' && oldRow.status !== 'done')
    msgs.push(`🏁 เรื่อง "${t}" ปิดงานเรียบร้อยแล้ว`);
  const edited = ['title', 'detail', 'suggestion', 'category', 'machine', 'area_id']
    .some(k => k in b && String(b[k] ?? '') !== String(oldRow[k] ?? ''));
  // ตอนส่งกลับมักแก้ประเภทไปพร้อมกัน — เหตุผลที่ส่งกลับบอกครบแล้ว ไม่ต้องยิงซ้ำอีกข้อความ
  if (edited && !justReturned) msgs.push(`✏️ มีการแก้ไขเนื้อหาเรื่อง "${t}"`);
  return msgs;
}
async function notify(env, empId, psifId, message, byId, byName) {
  try {
    await env.DB.prepare(
      'INSERT INTO notifications (employee_id,psif_id,message,by_id,by_name,is_read,created_at) VALUES (?,?,?,?,?,0,?)'
    ).bind(empId, psifId, message, byId || '', byName || '', nowISO()).run();
  } catch (_) { /* table missing — don't break the main action */ }
}
async function notifRoute(env, request, url, seg) {
  if (request.method === 'GET') {
    const emp = url.searchParams.get('employee_id');
    if (!emp) return err('employee_id required');
    const rows = (await env.DB.prepare(
      'SELECT * FROM notifications WHERE employee_id=? ORDER BY id DESC LIMIT 50').bind(emp).all()).results;
    const unread = (await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM notifications WHERE employee_id=? AND is_read=0').bind(emp).first())?.n || 0;
    return ok({ items: rows, unread });
  }
  if (request.method === 'POST' && seg[1] === 'read') {
    const b = await request.json();
    if (!b.employee_id) return err('employee_id required');
    await env.DB.prepare('UPDATE notifications SET is_read=1 WHERE employee_id=?').bind(b.employee_id).run();
    return ok({});
  }
  return err('method not allowed', 405);
}

async function addPhoto(env, psifId, kind, key) {
  await env.DB.prepare('INSERT INTO psif_photos (psif_id,kind,r2_key,uploaded_at) VALUES (?,?,?,?)')
    .bind(psifId, kind, key, nowISO()).run();
}
/* ผูกเฉพาะรูป "ชนิดที่ยังไม่มี" ให้แถวเดิม (2026-08-10)
 * ใช้ตอน retry ที่ request_id ซ้ำ: ถ้ารอบก่อนผูกรูปไว้แล้วจะไม่ผูกซ้ำ ถ้ายังขาดจึงเติมให้ */
async function attachMissingPhotos(env, psifId, photos) {
  if (!Array.isArray(photos) || !photos.length) return 0;
  const have = new Set(((await env.DB.prepare(
    'SELECT DISTINCT kind FROM psif_photos WHERE psif_id=?').bind(psifId).all()).results || []).map(r => r.kind));
  let n = 0;
  for (const p of photos) {
    const k = p && (p.key || p.r2_key);
    const kind = (p && p.kind) || 'before';
    if (!k || String(k).startsWith('data:') || have.has(kind)) continue;
    await addPhoto(env, psifId, kind, k);
    have.add(kind); n++;
  }
  return n;
}
async function attachPhotos(env, rows) {
  if (!rows.length) return;
  const ids = rows.map(r => r.id);
  // D1 caps bound parameters at ~100 per query, so chunk the IN(...) lookup.
  // Without this, loading many records (e.g. after a bulk import) throws
  // "too many SQL variables" and breaks the whole /psif (and app bootstrap).
  const ph = [];
  const CHUNK = 90;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const part = (await env.DB.prepare(
      `SELECT id,psif_id,kind,r2_key FROM psif_photos WHERE psif_id IN (${slice.map(()=>'?').join(',')})`
    ).bind(...slice).all()).results;
    for (const p of part) ph.push(p);
  }
  // Optional: serve straight from an R2 public bucket / custom domain to take
  // load off the Worker. Set the R2_PUBLIC_BASE var to enable (e.g.
  // https://pub-xxxx.r2.dev  or  https://photos.yourdomain.com). If unset, the
  // app falls back to streaming via this Worker's GET /photo/:key.
  const base = env.R2_PUBLIC_BASE ? env.R2_PUBLIC_BASE.replace(/\/+$/, '') : '';
  const byId = {};
  for (const p of ph) (byId[p.psif_id] ||= []).push({
    id: p.id, kind: p.kind, key: p.r2_key,
    url: base ? base + '/' + p.r2_key : undefined,
  });
  for (const r of rows) r.photos = byId[r.id] || [];
}

/* ---------------- photos (R2) ---------------- */
async function uploadPhoto(env, request) {
  if (!env.BUCKET) return err('R2 bucket (BUCKET) not bound — see README', 501);
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return err('file field required');
  const psifId = form.get('psif_id') || 'tmp';
  const kind   = form.get('kind') || 'before';
  const ext = (file.name && file.name.includes('.')) ? file.name.split('.').pop().toLowerCase() : 'jpg';
  const key = `psif/${psifId}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
  });
  return ok({ key });
}
async function servePhoto(env, key) {
  if (!env.BUCKET) return err('R2 bucket not bound', 501);
  const obj = await env.BUCKET.get(key);
  if (!obj) return err('photo not found', 404);
  const h = new Headers(CORS);
  obj.writeHttpMetadata(h);
  h.set('Cache-Control', 'public, max-age=31536000');
  return new Response(obj.body, { headers: h });
}

/* ---------------- หน่วยงานบนใบ PSIF ต้องเดินตามแผนกปัจจุบันของเจ้าของเรื่อง (2026-08-20) ----------------
 *  psif.vsm ถูกคัดลอกไว้ตอน "ส่งเรื่อง" — ถ้าคนย้ายแผนก/แผนกเปลี่ยนชื่อ ใบเก่าจะค้างอยู่แผนกเดิม
 *  ผลคือ: แดชบอร์ดนับเข้ากลุ่มที่ไม่มีแล้ว · Admin แผนกใหม่มองไม่เห็นใบเก่า (scope ที่ vsm=?)
 *          · ประตู "เปิดดำเนินการ" (issuances) ไปถามหาแผนกเดิม
 *  จึงย้ายใบตามทุกครั้งที่แผนกของพนักงานถูกแก้ */
async function syncPsifVsm(env, empId, vsm) {
  const id = String(empId || '').trim();
  if (!id) return 0;
  const v = String(vsm == null ? '' : vsm).trim();
  const r = await env.DB.prepare(
    "UPDATE psif SET vsm=?, updated_at=? WHERE reporter_id=? COLLATE NOCASE AND TRIM(COALESCE(vsm,''))<>?"
  ).bind(v, nowISO(), id, v).run();
  return (r && r.meta && r.meta.changes) || 0;
}

/* ---------------- generic CRUD (employees / areas / categories) ---------------- */
async function crudRoute(env, request, seg, table) {
  const id = seg[1];
  if (request.method === 'GET') {
    const rows = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
    return ok({ items: rows });
  }
  if (request.method === 'POST') { // upsert
    const b = await request.json();
    const deny = await requireSuperAdmin(env, request, b);   // ข้อ 3/6: แก้ข้อมูลหลัก = Super Admin เท่านั้น
    if (deny) return deny;
    if (!b.id || !b.name) return err('id and name required');
    if (table === 'employees') {
      await env.DB.prepare(
        `INSERT INTO employees (id,name,vsm,role,active) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, vsm=excluded.vsm, role=excluded.role, active=excluded.active`
      ).bind(b.id, b.name, b.vsm || '', b.role || 'user', b.active ?? 1).run();
      await syncPsifVsm(env, b.id, b.vsm || '');            // ย้ายแผนก → ใบเก่าตามไปด้วย
    } else if (table === 'areas') {
      await env.DB.prepare(
        `INSERT INTO areas (id,name,vsm,active) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, vsm=excluded.vsm, active=excluded.active`
      ).bind(b.id, b.name, b.vsm || '', b.active ?? 1).run();
    } else { // categories
      await env.DB.prepare(
        `INSERT INTO categories (id,name,active) VALUES (?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, active=excluded.active`
      ).bind(b.id, b.name, b.active ?? 1).run();
    }
    return ok({ id: b.id });
  }
  if (request.method === 'DELETE' && id) {
    const deny = await requireSuperAdmin(env, request);
    if (deny) return deny;
    await env.DB.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id).run();
    return ok({ deleted: id });
  }
  return err('method not allowed', 405);
}

/* ---------------- ย้ายข้อมูล PSIF ระหว่างรหัสพนักงาน (2026-08-02) ----------------
 *  POST /employees/transfer  { from, to, mode:'rename'|'resign', to_name?, to_vsm? }
 *  rename = พนักงานคนเดิมเปลี่ยนรหัส  → ย้ายทุกอย่าง (รายการ/ผู้ปิดงาน/ผู้ตรวจ/แจ้งเตือน) แล้ว "ลบรหัสเก่า"
 *  resign = พนักงานลาออก             → ย้ายรายการไป "ช่องว่าง" ของแผนก แล้วปิดใช้งานรหัสเดิม (active=0)
 *  ทั้งสองแบบ = Super Admin เท่านั้น (ข้อมูลหลัก) */
async function empTransferRoute(env, request) {
  if (request.method !== 'POST') return err('method not allowed', 405);
  const b = await request.json();
  const deny = await requireSuperAdmin(env, request, b);
  if (deny) return deny;
  try {
    const r = await doTransfer(env, b);
    return ok(r);
  } catch (e) {
    return err((e && e.message) || String(e), (e && e.status) || 400);
  }
}

/* แกนกลางการย้ายข้อมูล — ใช้ร่วมกันระหว่างย้ายทีละคน (/employees/transfer)
   และวางรายชื่อทีเดียวหลายคนจาก Excel (/employees/bulk) */
async function doTransfer(env, b) {
  const from = String((b && b.from) || '').trim();
  const to   = String((b && b.to)   || '').trim();
  const mode = b && b.mode === 'resign' ? 'resign' : 'rename';
  if (!from || !to) throw new Error('ต้องระบุรหัสเดิม (from) และรหัสปลายทาง (to)');
  if (from.toUpperCase() === to.toUpperCase()) throw new Error('รหัสเดิมกับรหัสปลายทางซ้ำกัน');

  const src = await env.DB.prepare('SELECT * FROM employees WHERE id=? COLLATE NOCASE').bind(from).first();
  if (!src) { const e = new Error('ไม่พบรหัสพนักงานเดิม: ' + from); e.status = 404; throw e; }

  let dst = await env.DB.prepare('SELECT * FROM employees WHERE id=? COLLATE NOCASE').bind(to).first();
  if (!dst) {   // ปลายทางยังไม่มี → สร้างให้ (ช่องว่างของแผนก หรือ รหัสใหม่ของคนเดิม)
    await env.DB.prepare('INSERT INTO employees (id,name,vsm,role,active) VALUES (?,?,?,?,1)')
      .bind(to,
            b.to_name || (mode === 'resign' ? to : src.name),
            b.to_vsm != null ? b.to_vsm : (src.vsm || ''),
            mode === 'resign' ? 'user' : (src.role || 'user')).run();
    dst = await env.DB.prepare('SELECT * FROM employees WHERE id=?').bind(to).first();
  }
  const name = dst.name || src.name || '';

  const r = await env.DB.prepare(
    'UPDATE psif SET reporter_id=?, reporter_name=?, updated_at=? WHERE reporter_id=? COLLATE NOCASE'
  ).bind(dst.id, name, nowISO(), from).run();
  const moved = (r && r.meta && r.meta.changes) || 0;
  // ใบที่ย้ายมาต้องอยู่แผนกของรหัสปลายทาง (รหัสใหม่ของคนเดิม / "ช่องว่าง" ของแผนกที่ลาออก)
  await syncPsifVsm(env, dst.id, dst.vsm || '');

  if (mode === 'rename') {
    // คนเดิม รหัสใหม่ → ประวัติผู้ดำเนินการ/ผู้ตรวจ และการแจ้งเตือน ต้องตามไปด้วย
    await env.DB.prepare('UPDATE psif SET done_by=?   WHERE done_by=?   COLLATE NOCASE').bind(dst.id, from).run();
    await env.DB.prepare('UPDATE psif SET safety_by=? WHERE safety_by=? COLLATE NOCASE').bind(dst.id, from).run();
    try {
      await env.DB.prepare('UPDATE notifications SET employee_id=? WHERE employee_id=? COLLATE NOCASE').bind(dst.id, from).run();
      await env.DB.prepare('UPDATE notifications SET by_id=?       WHERE by_id=?       COLLATE NOCASE').bind(dst.id, from).run();
    } catch (_) { /* ไม่มีตาราง notifications ก็ไม่ต้องล้ม */ }
    await env.DB.prepare('DELETE FROM employees WHERE id=? COLLATE NOCASE').bind(from).run();
  } else {
    await env.DB.prepare('UPDATE employees SET active=0 WHERE id=? COLLATE NOCASE').bind(from).run();
  }
  return { from, to: dst.id, mode, moved, employee: dst };
}

/* ---------------- วางรายชื่อพนักงานจาก Excel ทีเดียวหลายคน (2026-08-18) ----------------
 *  POST /employees/bulk  { mode:'upsert'|'resign'|'rename', rows:[...] }
 *    upsert → rows: { id, name, vsm?, role? }            เพิ่มรายชื่อใหม่ / แก้ไขรายชื่อเดิม
 *    resign → rows: { from, to, to_name?, to_vsm? }      ย้ายข้อมูลไป "ช่องว่าง" ของแผนก แล้วปิดรหัสเดิม
 *    rename → rows: { from, to, to_name?, to_vsm? }      คนเดิมได้รหัสใหม่ ย้ายข้อมูลตาม แล้วลบรหัสเก่า
 *  ทำทีละแถวและรายงานผลรายแถว — แถวที่พังไม่ทำให้ทั้งชุดล้ม (Super Admin เท่านั้น) */
async function empBulkRoute(env, request) {
  if (request.method !== 'POST') return err('method not allowed', 405);
  const b = await request.json();
  const deny = await requireSuperAdmin(env, request, b);
  if (deny) return deny;

  const mode = ['upsert', 'resign', 'rename'].includes(b.mode) ? b.mode : '';
  if (!mode) return err('mode ต้องเป็น upsert / resign / rename');
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return err('no rows');
  if (rows.length > 2000) return err('มากเกินไป — วางได้ครั้งละไม่เกิน 2000 แถว');

  const results = [];
  let done = 0, failed = 0, moved = 0;
  for (const r of rows) {
    try {
      if (mode === 'upsert') {
        const id = String(r.id || '').trim(), name = String(r.name || '').trim();
        if (!id || !name) throw new Error('ต้องมีรหัสพนักงานและชื่อ');
        await env.DB.prepare(
          `INSERT INTO employees (id,name,vsm,role,active) VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, vsm=excluded.vsm, role=excluded.role, active=excluded.active`
        ).bind(id, name, r.vsm || '', r.role || 'user', r.active == null ? 1 : r.active).run();
        const rev = await syncPsifVsm(env, id, r.vsm || ''); // ย้ายแผนก → ใบเก่าตามไปด้วย
        results.push({ id, revsm: rev, ok: true });
      } else {
        const d = await doTransfer(env, { ...r, mode });
        moved += d.moved || 0;
        results.push({ id: r.from, to: d.to, moved: d.moved || 0, ok: true });
      }
      done++;
    } catch (e) {
      failed++;
      results.push({ id: r.id || r.from || '', ok: false, error: (e && e.message) || String(e) });
    }
  }
  return ok({ mode, done, failed, moved, results });
}

/* ---------------- targets ---------------- */
async function targetsRoute(env, request) {
  if (request.method === 'GET') {
    const rows = (await env.DB.prepare('SELECT * FROM targets ORDER BY year').all()).results;
    return ok({ items: rows });
  }
  if (request.method === 'POST') {
    const b = await request.json();
    const deny = await requireSuperAdmin(env, request, b);   // ข้อ 3/6: ตั้งเป้าหมาย = Super Admin เท่านั้น
    if (deny) return deny;
    const year = +b.year || new Date().getFullYear();
    await env.DB.prepare(
      `INSERT INTO targets (year,per_person_target) VALUES (?,?)
       ON CONFLICT(year) DO UPDATE SET per_person_target=excluded.per_person_target`
    ).bind(year, +b.per_person_target || 6).run();
    return ok({ year });
  }
  return err('method not allowed', 405);
}

/* ---------------- issuances (req #6) ---------------- */
async function issuancesRoute(env, request, seg) {
  const id = seg[1];
  if (request.method === 'GET') {
    const rows = (await env.DB.prepare('SELECT * FROM issuances ORDER BY year,vsm').all()).results;
    return ok({ items: rows });
  }
  if (request.method === 'POST') {
    const b = await request.json();
    const deny = await requireSuperAdmin(env, request, b);   // ข้อ 3/6: เปิดดำเนินการ = Super Admin เท่านั้น
    if (deny) return deny;
    if (!b.vsm) return err('vsm required');
    const year = +b.year || new Date().getFullYear();
    const r = await env.DB.prepare(
      'INSERT INTO issuances (vsm,year,requested_by,requested_at) VALUES (?,?,?,?)'
    ).bind(b.vsm, year, b.requested_by || '', nowISO()).run();
    return ok({ id: r.meta.last_row_id });
  }
  if (request.method === 'DELETE' && id) {
    const deny = await requireSuperAdmin(env, request);
    if (deny) return deny;
    await env.DB.prepare('DELETE FROM issuances WHERE id=?').bind(id).run();
    return ok({ deleted: id });
  }
  return err('method not allowed', 405);
}

/* ---------------- duplicate / similar check (req #3,#4) ----------------
 * keyword overlap on title + same machine. No AI. */
async function dupeRoute(env, url) {
  const title   = (url.searchParams.get('title') || '').trim();
  const machine = (url.searchParams.get('machine') || '').trim();
  const year    = url.searchParams.get('year');
  const excludeId = url.searchParams.get('exclude');

  const where = [], bind = [];
  if (year) { where.push('year=?'); bind.push(+year); }
  if (excludeId) { where.push('id<>?'); bind.push(+excludeId); }
  const sql = 'SELECT id,no,title,machine,category,status,reporter_name,created_at FROM psif' +
              (where.length ? ' WHERE ' + where.join(' AND ') : '') +
              ' ORDER BY created_at DESC LIMIT 500';
  const rows = (await env.DB.prepare(sql).bind(...bind).all()).results;

  const toks = tokenize(title);
  const machineN = norm(machine);
  const scored = [];
  for (const r of rows) {
    let score = 0;
    const sameMachine = machineN && norm(r.machine) === machineN;
    if (sameMachine) score += 0.4;
    const rt = tokenize(r.title);
    const overlap = jaccard(toks, rt);
    score += overlap * 0.6;
    if (score >= 0.25 || (sameMachine && overlap > 0)) {
      scored.push({ ...r, _score: Math.round(score * 100), same_machine: sameMachine });
    }
  }
  scored.sort((a, b) => b._score - a._score);
  return ok({ candidates: scored.slice(0, 8) });
}
function norm(s) { return (s || '').toLowerCase().trim().replace(/\s+/g, ' '); }
function tokenize(s) {
  const t = norm(s).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(w => w.length >= 2);
  return new Set(t);
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/* ---------------- reports (req #7) ---------------- */
async function reportRoute(env, url, seg) {
  const kind = seg[1];
  const year = +(url.searchParams.get('year') || new Date().getFullYear());

  if (kind === 'person') {
    const emp = (await env.DB.prepare('SELECT id,name,vsm FROM employees WHERE active=1').all()).results;
    const rows = (await env.DB.prepare(
      'SELECT reporter_id,status,safety_result,category FROM psif WHERE year=?').bind(year).all()).results;
    const target = (await env.DB.prepare('SELECT per_person_target FROM targets WHERE year=?')
      .bind(year).first())?.per_person_target || 6;
    const newCats = () => ({ 'PSIF': 0, 'Near miss': 0, 'Behavior': 0 });
    const map = {};
    for (const e of emp) map[e.id] = {
      id: e.id, name: e.name, vsm: e.vsm,
      submitted: 0, done: 0, approved: 0, rejected: 0, cats: newCats(),
    };
    for (const r of rows) {
      const m = map[r.reporter_id] || (map[r.reporter_id] = {
        id: r.reporter_id, name: r.reporter_id, vsm: '', submitted: 0, done: 0, approved: 0, rejected: 0, cats: newCats() });
      m.submitted++;
      if (r.safety_result === 'approved') m.approved++;
      if (['rejected', 'duplicate', 'not_cardinal'].includes(r.safety_result)) m.rejected++;
      // ข้อ 4: นับผลงาน (done/cats/โบนัส) เฉพาะ Safety อนุมัติ + ดำเนินการจนจบ เท่านั้น
      if (isCounted(r)) { m.done++; if (m.cats[r.category] != null) m.cats[r.category]++; }
    }
    const people = Object.values(map).map(m => {
      m.missing = Math.max(0, target - m.done);
      m.bonus = bonusFromCats(m.cats);
      return m;
    }).sort((a, b) => b.done - a.done);
    return ok({ year, target, people });
  }

  if (kind === 'overview') {
    const rows = (await env.DB.prepare(
      'SELECT vsm,category,status,safety_result FROM psif WHERE year=?').bind(year).all()).results;
    const byVsm = {}, byCat = {};
    let total = 0, done = 0;
    for (const r of rows) {
      total++; if (isCounted(r)) done++;   // ข้อ 4: "done" = อนุมัติ + จบงาน เท่านั้น
      const v = (byVsm[r.vsm || '-'] ||= { vsm: r.vsm || '-', total: 0, done: 0 });
      v.total++; if (isCounted(r)) v.done++;
      const c = (byCat[r.category || '-'] ||= { category: r.category || '-', total: 0, done: 0 });
      c.total++; if (isCounted(r)) c.done++;
    }
    return ok({
      year, total, done,
      by_vsm: Object.values(byVsm).sort((a, b) => b.total - a.total),
      by_category: Object.values(byCat).sort((a, b) => b.total - a.total),
    });
  }
  return err('unknown report', 404);
}

/* โบนัสแบบบวกสะสม (ให้ตรงกับ frontend): ผ่าน PSIF(Con)≥2 = 5% พื้นฐาน ·
 * ครบ Near miss ≥2 = +2.5% · ครบ PSIF(Behavior) ≥2 = +2.5% (สูงสุด 10%)
 * นับจาก cats ที่ผ่านเกณฑ์ข้อ 4 แล้วเท่านั้น */
function bonusFromCats(cats) {
  const con = cats['PSIF'] || 0, beh = cats['Behavior'] || 0, nm = cats['Near miss'] || 0;
  if (con < 2) return 0;
  let b = 5;
  if (nm >= 2) b += 2.5;
  if (beh >= 2) b += 2.5;
  return b;
}
