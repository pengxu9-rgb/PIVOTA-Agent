#!/usr/bin/env node

const axios = require('axios');
const { query, withClient } = require('../src/db');
const { lookupExternalSeedImageOverride } = require('../src/services/externalSeedImageOverrides');
const {
  ensureJsonObject,
  collectSeedImageUrls,
  normalizeSeedImageUrls,
  normalizeSeedVariants,
  normalizeSeedAvailability,
} = require('../src/services/externalSeedProducts');

const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';
const MARKET_LOCALE_SEGMENT = {
  US: 'en-us',
  'EU-DE': 'de-de',
  SG: 'en-sg',
  JP: 'ja-jp',
};

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeNonEmptyString(value) {
  const next = String(value || '').trim();
  return next || '';
}

function normalizeUrlLike(value) {
  const next = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(next) ? next : '';
}

function normalizeUrlKey(value) {
  return normalizeUrlLike(value).replace(/\/+$/, '').toLowerCase();
}

const LOCALE_PATH_SEGMENT_RE = /^[a-z]{2}(?:-|_)[a-z]{2}$/i;
const NON_PRODUCT_PATH_RE =
  /(?:^|\/)(?:collections?|collection|category|catalogsearch|search|cart|account|customer|blog|blogs|pages?|faq|privacy|terms|wishlist|gift(?:ing)?|store-locator|customer-service|all-products|appointments?|booking|online-booking|locations?|contact-us)(?:\/|$)/i;

function normalizeComparableUrlKey(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] && LOCALE_PATH_SEGMENT_RE.test(segments[0])) segments.shift();
    parsed.pathname = `/${segments.join('/')}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return normalizeUrlKey(normalized);
  }
}

function looksLikeDirectProductTargetUrl(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return false;

  try {
    const parsed = new URL(normalized);
    const path = parsed.pathname.toLowerCase();
    if (path === '/' || path === '') return false;
    if (NON_PRODUCT_PATH_RE.test(path)) return false;
    if (/\/products?\//.test(path) || /\/p\/[^/]+$/.test(path) || /\.html$/.test(path)) return true;
    const lastSegment = path.split('/').filter(Boolean).pop() || '';
    const hyphenCount = (lastSegment.match(/-/g) || []).length;
    return hyphenCount >= 2;
  } catch {
    return false;
  }
}

function looksLikeKnownNonProductUrl(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return false;

  try {
    const parsed = new URL(normalized);
    const path = parsed.pathname.toLowerCase();
    return NON_PRODUCT_PATH_RE.test(path) || /(?:^|\/)contact-us(?:\.html)?(?:\/|$)/i.test(path);
  } catch {
    return false;
  }
}

function uniqueStrings(values) {
  const out = [];
  for (const value of values) {
    const next = normalizeNonEmptyString(value);
    if (!next || out.includes(next)) continue;
    out.push(next);
  }
  return out;
}

function buildExtractRequestBody(targetUrl, row) {
  const requestBody = {
    brand:
      normalizeNonEmptyString(
        ensureJsonObject(row?.seed_data).brand || row?.title || row?.domain || row?.external_product_id || row?.id,
      ) || row?.id,
    domain: targetUrl,
    limit: 50,
  };

  const market = normalizeNonEmptyString(row?.market);
  if (market) requestBody.market = market.toUpperCase();
  return requestBody;
}

function normalizeTargetUrlForMarket(value, market) {
  const normalized = normalizeUrlLike(value);
  const localeSegment = MARKET_LOCALE_SEGMENT[normalizeNonEmptyString(market).toUpperCase()];
  if (!normalized || !localeSegment) return normalized;

  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (!segments[0] || !LOCALE_PATH_SEGMENT_RE.test(segments[0])) return parsed.toString();
    if (segments[0].toLowerCase() === localeSegment) return parsed.toString();
    segments[0] = localeSegment;
    parsed.pathname = `/${segments.join('/')}${parsed.pathname.endsWith('/') ? '/' : ''}`;
    return parsed.toString();
  } catch {
    return normalized;
  }
}

function parsePrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = normalizeNonEmptyString(value);
  if (!raw) return null;
  const parsed = Number(raw.replace(/[^0-9.-]+/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function recoverTargetUrlFromDiagnostics(row) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const trace = Array.isArray(snapshot?.diagnostics?.http_trace) ? snapshot.diagnostics.http_trace : [];

  for (const entry of trace) {
    const url = normalizeUrlLike(entry?.url);
    if (!url) continue;
    if (looksLikeKnownNonProductUrl(url)) continue;
    if (looksLikeDirectProductTargetUrl(url)) return url;
  }

  return '';
}

function pickSeedTargetUrl(row) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const currentUrl = normalizeUrlLike(row?.canonical_url || row?.destination_url);
  const recoveredUrl =
    looksLikeKnownNonProductUrl(currentUrl) || !currentUrl ? recoverTargetUrlFromDiagnostics(row) : '';
  if (recoveredUrl) return recoveredUrl;
  const candidates = [
    row?.canonical_url,
    row?.destination_url,
    seedData.canonical_url,
    seedData.destination_url,
    snapshot.canonical_url,
    snapshot.destination_url,
    row?.domain ? `https://${row.domain}` : '',
  ];

  return candidates.map(normalizeUrlLike).find(Boolean) || '';
}

