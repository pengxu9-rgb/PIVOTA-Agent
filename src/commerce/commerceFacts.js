const DEFAULT_CONTRACT_VERSION = 'commerce_facts.v1';

const MARKET_CURRENCY_TARGET = Object.freeze({
  US: 'USD',
  'EU-DE': 'EUR',
  SG: 'SGD',
  JP: 'JPY',
  CN: 'CNY',
  KR: 'KRW',
});

const MARKET_COUNTRY = Object.freeze({
  US: 'US',
  'EU-DE': 'DE',
  SG: 'SG',
  JP: 'JP',
  CN: 'CN',
  KR: 'KR',
});

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeMarketId(value) {
  const normalized = asString(value || 'US').toUpperCase();
  return MARKET_CURRENCY_TARGET[normalized] ? normalized : 'US';
}

function normalizeCurrency(value) {
  const normalized = asString(value).toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : '';
}

function normalizeAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = asString(value).replace(/[^0-9.-]+/g, '');
  if (!cleaned) return null;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeAvailabilityStatus(value) {
  const normalized = asString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['in_stock', 'out_of_stock', 'low_stock', 'preorder', 'unknown'].includes(normalized)) {
    return normalized;
  }
  if (/out.*stock|sold.*out|unavailable/.test(normalized)) return 'out_of_stock';
  if (/pre.*order/.test(normalized)) return 'preorder';
  if (/low.*stock/.test(normalized)) return 'low_stock';
  if (/in.*stock|available/.test(normalized)) return 'in_stock';
  return 'unknown';
}

function isSupportedConfidence(value) {
  return ['high', 'medium', 'low', 'unknown'].includes(asString(value).toLowerCase());
}

function normalizeConfidence(value, fallback = 'unknown') {
  const normalized = asString(value).toLowerCase();
  return isSupportedConfidence(normalized) ? normalized : fallback;
}

function normalizePriceType(value) {
  const normalized = asString(value).toLowerCase();
  return ['list', 'sale', 'from', 'member', 'range', 'unknown'].includes(normalized) ? normalized : 'unknown';
}

function normalizeMarketSwitchStatus(value) {
  const normalized = asString(value).toLowerCase();
  return ['ok', 'mismatch', 'failed', 'unknown'].includes(normalized) ? normalized : 'unknown';
}

