'use strict';
// Ardoha backend: Google sign-in, accounts, client dashboards, admin panel, bookings and Paystack payments.
// Database: PostgreSQL (Supabase). Needs Node 18+ and the `pg` package.
const fs = require('fs');
const path = require('path');
const http = require('http');

// Tiny .env loader (hosts normally inject real environment variables instead)
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* no .env file */ }

const db = require('./db');
const auth = require('./auth');
const pay = require('./pay');
const CATALOG = require('./catalog.json');

const PORT = Number(process.env.PORT || 3000);
const SITES = (process.env.SITE_URL || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const ADMINS = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || '';
const now = () => new Date().toISOString();
const STATUSES = ['pending', 'active', 'paused', 'completed'];
const GOALS = ['reach', 'sales', 'endorse', 'unsure'];
const EMAIL = /^\S+@\S+\.\S+$/;

const { HttpError } = require('./errors');
const bad = (m) => new HttpError(400, m);
// Escapes the characters that act as wildcards in LIKE searches
const likeEsc = (s) => s.replace(/[!%_]/g, '!$&');

// ---------- helpers ----------
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role, title: u.book_title, goal: u.goal, provider: u.provider, joined: u.created_at }; }
function serviceRow(s) {
  const c = CATALOG[s.slug] || { name: s.slug };
  return { id: s.id, slug: s.slug, name: c.name, tier: s.tier, status: s.status, progress: s.progress, note: s.note, price: pay.price(s.slug, s.tier), updated: s.updated_at };
}
async function dashboard(user) {
  const [svc, updates, orders] = await Promise.all([
    db.many('SELECT * FROM services WHERE user_id = $1 ORDER BY id', [user.id]),
    db.many('SELECT id, text, service_slug, created_at FROM updates WHERE user_id = $1 ORDER BY id DESC LIMIT 100', [user.id]),
    db.many('SELECT reference, total_usd, status, created_at, paid_at FROM orders WHERE user_id = $1 ORDER BY id DESC', [user.id]),
  ]);
  return { user: publicUser(user), services: svc.map(serviceRow), updates, orders };
}
async function startSession(res, user) {
  await auth.touchLogin(user.id);
  res.setHeader('Set-Cookie', auth.cookieHeader(await auth.createSession(user.id)));
}
function validPlan(b) {
  const slug = clean(b.slug, 60), tier = clean(b.tier || 'starter', 20);
  if (!CATALOG[slug]) throw bad('Unknown service');
  if (!(tier in pay.TIERS)) throw bad('Unknown package');
  return { slug, tier };
}

// ---------- router ----------
const routes = [];
function route(method, pattern, opts, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, opts: opts || {}, handler });
}
const hits = new Map();
function limited(ip, key, max) {
  const k = ip + key, t = Date.now(), a = (hits.get(k) || []).filter((x) => t - x < 60000);
  if (a.length >= max) return true;
  a.push(t); hits.set(k, a); return false;
}
setInterval(() => { const t = Date.now(); for (const [k, a] of hits) if (!a.some((x) => t - x < 60000)) hits.delete(k); }, 120000).unref();
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function send(res, status, body, type) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  return SITES.includes(o) || o === 'http://' + req.headers.host || o === 'https://' + req.headers.host;
}

// ---------- public ----------
route('GET', '/health', {}, async () => { try { await db.query('SELECT 1'); } catch (e) { throw new HttpError(503, 'Database unavailable'); } return { ok: true }; });
route('GET', '/api/config', {}, () => ({ googleClientId: GOOGLE_ID, currency: process.env.CURRENCY || 'USD' }));
route('GET', '/api/catalog', {}, () => CATALOG);

route('POST', '/api/bookings', { limit: 10 }, async ({ body }) => {
  const b = { name: clean(body.name, 80), email: clean(body.email, 120).toLowerCase(), topic: clean(body.topic, 300), date: clean(body.date, 12), time: clean(body.time, 12), tz: clean(body.tz, 60) };
  if (!b.name || !EMAIL.test(b.email) || !/^\d{4}-\d{1,2}-\d{1,2}$/.test(b.date) || !b.time) throw bad('Please check the booking details');
  try {
    await db.query('INSERT INTO bookings(name, email, topic, slot_date, slot_time, tz, created_at) VALUES($1, $2, $3, $4, $5, $6, $7)', [b.name, b.email, b.topic, b.date, b.time, b.tz, now()]);
  } catch (e) { if (e.code === '23505') throw new HttpError(409, 'That time has just been taken'); throw e; }
  return { ok: true };
});
route('GET', '/api/bookings/taken', {}, async ({ q }) => ({ times: (await db.many('SELECT slot_time FROM bookings WHERE slot_date = $1', [clean(q.get('date'), 12)])).map((r) => r.slot_time) }));

