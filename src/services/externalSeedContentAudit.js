const { collectSeedImageUrls, ensureJsonObject, normalizeSeedVariants } = require('./externalSeedProducts');

const MARKET_LOCALE_SEGMENT = Object.freeze({
  US: 'en-us',
  'EU-DE': 'de-de',
  SG: 'en-sg',
  JP: 'ja-jp',
});
const MARKET_EXPECTED_CURRENCY = Object.freeze({
  US: 'USD',
  'EU-DE': 'EUR',
  SG: 'SGD',
  JP: 'JPY',
});

const LOCALE_PATH_SEGMENT_RE = /^[a-z]{2}(?:-|_)[a-z]{2}$/i;
const NON_PRODUCT_PATH_RE =
  /(?:^|\/)(?:collections?|collection|category|catalogsearch|search|cart|account|customer|blog|blogs|pages?|faq|privacy|terms|wishlist|gift(?:ing)?|store-locator|customer-service|all-products|appointments?|booking|online-booking|locations?|contact-us)(?:\/|$)/i;
const GENERIC_TEMPLATE_RE = /^experience the ultimate luxury with\s+/i;
const SYNTHETIC_SUMMARY_RE = /\bOFFICIAL:\b[\s\S]*\/\/\/\s*SOCIAL HIGHLIGHTS:/i;
const LANGUAGE_MARKERS = Object.freeze({
  de: [
    /\blichtschutzfaktor\b/i,
    /\bwei(?:ß|ss)e\b/i,
    /\bein\s+vielseitiges\b/i,
    /\bhaut\b/i,
    /\bhaare\b/i,
    /\bf(?:u|ü)r\b/i,
    /\bgegen\b/i,
  ],
  fr: [
    /\béclat\b/i,
    /\bpeau\b/i,
    /\bhydratant(?:e)?\b/i,
    /\bsoin\b/i,
    /\bcr(?:è|e)me\b/i,
    /\bregard\b/i,
    /\bbaume\b/i,
  ],
  es: [
    /\bprotecci(?:ó|o)n\b/i,
    /\bpiel\b/i,
    /\bhidrata(?:r|ci(?:ó|o)n)?\b/i,
    /\bsuero\b/i,
    /\bmanchas\b/i,
  ],
});

const ANOMALY_SEVERITY = Object.freeze({
  blocker: 'blocker',
  review: 'review',
  info: 'info',
});

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeUrlLike(value) {
  const normalized = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function normalizeUrlKey(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

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

function normalizeCurrency(value) {
  return normalizeNonEmptyString(value).toUpperCase();
}

function parseLocaleSegment(url) {
  const normalized = normalizeUrlLike(url);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const firstSegment = parsed.pathname.split('/').filter(Boolean)[0] || '';
    return LOCALE_PATH_SEGMENT_RE.test(firstSegment) ? firstSegment.toLowerCase() : '';
  } catch {
    return '';
  }
}

function localeSegmentsAreLanguageCompatible(expectedLocale, actualLocale) {
  const expected = normalizeNonEmptyString(expectedLocale).toLowerCase();
  const actual = normalizeNonEmptyString(actualLocale).toLowerCase();
  if (!expected || !actual) return false;
  if (expected === actual) return true;

  const [expectedLanguage] = expected.split(/[-_]/);
  const [actualLanguage] = actual.split(/[-_]/);
  return Boolean(expectedLanguage && actualLanguage && expectedLanguage === actualLanguage);
}

function getSnapshot(row) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return { seedData, snapshot };
}

function getCanonicalUrl(row, snapshot, seedData) {
  return normalizeUrlLike(
    snapshot?.canonical_url ||
      row?.canonical_url ||
      snapshot?.destination_url ||
      row?.destination_url ||
      seedData?.canonical_url ||
      seedData?.destination_url,
  );
}

function getLastExtractedAt(row, snapshot) {
  return normalizeNonEmptyString(snapshot?.extracted_at || row?.updated_at || row?.created_at);
}

