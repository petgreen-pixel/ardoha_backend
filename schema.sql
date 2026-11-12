-- Ardoha database schema (PostgreSQL / Supabase).
-- The server creates these tables automatically on first start. You only need this file if you
-- prefer to create them yourself: paste it into Supabase > SQL Editor and run it.

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
