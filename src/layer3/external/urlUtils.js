const crypto = require('crypto');

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ttclid', 'igshid', 'mc_cid', 'mc_eid']);

function validateHttpUrlOrThrow(rawUrl) {
  if (!rawUrl || rawUrl.length > 2048) {
    const err = new Error('URL_INVALID');
    err.code = 'URL_INVALID';
    throw err;
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    const err = new Error('URL_INVALID');
    err.code = 'URL_INVALID';
    throw err;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const err = new Error('URL_INVALID');
    err.code = 'URL_INVALID';
    throw err;
  }
  if (url.username || url.password) {
    const err = new Error('URL_INVALID');
    err.code = 'URL_INVALID';
    throw err;
  }
  return url;
}

function hostnameMatchesAllowlist(hostname, allowed) {
  const host = String(hostname || '').toLowerCase();
  for (const entryRaw of allowed || []) {
    const entry = String(entryRaw || '').trim().toLowerCase();
    if (!entry) continue;
    if (host === entry) return true;
    if (host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

function canonicalizeUrl(input) {
  const url = new URL(input.toString());
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }

  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams.entries()) {
    const k = String(key).toLowerCase();
    if (TRACKING_PARAMS.has(k)) continue;
    if (TRACKING_PARAM_PREFIXES.some((p) => k.startsWith(p))) continue;
    kept.append(key, value);
  }

  const sortedKeys = Array.from(new Set(Array.from(kept.keys()))).sort((a, b) => a.localeCompare(b));
  const normalized = new URLSearchParams();
  for (const key of sortedKeys) {
    const values = kept.getAll(key);
    values.sort((a, b) => a.localeCompare(b));
    for (const v of values) normalized.append(key, v);
  }
  url.search = normalized.toString();
  return url.toString();
}

function stableOfferIdFromCanonicalUrl(canonicalUrl) {
  const hex = crypto.createHash('sha256').update(String(canonicalUrl), 'utf8').digest('hex');
  return `offer_${hex.slice(0, 24)}`;
}

module.exports = {
  validateHttpUrlOrThrow,
  hostnameMatchesAllowlist,
  canonicalizeUrl,
  stableOfferIdFromCanonicalUrl,
};