function getPrimaryDescription(row) {
  const { seedData, snapshot } = getSnapshot(row);
  const snapshotVariants = Array.isArray(snapshot?.variants) ? snapshot.variants : [];
  const seedVariants = Array.isArray(seedData?.variants) ? seedData.variants : [];
  const variantDescription =
    snapshotVariants.find((variant) => normalizeNonEmptyString(variant?.description))?.description ||
    seedVariants.find((variant) => normalizeNonEmptyString(variant?.description))?.description;
  return normalizeNonEmptyString(variantDescription || snapshot?.description || row?.description || seedData?.description);
}

function getSeedDescriptionOrigin(row) {
  const { seedData, snapshot } = getSnapshot(row);
  return normalizeNonEmptyString(seedData.seed_description_origin || snapshot.seed_description_origin);
}

function getImageUrls(row) {
  const { seedData } = getSnapshot(row);
  return collectSeedImageUrls(seedData, row);
}

function getVariants(row) {
  const { seedData } = getSnapshot(row);
  return normalizeSeedVariants(seedData, row);
}

function buildFinding(row, snapshot, {
  anomalyType,
  severity,
  evidence,
  recommendedAction,
  autoFixable = false,
}) {
  const { seedData } = getSnapshot(row);
  return {
    seed_id: normalizeNonEmptyString(row?.id),
    domain: normalizeNonEmptyString(row?.domain),
    market: normalizeNonEmptyString(row?.market).toUpperCase(),
    canonical_url: getCanonicalUrl(row, snapshot, seedData),
    anomaly_type: anomalyType,
    severity,
    evidence,
    recommended_action: recommendedAction,
    auto_fixable: Boolean(autoFixable),
    last_extracted_at: getLastExtractedAt(row, snapshot),
  };
}

function detectLanguage(description) {
  const text = normalizeNonEmptyString(description);
  if (!text) return null;

  const scores = Object.entries(LANGUAGE_MARKERS).map(([language, patterns]) => ({
    language,
    matchedPatterns: patterns.filter((pattern) => pattern.test(text)),
  }));

  const winner = scores
    .map((score) => ({ ...score, matches: score.matchedPatterns.length }))
    .sort((left, right) => right.matches - left.matches)[0];

  if (!winner || winner.matches === 0) return null;

  if (winner.language === 'fr' && winner.matches === 1) {
    const onlyMatch = winner.matchedPatterns[0];
    if (onlyMatch && String(onlyMatch.source || '').includes('cr(?:è|e)me')) return null;
  }

  return winner.language;
}

function getLanguageAnomalyType(language) {
  if (language === 'fr') return 'fr_content_in_us_seed';
  if (language === 'de') return 'non_english_description_for_us_seed';
  if (language === 'es') return 'es_content_in_us_seed';
  return 'non_english_description_for_us_seed';
}

function detectGenericTemplateDescription(title, description) {
  const normalizedTitle = normalizeNonEmptyString(title);
  const normalizedDescription = normalizeNonEmptyString(description);
  if (!normalizedTitle || !normalizedDescription) return false;
  if (!GENERIC_TEMPLATE_RE.test(normalizedDescription)) return false;
  return normalizedDescription.toLowerCase().includes(normalizedTitle.toLowerCase());
}

function detectSyntheticSummaryDescription(description) {
  return SYNTHETIC_SUMMARY_RE.test(normalizeNonEmptyString(description));
}