function normalizeCommerceFactsV1(rawFacts, row = {}, options = {}) {
  const raw = asPlainObject(rawFacts);
  const seedData = asPlainObject(row.seed_data);
  const snapshot = asPlainObject(seedData.snapshot);
  const marketId = normalizeMarketId(raw.market_id || row.market || options.market);
  const currencyTarget = normalizeCurrency(raw.currency_target) || MARKET_CURRENCY_TARGET[marketId] || 'USD';
  const capturedAt =
    asString(raw.captured_at) ||
    asString(snapshot.extracted_at) ||
    asString(seedData.extracted_at) ||
    asString(options.capturedAt) ||
    new Date().toISOString();
  const evidenceUrl =
    asString(raw.evidence_url) ||
    asString(row.destination_url) ||
    asString(row.canonical_url) ||
    asString(seedData.destination_url) ||
    asString(snapshot.destination_url) ||
    asString(snapshot.canonical_url);
  const regionalPrice = asPlainObject(raw.regional_price);
  const availability = asPlainObject(raw.availability);
  const shipping = asPlainObject(raw.shipping);
  const returns = asPlainObject(raw.returns);
  const sellableRegion = asPlainObject(raw.sellable_region);
  const sourceAuthority = asString(raw.source_authority) || 'catalog_extract_v2';
  const observedCurrency =
    normalizeCurrency(regionalPrice.observed_currency) ||
    normalizeCurrency(regionalPrice.currency) ||
    normalizeCurrency(row.price_currency || seedData.price_currency || snapshot.price_currency);
  const priceAmount =
    normalizeAmount(regionalPrice.amount) ??
    normalizeAmount(row.price_amount ?? seedData.price_amount ?? snapshot.price_amount);
  const availabilityStatus = normalizeAvailabilityStatus(
    availability.status || row.availability || seedData.availability || snapshot.availability,
  );

  return {
    contract_version: DEFAULT_CONTRACT_VERSION,
    market_id: marketId,
    country: asString(raw.country) || MARKET_COUNTRY[marketId],
    currency_target: currencyTarget,
    source_authority: sourceAuthority,
    captured_at: capturedAt,
    evidence_url: evidenceUrl,
    sellable_region: {
      status: ['eligible', 'not_eligible', 'unknown'].includes(asString(sellableRegion.status))
        ? asString(sellableRegion.status)
        : 'unknown',
      countries: Array.isArray(sellableRegion.countries)
        ? sellableRegion.countries.map(asString).filter(Boolean)
        : [],
      evidence_source: asString(sellableRegion.evidence_source) || sourceAuthority,
      confidence: normalizeConfidence(sellableRegion.confidence),
      checked_at: asString(sellableRegion.checked_at) || capturedAt,
      reason_codes: Array.isArray(sellableRegion.reason_codes)
        ? sellableRegion.reason_codes.map(asString).filter(Boolean)
        : ['shipping_destination_not_verified'],
      evidence_url: asString(sellableRegion.evidence_url) || evidenceUrl,
    },
    regional_price: {
      amount: priceAmount,
      currency: observedCurrency || null,
      display_raw: asString(regionalPrice.display_raw) || null,
      price_type: normalizePriceType(regionalPrice.price_type),
      compare_at_amount: normalizeAmount(regionalPrice.compare_at_amount),
      compare_at_currency: normalizeCurrency(regionalPrice.compare_at_currency) || null,
      compare_at_display_raw: asString(regionalPrice.compare_at_display_raw) || null,
      range_min: normalizeAmount(regionalPrice.range_min) ?? undefined,
      range_max: normalizeAmount(regionalPrice.range_max) ?? undefined,
      tax_included:
        regionalPrice.tax_included === true || regionalPrice.tax_included === false
          ? regionalPrice.tax_included
          : 'unknown',
      confidence: normalizeConfidence(regionalPrice.confidence || raw.currency_confidence, 'low'),
      market_switch_status: normalizeMarketSwitchStatus(regionalPrice.market_switch_status || raw.market_switch_status),
      observed_currency: observedCurrency || null,
      source_url: asString(regionalPrice.source_url) || evidenceUrl,
      captured_at: asString(regionalPrice.captured_at) || capturedAt,
    },
    availability: {
      status: availabilityStatus,
      source: asString(availability.source) || sourceAuthority,
      confidence: normalizeConfidence(availability.confidence, availabilityStatus === 'unknown' ? 'unknown' : 'medium'),
      captured_at: asString(availability.captured_at) || capturedAt,
    },
    shipping: {
      status: ['available', 'unavailable', 'unknown'].includes(asString(shipping.status))
        ? asString(shipping.status)
        : 'unknown',
      ...(asString(shipping.destination_country) ? { destination_country: asString(shipping.destination_country) } : {}),
      ...(asString(shipping.method_label) ? { method_label: asString(shipping.method_label) } : {}),
      source: asString(shipping.source) || sourceAuthority,
      confidence: normalizeConfidence(shipping.confidence),
      reason_codes: Array.isArray(shipping.reason_codes)
        ? shipping.reason_codes.map(asString).filter(Boolean)
        : ['external_checkout_not_queried'],
      checked_at: asString(shipping.checked_at) || capturedAt,
    },
    promotions: Array.isArray(raw.promotions)
      ? raw.promotions
          .map((promo) => {
            const item = asPlainObject(promo);
            const summary = asString(item.summary);
            if (!summary) return null;
            return {
              promo_type: asString(item.promo_type) || 'unknown',
              summary,
              ...(asString(item.terms) ? { terms: asString(item.terms) } : {}),
              ...(asString(item.starts_at) ? { starts_at: asString(item.starts_at) } : {}),
              ...(asString(item.ends_at) ? { ends_at: asString(item.ends_at) } : {}),
              source: asString(item.source) || sourceAuthority,
              confidence: normalizeConfidence(item.confidence, 'low'),
              ...(asString(item.evidence_url) ? { evidence_url: asString(item.evidence_url) } : {}),
            };
          })
          .filter(Boolean)
      : [],
    returns: {
      status: ['available', 'unavailable', 'unknown'].includes(asString(returns.status))
        ? asString(returns.status)
        : 'unknown',
      source: asString(returns.source) || sourceAuthority,
      confidence: normalizeConfidence(returns.confidence),
      reason_codes: Array.isArray(returns.reason_codes)
        ? returns.reason_codes.map(asString).filter(Boolean)
        : ['external_returns_not_extracted'],
      checked_at: asString(returns.checked_at) || capturedAt,
    },
  };
}

