const crypto = require('crypto');

const AUTH_ENABLED = String(process.env.AURORA_BFF_AUTH_ENABLED || '').toLowerCase() === 'true';
const AUTH_DEBUG = String(process.env.AURORA_BFF_AUTH_DEBUG || '').toLowerCase() === 'true';

const CHALLENGE_TTL_MS = Math.max(60_000, Math.min(30 * 60_000, Number(process.env.AURORA_BFF_AUTH_CHALLENGE_TTL_MS || 10 * 60_000)));
const SESSION_TTL_MS = Math.max(5 * 60_000, Math.min(180 * 24 * 60_000, Number(process.env.AURORA_BFF_AUTH_SESSION_TTL_MS || 30 * 24 * 60_000)));

const challengesByEmail = new Map();
const sessionsByToken = new Map();
const emailsByUserId = new Map();

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

function pruneExpired() {
  const ts = nowMs();
  for (const [email, c] of challengesByEmail.entries()) {
    if (!c || typeof c !== 'object' || !c.expiresAtMs || c.expiresAtMs <= ts) challengesByEmail.delete(email);
  }
  for (const [token, s] of sessionsByToken.entries()) {
    if (!s || typeof s !== 'object' || !s.expiresAtMs || s.expiresAtMs <= ts) sessionsByToken.delete(token);
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

async function createOtpChallenge({ email, language } = {}) {
  pruneExpired();
  if (!AUTH_ENABLED) throw makeError('AUTH_NOT_CONFIGURED', 503);

  const mail = String(email || '').trim().toLowerCase();
  if (!isValidEmail(mail)) throw makeError('INVALID_EMAIL', 400);

  const challengeId = crypto.randomBytes(12).toString('hex');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const createdAtMs = nowMs();
  const expiresAtMs = createdAtMs + CHALLENGE_TTL_MS;

  challengesByEmail.set(mail, {
    email: mail,
    challengeId,
    code,
    createdAtMs,
    expiresAtMs,
    language: String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN',
  });

  return {
    email: mail,
    challengeId,
    expiresAt: toIso(expiresAtMs),
    expiresInSeconds: Math.round((expiresAtMs - createdAtMs) / 1000),
    delivery: 'not_configured',
    ...(AUTH_DEBUG ? { debug_code: code } : {}),
    ...(AUTH_DEBUG ? { delivery_error: 'email_delivery_not_implemented' } : {}),
  };
}

async function verifyOtpChallenge({ email, code } = {}) {
  pruneExpired();
  if (!AUTH_ENABLED) throw makeError('AUTH_NOT_CONFIGURED', 503);

  const mail = String(email || '').trim().toLowerCase();
  const inputCode = String(code || '').trim();
  if (!mail || !inputCode) return { ok: false, reason: 'missing_input' };

  const challenge = challengesByEmail.get(mail);
  if (!challenge) return { ok: false, reason: 'not_found_or_expired' };
  if (challenge.expiresAtMs <= nowMs()) {
    challengesByEmail.delete(mail);
    return { ok: false, reason: 'expired' };
  }
  if (String(challenge.code) !== inputCode) return { ok: false, reason: 'code_mismatch' };

  challengesByEmail.delete(mail);
  const userId = `usr_${crypto.createHash('sha256').update(mail).digest('hex').slice(0, 16)}`;
  emailsByUserId.set(userId, mail);
  return { ok: true, userId, email: mail };
}

async function createSession({ userId } = {}) {
  pruneExpired();
  if (!AUTH_ENABLED) throw makeError('AUTH_NOT_CONFIGURED', 503);
  const uid = String(userId || '').trim();
  if (!uid) throw makeError('USER_ID_MISSING', 400);

  const token = crypto.randomBytes(32).toString('hex');
  const createdAtMs = nowMs();
  const expiresAtMs = createdAtMs + SESSION_TTL_MS;

  sessionsByToken.set(token, {
    token,
    userId: uid,
    email: emailsByUserId.get(uid) || null,
    createdAtMs,
    expiresAtMs,
  });

  return { token, expiresAt: toIso(expiresAtMs) };
}

async function resolveSessionFromToken(token) {
  pruneExpired();
  if (!AUTH_ENABLED) return null;
  const t = String(token || '').trim();
  if (!t) return null;
  const session = sessionsByToken.get(t);
  if (!session) return null;
  if (session.expiresAtMs <= nowMs()) {
    sessionsByToken.delete(t);
    return null;
  }
  return { userId: session.userId, email: session.email || null, expiresAt: toIso(session.expiresAtMs) };
}

async function revokeSessionToken(token) {
  pruneExpired();
  if (!token) return { ok: true };
  sessionsByToken.delete(String(token || '').trim());
  return { ok: true };
}

module.exports = {
  getBearerToken,
  createOtpChallenge,
  verifyOtpChallenge,
  createSession,
  resolveSessionFromToken,
  revokeSessionToken,
};

