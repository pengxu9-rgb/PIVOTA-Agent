const axios = require('axios');
const sharp = require('sharp');

const { ensureJsonObject } = require('./externalSeedProducts');
const { sha256Buffer } = require('./catalogImageCacheStorage');

const IMAGE_ASSET_CACHE_CONTRACT_VERSION = 'external_seed.image_asset_cache.v1';
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

const SAFE_ORIGINAL_IMAGE_HOSTS = [
  'cdn.shopify.com',
  'shopifycdn.com',
  'images.unsplash.com',
  'web-production-fedb.up.railway.app',
  'pivota-agent-production.up.railway.app',
];

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeUrlLike(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!/^https?:\/\//i.test(normalized)) return '';
  try {
    return new URL(normalized).toString();
  } catch {
    return '';
  }
}

function sourceHostFromUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isKnownRemoteHost(hostname, candidates) {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) return false;
  return candidates.some((candidate) => normalized === candidate || normalized.endsWith(`.${candidate}`));
}

function isSafeOriginalImageUrl(value) {
  const url = normalizeUrlLike(value);
  if (!url) return false;
  const host = sourceHostFromUrl(url);
  return isKnownRemoteHost(host, SAFE_ORIGINAL_IMAGE_HOSTS);
}

function isDemandwareImageUrl(value) {
  const url = normalizeUrlLike(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname.toLowerCase().includes('/dw/image/');
  } catch {
    return false;
  }
}

function shouldCacheOriginalImageUrl(value, options = {}) {
  if (options.forceCache) return true;
  const url = normalizeUrlLike(value);
  if (!url) return false;
  if (isSafeOriginalImageUrl(url)) return false;
  if (isDemandwareImageUrl(url)) return true;
  const host = sourceHostFromUrl(url);
  if (host.includes('sdcdn.io')) return false;
  return true;
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = normalizeUrlLike(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function collectImageUrlsFromValue(value, out, fieldPath) {
  if (!value) return;
  if (typeof value === 'string') {
    const url = normalizeUrlLike(value);
    if (url) out.push({ url, field_path: fieldPath });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => collectImageUrlsFromValue(item, out, `${fieldPath}[${idx}]`));
    return;
  }
  if (typeof value !== 'object') return;
  const typed = value;
  [
    ['url', typed.url],
    ['src', typed.src],
    ['image', typed.image],
    ['image_url', typed.image_url],
    ['imageUrl', typed.imageUrl],
    ['label_image_url', typed.label_image_url],
    ['labelImageUrl', typed.labelImageUrl],
    ['swatch_image_url', typed.swatch_image_url],
    ['swatchImageUrl', typed.swatchImageUrl],
    ['thumbnail_url', typed.thumbnail_url],
    ['thumbnailUrl', typed.thumbnailUrl],
    ['primary_image_url', typed.primary_image_url],
    ['primaryImageUrl', typed.primaryImageUrl],
  ].forEach(([key, candidate]) => collectImageUrlsFromValue(candidate, out, `${fieldPath}.${key}`));
  [
    ['images', typed.images],
    ['image_urls', typed.image_urls],
    ['media', typed.media],
    ['gallery', typed.gallery],
    ['variants', typed.variants],
    ['preview_items', typed.preview_items],
    ['line_preview_images', typed.line_preview_images],
  ].forEach(([key, candidate]) => collectImageUrlsFromValue(candidate, out, `${fieldPath}.${key}`));
}

function collectExternalSeedImageCandidates(row) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const raw = [];
  [
    ['row.image_url', row?.image_url],
    ['seed_data.image_url', seedData.image_url],
    ['seed_data.image_urls', seedData.image_urls],
    ['seed_data.images', seedData.images],
    ['seed_data.media', seedData.media],
    ['seed_data.variants', seedData.variants],
    ['seed_data.line_preview_images', seedData.line_preview_images],
    ['snapshot.image_url', snapshot.image_url],
    ['snapshot.image_urls', snapshot.image_urls],
    ['snapshot.images', snapshot.images],
    ['snapshot.media', snapshot.media],
    ['snapshot.variants', snapshot.variants],
    ['snapshot.line_preview_images', snapshot.line_preview_images],
  ].forEach(([fieldPath, value]) => collectImageUrlsFromValue(value, raw, fieldPath));

  const byUrl = new Map();
  raw.forEach((candidate) => {
    const existing = byUrl.get(candidate.url) || {
      url: candidate.url,
      source_host: sourceHostFromUrl(candidate.url),
      field_paths: [],
    };
    if (candidate.field_path && !existing.field_paths.includes(candidate.field_path)) {
      existing.field_paths.push(candidate.field_path);
    }
    byUrl.set(candidate.url, existing);
  });
  return Array.from(byUrl.values());
}

