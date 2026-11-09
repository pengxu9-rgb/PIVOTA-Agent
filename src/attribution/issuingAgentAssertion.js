'use strict';

// The ISSUING-AGENT ASSERTION (ADR-025 D1, MCP door).
//
// The backend records which agent a link was issued to (surface_click_events.agent_id) from the
// caller's OWN api key. Over MCP that key never reaches it: the commerce kernel's upstream calls
// always authenticate as this gateway's service agent (forceInternalFallback in
// invokeCommerceKernelRawUpstream), and an MCP OAuth caller has no api key at all. So the backend
// excludes the gateway's service agent and would record every MCP link with no agent.
//
// This header carries the identity THIS gateway verified, signed with a secret only the gateway and
// the backend hold (ISSUING_AGENT_ASSERTION_SECRET). It is not the gateway's api key: that key is a
// DB agent key that also lives on operator machines, so possession of it proves nothing about which
// process sent the request.
//
// Wire format, a two-part compact token:
//
//   X-Pivota-Issuing-Agent: v1.<b64url(JSON payload)>.<b64url(HMAC-SHA256(secret, "v1." + part1))>
//
//   payload = { v: 1, kind: 'agent', sub: '<agent_id>',            op, ts }   api-key caller
//           | { v: 1, kind: 'oauth', iss: '<issuer>', cid: '<id>', op, ts }   MCP OAuth caller
//
// `op` binds the assertion to one operation and `ts` (unix seconds) to a short window, so a
// captured header cannot be replayed onto another operation or much later. The backend verifies,
// credits an OAuth client only if it is a CONFIDENTIAL client Pivota provisioned for a partner (its
// secret is checked at the token endpoint), and only then trusts the subject.
//
// PARTNER IDENTITY ON THE MONEY OPS (FIX_PLAN O-04), behind PARTNER_IDENTITY_FORWARDING_ENABLED
// (default OFF). The ops in PARTNER_IDENTITY_OPS (the kernel's quote, order, hosted link, payment and
// after-sales calls, and the per-response seed-link mint, SEED_LINK_MINT_OP) carry a REQUEST-BOUND v2
// token instead (boundIssuingAgentAssertionHeaders). With the backend's flag of the same name on, the
// backend makes the asserted agent the OWNER of what those routes write (pivota-backend
// routes/agent_forwarded_owner.py), so two partners calling through this one gateway are two owners,
// with their own scope, limits and clicks. Because the token then names an OWNER, a v1 shape would be
// a bearer capability ("act as this partner for this op, any body, 10 minutes"), so v2 binds it to one
// request:
//
//   X-Pivota-Issuing-Agent: v2.<b64url(JSON payload)>.<b64url(HMAC-SHA256(secret, "v2." + part1))>
//
//   payload = { v: 2, kind, sub | iss+cid, op, ts, jti, m, p, rid, bh }
//     m   HTTP method (upper case)      p   request path as sent, no query
//     rid the order or quote id the op acts on, or null     bh  sha256 hex of the EXACT body bytes
//     jti random single-use nonce (the backend refuses a second sighting)
//
// The backend accepts it within 60 s and once. It is signed per ATTEMPT (withBoundIssuingAssertion in
// src/server.js), so a transport retry carries a fresh nonce and is hashed over the body it actually
// sends. offers.resolve keeps v1: there a replay can at most misattribute a click. Off, nothing here
// changes: only ISSUING_OPS is signed, as v1.
//
// What is NEVER asserted:
//   - a cached read lane: its results are shared across callers and must stay caller-independent
//     (see COMMERCE_CACHED_READ_OPS and mcp-server/src/commerceToolSurface.js). Only ops in
//     ISSUING_OPS (and, with the flag on, PARTNER_IDENTITY_OPS) are signed, and none of them is
//     cached: the seed-link mint is signed only on the per-response call made after the cache;
//   - a degraded or fallback identity: emergency / service fallbacks and configured service keys
//     name the gateway or an operator, not an agent;
//   - anything taken from a request body or header the caller controls. The subject comes from
//     req.invokeAuth, which only the gateway's own auth code writes.

const crypto = require('crypto');

const ISSUING_AGENT_ASSERTION_HEADER = 'X-Pivota-Issuing-Agent';
const ISSUING_AGENT_ASSERTION_VERSION = 'v1';

