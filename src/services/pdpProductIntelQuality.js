const { resolveDisplayableCompactHighlight } = require('./pivotaShoppingCard');

function asString(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter(Boolean);
}

function normalizeKey(value) {
  return asString(value).toLowerCase();
}

function hasEllipsisOrTruncation(value) {
  const text = asString(value);
  if (!text) return false;
  return /\.\.\.|…/.test(text);
}

function hasBilingualPollution(value) {
  const text = asString(value);
  if (!text) return false;
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

function isGenericInsightText(value) {
  const text = normalizeKey(value);
  if (!text) return true;
  return [
    /\bpresented through merchant product data\b/,
    /\blisting[-\s]?grounded\b/,
    /\bdefines? the product around the title\b/,
    /\bfocused on .* within a .* routine\b/,
    /\banchors? the product\b/,
    /\bdaytime uv step\b/,
    /\bdaytime skin-?care routines?\b/,
    /\bgeneral .* routine\b/,
    /\bproduct data\b.*\broutine\b/,
    /\broutine context\b/,
    /\bdetails? (?:are|is) not available\b/,
    /\bproduct information\b.*\bunavailable\b/,
  ].some((pattern) => pattern.test(text));
}

function hasProductSpecificInsightText(value) {
  const text = normalizeKey(value);
  if (!text) return false;
  return [
    /\bspf\s*\d+\b/,
    /\bzinc oxide\b/,
    /\btitanium dioxide\b/,
    /\btinted\b/,
    /\bshade\b/,
    /\bmineral\b/,
    /\bcoverage\b/,
    /\bfinish\b/,
    /\bretinol\b/,
    /\bvitamin\s*c\b/,
    /\bascorb(?:ic|yl)\b/,
    /\bhyaluronic\s+acid\b/,
    /\bniacinamide\b/,
    /\bceramide\b/,
    /\bpeptide\b/,
    /\bsalicylic\s+acid\b/,
    /\bglycolic\s+acid\b/,
    /\blactic\s+acid\b/,
    /\baha\b/,
    /\bbha\b/,
    /\bpha\b/,
    /\balcohol denat\b/,
    /\bbutyloctyl salicylate\b/,
    /\b1,2-hexanediol\b/,
    /\bclinical\b/,
    /\bsebum\b/,
    /\brice[-\s]?infused\b/,
    /\bfragrance\b/,
    /\bconcealer\b/,
    /\bfoundation\b/,
    /\blip\b/,
  ].some((pattern) => pattern.test(text));
}

function readProductIntelCore(bundle) {
  return isPlainObject(bundle?.product_intel_core) ? bundle.product_intel_core : null;
}

function collectProductIntelPrimaryText(bundle) {
  const core = readProductIntelCore(bundle);
  if (!core) return '';
  const whatItIs = isPlainObject(core.what_it_is) ? core.what_it_is : {};
  const whyText = Array.isArray(core.why_it_stands_out)
    ? core.why_it_stands_out
        .map((item) => [item?.headline, item?.body].map(asString).filter(Boolean).join(' '))
        .filter(Boolean)
        .join(' ')
    : '';
  const bestForText = Array.isArray(core.best_for)
    ? core.best_for.map((item) => asString(item?.label || item?.tag)).filter(Boolean).join(' ')
    : '';
  const routineFit = isPlainObject(core.routine_fit) ? core.routine_fit : {};
  return [
    whatItIs.headline,
    whatItIs.body,
    bestForText,
    routineFit.step,
    ...toList(routineFit.pairing_notes),
    whyText,
  ]
    .map(asString)
    .filter(Boolean)
    .join(' ');
}

function hasReviewedOrCuratedProvenance(bundle) {
  const provenance = isPlainObject(bundle?.provenance) ? bundle.provenance : {};
  const reviewStatus = normalizeKey(provenance.review_status);
  const reviewDecision = normalizeKey(provenance.review_decision);
  const reviewerKind = normalizeKey(provenance.reviewer_kind);
  const selectedStrategy = normalizeKey(provenance.selection_strategy);
  const sourceVersion = normalizeKey(bundle?.freshness?.source_version || bundle?.product_intel_core?.freshness?.source_version);
  const qualityGate = isPlainObject(provenance.gemini_quality_gate) ? provenance.gemini_quality_gate : {};
  const fieldSources = isPlainObject(provenance.field_sources) ? provenance.field_sources : {};

  if (sourceVersion === 'pilot_selected:strict_human_reviewed') return true;
  if (normalizeKey(provenance.generator) === 'strict_human_manual_rewrite') return true;
  if (Object.values(fieldSources).some((value) => normalizeKey(value) === 'human_standard') && qualityGate.human_standard_rewrite === true) {
    return true;
  }
  if (
    reviewerKind === 'human' &&
    reviewStatus === 'completed' &&
    ['pass', 'rewrite'].includes(reviewDecision) &&
    selectedStrategy.includes('strict_human')
  ) {
    return true;
  }
  return (
    reviewerKind === 'assistant' &&
    reviewStatus === 'completed' &&
    ['pass', 'rewrite', 'seller_only_fallback'].includes(reviewDecision) &&
    selectedStrategy === 'curated_override'
  );
}

function evaluateProductIntelDisplayability(bundle) {
  const failureReasons = [];
  const core = readProductIntelCore(bundle);
  if (!isPlainObject(bundle) || !core) {
    failureReasons.push('product_intel_missing_core');
    return {
      displayable: false,
      contract_status: 'missing_blocked',
      source_quality_status: 'missing',
      failure_reasons: failureReasons,
    };
  }

  const qualityState = normalizeKey(core.quality_state || bundle.quality_state || bundle.normalized_pdp?.quality_state);
  if (qualityState === 'blocked') failureReasons.push('product_intel_quality_blocked');

  const primaryText = collectProductIntelPrimaryText(bundle);
  if (!primaryText) failureReasons.push('product_intel_empty_copy');
  if (hasEllipsisOrTruncation(primaryText)) failureReasons.push('product_intel_truncated_copy');
  if (hasBilingualPollution(primaryText)) failureReasons.push('product_intel_bilingual_pollution');
  if (isGenericInsightText(primaryText) && !hasProductSpecificInsightText(primaryText)) {
    failureReasons.push('product_intel_generic_copy');
  }
  if (!hasReviewedOrCuratedProvenance(bundle)) {
    failureReasons.push('product_intel_unreviewed');
  }

  const displayable = failureReasons.length === 0;
  return {
    displayable,
    contract_status: displayable ? 'ready' : 'missing_blocked',
    source_quality_status: displayable ? 'verified' : 'blocked',
    failure_reasons: failureReasons,
  };
}

function pickCardHighlight(product = {}) {
  const explicit = asString(
    product.card_highlight ||
      product.shopping_card?.highlight ||
      product.search_card?.highlight_candidate ||
      product.search_card?.highlight ||
      product.highlight,
  );
  const resolvedExplicit = resolveDisplayableCompactHighlight(explicit, {
    bundle: product.product_intel || product.productIntel || null,
    title: product.title || product.name || product.shopping_card?.title || product.search_card?.title_candidate,
    subtitle: product.shopping_card?.subtitle || product.search_card?.compact_candidate || '',
  });
  if (resolvedExplicit) return resolvedExplicit;

  return resolveDisplayableCompactHighlight(asString(product.card_subtitle || product.subtitle), {
    title: product.title || product.name || '',
    subtitle: '',
  });
}

function hasDisplayableSimilarHighlight(product = {}) {
  return Boolean(pickCardHighlight(product));
}

module.exports = {
  evaluateProductIntelDisplayability,
  collectProductIntelPrimaryText,
  hasDisplayableSimilarHighlight,
  hasProductSpecificInsightText,
  pickCardHighlight,
  _internals: {
    asString,
    hasBilingualPollution,
    hasEllipsisOrTruncation,
    isGenericInsightText,
  },
};
