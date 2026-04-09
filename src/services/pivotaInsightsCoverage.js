const {
  buildSearchCardPayload,
  buildShoppingCardPayload,
} = require('./pivotaShoppingCard');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function toList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function buildCoverageCandidate({
  canonicalProductRef,
  productGroupId = null,
  productIntel,
  product,
  selectedMode = 'service_draft',
}) {
  if (!productIntel || typeof productIntel !== 'object') return null;
  const shoppingCard = buildShoppingCardPayload({ product, bundle: productIntel });
  const searchCard = buildSearchCardPayload({ product, bundle: productIntel });
  return {
    case_id: `coverage_${asString(canonicalProductRef?.product_id)}`,
    canonical_product_ref: canonicalProductRef,
    ...(asString(productGroupId) ? { product_group_id: asString(productGroupId) } : {}),
    selected_mode: selectedMode,
    evidence_profile: asString(productIntel.evidence_profile),
    quality_state: asString(productIntel.quality_state),
    shopping_card: shoppingCard,
    search_card: searchCard,
    pivota_insights: {
      what_it_is: asString(productIntel?.product_intel_core?.what_it_is?.body),
      why_it_stands_out: toList(productIntel?.product_intel_core?.why_it_stands_out).map((item) => ({
        headline: asString(item?.headline),
        body: asString(item?.body),
      })),
    },
    bundle: {
      ...productIntel,
      shopping_card: shoppingCard,
      search_card: searchCard,
    },
  };
}

function buildCoverageReviewRow(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  return {
    case_id: asString(candidate.case_id),
    product_ref: candidate.canonical_product_ref || null,
    review_status: 'pending',
    reviewer: '',
    decision: 'pending',
    notes: '',
    selected_mode: asString(candidate.selected_mode),
    evidence_profile: asString(candidate.evidence_profile),
    quality_state: asString(candidate.quality_state),
    shopping_card: {
      title: asString(candidate?.shopping_card?.title),
      subtitle: asString(candidate?.shopping_card?.subtitle),
      proof_badge: asString(candidate?.shopping_card?.proof_badge),
    },
    pivota_insights: {
      what_it_is: asString(candidate?.pivota_insights?.what_it_is),
      why_it_stands_out: toList(candidate?.pivota_insights?.why_it_stands_out).map((item) => ({
        headline: asString(item?.headline),
        body: asString(item?.body),
      })),
    },
  };
}

function buildCoverageReviewPacket(candidates) {
  const rows = toList(candidates).map(buildCoverageReviewRow).filter(Boolean);
  return {
    meta: {
      generated_at: new Date().toISOString(),
      report_cases: rows.length,
      pending: rows.length,
    },
    rows,
  };
}

module.exports = {
  buildCoverageCandidate,
  buildCoverageReviewPacket,
  buildCoverageReviewRow,
};
