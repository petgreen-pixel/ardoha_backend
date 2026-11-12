'use strict';
// Runs the real backend against a fake Google key server, a fake Paystack, and a database.
//
//   Real PostgreSQL (the check that matters):  TEST_DATABASE_URL="postgresql://..." npm test
//     Uses a throw-away schema (ard_test_xxxx) that is deleted at the end. Your real tables are never touched.
//   No database available (for example a sandbox):  npm test
//     Falls back to a SQLite-backed stand-in for the `pg` driver. That checks the application logic only.
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const REAL = !!process.env.TEST_DATABASE_URL;
if (REAL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DB_SCHEMA = 'ard_test_' + require('crypto').randomBytes(4).toString('hex');
  console.log('Database: REAL PostgreSQL, throw-away schema ' + process.env.DB_SCHEMA + '\n');
} else {
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (request, ...rest) { return request === 'pg' ? require('./pg-standin') : orig.call(this, request, ...rest); };
  process.env.DATABASE_URL = 'postgresql://standin@localhost/standin';
  console.log('*** Database: SQLite-backed STAND-IN for pg. This checks the application logic, NOT PostgreSQL. ***');
  console.log('*** Run with TEST_DATABASE_URL set to test against your real PostgreSQL / Supabase database.   ***\n');
}

