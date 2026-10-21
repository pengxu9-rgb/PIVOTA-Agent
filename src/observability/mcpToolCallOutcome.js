'use strict';

// THE OUTCOME OF ONE MCP tools/call, for the `mcp tools/call complete` line (src/server.js).
//
// Every MCP door answers tools/call with HTTP 200 — a failing tool rides inside the JSON-RPC body — so the
// platform's 5xx metrics cannot see a tool failing, and until this module the completion line carried only
// the tool, the status and the latency. A tool error, a zero-result search and a cache hit all logged the
// same line. This records, per request, what the door actually answered, and folds it into a fixed set of
// fields at 'finish':
//
//   outcome      'ok' | 'tool_error' | 'rpc_error' | 'internal_error' | 'refused' | 'shed' | 'unknown'
//   is_error     outcome !== 'ok'  (a refusal is an error for the caller; the alert filters it out, see
//                docs/runbooks/mcp_tool_outcome_monitoring.md, so a rate-limit flood cannot page as a tool fault)
//   error_code   the tool's code as the caller saw it (UNKNOWN_PRODUCT_ID, ...), JSONRPC_<NAME> for a protocol
//                error, INTERNAL_ERROR when the adapter threw, HTTP_<status> for a refusal before dispatch,
//                MCP_CALLER_SHED for a caller-limit 503 (the door shed load before dispatch)
//   error_class  'server' (a fault on our side: a retriable taxonomy code such as MERCHANT_UNAVAILABLE, an
//                UNEXPECTED_ERROR from an uncurated exception, an internal error, a 5xx) | 'client' (the call
//                will not succeed as sent: UNKNOWN_TOOL, INVALID_ARGUMENTS, UNKNOWN_PRODUCT_ID,
//                USER_AUTH_REQUIRED, OPERATION_NOT_ALLOWED, a protocol error, a refusal) | 'capacity' (the
//                caller limits shed the call before dispatch: src/guardrails/mcpCallerLimits.js answered 503
//                because the database pool was saturated, or a TIER was full or over its rate: the anonymous
//                tier or the unregistered-OAuth-client tier, whose tier rate drops to a per-instance share
//                while the shared counter store is down or stale; see recordCallerLimitRefusal) | null when
//                ok. The error-rate alert counts 'server' only: a caller sending bad ids is not an outage,
//                and shedding is the limits doing their job, counted and alerted on by their own metric and
//                policy (monitoring/alerts/mcp_caller_limits/).
//   result_count rows the caller received, AFTER the public tier's filters (absent for a non-list result)
//   cache_hit    true | false | 'stale' (absent when no cache was consulted)
//   lane, lane_source, upstream_status    the search envelope's own markers, short tokens only
//   degraded     boolean; plus upstream_timeout / upstream_degraded / fallback_used when true
//   heartbeat_committed  the response outlived the heartbeat delay and was streamed (slow path)
//
// Measurement only: nothing reads these back, and nothing here may throw into the request it measures. The
// fields come from the RESULT and the door's own bookkeeping, never from the tool arguments.

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

const JSONRPC_ERROR_NAMES = Object.freeze({
  '-32700': 'PARSE_ERROR',
  '-32600': 'INVALID_REQUEST',
  '-32601': 'METHOD_NOT_FOUND',
  '-32602': 'INVALID_PARAMS',
  '-32603': 'INTERNAL_ERROR',
  '-32001': 'AUTHENTICATION_FAILED',
});

// The fields a surface or adapter may report, and how each is accepted. Anything else is dropped, so a future
// caller cannot widen the line by accident.
const OBSERVED_FIELDS = Object.freeze({
  result_count: (v) => (Number.isInteger(v) && v >= 0 ? v : undefined),
  cache_hit: (v) => (v === true || v === false || v === 'stale' ? v : undefined),
  error_code: (v) => (typeof v === 'string' && ERROR_CODE.test(v) ? v : undefined),
  lane: (v) => (typeof v === 'string' && TOKEN.test(v) ? v : undefined),
  lane_source: (v) => (typeof v === 'string' && TOKEN.test(v) ? v : undefined),
  upstream_status: (v) => (typeof v === 'string' && TOKEN.test(v) ? v : undefined),
  upstream_timeout: (v) => (v === true ? true : undefined),
  upstream_degraded: (v) => (v === true ? true : undefined),
  fallback_used: (v) => (v === true ? true : undefined),
  heartbeat_committed: (v) => (v === true ? true : undefined),
  // Internal to the recorder, never logged as such: they decide error_class and the tool label.
  error_retriable: (v) => (v === true || v === false ? v : undefined),
  tool_registered: (v) => (v === true || v === false ? v : undefined),
});

