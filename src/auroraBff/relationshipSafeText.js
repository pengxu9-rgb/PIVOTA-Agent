// Text that Postgres will accept, for every relationship-graph write (2026-11-02).
//
// JavaScript strings are UTF-16. `text.slice(0, max)` counts code units, so a cut can land between
// the two halves of an emoji and leave a lone surrogate. JSON.stringify writes a lone half as the
// escape "\udXXX", and Postgres refuses it in a jsonb parameter ("invalid input syntax for type
// json"; Unicode low surrogate must follow a high surrogate). A NUL character fails the same way
// ("unsupported Unicode escape sequence"). In a text parameter node-pg encodes a lone half as U+FFFD,
// which does not throw but corrupts the stored text.
//
// The 2026-11-02 relgraph-sync night failed on exactly this: a product description of more than 512
// characters with an emoji at the cut reached a label snapshot, and the one refused upsert aborted the
// build. Two guarantees, at two places:
// - truncateText never CREATES a lone half. It looks only at the code unit at the cut, because it runs
//   on every normalizeString call in the builder (a full scan cost ~330 ns a call on Node 20).
// - safeJsonbParam REPAIRS whatever reaches a jsonb parameter, whatever its origin.
// Writers that hash a record before storing it refuse malformed text instead (isWellFormedJsonValue),
// since repairing it would make the stored proof differ from its hash.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const LONE_SURROGATE_TEST = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Lone surrogate halves become U+FFFD (what toWellFormed does); NUL characters are removed.
function wellFormedText(value) {
  const text = typeof value === 'string' ? value : String(value == null ? '' : value);
  const formed = typeof text.toWellFormed === 'function' ? text.toWellFormed() : text.replace(LONE_SURROGATE, '\uFFFD');
  return formed.includes('\u0000') ? formed.replace(/\u0000/g, '') : formed;
}

function isWellFormedText(text) {
  const formed = typeof text.isWellFormed === 'function' ? text.isWellFormed() : !LONE_SURROGATE_TEST.test(text);
  return formed && !text.includes('\u0000');
}

// At most `max` UTF-16 code units, never ending on the first half of a pair: a cut that would split
// a pair drops the whole character instead. It does not repair text that arrives malformed (that is
// safeJsonbParam's job at the jsonb boundary).
function truncateText(value, max) {
  const text = typeof value === 'string' ? value : String(value == null ? '' : value);
  if (!(max >= 0) || text.length <= max) return text;
  const end = max > 0 && (text.charCodeAt(max - 1) & 0xfc00) === 0xd800 ? max - 1 : max;
  return text.slice(0, end);
}

function setOwn(target, key, value) {
  // An own "__proto__" key must stay a key, not become the copy's prototype.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

// A copy of a JSON-shaped value with every string (keys included) made well-formed, serialising
// exactly as JSON.stringify would for well-formed input: toJSON is honoured, boxed primitives are
// unboxed, own "__proto__" keys are kept. A cycle is returned as the original object, so
// JSON.stringify still throws on it, as do BigInt values; shared (non-circular) sub-objects are
// copied at every place they appear.
function wellFormedJsonValue(value, ancestors = new Set(), key = '') {
  if (typeof value === 'string') return wellFormedText(value);
  if (!value || typeof value !== 'object') return value;
  if (typeof value.toJSON === 'function') return wellFormedJsonValue(value.toJSON(key), ancestors, key);
  if (value instanceof String) return wellFormedText(value.valueOf());
  if (value instanceof Number || value instanceof Boolean) return value.valueOf();
  if (ancestors.has(value)) return value;
  ancestors.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((item, index) => wellFormedJsonValue(item, ancestors, String(index)));
  } else {
    out = {};
    for (const [itemKey, item] of Object.entries(value)) {
      setOwn(out, wellFormedText(itemKey), wellFormedJsonValue(item, ancestors, itemKey));
    }
  }
  ancestors.delete(value);
  return out;
}

// The text of a jsonb parameter that Postgres will accept. Like JSON.stringify it throws on a cycle
// or a BigInt; `fallback` stands in only for undefined.
function safeJsonbParam(value, fallback = null) {
  return JSON.stringify(wellFormedJsonValue(value === undefined ? fallback : value));
}

// True when every string (and key) in a JSON-shaped value is well-formed and NUL-free.
function isWellFormedJsonValue(value, ancestors = new Set()) {
  if (typeof value === 'string') return isWellFormedText(value);
  if (!value || typeof value !== 'object') return true;
  if (ancestors.has(value)) return true;
  ancestors.add(value);
  const ok = Array.isArray(value)
    ? value.every((item) => isWellFormedJsonValue(item, ancestors))
    : Object.entries(value).every(([itemKey, item]) => isWellFormedText(itemKey) && isWellFormedJsonValue(item, ancestors));
  ancestors.delete(value);
  return ok;
}

module.exports = { wellFormedText, truncateText, wellFormedJsonValue, safeJsonbParam, isWellFormedJsonValue };
