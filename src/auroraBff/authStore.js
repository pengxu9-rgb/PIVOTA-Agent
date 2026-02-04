const crypto = require('crypto');
const axios = require('axios');
const { query } = require('../db');

const AUTH_ENABLED = String(process.env.AURORA_BFF_AUTH_ENABLED || '').toLowerCase() === 'true';
const AUTH_DEBUG = String(process.env.AURORA_BFF_AUTH_DEBUG || '').toLowerCase() === 'true';
const AUTH_DEBUG_RETURN_CODE = String(process.env.AURORA_BFF_AUTH_DEBUG_RETURN_CODE || '').toLowerCase() === 'true';

const AUTH_PEPPER = String(process.env.AURORA_BFF_AUTH_PEPPER || process.env.AURORA_AUTH_PEPPER || '').trim();

const EMAIL_PROVIDER = String(process.env.AURORA_BFF_AUTH_EMAIL_PROVIDER || '').trim().toLowerCase();

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
    await query(
      `
        DELETE FROM aurora_auth_challenges
        WHERE expires_at < now()
           OR consumed_at IS NOT NULL
      `,
      [],
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

  const provider = EMAIL_PROVIDER || (RESEND_API_KEY ? 'resend' : 'ses');

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

async function createOtpChallenge({ email, language } = {}) {
  requireAuthConfigured();
  await pruneExpired();

  const mail = String(email || '').trim().toLowerCase();
  if (!isValidEmail(mail)) throw makeError('INVALID_EMAIL', 400);

  const challengeId = crypto.randomBytes(16).toString('hex');
  const code = String(Math.floor(100000 + Math.random() * 900000)).padStart(6, '0');
  const createdAtMs = nowMs();
  const expiresAtMs = createdAtMs + CHALLENGE_TTL_MS;

  const codeHash = hashWithPepper(`${challengeId}:${code}`);

  // Keep only one active challenge per email to reduce confusion.
  await query(
    `
      DELETE FROM aurora_auth_challenges
      WHERE email = $1
        AND consumed_at IS NULL
    `,
    [mail],
  );

  await query(
    `
      INSERT INTO aurora_auth_challenges (challenge_id, email, code_hash, expires_at)
      VALUES ($1, $2, $3, $4)
    `,
    [challengeId, mail, codeHash, new Date(expiresAtMs).toISOString()],
  );

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
  if (!row) return { ok: false, reason: 'not_found_or_expired' };

  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs()) {
    await query(`DELETE FROM aurora_auth_challenges WHERE challenge_id = $1`, [row.challenge_id]);
    return { ok: false, reason: 'expired' };
  }

  const expectedHash = String(row.code_hash || '');
  const actualHash = hashWithPepper(`${row.challenge_id}:${inputCode}`);
  if (!expectedHash || expectedHash !== actualHash) {
    const attempts = Number.isFinite(Number(row.attempts)) ? Number(row.attempts) : 0;
    await query(`UPDATE aurora_auth_challenges SET attempts = $2 WHERE challenge_id = $1`, [row.challenge_id, attempts + 1]);
    return { ok: false, reason: 'code_mismatch' };
  }

  await query(`UPDATE aurora_auth_challenges SET consumed_at = now() WHERE challenge_id = $1`, [row.challenge_id]);

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
    const attempts = Number.isFinite(Number(row.password_failed_attempts)) ? Number(row.password_failed_attempts) : 0;
    const nextAttempts = Math.max(0, Math.min(32000, attempts + 1));
    const shouldLock = nextAttempts >= PASSWORD_MAX_FAILED_ATTEMPTS;
    const lockedUntilIso = shouldLock ? new Date(nowMs() + PASSWORD_LOCKOUT_MS).toISOString() : null;
    try {
      await query(
        `
          UPDATE aurora_users
          SET password_failed_attempts = $2,
              password_locked_until = $3,
              updated_at = now()
          WHERE user_id = $1
            AND deleted_at IS NULL
        `,
        [userId, nextAttempts, lockedUntilIso],
      );
    } catch {
      // ignore
    }
    return { ok: false, reason: 'mismatch', locked_until: lockedUntilIso };
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
};
