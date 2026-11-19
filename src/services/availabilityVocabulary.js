'use strict';

// One availability vocabulary for the gateway: a port of the backend's
// utils/availability_vocabulary.normalize_availability (pivota-backend). The two must
// classify every spelling identically; tests/fixtures/availability_spellings_parity.json
// is a byte-identical copy of the backend's tests/fixtures/availability_spellings_parity.json
// and both change together (regenerate it in the backend, copy it here, never hand-edit).
//
// Result: 'in_stock' | 'out_of_stock' | null. null means "could not determine it" (empty,
// unrecognised, deliberately ambiguous, or self-contradictory). It NEVER means out of stock.
//
// Today only catalogServingIndex.resolveAvailabilityState (flag on) reads this.
// externalSeedProducts.normalizeSeedAvailability is an older, narrower vocabulary; it should
// migrate onto this module in a follow-up (its callers' outputs would change, so not here).

const IN_STOCK = 'in_stock';
const OUT_OF_STOCK = 'out_of_stock';

// Canonical tokens: lowercased, schema.org IRI unwrapped, every non-alphanumeric removed.
const OUT_OF_STOCK_TOKENS = new Set([
  'outofstock',
  'soldout',
  'unavailable',
  'notavailable',
  'oos',
  'reserved',
  // Deliberate product choice mirrored from the backend: discontinued is not servable.
  'discontinued',
]);

const IN_STOCK_TOKENS = new Set([
  'instock',
  'available',
  'instocknow',
  'limitedavailability',
  'limitedstock',
]);

// Orderable-but-not-immediate or channel-restricted: unknown on purpose. Checked first.
const AMBIGUOUS_TOKENS = new Set([
  'backorder',
  'backordered',
  'onbackorder',
  'preorder',
  'presale',
  'madetoorder',
  'onlineonly',
  'instoreonly',
]);

// Only a WHOLE schema.org IRI (http/https, optional www) is unwrapped.
const SCHEMA_ORG_IRI_RE = /^https?:\/\/(?:www\.)?schema\.org\/([A-Za-z]+)$/;

// Out-of-stock-only substring fallback. "oos" and "reserved" stay exact-token-only.
const OUT_OF_STOCK_PHRASES = [
  'outofstock',
  'soldout',
  'nolongerinstock',
  'nolongeravailable',
  'notinstock',
  'notavailable',
  'unavailable',
  'discontinued',
];

// Used only to detect a self-contradictory phrase, never to conclude in-stock.
const IN_STOCK_PHRASES = ['instock', 'available'];

const NON_ALNUM_RE = /[^\p{L}\p{N}]/gu;

function candidateValues(value) {
  if (Array.isArray(value) || value instanceof Set) return Array.from(value);
  if (value && typeof value === 'object') {
    const out = [];
    for (const key of ['@id', '@value', 'id', 'value', 'availability']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) out.push(value[key]);
    }
    return out;
  }
  return [value];
}

// Python's str.strip() set (str.isspace). NOT JS trim(): trim also strips U+FEFF and keeps
// U+001C..U+001F and U+0085, which Python does the other way round.
const PY_WHITESPACE = '\t\n\u000b\f\r\u001c\u001d\u001e\u001f \u0085  '
  + '               　';
const PY_STRIP_RE = new RegExp(`^[${PY_WHITESPACE}]+|[${PY_WHITESPACE}]+$`, 'gu');

// Characters Python's repr() escapes (not str.isprintable(); a plain space stays).
const PY_NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function pyStrRepr(text) {
  let out = '';
  for (const ch of text) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch !== ' ' && PY_NON_PRINTABLE_RE.test(ch)) {
      const cp = ch.codePointAt(0);
      if (cp < 0x100) out += `\\x${cp.toString(16).padStart(2, '0')}`;
      else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, '0')}`;
      else out += `\\U${cp.toString(16).padStart(8, '0')}`;
    } else out += ch;
  }
  return `'${out}'`;
}

// The backend calls str() on whatever candidate it gets; for a NESTED container that is
// Python's repr. Only its alphanumeric content survives canonicalisation, so this mirrors
// that content (keys, values, True/False/None, escape letters), not the punctuation.
function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return pyStrRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (value instanceof Set) return `{${Array.from(value).map(pyRepr).join(', ')}}`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${pyStrRepr(k)}: ${pyRepr(v)}`).join(', ')}}`;
  }
  return String(value);
}

function pyStr(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return pyRepr(value);
  return String(value);
}

function canonicalToken(value) {
  let text = pyStr(value).replace(PY_STRIP_RE, '');
  if (!text) return '';
  const iri = SCHEMA_ORG_IRI_RE.exec(text);
  if (iri) text = iri[1];
  return text.toLowerCase().replace(NON_ALNUM_RE, '');
}

function phraseVerdict(token) {
  const matched = OUT_OF_STOCK_PHRASES.filter((phrase) => token.includes(phrase));
  if (!matched.length) return null;
  let remainder = token;
  for (const phrase of matched) remainder = remainder.split(phrase).join('');
  if (IN_STOCK_PHRASES.some((phrase) => remainder.includes(phrase))) return null;
  return OUT_OF_STOCK;
}

function normalizeScalar(value) {
  if (value === true) return IN_STOCK;
  if (value === false) return OUT_OF_STOCK;
  const token = canonicalToken(value);
  if (!token) return null;
  if (AMBIGUOUS_TOKENS.has(token)) return null;
  if (OUT_OF_STOCK_TOKENS.has(token)) return OUT_OF_STOCK;
  if (IN_STOCK_TOKENS.has(token)) return IN_STOCK;
  return phraseVerdict(token);
}

function normalizeAvailability(value) {
  const verdicts = new Set();
  for (const item of candidateValues(value)) {
    const verdict = normalizeScalar(item);
    if (verdict !== null) verdicts.add(verdict);
  }
  // Zero decisive signals, or two that disagree: unknown.
  if (verdicts.size !== 1) return null;
  return verdicts.values().next().value;
}

module.exports = {
  IN_STOCK,
  OUT_OF_STOCK,
  normalizeAvailability,
};
