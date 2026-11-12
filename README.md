# Ardoha backend (PostgreSQL / Supabase)

One small service that gives the website everything that needs a server:

- **Real Google sign-in.** The server verifies Google's signed token itself (signature, app, issuer, expiry, verified email) before logging anyone in.
- **Email sign-up and login** with safely hashed passwords.
- **Client dashboards** stored in PostgreSQL: services, pending vs active, progress, notes and updates.
- **Admin panel** at `/admin` where your team updates every client's dashboard.
- **Cart and Paystack payments.** Prices are decided on the server. Payments are confirmed with Paystack, and services switch from Pending to Active automatically.
- **Bookings** with no double-booking across visitors.

Needs **Node 18 or newer** and one package, `pg` (the PostgreSQL driver). The database is PostgreSQL, so it works with **Supabase** or any other PostgreSQL. The server no longer needs a persistent disk, so any host works.

## What changed from the SQLite version
| File | Change |
|---|---|
| `db.js` | SQLite replaced by a PostgreSQL connection pool (SSL on by default for hosted databases), `$1, $2` placeholders, a `tx()` helper for all-or-nothing transactions, and the schema (created automatically on start). |
| `server.js` | Every route that touches the database is `async`/`await`. Search escapes wildcards. IDs are validated. Health check tests the database. Clean shutdown closes the pool. |
| `auth.js` | Account and session operations moved here and made asynchronous. Password hashing no longer blocks the server. Duplicate sign-ups made at the same moment are handled cleanly. |
| `pay.js` | Orders, payments and service activation are asynchronous and run in a transaction. Two confirmations arriving at once activate services only once. |
| `package.json` | Adds `pg`. |
| `.env.example` | Adds `DATABASE_URL` (Supabase) and SSL settings. `DB_PATH` is gone. |
| `test/run.js` | 60 checks. Runs against real PostgreSQL when you give it a database (see below). |

## IMPORTANT: how this was tested
The environment I built this in has **no PostgreSQL server and no internet**, so I could **not** run the tests against real PostgreSQL. What I did:
- Wrote the SQL in standard PostgreSQL syntax and reviewed every query.
- Ran all 60 checks against a **SQLite-backed stand-in for the `pg` driver** (`test/pg-standin.js`). It checks the application logic, the asynchronous flow and transactions. It is deliberately strict: it rejects SQLite-only syntax and any query whose parameter count doesn't match, which are common PostgreSQL failures.
- Re-ran the browser tests (the website, the admin panel and the backend together) the same way: all pass.

**So please run the real check yourself before going live.** It takes a minute:
```bash
npm install
TEST_DATABASE_URL="postgresql://postgres.PROJECT:PASSWORD@HOST:5432/postgres" npm test
```
This runs the same 60 checks against your real database inside a **throw-away schema** (named `ard_test_xxxx`), which is deleted at the end. Your real tables are never touched. Use a direct or session-pooler connection for tests (not the transaction pooler), because the test schema uses a per-connection setting. The first line of output tells you whether it used the real database or the stand-in. If anything fails, send me the message and I will fix it.

## Setup

