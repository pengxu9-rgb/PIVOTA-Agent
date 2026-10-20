'use strict';

// THE LOOPBACK CALLER ASSERTION: which caller an MCP tool's loopback invoke call is really for.
//
// An MCP tool call (search_catalog, unscoped get_product, recommend_products' price checks) reaches the
// invoke route as THIS process calling itself over loopback, authenticated with the gateway's own service
// key (invokeCommerceKernelRawUpstream). The invoke limiter keys on the verified caller, so every MCP
// caller — anonymous public traffic and partners alike — used to draw from the one bucket of that service
// key, shared with every other first-party user of it. One heavy caller could exhaust it for all of them.
//
// This header carries the caller the MCP DOOR resolved (src/guardrails/mcpCallerLimits.js
// resolveDoorCaller), so the invoke limiter can key on it instead. It must not be forgeable from outside,
// because a forged one would let any caller pick its own bucket:
//
//   - It is an HMAC over the payload with a secret generated at process start and never configured,
//     logged or sent anywhere. Only this process can mint a valid one. A loopback call that lands on a
//     DIFFERENT process (SELF_INVOKE_BASE pointed elsewhere) fails verification and is keyed exactly as
//     before — on the service key — so the failure mode is today's behaviour, never an open door.
//   - It is honoured only on a request that arrived over a loopback socket with no X-Forwarded-For
//     (callerLogFields.isLoopbackSelfCall). Everything routed in from outside carries X-Forwarded-For.
//   - It is bound to a short time window, so a value that somehow escaped could not be replayed later.
//
// What it asserts is only a rate-limit key and a tier: it never changes what a request may do or what
// the response contains, so a search result cached and shared across callers is unaffected by it.

const crypto = require('crypto');
const { isLoopbackSelfCall } = require('../attribution/callerLogFields');
const { callerLimitsMode } = require('./mcpCallerLimitsConfig');

const LOOPBACK_CALLER_HEADER = 'X-Pivota-Loopback-Caller';
const VERSION = 'v1';
const MAX_AGE_SEC = 60;
const MAX_HEADER_LENGTH = 1024;
const TIERS = new Set(['anonymous', 'partner']);

const PROCESS_SECRET = crypto.randomBytes(32);

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mac(input, secret) {
  return crypto.createHmac('sha256', secret).update(input).digest();
}

function signLoopbackCaller({ tier, key, agentId = null }, { nowSec, secret = PROCESS_SECRET } = {}) {
  const ts = Number.isInteger(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  const payload = { t: tier, k: key, ts, ...(agentId ? { a: agentId } : {}) };
  const signingInput = `${VERSION}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(mac(signingInput, secret))}`;
}

/**
 * Headers for one loopback invoke call: the signed caller the MCP door resolved, or {} when limits are
 * off, there is no resolved caller (not an MCP request), or the caller is first-party (whose invoke keying
 * stays exactly as it was). Never throws.
 */
function loopbackCallerHeaders(invokeContext, { env = process.env, nowSec } = {}) {
  try {
    if (callerLimitsMode(env) === 'off') return {};
    const caller = invokeContext && typeof invokeContext === 'object' ? invokeContext.limit_caller : null;
    if (!caller || !TIERS.has(caller.tier) || typeof caller.key !== 'string' || !caller.key) return {};
    return {
      [LOOPBACK_CALLER_HEADER]: signLoopbackCaller(
        { tier: caller.tier, key: caller.key, agentId: caller.agent_id || null },
        { nowSec },
      ),
    };
  } catch (_) {
    return {};
  }
}

/**
 * The caller a VALID loopback assertion names, or null. Null for: no header, a request that did not come
 * over loopback (or carries X-Forwarded-For), a bad signature, an expired or future timestamp, or an
 * unknown tier. Pure verification — whether to ACT on it is the caller's decision.
 */
function verifyLoopbackCaller(req, { nowSec, secret = PROCESS_SECRET } = {}) {
  try {
    const raw = req?.headers?.[LOOPBACK_CALLER_HEADER.toLowerCase()];
    if (typeof raw !== 'string' || !raw || raw.length > MAX_HEADER_LENGTH) return null;
    if (!isLoopbackSelfCall(req)) return null;
    const parts = raw.split('.');
    if (parts.length !== 3 || parts[0] !== VERSION) return null;
    const expected = mac(`${parts[0]}.${parts[1]}`, secret);
    const given = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const now = Number.isInteger(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
    if (!Number.isInteger(payload?.ts) || Math.abs(now - payload.ts) > MAX_AGE_SEC) return null;
    if (!TIERS.has(payload.t) || typeof payload.k !== 'string' || !payload.k) return null;
    return { tier: payload.t, key: payload.k, agent_id: typeof payload.a === 'string' && payload.a ? payload.a : null };
  } catch (_) {
    return null;
  }
}

/**
 * The invoke limiter's view: the asserted caller, only when limits are ENFORCED. In observe mode the
 * invoke route keeps its old keying, so observe changes no response anywhere.
 */
function enforcedLoopbackCaller(req, { env = process.env } = {}) {
  if (callerLimitsMode(env) !== 'enforce') return null;
  return verifyLoopbackCaller(req);
}

module.exports = {
  LOOPBACK_CALLER_HEADER,
  enforcedLoopbackCaller,
  loopbackCallerHeaders,
  signLoopbackCaller,
  verifyLoopbackCaller,
};
