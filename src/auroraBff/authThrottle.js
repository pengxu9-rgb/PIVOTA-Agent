'use strict';

/*
 * authThrottle.js — per-IP and per-email throttles in front of the Aurora sign-in doors
 * (/v1/auth/start, /v1/auth/verify, /v1/auth/password/login).
 *
 * WHAT THIS IS NOT: the bound on guessing a login code. That bound lives in the database, next to the
 * code (authStore.js: OTP_MAX_ATTEMPTS per challenge, OTP_START_MAX_PER_EMAIL per window), because the
 * gateway runs several instances and only the database is shared by all of them. These buckets are
 * process-local, built from the same primitive as the public read doors (publicReadRateLimit.js) and
 * keyed on the same client-IP rule as the invoke limiter (gatewayGuardrails clientIpFromRequest: the
 * X-Forwarded-For entry our load balancer vouched for, never one the caller wrote). They shed a flood
 * before it reaches the database and they slow one IP spraying many emails, which the per-email bound
 * cannot see.
 *
 * FAILURE POLICY. If a bucket throws, the request is ALLOWED through and the error is logged. That is
 * deliberate and it is safe only because of the split above: a broken valve must not lock every user
 * out of sign-in, and it cannot open the brute force, because the attempt cap and the per-email /start
 * bound are enforced by the same database write that reads the code. If the database is down, no code
 * can be minted or checked at all, so that path fails closed by construction.
 *
 * Separate limiter instances per (scope, door): the primitive clears its map when it reaches maxKeys,
 * so one shared map would let a flood of fresh emails wipe the per-IP buckets.
 */

const { createHash } = require('crypto');
const { createTokenBucketLimiter } = require('../services/publicReadRateLimit');
const { clientIpFromRequest } = require('../guardrails/gatewayGuardrails');

const HOUR_SEC = 60 * 60;
const QUARTER_HOUR_SEC = 15 * 60;

function positiveIntEnv(name, fallback, max) {
  const raw = process.env[name];
  const n = Number(raw);
  if (raw == null || String(raw).trim() === '' || !Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

// capacity requests, refilled evenly over periodSec. Per-IP numbers leave room for a shared address
// (an office, a carrier NAT); per-email numbers are the ones a person typing codes never reaches.
function defaultLimits() {
  return {
    ip: {
      start: { capacity: positiveIntEnv('AURORA_BFF_AUTH_IP_START_PER_HOUR', 20, 1000), periodSec: HOUR_SEC },
      verify: { capacity: positiveIntEnv('AURORA_BFF_AUTH_IP_VERIFY_PER_HOUR', 30, 1000), periodSec: HOUR_SEC },
      password: { capacity: positiveIntEnv('AURORA_BFF_AUTH_IP_PASSWORD_PER_HOUR', 30, 1000), periodSec: HOUR_SEC },
    },
    email: {
      start: { capacity: 5, periodSec: QUARTER_HOUR_SEC },
      verify: { capacity: 10, periodSec: QUARTER_HOUR_SEC },
      password: { capacity: 10, periodSec: QUARTER_HOUR_SEC },
    },
  };
}

function isThrottleEnabled() {
  return String(process.env.AURORA_BFF_AUTH_THROTTLE_ENABLED || '').trim().toLowerCase() !== 'false';
}

function emailKey(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return `email:${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

function createAuroraAuthThrottle({ now = () => Date.now(), logger = null, limits = defaultLimits() } = {}) {
  const buckets = new Map();

  function limiterFor(scope, door) {
    const spec = limits && limits[scope] && limits[scope][door];
    if (!spec) return null;
    const id = `${scope}:${door}`;
    let entry = buckets.get(id);
    if (!entry) {
      const refillPerSecond = spec.capacity / spec.periodSec;
      entry = {
        limiter: createTokenBucketLimiter({ capacity: spec.capacity, refillPerSecond, now }),
        retryAfterSec: Math.max(1, Math.ceil(1 / refillPerSecond)),
      };
      buckets.set(id, entry);
    }
    return entry;
  }

  function take(scope, door, key) {
    if (!isThrottleEnabled()) return { ok: true, scope, retryAfterSec: null };
    const entry = limiterFor(scope, door);
    if (!entry) return { ok: true, scope, retryAfterSec: null };
    try {
      if (entry.limiter.allow(key)) return { ok: true, scope, retryAfterSec: null };
      return { ok: false, scope, retryAfterSec: entry.retryAfterSec };
    } catch (err) {
      // Fail open — see FAILURE POLICY above. The database cap still holds.
      logger?.warn?.(
        { err: err?.message || String(err), scope, door },
        'aurora auth throttle failed; allowing (database attempt cap still applies)',
      );
      return { ok: true, scope, retryAfterSec: null, failedOpen: true };
    }
  }

  function checkIp(req, door) {
    const ip = clientIpFromRequest(req);
    return take('ip', door, `ip:${ip || 'unknown'}`);
  }

  function checkEmail(email, door) {
    return take('email', door, emailKey(email));
  }

  return { checkIp, checkEmail };
}

module.exports = {
  createAuroraAuthThrottle,
  __test__: { defaultLimits, emailKey, isThrottleEnabled },
};
