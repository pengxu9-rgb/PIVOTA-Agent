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
// What is NEVER asserted:
//   - a cached read lane: its results are shared across callers and must stay caller-independent
//     (see COMMERCE_CACHED_READ_OPS and mcp-server/src/commerceToolSurface.js). Only ops in
//     ISSUING_OPS are signed, and none of them is cached;
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
  NON_AGENT_AUTH_SOURCES,
  issuingSubjectFromInvokeContext,
  signIssuingAgentAssertion,
  issuingAgentAssertionHeaders,
  oauthClientFromClaims,
};
