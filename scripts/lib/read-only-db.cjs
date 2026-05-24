'use strict';

const { Pool } = require('pg');

let pool = null;

function requireReadOnlyDatabaseUrl() {
  const url = String(process.env.DATABASE_URL_PUBLIC || '').trim();
  if (!url) {
    throw new Error('DATABASE_URL_PUBLIC is required for read-only PDP sampling; no fallback is allowed');
  }
  return url;
}

function getPool() {
  if (pool) return pool;
  const connectionString = requireReadOnlyDatabaseUrl();
  pool = new Pool({
    connectionString,
    max: Number(process.env.DB_PUBLIC_POOL_MAX || 2),
    idleTimeoutMillis: Number(process.env.DB_PUBLIC_IDLE_TIMEOUT_MS || 10000),
    connectionTimeoutMillis: Number(process.env.DB_PUBLIC_CONN_TIMEOUT_MS || 10000),
    ssl:
      /[?&]sslmode=(require|verify-full|verify-ca)\b/i.test(connectionString) ||
      /[?&]ssl=true\b/i.test(connectionString)
        ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : undefined,
  });
  return pool;
}

async function queryReadOnly(text, params = []) {
  const sql = String(text || '').trim();
  if (!/^select\b/i.test(sql) && !/^with\b/i.test(sql)) {
    throw new Error('read-only helper only accepts SELECT/CTE queries');
  }
  return getPool().query(sql, params);
}

async function closeReadOnlyPool() {
  if (!pool) return;
  const existing = pool;
  pool = null;
  await existing.end();
}

module.exports = {
  closeReadOnlyPool,
  queryReadOnly,
  requireReadOnlyDatabaseUrl,
};