function chooseRepresentativeProduct(response, targetUrl, row) {
  const products = Array.isArray(response?.products) ? response.products : [];
  if (!products.length) return null;

  const rawCandidates = [
    targetUrl,
    row?.canonical_url,
    row?.destination_url,
    ensureJsonObject(row?.seed_data).canonical_url,
    ensureJsonObject(row?.seed_data).snapshot?.canonical_url,
  ].filter(Boolean);

  const candidateKeys = new Set(
    rawCandidates
      .map(normalizeUrlKey)
      .filter(Boolean),
  );
  const comparableKeys = new Set(
    [
      ...rawCandidates,
    ]
      .map(normalizeComparableUrlKey)
      .filter(Boolean),
  );

  for (const product of products) {
    const productKey = normalizeUrlKey(product?.url);
    const comparableProductKey = normalizeComparableUrlKey(product?.url);
    if (candidateKeys.has(productKey) || comparableKeys.has(comparableProductKey)) return product;
  }

  if (looksLikeDirectProductTargetUrl(targetUrl)) return null;
  return products[0];
}

function mapSnapshotVariants(product, response, existingSeedData) {
  const responseVariants = Array.isArray(response?.variants) ? response.variants : [];
  const representativeVariants =
    Array.isArray(product?.variants) && product.variants.length > 0
      ? product.variants
      : product?.url
        ? responseVariants.filter(
            (variant) => normalizeUrlKey(variant?.product_url || variant?.url) === normalizeUrlKey(product?.url),
          )
        : responseVariants;

  const mapped = representativeVariants
    .map((variant, idx) => {
      if (!variant || typeof variant !== 'object') return null;
      const imageUrls = uniqueStrings([...(Array.isArray(variant.image_urls) ? variant.image_urls : []), variant.image_url]);
      const sku = normalizeNonEmptyString(variant.sku || variant.sku_id || variant.id || `variant-${idx + 1}`);
      return {
        sku,
        variant_id: normalizeNonEmptyString(variant.id || variant.variant_id || sku),
        url: normalizeUrlLike(variant.url || variant.product_url),
        option_name: normalizeNonEmptyString(variant.option_name),
        option_value: normalizeNonEmptyString(variant.option_value),
        price: normalizeNonEmptyString(variant.price),
        currency: normalizeNonEmptyString(variant.currency),
        stock: normalizeNonEmptyString(variant.stock),
        image_url: imageUrls[0] || '',
        image_urls: imageUrls,
        description: normalizeNonEmptyString(variant.description),
      };
    })
    .filter(Boolean);

  if (mapped.length > 0) return mapped;
  return normalizeSeedVariants(existingSeedData, null);
}

function comparableSeedData(value) {
  const next = ensureJsonObject(value);
  const snapshot = ensureJsonObject(next.snapshot);
  return {
    ...next,
    snapshot: {
      ...snapshot,
      extracted_at: null,
    },
  };
}