// ---------- authentication ----------
route('POST', '/api/auth/google', { limit: 20 }, async ({ res, body }) => {
  let g;
  try { g = await auth.verifyGoogleToken(body.credential, GOOGLE_ID); } catch (e) { throw new HttpError(401, 'Google sign-in could not be verified'); }
  const { user, isNew } = await auth.signInWithGoogle(g, ADMINS.includes(g.email) ? 'admin' : 'user', clean(g.name, 80));
  await startSession(res, user);
  return { user: publicUser(user), isNew };
});
route('POST', '/api/auth/signup', { limit: 8 }, async ({ res, body }) => {
  const name = clean(body.name, 80), email = clean(body.email, 120).toLowerCase(), pw = String(body.password || '');
  if (!name) throw bad('Please tell us your name');
  if (!EMAIL.test(email)) throw bad('Please enter a valid email address');
  if (pw.length < 8 || pw.length > 200) throw bad('Your password should be at least 8 characters');
  const { user, isNew } = await auth.signUpWithPassword({ name, email, password: pw, title: clean(body.title, 120), goal: GOALS.includes(body.goal) ? body.goal : 'unsure' });
  await startSession(res, user);
  return { user: publicUser(user), isNew };
});
route('POST', '/api/auth/login', { limit: 10 }, async ({ res, body }) => {
  const { user, isNew } = await auth.signInWithPassword(clean(body.email, 120).toLowerCase(), String(body.password || ''));
  await startSession(res, user);
  return { user: publicUser(user), isNew };
});
route('POST', '/api/auth/logout', {}, async ({ req, res }) => { await auth.destroySession(req); res.setHeader('Set-Cookie', auth.cookieHeader('', true)); return { ok: true }; });
route('GET', '/api/me', { auth: true }, ({ user }) => ({ user: publicUser(user) }));

// ---------- client dashboard ----------
route('GET', '/api/me/dashboard', { auth: true }, ({ user }) => dashboard(user));
route('PATCH', '/api/me/profile', { auth: true }, async ({ user, body }) => {
  const name = clean(body.name, 80) || user.name, title = clean(body.title, 120), goal = GOALS.includes(body.goal) ? body.goal : user.goal;
  await db.query('UPDATE users SET name = $1, book_title = $2, goal = $3 WHERE id = $4', [name, title, goal, user.id]);
  return dashboard(await auth.getUserById(user.id));
});
route('POST', '/api/me/plan', { auth: true, limit: 60 }, async ({ user, body }) => {
  const { slug, tier } = validPlan(body);
  const ex = await db.one('SELECT * FROM services WHERE user_id = $1 AND slug = $2', [user.id, slug]);
  if (ex && ex.status !== 'pending') throw new HttpError(409, 'This service is already in your plan');
  if (ex) await db.query('UPDATE services SET tier = $1, updated_at = $2 WHERE id = $3', [tier, now(), ex.id]);
  else {
    await db.tx(async (q) => {
      await q("INSERT INTO services(user_id, slug, tier, status, created_at, updated_at) VALUES($1, $2, $3, 'pending', $4, $4)", [user.id, slug, tier, now()]);
      await q('INSERT INTO updates(user_id, text, author, created_at) VALUES($1, $2, $3, $4)', [user.id, `Added ${CATALOG[slug].name} to your plan. Awaiting payment.`, 'Ardoha', now()]);
    });
  }
  return dashboard(user);
});

route('DELETE', '/api/me/plan', { auth: true, limit: 60 }, async ({ user, body }) => {
  const slug = body && body.slug;

  if (typeof slug !== 'string' || !CATALOG[slug]) {
    throw new HttpError(400, 'Invalid service');
  }

  const result = await db.query(
    "DELETE FROM services WHERE user_id = $1 AND slug = $2 AND status = 'pending'",
    [user.id, slug]
  );

  if (result.rowCount) {
    await db.query(
      'INSERT INTO updates(user_id, text, author, created_at) VALUES($1, $2, $3, $4)',
      [user.id, `Removed ${CATALOG[slug].name} from your plan.`, 'Ardoha', now()]
    );
  }

  return dashboard(user);
});

