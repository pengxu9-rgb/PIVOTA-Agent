const crypto = require('crypto');
const axios = require('axios');
const { query, withClient } = require('../db');

const AUTH_ENABLED = String(process.env.AURORA_BFF_AUTH_ENABLED || '').toLowerCase() === 'true';
const AUTH_DEBUG = String(process.env.AURORA_BFF_AUTH_DEBUG || '').toLowerCase() === 'true';
const AUTH_DEBUG_RETURN_CODE = String(process.env.AURORA_BFF_AUTH_DEBUG_RETURN_CODE || '').toLowerCase() === 'true';

const AUTH_PEPPER = String(process.env.AURORA_BFF_AUTH_PEPPER || process.env.AURORA_AUTH_PEPPER || '').trim();

const EMAIL_PROVIDER = String(process.env.AURORA_BFF_AUTH_EMAIL_PROVIDER || '').trim().toLowerCase();

const SENDGRID_API_KEY = String(process.env.SENDGRID_API_KEY || '').trim();
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const AUTH_EMAIL_FROM = String(process.env.AURORA_BFF_AUTH_EMAIL_FROM || process.env.AURORA_AUTH_EMAIL_FROM || '').trim();

const SES_REGION = String(
  process.env.AURORA_BFF_AUTH_SES_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    '',
).trim();

const CHALLENGE_TTL_MS = Math.max(
  60_000,
  Math.min(30 * 60_000, Number(process.env.AURORA_BFF_AUTH_CHALLENGE_TTL_MS || 10 * 60_000)),
);
const SESSION_TTL_MS = Math.max(
  5 * 60_000,
  Math.min(180 * 24 * 60_000, Number(process.env.AURORA_BFF_AUTH_SESSION_TTL_MS || 30 * 24 * 60_000)),
);

function boundedIntEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const n = Number(raw);
  const v = raw != null && String(raw).trim() !== '' && Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

// A login code is 6 digits: 900,000 values, and a verified code buys a 30-day session. Every guess at
// a challenge is counted IN THE ROW THAT HOLDS THE CODE, so the cap holds across every gateway
// instance. The guess that reaches the cap closes the challenge; after that only a new /start helps.
const OTP_MAX_ATTEMPTS = boundedIntEnv('AURORA_BFF_AUTH_OTP_MAX_ATTEMPTS', 5, 3, 10);

// /start mints a fresh challenge with a fresh counter, so the per-code cap alone is a cap per /start.
// This bounds /start per email ACROSS instances, from the same table: every challenge minted for the
// email inside the window counts, whether it was used, superseded, expired or closed. With the
// defaults one email admits at most 5 codes x 5 guesses = 25 guesses per 15 minutes (about 0.27% a
// day against one account) wherever the requests land. The token buckets in authThrottle.js sit in
// front of this; they are per instance, so they are a valve, not the bound.
const OTP_START_WINDOW_MS = boundedIntEnv(
  'AURORA_BFF_AUTH_OTP_START_WINDOW_MS',
  15 * 60_000,
  5 * 60_000,
  24 * 60 * 60_000,
);
const OTP_START_MAX_PER_EMAIL = boundedIntEnv('AURORA_BFF_AUTH_OTP_START_MAX_PER_EMAIL', 5, 1, 20);

// Challenge rows are the evidence the /start bound counts, so they are kept (closed, never reusable)
// for as long as they can still count, and pruned only after that.
const CHALLENGE_RETENTION_MS = Math.max(OTP_START_WINDOW_MS, Number.isFinite(CHALLENGE_TTL_MS) ? CHALLENGE_TTL_MS : 0);

const PASSWORD_MAX_FAILED_ATTEMPTS = (() => {
  const n = Number(process.env.AURORA_BFF_AUTH_PASSWORD_MAX_ATTEMPTS || 5);
  const v = Number.isFinite(n) ? Math.trunc(n) : 5;
  return Math.max(3, Math.min(10, v));
})();

