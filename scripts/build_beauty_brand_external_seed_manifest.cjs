#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const {
  buildSeedRow,
} = require('./build_aurora_external_seed_creation_manifest.cjs');

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
  /\bbestsell(?:er|ers?)\b/i,
  /\bvalue\s+set\b/i,
  /\btravel\b/i,
  /\bcollection\b/i,
  /\bfree\b/i,
  /\bmini\b/i,
  /\bpack\s+of\s+\d+\b/i,
  /\b\d+\s*-\s*pack\b/i,
  /\b\d+\s+pack\b/i,
  /\btote\b/i,
  /\bbeanie\b/i,
  /\bhat\b/i,
  /\bhoodie\b/i,
  /\bsweatshirt\b/i,
  /\bt-?shirt\b/i,
  /\btee\b/i,
  /\bcap\b/i,
  /\bsticker\b/i,
  /\bpin\b/i,
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
  return BUNDLE_LIKE_TITLE_PATTERNS.some((pattern) => pattern.test(title));
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

function buildManifestFromExtract({
  brand,
  domain,
  market,
  limit,
  preferredTitles,
  extractDoc,
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
  let matchedPreferredTitleCount = 0;
  const matchedPreferredTitles = [];
  for (const { product, priority } of prioritizedProducts) {
    if (looksLikeBundleLikeProduct(product)) {
      excludedBundleLikeCount += 1;
      continue;
    }
    const targetUrl = normalizeNonEmptyString(product?.url || product?.canonical_url || product?.product_url);
    if (!targetUrl) continue;
    const seedRow = buildSeedRow(
      {
        ingredient_id: null,
        ingredient_name: null,
        target_brand: brand,
        target_url: targetUrl,
        extract_status: 'brand_catalog_extract',
      },
      {
        products: [product],
        diagnostics,
      },
    );
    if (!seedRow) continue;
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
      seed_row: annotateSeedRowAuthoritySource(seedRow, {
        sourceUrl: domain,
        sourceRole,
        matchedPreferredTitles: dedupeStrings([...preferredAliases, ...preferredHits], 12),
      }),
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
    matched_preferred_title_count: matchedPreferredTitleCount,
    diagnostics_summary: summarizeDiagnostics(extractDoc),
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
    sourceManifests.push(
      buildManifestFromExtract({
        brand: args.brand,
        domain: sourceSpec.domain,
        market,
        limit: args.limit,
        preferredTitles: args.preferredTitles,
        extractDoc,
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
  scorePreferredTitleMatch,
  collectPreferredTitleHits,
  computeExtractLimit,
  summarizeDiagnostics,
  annotateSeedRowAuthoritySource,
  fetchBrandCatalog,
  buildManifestFromExtract,
  shouldUseFallbackSources,
  buildManifestFromSourceAttempts,
};