// The operations whose backend handler issues click ids. Allowlist: a new op carries no identity
// until someone decides it should.
const ISSUING_OPS = Object.freeze(new Set(['offers.resolve']));

// The operation name of the per-response seed-link mint (src/server.js, after the search cache).
const SEED_LINK_MINT_OP = 'external_seed_links.mint';

// Signed only while PARTNER_IDENTITY_FORWARDING_ENABLED is on. Each name is the op this gateway
// sends upstream, and the backend verifies the token against the op of the route it lands on.
// get_order_status is NOT here: the kernel reads it through the backend's invoke route, which has no
// such operation and reads no assertion (O-04 review, P3-G4). Add it back with the read's reroute.
const PARTNER_IDENTITY_OPS = Object.freeze(new Set([
  'preview_quote',
  'create_order',
  'submit_payment',
  'create_payment_link',
  'request_after_sales',
  SEED_LINK_MINT_OP,
]));
const ISSUING_AGENT_ASSERTION_VERSION_V2 = 'v2';

const PARTNER_IDENTITY_FORWARDING_ENV = 'PARTNER_IDENTITY_FORWARDING_ENABLED';

function partnerIdentityForwardingEnabled(env = process.env) {
  const raw = env ? env[PARTNER_IDENTITY_FORWARDING_ENV] : undefined;
  return /^(1|true|yes|on)$/i.test(String(raw === undefined || raw === null ? '' : raw).trim());
}

function isBoundOp(operation, env = process.env) {
  return PARTNER_IDENTITY_OPS.has(operation) && partnerIdentityForwardingEnabled(env);
}

// Identities that name a service or an operator, never an agent (see adoptInvokeEmergencyAuthFallback
// and resolveConfiguredInvokeAuthFastPath in src/server.js, and the backend's internal-trusted keys).
// Defence in depth only: the backend accepts an asserted agent only if it is an ACTIVE, non-service
// agents row, so a source missing here still cannot credit a service identity.
const NON_AGENT_AUTH_SOURCES = Object.freeze(new Set([
  'configured_service_key',
  'emergency_fallback',
  'internal_trusted_key',
]));

const MAX_FIELD_LENGTH = 512;

function text(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s && s.length <= MAX_FIELD_LENGTH ? s : '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readSecret(env = process.env) {
  // No length cap: the backend verifier has none, and a long secret must sign, not silently disable.
  const s = typeof env.ISSUING_AGENT_ASSERTION_SECRET === 'string' ? env.ISSUING_AGENT_ASSERTION_SECRET.trim() : '';
  return s;
}

function excludedAgentIds(env = process.env) {
  return new Set(
    [
      env.AGENT_AUTH_SERVICE_FALLBACK_AGENT_ID || 'agent_service_fallback',
      env.AGENT_AUTH_EMERGENCY_AGENT_ID || env.AGENT_AUTH_FALLBACK_AGENT_ID || 'agent_emergency_fallback',
    ].map((id) => String(id || '').trim()).filter(Boolean),
  );
}

/**
 * The verified subject of this request, or null when it is not bound to one agent.
 * `invokeContext` is the INVOKE_AUTH_CONTEXT store (buildExternalInvokeContext).
 */
function issuingSubjectFromInvokeContext(invokeContext, env = process.env) {
  const ctx = invokeContext && typeof invokeContext === 'object' ? invokeContext : null;
  if (!ctx) return null;
  if (ctx.auth_degraded === true) return null;
  const introspectSource = text(ctx.introspect_auth_source).toLowerCase();
  if (NON_AGENT_AUTH_SOURCES.has(introspectSource)) return null;

  const authMode = text(ctx.auth_mode);
  if (authMode === 'api_key') {
    const agentId = text(ctx.agent_id);
    if (!agentId || excludedAgentIds(env).has(agentId)) return null;
    return { kind: 'agent', sub: agentId };
  }
  if (authMode === 'mcp_oauth') {
    const iss = text(ctx.oauth_issuer);
    const cid = text(ctx.oauth_client_id);
    if (!iss || !cid) return null;
    return { kind: 'oauth', iss, cid };
  }
  return null;
}