const PASSWORD_LOCKOUT_MS = (() => {
  const n = Number(process.env.AURORA_BFF_AUTH_PASSWORD_LOCKOUT_MS || 15 * 60_000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 15 * 60_000;
  return Math.max(60_000, Math.min(60 * 60_000, v));
})();

const PASSWORD_SCRYPT_OPTIONS = (() => {
  const n = Number(process.env.AURORA_BFF_AUTH_PASSWORD_SCRYPT_N || 16384);
  const r = Number(process.env.AURORA_BFF_AUTH_PASSWORD_SCRYPT_R || 8);
  const p = Number(process.env.AURORA_BFF_AUTH_PASSWORD_SCRYPT_P || 1);
  return {
    N: Number.isFinite(n) ? Math.max(1024, Math.min(1 << 18, Math.trunc(n))) : 16384,
    r: Number.isFinite(r) ? Math.max(1, Math.min(32, Math.trunc(r))) : 8,
    p: Number.isFinite(p) ? Math.max(1, Math.min(8, Math.trunc(p))) : 1,
    maxmem: 64 * 1024 * 1024,
  };
})();

const PASSWORD_SCRYPT_KEYLEN = 64;
const PASSWORD_SCRYPT_SALT_BYTES = 16;

function makeError(code, status = 500, message) {
  const err = new Error(message || code);
  err.code = code;
  err.status = status;
  return err;
}

function nowMs() {
  return Date.now();
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function isValidEmail(email) {
  const s = String(email || '').trim();
  if (!s) return false;
  if (s.length > 320) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function requireAuthConfigured() {
  if (!AUTH_ENABLED) throw makeError('AUTH_NOT_CONFIGURED', 503);
  if (!AUTH_PEPPER) throw makeError('AUTH_NOT_CONFIGURED', 503, 'Missing AURORA_BFF_AUTH_PEPPER');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function hashWithPepper(value) {
  return sha256Hex(`${AUTH_PEPPER}:${String(value || '')}`);
}

function scryptPromise(input, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(input, salt, keylen, options, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey);
    });
  });
}

function isHexString(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  return /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0;
}

function coerceHexBuffer(value) {
  const s = String(value || '').trim();
  if (!isHexString(s)) return null;
  try {
    return Buffer.from(s, 'hex');
  } catch {
    return null;
  }
}

let _sesClient = null;

function getSesClient() {
  if (_sesClient) return _sesClient;
  const region = SES_REGION;
  if (!region) return null;

  let mod = null;
  try {
    mod = require('@aws-sdk/client-ses');
  } catch {
    mod = null;
  }
  if (!mod || !mod.SESClient) return null;

  _sesClient = new mod.SESClient({ region });
  return _sesClient;
}

function extractEmailAddress(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const m = s.match(/<([^>]+)>/);
  return String(m ? m[1] : s).trim();
}

async function pruneExpired() {
  if (!AUTH_ENABLED) return;
  try {
    // Only rows too old to count toward the per-email /start bound. A closed challenge (consumed_at
    // set) can never verify again; it stays only as evidence for that count.
    await query(
      `
        DELETE FROM aurora_auth_challenges
        WHERE created_at < $1
      `,
      [toIso(nowMs() - CHALLENGE_RETENTION_MS)],
    );
  } catch {
    // ignore (auth can still work without pruning)
  }

  try {
    await query(
      `
        DELETE FROM aurora_auth_sessions
        WHERE expires_at < now()
           OR revoked_at IS NOT NULL
      `,
      [],
    );
  } catch {
    // ignore
  }
}

function getBearerToken(req) {
  const raw = (req && typeof req.get === 'function' ? req.get('Authorization') : null) || '';
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^Bearer\s+(.+)$/i);
  if (!m) return '';
  return String(m[1] || '').trim();
}