const good = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = Object.assign(good.publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256', use: 'sig' });
const CLIENT = 'test-client-id.apps.googleusercontent.com', SECRET = 'sk_test_fake_secret';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(over, key, kid) {
  const now = Math.floor(Date.now() / 1000);
  const p = Object.assign({ iss: 'https://accounts.google.com', aud: CLIENT, sub: 'g-1', email: 'author@test.com', email_verified: true, name: 'Ada Author', iat: now, exp: now + 3600 }, over || {});
  const body = b64({ alg: 'RS256', kid: kid || 'k1', typ: 'JWT' }) + '.' + b64(p);
  return body + '.' + crypto.sign('RSA-SHA256', Buffer.from(body), key || good.privateKey).toString('base64url');
}
const orders = {};
function listen(h) { return new Promise((r) => { const s = http.createServer(h); s.listen(0, () => r(s)); }); }

(async () => {
  const jwksSrv = await listen((q, s) => { s.end(JSON.stringify({ keys: [jwk] })); });
  const paySrv = await listen((q, s) => {
    let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => {
      s.setHeader('Content-Type', 'application/json');
      if (q.method === 'POST') { const j = JSON.parse(b); orders[j.reference] = j; return s.end(JSON.stringify({ status: true, data: { authorization_url: 'https://paystack.test/' + j.reference, reference: j.reference } })); }
      const ref = q.url.split('/').pop(); const o = orders[ref] || {};
      s.end(JSON.stringify({ status: true, data: { status: orders[ref] ? (o.fail ? 'failed' : 'success') : 'abandoned', amount: o.amount, currency: o.currency } }));
    });
  });
  Object.assign(process.env, { GOOGLE_CLIENT_ID: CLIENT, GOOGLE_JWKS_URL: `http://localhost:${jwksSrv.address().port}/jwks`,
    PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_URL: `http://localhost:${paySrv.address().port}`, SITE_URL: 'https://www.ardoha.test', ADMIN_EMAILS: 'boss@ardoha.test', CURRENCY: 'USD' });
  const app = require('../server');
  await app.ready; // tables created
  await new Promise((r) => app.listen(0, r));
  const base = `http://localhost:${app.address().port}`;

  function client() {
    let cookie = '';
    return async (method, url, body, extra) => {
      const r = await fetch(base + url, { method, headers: Object.assign({ 'Content-Type': 'application/json', Cookie: cookie }, extra || {}), body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
      let j = {}; try { j = await r.json(); } catch (e) { /* empty */ }
      return { s: r.status, j, h: r.headers };
    };
  }
  let pass = 0, fail = 0;
  const t = (name, ok, info) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  <- ' + JSON.stringify(info))); };

  const anon = client(), user = client(), admin = client(), pw = client();
  // ---- Google verification ----
  let r = await admin('POST', '/api/auth/google', { credential: token({ email: 'boss@ardoha.test', sub: 'g-boss', name: 'The Boss' }) });
  t('admin Google login accepted and gets admin role', r.s === 200 && r.j.user.role === 'admin' && r.j.isNew, r);
  r = await anon('POST', '/api/auth/google', { credential: token({}, evil.privateKey) });
  t('token signed with the wrong key is rejected', r.s === 401, r);
  r = await anon('POST', '/api/auth/google', { credential: token({ aud: 'someone-elses-app' }) });
  t('token meant for another app is rejected', r.s === 401, r);
  r = await anon('POST', '/api/auth/google', { credential: token({ exp: Math.floor(Date.now() / 1000) - 10 }) });
  t('expired token is rejected', r.s === 401, r);
  r = await anon('POST', '/api/auth/google', { credential: token({ iss: 'https://evil.com' }) });
  t('wrong issuer is rejected', r.s === 401, r);
  r = await anon('POST', '/api/auth/google', { credential: token({ email_verified: false }) });
  t('unverified Google email is rejected', r.s === 401, r);
  r = await anon('POST', '/api/auth/google', { credential: token({}, good.privateKey, 'unknown-kid') });
  t('unknown signing key id is rejected', r.s === 401, r);
  r = await anon('POST', '/api/auth/google', { credential: 'not.a.token' });
  t('garbage token is rejected', r.s === 401, r);
  r = await anon('POST', '/api/auth/google', {});
  t('missing token is rejected', r.s === 401, r);
  r = await user('POST', '/api/auth/google', { credential: token({}) });
  t('new author signs up with Google', r.s === 200 && r.j.isNew && r.j.user.role === 'user' && r.j.user.email === 'author@test.com', r);
  const again = client(); r = await again('POST', '/api/auth/google', { credential: token({}) });
  t('same author logging in again is recognised, not duplicated', r.s === 200 && !r.j.isNew, r);
  r = await user('GET', '/api/me');
  t('session cookie keeps the author logged in', r.s === 200 && r.j.user.name === 'Ada Author', r);
  r = await anon('GET', '/api/me');
  t('no cookie means not logged in', r.s === 401, r);
  // ---- Email accounts + account-takeover protection ----
  r = await pw('POST', '/api/auth/signup', { name: 'Tom', email: 'victim@test.com', password: 'short' });
  t('weak password is rejected', r.s === 400, r);
  r = await pw('POST', '/api/auth/signup', { name: 'Mallory', email: 'victim@test.com', password: 'longenough1' });
  t('email sign-up works', r.s === 200, r);
  r = await pw('POST', '/api/auth/signup', { name: 'X', email: 'victim@test.com', password: 'longenough1' });
  t('duplicate email is rejected', r.s === 409, r);
  r = await client()('POST', '/api/auth/login', { email: 'victim@test.com', password: 'wrongpass' });
  t('wrong password is rejected', r.s === 401, r);
  r = await client()('POST', '/api/auth/login', { email: 'nobody@test.com', password: 'whatever12' });
  t('unknown email gets the same error', r.s === 401 && r.j.error === 'Email or password is incorrect', r);
  r = await client()('POST', '/api/auth/login', { email: 'victim@test.com', password: 'longenough1' });
  t('correct password logs in', r.s === 200, r);
  await client()('POST', '/api/auth/google', { credential: token({ email: 'victim@test.com', sub: 'g-victim', name: 'Real Victim' }) });
  r = await client()('POST', '/api/auth/login', { email: 'victim@test.com', password: 'longenough1' });
  t('real owner signing in with Google removes the pre-registered password', r.s === 401, r);
  r = await pw('GET', '/api/me');
  t('and the attacker\'s old session is cut off', r.s === 401, r);
  // ---- Client dashboard ----
  r = await user('POST', '/api/me/plan', { slug: 'amazon', tier: 'growth' });
  t('add service to plan creates a PENDING service', r.s === 200 && r.j.services[0].status === 'pending' && r.j.services[0].price === 600, r);
  r = await user('POST', '/api/me/plan', { slug: 'nonsense', tier: 'growth' });
  t('unknown service is rejected', r.s === 400, r);
  await user('POST', '/api/me/plan', { slug: 'goodreads', tier: 'starter' });
  r = await user('PATCH', '/api/me/plan/goodreads', { tier: 'premium' });
  t('client can change the package of a pending service', r.s === 200 && r.j.services.find((s) => s.slug === 'goodreads').price === 900, r);
  r = await user('DELETE', '/api/me/plan/goodreads');
  t('client can remove a pending service', r.s === 200 && r.j.services.length === 1, r);
  // ---- Admin protection ----
  r = await user('GET', '/api/admin/users');
  t('normal client cannot use admin API', r.s === 403, r);
  r = await anon('GET', '/api/admin/stats');
  t('logged-out visitor cannot use admin API', r.s === 401, r);
  r = await anon('GET', '/api/admin/users');
  t('admin API refuses without login', r.s === 401, r);
  // ---- Payment ----
  r = await user('POST', '/api/checkout/initialize', { promo: 'FRIEND10' });
  const ref = r.j.reference;
  t('checkout starts, price comes from the server with 10% promo', r.s === 200 && r.j.total === 540 && orders[ref] && orders[ref].amount === 54000 && orders[ref].currency === 'USD', { r, o: orders[ref] });
  const wh = (obj, sig) => anon('POST', '/api/paystack/webhook', JSON.stringify(obj), { 'x-paystack-signature': sig });
  const ev = { event: 'charge.success', data: { reference: ref } };
  r = await wh(ev, 'bad-signature');
  t('webhook with a fake signature is rejected', r.s === 401, r);
  r = await wh(ev, crypto.createHmac('sha512', SECRET).update(JSON.stringify(ev)).digest('hex'));
  t('webhook with a valid signature is accepted', r.s === 200, r);
  await new Promise((x) => setTimeout(x, 400));
  r = await user('GET', '/api/me/dashboard');
  t('after payment the service is ACTIVE with an automatic update', r.j.services[0].status === 'active' && r.j.updates.some((u) => /Payment received/.test(u.text)), r.j);
  const n1 = r.j.updates.length;
  await user('GET', '/api/checkout/verify/' + ref); await wh(ev, crypto.createHmac('sha512', SECRET).update(JSON.stringify(ev)).digest('hex')); await new Promise((x) => setTimeout(x, 300));
  r = await user('GET', '/api/me/dashboard');
  t('paying twice is harmless (processed once)', r.j.updates.length === n1 && r.j.orders.length === 1, r.j);
  r = await user('GET', '/api/checkout/verify/' + ref);
  t('verify endpoint reports paid', r.j.status === 'paid', r);
  r = await anon('GET', '/api/checkout/verify/' + ref);
  t('logged-out visitors cannot check an order', r.s === 401, r);
  r = await pw('GET', '/api/checkout/verify/' + ref);
  t('and neither can another logged-in person', r.s === 401 || r.s === 404, r);
  r = await again('POST', '/api/checkout/initialize', {});
  t('empty cart cannot be checked out', r.s === 400, r);
  // ---- Admin work ----
  r = await admin('POST', '/api/auth/google', { credential: token({ email: 'boss@ardoha.test', sub: 'g-boss', name: 'The Boss' }) });
  r = await admin('GET', '/api/admin/stats');
  t('admin sees stats including revenue', r.s === 200 && r.j.revenueUsd === 540 && r.j.active === 1, r);
  r = await admin('GET', '/api/admin/users?q=ada');
  const uid = r.j[0] && r.j[0].id;
  t('admin can search clients', r.s === 200 && r.j.length === 1 && r.j[0].email === 'author@test.com', r);
  r = await admin('GET', '/api/admin/users/' + uid);
  const sid = r.j.services[0].id;
  r = await admin('PATCH', '/api/admin/services/' + sid, { progress: 60, status: 'active', note: 'Keywords approved', update: 'Your new Amazon blurb is live.' });
  t('admin updates progress and posts a message', r.s === 200 && r.j.services[0].progress === 60 && r.j.updates[0].text === 'Your new Amazon blurb is live.', r);
  r = await user('GET', '/api/me/dashboard');
  t('CLIENT SEES the admin\'s progress, note and update', r.j.services[0].progress === 60 && r.j.services[0].note === 'Keywords approved' && r.j.updates[0].text.startsWith('Your new Amazon'), r.j);
  r = await admin('POST', '/api/admin/users/' + uid + '/updates', { text: 'Strategy call booked for Friday.' });
  t('admin sends a stand-alone update', r.s === 200 && r.j.updates[0].text.startsWith('Strategy call'), r);
  const upid = r.j.updates[0].id;
  r = await admin('DELETE', '/api/admin/updates/' + upid);
  t('admin can delete an update', r.s === 200 && !r.j.updates.some((u) => u.id === upid), r);
  r = await admin('PATCH', '/api/admin/services/' + sid, { progress: 100 });
  t('reaching 100% marks the service completed', r.j.services[0].status === 'completed', r);
  r = await admin('PATCH', '/api/admin/services/' + sid, { progress: 999, status: 'hacked' });
  t('out-of-range values are clamped and bad statuses ignored', r.j.services[0].progress === 100 && ['active', 'completed', 'pending', 'paused'].includes(r.j.services[0].status), r);
  r = await admin('POST', '/api/admin/users/' + uid + '/services', { slug: 'cover-design', tier: 'premium', status: 'active' });
  t('admin can activate a service manually (for example, paid by bank transfer)', r.j.services.some((s) => s.slug === 'cover-design' && s.status === 'active'), r);
  // ---- Bookings, safety ----
  const bk = { name: 'Ada', email: 'a@b.com', date: '2026-12-01', time: '10:00 AM', tz: 'Africa/Lagos' };
  r = await anon('POST', '/api/bookings', bk); t('booking saved', r.s === 200, r);
  r = await anon('POST', '/api/bookings', Object.assign({}, bk, { email: 'other@b.com' })); t('same time slot cannot be booked twice', r.s === 409, r);
  r = await anon('GET', '/api/bookings/taken?date=2026-12-01'); t('taken times are available to the calendar', r.j.times.includes('10:00 AM'), r);
  r = await anon('POST', '/api/me/plan', { slug: 'amazon' }, { Origin: 'https://evil.com' }); t('requests from other websites are blocked', r.s === 403, r);
  r = await anon('POST', '/api/auth/login', '{bad json'); t('invalid JSON gets a clean error', r.s === 400, r);
  const x = await fetch(base + '/admin'); const html = await x.text(); t('admin page is served', x.status === 200 && /ARDOHA ADMIN/.test(html), x.status);
  r = await anon('GET', '/api/config'); t('public config exposes only the Google client id', r.j.googleClientId === CLIENT && !JSON.stringify(r.j).includes(SECRET), r);
  // ---- Concurrency: two payment confirmations at the same moment must activate services once ----
  const cu = client(); await cu('POST', '/api/auth/google', { credential: token({ email: 'racer@test.com', sub: 'g-race', name: 'Race Er' }) });
  await cu('POST', '/api/me/plan', { slug: 'cover-design', tier: 'starter' });
  r = await cu('POST', '/api/checkout/initialize', {});
  const rref = r.j.reference;
  await Promise.all([cu('GET', '/api/checkout/verify/' + rref), cu('GET', '/api/checkout/verify/' + rref), cu('GET', '/api/checkout/verify/' + rref)]);
  r = await cu('GET', '/api/me/dashboard');
  t('three simultaneous payment confirmations activate the service exactly once', r.j.services[0].status === 'active' && r.j.updates.filter((u) => /Payment received/.test(u.text)).length === 1, r.j);
  // ---- Concurrency: two sign-ups with the same email at the same moment ----
  const [s1, s2] = await Promise.all([client()('POST', '/api/auth/signup', { name: 'A', email: 'twin@test.com', password: 'longenough1' }), client()('POST', '/api/auth/signup', { name: 'B', email: 'twin@test.com', password: 'longenough1' })]);
  t('two sign-ups with the same email at once: one wins, one gets a clean 409 (no crash)', [s1.s, s2.s].sort().join() === '200,409', [s1.s, s2.s]);
  const [g1, g2] = await Promise.all([client()('POST', '/api/auth/google', { credential: token({ email: 'dbl@test.com', sub: 'g-dbl', name: 'Dbl' }) }), client()('POST', '/api/auth/google', { credential: token({ email: 'dbl@test.com', sub: 'g-dbl', name: 'Dbl' }) })]);
  t('two Google sign-ins at once create ONE account', g1.s === 200 && g2.s === 200 && g1.j.user.id === g2.j.user.id, [g1.j, g2.j]);
  r = await anon('GET', '/health'); t('health check confirms the database is reachable', r.s === 200 && r.j.ok === true, r);
  r = await admin('GET', '/api/admin/users?q=' + encodeURIComponent('100%')); t('search with wildcard characters is treated as plain text', r.s === 200 && r.j.length === 0, r);
  r = await admin('GET', '/api/admin/users/abc'); t('a non-numeric id gets a clean 404', r.s === 404, r);
  r = await admin('GET', '/api/admin/users/99999999999'); t('a huge id gets a clean 404 (no database error)', r.s === 404, r);
  console.log(`\n${pass} passed, ${fail} failed` + (REAL ? '  (real PostgreSQL)' : '  (STAND-IN, not PostgreSQL)'));
  try { await require('../db').dropTestSchema(); } catch (e) { console.log('Could not remove the test schema:', e.message); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