function signIssuingAgentAssertion({ subject, op, secret, nowSec }) {
  const payload = subject.kind === 'agent'
    ? { v: 1, kind: 'agent', sub: subject.sub, op, ts: nowSec }
    : { v: 1, kind: 'oauth', iss: subject.iss, cid: subject.cid, op, ts: nowSec };
  const signingInput = `${ISSUING_AGENT_ASSERTION_VERSION}.${b64url(JSON.stringify(payload))}`;
  const mac = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(mac)}`;
}

/**
 * Headers to add to one upstream call: `{ 'X-Pivota-Issuing-Agent': token }`, or `{}` when this
 * operation does not issue links, no secret is configured, or the caller is not one agent.
 * Never throws: attribution must never break the call it rides on.
 */
function issuingAgentAssertionHeaders({ op, invokeContext, env = process.env, nowSec } = {}) {
  try {
    const operation = text(op);
    if (!ISSUING_OPS.has(operation)) return {};
    const secret = readSecret(env);
    if (!secret) return {};
    const subject = issuingSubjectFromInvokeContext(invokeContext, env);
    if (!subject) return {};
    const ts = Number.isInteger(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
    return {
      [ISSUING_AGENT_ASSERTION_HEADER]: signIssuingAgentAssertion({ subject, op: operation, secret, nowSec: ts }),
    };
  } catch (_) {
    return {};
  }
}

function signBoundIssuingAgentAssertion({ subject, op, secret, nowSec, jti, method, path, rid, bodyHash }) {
  const head = subject.kind === 'agent'
    ? { v: 2, kind: 'agent', sub: subject.sub }
    : { v: 2, kind: 'oauth', iss: subject.iss, cid: subject.cid };
  const payload = { ...head, op, ts: nowSec, jti, m: method, p: path, rid: rid == null ? null : String(rid), bh: bodyHash };
  const signingInput = `${ISSUING_AGENT_ASSERTION_VERSION_V2}.${b64url(JSON.stringify(payload))}`;
  const mac = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(mac)}`;
}

/**
 * The v2 header for ONE outbound request: `{ 'X-Pivota-Issuing-Agent': token }`, or `{}` when the op is
 * not a partner-identity op, the flag is off, no secret is configured, or the caller is not one agent.
 * `rawBody` must be the exact string that is sent ('' for no body). Never throws.
 */
function boundIssuingAgentAssertionHeaders({
  op, invokeContext, method, url, rid = null, rawBody = '', env = process.env, nowSec, jti,
} = {}) {
  try {
    const operation = text(op);
    if (!isBoundOp(operation, env)) return {};
    const secret = readSecret(env);
    if (!secret) return {};
    const subject = issuingSubjectFromInvokeContext(invokeContext, env);
    if (!subject) return {};
    const path = new URL(String(url || '')).pathname;
    const bodyHash = crypto.createHash('sha256').update(Buffer.from(String(rawBody ?? ''), 'utf8')).digest('hex');
    return {
      [ISSUING_AGENT_ASSERTION_HEADER]: signBoundIssuingAgentAssertion({
        subject,
        op: operation,
        secret,
        nowSec: Number.isInteger(nowSec) ? nowSec : Math.floor(Date.now() / 1000),
        jti: typeof jti === 'string' && jti ? jti : crypto.randomBytes(18).toString('base64url'),
        method: String(method || 'GET').toUpperCase(),
        path,
        rid,
        bodyHash,
      }),
    };
  } catch (_) {
    return {};
  }
}

/**
 * The OAuth client a verified MCP access token names: RFC 9068 `client_id` (what Pivota's authorization
 * server stamps), else OIDC `azp`. The backend credits it only when it is a confidential client Pivota
 * provisioned; a public (open-registration) client stays agent-less (pivota-backend
 * services/issuing_agent_assertion.py).
 */
function oauthClientFromClaims(claims) {
  const c = claims && typeof claims === 'object' ? claims : {};
  return {
    oauth_issuer: text(c.iss) || null,
    oauth_client_id: text(c.client_id) || text(c.azp) || null,
  };
}

module.exports = {
  ISSUING_AGENT_ASSERTION_HEADER,
  ISSUING_OPS,
  PARTNER_IDENTITY_OPS,
  PARTNER_IDENTITY_FORWARDING_ENV,
  SEED_LINK_MINT_OP,
  partnerIdentityForwardingEnabled,
  isBoundOp,
  signBoundIssuingAgentAssertion,
  boundIssuingAgentAssertionHeaders,
  NON_AGENT_AUTH_SOURCES,
  issuingSubjectFromInvokeContext,
  signIssuingAgentAssertion,
  issuingAgentAssertionHeaders,
  oauthClientFromClaims,
};