### 1. Create the Supabase database
1. Create a project at supabase.com and choose a region near your customers. Save the **database password**.
2. Open **Connect** in the dashboard and copy a connection string. For hosts such as Render, Railway or Fly (which connect over IPv4), use the **pooler** string (the host ends in `pooler.supabase.com`). Put your password into it. Check the Connect panel for the current options, as Supabase updates them.
3. Put it in `DATABASE_URL`.
4. Start the server once. It creates the tables automatically. (Or paste `schema.sql` into Supabase's SQL Editor and run it.)
5. **Security: row level security is switched on for every table** (the schema does this). That blocks Supabase's built-in public web API from reading your tables. Without it, anyone holding your public key could read customer data. The server connects as the table owner (the `postgres` user in your connection string), so it is not affected. Never put your Supabase `service_role` key or database password in the website code.
6. Turn on **backups** in Supabase (Database > Backups). Daily backups are included on paid plans. Check your plan.

### 2. Google sign-in
1. In Google Cloud Console, set up the **OAuth consent screen** (app name Ardoha, support email, logo, privacy policy and terms links).
2. **Credentials > Create credentials > OAuth client ID > Web application.**
3. Under **Authorized JavaScript origins** add your website (`https://www.your-domain.com`) and your API address (`https://api.your-domain.com`, because the admin page signs in there). Add `http://localhost:3000` while testing.
4. Copy the **Client ID** into `GOOGLE_CLIENT_ID`. You do not need the client secret.

### 3. Host the backend
Any host that runs Node 18+ works (Render, Railway, Fly.io, a VPS). **No persistent disk is needed any more.**
- Build command: `npm install`. Start command: `node server.js`.
- Set every variable from `.env.example` in the host's dashboard. Use HTTPS only, and give the API its own address such as `api.your-domain.com`.
- Test it: open `https://api.your-domain.com/health`. It should say `{"ok":true}`. A 503 means the database can't be reached.

### 4. Connect the website
Add to the live site, just before the closing body tag: a small script that sets `window.ARD_CONFIG = { api: "https://api.your-domain.com" }`, then a script tag that loads `site/ardoha-live.js`. With no `api` set, the site stays in demo mode.

### 5. Paystack
1. Add your **test secret key** as `PAYSTACK_SECRET_KEY`.
2. In Paystack **Settings > API Keys & Webhooks**, set the webhook URL to `https://api.your-domain.com/api/paystack/webhook`.
3. Confirm USD is enabled for your business, or set `CURRENCY=NGN` and `USD_NGN_RATE`.
4. Test with Paystack's test cards, including a failed payment. Then switch to live keys and make one small real payment.
5. Keep `prices.json` the same as the prices on the website. The server's price is the one that counts.

### 6. Your team's admin panel
Put your team's Google emails in `ADMIN_EMAILS`, open `https://api.your-domain.com/admin` and sign in with Google. Search for a client, then set a service's status and progress, add a note, post an update, add a service (for example one paid by bank transfer), delete a wrong update, and see their orders. Turn on 2-step verification on those Google accounts.

## Notes on the PostgreSQL version
- **Connection pooling:** the pool opens up to 10 connections (`DB_POOL_MAX`). On Supabase's free plan, keep it small, or use the pooler string.
- **Transactions:** payments, plan changes and admin saves that touch several tables run as all-or-nothing transactions.
- **Race conditions:** an order can only be marked paid once, and duplicate sign-ups and Google sign-ins made at the same moment are handled (covered by tests).
- **Times** are stored as `TIMESTAMPTZ` (with time zone). **Counts and sums** are converted to normal numbers.
- **Moving data from the SQLite version:** if you only used it for testing, start fresh. If you have real data to keep, tell me and I'll write a one-time copy script.

## How it stays secure
- The Google token is checked against Google's public keys. Forged tokens, ones made for a different app, expired ones, and ones with an unverified email are refused.
- Sessions are random tokens in `HttpOnly` cookies. Only a hash is stored, and logout ends the session.
- If someone registers with an email they don't own, then the real owner signs in with Google, the old password and sessions are removed.
- Passwords use scrypt with a unique salt. All queries use parameters, so typed text can never become SQL.
- Prices and promo codes are decided on the server only. Payments are confirmed with Paystack and processed once.
- Only your website's address may call the API, and repeated requests are rate-limited.
- Everything shown on the dashboard and admin panel is escaped, so text typed by clients or staff can't run as code.

## Known limits and next steps
- No emails are sent yet (welcome, receipts, new-update alerts).
- No password reset or email verification for email sign-ups. Google users don't need them.
- Business hours for bookings are still the placeholder in the site code.
- Add your terms, refund policy and privacy policy pages before taking payments or publishing Google sign-in.
- Please have a developer review the live setup before you take real customer money.
