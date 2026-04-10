const {
  buildSearchCardPayload,
  buildShoppingCardPayload,
} = require('./pivotaShoppingCard');
const {
  buildHighlightSourcesSummary,
  normalizeExternalHighlightSignals,
} = require('./pivotaEvidenceSignals');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function toList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function buildExternalHighlightPreview(value) {
  return normalizeExternalHighlightSignals(value).map((signal) => ({
    signal_id: asString(signal.signal_id),
    source_type: asString(signal.source_type),
    claim_type: asString(signal.claim_type),
    claim_text: asString(signal.claim_text),
    stance: asString(signal.stance),
    evidence_strength: asString(signal.evidence_strength),
    surfaceable: signal.surfaceable === true,
    surface_targets: toList(signal.surface_targets).map((item) => asString(item)),
  }));
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
    external_highlight_signals: normalizeExternalHighlightSignals(productIntel.external_highlight_signals),
    external_highlight_preview: buildExternalHighlightPreview(productIntel.external_highlight_signals),
    highlight_sources_summary: buildHighlightSourcesSummary(productIntel.external_highlight_signals),
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
    review_decision: 'pending',
    rejection_reason: '',
    notes: '',
    selected_mode: asString(candidate.selected_mode),
    evidence_profile: asString(candidate.evidence_profile),
    quality_state: asString(candidate.quality_state),
    shopping_card: {
      title: asString(candidate?.shopping_card?.title),
      subtitle: asString(candidate?.shopping_card?.subtitle),
      highlight: asString(candidate?.shopping_card?.highlight),
      proof_badge: asString(candidate?.shopping_card?.proof_badge),
    },
    search_card: {
      compact_candidate: asString(candidate?.search_card?.compact_candidate),
      highlight_candidate: asString(candidate?.search_card?.highlight_candidate),
      proof_badge_candidate: asString(candidate?.search_card?.proof_badge_candidate),
      intro_candidate: asString(candidate?.search_card?.intro_candidate),
    },
    external_highlight_preview: toList(candidate?.external_highlight_preview).map((item) => ({
      signal_id: asString(item?.signal_id),
      source_type: asString(item?.source_type),
      claim_type: asString(item?.claim_type),
      claim_text: asString(item?.claim_text),
      stance: asString(item?.stance),
      evidence_strength: asString(item?.evidence_strength),
      surfaceable: item?.surfaceable === true,
      surface_targets: toList(item?.surface_targets).map((target) => asString(target)),
    })),
    highlight_sources_summary: toList(candidate?.highlight_sources_summary).map((item) => ({
      signal_id: asString(item?.signal_id),
      source_type: asString(item?.source_type),
      claim_type: asString(item?.claim_type),
      evidence_strength: asString(item?.evidence_strength),
      independence_count: Number(item?.independence_count || 0) || 0,
      sponsorship_status: asString(item?.sponsorship_status),
      surfaceable: item?.surfaceable === true,
      source_labels: toList(item?.source_labels).map((label) => asString(label)),
    })),
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