route('PATCH', '/api/me/plan/:slug', { auth: true }, async ({ user, params, body }) => {
  const { slug, tier } = validPlan({ slug: params.slug, tier: body.tier });
  const r = await db.query("UPDATE services SET tier = $1, updated_at = $2 WHERE user_id = $3 AND slug = $4 AND status = 'pending'", [tier, now(), user.id, slug]);
  if (!r.rowCount) throw new HttpError(404, 'Not in your cart');
  return dashboard(user);
});
route('DELETE', '/api/me/plan/:slug', { auth: true }, async ({ user, params }) => {
  const r = await db.query("DELETE FROM services WHERE user_id = $1 AND slug = $2 AND status = 'pending'", [user.id, clean(params.slug, 60)]);
  if (!r.rowCount) throw new HttpError(404, 'Not in your cart');
  return dashboard(user);
});

// ---------- payments ----------
route('POST', '/api/checkout/initialize', { auth: true, limit: 20 }, async ({ user, body }) => {
  console.log('Checkout initialization requested');

  try {
    const result = await pay.initialize(user, body.promo);
    console.log('Paystack initialization successful');
    return result;
  } catch (err) {
    console.error('Checkout initialization failed:', err.message);
    throw err;
  }
});route('GET', '/api/checkout/verify/:reference', { auth: true, limit: 60 }, async ({ user, params }) => {
  const o = await db.one('SELECT * FROM orders WHERE reference = $1 AND user_id = $2', [clean(params.reference, 40), user.id]);
  if (!o) throw new HttpError(404, 'Order not found');
  const r = await pay.fulfil(o.reference);
  return { status: r.status, reference: r.reference, total: r.total_usd };
});
route('POST', '/api/paystack/webhook', { raw: true }, ({ res, raw, req }) => {
if (!pay.signatureOk(raw, req.headers['paystack-signature'])) throw new HttpError(401, 'Bad signature');  res.writeHead(200); res.end();
  try { const ev = JSON.parse(raw.toString()); if (ev.event === 'charge.success') pay.fulfil(ev.data.reference).catch((e) => console.error('fulfil', e.message)); } catch (e) { /* ignore */ }
  return undefined;
});

// ---------- admin ----------
const admin = { auth: true, admin: true };
const count = async (sql) => (await db.one(sql)).n;
route('GET', '/api/admin/stats', admin, async () => {
  const [users, pending, active, completed, paidOrders, revenueUsd, bookings] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM users WHERE role = 'user'"),
    count("SELECT COUNT(*) AS n FROM services WHERE status = 'pending'"),
    count("SELECT COUNT(*) AS n FROM services WHERE status = 'active'"),
    count("SELECT COUNT(*) AS n FROM services WHERE status = 'completed'"),
    count("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'"),
    count("SELECT COALESCE(SUM(total_usd), 0) AS n FROM orders WHERE status = 'paid'"),
    count('SELECT COUNT(*) AS n FROM bookings'),
  ]);
  return { users, pending, active, completed, paidOrders, revenueUsd: Number(revenueUsd), bookings };
});
route('GET', '/api/admin/users', admin, ({ q }) => {
  const s = '%' + likeEsc(clean(q.get('q'), 60).toLowerCase()) + '%';
  return db.many(`SELECT u.id, u.name, u.email, u.role, u.book_title AS title, u.created_at AS joined,
    (SELECT COUNT(*) FROM services WHERE user_id = u.id AND status = 'active') AS active,
    (SELECT COUNT(*) FROM services WHERE user_id = u.id AND status = 'pending') AS pending
    FROM users u WHERE u.name ILIKE $1 ESCAPE '!' OR u.email ILIKE $1 ESCAPE '!' ORDER BY u.id DESC LIMIT 200`, [s]);
});
const idOf = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new HttpError(404, 'Not found'); return n; };
route('GET', '/api/admin/users/:id', admin, async ({ params }) => {
  const u = await auth.getUserById(idOf(params.id));
  if (!u) throw new HttpError(404, 'User not found');
  return dashboard(u);
});
route('POST', '/api/admin/users/:id/services', admin, async ({ params, body }) => {
  const u = await auth.getUserById(idOf(params.id));
  if (!u) throw new HttpError(404, 'User not found');
  const { slug, tier } = validPlan(body);
  const status = STATUSES.includes(body.status) ? body.status : 'active';
  const prog = Math.max(0, Math.min(100, parseInt(body.progress, 10) || 0));
  await db.query(`INSERT INTO services(user_id, slug, tier, status, progress, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, $6)
    ON CONFLICT (user_id, slug) DO UPDATE SET tier = EXCLUDED.tier, status = EXCLUDED.status, progress = EXCLUDED.progress, updated_at = EXCLUDED.updated_at`,
  [u.id, slug, tier, status, prog, now()]);
  return dashboard(u);
});
route('PATCH', '/api/admin/services/:id', admin, async ({ params, body, user }) => {
  const s = await db.one('SELECT * FROM services WHERE id = $1', [idOf(params.id)]);
  if (!s) throw new HttpError(404, 'Service not found');
  const prog = body.progress === undefined ? s.progress : Math.max(0, Math.min(100, parseInt(body.progress, 10) || 0));
  let status = STATUSES.includes(body.status) ? body.status : s.status;
  if (prog === 100 && status === 'active') status = 'completed';
  const tier = body.tier in pay.TIERS ? body.tier : s.tier;
  const note = body.note === undefined ? s.note : clean(body.note, 400);
  const msg = clean(body.update, 600);
  await db.tx(async (q) => {
    await q('UPDATE services SET progress = $1, status = $2, tier = $3, note = $4, updated_at = $5 WHERE id = $6', [prog, status, tier, note, now(), s.id]);
    if (msg) await q('INSERT INTO updates(user_id, text, service_slug, author, created_at) VALUES($1, $2, $3, $4, $5)', [s.user_id, msg, s.slug, user.name, now()]);
  });
  return dashboard(await auth.getUserById(s.user_id));
});
route('POST', '/api/admin/users/:id/updates', admin, async ({ params, body, user }) => {
  const u = await auth.getUserById(idOf(params.id));
  if (!u) throw new HttpError(404, 'User not found');
  const text = clean(body.text, 600);
  if (!text) throw bad('Please write the update');
  const slug = CATALOG[body.service_slug] ? body.service_slug : null;
  await db.query('INSERT INTO updates(user_id, text, service_slug, author, created_at) VALUES($1, $2, $3, $4, $5)', [u.id, text, slug, user.name, now()]);
  return dashboard(u);
});
route('DELETE', '/api/admin/updates/:id', admin, async ({ params }) => {
  const r = await db.query('DELETE FROM updates WHERE id = $1 RETURNING user_id', [idOf(params.id)]);
  if (!r.rows.length) throw new HttpError(404, 'Update not found');
  return dashboard(await auth.getUserById(r.rows[0].user_id));
});
route('GET', '/api/admin/bookings', admin, () => db.many('SELECT id, name, email, topic, slot_date AS date, slot_time AS time, tz, created_at FROM bookings ORDER BY slot_date DESC, slot_time DESC LIMIT 200'));