function detectDuplicateVariantSkus(variants) {
  const counts = new Map();
  for (const variant of variants) {
    const sku = normalizeNonEmptyString(variant?.sku);
    if (!sku) continue;
    counts.set(sku, (counts.get(sku) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([sku, count]) => ({ sku, count }));
}

function detectNonProductFallback(row, title, description, canonicalUrl) {
  const path = (() => {
    try {
      return new URL(canonicalUrl).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (path && NON_PRODUCT_PATH_RE.test(path)) return true;
  const combined = `${normalizeNonEmptyString(title)} ${normalizeNonEmptyString(description)}`.toLowerCase();
  return (
    /\b(e-?gift\s*card|gift\s*card|gift\s*certificate|carte\s+cadeau)\b/i.test(combined) ||
    /\b(contact us|customer service|privacy policy|terms and conditions|promotional terms)\b/i.test(combined) ||
    /\b(this product is used for the app|bogos(?:\.io)?|free gift bogo bundle|buy x get y|secomapp)\b/i.test(combined)
  );
}

function detectPriceCurrencyMismatch(row, variants) {
  const rowCurrency = normalizeCurrency(row?.price_currency);
  const variantCurrencies = Array.from(
    new Set(variants.map((variant) => normalizeCurrency(variant?.currency)).filter(Boolean)),
  );
  if (!rowCurrency || variantCurrencies.length === 0) return null;
  if (variantCurrencies.length === 1 && variantCurrencies[0] === rowCurrency) return null;
  return {
    row_currency: rowCurrency,
    variant_currencies: variantCurrencies,
  };
}

function detectMarketCurrencyMismatch(row, variants, market, title, description) {
  const expectedCurrency = normalizeCurrency(MARKET_EXPECTED_CURRENCY[normalizeNonEmptyString(market).toUpperCase()]);
  if (!expectedCurrency) return null;

  const rowCurrency = normalizeCurrency(row?.price_currency);
  const variantCurrencies = Array.from(
    new Set(variants.map((variant) => normalizeCurrency(variant?.currency)).filter(Boolean)),
  );
  const mismatchedVariantCurrencies = variantCurrencies.filter((currency) => currency !== expectedCurrency);
  const hasRowMismatch = rowCurrency && rowCurrency !== expectedCurrency;
  if (!hasRowMismatch && mismatchedVariantCurrencies.length === 0) return null;

  return {
    market: normalizeNonEmptyString(market).toUpperCase(),
    expected_currency: expectedCurrency,
    row_currency: rowCurrency || null,
    variant_currencies: variantCurrencies,
    title_contains_currency_symbol: /€|\bEUR\b|\$|\bUSD\b/i.test(normalizeNonEmptyString(title)),
    description_contains_currency_symbol: /€|\bEUR\b|\$|\bUSD\b/i.test(normalizeNonEmptyString(description)),
  };
}

function collectSizeTitleCandidates(row, snapshot, seedData, variants) {
  const values = [
    snapshot?.title,
    row?.title,
    seedData?.title,
    ...variants.map((variant) => variant?.title),
  ];
  return Array.from(new Set(values.map((value) => normalizeNonEmptyString(value)).filter(Boolean)));
}

function detectMetricOnlySizeInUsSeed(row, snapshot, seedData, variants) {
  const market = normalizeNonEmptyString(row?.market).toUpperCase();
  if (market !== 'US') return null;

  const titles = collectSizeTitleCandidates(row, snapshot, seedData, variants);
  if (titles.length === 0) return null;

  const metricMatches = [];
  const imperialMatches = [];
  for (const title of titles) {
    const metric = title.match(/\b\d+(?:[.,]\d+)?\s?(?:ml|g|kg|l)\b/gi) || [];
    const imperial = title.match(/\b\d+(?:[.,]\d+)?\s?(?:fl\.?\s?oz|oz|lb|lbs)\b/gi) || [];
    if (metric.length > 0) metricMatches.push({ title, matches: metric });
    if (imperial.length > 0) imperialMatches.push({ title, matches: imperial });
  }

  if (metricMatches.length === 0 || imperialMatches.length > 0) return null;
  return {
    market,
    metric_only_titles: metricMatches.slice(0, 5),
  };
}

function auditExternalSeedRow(row, options = {}) {
  const findings = [];
  const { seedData, snapshot } = getSnapshot(row);
  const title = normalizeNonEmptyString(snapshot?.title || row?.title || seedData?.title);
  const description = getPrimaryDescription(row);
  const canonicalUrl = getCanonicalUrl(row, snapshot, seedData);
  const imageUrls = getImageUrls(row);
  const variants = getVariants(row);
  const market = normalizeNonEmptyString(row?.market).toUpperCase();
  const diagnostics = ensureJsonObject(snapshot?.diagnostics);
  const expectedLocale = MARKET_LOCALE_SEGMENT[market] || '';
  const localeSegment = parseLocaleSegment(canonicalUrl);
  const detectedLanguage = options.detectedLanguage || detectLanguage(description);
  const lastExtractedAt = getLastExtractedAt(row, snapshot);
  const seedDescriptionOrigin = getSeedDescriptionOrigin(row);
  const isNonProductFallback = canonicalUrl && detectNonProductFallback(row, title, description, canonicalUrl);

  if (expectedLocale && localeSegment && !localeSegmentsAreLanguageCompatible(expectedLocale, localeSegment)) {
    findings.push(
      buildFinding(row, snapshot, {
        anomalyType: 'locale_market_mismatch',
        severity: ANOMALY_SEVERITY.blocker,
        evidence: {
          expected_locale: expectedLocale,
          actual_locale: localeSegment,
          market,
        },
        recommendedAction: 'Normalize the seed URL locale segment to the requested market before extraction.',
        autoFixable: true,
      }),
    );
  }

  if (market === 'US' && detectedLanguage) {
    findings.push(
      buildFinding(row, snapshot, {
        anomalyType: getLanguageAnomalyType(detectedLanguage),
        severity: ANOMALY_SEVERITY.review,
        evidence: {
          detected_language: detectedLanguage,
          description_excerpt: description.slice(0, 280),
        },
        recommendedAction: 'Review the source URL and refresh the seed so the US record uses English-facing PDP content.',
        autoFixable: false,
      }),
    );
  }

  if (detectGenericTemplateDescription(title, description)) {
    findings.push(
      buildFinding(row, snapshot, {
        anomalyType: 'generic_template_description',
        severity: ANOMALY_SEVERITY.review,
        evidence: {
          title,
          description_excerpt: description.slice(0, 280),
        },
        recommendedAction: 'Replace the fallback template copy with source PDP description text or clear the field for manual review.',
        autoFixable: false,
      }),
    );
  }

  if (seedDescriptionOrigin === 'synthetic_summary' || detectSyntheticSummaryDescription(description)) {
    findings.push(
      buildFinding(row, snapshot, {
        anomalyType: 'seed_description_pollution',
        severity: ANOMALY_SEVERITY.review,
        evidence: {
          seed_description_origin: seedDescriptionOrigin || 'synthetic_summary',
          description_excerpt: description.slice(0, 280),
        },
        recommendedAction: 'Prefer PDP raw fields and exclude synthetic summary text from ingredient extraction inputs.',
        autoFixable: false,
      }),
    );
  }

  if (isNonProductFallback) {
    findings.push(
      buildFinding(row, snapshot, {
        anomalyType: 'non_product_fallback_page',
        severity: ANOMALY_SEVERITY.blocker,
        evidence: {
          canonical_url: canonicalUrl,
          title,
          description_excerpt: description.slice(0, 280),
        },
        recommendedAction: 'Recover the original PDP target and rerun extraction instead of keeping fallback page content.',
        autoFixable: true,
      }),
    );
  }

  const priceCurrencyMismatch = detectPriceCurrencyMismatch(row, variants);
  if (priceCurrencyMismatch) {
    findings.push(
      buildFinding(row, snapshot, {
        anomalyType: 'price_currency_mismatch',
        severity: ANOMALY_SEVERITY.blocker,
        evidence: priceCurrencyMismatch,
        recommendedAction: 'Re-extract pricing and reconcile row currency with variant currencies before downstream export.',
        autoFixable: false,
      }),
    );
  }

  if (!isNonProductFallback) {
    const marketCurrencyMismatch = detectMarketCurrencyMismatch(row, variants, market, title, description);
    if (marketCurrencyMismatch) {
      findings.push(
        buildFinding(row, snapshot, {
          anomalyType: 'market_currency_mismatch',
          severity: ANOMALY_SEVERITY.blocker,
          evidence: marketCurrencyMismatch,
          recommendedAction:
            'Refresh the seed from the market-correct PDP so row and variant pricing match the expected currency for this market.',
          autoFixable: false,
        }),
      );
    }

    const metricOnlySize = detectMetricOnlySizeInUsSeed(row, snapshot, seedData, variants);
    if (metricOnlySize) {
      findings.push(
        buildFinding(row, snapshot, {
          anomalyType: 'metric_only_size_in_us_seed',
          severity: ANOMALY_SEVERITY.review,
          evidence: metricOnlySize,
          recommendedAction:
            'Review the PDP locale and merchandising copy so US seeds expose user-facing size information in the expected unit system.',
          autoFixable: false,
        }),
      );
    }
  }

  if (imageUrls.length === 0) {
    findings.push(
      buildFinding(row, snapshot, {
        anomalyType: 'zero_images',
        severity: ANOMALY_SEVERITY.review,
        evidence: {
          canonical_url: canonicalUrl,
          image_count: 0,
        },
        recommendedAction: 'Review PDP media extraction or apply a curated image override before downstream use.',
        autoFixable: false,
      }),
    );
  }

  if (variants.length === 0) {
    findings.push(
      buildFinding(row, snapshot, {
        anomalyType: 'zero_variants',
        severity: ANOMALY_SEVERITY.blocker,
        evidence: {
          canonical_url: canonicalUrl,
          variant_count: 0,
        },
        recommendedAction: 'Treat the seed as blocked until extraction can recover at least one sellable variant.',
        autoFixable: false,
      }),
    );
  }

  if (diagnostics?.manual_image_override?.applied) {
    findings.push(
      buildFinding(row, snapshot, {
        anomalyType: 'manual_image_override_present',
        severity: ANOMALY_SEVERITY.review,
        evidence: diagnostics.manual_image_override,
        recommendedAction: 'Keep the override under review and replace it with extractor-owned media when possible.',
        autoFixable: false,
      }),
    );
  }

  const duplicateSkus = detectDuplicateVariantSkus(variants);
  if (duplicateSkus.length > 0) {
    findings.push(
      buildFinding(row, snapshot, {
        anomalyType: 'gift_card_duplicate_sku',
        severity: ANOMALY_SEVERITY.info,
        evidence: {
          duplicates: duplicateSkus,
        },
        recommendedAction: 'Use variant_id or option values as the downstream unique key when SKU is intentionally shared.',
        autoFixable: false,
      }),
    );
  }

  return {
    row: {
      id: normalizeNonEmptyString(row?.id),
      domain: normalizeNonEmptyString(row?.domain),
      market,
      canonical_url: canonicalUrl,
      title,
      description,
      image_count: imageUrls.length,
      variant_count: variants.length,
      last_extracted_at: lastExtractedAt,
    },
    findings,
  };
}

function summarizeAuditResults(results) {
  const summary = {
    scanned: results.length,
    flagged_rows: 0,
    findings_total: 0,
    by_severity: {
      blocker: 0,
      review: 0,
      info: 0,
    },
    by_anomaly_type: {},
    by_domain: {},
  };

  for (const result of results) {
    const rowFindings = Array.isArray(result?.findings) ? result.findings : [];
    if (rowFindings.length > 0) summary.flagged_rows += 1;
    summary.findings_total += rowFindings.length;
    for (const finding of rowFindings) {
      const severity = normalizeNonEmptyString(finding?.severity);
      if (severity && Object.prototype.hasOwnProperty.call(summary.by_severity, severity)) {
        summary.by_severity[severity] += 1;
      }
      const anomalyType = normalizeNonEmptyString(finding?.anomaly_type);
      if (anomalyType) {
        summary.by_anomaly_type[anomalyType] = (summary.by_anomaly_type[anomalyType] || 0) + 1;
      }
      const domain = normalizeNonEmptyString(finding?.domain);
      if (domain) {
        summary.by_domain[domain] = (summary.by_domain[domain] || 0) + 1;
      }
    }
  }

  return summary;
}

module.exports = {
  ANOMALY_SEVERITY,
  MARKET_LOCALE_SEGMENT,
  auditExternalSeedRow,
  detectLanguage,
  detectGenericTemplateDescription,
  getPrimaryDescription,
  normalizeComparableUrlKey,
  normalizeUrlKey,
  summarizeAuditResults,
};
