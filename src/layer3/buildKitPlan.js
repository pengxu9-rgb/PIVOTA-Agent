const axios = require('axios');
const { ProductAttributesV0Schema, ProductCategorySchema } = require('./schemas/productAttributesV0');
const { KitPlanV0Schema } = require('./schemas/kitPlanV0');
const { getCandidates } = require('./retrieval/getCandidates');
const { normalizeSkuToAttributes } = require('./normalize/normalizeSkuToAttributes');
const { rankCandidates } = require('./ranking/rankCandidates');
const { buildWhyThis } = require('./copy/whyThis');

const INFRA_API_BASE = (process.env.PIVOTA_API_BASE || 'http://localhost:8080').replace(/\/$/, '');
const OUTBOUND_LINKS_TOOL = String(process.env.OUTBOUND_LINKS_TOOL || 'look_replicator');
const OUTBOUND_LINKS_ENABLED = process.env.NODE_ENV === 'production' || String(process.env.LAYER3_OUTBOUND_LINKS || '') === '1';
const EXTERNAL_OFFERS_ENABLED = process.env.NODE_ENV === 'production' || String(process.env.LAYER3_EXTERNAL_OFFERS || '') === '1';

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
    ...(normalized.merchantId ? { merchantId: normalized.merchantId } : {}),
    name: normalized.name,
    brand: normalized.brand,
    price: normalized.price,
    priceTier: normalized.priceTier,
    imageUrl: normalized.imageUrl,
    productUrl: normalized.productUrl,
    ...(normalized.purchaseEnabled != null ? { purchaseEnabled: normalized.purchaseEnabled } : {}),
    availability: normalized.availability,
    availabilityByMarket: normalized.availabilityByMarket,
    tags: normalized.tags,
    undertoneFit: normalized.undertoneFit,
    shadeDescriptor: normalized.shadeDescriptor,
    whyThis,
    evidence,
  });
}

function isLikelyBadName(name) {
  const n = String(name || '').trim().toLowerCase();
  return !n || n === 'default title' || n.startsWith('placeholder ') || n.startsWith('占位符');
}

function deriveUsdTier(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 'unknown';
  if (n <= 15) return 'budget';
  if (n <= 35) return 'mid';
  return 'premium';
}

function brandCandidatesForOutboundLinks(rawBrand) {
  const raw = typeof rawBrand === 'string' ? rawBrand.trim() : '';
  if (!raw) return [];

  const lower = raw.toLowerCase();
  const simplified = lower
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const compact = simplified.replace(/\s+/g, '');

  const canonical = [];
  if (simplified === 'mac' || simplified.startsWith('mac ')) canonical.push('mac');
  if (simplified === 'm a c' || simplified.startsWith('m a c ')) canonical.push('mac');
  if (simplified.startsWith('tom ford')) canonical.push('tom ford');

  const out = [canonical[0], canonical[1], simplified, compact, lower]
    .filter(Boolean)
    .map((v) => String(v).trim())
    .filter(Boolean);
  return Array.from(new Set(out));
}

async function applyOutboundLinkAndExternalOffer({ market, area, kind, product, jobId }) {
  if (!OUTBOUND_LINKS_ENABLED || !INFRA_API_BASE) return;
  if (!product?.skuId) return;

  let resolved = null;
  const brandCandidates = brandCandidatesForOutboundLinks(product.brand);
  const brandsToTry = brandCandidates.length ? brandCandidates : [String(product.brand || '').trim()].filter(Boolean);

  for (const brand of brandsToTry) {
    try {
      const res = await axios.post(
        `${INFRA_API_BASE}/api/links/resolve`,
        {
          market,
          tool: OUTBOUND_LINKS_TOOL,
          candidates: {
            skuId: product.skuId,
            brand,
            category: area,
          },
          context: {
            area,
            kind,
            ...(jobId ? { jobId } : {}),
          },
        },
        { timeout: 5000 },
      );
      if (res?.data?.matched) {
        resolved = res.data.resolved ?? null;
        break;
      }
    } catch {
      // try next
    }
  }

  if (!resolved?.redirectUrl) return;

  product.productUrl = resolved.redirectUrl;
  product.purchaseEnabled = Boolean(resolved.purchaseEnabled);

  const shouldEnrich =
    EXTERNAL_OFFERS_ENABLED &&
    resolved.destinationUrl &&
    (product.purchaseEnabled === false || !product.imageUrl || isLikelyBadName(product.name) || !product.price?.amount);

  if (!shouldEnrich) return;

  try {
    const offerRes = await axios.post(
      `${INFRA_API_BASE}/api/offers/external/resolve`,
      { market, url: resolved.destinationUrl },
      { timeout: 8000 },
    );
    const offer = offerRes?.data?.ok ? offerRes.data.offer : null;
    if (!offer) return;

    if (offer.title && isLikelyBadName(product.name)) {
      product.name = offer.title;
    }
    if (offer.brand && (!product.brand || String(product.brand).toLowerCase() === 'unknown' || String(product.brand).trim() === '未知')) {
      product.brand = String(offer.brand);
    }
    if (offer.imageUrl && !product.imageUrl) {
      product.imageUrl = offer.imageUrl;
    }
    if (offer.price?.currency && typeof offer.price.amount === 'number' && offer.price.amount > 0) {
      if (!product.price?.amount || product.price.amount <= 0) {
        product.price = { currency: offer.price.currency, amount: offer.price.amount };
      }
      if (market === 'US' && offer.price.currency === 'USD') {
        product.priceTier = deriveUsdTier(offer.price.amount);
      } else {
        product.priceTier = 'unknown';
      }
    }
    if (offer.availability) {
      product.availability = offer.availability;
      product.availabilityByMarket = market === 'US' ? { US: offer.availability } : { JP: offer.availability };
    }
  } catch {
    // best-effort: keep original product data
  }
}

async function buildKitPlan(input) {
  const { market, locale, lookSpec } = input;
  if (market !== 'US' && market !== 'JP') throw new Error('MARKET_NOT_SUPPORTED');
  const versions = engineVersionFor(market);
  const debugTriggerMatch = String(process.env.LAYER3_TRIGGER_MATCH_DEBUG || '').trim() === '1';
  const userProfile = input.userProfile ?? null;
  const userSignals = input.userSignals ?? null;
  const jobId = input.jobId ? String(input.jobId) : null;

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

  // Best-effort enrichment:
  // - Apply outbound link rules (external-only + redirect tracking) via infra.
  // - If external-only, optionally fetch external metadata (title/image/price) from cached OG/JSON-LD snapshots.
  try {
    const tasks = [];
    for (const area of Object.keys(kit)) {
      const slot = kit[area];
      if (!slot?.best || !slot?.dupe) continue;
      tasks.push(applyOutboundLinkAndExternalOffer({ market, area, kind: 'best', product: slot.best, jobId }));
      tasks.push(applyOutboundLinkAndExternalOffer({ market, area, kind: 'dupe', product: slot.dupe, jobId }));
    }
    await Promise.all(tasks);
  } catch {
    // ignore
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