function buildCommerceFactsFromSeedRow(row = {}, options = {}) {
  const seedData = asPlainObject(row.seed_data);
  const snapshot = asPlainObject(seedData.snapshot);
  const marketId = normalizeMarketId(row.market || options.market);
  const capturedAt = asString(options.capturedAt) || asString(snapshot.extracted_at) || new Date().toISOString();
  const priceCurrency = normalizeCurrency(row.price_currency || seedData.price_currency || snapshot.price_currency);
  const priceAmount = normalizeAmount(row.price_amount ?? seedData.price_amount ?? snapshot.price_amount);
  const evidenceUrl =
    asString(row.destination_url) ||
    asString(row.canonical_url) ||
    asString(seedData.destination_url) ||
    asString(snapshot.destination_url) ||
    asString(snapshot.canonical_url);
  return normalizeCommerceFactsV1(
    {
      market_id: marketId,
      country: MARKET_COUNTRY[marketId],
      currency_target: MARKET_CURRENCY_TARGET[marketId],
      source_authority: options.sourceAuthority || 'catalog_extract_v2',
      captured_at: capturedAt,
      evidence_url: evidenceUrl,
      sellable_region: {
        status: 'unknown',
        countries: [],
        confidence: 'unknown',
        reason_codes: ['shipping_destination_not_verified'],
      },
      regional_price: {
        amount: priceAmount,
        currency: priceCurrency || null,
        observed_currency: priceCurrency || null,
        price_type: 'unknown',
        confidence: priceCurrency ? 'medium' : 'low',
        market_switch_status:
          priceCurrency && priceCurrency === MARKET_CURRENCY_TARGET[marketId] ? 'ok' : priceCurrency ? 'mismatch' : 'unknown',
        source_url: evidenceUrl,
        captured_at: capturedAt,
      },
      availability: {
        status: normalizeAvailabilityStatus(row.availability || seedData.availability || snapshot.availability),
        confidence: 'medium',
      },
      shipping: {
        status: 'unknown',
        confidence: 'unknown',
        reason_codes: ['external_checkout_not_queried'],
      },
      promotions: [],
      returns: {
        status: 'unknown',
        confidence: 'unknown',
        reason_codes: ['external_returns_not_extracted'],
      },
    },
    row,
    { market: marketId, capturedAt },
  );
}

function readCommerceFactsV1(row = {}) {
  const seedData = asPlainObject(row.seed_data);
  const snapshot = asPlainObject(seedData.snapshot);
  const seedFacts = asPlainObject(seedData.commerce_facts_v1);
  const snapshotFacts = asPlainObject(snapshot.commerce_facts_v1);
  const raw =
    seedFacts.contract_version === DEFAULT_CONTRACT_VERSION
      ? seedFacts
      : snapshotFacts.contract_version === DEFAULT_CONTRACT_VERSION
        ? snapshotFacts
        : null;
  return raw ? normalizeCommerceFactsV1(raw, row) : null;
}

function attachCommerceFactsToSeedRow(row = {}, rawFacts = null, options = {}) {
  const seedData = asPlainObject(row.seed_data);
  const snapshot = asPlainObject(seedData.snapshot);
  const facts = rawFacts
    ? normalizeCommerceFactsV1(rawFacts, row, options)
    : buildCommerceFactsFromSeedRow(row, options);
  return {
    ...row,
    seed_data: {
      ...seedData,
      commerce_facts_v1: facts,
      snapshot: {
        ...snapshot,
        commerce_facts_v1: facts,
      },
    },
  };
}

