const ABSOLUTE_HTTP_URL_RE = /^https?:\/\//i;
const SHOPIFY_FILE_HASH_SUFFIX_RE =
  /^(.*?_[0-9]+)_(?:[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}|[0-9a-f-]{16,})\.(avif|gif|jpe?g|png|webp)$/i;
const SHOPIFY_FILE_TRANSFORM_SUFFIX_RE =
  /^(.*?)(?:_[0-9]{2,4}x(?:[0-9]{2,4})?)\.(avif|gif|jpe?g|png|webp)$/i;
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
  'sw',
  'sh',
  'sm',
]);
const KNOWN_SDCND_FILENAME_ALIASES = {
  'tf_sku_t2ss02_3000x3000_0.png': 'tf_sku_T2SS02_3000x3000_1.png',
};
const TOM_FORD_SHOPIFY_FILES_PREFIX = '/s/files/1/0761/9690/5173/files/';
const PIXI_SHOPIFY_FILES_PREFIX = '/s/files/1/1463/5858/files/';
const DEFAULT_SHOPIFY_WIDTH_PLACEHOLDER = '1024';
const MIN_SHOPIFY_DISPLAY_TRANSFORM_EDGE = 800;
const SHOPIFY_CONTENT_PATH_RE = /(?:\/cdn\/shop\/files\/|\/s\/files\/)/i;
const SHOPIFY_PRODUCT_PATH_RE = /\/cdn\/shop\/products\//i;

function pathnameHasSegment(pathname, segment) {
  const normalized = String(pathname || '').trim().toLowerCase();
  const target = String(segment || '').trim().toLowerCase();
  if (!normalized || !target) return false;
  return normalized.split('/').includes(target);
}

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
  const assetKind = classifyShopifyLikeAsset(parsed);
  if (assetKind) return true;
  return isKnownHost(parsed?.hostname, ['cdn.shopify.com', 'shopifycdn.com', 'sdcdn.io']);
}