function statusFromHttpFailure(status) {
  const n = Number(status || 0);
  if (n === 404 || n === 410) return { status: 'stale_404', reason: 'stale_404' };
  if ([401, 403, 429, 500, 502, 503, 504].includes(n)) {
    return { status: 'server_fetch_blocked', reason: `http_${n}` };
  }
  return { status: 'fetch_failed', reason: n ? `http_${n}` : 'request_failed' };
}

function classifyImageFetchResult(result) {
  const url = normalizeUrlLike(result?.url);
  if (!url) {
    return {
      url: result?.url || '',
      ok: false,
      status: 'invalid_url',
      reason_codes: ['invalid_url'],
      fetch_method: result?.fetch_method || null,
    };
  }
  if (result?.error) {
    return {
      ...result,
      url,
      ok: false,
      status: result.error === 'browser_fetch_unavailable' ? 'browser_fetch_unavailable' : 'fetch_failed',
      reason_codes: [String(result.error)],
    };
  }
  const httpStatus = Number(result?.http_status || 0);
  const contentType = normalizeNonEmptyString(result?.content_type).toLowerCase();
  if (!(httpStatus >= 200 && httpStatus < 400)) {
    const failed = statusFromHttpFailure(httpStatus);
    return {
      ...result,
      url,
      ok: false,
      status: failed.status,
      reason_codes: [failed.reason],
    };
  }
  if (!contentType.includes('image/')) {
    return {
      ...result,
      url,
      ok: false,
      status: 'invalid_content_type',
      reason_codes: ['invalid_content_type'],
    };
  }
  const bytes = Number(result?.bytes || 0);
  if (bytes > 0 && bytes < 768) {
    return {
      ...result,
      url,
      ok: false,
      status: 'too_small_or_placeholder',
      reason_codes: ['too_small_or_placeholder'],
    };
  }
  return {
    ...result,
    url,
    ok: true,
    status: result?.fetch_method === 'browser' ? 'browser_fetch_ok' : 'direct_fetch_ok',
    reason_codes: [],
  };
}

async function readImageDimensions(body) {
  try {
    const meta = await sharp(body).metadata();
    return {
      width: Number.isFinite(meta.width) ? meta.width : null,
      height: Number.isFinite(meta.height) ? meta.height : null,
    };
  } catch {
    return { width: null, height: null };
  }
}

async function fetchImageDirect(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.CATALOG_IMAGE_CACHE_FETCH_TIMEOUT_MS || 8000);
  const maxBytes = Number(options.maxBytes || process.env.CATALOG_IMAGE_CACHE_MAX_BYTES || DEFAULT_MAX_BYTES);
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxContentLength: maxBytes,
      validateStatus: () => true,
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent':
          options.userAgent ||
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...(options.sourceUrl ? { Referer: options.sourceUrl } : {}),
      },
    });
    const body = Buffer.from(response.data || []);
    const dimensions = response.status >= 200 && response.status < 400 ? await readImageDimensions(body) : {};
    return classifyImageFetchResult({
      url,
      fetch_method: 'direct',
      http_status: Number(response.status || 0),
      content_type: normalizeNonEmptyString(response.headers?.['content-type']).toLowerCase(),
      bytes: body.length,
      body,
      sha256: body.length ? sha256Buffer(body) : null,
      width: dimensions.width || null,
      height: dimensions.height || null,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    return classifyImageFetchResult({
      url,
      fetch_method: 'direct',
      error: normalizeNonEmptyString(error?.code || error?.message || 'request_failed'),
    });
  }
}

async function fetchImageWithBrowser(url, options = {}) {
  let chromium;
  try {
    // Optional dependency: installed in environments that need browser-mode capture.
    // eslint-disable-next-line global-require
    chromium = require('playwright').chromium;
  } catch {
    return classifyImageFetchResult({
      url,
      fetch_method: 'browser',
      error: 'browser_fetch_unavailable',
    });
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        options.userAgent ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    if (options.sourceUrl) {
      await page.goto(options.sourceUrl, {
        waitUntil: 'domcontentloaded',
        timeout: Number(options.timeoutMs || 12000),
      }).catch(() => null);
    }
    const payload = await page.evaluate(async (target) => {
      function bytesToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode(...chunk);
        }
        return btoa(binary);
      }
      const response = await fetch(target, {
        credentials: 'include',
        headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
      });
      const contentType = response.headers.get('content-type') || '';
      const arrayBuffer = await response.arrayBuffer();
      return {
        http_status: response.status,
        content_type: contentType,
        bytes_base64: bytesToBase64(new Uint8Array(arrayBuffer)),
      };
    }, url);
    const body = Buffer.from(payload.bytes_base64 || '', 'base64');
    const dimensions = payload.http_status >= 200 && payload.http_status < 400 ? await readImageDimensions(body) : {};
    return classifyImageFetchResult({
      url,
      fetch_method: 'browser',
      http_status: Number(payload.http_status || 0),
      content_type: normalizeNonEmptyString(payload.content_type).toLowerCase(),
      bytes: body.length,
      body,
      sha256: body.length ? sha256Buffer(body) : null,
      width: dimensions.width || null,
      height: dimensions.height || null,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    return classifyImageFetchResult({
      url,
      fetch_method: 'browser',
      error: normalizeNonEmptyString(error?.code || error?.message || 'browser_fetch_failed'),
    });
  } finally {
    await browser.close().catch(() => null);
  }
}