// ---------- server ----------
const ADMIN_HTML = path.join(__dirname, 'admin', 'index.html');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (origin && SITES.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data: https:");
      return send(res, 200, fs.readFileSync(ADMIN_HTML), 'text/html; charset=utf-8');
    }
    const ip = (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      if (req.method !== 'GET' && !originOk(req)) throw new HttpError(403, 'Origin not allowed');
      if (r.opts.limit && limited(ip, url.pathname, r.opts.limit)) throw new HttpError(429, 'Too many requests, please wait a minute');
      const ctx = { req, res, params: {}, q: url.searchParams, body: {}, user: null };
      r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
      if (r.opts.auth || r.opts.admin) {
        ctx.user = await auth.userFromRequest(req);
        if (!ctx.user) throw new HttpError(401, 'Please log in');
        if (r.opts.admin && ctx.user.role !== 'admin') throw new HttpError(403, 'Admins only');
      }
      if (r.opts.raw) ctx.raw = await readBody(req, 200000);
      else if (req.method === 'POST' || req.method === 'PATCH') {
        const buf = await readBody(req, 100000);
        try { ctx.body = buf.length ? JSON.parse(buf.toString()) : {}; } catch (e) { throw bad('Invalid JSON'); }
        if (ctx.body === null || typeof ctx.body !== 'object') ctx.body = {};
      }
      const out = await r.handler(ctx);
      if (out !== undefined && !res.writableEnded) send(res, 200, out);
      return;
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('Server error:', e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong' });
  }
});
// Tables are created on first start (safe to repeat). Tests wait for server.ready.
server.ready = db.init();
setInterval(() => auth.purgeExpiredSessions().catch(() => {}), 3600e3).unref();
if (require.main === module) {
  server.ready.then(() => {
    server.listen(PORT, () => console.log('Ardoha backend listening on', PORT));
    const stop = () => server.close(() => db.close().then(() => process.exit(0), () => process.exit(1)));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((e) => { console.error('Could not set up the database:', e.message); process.exit(1); });
}
module.exports = server;
