let kbPool = null;
let poolCtor = null;
let poolCtorResolved = false;

function getPoolConstructor() {
  if (poolCtorResolved) return poolCtor;
  poolCtorResolved = true;
  try {
    const mod = require('pg');
    poolCtor = mod && typeof mod.Pool === 'function' ? mod.Pool : null;
  } catch (_err) {
    poolCtor = null;
  }
  return poolCtor;
}

function getKbDatabaseUrl() {
  return String(process.env.PCI_KB_DATABASE_URL || '').trim();
}

function shouldUseSsl(databaseUrl) {
  if (process.env.PCI_KB_DB_SSL === 'true') return true;
  const url = String(databaseUrl || '');
  return (
    /[?&]sslmode=(require|verify-full|verify-ca)\b/i.test(url) ||
    /[?&]ssl=true\b/i.test(url)
  );
}

function isDedicatedKbConfigured() {
  const kb = getKbDatabaseUrl();
  if (!kb) return false;
  return kb !== String(process.env.DATABASE_URL || '').trim();
}

function getKbPool() {
  const databaseUrl = getKbDatabaseUrl();
  if (!databaseUrl) return null;
  if (!isDedicatedKbConfigured()) return null;
  const Pool = getPoolConstructor();
  if (!Pool) return null;
  if (!kbPool) {
    const useSsl = shouldUseSsl(databaseUrl);
    kbPool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.PCI_KB_DB_POOL_MAX || 3),
      idleTimeoutMillis: Number(process.env.PCI_KB_DB_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.PCI_KB_DB_CONN_TIMEOUT_MS || 10000),
      ssl:
        useSsl
          ? { rejectUnauthorized: process.env.PCI_KB_DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
          : undefined,
    });
  }
  return kbPool;
}

async function kbQuery(text, params) {
  const pool = getKbPool();
  if (!pool) return null;
  return pool.query(text, params);
}

module.exports = {
  getKbDatabaseUrl,
  isDedicatedKbConfigured,
  kbQuery,
};