// Codes that mean "our side failed" even though the taxonomy marks them non-retriable or carries no flag:
// UNEXPECTED_ERROR is what an uncurated exception becomes on the wire.
const SERVER_TOOL_ERROR_CODES = new Set(['UNEXPECTED_ERROR']);

const MAX_TOOL_LABEL_LENGTH = 64;
const TOOL_LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;

function jsonRpcErrorCode(code) {
  const name = JSONRPC_ERROR_NAMES[String(code)];
  if (name) return `JSONRPC_${name}`;
  return Number.isInteger(code) ? `JSONRPC_${code < 0 ? 'M' : ''}${Math.abs(code)}` : 'JSONRPC_UNKNOWN';
}

/**
 * Per-request recorder. The door creates one per tools/call, hands `observe` to the adapter, and reports what
 * it sent with recordRpcResponse / recordToolError / recordInternalError. `fields(statusCode)` folds it all
 * into the log fields at 'finish'.
 */
function createMcpToolCallRecorder() {
  const observed = {};
  let answer = null; // { kind: 'rpc_error'|'tool_error'|'ok'|'internal_error', code? }

  function observe(fields) {
    try {
      if (!fields || typeof fields !== 'object') return;
      for (const [key, accept] of Object.entries(OBSERVED_FIELDS)) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
        const value = accept(fields[key]);
        if (value !== undefined) observed[key] = value;
      }
    } catch (_) {
      // Never into the request.
    }
  }

  // The adapter's answer, read from the JSON-RPC body it produced (whether the door then wrote it directly or
  // the heartbeat streamed it).
  function recordRpcResponse(out) {
    try {
      const body = out && typeof out.body === 'object' && out.body !== null ? out.body : null;
      if (!body) return;
      if (body.error && typeof body.error === 'object') {
        answer = { kind: 'rpc_error', code: jsonRpcErrorCode(body.error.code) };
      } else if (body.result && typeof body.result === 'object' && body.result.isError === true) {
        answer = { kind: 'tool_error' };
      } else if (Object.prototype.hasOwnProperty.call(body, 'result')) {
        answer = { kind: 'ok' };
      }
    } catch (_) {
      // Same.
    }
  }

  // A tool error the DOOR wrote itself (the money kill-switch refusal), without going through the adapter.
  function recordToolError(code) {
    answer = { kind: 'tool_error' };
    observe({ error_code: code });
  }

  // The adapter threw: the caller got a JSON-RPC internal error on a committed wire, or a 503.
  function recordInternalError() {
    answer = { kind: 'internal_error' };
  }

  // The per-caller limits refused the call before dispatch (src/guardrails/mcpCallerLimits.js). A 5xx there is
  // SHEDDING: 'shed' / 'capacity', not a server fault, so the error-rate alert does not count the limits working
  // as an outage. The limiter answers 503 for three reasons (firstViolation):
  //   shed              the database pool has waiters at or above the threshold (anonymous callers at theirs,
  //                     every other limited caller, unregistered OAuth clients included, at the partner one);
  //   tier_concurrency  a TIER's in-flight cap on this instance is full;
  //   tier_rate         a TIER's requests per minute are spent.
  // A tier is the anonymous tier or the unregistered-OAuth-client tier (an OAuth client with no override of
  // its own: policyFor). The tier rate is a shared count, so while the shared counter store is down, its
  // snapshot is stale, or the tier key has not been synced yet, it is cut to this instance's share (limit /
  // MCP_CALLER_LIMITS_EXPECTED_INSTANCES: effectiveLimit) and a store outage alone can raise tier_rate 503s
  // (the limiter's line says limit_split: true). All three are shedding. A 4xx is the caller's own budget
  // (rate, concurrency; also cut to the per-instance share in that fallback) and stays what any refusal before
  // dispatch is: 'refused' / 'client' / HTTP_<status>.
  function recordCallerLimitRefusal(refusal) {
    try {
      if (Number(refusal && refusal.status) >= 500) answer = { kind: 'shed' };
    } catch (_) {
      // Never into the request.
    }
  }

  function fields(statusCode) {
    const status = Number(statusCode) || 0;
    let outcome;
    let errorCode = null;
    if (answer && answer.kind === 'internal_error') {
      outcome = 'internal_error';
      errorCode = 'INTERNAL_ERROR';
    } else if (answer && answer.kind === 'shed') {
      outcome = 'shed';
      errorCode = 'MCP_CALLER_SHED';
    } else if (answer && answer.kind === 'rpc_error') {
      outcome = 'rpc_error';
      errorCode = answer.code;
    } else if (answer && answer.kind === 'tool_error') {
      outcome = 'tool_error';
      errorCode = observed.error_code || 'UNEXPECTED_ERROR';
    } else if (answer && answer.kind === 'ok') {
      outcome = 'ok';
    } else if (status >= 500) {
      outcome = 'internal_error';
      errorCode = `HTTP_${status}`;
    } else if (status >= 400) {
      // Refused before dispatch: disabled door, oversized body, rate limit, auth challenge.
      outcome = 'refused';
      errorCode = `HTTP_${status}`;
    } else {
      outcome = 'unknown';
    }

    let errorClass = null;
    if (outcome === 'internal_error') errorClass = 'server';
    else if (outcome === 'rpc_error') errorClass = errorCode === 'JSONRPC_INTERNAL_ERROR' ? 'server' : 'client';
    else if (outcome === 'tool_error') {
      errorClass = observed.error_retriable === true || SERVER_TOOL_ERROR_CODES.has(errorCode) ? 'server' : 'client';
    } else if (outcome === 'refused') errorClass = 'client';
    else if (outcome === 'shed') errorClass = 'capacity';

    const out = { outcome, is_error: outcome !== 'ok', error_code: errorCode, error_class: errorClass };
    for (const key of ['result_count', 'cache_hit', 'lane', 'lane_source', 'upstream_status']) {
      if (observed[key] !== undefined) out[key] = observed[key];
    }
    const degradedFlags = ['upstream_timeout', 'upstream_degraded', 'fallback_used'].filter((k) => observed[k] === true);
    out.degraded = degradedFlags.length > 0;
    for (const key of degradedFlags) out[key] = true;
    if (observed.heartbeat_committed === true) out.heartbeat_committed = true;
    return out;
  }

  /**
   * The tool name for the log line. `params.name` is whatever the caller sent, so it is logged only when the
   * door's surface recognised it on this call, or when it is one of the names the gateway's own surfaces
   * advertise (`knownToolNames`, for calls refused before dispatch). Anything else is 'other': an unbounded,
   * caller-chosen string must not become a metric label or reach the log verbatim.
   */
  function toolLabel(rawTool, knownToolNames) {
    try {
      const name = typeof rawTool === 'string' ? rawTool.trim() : '';
      if (!name || name.length > MAX_TOOL_LABEL_LENGTH || !TOOL_LABEL.test(name)) return 'other';
      if (observed.tool_registered === false) return 'other';
      if (observed.tool_registered === true) return name;
      return knownToolNames && typeof knownToolNames.has === 'function' && knownToolNames.has(name) ? name : 'other';
    } catch (_) {
      return 'other';
    }
  }

  return { observe, recordRpcResponse, recordToolError, recordInternalError, recordCallerLimitRefusal, fields, toolLabel };
}

/**
 * Which tier answered: 'public' (the auth:none read door), 'first_party' (Pivota's own configured service
 * key), 'authenticated' (any other resolved caller: an introspected agent key, an MCP OAuth connector), or
 * 'unauthenticated' (a commerce door refused before any caller was resolved). Read from req.invokeAuth, which
 * only this gateway's auth code writes.
 */
function mcpCallerTier(req, door) {
  try {
    if (door === 'public_mcp') return 'public';
    const auth = req && typeof req.invokeAuth === 'object' && req.invokeAuth ? req.invokeAuth : null;
    if (!auth) return 'unauthenticated';
    if (auth.introspect_auth_source === 'configured_service_key') return 'first_party';
    return 'authenticated';
  } catch (_) {
    return 'unknown';
  }
}

module.exports = { createMcpToolCallRecorder, mcpCallerTier, jsonRpcErrorCode };
