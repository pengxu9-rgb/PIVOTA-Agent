#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const {
  buildSeedRow,
} = require('./build_aurora_external_seed_creation_manifest.cjs');
const {
  attachCommerceFactsToSeedRow,
  validateCommerceFactsGateForSeedRow,
} = require('../src/commerce/commerceFacts');

const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';
const BUNDLE_LIKE_TITLE_PATTERNS = [
  /\bkit\b/i,
  /\bset\b/i,
  /\bduo\b/i,
  /\btrio\b/i,
  /\bbundle\b/i,
  /\broutine\b/i,
  /\bintro\b/i,
  /\bessentials\b/i,
  /\bpower\s+pair\b/i,
  /\bpair\b/i,
  /\bbestsell(?:er|ers?)\b/i,
  /\bvalue\s+set\b/i,
  /\bvalue\s+pack\b/i,
  /\b(?:hydration\s+)?heroe?s\b/i,
  /\bbogo\b/i,
  /\b\d+\s*\+\s*\d+\b/i,
  /\btravel\b/i,
  /\bon\s+the\s+go\b/i,
  /\bcollection\b/i,
  /\b100%\s*off\b/i,
  /🎁/i,
  /\bfree\b/i,
  /\bfree\s*gift\b/i,
  /\bfreegift\b/i,
  /\bgift\s+with\s+purchase\b/i,
  /\bgift\b/i,
  /\bsample\b/i,
  /\bsampler\b/i,
  /\bsachet\s*book\b/i,
  /\bsachetbook\b/i,
  /\bmini\b/i,
  /\b(?:1|2|3|4|5|6|7|8|9|10|12|15)\s*(?:ml|mL|g)\b/i,
  /\bvault\b/i,
  /\bpack\s+of\s+\d+\b/i,
  /\b\d+\s*-\s*pack\b/i,
  /\b\d+\s+pack\b/i,
  /\bcoming\s+soon\b/i,
  /\bamazon\b/i,
  /\btote\b/i,
  /\bkey\s*chain\b/i,
  /\bkeychain\b/i,
  /\bblanket\b/i,
  /\bbag\b/i,
  /\btumbler\b/i,
  /\bicons?\s+to\s+go\b/i,
  /\bmist\s+pump\b/i,
  /\bice\s+roller\b/i,
  /\bnail\s+polish\b/i,
  /\bnail\s+art\b/i,
  /\bpillowcase\b/i,
  /\bscrunchie\b/i,
  /\bcrewneck\b/i,
  /\bphone\s+grip\b/i,
  /\bholder\b/i,
  /\bclip(?:s)?\b/i,
  /\bpouch\b/i,
  /\bbrush\b/i,
  /\bblister\b/i,
  /\bbeanie\b/i,
  /\bhat\b/i,
  /\bhoodie\b/i,
  /\bsweatshirt\b/i,
  /\bt-?shirt\b/i,
  /\btee\b/i,
  /\bcap\b/i,
  /\bsticker\b/i,
  /\bpin\b/i,
  /\bshort-?dated\b/i,
];
const BUNDLE_LIKE_DESCRIPTION_PATTERNS = [
  /\bgift\s+with\s+purchase\s+only\b/i,
  /\bnot\s+for\s+sale\b/i,
  /\bcomplimentary\s+gift\b/i,
];

