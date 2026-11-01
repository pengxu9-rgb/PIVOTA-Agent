'use strict';

// SYNTHETIC CALLERS: our own eval traffic on the production MCP door.
//
// An eval harness measures the real system by calling the real read tools. Its calls must not be counted as
// a partner's (click rows, decision ledger, usage counters), must not reach the money tools, and must be told
// apart in every log line a metric or alert reads. This module decides WHO is synthetic and WHAT such a
// caller may send. The skips themselves live with the writers they skip.
//
// WHO. Only a caller the operator listed in SYNTHETIC_CALLERS_JSON: [{"iss": "...", "client_id": "..."}].
// The match is on the VERIFIED access token's issuer AND its `client_id` claim, exact strings. Nothing the
// client sends can make a call synthetic, and `azp` never matches on its own: another issuer the door
// accepts could mint a token whose azp equals our eval client's id.
//
// A BROKEN CONFIG NEVER TAKES TRAFFIC. Any config that is not exactly a list of {iss, client_id} entries on
// our own issuers (unparseable JSON, a non-array, a non-object entry, a missing or misspelt key, an issuer
// that is not ours, an unknown mode) refuses the BOOT: assertSyntheticConfig, called first thing at startup,
// logs synthetic_config_invalid at ERROR and throws. A config only changes with a new revision, so a typo
// leaves traffic on the previous one instead of silently turning the eval client into an ordinary caller with
// the full tool surface and real writes. At runtime an invalid entry is still kept, not dropped (every
// tools/call from it is refused), and a token from a listed client that carries the id only as azp is
// refused too.
//
// WHAT. A listed caller is restricted in EVERY mode, off included: one JSON-RPC object per request, the
// handshake methods, and tools/call for the five read tools only. Anything else is refused before any
// resolver, adapter or name-routed handler sees it, so a tool added later is refused until listed here.
// On the UCP dialect a listed caller is refused outright: phase 1 proves one door.
//
// MODE (SYNTHETIC_TRAFFIC_MODE): off | observe | enforce, default off.
//   off      nobody is synthetic; listed callers are still restricted (above).
//   observe  a listed caller is classified and logged (synthetic_classified), nothing else changes. It is
//            run with NO harness traffic: it proves no real caller is ever classified.
//   enforce  the call carries the synthetic marker to every hop, and the writers skip.

const crypto = require('crypto');

const MODES = new Set(['off', 'observe', 'enforce']);

const SYNTHETIC_READ_TOOLS = Object.freeze(
  new Set(['search_catalog', 'get_product', 'get_offers', 'get_alternatives', 'get_intel']),
);

const SYNTHETIC_RPC_METHODS = Object.freeze(
  new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call']),
);

const SYNTHETIC_DIALECTS = Object.freeze(new Set(['mcp']));

const ENTRY_KEYS = new Set(['iss', 'client_id']);

// A shared HMAC secret shorter than this is refused at boot.
const MIN_SECRET_LENGTH = 32;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function syntheticTrafficMode(env = process.env) {
  const raw = String(env.SYNTHETIC_TRAFFIC_MODE || '').trim().toLowerCase();
  return MODES.has(raw) ? raw : 'off';
}

/**
 * The listed callers, each marked valid or not. `ownIssuers` are this gateway's own authorization servers
 * (MCP_OAUTH_AUTHORIZATION_SERVERS). Unparseable JSON lists nothing and reports the error: there is no
 * entry to restrict, and there is no caller to treat as synthetic either.
 */
function parseSyntheticCallers(env = process.env, { ownIssuers = [] } = {}) {
  const raw = text(env.SYNTHETIC_CALLERS_JSON);
  if (!raw) return { entries: [], error: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { entries: [], error: 'SYNTHETIC_CALLERS_JSON is not valid JSON' };
  }
  if (!Array.isArray(parsed)) return { entries: [], error: 'SYNTHETIC_CALLERS_JSON must be a JSON array' };
  const own = new Set((Array.isArray(ownIssuers) ? ownIssuers : []).map(text).filter(Boolean));
  const entries = [];
  for (const item of parsed) {
    const isObject = Boolean(item) && typeof item === 'object' && !Array.isArray(item);
    const iss = isObject ? text(item.iss) : null;
    const clientId = isObject ? text(item.client_id) : null;
    let reason = null;
    if (!isObject) reason = 'entry_not_object';
    else if (Object.keys(item).some((k) => !ENTRY_KEYS.has(k))) reason = 'unknown_key';
    else if (!clientId) reason = 'missing_client_id';
    else if (!iss) reason = 'missing_iss';
    else if (!own.has(iss)) reason = 'issuer_not_own';
    // Kept even when it can match nothing (no client_id): the boot check counts it.
    entries.push({ iss, client_id: clientId, valid: reason === null, reason });
  }
  return { entries, error: null };
}

