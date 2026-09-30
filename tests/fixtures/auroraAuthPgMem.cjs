'use strict';

// A pg-mem database with the SHIPPED Aurora auth DDL (migrations 013 + 014), exposing the two entry
// points authStore uses: `query` and `withClient`.
//
// pg-mem runs one statement at a time, so it proves what the SQL does, not that it is atomic under
// concurrency. Atomicity is pinned against real PostgreSQL in
// tests/integration/aurora_otp_start_atomic_postgres.test.js.

const fs = require('node:fs');
const path = require('node:path');
const { newDb, DataType } = require('pg-mem');

const MIGRATIONS = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');

function statements(file) {
  return fs
    .readFileSync(path.join(MIGRATIONS, file), 'utf8')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function auroraAuthDdl() {
  const tables = statements('013_aurora_accounts.sql')
    .filter((s) => /\b(aurora_users|aurora_auth_challenges|aurora_auth_sessions)\b/.test(s))
    .filter((s) => !/aurora_identity_links|aurora_account_/.test(s));
  const password = statements('014_aurora_password_auth.sql');
  // Migration 060 (LOCK TABLE, the duplicate-closing UPDATE and a PARTIAL unique index) is NOT applied
  // here: pg-mem answers a plain `WHERE email = $1` through the partial index and so silently drops
  // every closed row from counts and reads. 060 is exercised on real PostgreSQL instead.
  return [...tables, ...password];
}

function makeAuroraAuthDb() {
  const db = newDb();
  db.public.registerFunction({ name: 'hashtext', args: [DataType.text], returns: DataType.integer, implementation: () => 0 });
  db.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer],
    returns: DataType.text,
    implementation: () => '',
    impure: true,
  });
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  const ready = (async () => {
    for (const stmt of auroraAuthDdl()) await pool.query(stmt);
  })();
  const query = async (sql, params) => {
    await ready;
    return pool.query(sql, params);
  };
  const withClient = async (fn) => {
    await ready;
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  };
  return { query, withClient };
}

module.exports = { makeAuroraAuthDb, auroraAuthDdl };
