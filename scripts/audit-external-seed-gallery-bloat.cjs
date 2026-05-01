#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  fetchRows,
  invokeGatewayProbe,
  resolveGatewayUrl,
  unwrapLivePdpPayload,
} = require('./audit-external-product-pdp-quality');
const { buildPdpImageDedupeKey, normalizePdpImageUrl } = require('../src/utils/pdpImageUrls');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseExternalProductIds(raw) {
  return Array.from(
    new Set(
      String(raw || '')
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function readExternalProductIdsFromArgs() {
  const inline = parseExternalProductIds(argValue('external-product-ids') || argValue('externalProductIds'));
  const filePath = argValue('external-product-ids-file') || argValue('externalProductIdsFile');
  if (!filePath) return inline;
  const fromFile = parseExternalProductIds(fs.readFileSync(path.resolve(filePath), 'utf8'));
  return Array.from(new Set([...inline, ...fromFile]));
}

function buildMediaDedupeKey(value) {
  const url = normalizePdpImageUrl(
    typeof value === 'string' ? value : value?.url || value?.image_url || value?.src,
  );
  return buildPdpImageDedupeKey(url) || String(url || '').toLowerCase();
}

function imageFilenameFamilyKey(value) {
  const url = normalizePdpImageUrl(
    typeof value === 'string' ? value : value?.url || value?.image_url || value?.src,
  );
  if (!url) return '';
  try {
    const parsed = new URL(url);
    let filename = String(parsed.pathname.split('/').pop() || '').toLowerCase();
    filename = filename.replace(/\.[a-z0-9]+$/i, '');
    filename = filename.replace(/_[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}$/i, '');
    const tokens = filename
      .split(/[_\-\s]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    return tokens[0] || filename;
  } catch {
    return '';
  }
}

function countValues(items, valueFn) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = normalizeNonEmptyString(valueFn(item));
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] === a[1]) return a[0].localeCompare(b[0]);
      return b[1] - a[1];
    })
    .map(([key, count]) => ({ key, count }));
}

function extractGalleryStats(livePayload = {}) {
  const product = livePayload?.product && typeof livePayload.product === 'object' ? livePayload.product : {};
  const mediaGallery = Array.isArray(livePayload?.modules)
    ? livePayload.modules.find((module) => module?.type === 'media_gallery')
    : null;
  const productImageUrls = Array.isArray(product.image_urls) ? product.image_urls : [];
  const mediaItems = Array.isArray(mediaGallery?.data?.items) ? mediaGallery.data.items : [];

  const uniqueProductImageKeys = new Set(
    productImageUrls.map((item) => buildMediaDedupeKey(item)).filter(Boolean),
  );
  const uniqueMediaItemKeys = new Set(
    mediaItems.map((item) => buildMediaDedupeKey(item)).filter(Boolean),
  );
  const sourceCounts = countValues(mediaItems, (item) => item?.source || '__none__');
  const sourceKindCounts = countValues(mediaItems, (item) => item?.source_kind || '__none__');
  const familyCounts = countValues(mediaItems, (item) => imageFilenameFamilyKey(item)).slice(0, 10);
  const topFamily = familyCounts[0] || null;

  return {
    product_image_urls_count: productImageUrls.length,
    product_image_urls_unique_count: uniqueProductImageKeys.size,
    media_gallery_count: mediaItems.length,
    media_gallery_unique_count: uniqueMediaItemKeys.size,
    exact_duplicate_count: Math.max(0, mediaItems.length - uniqueMediaItemKeys.size),
    source_counts: sourceCounts,
    source_kind_counts: sourceKindCounts,
    filename_family_counts: familyCounts,
    top_family_count: topFamily?.count || 0,
    top_family_key: topFamily?.key || null,
    gallery_scope: normalizeNonEmptyString(product.gallery_scope || mediaGallery?.data?.gallery_scope) || null,
    preview_scope: normalizeNonEmptyString(product.preview_scope || mediaGallery?.data?.preview_scope) || null,
    sample_urls: mediaItems.slice(0, 8).map((item) => normalizePdpImageUrl(item?.url || item?.image_url || item?.src)).filter(Boolean),
  };
}

function classifyGalleryIssue(stats = {}, { minGalleryItems = 40, extremeGalleryItems = 80, repeatedFamilyMin = 12 } = {}) {
  const galleryCount = Number(stats.media_gallery_count || 0);
  const topFamilyCount = Number(stats.top_family_count || 0);
  if (galleryCount >= extremeGalleryItems) return 'gallery_bloat_extreme';
  if (galleryCount >= minGalleryItems) return 'gallery_bloat';
  if (topFamilyCount >= repeatedFamilyMin) return 'gallery_family_repetition';
  return 'ok';
}