/**
 * Whether the configuration may take traffic. `ok` is false for any config a typo could have produced:
 * the caller refuses to boot (assertSyntheticConfig). Unset is ok: nobody is listed.
 */
function syntheticConfigStatus(env = process.env, { ownIssuers = [] } = {}) {
  const rawMode = String(env.SYNTHETIC_TRAFFIC_MODE || '').trim().toLowerCase();
  const modeValid = rawMode === '' || MODES.has(rawMode);
  const configured = Boolean(text(env.SYNTHETIC_CALLERS_JSON));
  const { entries, error } = parseSyntheticCallers(env, { ownIssuers });
  const invalid = entries
    .map((e, index) => (e.valid ? null : { index, reason: e.reason }))
    .filter(Boolean);
  let parseStatus = 'unset';
  if (configured) parseStatus = error ? (/array/.test(error) ? 'not_array' : 'invalid_json') : 'ok';
  const secret = syntheticAssertionSecret(env);
  const secretValid = !secret || secret.length >= MIN_SECRET_LENGTH;
  const ok =
    modeValid &&
    secretValid &&
    (parseStatus === 'unset' || (parseStatus === 'ok' && entries.length > 0 && invalid.length === 0));
  return {
    ok,
    parse_status: parseStatus,
    mode: syntheticTrafficMode(env),
    mode_valid: modeValid,
    secret_valid: secretValid,
    entry_count: entries.length,
    invalid_entries: invalid,
  };
}

/**
 * Called first thing at boot. A config that is not ok logs `synthetic_config_invalid` at ERROR and throws,
 * so the revision never takes traffic; a valid non-empty one logs `synthetic_config_loaded`. Never logs
 * the client ids.
 */
function assertSyntheticConfig({ env = process.env, ownIssuers = [], logger } = {}) {
  const status = syntheticConfigStatus(env, { ownIssuers });
  if (!status.ok) {
    logger?.error?.({ event: 'synthetic_config_invalid', ...status }, 'synthetic_config_invalid');
    throw new Error(`SYNTHETIC_CONFIG_INVALID: ${status.parse_status}`);
  }
  if (status.parse_status === 'ok') {
    logger?.info?.({ event: 'synthetic_config_loaded', ...status }, 'synthetic_config_loaded');
  }
  return status;
}

/**
 * How the door should treat this caller, from the VERIFIED token claims (null for a caller without them).
 *   null                                     not listed: an ordinary caller
 *   { listed, valid:false, reason }          listed, misconfigured: every tools/call is refused
 *   { listed, valid:true, caller, mode, synthetic }   listed; `synthetic` only in enforce
 */
