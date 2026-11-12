'use strict';
// A STAND-IN for the `pg` driver, backed by Node's built-in SQLite. It is used ONLY when no real PostgreSQL is
// available (for example in a sandbox without internet). It exercises the application's asynchronous logic,
// transactions and SQL structure, but it is NOT PostgreSQL. Run `TEST_DATABASE_URL=... npm test` for the real check.
const { DatabaseSync } = require('node:sqlite');

function translate(sql) {
  return sql
    .replace(/ALTER TABLE \w+ ENABLE ROW LEVEL SECURITY;?/gi, '')
    .replace(/CREATE SCHEMA[^;]*;?/gi, '')
    .replace(/\bSERIAL PRIMARY KEY\b/gi, 'INTEGER PRIMARY KEY')
    .replace(/\bTIMESTAMPTZ\b/gi, 'TEXT')
    .replace(/\bBIGINT\b/gi, 'INTEGER')
    .replace(/\$(\d+)/g, '?$1')
    .replace(/\bILIKE\b/gi, 'LIKE');
}
// PostgreSQL is stricter than SQLite. Reject the mistakes SQLite would quietly accept.
function lint(sql, params) {
  const bad = [[/\?/, 'a "?" placeholder (PostgreSQL uses $1, $2)'], [/\bPRAGMA\b/i, 'PRAGMA'], [/\bAUTOINCREMENT\b/i, 'AUTOINCREMENT'],
    [/\bINSERT\s+OR\b/i, 'INSERT OR ...'], [/\b(datetime|strftime|ifnull)\s*\(/i, 'a SQLite-only function'], [/lastInsertRowid/i, 'lastInsertRowid (use RETURNING)']];
  for (const [re, what] of bad) if (re.test(sql.replace(/'[^']*'/g, "''"))) throw new Error('Not valid PostgreSQL: uses ' + what + ' in: ' + sql.slice(0, 80));
  const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const n = params ? params.length : 0;
  if (used.length !== n || used.some((v, i) => v !== i + 1)) {
    const e = new Error(`PostgreSQL would reject this: the query uses parameters [${used}] but ${n} value(s) were supplied: ` + sql.slice(0, 80));
    e.code = '08P01'; throw e;
  }
}
function mapError(e) {
  const m = String(e.message || '');
  if (/UNIQUE constraint failed/.test(m)) e.code = '23505';
  else if (/FOREIGN KEY constraint failed/.test(m)) e.code = '23503';
  else if (/CHECK constraint failed/.test(m)) e.code = '23514';
  else if (/NOT NULL constraint failed/.test(m)) e.code = '23502';
  return e;
}

const shared = new DatabaseSync(':memory:');
shared.exec('PRAGMA foreign_keys = ON');
let chain = Promise.resolve(); // one connection: run statements one at a time

function run(sql, params) {
  lint(sql, params);
  const text = translate(sql).trim();
  try {
    if (!params && /;\s*\S/.test(text)) { shared.exec(text); return { rows: [], rowCount: 0 }; } // several statements (schema setup)
    if (!text) return { rows: [], rowCount: 0 };
    if (/^(BEGIN|COMMIT|ROLLBACK|SET )/i.test(text)) { shared.exec(text.replace(/^SET .*/i, 'SELECT 1')); return { rows: [], rowCount: 0 }; }
    const st = shared.prepare(text);
    const p = (params || []).map((v) => (v === undefined ? null : v));
    if (/^(SELECT|WITH)/i.test(text) || /\bRETURNING\b/i.test(text)) {
      const rows = st.all(...p).map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: Number(st.run(...p).changes) };
  } catch (e) { throw mapError(e); }
}

class Client {
  constructor(release) { this._release = release; }
  async query(sql, params) { return run(sql, params); }
  release() { this._release(); }
}
class Pool {
  constructor() { this.handlers = {}; }
  on(ev, fn) { this.handlers[ev] = fn; return this; }
  query(sql, params) { const r = chain.then(() => run(sql, params)); chain = r.catch(() => {}); return r; }
  connect() { // holds the connection for a whole transaction
    return new Promise((resolve) => {
      chain = chain.then(() => new Promise((done) => resolve(new Client(done))));
    });
  }
  async end() {}
}
module.exports = { Pool, types: { setTypeParser() {} } };