// Patterns for recovering current product image URLs from a canonical
// page when the stored image_url candidates have all 404'd. Most beauty
// retailers expose either Open Graph metadata, Twitter cards, or
// schema.org Product.image — checking all three covers the main cases.
const _RECOVERY_OG_IMAGE_RE = /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i;
const _RECOVERY_OG_IMAGE_REVERSED_RE = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i;
const _RECOVERY_TWITTER_IMAGE_RE = /<meta[^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i;
const _RECOVERY_JSONLD_IMAGE_STRING_RE = /"image"\s*:\s*"([^"]+)"/g;
const _RECOVERY_JSONLD_IMAGE_ARRAY_RE = /"image"\s*:\s*\[\s*"([^"]+)"/g;


/**
 * Recover current image URLs for a product by fetching its canonical
 * page and parsing meta tags / JSON-LD. Used when every stored image
 * URL on a row has 404'd (Tom Ford CDN rotation pattern).
 *
 * Returns a deduped list of HTTP(S) URL strings; never throws (fetch
 * failures yield an empty list so the caller can degrade gracefully).
 *
 * @param {string} canonicalUrl - The merchant's canonical product URL.
 * @param {object} [options]
 * @param {number} [options.timeoutMs=8000]
 * @param {string} [options.userAgent]
 * @returns {Promise<string[]>}
 */
