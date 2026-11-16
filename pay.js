'use strict';
// Paystack payments. The server decides prices; the browser only says which services.
const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./errors');
const PRICES = require('./prices.json');
const TIERS = { starter: 0, growth: 1, premium: 2 };
const PROMOS = { WELCOME10: 0.1, FRIEND10: 0.1 };
const KEY = () => process.env.PAYSTACK_SECRET_KEY;
const API = () => process.env.PAYSTACK_API_URL || 'https://api.paystack.co';
const CUR = () => process.env.CURRENCY || 'USD';
const now = () => new Date().toISOString();

async function ps(method, endpoint, body) {
  const r = await fetch(API() + endpoint, { method, headers: { Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
function price(slug, tier) { return PRICES[slug][TIERS[tier]]; }
function quote(services, promo) {
  const usd = services.reduce((t, s) => t + price(s.slug, s.tier), 0);
  const code = promo ? String(promo).toUpperCase() : null;
  const off = code && PROMOS[code] ? Math.round(usd * PROMOS[code]) : 0;
  const total = usd - off;
  const rate = Number(process.env.USD_NGN_RATE || 0);
  const minor = CUR() === 'USD' ? Math.round(total * 100) : Math.round(total * rate * 100);
  return { usd, off, total, minor, promo: off ? code : null };
}

// Start a payment for everything in the client's cart (their PENDING services).
async function initialize(user, promo) {
  if (!KEY()) throw new HttpError(503, 'Payments are not configured');
  const pending = await db.many("SELECT * FROM services WHERE user_id = $1 AND status = 'pending'", [user.id]);
  if (!pending.length) throw new HttpError(400, 'Your cart is empty');
  const q = quote(pending, promo);
  const reference = 'ARD-' + crypto.randomBytes(8).toString('hex').toUpperCase();
  const r = await ps('POST', '/transaction/initialize', {
    email: user.email, amount: q.minor, currency: CUR(), reference,
    callback_url: (process.env.SITE_URL || '').split(',')[0].trim() + '/',
    metadata: { order: reference },
  });
 if (!r.status) {
  console.error('Paystack rejected payment:', r.message);
  throw new HttpError(502, 'Paystack error: ' + (r.message || 'Unknown error'));
}
  const items = pending.map((s) => ({ slug: s.slug, tier: s.tier, usd: price(s.slug, s.tier) }));
  await db.query('INSERT INTO orders(reference, user_id, items_json, total_usd, amount_minor, currency, promo, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8)',
    [reference, user.id, JSON.stringify(items), q.total, q.minor, CUR(), q.promo, now()]);
  return { authorization_url: r.data.authorization_url, reference, total: q.total };
}

// Confirm with Paystack, check amount and currency, then activate services exactly once.
async function fulfil(reference) {
  const o = await db.one('SELECT * FROM orders WHERE reference = $1', [reference]);
  if (!o) return null;
  if (o.status === 'paid') return o;
  const v = await ps('GET', '/transaction/verify/' + encodeURIComponent(reference));
  const d = v && v.data; console.log('PAYMENT VERIFICATION:', JSON.stringify({
  status: d && d.status,
  amount: d && d.amount,
  requested_amount: d && d.requested_amount,
  expected_amount: o.amount_minor,
  currency: d && d.currency,
  reference: d && d.reference
}));
if (
  d &&
  d.status === 'success' &&
  d.domain === 'live' &&
  d.reference === reference &&
  (d.requested_amount ?? d.amount) === o.amount_minor &&
  d.currency === o.currency
) { await db.tx(async (q) => {
      // The "status <> 'paid'" condition makes this safe if the webhook and the customer's return arrive together:
      // PostgreSQL lets only one of them change the row, so services are activated once.
      const upd = await q("UPDATE orders SET status = 'paid', paid_at = $1 WHERE reference = $2 AND status <> 'paid'", [now(), reference]);
      if (upd.rowCount) {
        for (const i of JSON.parse(o.items_json)) {
          await q("UPDATE services SET status = 'active', progress = 0, updated_at = $1 WHERE user_id = $2 AND slug = $3 AND status = 'pending'", [now(), o.user_id, i.slug]);
        }
        await q('INSERT INTO updates(user_id, text, author, created_at) VALUES($1, $2, $3, $4)',
          [o.user_id, `Payment received (order ${reference}). Your services are now active and your team will be in touch to begin.`, 'Ardoha', now()]);
      }
    });
  } else if (d && (d.status === 'failed' || d.status === 'abandoned')) {
    await db.query("UPDATE orders SET status = $1 WHERE reference = $2 AND status = 'pending'", [d.status, reference]);
  }
  return db.one('SELECT * FROM orders WHERE reference = $1', [reference]);
}

function signatureOk(raw, header) {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;

  if (!secret || !Buffer.isBuffer(raw) || typeof header !== 'string') {
    return false;
  }

  let timestamp = null;
  const signatures = [];

  for (const part of header.split(',')) {
    const [key, ...values] = part.trim().split('=');
    const value = values.join('=');

    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      const colon = value.indexOf(':');
      if (colon !== -1) {
        signatures.push(value.slice(colon + 1));
      }
    }
  }

  const time = Number(timestamp);

  if (!Number.isInteger(time) ||
      Math.abs(Math.floor(Date.now() / 1000) - time) > 300) {
    return false;
  }

  const expected = crypto.createHmac('sha512', secret)
    .update(String(time) + '.')
    .update(raw)
    .digest();

  return signatures.some(sig =>
    /^[0-9a-f]{128}$/.test(sig) &&
    crypto.timingSafeEqual(expected, Buffer.from(sig, 'hex'))
  );
}
module.exports = { quote, initialize, fulfil, signatureOk, price, TIERS, PRICES };
