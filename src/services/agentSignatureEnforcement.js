'use strict';

// ENFORCE mode for inbound agent signatures (AGENT_SIGNATURE_VERIFY_MODE=enforce). The verifier
// (agentSignatureVerifier.js) answers "did a key we trust sign this request, and whose is it?"; this module
// answers "given that answer, does the request go on?". Pure: the middleware in src/server.js feeds it the
// verification result, the route group and (when the request names one) the merchant.
//
// WHAT ENFORCE DOES, and only this:
//   1. A request that CLAIMS a Visa TAP tag (agent-browser-auth / agent-payer-auth) on an enforced route
//      group, or for a merchant that opted in, and does not verify → 401. A forged, expired, replayed or
//      unknown-key TAP claim is refused instead of passing as if unsigned.
//   2. An UNSIGNED request — or one signed with another profile (Web Bot Auth, the ACP adapter's HMAC) —
//      passes exactly as before. The single exception is a merchant that opted into `tap_only`: on its
//      requests, anything but a verified TAP signature is refused.
//   3. A VERIFIED TAP request passes and carries its identity (authority, keyid, tag) on the request, which
//      the order path records on order metadata.
//
// WHAT IS NOT A REFUSAL. A TAP claim we could not CHECK — the key source unreachable, the verification
// budget spent, the nonce store full — passes as unverified (no identity attached), on enforced route
// groups. Refusing it would make Visa's JWKS availability ours, and it buys nothing: the same request with
// no signature at all passes anyway. Under `tap_only` it is refused (503, retryable), because there an
// unverified request is exactly what the merchant asked us to turn away.
//
// DEFAULT OFF, three ways. Mode `enforce` with no route groups and no merchant opt-ins behaves exactly like
// observe. Route groups come from AGENT_SIGNATURE_ENFORCE_ROUTE_GROUPS (comma list of `merchant_doors`,
// `checkout`); merchant opt-ins from AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON ({"<merchant_id>": "enforce" |
// "tap_only"}). Anything unrecognised in either is dropped, never guessed at.
//
// KNOWN LIMITS (also in the PR):
//   - The merchant is known at the edge only when the request NAMES it — the MCP dialect's `merchant_id`
//     tool argument. UCP and ACP checkout shapes carry none, and session follow-ups (update / complete by
//     session id) name only the session. So a merchant opt-in applies to the requests that name it; the
//     log line's `merchant_resolved` says how many did.
//   - Nonces are remembered per instance. A replay landing on a second instance verifies there. Turning
//     `tap_only` on in prod should wait for a shared nonce store.

const ROUTE_GROUP = Object.freeze({ MERCHANT_DOORS: 'merchant_doors', CHECKOUT: 'checkout' });
const ROUTE_GROUPS = new Set(Object.values(ROUTE_GROUP));
const MERCHANT_POLICY = Object.freeze({ ENFORCE: 'enforce', TAP_ONLY: 'tap_only' });
const MERCHANT_POLICIES = new Set(Object.values(MERCHANT_POLICY));

// Verification outcomes that say nothing about the signature itself — we failed to check it.
const UNCHECKED_REASONS = Object.freeze(new Set([
  'verification_timeout',
  'verifier_error',
  'key_source_unavailable',
  'nonce_store_full',
  'no_trusted_key_source',
]));

const MAX_MERCHANT_ID_LENGTH = 128;

// `tag="agent-browser-auth"` / `tag="agent-payer-auth"` anywhere in Signature-Input. Read off the raw header
// rather than the verifier's parse, so a TAP claim whose headers do not even parse still counts as a claim.
const TAP_TAG_RE = /;\s*tag\s*=\s*"agent-(?:browser|payer)-auth"/i;

function claimsTapTag(headers) {
  const raw = headers ? headers['signature-input'] : undefined;
  if (raw === undefined) return false;
  return TAP_TAG_RE.test(Array.isArray(raw) ? raw.join(', ') : String(raw));
}

function loadEnforcementConfig(env = process.env, log) {
  const routeGroups = new Set(
    String(env.AGENT_SIGNATURE_ENFORCE_ROUTE_GROUPS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => ROUTE_GROUPS.has(s)),
  );
  const merchantPolicies = new Map();
  const raw = env.AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON;
  if (raw != null && String(raw).trim() !== '') {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log?.warn?.({ event: 'agent_signature_config' }, 'AGENT_SIGNATURE_ENFORCE_MERCHANTS_JSON is not JSON; no merchant opt-ins');
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [merchantId, policy] of Object.entries(parsed)) {
        const id = String(merchantId).trim();
        const p = String(policy || '').trim().toLowerCase();
        if (id && id.length <= MAX_MERCHANT_ID_LENGTH && MERCHANT_POLICIES.has(p)) merchantPolicies.set(id, p);
      }
    }
  }
  const hasTapOnly = [...merchantPolicies.values()].includes(MERCHANT_POLICY.TAP_ONLY);
  return { routeGroups, merchantPolicies, hasTapOnly };
}

