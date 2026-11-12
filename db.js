'use strict';
// PostgreSQL (works with Supabase). All queries are asynchronous and use $1, $2 placeholders.
const { Pool, types } = require('pg');

// PostgreSQL returns bigint (COUNT, SUM, BIGINT columns) as text by default. Turn them into numbers.
types.setTypeParser(20, (v) => parseInt(v, 10));

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Add your Supabase (or other PostgreSQL) connection string.');

// Supabase and most hosted databases require SSL. Local databases usually don't.
const isLocal = /@(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
const sslOn = process.env.DB_SSL ? process.env.DB_SSL !== 'false' : !isLocal;
const pool = new Pool({
  connectionString: url,
  ssl: sslOn ? { rejectUnauthorized: process.env.DB_SSL_STRICT === 'true' } : false,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
// An idle connection can drop (database restart, network). Log it instead of crashing the server.
pool.on('error', (e) => console.error('Database pool error:', e.message));

// Optional: keep everything in a separate schema (used by the tests so they never touch real data).
const schema = process.env.DB_SCHEMA || '';
if (schema) {
  if (!/^[a-z0-9_]+$/i.test(schema)) throw new Error('DB_SCHEMA may only contain letters, numbers and underscores');
  pool.on('connect', (client) => client.query(`SET search_path TO ${schema}`));
}

const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const many = async (text, params) => (await pool.query(text, params)).rows;

// Run several statements as one all-or-nothing transaction.
// fn receives a query function that uses the SAME connection. Do not use the pool inside fn.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users(
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  provider TEXT NOT NULL,
  google_sub TEXT UNIQUE,
  pw_hash TEXT,
  book_title TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT 'unsure',
  created_at TIMESTAMPTZ NOT NULL,
  last_login TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS services(
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(user_id, slug)
);
CREATE TABLE IF NOT EXISTS updates(
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  service_slug TEXT,
  author TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_user_idx ON updates(user_id, id);
CREATE TABLE IF NOT EXISTS orders(
  id SERIAL PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  items_json TEXT NOT NULL,
  total_usd INTEGER NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  promo TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id);
CREATE TABLE IF NOT EXISTS bookings(
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT,
  slot_date TEXT NOT NULL,
  slot_time TEXT NOT NULL,
  tz TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(slot_date, slot_time)
);
-- Supabase publishes tables in the public schema through its own web API. Turning on row level security
-- (with no policies) blocks that route completely. This server connects as the table owner, so it is not affected.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
`;

// Creates the tables if they do not exist yet. Safe to run on every start.
async function init() {
  if (schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await pool.query(SCHEMA_SQL);
}

// Tests only: remove the throw-away schema.
async function dropTestSchema() {
  if (schema && /^ard_test_/.test(schema)) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
}
const close = () => pool.end();

module.exports = { query, one, many, tx, init, close, dropTestSchema, SCHEMA_SQL };