async function sendOtpEmail({ email, code, language }) {
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';

  const subject = lang === 'CN' ? 'Aurora 登录验证码' : 'Your Aurora sign-in code';
  const text =
    lang === 'CN'
      ? `你的 Aurora 登录验证码是：${code}\n\n10 分钟内有效。`
      : `Your Aurora sign-in code is: ${code}\n\nIt expires in 10 minutes.`;

  const provider = EMAIL_PROVIDER || (SENDGRID_API_KEY ? 'sendgrid' : RESEND_API_KEY ? 'resend' : 'ses');

  if (provider === 'sendgrid') {
    if (!SENDGRID_API_KEY || !AUTH_EMAIL_FROM) return { ok: false, reason: 'email_not_configured', provider };
    const fromEmail = extractEmailAddress(AUTH_EMAIL_FROM);
    if (!fromEmail) return { ok: false, reason: 'email_not_configured', provider };

    try {
      await axios.post(
        'https://api.sendgrid.com/v3/mail/send',
        {
          personalizations: [{ to: [{ email }] }],
          from: { email: fromEmail, name: AUTH_EMAIL_FROM.includes('<') ? AUTH_EMAIL_FROM.replace(/<.*>/, '').trim() : '' },
          subject,
          content: [{ type: 'text/plain', value: text }],
        },
        {
          headers: {
            Authorization: `Bearer ${SENDGRID_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
          validateStatus: (s) => s >= 200 && s < 300,
        },
      );
      return { ok: true, provider };
    } catch (err) {
      const message =
        err && err.response && err.response.data
          ? JSON.stringify(err.response.data).slice(0, 400)
          : err?.message || String(err);
      return { ok: false, reason: 'email_send_failed', message, provider };
    }
  }

  if (provider === 'ses') {
    const fromEmail = extractEmailAddress(AUTH_EMAIL_FROM);
    const ses = getSesClient();
    if (!ses || !fromEmail) return { ok: false, reason: 'email_not_configured', provider };

    let mod = null;
    try {
      mod = require('@aws-sdk/client-ses');
    } catch {
      mod = null;
    }
    if (!mod || !mod.SendEmailCommand) return { ok: false, reason: 'email_not_configured', provider };

    try {
      await ses.send(
        new mod.SendEmailCommand({
          Source: fromEmail,
          Destination: { ToAddresses: [email] },
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Text: { Data: text, Charset: 'UTF-8' } },
          },
        }),
      );
      return { ok: true, provider };
    } catch (err) {
      const message = err?.name || err?.message ? `${err?.name || ''} ${err?.message || ''}`.trim() : String(err);
      return { ok: false, reason: 'email_send_failed', message: message.slice(0, 400), provider };
    }
  }

  if (provider !== 'resend') return { ok: false, reason: 'email_not_configured', provider };
  if (!RESEND_API_KEY || !AUTH_EMAIL_FROM) return { ok: false, reason: 'email_not_configured', provider };

  try {
    await axios.post(
      'https://api.resend.com/emails',
      {
        from: AUTH_EMAIL_FROM,
        to: [email],
        subject,
        text,
      },
      {
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      },
    );
    return { ok: true, provider };
  } catch (err) {
    const message =
      err && err.response && err.response.data
        ? JSON.stringify(err.response.data).slice(0, 400)
        : err?.message || String(err);
    return { ok: false, reason: 'email_send_failed', message, provider };
  }
}

// Runs fn(txQuery) in one transaction holding a per-email advisory lock (released at COMMIT/ROLLBACK).
// The same pattern as the bookings idempotency lock (services/bookings/repository.js).
async function withOtpStartLock(mail, fn) {
  if (typeof withClient !== 'function') throw makeError('AUTH_START_FAILED', 500, 'db_client_unavailable');
  return withClient(async (client) => {
    const txQuery = (text, params) => client.query(text, params);
    await txQuery('BEGIN');
    try {
      // Two-key form (like the bookings lock): a namespace key plus the email, so no email hash can
      // coincide with the single-key session lock the migrations/seeds take (72403119).
      await txQuery('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['aurora_otp_start', mail]);
      const result = await fn(txQuery);
      await txQuery('COMMIT');
      return result;
    } catch (err) {
      await txQuery('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

async function createOtpChallenge({ email, language } = {}) {
  requireAuthConfigured();
  await pruneExpired();

  const mail = String(email || '').trim().toLowerCase();
  if (!isValidEmail(mail)) throw makeError('INVALID_EMAIL', 400);

  const challengeId = crypto.randomBytes(16).toString('hex');
  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = hashWithPepper(`${challengeId}:${code}`);

  // Count, close the open code and insert the new one as ONE transaction, serialised per email by a
  // transaction-scoped advisory lock. As three autocommit statements, concurrent /start calls all read
  // the same count and each inserted a code: 40 concurrent calls minted 35-40 codes with 9-28 left
  // open, turning a 25-guess bound into 45-140. The partial unique index from migration 060 (one open
  // challenge per email) is the backstop if anything ever writes around this lock.
  const { createdAtMs, expiresAtMs } = await withOtpStartLock(mail, async (txQuery) => {
    const startedAtMs = nowMs();

    // The cross-instance /start bound (see OTP_START_MAX_PER_EMAIL). The answer is the same whether
    // or not an account exists for the email: it counts challenges, which /start mints for any address.
    const recent = await txQuery(
      `
        SELECT COUNT(*) AS n, MIN(created_at) AS oldest
        FROM aurora_auth_challenges
        WHERE email = $1
          AND created_at > $2
      `,
      [mail, toIso(startedAtMs - OTP_START_WINDOW_MS)],
    );
    const recentRow = recent && recent.rows && recent.rows[0] ? recent.rows[0] : null;
    const recentCount = recentRow ? Number(recentRow.n) : 0;
    if (!Number.isFinite(recentCount)) throw makeError('AUTH_START_FAILED', 500, 'challenge_count_unreadable');
    if (recentCount >= OTP_START_MAX_PER_EMAIL) {
      const oldestMs = recentRow && recentRow.oldest ? new Date(recentRow.oldest).getTime() : NaN;
      const retryAfterMs = Number.isFinite(oldestMs) ? oldestMs + OTP_START_WINDOW_MS - startedAtMs : OTP_START_WINDOW_MS;
      const err = makeError('AUTH_RATE_LIMITED', 429, 'otp_start_limit_per_email');
      err.retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      throw err;
    }

    // Keep only one open challenge per email. The superseded one is CLOSED, not deleted: it still
    // counts toward the /start bound above until it ages out.
    await txQuery(
      `
        UPDATE aurora_auth_challenges
        SET consumed_at = $2
        WHERE email = $1
          AND consumed_at IS NULL
      `,
      [mail, toIso(startedAtMs)],
    );

    const challengeExpiresAtMs = startedAtMs + CHALLENGE_TTL_MS;
    await txQuery(
      `
        INSERT INTO aurora_auth_challenges (challenge_id, email, code_hash, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [challengeId, mail, codeHash, toIso(challengeExpiresAtMs), toIso(startedAtMs)],
    );
    return { createdAtMs: startedAtMs, expiresAtMs: challengeExpiresAtMs };
  });

  const deliveryResult = await sendOtpEmail({ email: mail, code, language });
  if (!deliveryResult.ok && !AUTH_DEBUG && !AUTH_DEBUG_RETURN_CODE) {
    if (deliveryResult.reason === 'email_not_configured') {
      throw makeError('AUTH_NOT_CONFIGURED', 503, deliveryResult.reason);
    }
    throw makeError('AUTH_START_FAILED', 500, deliveryResult.reason || 'email_send_failed');
  }
  return {
    email: mail,
    challengeId,
    expiresAt: toIso(expiresAtMs),
    expiresInSeconds: Math.round((expiresAtMs - createdAtMs) / 1000),
    delivery: deliveryResult.ok ? (deliveryResult.provider || 'email') : 'debug',
    ...(AUTH_DEBUG || AUTH_DEBUG_RETURN_CODE ? { debug_code: code } : {}),
    ...(deliveryResult.ok
      ? {}
      : {
          delivery_error: deliveryResult.message
            ? `email_send_failed:${deliveryResult.message}`
            : deliveryResult.reason || 'email_send_failed',
        }),
  };
}

// Constant-time comparison of two stored/derived hex digests. Both sides are SHA-256 hex of
// pepper-keyed input, so an early-exit compare leaks little, but a code check should not be the one
// place that depends on that argument.
function hashesEqual(expectedHex, actualHex) {
  const expected = Buffer.from(String(expectedHex || ''), 'utf8');
  const actual = Buffer.from(String(actualHex || ''), 'utf8');
  if (expected.length === 0 || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// Closing sets consumed_at: the row can never verify again, and it still counts toward the per-email
// /start bound until pruneExpired ages it out.
async function closeChallenge(challengeId) {
  await query(
    `
      UPDATE aurora_auth_challenges
      SET consumed_at = $2
      WHERE challenge_id = $1
        AND consumed_at IS NULL
    `,
    [challengeId, toIso(nowMs())],
  );
}

async function verifyOtpChallenge({ email, code } = {}) {
  requireAuthConfigured();
  await pruneExpired();

  const mail = String(email || '').trim().toLowerCase();
  const inputCode = String(code || '').trim();
  if (!mail || !inputCode) return { ok: false, reason: 'missing_input' };

  const res = await query(
    `
      SELECT challenge_id, code_hash, expires_at, attempts
      FROM aurora_auth_challenges
      WHERE email = $1
        AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [mail],
  );
  const row = res.rows && res.rows[0] ? res.rows[0] : null;
  // One public answer for "no code", "expired code" and "wrong code": which of them it was says
  // whether someone asked for a code for this email recently.
  if (!row) return { ok: false, reason: 'invalid_or_expired' };

  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs()) {
    await closeChallenge(row.challenge_id);
    return { ok: false, reason: 'invalid_or_expired' };
  }

  // Reserve the guess BEFORE comparing, in one statement, so concurrent guesses cannot all read the
  // same count: whichever request would exceed the cap gets no row back and is refused without a
  // comparison. The counter lives in the challenge row itself, so it is shared by every instance.
  const reserved = await query(
    `
      UPDATE aurora_auth_challenges
      SET attempts = attempts + 1
      WHERE challenge_id = $1
        AND consumed_at IS NULL
        AND attempts < $2
      RETURNING attempts
    `,
    [row.challenge_id, OTP_MAX_ATTEMPTS],
  );
  const reservedRow = reserved && reserved.rows && reserved.rows[0] ? reserved.rows[0] : null;
  // No reservation left: refuse WITHOUT closing. The attempts already reserved may still be in flight,
  // and one of them may carry the right code; closing here let a 6th concurrent right-code request
  // shut the code before any of the first five consumed it, so nobody signed in. attempts = cap
  // already refuses every later reservation, and the guess that reached the cap closes the code
  // itself if it was wrong.
  if (!reservedRow) {
    return { ok: false, reason: 'invalid_or_expired' };
  }
  const attemptsUsed = Number(reservedRow.attempts);

  const actualHash = hashWithPepper(`${row.challenge_id}:${inputCode}`);
  if (!hashesEqual(row.code_hash, actualHash)) {
    // The public reason stays invalid_or_expired when the cap closes a code: a distinct answer would
    // confirm that the address has a live code under attack. closedByCap is for the caller's log only.
    if (!Number.isFinite(attemptsUsed) || attemptsUsed >= OTP_MAX_ATTEMPTS) {
      await closeChallenge(row.challenge_id);
      return { ok: false, reason: 'invalid_or_expired', closedByCap: true };
    }
    return { ok: false, reason: 'invalid_or_expired' };
  }

  // Consume exactly once: a second request racing with the same right code gets no row back.
  const consumed = await query(
    `
      UPDATE aurora_auth_challenges
      SET consumed_at = $2
      WHERE challenge_id = $1
        AND consumed_at IS NULL
      RETURNING challenge_id
    `,
    [row.challenge_id, toIso(nowMs())],
  );
  if (!(consumed && consumed.rows && consumed.rows[0])) return { ok: false, reason: 'invalid_or_expired' };

  // Find or create user for this email.
  const existing = await query(
    `
      SELECT user_id
      FROM aurora_users
      WHERE email = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [mail],
  );
  let userId = existing.rows && existing.rows[0] && existing.rows[0].user_id ? String(existing.rows[0].user_id) : '';
  if (!userId) {
    userId = `usr_${sha256Hex(mail).slice(0, 16)}`;
    await query(
      `
        INSERT INTO aurora_users (user_id, email, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (email) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          updated_at = now(),
          deleted_at = NULL
      `,
      [userId, mail],
    );
  }

  return { ok: true, userId, email: mail };
}

async function createSession({ userId } = {}) {
  requireAuthConfigured();
  await pruneExpired();
  const uid = String(userId || '').trim();
  if (!uid) throw makeError('USER_ID_MISSING', 400);

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashWithPepper(token);
  const createdAtMs = nowMs();
  const expiresAtMs = createdAtMs + SESSION_TTL_MS;

  await query(
    `
      INSERT INTO aurora_auth_sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, $3)
    `,
    [tokenHash, uid, new Date(expiresAtMs).toISOString()],
  );

  return { token, expiresAt: toIso(expiresAtMs) };
}

async function resolveSessionFromToken(token) {
  if (!AUTH_ENABLED || !AUTH_PEPPER) return null;
  await pruneExpired();
  const t = String(token || '').trim();
  if (!t) return null;
  const tokenHash = hashWithPepper(t);

  const res = await query(
    `
      SELECT s.user_id, s.expires_at, u.email
      FROM aurora_auth_sessions s
      LEFT JOIN aurora_users u ON u.user_id = s.user_id AND u.deleted_at IS NULL
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      LIMIT 1
    `,
    [tokenHash],
  );
  const row = res.rows && res.rows[0] ? res.rows[0] : null;
  if (!row) return null;

  try {
    await query(`UPDATE aurora_auth_sessions SET last_seen_at = now() WHERE token_hash = $1`, [tokenHash]);
  } catch {
    // ignore
  }

  const expiresAt = row.expires_at ? new Date(row.expires_at).toISOString() : null;
  return { userId: String(row.user_id), email: row.email ? String(row.email) : null, expiresAt };
}

async function revokeSessionToken(token) {
  if (!AUTH_ENABLED || !AUTH_PEPPER) return { ok: true };
  await pruneExpired();
  const t = String(token || '').trim();
  if (!t) return { ok: true };
  const tokenHash = hashWithPepper(t);
  try {
    await query(`UPDATE aurora_auth_sessions SET revoked_at = now() WHERE token_hash = $1`, [tokenHash]);
  } catch {
    // ignore
  }
  return { ok: true };
}

function validatePasswordInput(password) {
  const p = String(password || '');
  if (!p || p.length < 8 || p.length > 128) return { ok: false, reason: 'length' };
  if (!p.trim()) return { ok: false, reason: 'blank' };
  return { ok: true };
}

async function setUserPassword({ userId, password } = {}) {
  requireAuthConfigured();
  const uid = String(userId || '').trim();
  if (!uid) throw makeError('USER_ID_MISSING', 400);

  const valid = validatePasswordInput(password);
  if (!valid.ok) throw makeError('INVALID_PASSWORD', 400);

  const salt = crypto.randomBytes(PASSWORD_SCRYPT_SALT_BYTES);
  const saltHex = salt.toString('hex');
  const derived = await scryptPromise(
    `${AUTH_PEPPER}:${String(password)}`,
    salt,
    PASSWORD_SCRYPT_KEYLEN,
    PASSWORD_SCRYPT_OPTIONS,
  );
  const hashHex = Buffer.from(derived).toString('hex');
  const params = { ...PASSWORD_SCRYPT_OPTIONS, keylen: PASSWORD_SCRYPT_KEYLEN };

  const res = await query(
    `
      UPDATE aurora_users
      SET password_salt = $2,
          password_hash = $3,
          password_alg = $4,
          password_params = $5::jsonb,
          password_updated_at = now(),
          password_failed_attempts = 0,
          password_locked_until = NULL,
          updated_at = now(),
          deleted_at = NULL
      WHERE user_id = $1
        AND deleted_at IS NULL
    `,
    [uid, saltHex, hashHex, 'scrypt', JSON.stringify(params)],
  );

  if (!res || typeof res.rowCount !== 'number' || res.rowCount < 1) throw makeError('USER_NOT_FOUND', 404);

  return { ok: true, userId: uid, password_updated_at: new Date().toISOString() };
}

async function verifyPasswordForEmail({ email, password } = {}) {
  requireAuthConfigured();
  const mail = String(email || '').trim().toLowerCase();
  const inputPassword = String(password || '');
  if (!isValidEmail(mail) || !inputPassword) return { ok: false, reason: 'missing_input' };

  const res = await query(
    `
      SELECT user_id,
             email,
             password_salt,
             password_hash,
             password_alg,
             password_params,
             password_failed_attempts,
             password_locked_until
      FROM aurora_users
      WHERE email = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [mail],
  );
  const row = res.rows && res.rows[0] ? res.rows[0] : null;
  if (!row) return { ok: false, reason: 'not_found' };

  const userId = String(row.user_id || '').trim();
  const lockedUntilMs = row.password_locked_until ? Date.parse(row.password_locked_until) : NaN;
  if (Number.isFinite(lockedUntilMs) && lockedUntilMs > nowMs()) {
    return { ok: false, reason: 'locked', locked_until: new Date(lockedUntilMs).toISOString() };
  }

  const alg = String(row.password_alg || '').trim().toLowerCase();
  const saltBuf = coerceHexBuffer(row.password_salt);
  const expectedBuf = coerceHexBuffer(row.password_hash);
  if (!alg || !saltBuf || !expectedBuf) return { ok: false, reason: 'no_password_set' };
  if (alg !== 'scrypt') return { ok: false, reason: 'unsupported_alg' };

  const paramsRaw = row.password_params;
  const paramsObj = paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw) ? paramsRaw : null;

  const N = Number.isFinite(Number(paramsObj?.N)) ? Math.trunc(Number(paramsObj.N)) : PASSWORD_SCRYPT_OPTIONS.N;
  const r = Number.isFinite(Number(paramsObj?.r)) ? Math.trunc(Number(paramsObj.r)) : PASSWORD_SCRYPT_OPTIONS.r;
  const p = Number.isFinite(Number(paramsObj?.p)) ? Math.trunc(Number(paramsObj.p)) : PASSWORD_SCRYPT_OPTIONS.p;
  const keylen = Number.isFinite(Number(paramsObj?.keylen)) ? Math.trunc(Number(paramsObj.keylen)) : PASSWORD_SCRYPT_KEYLEN;

  const options = {
    N: Math.max(1024, Math.min(1 << 18, N)),
    r: Math.max(1, Math.min(32, r)),
    p: Math.max(1, Math.min(8, p)),
    maxmem: 64 * 1024 * 1024,
  };

  // Reserve the attempt BEFORE the comparison, in one guarded statement, the same shape as the OTP cap.
  // Read-then-write let concurrent wrong passwords all read the same count: 40 at once made 28 real
  // comparisons against a lockout of 5. The row lock serialises these UPDATEs and each re-checks the
  // WHERE, so once a reservation has set password_locked_until the rest get no row. The reservation
  // that reaches the limit sets the lock itself (a crash after it cannot leave the count stuck), and a
  // right password on that attempt clears it below. An expired lock starts a fresh count.
  const reservedAtMs = nowMs();
  const reservation = await query(
    `
      UPDATE aurora_users
      SET password_failed_attempts =
            (CASE WHEN password_locked_until IS NOT NULL AND password_locked_until <= $2::timestamptz
                  THEN 0 ELSE password_failed_attempts END) + 1,
          password_locked_until =
            CASE WHEN (CASE WHEN password_locked_until IS NOT NULL AND password_locked_until <= $2::timestamptz
                            THEN 0 ELSE password_failed_attempts END) + 1 >= $3
                 THEN $4::timestamptz
                 ELSE NULL END,
          updated_at = now()
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND (password_locked_until IS NULL OR password_locked_until <= $2::timestamptz)
      RETURNING password_failed_attempts, password_locked_until
    `,
    [userId, toIso(reservedAtMs), PASSWORD_MAX_FAILED_ATTEMPTS, toIso(reservedAtMs + PASSWORD_LOCKOUT_MS)],
  );
  const reservedRow = reservation && reservation.rows && reservation.rows[0] ? reservation.rows[0] : null;
  if (!reservedRow) return { ok: false, reason: 'locked' };
  const reservedLockIso = reservedRow.password_locked_until ? new Date(reservedRow.password_locked_until).toISOString() : null;

  let derived = null;
  try {
    derived = await scryptPromise(`${AUTH_PEPPER}:${inputPassword}`, saltBuf, keylen, options);
  } catch {
    derived = null;
  }

  const actualBuf = derived && Buffer.isBuffer(derived) ? derived : Buffer.from([]);
  const match =
    expectedBuf.length === actualBuf.length && expectedBuf.length > 0 && crypto.timingSafeEqual(expectedBuf, actualBuf);

  if (!match) {
    return { ok: false, reason: 'mismatch', locked_until: reservedLockIso };
  }

  try {
    await query(
      `
        UPDATE aurora_users
        SET password_failed_attempts = 0,
            password_locked_until = NULL,
            updated_at = now()
        WHERE user_id = $1
          AND deleted_at IS NULL
      `,
      [userId],
    );
  } catch {
    // ignore
  }

  return { ok: true, userId, email: mail };
}

module.exports = {
  getBearerToken,
  createOtpChallenge,
  verifyOtpChallenge,
  createSession,
  resolveSessionFromToken,
  revokeSessionToken,
  setUserPassword,
  verifyPasswordForEmail,
  __test__: {
    extractEmailAddress,
    sendOtpEmail,
    hashesEqual,
    OTP_MAX_ATTEMPTS,
    OTP_START_MAX_PER_EMAIL,
    OTP_START_WINDOW_MS,
  },
};