function parseArgs(argv) {
  const out = {
    brand: '',
    domain: '',
    fallbackDomains: [],
    market: 'US',
    limit: 200,
    outPath: '',
    catalogBaseUrl: DEFAULT_CATALOG_BASE_URL,
    preferredTitles: [],
    includeCommerceFacts: false,
  };
  for (let idx = 2; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    const next = String(argv[idx + 1] || '').trim();
    if (token === '--brand' && next) {
      out.brand = next;
      idx += 1;
    } else if (token === '--domain' && next) {
      out.domain = next;
      idx += 1;
    } else if (token === '--fallback-domains' && next) {
      out.fallbackDomains = next
        .split(';;')
        .map((item) => item.trim())
        .filter(Boolean);
      idx += 1;
    } else if (token === '--market' && next) {
      out.market = next;
      idx += 1;
    } else if (token === '--limit' && next) {
      out.limit = Math.max(1, Math.min(Number(next) || 200, 1000));
      idx += 1;
    } else if (token === '--out' && next) {
      out.outPath = next;
      idx += 1;
    } else if (token === '--catalog-base-url' && next) {
      out.catalogBaseUrl = next;
      idx += 1;
    } else if (token === '--preferred-titles' && next) {
      out.preferredTitles = next
        .split(';;')
        .map((item) => item.trim())
        .filter(Boolean);
      idx += 1;
    } else if (token === '--include-commerce-facts' || token === '--includeCommerceFacts') {
      out.includeCommerceFacts = true;
    }
  }
  return out;
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeSearchText(value) {
  return normalizeNonEmptyString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/\s+/g, '');
}

function dedupeStrings(values, maxItems = 24) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const normalized = normalizeNonEmptyString(raw);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function buildBrandScopeTokens(brand) {
  const normalized = normalizeSearchText(brand);
  const compact = compactSearchText(brand);
  const wordTokens = normalized
    .split(/\s+/g)
    .map((token) => compactSearchText(token))
    .filter(
      (token) =>
        token.length >= 4 &&
        ![
          'beauty',
          'skin',
          'skincare',
          'official',
          'global',
          'from',
          'with',
          'the',
          'and',
          'cosmetics',
        ].includes(token),
    );
  return dedupeStrings([compact, wordTokens.join(''), ...wordTokens], 16).filter((token) => token.length >= 4);
}

function sourceLooksBrandScoped({ brand, sourceUrl }) {
  const tokens = buildBrandScopeTokens(brand);
  if (!tokens.length) return false;
  const sourceCompact = compactSearchText(sourceUrl);
  return tokens.some((token) => sourceCompact.includes(token));
}

function productHasExplicitBrandSignal(product = {}, brand) {
  const tokens = buildBrandScopeTokens(brand);
  if (!tokens.length) return false;
  const productCompact = compactSearchText(
    [
      product?.brand,
      product?.brand_name,
      product?.vendor,
      product?.vendor_name,
      product?.manufacturer,
      product?.title,
      product?.name,
      product?.url,
      product?.canonical_url,
      product?.product_url,
    ]
      .filter(Boolean)
      .join(' '),
  );
  return tokens.some((token) => productCompact.includes(token));
}

