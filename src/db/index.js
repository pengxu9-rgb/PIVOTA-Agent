let pool = null;
let poolCtor = null;
let poolCtorResolved = false;

function getPoolConstructor() {
  if (poolCtorResolved) return poolCtor;
  poolCtorResolved = true;
  try {
    // Load lazily so local/unit environments without `pg` can still run non-DB paths.
    const mod = require('pg');
    poolCtor = mod && typeof mod.Pool === 'function' ? mod.Pool : null;
  } catch (_err) {
    poolCtor = null;
  }
  return poolCtor;
}

function shouldUseSsl(databaseUrl) {
  if (process.env.DB_SSL === 'true') return true;
  const url = String(databaseUrl || '');
  return (
    /[?&]sslmode=(require|verify-full|verify-ca)\b/i.test(url) ||
    /[?&]ssl=true\b/i.test(url)
  );
}

function getPool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const Pool = getPoolConstructor();
  if (!Pool) return null;
  if (!pool) {
    const useSsl = shouldUseSsl(databaseUrl);
    pool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DB_POOL_MAX || 5),
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS || 10000),
      ssl:
        useSsl
          ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
          : undefined,
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) {
    const err = new Error('DATABASE_URL not configured or pg driver unavailable');
    err.code = 'NO_DATABASE';
    throw err;
  }
  return p.query(text, params);
}

async function withClient(fn) {
  const p = getPool();
  if (!p) {
    const err = new Error('DATABASE_URL not configured or pg driver unavailable');
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
