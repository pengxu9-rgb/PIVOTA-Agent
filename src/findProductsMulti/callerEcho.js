'use strict';

// What a search request's caller may decide, and what of the caller's own values a search answer may
// carry back. Two rules, used by handleInvokeRequest (src/server.js) for find_products and
// find_products_multi:
//
// 1. THE SEARCH REQUEST CONTRACT IS THE GATEWAY'S. `search_request_contract`, and the fields the gateway
//    copies out of it (`primary_lane`, `primary_retrieval_contract`, `supplement_lanes`), are written by
//    the gateway from its own state. A value under those keys in the request metadata is the caller's and
//    is dropped before anything reads it: otherwise the caller picks the lane and the gateway echoes the
//    pick back as its own. The one in-process hand-off that legitimately arrives with a contract (the
//    public GET search route, which builds one and then calls the invoke handler) names that exact object
//    in its route context; only that object is kept. The same holds for the routing flags
//    `public_search_route` and `invoke_search_rail`: the GET route sets the first itself, and hands over
//    the very metadata object it built; in any other request metadata they are the caller's and dropped.
//    The SEARCH QUALITY contract (`search_quality_contract`) is the gateway's too: the beauty mainline
//    adopted one sent by the caller (in payload.search, the payload itself or the metadata) and searched
//    with its effective_query and category prefix. It is dropped from all three before anything reads it.
//    The gateway builds its own afterwards (buildFindProductsMultiContext writes it into the search block
//    the later lanes read; the early mainline builds one from the query), so no hand-off is lost.
//    The same holds for `query_understanding`: its readers (the beauty mainline, the canonical-chain
//    answer, the policy step) take the one in the search block, else the metadata, so where the gateway
//    had built none (the early beauty lane) one sent by the caller (in payload.search, the payload itself
//    or the metadata) was echoed back whole as the gateway's metadata.query_understanding. It is dropped
//    from all three too. The gateway's own (understandShoppingQuery, via buildFindProductsMultiContext)
//    is written into the search block and the handler's metadata after this drop, so every reader still
//    gets it.
//
// 2. A CALLER VALUE IS ECHOED ONLY WHEN IT IS A PLAIN, SHORT VALUE. The handler copies the caller's
//    attribution values (creator id / name, trace id, source, market) into its metadata, and several lanes
//    copy them on into the answer. In the answer, a top-level key holding one of those caller values, and
//    query_understanding.source / .market recorded from one, stay only when the value passes the allowlist
//    below. A value the gateway set itself (a configured default creator, its default source) is not the
//    caller's and is never touched.
//
// 3. A CALLER VALUE THAT FAILS ITS RULE NEVER COMES BACK IN ANY FORM. The gateway also records the
//    caller's source and market in normalised forms (lower-cased and hyphenated, upper-cased, the string
//    form of an array). Each such field holding the normalised form of a value that failed its rule is
//    cleared, whatever the normalised form itself looks like. For the source, that value is the one the
//    handler CHOSE (normalizeMetadata: the metadata's source, else the payload's): a source the caller sent
//    elsewhere is not the request's, and a field holding the gateway's default, or a chosen source that
//    passed its rule, is the gateway's own even when a rejected string normalises to the same form.
//    The market is the same: the value compared is the market the request USED (callerChosenMarket:
//    the search block's market, else a flat payload's, else the metadata's -- the one every lane serves),
//    not any market the caller sent.

const { BUYER_REGION_CURRENCY } = require('../auroraBff/buyerRegion');
const { isIso3166Alpha2 } = require('./iso3166Alpha2');
const { requestedMarketOf } = require('../services/servingCurrencyGuard');

const CALLER_SEARCH_CONTRACT_KEYS = Object.freeze([
  'search_request_contract',
  'primary_lane',
  'primary_retrieval_contract',
  'supplement_lanes',
]);

// Routing flags only the gateway may set: `public_search_route` (the public GET search route) and
// `invoke_search_rail` (computed from the source). Sent by a caller, the first moved a POST search onto
// the public lanes and the second was echoed as the gateway's own rail.
const CALLER_ROUTING_KEYS = Object.freeze(['public_search_route', 'invoke_search_rail']);