function classifySyntheticCaller(claims, { env = process.env, ownIssuers = [] } = {}) {
  try {
    const c = claims && typeof claims === 'object' ? claims : null;
    if (!c) return null;
    const { entries } = parseSyntheticCallers(env, { ownIssuers });
    if (entries.length === 0) return null;
    const iss = text(c.iss);
    const clientId = text(c.client_id);
    const azp = text(c.azp);
    const exact = entries.find((e) => e.client_id === clientId && e.iss === iss);
    if (exact) {
      if (!exact.valid) return { listed: true, valid: false, reason: exact.reason };
      const mode = syntheticTrafficMode(env);
      return { listed: true, valid: true, caller: `${iss}|${clientId}`, mode, synthetic: mode === 'enforce' };
    }
    // A listed client presenting its id only as azp, on the listed issuer: this is our eval client, so it
    // must not run as an ordinary caller; it cannot be matched exactly either. Refuse.
    if (!clientId && azp && entries.some((e) => e.client_id === azp && e.iss === iss)) {
      return { listed: true, valid: false, reason: 'client_id_claim_missing' };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Null when a listed caller may send this request; otherwise the refusal { code, message }. Checked before
 * anything else reads the body, for listed callers only.
 */
function syntheticRequestRefusal(rpcBody, { dialect = 'mcp', classification = null } = {}) {
  const refuse = (reason) => ({
    code: 'OPERATION_NOT_ALLOWED',
    reason,
    message: 'This operation is not available to this client.',
  });
  if (!SYNTHETIC_DIALECTS.has(dialect)) return refuse('dialect_not_allowed');
  if (!rpcBody || typeof rpcBody !== 'object' || Array.isArray(rpcBody)) return refuse('body_not_single_object');
  const method = rpcBody.method;
  if (typeof method !== 'string' || !SYNTHETIC_RPC_METHODS.has(method)) return refuse('method_not_allowed');
  if (method !== 'tools/call') return null;
  if (classification && classification.valid === false) return refuse('config_invalid');
  const params = rpcBody.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return refuse('tool_not_allowed');
  const name = params.name;
  if (typeof name !== 'string' || !SYNTHETIC_READ_TOOLS.has(name)) return refuse('tool_not_allowed');
  return null;
}

/** A tools/list answer narrowed to the tools a listed caller may call. Any other shape is returned as is. */
function filterToolsListForSynthetic(out) {
  try {
    const tools = out?.body?.result?.tools;
    if (!Array.isArray(tools)) return out;
    return {
      ...out,
      body: {
        ...out.body,
        result: { ...out.body.result, tools: tools.filter((t) => SYNTHETIC_READ_TOOLS.has(t?.name)) },
      },
    };
  } catch (_) {
    return out;
  }
}

// THE BACKEND ASSERTION. Every backend hop of a synthetic call carries X-Pivota-Synthetic-Assertion, so the
// backend can skip its partner-facing writes. HMAC-SHA256 with SYNTHETIC_ASSERTION_SECRET (shared with the
// backend only), over: the synthetic caller, the gateway request id, the issue time, a random id, and a
// fingerprint of the API key the same request authenticates with. The backend accepts it only when that
// fingerprint is the gateway's own key and the issue time is within 60 s; anything else is a real call.
// No nonce store: a re-sent header (an upstream retry) is the same call, and the key binding is what stops
// anyone else using one.

const SYNTHETIC_ASSERTION_HEADER = 'X-Pivota-Synthetic-Assertion';
const SYNTHETIC_ASSERTION_VERSION = 'v1';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function keyFingerprint(apiKey) {
  const k = text(apiKey);
  return k ? crypto.createHash('sha256').update(k).digest('hex').slice(0, 32) : null;
}

function syntheticAssertionSecret(env = process.env) {
  return text(env.SYNTHETIC_ASSERTION_SECRET);
}

function signSyntheticAssertion({ caller, requestId, apiKey }, { secret, nowSec } = {}) {
  const iat = Number.isInteger(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  const payload = {
    c: caller,
    r: requestId,
    iat,
    jti: b64url(crypto.randomBytes(12)),
    kfp: keyFingerprint(apiKey),
  };
  const signingInput = `${SYNTHETIC_ASSERTION_VERSION}.${b64url(JSON.stringify(payload))}`;
  const mac = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(mac)}`;
}

/**
 * `headers` plus the assertion when the invoke context is a synthetic call; `headers` unchanged otherwise.
 * The fingerprint is of the X-API-Key these headers send (none on the checkout-token branch, which a
 * synthetic caller cannot reach). Never throws; with no secret it adds nothing, and the door refuses a
 * synthetic call before dispatch when the secret is missing (syntheticCarrierReady).
 */
function withSyntheticAssertion(headers, invokeContext, { env = process.env, nowSec } = {}) {
  try {
    if (!invokeContext || invokeContext.synthetic !== true) return headers;
    const secret = syntheticAssertionSecret(env);
    const caller = text(invokeContext.synthetic_caller);
    const requestId = text(invokeContext.gw_request_id);
    if (!secret || !caller || !requestId) return headers;
    return {
      ...headers,
      [SYNTHETIC_ASSERTION_HEADER]: signSyntheticAssertion(
        { caller, requestId, apiKey: headers?.['X-API-Key'] },
        { secret, nowSec },
      ),
    };
  } catch (_) {
    return headers;
  }
}

/** Whether a synthetic call can be carried at all. Without the secret the backend would see a real call. */
function syntheticCarrierReady(env = process.env) {
  return Boolean(syntheticAssertionSecret(env));
}

module.exports = {
  assertSyntheticConfig,
  syntheticConfigStatus,
  SYNTHETIC_ASSERTION_HEADER,
  SYNTHETIC_READ_TOOLS,
  SYNTHETIC_RPC_METHODS,
  classifySyntheticCaller,
  filterToolsListForSynthetic,
  keyFingerprint,
  parseSyntheticCallers,
  signSyntheticAssertion,
  syntheticCarrierReady,
  syntheticRequestRefusal,
  syntheticTrafficMode,
  withSyntheticAssertion,
};
