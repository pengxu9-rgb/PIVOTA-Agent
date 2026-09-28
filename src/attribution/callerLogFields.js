'use strict';

// WHO CALLED, on a completion log line. Measurement only: nothing reads these fields back.
//
// ADR-025 D1 records the agent a link was issued to, and whether that is worth building for a lane depends
// on who calls the lane. Until now no log line could answer that: the invoke completion line carried only a
// key fingerprint (Pivota's own UI and this gateway's loopback self-calls share one key, so the fingerprint
// cannot tell them apart), and the MCP doors logged no tool calls at all. Measured 2026-09-28 over 7 days of
// find_products_multi: 1,257 calls on that one fingerprint, 618 with none, and no way to see an agent.
//
// The identity comes from req.invokeAuth, which only this gateway's auth code writes (the api-key
// introspection, the configured/emergency fast paths, the MCP OAuth front door). Nothing is taken from a
// request body or a header the caller controls, and no credential is ever copied: `raw_token` is the
// caller's API key and must never reach a log.

const MAX_FIELD_LENGTH = 256;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function text(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s && s.length <= MAX_FIELD_LENGTH ? s : null;
}

// A request this process sent to itself (invokeCommerceKernelRawUpstream's loopback, e.g. an MCP
// search_catalog). Its credential is this gateway's own key, so the agent on its invoke line is the gateway,
// and the real caller is on the MCP door's line. Cloud Run sets X-Forwarded-For on every request it routes
// in; the loopback call is a bare axios request that sets none, so both conditions together mark it.
function isLoopbackSelfCall(req) {
  const remote = text(req?.socket?.remoteAddress);
  if (!remote || !LOOPBACK_ADDRESSES.has(remote)) return false;
  const forwarded = req?.headers?.['x-forwarded-for'];
  return !(typeof forwarded === 'string' && forwarded.trim());
}

/**
 * Log fields naming the resolved caller of `req`. Absent values are omitted, except `caller_auth_mode`,
 * which is always present ('unauthenticated' when no auth record exists, e.g. the public search GET), so
 * a count by auth mode covers every request. Never throws.
 */
function callerLogFields(req) {
  try {
    const auth = req && typeof req.invokeAuth === 'object' && req.invokeAuth ? req.invokeAuth : null;
    const fields = { caller_auth_mode: (auth && text(auth.auth_mode)) || 'unauthenticated' };
    const agentId = auth && text(auth.agent_id);
    if (agentId) fields.caller_agent_id = agentId;
    const oauthClientId = auth && text(auth.oauth_client_id);
    if (oauthClientId) fields.caller_oauth_client_id = oauthClientId;
    const oauthIssuer = auth && text(auth.oauth_issuer);
    if (oauthIssuer) fields.caller_oauth_issuer = oauthIssuer;
    const introspectSource = auth && text(auth.introspect_auth_source);
    if (introspectSource) fields.caller_auth_source = introspectSource;
    if (auth && auth.auth_degraded === true) fields.caller_auth_degraded = true;
    if (isLoopbackSelfCall(req)) fields.caller_loopback = true;
    return fields;
  } catch (_) {
    return { caller_auth_mode: 'unknown' };
  }
}

module.exports = { callerLogFields, isLoopbackSelfCall };