function validateCommerceFactsGateForSeedRow(row = {}, options = {}) {
  const marketId = normalizeMarketId(row.market || options.market);
  const expectedCurrency = MARKET_CURRENCY_TARGET[marketId] || 'USD';
  const seedData = asPlainObject(row.seed_data);
  const facts = readCommerceFactsV1(row);
  const topCurrency = normalizeCurrency(row.price_currency || seedData.price_currency);
  const observedCurrency = normalizeCurrency(facts?.regional_price?.observed_currency || facts?.regional_price?.currency || topCurrency);
  const marketSwitchStatus = normalizeMarketSwitchStatus(facts?.regional_price?.market_switch_status);
  const problems = [];

  if (marketId === 'US' && topCurrency && topCurrency !== 'USD') {
    problems.push('market_currency_mismatch');
  }
  if (marketId === 'US' && observedCurrency && observedCurrency !== 'USD') {
    problems.push('commerce_facts_currency_mismatch');
  }
  if (facts && ['mismatch', 'failed'].includes(marketSwitchStatus)) {
    problems.push('commerce_facts_market_switch_not_ok');
  }
  if (options.requireTransactionReady !== false) {
    if (!(normalizeAmount(row.price_amount ?? seedData.price_amount) > 0)) problems.push('missing_transaction_price');
    if (!observedCurrency && !topCurrency) problems.push('missing_transaction_currency');
    if (!asString(row.availability || seedData.availability)) problems.push('missing_transaction_availability');
    if (!asString(row.image_url || seedData.image_url)) problems.push('missing_transaction_image');
  }
  if (
    options.requireMergeCandidate === true ||
    seedData.requires_multi_offer_merge_validation === true ||
    asPlainObject(seedData.source_validation).requires_multi_offer_merge_validation === true
  ) {
    const merge = asPlainObject(seedData.multi_offer_merge_candidate || seedData.multi_offer_merge_validation);
    const status = asString(merge.status);
    if (!['candidate', 'matched', 'pass', 'approved'].includes(status)) {
      problems.push('missing_multi_offer_merge_candidate');
    }
  }

  const status = problems.length ? 'hold' : 'pass';
  return {
    status,
    market_id: marketId,
    expected_currency: expectedCurrency,
    observed_currency: observedCurrency || topCurrency || null,
    market_switch_status: facts ? marketSwitchStatus : 'not_available',
    sellable_region_status: facts?.sellable_region?.status || 'unknown',
    shipping_status: facts?.shipping?.status || 'unknown',
    promotions_status: facts?.promotions?.length ? 'available' : 'unknown',
    availability_status: facts?.availability?.status || normalizeAvailabilityStatus(row.availability || seedData.availability),
    problems,
  };
}

function buildAgentSafeCommerceFacts(rowOrFacts = {}) {
  const facts = rowOrFacts.contract_version === DEFAULT_CONTRACT_VERSION
    ? normalizeCommerceFactsV1(rowOrFacts)
    : readCommerceFactsV1(rowOrFacts);
  if (!facts) return null;
  const canState = (confidence) => ['high', 'medium'].includes(normalizeConfidence(confidence));
  return {
    contract_version: DEFAULT_CONTRACT_VERSION,
    market_id: facts.market_id,
    price:
      canState(facts.regional_price.confidence) && facts.regional_price.market_switch_status === 'ok'
        ? facts.regional_price
        : { status: 'unverified', reason: 'low_confidence_or_market_mismatch' },
    availability: canState(facts.availability.confidence)
      ? facts.availability
      : { status: 'unknown', reason: 'low_confidence_or_missing' },
    shipping:
      facts.shipping.status !== 'unknown' && canState(facts.shipping.confidence)
        ? facts.shipping
        : { status: 'unknown', reason: 'verify_at_checkout' },
    promotions: facts.promotions.filter((promo) => canState(promo.confidence)),
    checkout_note:
      facts.shipping.status === 'unknown' || !facts.promotions.length
        ? 'Shipping and promotions are not verified for this external offer; verify at merchant checkout.'
        : undefined,
  };
}

module.exports = {
  MARKET_CURRENCY_TARGET,
  MARKET_COUNTRY,
  normalizeCommerceFactsV1,
  buildCommerceFactsFromSeedRow,
  readCommerceFactsV1,
  attachCommerceFactsToSeedRow,
  validateCommerceFactsGateForSeedRow,
  buildAgentSafeCommerceFacts,
  normalizeAvailabilityStatus,
};
