const ABSOLUTE_HTTP_URL_RE = /^https?:\/\//i;
const SHOPIFY_FILE_HASH_SUFFIX_RE =
  /^(.*?_[0-9]+)_(?:[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}|[0-9a-f-]{16,})\.(avif|gif|jpe?g|png|webp)$/i;
const IMAGE_DEDUPE_IGNORED_QUERY_KEYS = new Set([
  'w',
  'width',
  'h',
  'height',
  'q',
  'quality',
  'dpr',
  'auto',
  'format',
  'fm',
  'fit',
]);
const KNOWN_SDCND_FILENAME_ALIASES = {
  'tf_sku_t2ss02_3000x3000_0.png': 'tf_sku_T2SS02_3000x3000_1.png',
};

function isAbsoluteHttpUrl(value) {
  return ABSOLUTE_HTTP_URL_RE.test(String(value || '').trim());
}

function isKnownHost(hostname, candidates) {
  const normalizedHost = String(hostname || '').trim().toLowerCase();
  if (!normalizedHost) return false;
  return candidates.some((host) => normalizedHost === host || normalizedHost.endsWith(`.${host}`));
}

function isShopifyLikeAsset(parsed) {
  const pathname = String(parsed?.pathname || '').toLowerCase();
  return (
    isKnownHost(parsed?.hostname, ['cdn.shopify.com', 'shopifycdn.com', 'sdcdn.io']) ||
    pathname.includes('/cdn/shop/files/') ||
    pathname.includes('/s/files/')
  );
}

function rewriteKnownSdcdnMirror(parsed) {
  const next = new URL(parsed.toString());
  const filename = String(next.pathname.split('/').pop() || '').trim();
  if (!filename) return next;

  if (
    isKnownHost(next.hostname, ['cdn.shopify.com', 'shopifycdn.com']) &&
    /^tf_/i.test(filename)
  ) {
    const mirror = new URL(`https://sdcdn.io/tf/${filename}`);
    mirror.searchParams.set('height', '1400px');
    mirror.searchParams.set('width', '1400px');
    return mirror;
  }

  return next;
}

function normalizeShopifyLikeFilename(filename) {
  const trimmed = String(filename || '').trim();
  if (!trimmed) return trimmed;
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }
  const compacted = decoded.replace(/\s*_\s*/g, '_').trim();
  const aliased = KNOWN_SDCND_FILENAME_ALIASES[compacted.toLowerCase()] || compacted;
  const matched = aliased.match(SHOPIFY_FILE_HASH_SUFFIX_RE);
  if (matched) {
    return `${matched[1]}.${matched[2]}`;
  }
  return aliased;
}

function normalizePdpImageUrl(value) {
  const raw = String(value || '').trim();
  if (!isAbsoluteHttpUrl(raw)) return '';

  try {
    let parsed = new URL(raw);
    if (isShopifyLikeAsset(parsed)) {
      parsed.searchParams.delete('v');
      const segments = parsed.pathname.split('/');
      const lastIndex = segments.length - 1;
      segments[lastIndex] = normalizeShopifyLikeFilename(segments[lastIndex] || '');
      parsed.pathname = segments.join('/');
    }
    parsed = rewriteKnownSdcdnMirror(parsed);
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizePdpImageUrls(values) {
  const seen = new Set();
  const out = [];

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizePdpImageUrl(
      typeof value === 'string' ? value : value?.url || value?.src || value?.image_url,
    );
    const dedupeKey = buildPdpImageDedupeKey(normalized) || normalized;
    if (!normalized || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(normalized);
  }

  return out;
}

function buildPdpImageDedupeKey(value) {
  const normalized = normalizePdpImageUrl(value);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    if (isShopifyLikeAsset(parsed)) {
      const filename = normalizeShopifyLikeFilename(parsed.pathname.split('/').pop() || '');
      if (filename) {
        return `asset:${filename.toLowerCase()}`;
      }
    }
    const normalizedSearch = new URLSearchParams();
    Array.from(parsed.searchParams.entries())
      .sort(([aKey, aValue], [bKey, bValue]) => {
        if (aKey === bKey) return aValue.localeCompare(bValue);
        return aKey.localeCompare(bKey);
      })
      .forEach(([key, candidateValue]) => {
        if (IMAGE_DEDUPE_IGNORED_QUERY_KEYS.has(String(key || '').toLowerCase())) return;
        normalizedSearch.append(key, candidateValue);
      });

    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${
      normalizedSearch.toString() ? `?${normalizedSearch.toString()}` : ''
    }`;
  } catch {
    return normalized;
  }
}

module.exports = {
  buildPdpImageDedupeKey,
  normalizePdpImageUrl,
  normalizePdpImageUrls,
};
