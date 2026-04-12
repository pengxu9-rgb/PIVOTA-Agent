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

function buildManifestFromExtract({ brand, domain, market, limit, preferredTitles, extractDoc }) {
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
    items.push({
      ingredient_id: null,
      ingredient_name: null,
      target_brand: brand,
      target_url: targetUrl,
      extract_status: 'brand_catalog_extract',
      market,
      source_domain: domain,
      seed_row: seedRow,
    });
    if (priority >= 80) matchedPreferredTitleCount += 1;
    if (items.length >= desiredLimit) break;
  }
  return {
    generated_at: new Date().toISOString(),
    brand,
    domain,
    market,
    preferred_titles: preferred,
    extracted_product_count: products.length,
    excluded_bundle_like_count: excludedBundleLikeCount,
    matched_preferred_title_count: matchedPreferredTitleCount,
    item_count: items.length,
    items,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!normalizeNonEmptyString(args.brand) || !normalizeNonEmptyString(args.domain)) {
    throw new Error('Missing required --brand <Brand> and --domain <https://brand.example>');
  }
  const extractDoc = await fetchBrandCatalog({
    brand: args.brand,
    domain: args.domain,
    market: normalizeNonEmptyString(args.market).toUpperCase() || 'US',
    limit: computeExtractLimit(args.limit, args.preferredTitles),
    catalogBaseUrl: args.catalogBaseUrl,
  });
  const manifest = buildManifestFromExtract({
    brand: args.brand,
    domain: args.domain,
    market: normalizeNonEmptyString(args.market).toUpperCase() || 'US',
    limit: args.limit,
    preferredTitles: args.preferredTitles,
    extractDoc,
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
  computeExtractLimit,
  fetchBrandCatalog,
  buildManifestFromExtract,
};