async function recoverImageUrlsFromCanonicalPage(canonicalUrl, options = {}) {
  const url = normalizeUrlLike(canonicalUrl);
  if (!url) return [];
  const timeoutMs = Number(options.timeoutMs || 8000);
  let html = '';
  try {
    const response = await axios.get(url, {
      timeout: timeoutMs,
      maxContentLength: 4 * 1024 * 1024,
      validateStatus: () => true,
      responseType: 'text',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent':
          options.userAgent ||
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    if (response.status >= 400) return [];
    html = String(response.data || '');
  } catch {
    return [];
  }
  if (!html) return [];

  const out = [];
  const pushUnique = (raw) => {
    const normalized = normalizeUrlLike(raw);
    if (!normalized) return;
    if (!out.includes(normalized)) out.push(normalized);
  };

  // og:image (and the reversed-attribute order some sites emit)
  const ogMatch = html.match(_RECOVERY_OG_IMAGE_RE) || html.match(_RECOVERY_OG_IMAGE_REVERSED_RE);
  if (ogMatch) pushUnique(ogMatch[1]);

  // twitter:image / twitter:image:src
  const twitterMatch = html.match(_RECOVERY_TWITTER_IMAGE_RE);
  if (twitterMatch) pushUnique(twitterMatch[1]);

  // schema.org Product.image — string OR first element of array.
  // Use global regex iteration to handle multiple Product blocks.
  let m;
  _RECOVERY_JSONLD_IMAGE_ARRAY_RE.lastIndex = 0;
  while ((m = _RECOVERY_JSONLD_IMAGE_ARRAY_RE.exec(html)) !== null) {
    pushUnique(m[1]);
  }
  _RECOVERY_JSONLD_IMAGE_STRING_RE.lastIndex = 0;
  while ((m = _RECOVERY_JSONLD_IMAGE_STRING_RE.exec(html)) !== null) {
    pushUnique(m[1]);
  }

  return out;
}


async function fetchImageForCache(url, options = {}) {
  const normalized = normalizeUrlLike(url);
  if (!normalized) return classifyImageFetchResult({ url, error: 'invalid_url' });
  const mode = String(options.fetchMode || 'auto').trim().toLowerCase();
  if (mode === 'browser') return fetchImageWithBrowser(normalized, options);
  const direct = await fetchImageDirect(normalized, options);
  if (mode === 'direct') return direct;
  if (direct.ok || !['server_fetch_blocked', 'fetch_failed'].includes(direct.status)) return direct;
  const browser = await fetchImageWithBrowser(normalized, options);
  return browser.ok ? browser : direct;
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function summarizeAssetCheckForContract(candidate, check) {
  return {
    original_url: candidate.url,
    source_host: candidate.source_host || sourceHostFromUrl(candidate.url),
    status: check?.status || 'unchecked',
    reason_codes: Array.isArray(check?.reason_codes) ? check.reason_codes : [],
    cached_url: normalizeUrlLike(check?.cached_url) || null,
    sha256: check?.sha256 || null,
    content_type: check?.content_type || null,
    bytes: Number.isFinite(Number(check?.bytes)) ? Number(check.bytes) : null,
    width: Number.isFinite(Number(check?.width)) ? Number(check.width) : null,
    height: Number.isFinite(Number(check?.height)) ? Number(check.height) : null,
    fetched_at: check?.fetched_at || null,
    fetch_method: check?.fetch_method || null,
    field_paths: candidate.field_paths || [],
  };
}

function buildImageAssetBackfillPlanForRow(row, checksByUrl, options = {}) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const quarantine = ensureJsonObject(seedData.snapshot_quarantine);
  const candidates = collectExternalSeedImageCandidates(row);
  const visible = [];
  const assets = [];
  const quarantineAssets = [];

  for (const candidate of candidates) {
    const check = checksByUrl[candidate.url] || { status: 'unchecked', reason_codes: ['unchecked'] };
    const cachedUrl = normalizeUrlLike(check.cached_url);
    const shouldCache = shouldCacheOriginalImageUrl(candidate.url, options);
    const canUseOriginal = check.ok && isSafeOriginalImageUrl(candidate.url) && !shouldCache;
    const assetSummary = summarizeAssetCheckForContract(candidate, check);

    if (cachedUrl) {
      visible.push(cachedUrl);
      assets.push({ ...assetSummary, cached_url: cachedUrl, visible_url: cachedUrl });
      continue;
    }
    if (canUseOriginal) {
      visible.push(candidate.url);
      assets.push({ ...assetSummary, visible_url: candidate.url });
      continue;
    }

    const reasonCodes = Array.isArray(check.reason_codes) && check.reason_codes.length
      ? check.reason_codes
      : [check.status || 'not_surfaceable'];
    quarantineAssets.push({
      ...assetSummary,
      reason_codes: shouldCache && check.ok
        ? Array.from(new Set([...reasonCodes, 'cache_required_missing_cached_url']))
        : reasonCodes,
    });
  }

  const visibleImageUrls = uniqueStrings(visible);
  const nextSeedData = {
    ...cloneJsonValue(seedData),
    image_asset_cache_v1: {
      contract_version: IMAGE_ASSET_CACHE_CONTRACT_VERSION,
      generated_at: new Date().toISOString(),
      visible_image_urls: visibleImageUrls,
      assets,
      quarantine_count: quarantineAssets.length,
    },
    snapshot: {
      ...cloneJsonValue(snapshot),
      image_asset_cache_v1: {
        contract_version: IMAGE_ASSET_CACHE_CONTRACT_VERSION,
        visible_image_urls: visibleImageUrls,
        assets,
        quarantine_count: quarantineAssets.length,
      },
      ...(visibleImageUrls.length
        ? {
            image_url: visibleImageUrls[0],
            image_urls: visibleImageUrls,
            images: visibleImageUrls,
          }
        : {
            image_url: '',
            image_urls: [],
            images: [],
          }),
    },
    snapshot_quarantine: {
      ...cloneJsonValue(quarantine),
      image_assets: quarantineAssets,
    },
  };
  if (visibleImageUrls.length) {
    nextSeedData.image_url = visibleImageUrls[0];
    nextSeedData.image_urls = visibleImageUrls;
    nextSeedData.images = visibleImageUrls;
  } else {
    delete nextSeedData.image_url;
    nextSeedData.image_urls = [];
    nextSeedData.images = [];
  }

  const changed = JSON.stringify(seedData) !== JSON.stringify(nextSeedData);
  return {
    seed_id: row?.id ? String(row.id) : null,
    external_product_id: row?.external_product_id || seedData.external_product_id || snapshot.external_product_id || null,
    changed,
    visible_image_urls: visibleImageUrls,
    asset_count: assets.length,
    quarantine_count: quarantineAssets.length,
    assets,
    quarantine_assets: quarantineAssets,
    next_seed_data: nextSeedData,
  };
}

module.exports = {
  IMAGE_ASSET_CACHE_CONTRACT_VERSION,
  SAFE_ORIGINAL_IMAGE_HOSTS,
  buildImageAssetBackfillPlanForRow,
  classifyImageFetchResult,
  collectExternalSeedImageCandidates,
  fetchImageForCache,
  isSafeOriginalImageUrl,
  recoverImageUrlsFromCanonicalPage,
  shouldCacheOriginalImageUrl,
  sourceHostFromUrl,
};
