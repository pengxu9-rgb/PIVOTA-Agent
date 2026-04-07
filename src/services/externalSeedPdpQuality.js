const { ensureJsonObject, normalizeNonEmptyString } = require('./externalSeedRecall');

const POLLUTED_FACTS_RE =
  /\b(contact us|customer service|privacy policy|terms(?: and conditions)?|shipping policy|return policy|about us|blog|blogs|impact|foundation transparency|transparency|give 20%|donation|donate|store locator|support)\b/i;

function normalizeAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(String(value || '').replace(/[^0-9.-]+/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickExtractorPrice(product = {}) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const variantPrice = variants
    .map((variant) => normalizeAmount(variant?.price ?? variant?.price_amount))
    .find((value) => value > 0);
  if (variantPrice > 0) return variantPrice;
  return normalizeAmount(product.price ?? product.price_amount);
}

function pickLivePdpPrice(livePayload = {}) {
  const modules = Array.isArray(livePayload?.modules) ? livePayload.modules : [];
  const priceModule = modules.find((module) => module?.type === 'price_promo');
  return normalizeAmount(priceModule?.data?.price?.amount);
}

function collectProductDetailsText(livePayload = {}) {
  const modules = Array.isArray(livePayload?.modules) ? livePayload.modules : [];
  return modules
    .filter((module) => module?.type === 'product_details')
    .flatMap((module) => (Array.isArray(module?.data?.sections) ? module.data.sections : []))
    .map((section) => normalizeNonEmptyString(section?.content))
    .filter(Boolean);
}

function collectProductFactsText(livePayload = {}) {
  const modules = Array.isArray(livePayload?.modules) ? livePayload.modules : [];
  return modules
    .filter((module) => module?.type === 'product_facts')
    .flatMap((module) => (Array.isArray(module?.data?.sections) ? module.data.sections : []))
    .map((section) => [section?.heading, section?.content].filter(Boolean).join(' '))
    .map((value) => normalizeNonEmptyString(value))
    .filter(Boolean);
}

function buildSeedGate(audit = {}) {
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const blocked = findings.filter((finding) => String(finding?.severity || '').trim().toLowerCase() === 'blocker');
  return {
    status: blocked.length > 0 ? 'failed' : 'passed',
    findings_count: findings.length,
    blockers_count: blocked.length,
  };
}

function buildExtractorGate({ extractorResponse = {}, extractorProduct = {} } = {}) {
  const diagnostics = ensureJsonObject(extractorResponse?.diagnostics);
  const failureCategory = normalizeNonEmptyString(diagnostics.failure_category);
  const descriptionPresent = Boolean(
    normalizeNonEmptyString(extractorProduct?.description_raw || extractorProduct?.description),
  );
  const price = pickExtractorPrice(extractorProduct);
  const failureReasons = [];
  if (failureCategory) failureReasons.push('extractor_failure');
  return {
    status: failureReasons.length ? 'failed' : 'passed',
    failure_category: failureCategory || null,
    description_present: descriptionPresent,
    price_amount: price || null,
    failure_reasons: failureReasons,
  };
}

function buildLivePdpGate({ extractorProduct = {}, livePayload = {} } = {}) {
  const extractorPrice = pickExtractorPrice(extractorProduct);
  const livePrice = pickLivePdpPrice(livePayload);
  const detailsText = collectProductDetailsText(livePayload);
  const factsText = collectProductFactsText(livePayload);
  const extractorHasDescription = Boolean(
    normalizeNonEmptyString(extractorProduct?.description_raw || extractorProduct?.description),
  );
  const failureReasons = [];

  if (extractorPrice > 0 && livePrice > 0 && Math.abs(extractorPrice - livePrice) > 0.01) {
    failureReasons.push('price_mismatch');
  }
  if (extractorHasDescription && detailsText.length === 0) {
    failureReasons.push('missing_overview_from_available_description');
  }
  if (factsText.some((value) => POLLUTED_FACTS_RE.test(value))) {
    failureReasons.push('polluted_product_facts');
  }

  return {
    status: failureReasons.length ? 'failed' : 'passed',
    price_amount: livePrice || null,
    has_overview: detailsText.length > 0,
    failure_reasons: failureReasons,
  };
}

function buildSimilarGate({ similarResponse = {}, exclusionFlags = {} } = {}) {
  const products = Array.isArray(similarResponse?.products) ? similarResponse.products : [];
  const exempt =
    Boolean(exclusionFlags?.gift_card) ||
    Boolean(exclusionFlags?.donation_bundle) ||
    Boolean(exclusionFlags?.non_merchandise);
  const failureReasons = [];
  if (!exempt && products.length < 4) {
    failureReasons.push('similar_underfill');
  }
  return {
    status: failureReasons.length ? 'failed' : exempt ? 'exempt' : 'passed',
    similar_count: products.length,
    exempt,
    failure_reasons: failureReasons,
  };
}

function buildExternalSeedQualityResult({
  seedId = '',
  externalProductId = '',
  canonicalUrl = '',
  seedGate = {},
  extractorGate = {},
  livePdpGate = {},
  similarGate = {},
} = {}) {
  const failureReasons = [
    ...(Array.isArray(seedGate.failure_reasons) ? seedGate.failure_reasons : []),
    ...(Array.isArray(extractorGate.failure_reasons) ? extractorGate.failure_reasons : []),
    ...(Array.isArray(livePdpGate.failure_reasons) ? livePdpGate.failure_reasons : []),
    ...(Array.isArray(similarGate.failure_reasons) ? similarGate.failure_reasons : []),
  ].filter(Boolean);
  return {
    seed_id: normalizeNonEmptyString(seedId),
    external_product_id: normalizeNonEmptyString(externalProductId),
    canonical_url: normalizeNonEmptyString(canonicalUrl),
    seed_gate: seedGate,
    extractor_gate: extractorGate,
    live_pdp_gate: livePdpGate,
    similar_gate: similarGate,
    failure_reasons: Array.from(new Set(failureReasons)),
  };
}

module.exports = {
  pickExtractorPrice,
  pickLivePdpPrice,
  collectProductDetailsText,
  collectProductFactsText,
  buildSeedGate,
  buildExtractorGate,
  buildLivePdpGate,
  buildSimilarGate,
  buildExternalSeedQualityResult,
};
