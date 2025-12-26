const { ProductAttributesV0Schema, ProductCategorySchema } = require('./schemas/productAttributesV0');
const { KitPlanV0Schema } = require('./schemas/kitPlanV0');
const { getCandidates } = require('./retrieval/getCandidates');
const { normalizeSkuToAttributes } = require('./normalize/normalizeSkuToAttributes');
const { rankCandidates } = require('./ranking/rankCandidates');
const { buildWhyThis } = require('./copy/whyThis');

function makePlaceholder({ category, locale, kind, lookSpec, reason }) {
  const area = lookSpec.breakdown[category];
  const whyThis = `No catalog match found (${reason}). Placeholder for ${category} to target ${area.finish} finish and ${area.coverage} coverage.`;

  return ProductAttributesV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    locale,
    layer2EngineVersion: 'l2-us-0.1.0',
    layer3EngineVersion: 'l3-us-0.1.0',
    orchestratorVersion: 'orchestrator-us-0.1.0',
    category,
    skuId: `placeholder_${category}_${kind}`,
    name: `Placeholder ${category} (${kind})`,
    brand: 'Unknown',
    price: { currency: 'USD', amount: 0 },
    priceTier: 'unknown',
    imageUrl: undefined,
    productUrl: undefined,
    availability: 'unknown',
    availabilityByMarket: { US: 'unknown' },
    tags: { finish: [], texture: [], coverage: [], effect: [] },
    undertoneFit: 'unknown',
    shadeDescriptor: undefined,
    whyThis,
    evidence: [
      `lookSpec.breakdown.${category}.finish`,
      `lookSpec.breakdown.${category}.coverage`,
      'product.priceTier',
      'product.availabilityByMarket.US',
    ],
  });
}

function toProductAttributes({ locale, lookSpec, normalized, category }) {
  const { whyThis, evidence } = buildWhyThis({ category, candidate: normalized, lookSpec });
  return ProductAttributesV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    locale,
    layer2EngineVersion: 'l2-us-0.1.0',
    layer3EngineVersion: 'l3-us-0.1.0',
    orchestratorVersion: 'orchestrator-us-0.1.0',
    category,
    skuId: normalized.skuId,
    name: normalized.name,
    brand: normalized.brand,
    price: normalized.price,
    priceTier: normalized.priceTier,
    imageUrl: normalized.imageUrl,
    productUrl: normalized.productUrl,
    availability: normalized.availability,
    availabilityByMarket: normalized.availabilityByMarket,
    tags: normalized.tags,
    undertoneFit: normalized.undertoneFit,
    shadeDescriptor: normalized.shadeDescriptor,
    whyThis,
    evidence,
  });
}

async function buildKitPlan(input) {
  const { market, locale, lookSpec } = input;
  if (market !== 'US') throw new Error('MARKET_NOT_SUPPORTED');

  const warnings = [];
  const candidatesByCategory =
    input.candidatesByCategory ??
    (await getCandidates({
      market,
      locale,
      lookSpec,
      limitPerCategory: input.limitPerCategory,
    }));

  function buildArea(category, rawCandidates) {
    if (!rawCandidates.length) {
      warnings.push(`NO_CANDIDATES:${category}`);
      return {
        best: makePlaceholder({ category, locale, kind: 'best', lookSpec, reason: 'NO_CANDIDATES' }),
        dupe: makePlaceholder({ category, locale, kind: 'dupe', lookSpec, reason: 'NO_CANDIDATES' }),
      };
    }

    const normalized = rawCandidates
      .map((sku) => normalizeSkuToAttributes({ market, locale, category, sku }))
      .filter(Boolean);

    const ranked = rankCandidates({ category, lookSpec, candidates: normalized });
    for (const w of ranked.warnings) warnings.push(`${w}:${category}`);

    const best = ranked.best ?? normalizeSkuToAttributes({ market, locale, category, sku: rawCandidates[0] });
    const dupe =
      ranked.dupe ??
      normalizeSkuToAttributes({ market, locale, category, sku: rawCandidates[Math.min(1, rawCandidates.length - 1)] });

    return {
      best: toProductAttributes({ locale, lookSpec, normalized: best, category }),
      dupe: toProductAttributes({ locale, lookSpec, normalized: dupe, category }),
    };
  }

  const kit = {
    base: buildArea('base', candidatesByCategory.base || []),
    eye: buildArea('eye', candidatesByCategory.eye || []),
    lip: buildArea('lip', candidatesByCategory.lip || []),
  };

  return KitPlanV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    locale,
    layer2EngineVersion: 'l2-us-0.1.0',
    layer3EngineVersion: 'l3-us-0.1.0',
    orchestratorVersion: 'orchestrator-us-0.1.0',
    kit,
    ...(warnings.length ? { warnings } : {}),
  });
}

module.exports = {
  buildKitPlan,
};