function getUrlHost(value) {
  try {
    return new URL(normalizeNonEmptyString(value)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sourceHostLooksBrandOwned({ brand, sourceUrl }) {
  const tokens = buildBrandScopeTokens(brand);
  const hostCompact = compactSearchText(getUrlHost(sourceUrl));
  return Boolean(hostCompact && tokens.some((token) => hostCompact.includes(token)));
}

function normalizeComparableUrl(value) {
  const raw = normalizeNonEmptyString(value);
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.search = '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    parsed.pathname = parsed.pathname.replace(/\/+$/g, '').toLowerCase();
    return parsed.toString();
  } catch {
    return raw.toLowerCase();
  }
}

function normalizeTitleKey(value) {
  return normalizeSearchText(value)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function computeExtractLimit(limit, preferredTitles = []) {
  const requested = Math.max(1, Math.min(Number(limit) || 1, 1000));
  if ((Array.isArray(preferredTitles) ? preferredTitles : []).some((item) => normalizeNonEmptyString(item))) {
    return Math.min(Math.max(requested * 20, 250), 1000);
  }
  return Math.min(Math.max(requested, requested * 5), 1000);
}

function resolvePathMaybeRelative(targetPath) {
  const normalized = normalizeNonEmptyString(targetPath);
  if (!normalized) return '';
  return path.isAbsolute(normalized) ? normalized : path.join(process.cwd(), normalized);
}

function looksLikeBundleLikeProduct(product = {}) {
  const title = normalizeNonEmptyString(product?.title || product?.name);
  const targetUrl = normalizeNonEmptyString(product?.url || product?.canonical_url || product?.product_url);
  const description = normalizeNonEmptyString(product?.description || product?.description_raw || product?.body_html);
  const combined = `${title} ${targetUrl}`;
  return (
    BUNDLE_LIKE_TITLE_PATTERNS.some((pattern) => pattern.test(combined)) ||
    BUNDLE_LIKE_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(description))
  );
}

function looksLikeNonProductCatalogPage(product = {}) {
  const targetUrl = normalizeNonEmptyString(product?.url || product?.canonical_url || product?.product_url);
  const title = normalizeNonEmptyString(product?.title || product?.name);
  if (!targetUrl) return true;
  let urlPath = targetUrl;
  try {
    const parsed = new URL(targetUrl);
    urlPath = `${parsed.pathname || ''}?${parsed.searchParams.toString()}`;
  } catch {
    urlPath = targetUrl;
  }
  if (/\/(?:category|collections?|collection|board|search|pages?)\//i.test(urlPath)) return true;
  if (/(?:^|[?&])cate_no=\d+/i.test(urlPath) && !/\/product\/(?:detail|[^/]+\/)/i.test(urlPath)) return true;
  if (/\/product\/list\.html/i.test(urlPath)) return true;
  if (/\/(?:notice|privacy|policy|policies|terms|mothers?-day|gift-guide)(?:[/?#-]|$)/i.test(urlPath)) return true;
  if (/veritas-hub\.cafe24\.com\/challenge/i.test(targetUrl)) return true;
  if (/^(?:all|md'?pick|라인별)\s*[-:]/i.test(title)) return true;
  if (/\bcolor correctors\s*&\s*tinted moisturizers\b/i.test(title)) return true;
  if (/\b(?:privacy|policy|statement|gift guide|mothers? day|online shop|wholesale)\b/i.test(title)) return true;
  return false;
}

function looksLikeSyntheticFallbackProduct(product = {}, brand = '', extractDoc = {}) {
  const mode = normalizeNonEmptyString(extractDoc?.mode).toLowerCase();
  if (mode === 'simulation') return true;
  const title = normalizeNonEmptyString(product?.title || product?.name);
  const normalizedTitle = normalizeSearchText(title);
  const normalizedBrand = normalizeSearchText(brand);
  if (!normalizedTitle) return false;
  if (/^product\s+\d{3}$/.test(normalizedTitle)) return true;
  if (normalizedBrand) {
    const escapedBrand = normalizedBrand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^${escapedBrand}\\s+product\\s+\\d{3}$`).test(normalizedTitle)) {
      return true;
    }
  }
  const imageUrls = [
    product?.image_url,
    ...(Array.isArray(product?.image_urls) ? product.image_urls : []),
    ...(Array.isArray(product?.images) ? product.images : []),
  ]
    .map((item) => normalizeNonEmptyString(typeof item === 'string' ? item : item?.url || item?.src))
    .filter(Boolean);
  return imageUrls.some((url) => /(?:^|\/\/)via\.placeholder\.com|placeholder/i.test(url));
}

function scorePreferredTitleMatch(product = {}, preferredTitles = []) {
  const normalizedTitle = normalizeSearchText(product?.title || product?.name);
  if (!normalizedTitle) return 0;
  let bestScore = 0;
  for (const rawPreferred of Array.isArray(preferredTitles) ? preferredTitles : []) {
    const preferred = normalizeSearchText(rawPreferred);
    if (!preferred) continue;
    if (normalizedTitle === preferred) bestScore = Math.max(bestScore, 100);
    else if (normalizedTitle.includes(preferred) || preferred.includes(normalizedTitle)) bestScore = Math.max(bestScore, 80);
    else {
      const preferredTokens = preferred.split(' ').filter(Boolean);
      const overlap = preferredTokens.filter((token) => normalizedTitle.includes(token)).length;
      if (overlap > 0) {
        bestScore = Math.max(bestScore, 20 + overlap * 10);
      }
    }
  }
  return bestScore;
}

function collectPreferredTitleHits(product = {}, preferredTitles = [], { minScore = 80 } = {}) {
  const normalizedTitle = normalizeSearchText(product?.title || product?.name);
  if (!normalizedTitle) return [];
  const hits = [];
  for (const rawPreferred of Array.isArray(preferredTitles) ? preferredTitles : []) {
    const preferred = normalizeSearchText(rawPreferred);
    if (!preferred) continue;
    let matchScore = 0;
    if (normalizedTitle === preferred) matchScore = 100;
    else if (normalizedTitle.includes(preferred) || preferred.includes(normalizedTitle)) matchScore = 80;
    else {
      const preferredTokens = preferred.split(' ').filter(Boolean);
      const overlap = preferredTokens.filter((token) => normalizedTitle.includes(token)).length;
      if (overlap > 0) matchScore = 20 + overlap * 10;
    }
    if (matchScore >= minScore) hits.push(normalizeNonEmptyString(rawPreferred));
  }
  return dedupeStrings(hits, 12);
}

function hasTransactionReadySeedSignals(seedRow = {}) {
  return (
    Number(seedRow.price_amount) > 0 &&
    Boolean(normalizeNonEmptyString(seedRow.price_currency)) &&
    Boolean(normalizeNonEmptyString(seedRow.availability)) &&
    Boolean(normalizeNonEmptyString(seedRow.image_url))
  );
}

async function fetchBrandCatalog({ brand, domain, market, limit, catalogBaseUrl }) {
  const response = await axios.post(
    `${String(catalogBaseUrl || DEFAULT_CATALOG_BASE_URL).replace(/\/+$/, '')}/api/extract`,
    {
      brand,
      domain,
      market,
      limit,
    },
    {
      timeout: Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return response.data || {};
}

async function fetchBrandCatalogV2({ brand, domain, market, limit, catalogBaseUrl }) {
  const response = await axios.post(
    `${String(catalogBaseUrl || DEFAULT_CATALOG_BASE_URL).replace(/\/+$/, '')}/api/extract-v2`,
    {
      brand,
      domain,
      market,
      limit,
    },
    {
      timeout: Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return response.data || {};
}

function summarizeDiagnostics(extractDoc = {}) {
  const diagnostics = extractDoc?.diagnostics || {};
  return {
    discovery_strategy: normalizeNonEmptyString(diagnostics.discovery_strategy) || null,
    failure_category: normalizeNonEmptyString(diagnostics.failure_category) || null,
    block_provider: normalizeNonEmptyString(diagnostics.block_provider) || null,
  };
}

function annotateSeedRowAuthoritySource(seedRow = {}, authorityContext = {}) {
  const sourceUrl = normalizeNonEmptyString(authorityContext.sourceUrl);
  const sourceRole = normalizeNonEmptyString(authorityContext.sourceRole) || 'primary';
  const matchedPreferredTitles = dedupeStrings(authorityContext.matchedPreferredTitles, 12);
  const searchAliases = dedupeStrings(
    [
      ...(Array.isArray(seedRow?.seed_data?.search_aliases) ? seedRow.seed_data.search_aliases : []),
      ...(Array.isArray(seedRow?.seed_data?.snapshot?.search_aliases) ? seedRow.seed_data.snapshot.search_aliases : []),
      ...matchedPreferredTitles,
      seedRow?.title,
      seedRow?.seed_data?.title,
    ],
    16,
  );
  const authoritySource = {
    source_url: sourceUrl || null,
    source_role: sourceRole || null,
    matched_preferred_titles: matchedPreferredTitles,
  };
  return {
    ...seedRow,
    seed_data: {
      ...(seedRow.seed_data || {}),
      search_aliases: searchAliases,
      authority_source: authoritySource,
      snapshot: {
        ...(seedRow.seed_data?.snapshot || {}),
        search_aliases: searchAliases,
        authority_source: authoritySource,
      },
    },
  };
}

function findCommerceFactsForProduct(product = {}, extractV2Doc = {}) {
  const offers = Array.isArray(extractV2Doc?.offers_v2) ? extractV2Doc.offers_v2 : [];
  if (!offers.length) return null;
  const productUrlKey = normalizeComparableUrl(product?.url || product?.canonical_url || product?.product_url);
  const productTitleKey = normalizeTitleKey(product?.title || product?.name);
  const primaryVariant = Array.isArray(product?.variants) ? product.variants[0] : null;
  const primaryVariantSkus = new Set(
    [primaryVariant?.sku, primaryVariant?.variant_sku, primaryVariant?.id, primaryVariant?.variant_id]
      .map((item) => normalizeNonEmptyString(item).toLowerCase())
      .filter(Boolean),
  );
  const variantSkus = new Set(
    (Array.isArray(product?.variants) ? product.variants : [])
      .flatMap((variant) => [variant?.sku, variant?.variant_sku, variant?.id, variant?.variant_id])
      .map((item) => normalizeNonEmptyString(item).toLowerCase())
      .filter(Boolean),
  );
  const exactUrlMatch = offers.find((offer) => {
    const offerUrlKey = normalizeComparableUrl(offer?.url_canonical);
    return Boolean(productUrlKey && offerUrlKey === productUrlKey);
  });
  if (exactUrlMatch?.commerce_facts_v1) return exactUrlMatch.commerce_facts_v1;

  const primaryVariantMatch = offers.find((offer) => {
    const offerSku = normalizeNonEmptyString(offer?.variant_sku).toLowerCase();
    return Boolean(offerSku && primaryVariantSkus.has(offerSku));
  });
  if (primaryVariantMatch?.commerce_facts_v1) return primaryVariantMatch.commerce_facts_v1;

  const variantMatch = offers.find((offer) => {
    const offerSku = normalizeNonEmptyString(offer?.variant_sku).toLowerCase();
    return Boolean(offerSku && variantSkus.has(offerSku));
  });
  if (variantMatch?.commerce_facts_v1) return variantMatch.commerce_facts_v1;

  const titleMatch = offers.find((offer) => {
    const offerTitleKey = normalizeTitleKey(offer?.product_title);
    return Boolean(productTitleKey && offerTitleKey && productTitleKey === offerTitleKey);
  });
  return titleMatch?.commerce_facts_v1 || null;
}

function annotateSeedRowSourceValidation(seedRow = {}, { brand, sourceUrl }) {
  const sourceType = sourceHostLooksBrandOwned({ brand, sourceUrl }) ? 'brand_owned' : 'channel_or_retailer';
  const sourceValidation = {
    source_type: sourceType,
    requires_multi_offer_merge_validation: sourceType === 'channel_or_retailer',
    source_host: getUrlHost(sourceUrl) || null,
  };
  return {
    ...seedRow,
    seed_data: {
      ...(seedRow.seed_data || {}),
      source_validation: sourceValidation,
      ...(sourceType === 'channel_or_retailer' ? { requires_multi_offer_merge_validation: true } : {}),
      snapshot: {
        ...(seedRow.seed_data?.snapshot || {}),
        source_validation: sourceValidation,
        ...(sourceType === 'channel_or_retailer' ? { requires_multi_offer_merge_validation: true } : {}),
      },
    },
  };
}

function annotateSeedRowCommerceFacts(seedRow = {}, { product, extractV2Doc, market }) {
  const rawFacts = findCommerceFactsForProduct(product, extractV2Doc);
  const withFacts = attachCommerceFactsToSeedRow(seedRow, rawFacts, { market });
  const gate = validateCommerceFactsGateForSeedRow(withFacts);
  return {
    ...withFacts,
    seed_data: {
      ...(withFacts.seed_data || {}),
      commerce_facts_gate: gate,
      snapshot: {
        ...(withFacts.seed_data?.snapshot || {}),
        commerce_facts_gate: gate,
      },
    },
  };
}

function buildManifestFromExtract({
  brand,
  domain,
  market,
  limit,
  preferredTitles,
  extractDoc,
  extractV2Doc,
  sourceRole = 'primary',
}) {
  const products = Array.isArray(extractDoc?.products) ? extractDoc.products : [];
  const diagnostics = extractDoc?.diagnostics || {};
  const desiredLimit = Math.max(1, Math.min(Number(limit) || products.length || 1, 1000));
  const preferred = (Array.isArray(preferredTitles) ? preferredTitles : [])
    .map((item) => normalizeNonEmptyString(item))
    .filter(Boolean);
  const prioritizedProducts = products
    .map((product, index) => ({
      product,
      index,
      priority: scorePreferredTitleMatch(product, preferred),
    }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index);
  const items = [];
  let excludedBundleLikeCount = 0;
  let excludedNonProductPageCount = 0;
  let excludedIncompleteTransactionCount = 0;
  let excludedBrandScopeMismatchCount = 0;
  let excludedLowQualityFallbackCount = 0;
  let matchedPreferredTitleCount = 0;
  const matchedPreferredTitles = [];
  const sourceBrandScoped = sourceLooksBrandScoped({ brand, sourceUrl: domain });
  for (const { product, priority } of prioritizedProducts) {
    if (looksLikeSyntheticFallbackProduct(product, brand, extractDoc)) {
      excludedLowQualityFallbackCount += 1;
      continue;
    }
    if (!sourceBrandScoped && !productHasExplicitBrandSignal(product, brand) && priority < 80) {
      excludedBrandScopeMismatchCount += 1;
      continue;
    }
    if (looksLikeBundleLikeProduct(product)) {
      excludedBundleLikeCount += 1;
      continue;
    }
    const targetUrl = normalizeNonEmptyString(product?.url || product?.canonical_url || product?.product_url);
    if (!targetUrl) continue;
    if (looksLikeNonProductCatalogPage(product)) {
      excludedNonProductPageCount += 1;
      continue;
    }
    const seedRow = buildSeedRow(
      {
        ingredient_id: null,
        ingredient_name: null,
        target_brand: brand,
        target_url: targetUrl,
        extract_status: 'brand_catalog_extract',
        market,
      },
      {
        products: [product],
        diagnostics,
      },
    );
    if (!seedRow) continue;
    if (!hasTransactionReadySeedSignals(seedRow)) {
      excludedIncompleteTransactionCount += 1;
      continue;
    }
    const preferredHits = collectPreferredTitleHits(product, preferred, { minScore: 80 });
    const preferredAliases = collectPreferredTitleHits(product, preferred, { minScore: 60 });
    items.push({
      ingredient_id: null,
      ingredient_name: null,
      target_brand: brand,
      target_url: targetUrl,
      extract_status: 'brand_catalog_extract',
      market,
      source_domain: domain,
      source_role: sourceRole,
      matched_preferred_titles: preferredHits,
      alias_preferred_titles: preferredAliases,
      seed_row: annotateSeedRowCommerceFacts(
        annotateSeedRowSourceValidation(
          annotateSeedRowAuthoritySource(seedRow, {
            sourceUrl: domain,
            sourceRole,
            matchedPreferredTitles: dedupeStrings([...preferredAliases, ...preferredHits], 12),
          }),
          { brand, sourceUrl: domain },
        ),
        { product, extractV2Doc, market },
      ),
    });
    if (priority >= 80) matchedPreferredTitleCount += 1;
    matchedPreferredTitles.push(...preferredHits);
    if (items.length >= desiredLimit) break;
  }
  return {
    generated_at: new Date().toISOString(),
    brand,
    domain,
    source_url: domain,
    source_role: sourceRole,
    market,
    preferred_titles: preferred,
    matched_preferred_titles: dedupeStrings(matchedPreferredTitles, 24),
    extracted_product_count: products.length,
    excluded_bundle_like_count: excludedBundleLikeCount,
    excluded_non_product_page_count: excludedNonProductPageCount,
    excluded_incomplete_transaction_count: excludedIncompleteTransactionCount,
    excluded_brand_scope_mismatch_count: excludedBrandScopeMismatchCount,
    excluded_low_quality_fallback_count: excludedLowQualityFallbackCount,
    matched_preferred_title_count: matchedPreferredTitleCount,
    diagnostics_summary: summarizeDiagnostics(extractDoc),
    commerce_facts_summary: {
      requested: Boolean(extractV2Doc),
      offers_v2_count: Array.isArray(extractV2Doc?.offers_v2) ? extractV2Doc.offers_v2.length : 0,
      counters_by_site_market: Array.isArray(extractV2Doc?.counters_by_site_market)
        ? extractV2Doc.counters_by_site_market
        : [],
    },
    item_count: items.length,
    items,
  };
}

function shouldUseFallbackSources({ primaryManifest, currentMatchedPreferredTitles, preferredTitles, currentItemCount, limit }) {
  const desiredLimit = Math.max(1, Math.min(Number(limit) || 1, 1000));
  if (!primaryManifest) return true;
  if (primaryManifest.item_count <= 0) return true;
  const preferred = dedupeStrings(preferredTitles, 24);
  if (preferred.length > 0) {
    return currentMatchedPreferredTitles.length < preferred.length;
  }
  return currentItemCount <= 0 && desiredLimit > 0;
}

function buildManifestFromSourceAttempts({ brand, domain, fallbackDomains, market, limit, preferredTitles, sourceManifests }) {
  const preferred = dedupeStrings(preferredTitles, 24);
  const desiredLimit = Math.max(1, Math.min(Number(limit) || 1, 1000));
  const attempts = Array.isArray(sourceManifests) ? sourceManifests : [];
  const primaryManifest = attempts[0] || null;
  const mergedItems = [];
  const seenTargetUrls = new Set();
  const matchedPreferredTitles = [];
  const sourceAttempts = attempts.map((attempt, index) => {
    const currentMatchedPreferredTitles = dedupeStrings(matchedPreferredTitles, 24);
    const allowUse =
      index === 0 ||
      shouldUseFallbackSources({
        primaryManifest,
        currentMatchedPreferredTitles,
        preferredTitles: preferred,
        currentItemCount: mergedItems.length,
        limit: desiredLimit,
      });
    let addedItemCount = 0;
    const addedMatchedTitles = [];
    if (allowUse) {
      for (const item of Array.isArray(attempt?.items) ? attempt.items : []) {
        const targetUrl = normalizeNonEmptyString(item?.target_url);
        const dedupeKey = targetUrl.toLowerCase();
        if (!targetUrl || seenTargetUrls.has(dedupeKey)) continue;
        seenTargetUrls.add(dedupeKey);
        mergedItems.push(item);
        addedItemCount += 1;
        addedMatchedTitles.push(...(Array.isArray(item?.matched_preferred_titles) ? item.matched_preferred_titles : []));
        matchedPreferredTitles.push(...(Array.isArray(item?.matched_preferred_titles) ? item.matched_preferred_titles : []));
        if (mergedItems.length >= desiredLimit) break;
      }
    }
    return {
      source_url: attempt?.source_url || attempt?.domain || null,
      source_role: attempt?.source_role || (index === 0 ? 'primary' : 'secondary_fallback'),
      extracted_product_count: Number(attempt?.extracted_product_count || 0) || 0,
      item_count: Number(attempt?.item_count || 0) || 0,
      matched_preferred_title_count: Number(attempt?.matched_preferred_title_count || 0) || 0,
      matched_preferred_titles: dedupeStrings(attempt?.matched_preferred_titles, 24),
      diagnostics_summary: attempt?.diagnostics_summary || null,
      used_in_manifest: allowUse && addedItemCount > 0,
      added_item_count: addedItemCount,
      added_matched_preferred_titles: dedupeStrings(addedMatchedTitles, 24),
      skip_reason: allowUse ? null : 'primary_sufficient',
    };
  });
  return {
    generated_at: new Date().toISOString(),
    brand,
    domain,
    fallback_domains: dedupeStrings(fallbackDomains, 24),
    market,
    preferred_titles: preferred,
    matched_preferred_titles: dedupeStrings(matchedPreferredTitles, 24),
    extracted_product_count: attempts.reduce(
      (sum, attempt) => sum + Math.max(0, Number(attempt?.extracted_product_count || 0) || 0),
      0,
    ),
    excluded_bundle_like_count: attempts.reduce(
      (sum, attempt) => sum + Math.max(0, Number(attempt?.excluded_bundle_like_count || 0) || 0),
      0,
    ),
    excluded_non_product_page_count: attempts.reduce(
      (sum, attempt) => sum + Math.max(0, Number(attempt?.excluded_non_product_page_count || 0) || 0),
      0,
    ),
    excluded_incomplete_transaction_count: attempts.reduce(
      (sum, attempt) => sum + Math.max(0, Number(attempt?.excluded_incomplete_transaction_count || 0) || 0),
      0,
    ),
    excluded_brand_scope_mismatch_count: attempts.reduce(
      (sum, attempt) => sum + Math.max(0, Number(attempt?.excluded_brand_scope_mismatch_count || 0) || 0),
      0,
    ),
    matched_preferred_title_count: dedupeStrings(matchedPreferredTitles, 24).length,
    item_count: mergedItems.length,
    fallback_used: sourceAttempts.some((attempt, index) => index > 0 && attempt.used_in_manifest),
    source_attempts: sourceAttempts,
    items: mergedItems.slice(0, desiredLimit),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!normalizeNonEmptyString(args.brand) || !normalizeNonEmptyString(args.domain)) {
    throw new Error('Missing required --brand <Brand> and --domain <https://brand.example>');
  }
  const market = normalizeNonEmptyString(args.market).toUpperCase() || 'US';
  const sourceSpecs = [
    { domain: args.domain, sourceRole: 'primary' },
    ...dedupeStrings(args.fallbackDomains, 24).map((domain) => ({
      domain,
      sourceRole: 'secondary_fallback',
    })),
  ];
  const sourceManifests = [];
  for (const sourceSpec of sourceSpecs) {
    // eslint-disable-next-line no-await-in-loop
    const extractDoc = await fetchBrandCatalog({
      brand: args.brand,
      domain: sourceSpec.domain,
      market,
      limit: computeExtractLimit(args.limit, args.preferredTitles),
      catalogBaseUrl: args.catalogBaseUrl,
    });
    // eslint-disable-next-line no-await-in-loop
    const extractV2Doc = args.includeCommerceFacts
      ? await fetchBrandCatalogV2({
          brand: args.brand,
          domain: sourceSpec.domain,
          market,
          limit: computeExtractLimit(args.limit, args.preferredTitles),
          catalogBaseUrl: args.catalogBaseUrl,
        })
      : null;
    sourceManifests.push(
      buildManifestFromExtract({
        brand: args.brand,
        domain: sourceSpec.domain,
        market,
        limit: args.limit,
        preferredTitles: args.preferredTitles,
        extractDoc,
        extractV2Doc,
        sourceRole: sourceSpec.sourceRole,
      }),
    );
  }
  const manifest = buildManifestFromSourceAttempts({
    brand: args.brand,
    domain: args.domain,
    fallbackDomains: args.fallbackDomains,
    market,
    limit: args.limit,
    preferredTitles: args.preferredTitles,
    sourceManifests,
  });
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const outPath = resolvePathMaybeRelative(args.outPath);
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, body, 'utf8');
  }
  process.stdout.write(body);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  looksLikeBundleLikeProduct,
  looksLikeNonProductCatalogPage,
  looksLikeSyntheticFallbackProduct,
  scorePreferredTitleMatch,
  collectPreferredTitleHits,
  hasTransactionReadySeedSignals,
  buildBrandScopeTokens,
  sourceLooksBrandScoped,
  sourceHostLooksBrandOwned,
  productHasExplicitBrandSignal,
  fetchBrandCatalogV2,
  findCommerceFactsForProduct,
  annotateSeedRowSourceValidation,
  annotateSeedRowCommerceFacts,
  computeExtractLimit,
  summarizeDiagnostics,
  annotateSeedRowAuthoritySource,
  fetchBrandCatalog,
  buildManifestFromExtract,
  shouldUseFallbackSources,
  buildManifestFromSourceAttempts,
};