function buildSeedUpdatePayload(row, response, targetUrl) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const fallbackPollutedRow =
    looksLikeKnownNonProductUrl(row?.canonical_url || row?.destination_url) &&
    looksLikeDirectProductTargetUrl(targetUrl);
  const representativeProduct = chooseRepresentativeProduct(response, targetUrl, row);
  const representativeProductUrl = normalizeUrlLike(representativeProduct?.url) || normalizeUrlLike(targetUrl) || normalizeUrlLike(row?.canonical_url);
  const snapshotVariants = mapSnapshotVariants(representativeProduct, response, seedData);
  const effectiveSnapshotVariants = fallbackPollutedRow && !representativeProduct ? [] : snapshotVariants;
  const extractedImageUrls = uniqueStrings([
    ...(Array.isArray(representativeProduct?.image_urls) ? representativeProduct.image_urls : []),
    representativeProduct?.image_url,
    ...effectiveSnapshotVariants.flatMap((variant) => variant.image_urls || []),
  ]);
  const existingImageUrls = fallbackPollutedRow ? [] : collectSeedImageUrls(seedData, row);
  const imageOverride = lookupExternalSeedImageOverride(
    representativeProductUrl,
    targetUrl,
    row?.canonical_url,
    row?.destination_url,
    seedData.canonical_url,
    seedData.destination_url,
    snapshot.canonical_url,
    snapshot.destination_url,
  );
  const overrideImageUrls = uniqueStrings([
    ...(Array.isArray(imageOverride?.image_urls) ? imageOverride.image_urls : []),
    imageOverride?.image_url,
  ]);
  let mergedImageUrls = extractedImageUrls.length > 0 ? uniqueStrings([...extractedImageUrls, ...existingImageUrls]) : existingImageUrls;
  const manualImageOverrideApplied = mergedImageUrls.length === 0 && overrideImageUrls.length > 0;
  if (manualImageOverrideApplied) mergedImageUrls = overrideImageUrls;
  const imageUrl = mergedImageUrls[0] || '';
  const variantSkus = uniqueStrings(effectiveSnapshotVariants.map((variant) => variant.sku));
  const variantPrices = effectiveSnapshotVariants
    .map((variant) => parsePrice(variant.price))
    .filter((value) => typeof value === 'number' && value > 0);
  const anyInStock = effectiveSnapshotVariants.some((variant) => {
    const normalized = normalizeSeedAvailability(variant.stock);
    return normalized !== 'out_of_stock';
  });
  const availability =
    effectiveSnapshotVariants.length > 0
      ? anyInStock
        ? 'in_stock'
        : 'out_of_stock'
      : normalizeSeedAvailability(row?.availability || seedData.availability || snapshot.availability) || '';
  const description =
    normalizeNonEmptyString(
      representativeProduct?.variants?.find((variant) => variant.description)?.description ||
        effectiveSnapshotVariants.find((variant) => variant.description)?.description ||
        (fallbackPollutedRow ? seedData.description : snapshot.description) ||
        seedData.description,
    ) || '';
  const title =
    normalizeNonEmptyString(representativeProduct?.title || seedData.title || snapshot.title || row?.title) || row?.id;
  const currency =
    normalizeNonEmptyString(
      effectiveSnapshotVariants.find((variant) => variant.currency)?.currency ||
        row?.price_currency ||
        seedData.price_currency ||
        snapshot.price_currency,
    ) || 'USD';
  const priceAmount =
    variantPrices.length > 0
      ? Math.min(...variantPrices)
      : typeof row?.price_amount === 'number'
        ? row.price_amount
        : parsePrice(seedData.price_amount ?? snapshot.price_amount) || null;
  const destinationUrl =
    normalizeUrlLike(effectiveSnapshotVariants.find((variant) => variant.url)?.url) ||
    representativeProductUrl ||
    (fallbackPollutedRow ? normalizeUrlLike(targetUrl) : normalizeUrlLike(row?.destination_url)) ||
    normalizeUrlLike(targetUrl);

  const nextSnapshot = {
    ...snapshot,
    source: 'catalog_intelligence',
    extracted_at: new Date().toISOString(),
    canonical_url: representativeProductUrl || normalizeUrlLike(snapshot.canonical_url) || normalizeUrlLike(targetUrl),
    title,
    description: description || normalizeNonEmptyString(snapshot.description),
    image_url: imageUrl || normalizeNonEmptyString(snapshot.image_url),
    image_urls: mergedImageUrls,
    images: mergedImageUrls,
    variants: effectiveSnapshotVariants.length > 0 ? effectiveSnapshotVariants : normalizeSeedVariants(fallbackPollutedRow ? {} : seedData, null),
    diagnostics:
      manualImageOverrideApplied
        ? {
            ...(response?.diagnostics && typeof response.diagnostics === 'object' ? response.diagnostics : {}),
            manual_image_override: {
              applied: true,
              source: imageOverride?.source || 'manual_seed_override',
              note: imageOverride?.note || 'Manual image override applied',
            },
          }
        : response?.diagnostics || snapshot.diagnostics || null,
    variant_skus: variantSkus.length > 0 ? variantSkus : uniqueStrings(snapshot.variant_skus || []),
  };

  const nextSeedData = {
    ...seedData,
    ...(imageUrl ? { image_url: imageUrl } : {}),
    ...(mergedImageUrls.length > 0 ? { image_urls: mergedImageUrls, images: mergedImageUrls } : {}),
    ...(effectiveSnapshotVariants.length > 0 ? { variants: effectiveSnapshotVariants } : {}),
    snapshot: nextSnapshot,
  };

  const nextRow = {
    title,
    canonical_url: representativeProductUrl || normalizeNonEmptyString(row?.canonical_url),
    destination_url: destinationUrl || normalizeNonEmptyString(row?.destination_url),
    image_url: imageUrl || normalizeNonEmptyString(row?.image_url),
    price_amount: priceAmount,
    price_currency: currency,
    availability: availability || normalizeNonEmptyString(row?.availability),
    seed_data: nextSeedData,
  };

  const changed =
    normalizeNonEmptyString(row?.title) !== nextRow.title ||
    normalizeNonEmptyString(row?.canonical_url) !== nextRow.canonical_url ||
    normalizeNonEmptyString(row?.destination_url) !== nextRow.destination_url ||
    normalizeNonEmptyString(row?.image_url) !== nextRow.image_url ||
    (typeof row?.price_amount === 'number' ? row.price_amount : parsePrice(row?.price_amount)) !== nextRow.price_amount ||
    normalizeNonEmptyString(row?.price_currency).toUpperCase() !== nextRow.price_currency ||
    normalizeNonEmptyString(row?.availability) !== nextRow.availability ||
    JSON.stringify(comparableSeedData(row?.seed_data)) !== JSON.stringify(comparableSeedData(nextSeedData));

  return {
    changed,
    nextRow,
    representativeProduct,
    snapshot: nextSnapshot,
  };
}