// The search quality contract: written by the gateway (buildSearchQualityContract), never the caller's.
const CALLER_QUALITY_CONTRACT_KEY = 'search_quality_contract';
// The query understanding: written by the gateway (understandShoppingQuery), never the caller's.
const CALLER_QUERY_UNDERSTANDING_KEY = 'query_understanding';
// What a caller cannot put in the payload, at its top level or in its search block.
const CALLER_PAYLOAD_GATEWAY_KEYS = Object.freeze([CALLER_QUALITY_CONTRACT_KEY, CALLER_QUERY_UNDERSTANDING_KEY]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * True when `rawMetadata` is the very metadata object an in-process route built and handed over
 * (`gatewayMetadata`): every key in it was set by the gateway, from parameters it validated itself.
 */
function isGatewaySearchMetadata(rawMetadata, gatewayMetadata = null) {
  return isPlainObject(rawMetadata) && isPlainObject(gatewayMetadata) && rawMetadata === gatewayMetadata;
}

/**
 * The request metadata without the caller's search request contract fields and routing flags.
 * `gatewayMetadata` is the metadata object an in-process route built and handed over, and
 * `gatewayContract` the contract it built: metadata that is exactly that object is the gateway's own and
 * is returned unchanged, and a contract that is exactly that object is kept. Anything else under those
 * keys came from the request body. Returns the input itself when there is nothing to drop.
 */
function withoutCallerSearchRequestContract(rawMetadata, { gatewayContract = null, gatewayMetadata = null } = {}) {
  if (!isPlainObject(rawMetadata)) return rawMetadata;
  if (isGatewaySearchMetadata(rawMetadata, gatewayMetadata)) return rawMetadata;
  const gatewayOwnContract =
    isPlainObject(gatewayContract) && rawMetadata.search_request_contract === gatewayContract;
  const callerKeys = [
    ...(gatewayOwnContract ? [] : CALLER_SEARCH_CONTRACT_KEYS),
    ...CALLER_ROUTING_KEYS,
    CALLER_QUALITY_CONTRACT_KEY,
    CALLER_QUERY_UNDERSTANDING_KEY,
  ];
  if (!callerKeys.some((key) => hasOwn(rawMetadata, key))) return rawMetadata;
  const out = { ...rawMetadata };
  for (const key of callerKeys) delete out[key];
  return out;
}

/**
 * Each payload without the caller's `search_quality_contract` and `query_understanding`, at its top level
 * and in its search block. The handler keeps two copies of the payload (the parsed one and the raw
 * request body's, which lanes also read) that share their search block: a block (or payload) seen twice
 * is copied once, so the copies still share it. A payload with nothing to drop is returned as it is.
 */
function withoutCallerSearchGatewayKeys(...payloads) {
  const copies = new Map();
  const withoutKey = (obj) => {
    if (!isPlainObject(obj) || !CALLER_PAYLOAD_GATEWAY_KEYS.some((key) => hasOwn(obj, key))) return obj;
    if (!copies.has(obj)) {
      const out = { ...obj };
      for (const key of CALLER_PAYLOAD_GATEWAY_KEYS) delete out[key];
      copies.set(obj, out);
    }
    return copies.get(obj);
  };
  return payloads.map((payload) => {
    if (!isPlainObject(payload)) return payload;
    if (copies.has(payload)) return copies.get(payload);
    const search = withoutKey(payload.search);
    const top = withoutKey(payload);
    if (search === payload.search) return top;
    const out = top === payload ? { ...payload } : top;
    out.search = search;
    copies.set(payload, out);
    return out;
  });
}

// A display name: 1-128 characters, no control, zero-width, bidi or line/paragraph-separator character,
// no markup bracket, and no script-scheme prefix.
const ECHO_NAME =
  /^(?!\s*(?:javascript|vbscript|data):)[^\u0000-\u001f\u007f-\u009f<>\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]{1,128}$/i;
const ECHO_ID = /^[\w.:-]{1,128}$/;
const ECHO_SOURCE = /^[a-z0-9_.:-]{1,64}$/i;
const ECHO_MARKET = Object.freeze({
  // A market the gateway prices for, an officially assigned ISO 3166-1 alpha-2 country code, or EU, each
  // exactly as written: 'us', 'USA', user-assigned codes (XX, ZZ) and anything else are not.
  test: (value) =>
    typeof value === 'string' && (hasOwn(BUYER_REGION_CURRENCY, value) || isIso3166Alpha2(value) || value === 'EU'),
});

const CALLER_ECHO_ALLOWLIST = Object.freeze({
  source: ECHO_SOURCE,
  creator_id: ECHO_ID,
  creatorId: ECHO_ID,
  creator_name: ECHO_NAME,
  creatorName: ECHO_NAME,
  trace_id: ECHO_ID,
  traceId: ECHO_ID,
  market: ECHO_MARKET,
});

// normalizeMetadata copies these caller keys under a second spelling: the copy is the caller's too.
const CALLER_ECHO_KEY_ALIASES = Object.freeze({
  creator_id: 'creatorId',
  creatorId: 'creator_id',
  creator_name: 'creatorName',
  creatorName: 'creator_name',
  trace_id: 'traceId',
  traceId: 'trace_id',
});

// Where the handler reads these values from besides the request metadata.
const CALLER_PAYLOAD_ECHO_KEYS = Object.freeze([
  'creator_id', 'creatorId', 'creator_name', 'creatorName', 'trace_id', 'traceId', 'source', 'market',
]);
const CALLER_SEARCH_ECHO_KEYS = Object.freeze(['creator_id', 'source', 'market']);

// query_understanding (and the search quality contract's hard constraints) record the source and market
// they were given, in this form.
const QUERY_UNDERSTANDING_RECORDED_FORM = Object.freeze({
  source: (value) => String(value).trim(),
  market: (value) => String(value).trim().toUpperCase(),
});

// The gateway's normalised forms of a source (normalizeAgentSource in src/server.js, the search request
// contract's and the beauty delegation trace's normalizeSourceToken) all lower-case it and fold spaces,
// underscores and hyphens to hyphens; this is the coarsest of them, so a field holding any of those forms
// of a value maps to the same key.
function sourceFormKey(value) {
  try {
    return String(value).trim().toLowerCase().replace(/[\s_-]+/g, '-');
  } catch (_) {
    return null;
  }
}

// Fields that hold a normalised form of the source the handler used: [path from the body, ...].
const SOURCE_FORM_FIELDS = Object.freeze([
  Object.freeze(['metadata', 'search_request_contract', 'source']),
  Object.freeze(['metadata', 'guard_source_normalized']),
  Object.freeze(['beauty_expert_v1', 'delegation_trace', 'source_profile']),
]);

function isEchoableCallerValue(key, value) {
  const rule = hasOwn(CALLER_ECHO_ALLOWLIST, key) ? CALLER_ECHO_ALLOWLIST[key] : null;
  return Boolean(rule) && typeof value === 'string' && rule.test(value);
}

// True when `recorded` is `recordedForm` of `value`, a value the caller sent under `key` that fails its rule.
function recordedFromRejected(key, value, recorded, recordedForm) {
  if (value === undefined || value === null || isEchoableCallerValue(key, value)) return false;
  try {
    return recordedForm(value) === recorded;
  } catch (_) {
    return false;
  }
}

/**
 * The source normalizeMetadata (src/server.js) takes from the caller: the metadata's source, else the
 * payload's (`rawMetadata.source || payload.source`); undefined when it falls back to the gateway's
 * default. This is the source the request runs as, so the only caller source whose normalised forms
 * the answer can hold.
 */
function callerChosenSource(rawMetadata, payload) {
  const fromMetadata = isPlainObject(rawMetadata) ? rawMetadata.source : undefined;
  if (fromMetadata) return fromMetadata;
  const fromPayload = isPlainObject(payload) ? payload.source : undefined;
  return fromPayload || undefined;
}

/**
 * The market the request used: the one every find_products_multi lane serves and
 * buildFindProductsMultiContext (src/findProductsMulti/policy.js) records into the query understanding and
 * the search quality contract -- servingCurrencyGuard.requestedMarketOf: the search block's market (the
 * payload itself when there is no search block), else the metadata's. A `market` beside a search block is
 * not it. Undefined when the request names none. This is the only caller market whose recorded form the
 * answer's query_understanding.market and hard_constraints.market can hold.
 */
function callerChosenMarket(rawMetadata, payload) {
  return requestedMarketOf(payload, rawMetadata) || undefined;
}

// `body` with the value at `path` replaced by `next`, copying each object on the way; the body itself
// when the path is not there.
function withValueAt(body, path, next) {
  const [head, ...rest] = path;
  if (!isPlainObject(body) || !hasOwn(body, head)) return body;
  const inner = rest.length ? withValueAt(body[head], rest, next) : next;
  return inner === body[head] ? body : { ...body, [head]: inner };
}

function valueAt(body, path) {
  let node = body;
  for (const key of path) {
    if (!isPlainObject(node) || !hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * Every value the caller sent under an allowlisted key, by key: from the request metadata, and from each
 * payload's top level and payload.search (the parsed payload and the raw request payload, which lanes
 * also read). Taken before the handler writes anything.
 */
function collectCallerEchoValues(rawMetadata, ...payloads) {
  const sent = new Map();
  const add = (key, value) => {
    if (value === undefined || value === null) return;
    if (!sent.has(key)) sent.set(key, []);
    sent.get(key).push(value);
  };
  const metadata = isPlainObject(rawMetadata) ? rawMetadata : {};
  for (const key of Object.keys(CALLER_ECHO_ALLOWLIST)) add(key, metadata[key]);
  for (const payload of payloads) {
    const body = isPlainObject(payload) ? payload : {};
    const search = isPlainObject(body.search) ? body.search : {};
    for (const key of CALLER_PAYLOAD_ECHO_KEYS) add(key, body[key]);
    for (const key of CALLER_SEARCH_ECHO_KEYS) add(key, search[key]);
  }
  return sent;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
}

/**
 * The answer without any caller value that fails the allowlist: top-level metadata keys holding one, and
 * query_understanding.source / .market (and hard_constraints.market) recorded from one. `chosenSource` is
 * the source the request ran as when it came from the caller (callerChosenSource), and `chosenMarket` the
 * market it used (callerChosenMarket); the recorded forms are checked against those alone. Returns the
 * body itself when nothing is dropped, so an answer to a clean request is the same object, byte for byte.
 */
function withoutHostileCallerEcho(body, callerValues, { chosenSource, chosenMarket } = {}) {
  if (!isPlainObject(body) || !isPlainObject(body.metadata)) return body;
  if (!(callerValues instanceof Map) || callerValues.size === 0) return body;
  const sentAs = (key, value) => (callerValues.get(key) || []).some((sent) => sameValue(sent, value));
  const fromCaller = (key, value) =>
    sentAs(key, value) || (hasOwn(CALLER_ECHO_KEY_ALIASES, key) && sentAs(CALLER_ECHO_KEY_ALIASES[key], value));

  const metadata = body.metadata;
  let nextMetadata = metadata;
  for (const key of Object.keys(CALLER_ECHO_ALLOWLIST)) {
    if (!hasOwn(metadata, key)) continue;
    const value = metadata[key];
    if (!fromCaller(key, value) || isEchoableCallerValue(key, value)) continue;
    if (nextMetadata === metadata) nextMetadata = { ...metadata };
    delete nextMetadata[key];
  }

  // query_understanding.source / .market: the recorded form of a caller value that fails its rule goes,
  // whatever the recorded form looks like (an array ['X'] is recorded as 'X', 'zz' as 'ZZ'). The values
  // recorded are the chosen source and the used market, so only those are compared: a rejected market
  // the caller sent elsewhere was not read, and a field holding the same form holds a clean one.
  const chosen = { source: chosenSource, market: chosenMarket };
  const understanding = metadata.query_understanding;
  if (isPlainObject(understanding)) {
    let kept = understanding;
    for (const [key, recordedForm] of Object.entries(QUERY_UNDERSTANDING_RECORDED_FORM)) {
      if (!hasOwn(kept, key)) continue;
      if (!recordedFromRejected(key, chosen[key], kept[key], recordedForm)) continue;
      if (kept === understanding) kept = { ...understanding };
      delete kept[key];
    }
    if (kept !== understanding) {
      if (nextMetadata === metadata) nextMetadata = { ...metadata };
      nextMetadata.query_understanding = kept;
    }
  }

  let out = nextMetadata === metadata ? body : { ...body, metadata: nextMetadata };

  // search_quality_contract.hard_constraints.market: the same rule, against the used market; cleared to
  // null, its value when no market was given.
  const marketPath = ['metadata', 'search_quality_contract', 'hard_constraints', 'market'];
  const constraintMarket = valueAt(out, marketPath);
  if (
    constraintMarket !== undefined &&
    constraintMarket !== null &&
    recordedFromRejected('market', chosenMarket, constraintMarket, QUERY_UNDERSTANDING_RECORDED_FORM.market)
  ) {
    out = withValueAt(out, marketPath, null);
  }

  // The normalised forms of the chosen source, when it fails its rule: cleared to null. A rejected source
  // the caller sent elsewhere (payload.search.source, or payload.source beside a metadata source) was not
  // the request's, so a field holding the same form holds the gateway's own source.
  const rejectedSourceKey =
    chosenSource !== undefined && chosenSource !== null && !isEchoableCallerValue('source', chosenSource)
      ? sourceFormKey(chosenSource)
      : null;
  if (rejectedSourceKey !== null) {
    for (const path of SOURCE_FORM_FIELDS) {
      const value = valueAt(out, path);
      if (value === undefined || value === null) continue;
      if (sourceFormKey(value) !== rejectedSourceKey) continue;
      out = withValueAt(out, path, null);
    }
  }

  return out;
}

module.exports = {
  CALLER_SEARCH_CONTRACT_KEYS,
  CALLER_ROUTING_KEYS,
  CALLER_ECHO_ALLOWLIST,
  isGatewaySearchMetadata,
  withoutCallerSearchRequestContract,
  withoutCallerSearchGatewayKeys,
  // The name #2511 gave it, when it dropped the search quality contract alone.
  withoutCallerSearchQualityContract: withoutCallerSearchGatewayKeys,
  callerChosenSource,
  callerChosenMarket,
  isEchoableCallerValue,
  collectCallerEchoValues,
  withoutHostileCallerEcho,
};
