'use strict';
// Accounts, sessions, passwords and Google token verification. All database work is asynchronous (PostgreSQL).
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');
const { HttpError } = require('./errors');

const scrypt = promisify(crypto.scrypt);
const now = () => new Date().toISOString();

// ---------- Passwords (scrypt, per-user salt). Async so hashing never blocks other visitors. ----------
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return salt.toString('hex') + '$' + h.toString('hex');
}
async function checkPassword(pw, stored) {
  const [s, h] = (stored || '00$00').split('$');
  const salt = Buffer.from(s, 'hex');
  const want = Buffer.from(h, 'hex');
  const got = await scrypt(pw, salt.length ? salt : Buffer.alloc(16), 64, { N: 16384, r: 8, p: 1 }); // runs even with no stored hash, so timing stays similar
  return !!stored && want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ---------- Sessions (random token in an HttpOnly cookie, only its hash is stored) ----------
const COOKIE = 'ard_session';
const DAYS = 14;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1, $2, $3)', [sha(token), userId, Date.now() + DAYS * 864e5]);
  return token;
}
function cookieHeader(token, clear) {
  const prod = process.env.NODE_ENV === 'production';
  const same = process.env.COOKIE_SAMESITE || 'Lax';
  const parts = [`${COOKIE}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', `SameSite=${same}`, `Max-Age=${clear ? 0 : DAYS * 86400}`];
  if (prod || same === 'None') parts.push('Secure');
  if (process.env.COOKIE_DOMAIN) parts.push('Domain=' + process.env.COOKIE_DOMAIN);
  return parts.join('; ');
}
function readToken(req) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return m ? m.slice(COOKIE.length + 1) : null;
}
async function userFromRequest(req) {
  const t = readToken(req);
  if (!t) return null;
  const row = await db.one('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1', [sha(t)]);
  if (!row) return null;
  if (row.expires_at < Date.now()) { await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(t)]); return null; }
  return row;
}
async function destroySession(req) {
  const t = readToken(req);
  if (t) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(t)]);
}
async function purgeExpiredSessions() { await db.query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]); }
async function touchLogin(userId) { await db.query('UPDATE users SET last_login = $1 WHERE id = $2', [now(), userId]); }

// ---------- Account operations ----------
const getUserById = (id) => db.one('SELECT * FROM users WHERE id = $1', [id]);
const getUserByEmail = (email) => db.one('SELECT * FROM users WHERE email = $1', [email]);

// Verified Google profile -> existing or new account. role is decided by the server (admin list), never by the browser.
async function signInWithGoogle(g, role, name) {
  let u = (await db.one('SELECT * FROM users WHERE google_sub = $1', [g.sub])) || (await getUserByEmail(g.email));
  let isNew = false;
  if (!u) {
    try {
      u = (await db.query("INSERT INTO users(email, name, role, provider, google_sub, created_at) VALUES($1, $2, $3, 'google', $4, $5) RETURNING *",
        [g.email, name, role, g.sub, now()])).rows[0];
      isNew = true;
    } catch (e) {
      if (e.code !== '23505') throw e; // two sign-ins at the same moment: use the account the other one just made
      u = await db.one('SELECT * FROM users WHERE google_sub = $1 OR email = $2', [g.sub, g.email]);
      if (!u) throw e;
    }
  } else {
    if (!u.google_sub) {
      // Linking Google to an existing password account: drop the old password and sessions, so nobody who
      // pre-registered this email can keep access.
      await db.tx(async (q) => {
        await q("UPDATE users SET google_sub = $1, pw_hash = NULL, provider = 'google' WHERE id = $2", [g.sub, u.id]);
        await q('DELETE FROM sessions WHERE user_id = $1', [u.id]);
      });
    }
    u = (await db.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING *', [role, u.id])).rows[0];
  }
  return { user: u, isNew };
}
async function signUpWithPassword({ name, email, password, title, goal }) {
  if (await getUserByEmail(email)) throw new HttpError(409, 'An account with this email already exists');
  const hash = await hashPassword(password);
  try {
    const u = (await db.query("INSERT INTO users(email, name, role, provider, pw_hash, book_title, goal, created_at) VALUES($1, $2, 'user', 'password', $3, $4, $5, $6) RETURNING *",
      [email, name, hash, title, goal, now()])).rows[0];
    return { user: u, isNew: true };
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'An account with this email already exists');
    throw e;
  }
}
async function signInWithPassword(email, password) {
  const u = await getUserByEmail(email);
  const ok = await checkPassword(password, u && u.pw_hash);
  if (!u || !ok) throw new HttpError(401, 'Email or password is incorrect');
  return { user: u, isNew: false };
}

// ---------- Google ID token verification (no library) ----------
const JWKS_URL = process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
let jwks = { keys: [], at: 0 };
async function loadJwks(force) {
  if (!force && Date.now() - jwks.at < 3600e3) return;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error('Could not load Google keys');
  jwks = { keys: (await r.json()).keys || [], at: Date.now() };
}
async function findKey(kid) {
  await loadJwks(false);
  let k = jwks.keys.find((x) => x.kid === kid);
  if (!k && Date.now() - jwks.at > 300e3) { await loadJwks(true); k = jwks.keys.find((x) => x.kid === kid); } // key rotation, at most every 5 min
  return k;
}
async function verifyGoogleToken(idToken, clientId) {
  if (!clientId) throw new Error('Google sign-in is not configured');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error('Bad algorithm');
  const jwk = await findKey(header.kid);
  if (!jwk) throw new Error('Unknown signing key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (!crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), key, Buffer.from(s, 'base64url'))) throw new Error('Bad signature');
  const t = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw new Error('Bad issuer');
  if (payload.aud !== clientId) throw new Error('Token is for a different app');
  if (!payload.exp || payload.exp < t) throw new Error('Token expired');
  if (payload.iat && payload.iat > t + 300) throw new Error('Token not valid yet');
  if (!payload.sub || !payload.email) throw new Error('Missing profile');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw new Error('Google email not verified');
  return { sub: payload.sub, email: String(payload.email).toLowerCase(), name: payload.name || String(payload.email).split('@')[0], picture: payload.picture || '' };
}

module.exports = {
  hashPassword, checkPassword, createSession, cookieHeader, userFromRequest, destroySession, purgeExpiredSessions, touchLogin,
  getUserById, getUserByEmail, signInWithGoogle, signUpWithPassword, signInWithPassword, verifyGoogleToken,
};