function buildFailureSeedData(row, targetUrl, error) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const existingImageUrls = collectSeedImageUrls(seedData, row);
  const imageOverride = lookupExternalSeedImageOverride(
    targetUrl,
    row?.canonical_url,
    row?.destination_url,
    seedData.canonical_url,
    seedData.destination_url,
    snapshot.canonical_url,
    snapshot.destination_url,
  );
  const overrideImageUrls = uniqueStrings([
    ...(Array.isArray(imageOverride?.image_urls) ? imageOverride.image_urls : []),
    imageOverride?.image_url,
  ]);
  const manualImageOverrideApplied = existingImageUrls.length === 0 && overrideImageUrls.length > 0;
  const currentImageUrls = existingImageUrls.length > 0 ? existingImageUrls : overrideImageUrls;
  return {
    ...seedData,
    snapshot: {
      ...snapshot,
      source: 'catalog_intelligence',
      extracted_at: new Date().toISOString(),
      canonical_url: normalizeUrlLike(snapshot.canonical_url) || normalizeUrlLike(targetUrl),
      diagnostics: {
        ...(snapshot.diagnostics && typeof snapshot.diagnostics === 'object' ? snapshot.diagnostics : {}),
        failure_category: 'unknown',
        error: String(error?.message || error || 'unknown_error'),
        ...(manualImageOverrideApplied
          ? {
              manual_image_override: {
                applied: true,
                source: imageOverride?.source || 'manual_seed_override',
                note: imageOverride?.note || 'Manual image override applied after extraction failure',
              },
            }
          : {}),
      },
      image_url: currentImageUrls[0] || snapshot.image_url || seedData.image_url || '',
      image_urls: currentImageUrls,
      images: currentImageUrls,
      variants: normalizeSeedVariants(seedData, row),
    },
  };
}

async function fetchRows(options) {
  const where = [
    `status = 'active'`,
    `attached_product_key IS NULL`,
    `market = $1`,
    `(tool = '*' OR tool = 'creator_agents')`,
  ];
  const params = [options.market];
  let idx = params.length;

  const addParam = (value) => {
    params.push(value);
    idx += 1;
    return `$${idx}`;
  };

  if (options.seedId) where.push(`id::text = ${addParam(options.seedId)}`);
  if (options.externalProductId) where.push(`external_product_id = ${addParam(options.externalProductId)}`);
  if (options.domain) where.push(`domain = ${addParam(options.domain)}`);
  if (options.brand) where.push(`lower(coalesce(seed_data->>'brand', '')) = lower(${addParam(options.brand)})`);

  params.push(options.limit);
  const limitBind = `$${params.length}`;
  params.push(options.offset);
  const offsetBind = `$${params.length}`;

  const sql = `
    SELECT
      id,
      external_product_id,
      market,
      tool,
      destination_url,
      canonical_url,
      domain,
      title,
      image_url,
      price_amount,
      price_currency,
      availability,
      seed_data,
      status,
      attached_product_key,
      created_at,
      updated_at
    FROM external_product_seeds
    WHERE ${where.join('\n      AND ')}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT ${limitBind}
    OFFSET ${offsetBind}
  `;

  const res = await query(sql, params);
  return res.rows || [];
}

