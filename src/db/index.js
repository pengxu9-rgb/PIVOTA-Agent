const { Pool } = require('pg');

let pool = null;

function getPool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DB_POOL_MAX || 5),
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS || 10000),
      ssl:
        process.env.DB_SSL === 'true'
          ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
          : undefined,
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) {
    const err = new Error('DATABASE_URL not configured');
    err.code = 'NO_DATABASE';
    throw err;
  }
  return p.query(text, params);
}

async function withClient(fn) {
  const p = getPool();
  if (!p) {
    const err = new Error('DATABASE_URL not configured');
    err.code = 'NO_DATABASE';
    throw err;
  }
  const client = await p.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  query,
  withClient,
};

