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
//    in its route context; only that object is kept.
//
// 2. A CALLER VALUE IS ECHOED ONLY WHEN IT IS A PLAIN, SHORT VALUE. The handler copies the caller's
//    attribution values (creator id / name, trace id, source, market) into its metadata, and several lanes
//    copy them on into the answer. In the answer, a top-level key holding one of those caller values, and
//    query_understanding.source / .market recorded from one, stay only when the value passes the allowlist
//    below. A value the gateway set itself (a configured default creator, its default source) is not the
//    caller's and is never touched.

const { BUYER_REGION_CURRENCY } = require('../auroraBff/buyerRegion');

const CALLER_SEARCH_CONTRACT_KEYS = Object.freeze([
  'search_request_contract',
  'primary_lane',
  'primary_retrieval_contract',
  'supplement_lanes',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * The request metadata without the caller's search request contract fields. `gatewayContract` is the
 * contract an in-process route built and handed over: when the metadata carries exactly that object it is
 * the gateway's own, and the metadata is returned unchanged. Anything else under those keys came from the
 * request body. Returns the input itself when there is nothing to drop.
 */
function withoutCallerSearchRequestContract(rawMetadata, { gatewayContract = null } = {}) {
  if (!isPlainObject(rawMetadata)) return rawMetadata;
  if (isPlainObject(gatewayContract) && rawMetadata.search_request_contract === gatewayContract) {
    return rawMetadata;
  }
  if (!CALLER_SEARCH_CONTRACT_KEYS.some((key) => hasOwn(rawMetadata, key))) return rawMetadata;
  const out = { ...rawMetadata };
  for (const key of CALLER_SEARCH_CONTRACT_KEYS) delete out[key];
  return out;
}

// A display name: 1-128 characters, no control, zero-width, bidi or line/paragraph-separator character,
// no markup bracket, and no script-scheme prefix.
const ECHO_NAME =
  /^(?!\s*(?:javascript|vbscript|data):)[^\u0000-\u001f\u007f-\u009f<>\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]{1,128}$/i;
const ECHO_ID = /^[\w.:-]{1,128}$/;
const ECHO_SOURCE = /^[a-z0-9_.:-]{1,64}$/i;
const ECHO_MARKET = Object.freeze({
  // a market the gateway prices for, exactly as written ('us', 'USA' and unknown codes are not)
  test: (value) => hasOwn(BUYER_REGION_CURRENCY, value),
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

// query_understanding records the source and market it was given, in this form.
const QUERY_UNDERSTANDING_RECORDED_FORM = Object.freeze({
  source: (value) => String(value).trim(),
  market: (value) => String(value).trim().toUpperCase(),
});

function isEchoableCallerValue(key, value) {
  const rule = hasOwn(CALLER_ECHO_ALLOWLIST, key) ? CALLER_ECHO_ALLOWLIST[key] : null;
  return Boolean(rule) && typeof value === 'string' && rule.test(value);
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
 * query_understanding.source / .market recorded from one. Returns the body itself when nothing is dropped,
 * so an answer to a clean request is the same object, byte for byte.
 */
function withoutHostileCallerEcho(body, callerValues) {
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

  const understanding = metadata.query_understanding;
  if (isPlainObject(understanding)) {
    let kept = understanding;
    for (const [key, recordedForm] of Object.entries(QUERY_UNDERSTANDING_RECORDED_FORM)) {
      if (!hasOwn(kept, key)) continue;
      const value = kept[key];
      const recordedFromCaller = (callerValues.get(key) || []).some((sent) => {
        try {
          return recordedForm(sent) === value;
        } catch (_) {
          return false;
        }
      });
      if (!recordedFromCaller || isEchoableCallerValue(key, value)) continue;
      if (kept === understanding) kept = { ...understanding };
      delete kept[key];
    }
    if (kept !== understanding) {
      if (nextMetadata === metadata) nextMetadata = { ...metadata };
      nextMetadata.query_understanding = kept;
    }
  }

  return nextMetadata === metadata ? body : { ...body, metadata: nextMetadata };
}

module.exports = {
  CALLER_SEARCH_CONTRACT_KEYS,
  CALLER_ECHO_ALLOWLIST,
  withoutCallerSearchRequestContract,
  isEchoableCallerValue,
  collectCallerEchoValues,
  withoutHostileCallerEcho,
};