async function extractSeed(targetUrl, row, baseUrl) {
  const requestBody = buildExtractRequestBody(targetUrl, row);
  const response = await axios.post(`${baseUrl.replace(/\/$/, '')}/api/extract`, requestBody, {
    timeout: Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data || {};
}

async function processRow(row, options) {
  const targetUrl = normalizeTargetUrlForMarket(pickSeedTargetUrl(row), row?.market);
  if (!targetUrl) {
    return { status: 'skipped', reason: 'missing_target_url', row };
  }

  try {
    const response = await extractSeed(targetUrl, row, options.baseUrl);
    const payload = buildSeedUpdatePayload(row, response, targetUrl);
    if (options.dryRun || !payload.changed) {
      return {
        status: payload.changed ? 'dry_run' : 'skipped',
        reason: payload.changed ? null : 'unchanged',
        row,
        targetUrl,
        payload,
      };
    }

    await withClient(async (client) => {
      await client.query(
        `
          UPDATE external_product_seeds
          SET
            title = CASE WHEN $2 <> '' THEN $2 ELSE title END,
            canonical_url = CASE WHEN $3 <> '' THEN $3 ELSE canonical_url END,
            destination_url = CASE WHEN $4 <> '' THEN $4 ELSE destination_url END,
            image_url = CASE WHEN $5 <> '' THEN $5 ELSE image_url END,
            price_amount = COALESCE($6, price_amount),
            price_currency = CASE WHEN $7 <> '' THEN $7 ELSE price_currency END,
            availability = CASE WHEN $8 <> '' THEN $8 ELSE availability END,
            seed_data = $9::jsonb,
            updated_at = now()
          WHERE id = $1
        `,
        [
          row.id,
          payload.nextRow.title,
          payload.nextRow.canonical_url,
          payload.nextRow.destination_url,
          payload.nextRow.image_url,
          payload.nextRow.price_amount,
          payload.nextRow.price_currency,
          payload.nextRow.availability,
          JSON.stringify(payload.nextRow.seed_data),
        ],
      );
    });

    return { status: 'updated', row, targetUrl, payload };
  } catch (error) {
    const nextSeedData = buildFailureSeedData(row, targetUrl, error);
    if (!options.dryRun) {
      await query(
        `
          UPDATE external_product_seeds
          SET seed_data = $2::jsonb, updated_at = now()
          WHERE id = $1
        `,
        [row.id, JSON.stringify(nextSeedData)],
      );
    }
    return { status: 'failed', row, targetUrl, error };
  }
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) break;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

async function main() {
  const limit = Math.max(1, Math.min(Number(argValue('limit') || 50), 1000));
  const offset = Math.max(0, Number(argValue('offset') || 0));
  const concurrency = Math.max(1, Math.min(Number(argValue('concurrency') || 3), 10));
  const options = {
    seedId: argValue('seed-id') || argValue('seedId') || null,
    externalProductId: argValue('external-product-id') || argValue('externalProductId') || null,
    domain: argValue('domain') || null,
    brand: argValue('brand') || null,
    market: normalizeNonEmptyString(argValue('market') || 'US').toUpperCase(),
    limit,
    offset,
    concurrency,
    dryRun: hasFlag('dry-run') || hasFlag('dryRun'),
    baseUrl: DEFAULT_CATALOG_BASE_URL,
  };

  const rows = await fetchRows(options);
  console.log(JSON.stringify({ rows: rows.length, ...options }, null, 2));

  const results = await mapWithConcurrency(rows, concurrency, async (row) => processRow(row, options));
  const summary = {
    scanned: rows.length,
    updated: results.filter((result) => result.status === 'updated').length,
    dry_run: results.filter((result) => result.status === 'dry_run').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (summary.failed > 0) {
    const failed = results
      .filter((result) => result.status === 'failed')
      .map((result) => ({
        id: result.row?.id,
        targetUrl: result.targetUrl,
        error: String(result.error?.message || result.error || ''),
      }));
    console.error(JSON.stringify({ failed }, null, 2));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchRows,
  processRow,
  pickSeedTargetUrl,
  buildExtractRequestBody,
  chooseRepresentativeProduct,
  buildSeedUpdatePayload,
  buildFailureSeedData,
  normalizeComparableUrlKey,
  normalizeTargetUrlForMarket,
  recoverTargetUrlFromDiagnostics,
};