async function fetchLivePayload(productId, gatewayUrl, timeoutMs) {
  const response = await invokeGatewayProbe(
    gatewayUrl,
    'get_pdp_v2',
    {
      product_id: productId,
      include: ['canonical', 'product_intel', 'reviews_preview', 'variant_selector', 'offers'],
      options: { debug: true, no_cache: true, cache_bypass: true, similar_cache_bypass: true },
    },
    { timeoutMs, probe: 'gallery_bloat_audit' },
  );
  return {
    response,
    livePayload: unwrapLivePdpPayload(response) || {},
  };
}

async function main() {
  const market = normalizeNonEmptyString(argValue('market') || 'US').toUpperCase();
  const brand = normalizeNonEmptyString(argValue('brand'));
  const domain = normalizeNonEmptyString(argValue('domain'));
  const externalProductIds = readExternalProductIdsFromArgs();
  const limit = parsePositiveInt(argValue('limit'), 20, 1, 500);
  const offset = parsePositiveInt(argValue('offset'), 0, 0, 1000000);
  const threshold = parsePositiveInt(argValue('min-gallery-items'), 40, 5, 500);
  const extremeThreshold = parsePositiveInt(argValue('extreme-gallery-items'), 80, threshold, 1000);
  const repeatedFamilyMin = parsePositiveInt(argValue('repeated-family-min'), 12, 2, 1000);
  const gatewayUrl = resolveGatewayUrl(argValue('gateway-url') || argValue('gateway'));
  const timeoutMs = parsePositiveInt(argValue('timeout-ms'), 30000, 1000, 300000);
  const outPath = path.resolve(
    argValue('out') ||
      `/Users/pengchydan/dev/PIVOTA-Agent/reports/k_beauty_seed_expansion_20260429/gallery_bloat_audit_${(brand || domain || market || 'all').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}.json`,
  );

  let rows;
  if (externalProductIds.length) {
    rows = externalProductIds.map((external_product_id) => ({ external_product_id, market, seed_data: {} }));
  } else {
    rows = await fetchRows({
      market,
      seedId: '',
      externalProductId: '',
      domain,
      brand,
      limit,
      offset,
    });
  }

  const results = [];
  for (const row of rows) {
    const externalProductId = normalizeNonEmptyString(row.external_product_id);
    if (!externalProductId) continue;
    const { response, livePayload } = await fetchLivePayload(externalProductId, gatewayUrl, timeoutMs);
    const stats = extractGalleryStats(livePayload);
    const issueType = classifyGalleryIssue(stats, {
      minGalleryItems: threshold,
      extremeGalleryItems: extremeThreshold,
      repeatedFamilyMin,
    });
    const failure = response?.status === 'error' ? response?.error || {} : null;
    results.push({
      external_product_id: externalProductId,
      market: normalizeNonEmptyString(row.market || market) || market,
      brand: normalizeNonEmptyString(row.seed_data?.brand || row.seed_data?.snapshot?.brand || row.brand),
      title: normalizeNonEmptyString(row.title || livePayload?.product?.title),
      canonical_url: normalizeNonEmptyString(row.canonical_url || row.destination_url || livePayload?.product?.canonical_url),
      status: issueType === 'ok' ? 'ok' : 'review',
      anomaly_type: issueType === 'ok' ? null : issueType,
      live_probe_error: failure,
      gallery_stats: stats,
    });
  }

  const flagged = results.filter((row) => row.anomaly_type);
  const report = {
    generated_at: new Date().toISOString(),
    market,
    brand: brand || null,
    domain: domain || null,
    scanned_rows: results.length,
    threshold,
    extreme_threshold: extremeThreshold,
    repeated_family_min: repeatedFamilyMin,
    flagged_count: flagged.length,
    flagged_by_type: flagged.reduce((acc, row) => {
      acc[row.anomaly_type] = (acc[row.anomaly_type] || 0) + 1;
      return acc;
    }, {}),
    results,
  };

  ensureParentDir(outPath);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        out: outPath,
        scanned_rows: report.scanned_rows,
        flagged_count: report.flagged_count,
        flagged_by_type: report.flagged_by_type,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error?.code || error?.name || 'gallery_bloat_audit_failed',
          message: error?.message || String(error),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  });
}

module.exports = {
  parseExternalProductIds,
  imageFilenameFamilyKey,
  extractGalleryStats,
  classifyGalleryIssue,
};
