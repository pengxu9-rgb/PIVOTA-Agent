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
// build. Every truncation and every jsonb parameter in the relgraph pipeline goes through here.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Lone surrogate halves become U+FFFD (what toWellFormed does); NUL characters are removed.
function wellFormedText(value) {
  const text = typeof value === 'string' ? value : String(value == null ? '' : value);
  const formed = typeof text.toWellFormed === 'function' ? text.toWellFormed() : text.replace(LONE_SURROGATE, '\uFFFD');
  return formed.includes('\u0000') ? formed.replace(/\u0000/g, '') : formed;
}

// At most `max` UTF-16 code units, never ending on the first half of a pair: a cut that would split
// a pair drops the whole character instead. Input that was already malformed is repaired too.
function truncateText(value, max) {
  const text = wellFormedText(value);
  if (!(max >= 0) || text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

// A copy of a JSON-shaped value with every string (keys included) made well-formed. Values that are
// not plain JSON (Dates, class instances with toJSON) are left to JSON.stringify as before.
// A cycle is returned as the original object, so JSON.stringify still throws on it; shared
// (non-circular) sub-objects are copied at every place they appear.
function wellFormedJsonValue(value, ancestors = new Set()) {
  if (typeof value === 'string') return wellFormedText(value);
  if (!value || typeof value !== 'object') return value;
  if (typeof value.toJSON === 'function') return wellFormedJsonValue(value.toJSON(), ancestors);
  if (ancestors.has(value)) return value;
  ancestors.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((item) => wellFormedJsonValue(item, ancestors));
  } else {
    out = {};
    for (const [key, item] of Object.entries(value)) out[wellFormedText(key)] = wellFormedJsonValue(item, ancestors);
  }
  ancestors.delete(value);
  return out;
}

// The text of a jsonb parameter that Postgres will accept. Circular or otherwise unserialisable
// values fall back to `fallback` (default JSON null), as the pipeline's stableJson helpers did.
function safeJsonbParam(value, fallback = null) {
  try {
    return JSON.stringify(wellFormedJsonValue(value === undefined ? fallback : value));
  } catch {
    return JSON.stringify(fallback);
  }
}

module.exports = { wellFormedText, truncateText, wellFormedJsonValue, safeJsonbParam };