function classifyShopifyLikeAsset(parsed) {
  const pathname = String(parsed?.pathname || '').trim();
  if (!pathname) return '';
  const isShopifyHost = isKnownHost(parsed?.hostname, ['cdn.shopify.com', 'shopifycdn.com', 'sdcdn.io']);
  const filename = String(pathname.split('/').pop() || '').trim();
  if (SHOPIFY_PRODUCT_PATH_RE.test(pathname) || (isShopifyHost && pathnameHasSegment(pathname, 'products'))) {
    return 'product';
  }
  if (
    (isShopifyHost && pathnameHasSegment(pathname, 'files')) ||
    SHOPIFY_CONTENT_PATH_RE.test(pathname)
  ) {
    if (
      /(?:^|[_-])silo(?:[_-]|\.|$)/i.test(filename) &&
      !/(?:^|[_-])(?:mini|refill|travel|jumbo|trial|sample)(?:[_-]|\.|$)/i.test(filename)
    ) {
      return 'product';
    }
    return 'content';
  }
  return '';
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

function rewritePixiAssetToOfficialShopify(parsed) {
  const pathname = String(parsed?.pathname || '').trim();
  if (!isKnownHost(parsed?.hostname, ['pixibeauty.com'])) {
    return parsed;
  }
  if (!/^\/files\/.+/i.test(pathname)) {
    return parsed;
  }
  const relativePath = pathname.replace(/^\/files\//i, '');
  if (!relativePath) return parsed;
  const rewritten = new URL(`https://cdn.shopify.com${PIXI_SHOPIFY_FILES_PREFIX}${relativePath}`);
  rewritten.search = parsed.search;
  return rewritten;
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

function collapseShopifyTransformSuffixForDedupe(filename) {
  const trimmed = String(filename || '').trim();
  if (!trimmed) return trimmed;
  const matched = trimmed.match(SHOPIFY_FILE_TRANSFORM_SUFFIX_RE);
  if (!matched) return trimmed;
  const base = matched[1];
  const ext = matched[2];
  if (!/(?:^|[_-])[0-9]{2,4}x[0-9]{2,4}(?:[_-]|$)/i.test(base)) {
    return trimmed;
  }
  return `${base}.${ext}`;
}

function collapseSmallShopifyTransformSuffixForDisplay(filename) {
  const trimmed = String(filename || '').trim();
  if (!trimmed) return trimmed;
  const matched = trimmed.match(SHOPIFY_FILE_TRANSFORM_SUFFIX_RE);
  if (!matched) return trimmed;
  const base = matched[1];
  const ext = matched[2];
  const transform = trimmed.match(/_([0-9]{2,4})x([0-9]{2,4})?\.(?:avif|gif|jpe?g|png|webp)$/i);
  const transformLongEdge = Math.max(
    Number(transform?.[1] || 0),
    Number(transform?.[2] || transform?.[1] || 0),
  );
  if (!Number.isFinite(transformLongEdge) || transformLongEdge >= MIN_SHOPIFY_DISPLAY_TRANSFORM_EDGE) {
    return trimmed;
  }
  if (!/(?:^|[_-])[0-9]{3,4}x[0-9]{3,4}(?:[_-]|$)/i.test(base)) {
    return trimmed;
  }
  return `${base}.${ext}`;
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
    if (String(parsed.hostname || '').trim().toLowerCase() === 'files') {
      return '';
    }
    if (parsed.protocol === 'http:' && isShopifyLikeAsset(parsed)) {
      parsed.protocol = 'https:';
    }
    parsed = rewritePixiAssetToOfficialShopify(parsed);
    if (isShopifyLikeAsset(parsed)) {
      stripImageTransformQueryParams(parsed);
      const segments = parsed.pathname.split('/');
      const lastIndex = segments.length - 1;
      segments[lastIndex] = normalizeShopifyLikeFilename(segments[lastIndex] || '', {
        stripHash: false,
      });
      segments[lastIndex] = collapseSmallShopifyTransformSuffixForDisplay(segments[lastIndex]);
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

// Memo for buildPdpImageDedupeKey.
//
// The key is a PURE function of its input string — it parses into a fresh URL,
// builds a local URLSearchParams and returns a string, mutating nothing — so
// caching by exact input is output-identical by construction.
//
// WHY (2026-07-26): appendImageUrls in services/externalSeedProducts.js dedupes
// with `out.some(existing => buildPdpImageDedupeKey(existing) === key)`, which
// RECOMPUTES this key for every element of the accumulating gallery on every
// incoming URL — O(n*m) calls of a ~15us function. External seeds make that
// explode, because every variant carries an identical copy of the whole product
// image list: the three Tom Ford PDPs that were serving 500s feed 7,276 image
// URLs of which only 165 are DISTINCT (redundancy is exactly the variant count:
// 40 variants => 40.0x). 7,276 x ~165 accumulated ~= 1.2M expensive calls, which
// measured at ~18-20s locally and ~7.8s in prod — inside a request whose
// frontend budget is 9s.
//
// Bounded so a long-lived process cannot grow it without limit; eviction is
// oldest-first via Map insertion order.
const PDP_IMAGE_DEDUPE_KEY_CACHE = new Map();
const PDP_IMAGE_DEDUPE_KEY_CACHE_MAX_ENTRIES = Math.max(
  1000,
  Number(process.env.PDP_IMAGE_DEDUPE_KEY_CACHE_MAX_ENTRIES || 20000) || 20000,
);

function buildPdpImageDedupeKey(value) {
  // Only memoize string inputs. Objects are rare here and are not safe map keys
  // by identity, so they fall through to the uncached path unchanged.
  if (typeof value !== 'string') return computePdpImageDedupeKey(value);

  const cached = PDP_IMAGE_DEDUPE_KEY_CACHE.get(value);
  if (cached !== undefined) return cached;

  const computed = computePdpImageDedupeKey(value);
  if (PDP_IMAGE_DEDUPE_KEY_CACHE.size >= PDP_IMAGE_DEDUPE_KEY_CACHE_MAX_ENTRIES) {
    const oldest = PDP_IMAGE_DEDUPE_KEY_CACHE.keys().next().value;
    if (oldest !== undefined) PDP_IMAGE_DEDUPE_KEY_CACHE.delete(oldest);
  }
  PDP_IMAGE_DEDUPE_KEY_CACHE.set(value, computed);
  return computed;
}

function computePdpImageDedupeKey(value) {
  const normalized = normalizePdpImageUrl(value);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    if (isShopifyLikeAsset(parsed)) {
      const filename = collapseShopifyTransformSuffixForDedupe(
        normalizeShopifyLikeFilename(parsed.pathname.split('/').pop() || '', {
          stripHash: false,
        }),
      );
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
  classifyShopifyLikeAsset,
  normalizePdpImageUrl,
  normalizePdpImageUrls,
};