/**
 * The merchant an MCP-dialect JSON-RPC body names (`params.arguments.merchant_id`), for one call or a batch
 * whose calls all name the same one. Null when none, or when a batch names several — a batch is never
 * attributed to one merchant it only partly belongs to.
 */
function merchantIdFromRpcBody(body) {
  const calls = Array.isArray(body) ? body : [body];
  const ids = new Set();
  for (const call of calls) {
    const id = call && call.params && call.params.arguments && call.params.arguments.merchant_id;
    if (typeof id === 'string' && id.trim() && id.trim().length <= MAX_MERCHANT_ID_LENGTH) ids.add(id.trim());
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function isVerifiedTap(result) {
  return Boolean(result && result.verified === true && result.profile === 'visa-tap');
}

/**
 * The identity a verified TAP request carries onward. Only fields the VERIFIER established — never a header.
 */
function tapIdentityFromResult(result) {
  if (!isVerifiedTap(result)) return null;
  return Object.freeze({
    protocol: 'visa-tap',
    authority: result.authority || null,
    keyid: result.keyid || null,
    tag: result.tag || null,
    agent: result.agent || null,
    alg: result.alg || null,
    created: Number.isInteger(result.created) ? result.created : null,
    expires: Number.isInteger(result.expires) ? result.expires : null,
  });
}

/**
 * @param {object} p
 * @param {'off'|'observe'|'enforce'} p.mode
 * @param {ReturnType<typeof loadEnforcementConfig>} p.config
 * @param {string|null} p.routeGroup        ROUTE_GROUP value for this door request
 * @param {string|null} p.merchantId        merchant the request names, if any
 * @param {object|null} p.result            verifier result; null when the request carried no Signature-Input
 * @param {boolean} p.tapClaimed            claimsTapTag(req.headers)
 * @returns {{ action: 'pass'|'reject', status?: number, code?: string, reason: string, enforced: boolean, merchant_policy: string|null, identity: object|null }}
 */
function decideAgentSignatureEnforcement({ mode, config, routeGroup, merchantId, result, tapClaimed }) {
  const identity = mode === 'enforce' ? tapIdentityFromResult(result) : null;
  if (mode !== 'enforce' || !config) {
    return { action: 'pass', reason: 'not_enforcing', enforced: false, merchant_policy: null, identity: null };
  }
  const merchantPolicy = merchantId ? config.merchantPolicies.get(merchantId) || null : null;
  const groupEnforced = Boolean(routeGroup && config.routeGroups.has(routeGroup));
  const enforced = groupEnforced || merchantPolicy !== null;
  const base = { enforced, merchant_policy: merchantPolicy, identity };
  if (!enforced) return { ...base, action: 'pass', reason: 'scope_not_enforced' };

  if (isVerifiedTap(result)) return { ...base, action: 'pass', reason: 'verified_tap' };

  const unchecked = Boolean(result && UNCHECKED_REASONS.has(result.reason));
  if (merchantPolicy === MERCHANT_POLICY.TAP_ONLY) {
    if (unchecked) {
      return { ...base, action: 'reject', status: 503, code: 'AGENT_SIGNATURE_UNAVAILABLE', reason: result.reason };
    }
    return {
      ...base,
      action: 'reject',
      status: 401,
      code: 'AGENT_SIGNATURE_REQUIRED',
      reason: tapClaimed ? (result ? result.reason : 'no_signature') : 'tap_signature_required',
    };
  }
  if (!tapClaimed) return { ...base, action: 'pass', reason: result ? 'not_a_tap_claim' : 'unsigned' };
  if (unchecked) return { ...base, action: 'pass', reason: `unchecked:${result.reason}` };
  return { ...base, action: 'reject', status: 401, code: 'AGENT_SIGNATURE_INVALID', reason: result ? result.reason : 'malformed_signature_headers' };
}

/** The JSON body a refused request gets. No echo of anything the caller sent beyond the reason code. */
function enforcementErrorBody(decision) {
  const messages = {
    AGENT_SIGNATURE_INVALID: 'The request claims a Visa Trusted Agent Protocol signature that did not verify.',
    AGENT_SIGNATURE_REQUIRED: 'This merchant accepts only requests signed by a Visa-trusted agent (Trusted Agent Protocol).',
    AGENT_SIGNATURE_UNAVAILABLE: 'The agent signature could not be checked right now; retry shortly.',
  };
  return { error: decision.code, reason: decision.reason, message: messages[decision.code] || 'Agent signature refused.' };
}

module.exports = {
  ROUTE_GROUP,
  MERCHANT_POLICY,
  UNCHECKED_REASONS,
  claimsTapTag,
  loadEnforcementConfig,
  merchantIdFromRpcBody,
  tapIdentityFromResult,
  decideAgentSignatureEnforcement,
  enforcementErrorBody,
};
