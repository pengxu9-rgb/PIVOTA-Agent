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
const TOM_FORD_SHOPIFY_FILES_PREFIX = '/s/files/1/0761/9690/5173/files/';
const DEFAULT_SHOPIFY_WIDTH_PLACEHOLDER = '1024';

function isAbsoluteHttpUrl(value) {
  return ABSOLUTE_HTTP_URL_RE.test(String(value || '').trim());
}

function isKnownHost(hostname, candidates) {
  const normalizedHost = String(hostname || '').trim().toLowerCase();
  if (!normalizedHost) return false;
  return candidates.some((host) => normalizedHost === host || normalizedHost.endsWith(`.${host}`));
}

function isSdcdnHost(hostname) {
  return isKnownHost(hostname, ['sdcdn.io']);
}

function isShopifyLikeAsset(parsed) {
  const pathname = String(parsed?.pathname || '').toLowerCase();
  return (
    isKnownHost(parsed?.hostname, ['cdn.shopify.com', 'shopifycdn.com', 'sdcdn.io']) ||
    pathname.includes('/cdn/shop/files/') ||
    pathname.includes('/s/files/')
  );
}

function rewriteTomFordAssetToOfficialShopify(parsed) {
  const next = new URL(parsed.toString());
  const filename = normalizeShopifyLikeFilename(
    String(next.pathname.split('/').pop() || '').trim(),
    { stripHash: false },
  );
  if (!filename) return next;

  if (isSdcdnHost(next.hostname)) {
    return next;
  }

  if (/^tfb?_sku_/i.test(filename)) {
    const rewritten = new URL(`https://cdn.shopify.com${TOM_FORD_SHOPIFY_FILES_PREFIX}${filename}`);
    rewritten.search = next.search;
    return rewritten;
  }

  return next;
}

function normalizeShopifyLikeFilename(filename, options = {}) {
  const stripHash = options.stripHash === true;
  const trimmed = String(filename || '').trim();
  if (!trimmed) return trimmed;
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }
  const compacted = decoded
    .replace(/\{width\}x/gi, `${DEFAULT_SHOPIFY_WIDTH_PLACEHOLDER}x`)
    .replace(/\{width\}/gi, DEFAULT_SHOPIFY_WIDTH_PLACEHOLDER)
    .replace(/\s*_\s*/g, '_')
    .trim();
  const aliased = KNOWN_SDCND_FILENAME_ALIASES[compacted.toLowerCase()] || compacted;
  if (!stripHash) {
    return aliased;
  }
  const matched = aliased.match(SHOPIFY_FILE_HASH_SUFFIX_RE);
  if (matched) {
    return `${matched[1]}.${matched[2]}`;
  }
  return aliased;
}

function stripImageTransformQueryParams(parsed) {
  Array.from(parsed.searchParams.keys()).forEach((key) => {
    if (IMAGE_DEDUPE_IGNORED_QUERY_KEYS.has(String(key || '').toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  });
}

function normalizePdpImageUrl(value) {
  const raw = String(value || '').trim();
  if (!isAbsoluteHttpUrl(raw)) return '';

  try {
    let parsed = new URL(raw);
    if (isShopifyLikeAsset(parsed)) {
      stripImageTransformQueryParams(parsed);
      const segments = parsed.pathname.split('/');
      const lastIndex = segments.length - 1;
      segments[lastIndex] = normalizeShopifyLikeFilename(segments[lastIndex] || '', {
        stripHash: false,
      });
      parsed.pathname = segments.join('/');
    }
    parsed = rewriteTomFordAssetToOfficialShopify(parsed);
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
      const filename = normalizeShopifyLikeFilename(parsed.pathname.split('/').pop() || '', {
        stripHash: false,
      });
      if (filename) {
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
        return `asset:${filename.toLowerCase()}${
          normalizedSearch.toString() ? `?${normalizedSearch.toString()}` : ''
        }`;
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
