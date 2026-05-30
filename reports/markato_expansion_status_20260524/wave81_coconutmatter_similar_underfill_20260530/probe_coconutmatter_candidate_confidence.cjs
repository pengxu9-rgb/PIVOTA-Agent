#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const RecommendationEngine = require(path.join(process.cwd(), 'src/services/RecommendationEngine'));
const { closePool } = require(path.join(process.cwd(), 'src/db'));

const {
  enrichExternalBaseProduct,
  fetchCatalogCandidates,
  getBrandName,
  getLeafCategory,
  getParentCategory,
  getSimilarIntentFamilyFromProductTitle,
} = RecommendationEngine._internals;
const { pickLayeredRecommendations } = RecommendationEngine;

const TARGET_IDS = [
  'ext_c840771410198f627d75673a',
  'ext_8982e4384c3bd70a5718c899',
];

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : '';
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeText(value) {
  return String(value || '').trim();
}

function productId(product = {}) {
  return normalizeText(product.product_id || product.productId || product.id || product.external_product_id);
}

function merchantId(product = {}) {
  return normalizeText(product.merchant_id || product.merchantId || product.merchant || product.source_merchant_id);
}

function catalogPath(product = {}) {
  const raw = product.catalog_category_path || product.category_path || product.categoryPath;
  if (Array.isArray(raw)) return raw.filter(Boolean).join('/');
  return normalizeText(raw);
}

function summarizeProduct(product = {}) {
  return {
    product_id: productId(product),
    merchant_id: merchantId(product),
    title: normalizeText(product.title || product.name),
    brand: normalizeText(product.brand || product.vendor),
    category: normalizeText(product.category),
    product_type: normalizeText(product.product_type || product.productType),
    category_path: catalogPath(product),
    price_amount: Number(product.price_amount ?? product.price ?? product.amount ?? 0) || null,
    vertical: normalizeText(product.semantic_vertical || product.recall_vertical),
    intent_title_family: getSimilarIntentFamilyFromProductTitle(product) || null,
    image_url_present: Boolean(normalizeText(product.image_url || product.image)),
    availability: normalizeText(product.availability),
  };
}

function summarizePick(pickResult = {}) {
  const items = Array.isArray(pickResult.items) ? pickResult.items : [];
  return {
    accepted: items.length > 0,
    accepted_items: items.map(summarizeProduct),
    metadata: pickResult.metadata || {},
    debug: {
      layers: pickResult.debug?.layers || {},
      candidates_total: pickResult.debug?.candidates_total || 0,
      filters: pickResult.debug?.filters || {},
      confidence: pickResult.debug?.confidence || {},
      base: pickResult.debug?.base || {},
    },
  };
}

async function probeOne(externalProductId) {
  const { product: baseProduct, semantic: baseSemantic } = await enrichExternalBaseProduct({
    merchant_id: 'external_seed',
    product_id: externalProductId,
    external_product_id: externalProductId,
  });

  const brand = getBrandName(baseProduct);
  const leaf = getLeafCategory(baseProduct);
  const parent = getParentCategory(baseProduct);
  const categoryPath = catalogPath(baseProduct);
  const intentFamily = getSimilarIntentFamilyFromProductTitle(baseProduct);

  const catalogCandidates = await fetchCatalogCandidates({
    brandHint: brand,
    categoryHint: leaf,
    categoryPathHint: categoryPath,
    verticalHint: baseSemantic?.vertical || '',
    intentFamilyHint: intentFamily,
    sourceMerchantHint: 'external_seed',
    limit: 18,
    minFocusedCandidates: 12,
    overfetchMultiplier: 1,
    queryTimeoutCapMs: 3000,
  });

  const filteredCandidates = (Array.isArray(catalogCandidates) ? catalogCandidates : [])
    .filter((candidate) => productId(candidate) !== externalProductId);

  const aggregatePick = pickLayeredRecommendations({
    baseProduct,
    internalCandidates: [],
    externalCandidates: filteredCandidates,
    k: 18,
    baseSemantic,
  });

  const candidate_results = filteredCandidates.map((candidate) => {
    const soloPick = pickLayeredRecommendations({
      baseProduct,
      internalCandidates: [],
      externalCandidates: [candidate],
      k: 1,
      baseSemantic,
    });
    return {
      candidate: summarizeProduct(candidate),
      solo_pick: summarizePick(soloPick),
    };
  });

  return {
    external_product_id: externalProductId,
    base: {
      ...summarizeProduct(baseProduct),
      leaf_category: leaf || null,
      parent_category: parent || null,
      semantic: baseSemantic || null,
      category_path_hint: categoryPath || null,
      intent_family_hint: intentFamily || null,
    },
    catalog_fetch_stats: catalogCandidates.__catalogFetchStats || null,
    catalog_candidate_count_excluding_base: filteredCandidates.length,
    aggregate_pick: summarizePick(aggregatePick),
    candidate_results,
  };
}

async function main() {
  const out = argValue('out');
  const payload = {
    generated_at: new Date().toISOString(),
    targets: [],
  };
  for (const id of TARGET_IDS) {
    payload.targets.push(await probeOne(id));
  }
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (out) {
    ensureParentDir(out);
    fs.writeFileSync(out, text);
  }
  process.stdout.write(text);
}

main()
  .catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closePool();
    } catch {}
  });
