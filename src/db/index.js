const logger = require('../logger');

let pool = null;
let poolCtor = null;
let poolCtorResolved = false;
let poolResetState = { pool: null, promise: null };

const TRANSIENT_DB_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  '57P01',
  '57P02',
  '57P03',
]);

function parseIntegerEnv(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function getDbQueryRetries() {
  return parseIntegerEnv(process.env.DB_QUERY_RETRIES, 1, { min: 0, max: 3 });
}

function getDbConnectRetries() {
  return parseIntegerEnv(process.env.DB_CONNECT_RETRIES, 1, { min: 0, max: 3 });
}

function getDbRetryBackoffMs() {
  return parseIntegerEnv(process.env.DB_QUERY_RETRY_BACKOFF_MS, 75, { min: 0, max: 2000 });
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDbError(err) {
  const code = String(err?.code || '').trim().toUpperCase();
  const message = String(err?.message || err || '').toLowerCase();
  if (!code && !message) return false;
  if (TRANSIENT_DB_ERROR_CODES.has(code)) return true;
  if (code.startsWith('08')) return true;
  return (
    message.includes('econnreset') ||
    message.includes('connection reset') ||
    message.includes('connection terminated unexpectedly') ||
    message.includes('server closed the connection unexpectedly') ||
    message.includes('socket hang up') ||
    message.includes('terminating connection due to administrator command') ||
    message.includes('client has encountered a connection error') ||
    message.includes('connection terminated')
  );
}

function buildNoDatabaseError() {
  const err = new Error('DATABASE_URL not configured or pg driver unavailable');
  err.code = 'NO_DATABASE';
  return err;
}

async function resetPool(sourcePool, reason, err) {
  const existingPool = sourcePool || pool;
  if (!existingPool) return;
  if (pool === existingPool) pool = null;
  if (poolResetState.pool === existingPool && poolResetState.promise) {
    await poolResetState.promise;
    return;
  }
  const resetPromise = (async () => {
    try {
      if (typeof existingPool.end === 'function') {
        await existingPool.end();
      }
    } catch (endErr) {
      logger.warn(
        {
          reason,
          err: endErr?.message || String(endErr),
          original_err: err?.message || null,
        },
        'Failed to close Postgres pool after transient error',
      );
    } finally {
      if (poolResetState.pool === existingPool) {
        poolResetState = { pool: null, promise: null };
      }
    }
  })();
  poolResetState = { pool: existingPool, promise: resetPromise };
  await resetPromise;
}

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
    const nextPool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DB_POOL_MAX || 5),
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS || 10000),
      ssl:
        useSsl
          ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
          : undefined,
    });
    if (typeof nextPool.on === 'function') {
      nextPool.on('error', (err) => {
        logger.warn(
          { err: err?.message || String(err), code: err?.code || null },
          'Postgres pool emitted client error; resetting pool',
        );
        resetPool(nextPool, 'pool_error', err).catch((resetErr) => {
          logger.warn(
            { err: resetErr?.message || String(resetErr) },
            'Failed to reset Postgres pool after client error',
          );
        });
      });
    }
    pool = nextPool;
  }
  return pool;
}

async function query(text, params) {
  const maxRetries = getDbQueryRetries();
  const backoffMs = getDbRetryBackoffMs();
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const p = getPool();
    if (!p) throw buildNoDatabaseError();
    try {
      return await p.query(text, params);
    } catch (err) {
      if (!isTransientDbError(err) || attempt >= maxRetries) {
        throw err;
      }
      logger.warn(
        {
          err: err?.message || String(err),
          code: err?.code || null,
          attempt: attempt + 1,
          max_retries: maxRetries,
        },
        'Transient DB query failed; resetting pool and retrying',
      );
      await resetPool(p, 'query_retry', err);
      await sleep(backoffMs);
    }
  }
  throw new Error('unreachable');
}

async function connectWithRetry() {
  const maxRetries = getDbConnectRetries();
  const backoffMs = getDbRetryBackoffMs();
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const p = getPool();
    if (!p) throw buildNoDatabaseError();
    try {
      return { client: await p.connect(), pool: p };
    } catch (err) {
      if (!isTransientDbError(err) || attempt >= maxRetries) {
        throw err;
      }
      logger.warn(
        {
          err: err?.message || String(err),
          code: err?.code || null,
          attempt: attempt + 1,
          max_retries: maxRetries,
        },
        'Transient DB connect failed; resetting pool and retrying',
      );
      await resetPool(p, 'connect_retry', err);
      await sleep(backoffMs);
    }
  }
  throw new Error('unreachable');
}

async function withClient(fn) {
  const { client, pool: sourcePool } = await connectWithRetry();
  let released = false;
  try {
    return await fn(client);
  } catch (err) {
    if (isTransientDbError(err)) {
      try {
        client.release(true);
        released = true;
      } catch {
        // ignore release failures on broken clients
      }
      await resetPool(sourcePool, 'with_client_error', err);
    }
    throw err;
  } finally {
    if (!released) {
      client.release();
    }
  }
}

module.exports = {
  getPool,
  query,
  withClient,
};
