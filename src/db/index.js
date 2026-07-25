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
      // Backstop so NO query in this process can hang forever.
      //
      // 2026-07-25: three sitemap PDPs returned zero bytes and no status,
      // indefinitely, because `query()` is `Pool.query` — which had neither a
      // server-side nor a client-side deadline. A single pathological plan
      // pinned one of only `max` (default 5) connections until the TCP session
      // died, and the awaiting request never produced a response at all.
      //
      // Both are set here rather than per-query on purpose: node-postgres sends
      // them with the connection, so they cost ZERO extra round-trips. The
      // per-query alternative (`queryWithStatementTimeout`) wraps each call in
      // BEGIN / SET LOCAL / COMMIT — three extra round-trips on a hot read path
      // whose app and database sit in different regions.
      //
      // Deliberately generous: these exist to kill true pathologies, not to
      // enforce latency budgets. Per-request budgets belong at the call site
      // (see `withStageBudget`). `query_timeout` is set ABOVE
      // `statement_timeout` so the server-side cancel normally wins and the
      // connection stays reusable; the client-side one only fires if the socket
      // itself is wedged.
      statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 30000),
      query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS || 35000),
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

function normalizeLocalTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(60_000, Math.trunc(parsed)));
}

async function queryWithStatementTimeout(text, params, options = {}) {
  const statementTimeoutMs = normalizeLocalTimeoutMs(options.statementTimeoutMs);
  const lockTimeoutMs = normalizeLocalTimeoutMs(options.lockTimeoutMs);
  if (!statementTimeoutMs && !lockTimeoutMs) {
    return query(text, params);
  }

  return withClient(async (client) => {
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      if (statementTimeoutMs) {
        await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
      }
      if (lockTimeoutMs) {
        await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      }
      const result = await client.query(text, params);
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (err) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          logger.warn(
            {
              err: rollbackErr?.message || String(rollbackErr),
              original_err: err?.message || String(err),
            },
            'Failed to rollback statement-timeout query transaction',
          );
        }
      }
      throw err;
    }
  });
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

function captureCheckedOutClientErrors(client) {
  if (!client || typeof client.on !== 'function') {
    return {
      getError: () => null,
      detach: () => {},
    };
  }

  let capturedError = null;
  const onError = (err) => {
    capturedError = err || new Error('Postgres checked-out client emitted an unknown error');
    logger.warn(
      {
        err: capturedError?.message || String(capturedError),
        code: capturedError?.code || null,
      },
      'Postgres checked-out client emitted error; marking client broken',
    );
  };

  client.on('error', onError);
  return {
    getError: () => capturedError,
    detach: () => {
      if (typeof client.off === 'function') {
        client.off('error', onError);
      } else if (typeof client.removeListener === 'function') {
        client.removeListener('error', onError);
      }
    },
  };
}

async function withClient(fn) {
  const { client, pool: sourcePool } = await connectWithRetry();
  let released = false;
  let poolResetAfterError = false;
  const clientErrorCapture = captureCheckedOutClientErrors(client);
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
      poolResetAfterError = true;
    }
    throw err;
  } finally {
    const checkedOutClientError = clientErrorCapture.getError();
    try {
      if (!released) {
        client.release(Boolean(checkedOutClientError));
        released = true;
      }
    } finally {
      clientErrorCapture.detach();
    }
    if (checkedOutClientError && !poolResetAfterError) {
      await resetPool(sourcePool, 'with_client_error_event', checkedOutClientError);
    }
  }
}

async function closePool() {
  const existingPool = pool;
  if (!existingPool) return;
  await resetPool(existingPool, 'manual_close', null);
}

module.exports = {
  closePool,
  getPool,
  query,
  queryWithStatementTimeout,
  withClient,
};
