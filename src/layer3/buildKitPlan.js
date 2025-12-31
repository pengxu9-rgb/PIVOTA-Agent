const { ProductAttributesV0Schema, ProductCategorySchema } = require('./schemas/productAttributesV0');
const { KitPlanV0Schema } = require('./schemas/kitPlanV0');
const { getCandidates } = require('./retrieval/getCandidates');
const { normalizeSkuToAttributes } = require('./normalize/normalizeSkuToAttributes');
const { rankCandidates } = require('./ranking/rankCandidates');
const { buildWhyThis } = require('./copy/whyThis');

function engineVersionFor(market) {
  const m = String(market || 'US').toLowerCase();
  return {
    layer2: `l2-${m}-0.1.0`,
    layer3: `l3-${m}-0.1.0`,
    orchestrator: `orchestrator-${m}-0.1.0`,
  };
}

function isZhLocale(locale) {
  const s = String(locale || '').trim().toLowerCase().replace(/_/g, '-');
  return s === 'zh' || s.startsWith('zh-');
}

function zhCategoryLabel(category) {
  if (category === 'prep') return '妆前';
  if (category === 'base') return '底妆';
  if (category === 'contour') return '修容';
  if (category === 'brow') return '眉';
  if (category === 'eye') return '眼妆';
  if (category === 'blush') return '腮红';
  if (category === 'lip') return '唇妆';
  return String(category || '');
}

function makePlaceholder({ market, locale, kind, lookSpec, category, reason, purchaseEnabled }) {
  const area = lookSpec.breakdown[category];
  const whyThis = isZhLocale(locale)
    ? `暂未从商品库找到匹配（${reason}）。先用占位符：${zhCategoryLabel(category)}（目标妆效：${area.finish}，覆盖度：${area.coverage}）。`
    : `No catalog match found (${reason}). Placeholder for ${category} to target ${area.finish} finish and ${area.coverage} coverage.`;
  const versions = engineVersionFor(market);

  return ProductAttributesV0Schema.parse({
    schemaVersion: 'v0',
    market,
    locale,
    layer2EngineVersion: versions.layer2,
    layer3EngineVersion: versions.layer3,
    orchestratorVersion: versions.orchestrator,
    category,
    skuId: `placeholder_${category}_${kind}`,
    name: isZhLocale(locale) ? `占位符 ${zhCategoryLabel(category)}（${kind}）` : `Placeholder ${category} (${kind})`,
    brand: isZhLocale(locale) ? '未知' : 'Unknown',
    price: { currency: market === 'JP' ? 'JPY' : 'USD', amount: 0 },
    priceTier: 'unknown',
    imageUrl: undefined,
    productUrl: undefined,
    availability: 'unknown',
    availabilityByMarket: { ...(market === 'US' ? { US: 'unknown' } : { JP: 'unknown' }) },
    tags: { finish: [], texture: [], coverage: [], effect: [] },
    undertoneFit: 'unknown',
    shadeDescriptor: undefined,
    whyThis,
    evidence: [
      `lookSpec.breakdown.${category}.finish`,
      `lookSpec.breakdown.${category}.coverage`,
      'product.priceTier',
      market === 'US' ? 'product.availabilityByMarket.US' : 'product.availabilityByMarket.JP',
    ],
    ...(purchaseEnabled != null ? { purchaseEnabled } : {}),
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
  if (market !== 'US' && market !== 'JP') throw new Error('MARKET_NOT_SUPPORTED');
  const versions = engineVersionFor(market);
  const debugTriggerMatch = String(process.env.LAYER3_TRIGGER_MATCH_DEBUG || '').trim() === '1';
  const userProfile = input.userProfile ?? null;
  const userSignals = input.userSignals ?? null;

  // JP internal experiment: commerce is disabled; return role-based placeholders without blocking Layer2.
  if (market === 'JP' && input.commerceEnabled === false) {
    const kit = {
      base: {
        best: makePlaceholder({ market, locale, kind: 'best', lookSpec, category: 'base', reason: 'COMMERCE_DISABLED', purchaseEnabled: false }),
        dupe: makePlaceholder({ market, locale, kind: 'dupe', lookSpec, category: 'base', reason: 'COMMERCE_DISABLED', purchaseEnabled: false }),
      },
      eye: {
        best: makePlaceholder({ market, locale, kind: 'best', lookSpec, category: 'eye', reason: 'COMMERCE_DISABLED', purchaseEnabled: false }),
        dupe: makePlaceholder({ market, locale, kind: 'dupe', lookSpec, category: 'eye', reason: 'COMMERCE_DISABLED', purchaseEnabled: false }),
      },
      lip: {
        best: makePlaceholder({ market, locale, kind: 'best', lookSpec, category: 'lip', reason: 'COMMERCE_DISABLED', purchaseEnabled: false }),
        dupe: makePlaceholder({ market, locale, kind: 'dupe', lookSpec, category: 'lip', reason: 'COMMERCE_DISABLED', purchaseEnabled: false }),
      },
    };

    return KitPlanV0Schema.parse({
      schemaVersion: 'v0',
      market,
      locale,
      layer2EngineVersion: versions.layer2,
      layer3EngineVersion: versions.layer3,
      orchestratorVersion: versions.orchestrator,
      kit,
      warnings: ['COMMERCE_DISABLED:JP'],
    });
  }

  const warnings = [];
  const candidatesByCategory =
    input.candidatesByCategory ??
    (await getCandidates({
      market,
      locale,
      lookSpec,
      limitPerCategory: input.limitPerCategory,
    }));

  function buildArea(category, rawCandidates, opts) {
    if (!rawCandidates.length) {
      if (debugTriggerMatch) warnings.push(`NO_CANDIDATES market=${market} category=${category} candidates=0`);
      if (!opts?.allowPlaceholder) return null;
      return {
        best: makePlaceholder({ market, category, locale, kind: 'best', lookSpec, reason: 'NO_CANDIDATES', purchaseEnabled: false }),
        dupe: makePlaceholder({ market, category, locale, kind: 'dupe', lookSpec, reason: 'NO_CANDIDATES', purchaseEnabled: false }),
      };
    }

    const normalized = rawCandidates
      .map((sku) => normalizeSkuToAttributes({ market, locale, category, sku }))
      .filter(Boolean);

    const ranked = rankCandidates({ category, lookSpec, candidates: normalized, userProfile, userSignals });
    for (const w of ranked.warnings) {
      if (w === 'NO_CANDIDATES') {
        if (debugTriggerMatch) warnings.push(`NO_CANDIDATES market=${market} category=${category} candidates=${normalized.length}`);
      } else {
        warnings.push(`${w}:${category}`);
      }
    }

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
    base: buildArea('base', candidatesByCategory.base || [], { allowPlaceholder: true }),
    eye: buildArea('eye', candidatesByCategory.eye || [], { allowPlaceholder: true }),
    lip: buildArea('lip', candidatesByCategory.lip || [], { allowPlaceholder: true }),
  };

  for (const category of ['prep', 'contour', 'brow', 'blush']) {
    const slot = buildArea(category, candidatesByCategory[category] || [], { allowPlaceholder: false });
    if (slot) kit[category] = slot;
  }

  return KitPlanV0Schema.parse({
    schemaVersion: 'v0',
    market,
    locale,
    layer2EngineVersion: versions.layer2,
    layer3EngineVersion: versions.layer3,
    orchestratorVersion: versions.orchestrator,
    kit,
    ...(warnings.length ? { warnings } : {}),
  });
}

module.exports = {
  buildKitPlan,
};
