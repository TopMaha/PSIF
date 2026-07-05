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
  'Access-Control-Allow-Headers': 'Content-Type',
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
        case 'health':    return ok({ service: 'psif', time: nowISO() });
        case 'bootstrap': return await bootstrap(env);
        case 'psif':      return await psifRoute(env, request, seg);
        case 'employees': return await crudRoute(env, request, seg, 'employees');
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
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return err('no rows');
  const now = nowISO();
  let n = 0;
  for (const r of rows) {
    const title = (r.title || (r.detail || '').slice(0, 120) || '(นำเข้าข้อมูล)');
    if (!(r.detail || r.title)) continue;
    await env.DB.prepare(
      `INSERT INTO psif (no,reporter_id,reporter_name,vsm,area_id,machine,category,title,detail,suggestion,
         status,safety_result,safety_note,safety_at,done_detail,done_by,done_at,year,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      r.no || '', r.reporter_id || '', r.reporter_name || '', r.vsm || '', '', r.machine || '', r.category || '',
      title, r.detail || '', r.suggestion || '',
      r.status || 'recorded', r.safety_result || 'pending', r.safety_note || '', r.safety_at || '',
      r.done_detail || '', r.done_by || '', r.done_at || '',
      +r.year || new Date().getFullYear(), r.created_at || now, now
    ).run();
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
    const sql = 'SELECT * FROM psif' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
                ' ORDER BY created_at DESC';
    const rows = (await env.DB.prepare(sql).bind(...bind).all()).results;
    await attachPhotos(env, rows);
    return ok({ items: rows });
  }

  if (request.method === 'GET' && id) {
    const row = await env.DB.prepare('SELECT * FROM psif WHERE id=?').bind(id).first();
    if (!row) return err('not found', 404);
    await attachPhotos(env, [row]);
    return ok({ item: row });
  }

  if (request.method === 'POST') {
    const b = await request.json();
    if (!b.reporter_id) return err('reporter_id required');
    // title field was removed from the form — derive it from the detail
    const title = (b.title || (b.detail || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(ไม่มีหัวข้อ)');
    const year = b.year || new Date().getFullYear();
    const r = await env.DB.prepare(
      `INSERT INTO psif (no,reporter_id,reporter_name,vsm,area_id,machine,category,title,detail,suggestion,status,year,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'recorded', ?,?,?)`
    ).bind(
      b.no || '', b.reporter_id, b.reporter_name || '', b.vsm || '', b.area_id || '',
      b.machine || '', b.category || '', title, b.detail || '', b.suggestion || '',
      year, nowISO(), nowISO()
    ).run();
    const newId = r.meta.last_row_id;
    // attach any photos already uploaded (req #2: before-photo)
    if (Array.isArray(b.photos)) {
      for (const p of b.photos) {
        const k = p && (p.key || p.r2_key);
        if (k && !k.startsWith('data:')) await addPhoto(env, newId, p.kind || 'before', k);
      }
    }
    // req: notify the Admin/Manager group (role admin|safety) when a new report arrives
    try {
      const mgrs = (await env.DB.prepare(
        "SELECT id FROM employees WHERE role IN ('admin','safety') AND active=1"
      ).all()).results;
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
    const allowed = ['no','reporter_name','vsm','area_id','machine','category','title','detail',
      'suggestion','status','safety_result','safety_note','safety_by','safety_at',
      'done_detail','done_by','done_at'];
    const sets = [], bind = [];
    for (const k of allowed) {
      if (k in b) { sets.push(`${k}=?`); bind.push(b[k]); }
    }
    if (sets.length) {
      sets.push('updated_at=?'); bind.push(nowISO());
      bind.push(id);
      await env.DB.prepare(`UPDATE psif SET ${sets.join(',')} WHERE id=?`).bind(...bind).run();
    }
    // req: notify the reporter whenever someone else acts on their record
    const actor = b._by || '';
    if (oldRow.reporter_id && actor !== oldRow.reporter_id) {
      for (const m of notifMessages(oldRow, b)) {
        await notify(env, oldRow.reporter_id, +id, m, actor, b._by_name || '');
      }
    }
    if (Array.isArray(b.photos)) {
      for (const p of b.photos) {
        const k = p && (p.key || p.r2_key);
        if (k && !k.startsWith('data:')) await addPhoto(env, id, p.kind || 'after', k);
      }
    }
    const row = await env.DB.prepare('SELECT * FROM psif WHERE id=?').bind(id).first();
    if (!row) return err('not found', 404);
    await attachPhotos(env, [row]);
    return ok({ item: row });
  }

  if (request.method === 'DELETE' && id) {
    const u = new URL(request.url);
    const row = await env.DB.prepare('SELECT reporter_id,title FROM psif WHERE id=?').bind(id).first();
    const photos = (await env.DB.prepare('SELECT r2_key FROM psif_photos WHERE psif_id=?').bind(id).all()).results;
    if (env.BUCKET) { for (const p of photos) { try { await env.BUCKET.delete(p.r2_key); } catch (_) {} } }
    await env.DB.prepare('DELETE FROM psif_photos WHERE psif_id=?').bind(id).run();
    await env.DB.prepare('DELETE FROM psif WHERE id=?').bind(id).run();
    const actor = u.searchParams.get('by') || '';
    if (row && row.reporter_id && actor !== row.reporter_id) {
      await notify(env, row.reporter_id, +id,
        `🗑️ เรื่อง "${(row.title || '').slice(0, 40)}" ถูกลบออกจากระบบ`,
        actor, u.searchParams.get('by_name') || '');
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
  if (b.safety_result === 'rejected' && oldRow.safety_result !== 'rejected')
    msgs.push(`❌ Safety ไม่อนุมัติเรื่อง "${t}"${b.safety_note ? ' — ' + b.safety_note : ''}`);
  if (b.status === 'inprogress' && oldRow.status !== 'inprogress')
    msgs.push(`🚀 เรื่อง "${t}" เริ่มดำเนินการแล้ว${b.no ? ' (No.' + b.no + ')' : ''}`);
  if (b.status === 'done' && oldRow.status !== 'done')
    msgs.push(`🏁 เรื่อง "${t}" ปิดงานเรียบร้อยแล้ว`);
  const edited = ['title', 'detail', 'suggestion', 'category', 'machine', 'area_id']
    .some(k => k in b && String(b[k] ?? '') !== String(oldRow[k] ?? ''));
  if (edited) msgs.push(`✏️ มีการแก้ไขเนื้อหาเรื่อง "${t}"`);
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

/* ---------------- generic CRUD (employees / areas / categories) ---------------- */
async function crudRoute(env, request, seg, table) {
  const id = seg[1];
  if (request.method === 'GET') {
    const rows = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
    return ok({ items: rows });
  }
  if (request.method === 'POST') { // upsert
    const b = await request.json();
    if (!b.id || !b.name) return err('id and name required');
    if (table === 'employees') {
      await env.DB.prepare(
        `INSERT INTO employees (id,name,vsm,role,active) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, vsm=excluded.vsm, role=excluded.role, active=excluded.active`
      ).bind(b.id, b.name, b.vsm || '', b.role || 'user', b.active ?? 1).run();
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
    await env.DB.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id).run();
    return ok({ deleted: id });
  }
  return err('method not allowed', 405);
}

/* ---------------- targets ---------------- */
async function targetsRoute(env, request) {
  if (request.method === 'GET') {
    const rows = (await env.DB.prepare('SELECT * FROM targets ORDER BY year').all()).results;
    return ok({ items: rows });
  }
  if (request.method === 'POST') {
    const b = await request.json();
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
    if (!b.vsm) return err('vsm required');
    const year = +b.year || new Date().getFullYear();
    const r = await env.DB.prepare(
      'INSERT INTO issuances (vsm,year,requested_by,requested_at) VALUES (?,?,?,?)'
    ).bind(b.vsm, year, b.requested_by || '', nowISO()).run();
    return ok({ id: r.meta.last_row_id });
  }
  if (request.method === 'DELETE' && id) {
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
      'SELECT reporter_id,status,safety_result FROM psif WHERE year=?').bind(year).all()).results;
    const target = (await env.DB.prepare('SELECT per_person_target FROM targets WHERE year=?')
      .bind(year).first())?.per_person_target || 6;
    const map = {};
    for (const e of emp) map[e.id] = {
      id: e.id, name: e.name, vsm: e.vsm,
      submitted: 0, done: 0, approved: 0, rejected: 0,
    };
    for (const r of rows) {
      const m = map[r.reporter_id] || (map[r.reporter_id] = {
        id: r.reporter_id, name: r.reporter_id, vsm: '', submitted: 0, done: 0, approved: 0, rejected: 0 });
      m.submitted++;
      if (r.status === 'done') m.done++;
      if (r.safety_result === 'approved') m.approved++;
      if (r.safety_result === 'rejected') m.rejected++;
    }
    const people = Object.values(map).map(m => {
      m.missing = Math.max(0, target - m.done);
      m.bonus = bonusPct(m.done);
      return m;
    }).sort((a, b) => b.done - a.done);
    return ok({ year, target, people });
  }

  if (kind === 'overview') {
    const rows = (await env.DB.prepare(
      'SELECT vsm,category,status FROM psif WHERE year=?').bind(year).all()).results;
    const byVsm = {}, byCat = {};
    let total = 0, done = 0;
    for (const r of rows) {
      total++; if (r.status === 'done') done++;
      const v = (byVsm[r.vsm || '-'] ||= { vsm: r.vsm || '-', total: 0, done: 0 });
      v.total++; if (r.status === 'done') v.done++;
      const c = (byCat[r.category || '-'] ||= { category: r.category || '-', total: 0, done: 0 });
      c.total++; if (r.status === 'done') c.done++;
    }
    return ok({
      year, total, done,
      by_vsm: Object.values(byVsm).sort((a, b) => b.total - a.total),
      by_category: Object.values(byCat).sort((a, b) => b.total - a.total),
    });
  }
  return err('unknown report', 404);
}

// req #13 bonus tiers: 4->5%, 5->7.5%, >=6 ->10%
function bonusPct(done) {
  if (done >= 6) return 10;
  if (done === 5) return 7.5;
  if (done === 4) return 5;
  return 0;
}
