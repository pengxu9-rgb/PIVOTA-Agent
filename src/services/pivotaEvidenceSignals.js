function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTimestamp(value) {
  const text = asString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeReviewSummary(value) {
  const source = value && typeof value === 'object' ? value : {};
  const rating = toFiniteNumber(
    source.rating ??
      source.rating_value ??
      source.average_rating ??
      source.avg_rating ??
      source.value ??
      source.review_rating,
  );
  const reviewCount = toFiniteNumber(
    source.review_count ??
      source.reviewCount ??
      source.count ??
      source.total ??
      source.total_reviews ??
      source.review_count_total,
  );
  if (rating == null && reviewCount == null) return null;
  return {
    ...(rating != null ? { rating } : {}),
    ...(reviewCount != null ? { review_count: reviewCount } : {}),
  };
}

function normalizeCommunitySignals(value) {
  const source = value && typeof value === 'object' ? value : {};
  const status = asString(source.status || source.state || source.availability);
  const sourceCounts =
    source.source_counts && typeof source.source_counts === 'object' ? source.source_counts : {};
  if (!status && !Object.keys(sourceCounts).length) return null;
  return {
    ...(status ? { status } : {}),
    ...(Object.keys(sourceCounts).length ? { source_counts: sourceCounts } : {}),
  };
}

function normalizeMarketSignalBadges(value) {
  return asArray(value)
    .map((item) => {
      const row = item && typeof item === 'object' ? item : null;
      const badgeLabel = asString(row?.badge_label || row?.label || item);
      if (!badgeLabel) return null;
      const badgeType = asString(row?.badge_type || row?.type);
      const sourceType = asString(row?.source_type || row?.sourceType);
      const sponsorshipStatus = asString(
        row?.sponsorship_status || row?.sponsorshipStatus || row?.sponsorship,
      );
      const evidenceStrength = asString(row?.evidence_strength || row?.evidenceStrength || row?.strength);
      const independenceCount = toFiniteNumber(
        row?.independence_count ??
          row?.independenceCount ??
          row?.independent_source_count ??
          row?.independentSourceCount,
      );
      const reviewSummary = normalizeReviewSummary(
        row?.review_summary ||
          (row?.review_rating != null || row?.review_count != null
            ? {
                review_rating: row?.review_rating,
                review_count: row?.review_count,
              }
            : null),
      );
      return {
        ...(badgeType ? { badge_type: badgeType } : {}),
        badge_label: badgeLabel,
        ...(sourceType ? { source_type: sourceType } : {}),
        ...(sponsorshipStatus ? { sponsorship_status: sponsorshipStatus } : {}),
        ...(evidenceStrength ? { evidence_strength: evidenceStrength } : {}),
        ...(independenceCount != null ? { independence_count: independenceCount } : {}),
        ...(reviewSummary ? { review_summary: reviewSummary } : {}),
      };
    })
    .filter(Boolean);
}

function normalizeSourceType(value) {
  const text = asString(value).toLowerCase();
  if (['verified_reviews', 'verified_review', 'reviews', 'review'].includes(text)) {
    return 'verified_reviews';
  }
  if (
    [
      'creator_social_consensus',
      'creator_consensus',
      'social_consensus',
      'creator',
      'social',
    ].includes(text)
  ) {
    return 'creator_social_consensus';
  }
  if (['editorial_support', 'editorial', 'media', 'editorial_signal'].includes(text)) {
    return 'editorial_support';
  }
  if (['expert_quote', 'expert'].includes(text)) {
    return 'expert_quote';
  }
  return '';
}

function normalizeClaimType(value) {
  const text = asString(value).toLowerCase();
  if (['standout', 'why_it_stands_out', 'why'].includes(text)) return 'standout';
  if (['texture_finish', 'texture', 'finish'].includes(text)) return 'texture_finish';
  if (['routine_fit', 'routine', 'usage'].includes(text)) return 'routine_fit';
  if (['watchout', 'watchouts'].includes(text)) return 'watchout';
  if (['best_for', 'fit'].includes(text)) return 'best_for';
  if (['card_hook', 'highlight'].includes(text)) return 'card_hook';
  return '';
}

function normalizeStance(value) {
  const text = asString(value).toLowerCase();
  if (['mixed', 'negative', 'positive'].includes(text)) return text;
  return 'positive';
}

function normalizeSponsorshipStatus(value) {
  const text = asString(value).toLowerCase();
  if (['organic', 'mixed', 'sponsored', 'gifted', 'unknown'].includes(text)) return text;
  if (['paid', 'ad'].includes(text)) return 'sponsored';
  return 'unknown';
}

function normalizeEvidenceStrength(value) {
  const text = asString(value).toLowerCase();
  if (['weak', 'moderate', 'strong'].includes(text)) return text;
  if (['high', 'verified'].includes(text)) return 'strong';
  if (['limited', 'low'].includes(text)) return 'weak';
  return 'weak';
}

function normalizeConfidence(value) {
  const text = asString(value).toLowerCase();
  if (['low', 'moderate', 'high'].includes(text)) return text;
  return '';
}

function normalizeSurfaceText(value) {
  const text = asString(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length > 40) return '';
  return text;
}

function normalizeSurfaceTargets(value, claimType, stance) {
  const explicit = asArray(value)
    .map((item) => {
      const text = asString(item).toLowerCase();
      if (['why_it_stands_out', 'standout', 'why'].includes(text)) return 'why_it_stands_out';
      if (['texture_finish', 'texture', 'finish'].includes(text)) return 'texture_finish';
      if (['watchouts', 'watchout'].includes(text)) return 'watchouts';
      if (['shopping_card_highlight', 'shopping_card', 'card'].includes(text)) return 'shopping_card_highlight';
      if (['search_card_intro', 'search_intro', 'search_card'].includes(text)) return 'search_card_intro';
      return '';
    })
    .filter(Boolean);
  if (explicit.length) return Array.from(new Set(explicit));
  if (claimType === 'watchout' || stance === 'negative') return ['watchouts'];
  if (claimType === 'texture_finish') return ['texture_finish', 'shopping_card_highlight'];
  if (claimType === 'routine_fit') return ['search_card_intro'];
  if (claimType === 'card_hook') return ['shopping_card_highlight', 'search_card_intro'];
  if (claimType === 'standout') return ['why_it_stands_out', 'shopping_card_highlight', 'search_card_intro'];
  if (claimType === 'best_for') return ['why_it_stands_out'];
  return [];
}

function normalizeSupportingSources(value) {
  return asArray(value)
    .map((item) => {
      const row = item && typeof item === 'object' ? item : null;
      if (!row) return null;
      const label = asString(row.label || row.source_label || row.title || row.name);
      const url = asString(row.url || row.source_url);
      const publishedAt = normalizeTimestamp(row.published_at || row.publishedAt || row.date);
      const sponsorshipStatus = normalizeSponsorshipStatus(
        row.sponsorship_status || row.sponsorshipStatus || row.sponsorship,
      );
      if (!label && !url) return null;
      return {
        ...(label ? { label } : {}),
        ...(url ? { url } : {}),
        ...(publishedAt ? { published_at: publishedAt } : {}),
        ...(sponsorshipStatus ? { sponsorship_status: sponsorshipStatus } : {}),
      };
    })
    .filter(Boolean);
}

function computeHighlightSignalSurfaceable(signal, explicitSurfaceable = null) {
  if (!signal || typeof signal !== 'object') return false;
  if (!asString(signal.claim_text)) return false;
  if (explicitSurfaceable === false) return false;
  const sourceType = normalizeSourceType(signal.source_type);
  const sponsorshipStatus = normalizeSponsorshipStatus(signal.sponsorship_status);
  const evidenceStrength = normalizeEvidenceStrength(signal.evidence_strength);
  const independenceCount = Number(signal.independence_count || 0) || 0;
  const reviewCount = Number(signal.rating_summary?.review_count || 0) || 0;
  const hasSources = Array.isArray(signal.supporting_sources) && signal.supporting_sources.length > 0;

  if (sourceType === 'verified_reviews') {
    return reviewCount > 0 || hasSources || independenceCount >= 1;
  }
  if (sourceType === 'creator_social_consensus') {
    if (['sponsored', 'gifted'].includes(sponsorshipStatus)) return false;
    if (!['moderate', 'strong'].includes(evidenceStrength)) return false;
    return independenceCount >= 3;
  }
  if (sourceType === 'expert_quote') {
    if (explicitSurfaceable !== true) return false;
    if (['sponsored', 'gifted'].includes(sponsorshipStatus)) return false;
    return evidenceStrength === 'strong' && hasSources;
  }
  return false;
}

function normalizeExternalHighlightSignals(value) {
  return asArray(value)
    .map((item, index) => {
      const row = item && typeof item === 'object' ? item : null;
      if (!row) return null;
      const sourceType = normalizeSourceType(row.source_type || row.sourceType);
      const claimType = normalizeClaimType(row.claim_type || row.claimType);
      const claimText = asString(row.claim_text || row.claimText || row.text || row.claim);
      if (!claimText) return null;
      const surfaceText = normalizeSurfaceText(
        row.surface_text ||
          row.surfaceText ||
          row.card_highlight_text ||
          row.cardHighlightText ||
          row.highlight_text ||
          row.highlightText,
      );
      const stance = normalizeStance(row.stance);
      const supportingSources = normalizeSupportingSources(
        row.supporting_sources || row.supportingSources || row.sources,
      );
      const ratingSummary = normalizeReviewSummary(
        row.rating_summary || row.ratingSummary || row.review_summary || row.reviewSummary,
      );
      const sponsorshipStatus = normalizeSponsorshipStatus(
        row.sponsorship_status || row.sponsorshipStatus || row.sponsorship,
      );
      const evidenceStrength = normalizeEvidenceStrength(
        row.evidence_strength || row.evidenceStrength || row.strength,
      );
      const confidence = normalizeConfidence(row.confidence);
      const independenceCount = toFiniteNumber(
        row.independence_count ??
          row.independenceCount ??
          row.independent_source_count ??
          row.independentSourceCount,
      );
      const surfaceTargets = normalizeSurfaceTargets(
        row.surface_targets || row.surfaceTargets,
        claimType,
        stance,
      );
      const explicitSurfaceable =
        typeof row.surfaceable === 'boolean'
          ? row.surfaceable
          : typeof row.surfaceable === 'string'
            ? ['true', '1', 'yes'].includes(row.surfaceable.trim().toLowerCase())
              ? true
              : ['false', '0', 'no'].includes(row.surfaceable.trim().toLowerCase())
                ? false
                : null
            : null;
      const signal = {
        signal_id:
          asString(row.signal_id || row.signalId) ||
          `external_highlight_${index + 1}`,
        ...(sourceType ? { source_type: sourceType } : {}),
        ...(claimType ? { claim_type: claimType } : {}),
        claim_text: claimText,
        ...(surfaceText ? { surface_text: surfaceText } : {}),
        stance,
        ...(supportingSources.length ? { supporting_sources: supportingSources } : {}),
        ...(independenceCount != null ? { independence_count: independenceCount } : {}),
        ...(ratingSummary ? { rating_summary: ratingSummary } : {}),
        sponsorship_status: sponsorshipStatus,
        evidence_strength: evidenceStrength,
        ...(confidence ? { confidence } : {}),
        ...(normalizeTimestamp(row.freshness || row.last_seen_at || row.lastSeenAt || row.observed_at || row.observedAt)
          ? {
              freshness: normalizeTimestamp(
                row.freshness || row.last_seen_at || row.lastSeenAt || row.observed_at || row.observedAt,
              ),
            }
          : {}),
        surface_targets: surfaceTargets,
      };
      return {
        ...signal,
        surfaceable: computeHighlightSignalSurfaceable(signal, explicitSurfaceable),
      };
    })
    .filter(Boolean);
}

function highlightSignalPassesDisplayPolicy(signal, { surfaceTarget = '', allowNegative = false } = {}) {
  const normalized = signal && typeof signal === 'object' ? signal : null;
  if (!normalized || normalized.surfaceable !== true) return false;
  if (!asString(normalized.claim_text)) return false;
  if (surfaceTarget) {
    const targets = asArray(normalized.surface_targets).map((item) => asString(item));
    if (targets.length && !targets.includes(surfaceTarget)) return false;
  }
  const stance = normalizeStance(normalized.stance);
  if (!allowNegative && stance === 'negative') return false;
  if (
    ['shopping_card_highlight', 'search_card_intro'].includes(surfaceTarget) &&
    stance === 'negative'
  ) {
    return false;
  }
  return true;
}

function scoreHighlightSignal(signal, { surfaceTarget = '' } = {}) {
  const sourceType = normalizeSourceType(signal?.source_type);
  const evidenceStrength = normalizeEvidenceStrength(signal?.evidence_strength);
  const stance = normalizeStance(signal?.stance);
  const independenceCount = Number(signal?.independence_count || 0) || 0;
  const reviewCount = Number(signal?.rating_summary?.review_count || 0) || 0;
  const sourceWeight =
    sourceType === 'verified_reviews'
      ? 300
      : sourceType === 'creator_social_consensus'
        ? 220
        : sourceType === 'expert_quote'
          ? 160
          : 0;
  const strengthWeight =
    evidenceStrength === 'strong' ? 30 : evidenceStrength === 'moderate' ? 20 : 10;
  const stanceWeight =
    stance === 'positive' ? 8 : stance === 'mixed' ? 5 : surfaceTarget === 'watchouts' ? 4 : 0;
  return sourceWeight + strengthWeight + stanceWeight + Math.min(independenceCount, 9) + Math.min(reviewCount, 9999) / 10000;
}

function filterSurfaceableExternalHighlightSignals(value, options = {}) {
  const normalizedSignals = normalizeExternalHighlightSignals(value);
  const seen = new Set();
  const out = [];
  for (const signal of normalizedSignals
    .filter((item) => highlightSignalPassesDisplayPolicy(item, options))
    .sort((left, right) => scoreHighlightSignal(right, options) - scoreHighlightSignal(left, options))) {
    const key = `${asString(signal.claim_type).toLowerCase()}::${asString(signal.claim_text).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signal);
  }
  return out;
}

function buildHighlightSourcesSummary(value) {
  return normalizeExternalHighlightSignals(value).map((signal) => ({
    signal_id: asString(signal.signal_id),
    source_type: asString(signal.source_type),
    claim_type: asString(signal.claim_type),
    surface_text: asString(signal.surface_text),
    evidence_strength: asString(signal.evidence_strength),
    independence_count: Number(signal.independence_count || 0) || 0,
    sponsorship_status: asString(signal.sponsorship_status),
    surfaceable: signal.surfaceable === true,
    source_labels: asArray(signal.supporting_sources)
      .map((item) => asString(item?.label))
      .filter(Boolean),
  }));
}

function pickSurfaceableExternalHighlightSignal(value, options = {}) {
  const signals = filterSurfaceableExternalHighlightSignals(value, options);
  return signals[0] || null;
}

function isVerifiedReviewSummary(reviewSummary) {
  const review = normalizeReviewSummary(reviewSummary);
  return Number(review?.rating || 0) >= 4.5 && Number(review?.review_count || 0) >= 100;
}

function isAllowedCreatorConsensusBadge(badge) {
  const type = asString(badge?.badge_type).toLowerCase();
  if (type !== 'creator_signal') return false;
  const sourceType = asString(badge?.source_type).toLowerCase();
  const sponsorshipStatus = asString(badge?.sponsorship_status).toLowerCase();
  const evidenceStrength = asString(badge?.evidence_strength).toLowerCase();
  const independenceCount = Number(badge?.independence_count || 0) || 0;
  if (!sourceType || !['creator_consensus', 'social_consensus'].includes(sourceType)) return false;
  if (!sponsorshipStatus || ['paid', 'sponsored', 'gifted', 'ad'].includes(sponsorshipStatus)) return false;
  if (!['strong', 'high', 'verified'].includes(evidenceStrength)) return false;
  return independenceCount >= 3;
}

function badgePassesDisplayPolicy(badge, context = {}) {
  const normalized = badge && typeof badge === 'object' ? badge : null;
  if (!normalized) return false;
  const type = asString(normalized.badge_type).toLowerCase();
  if (type === 'review_signal') {
    return isVerifiedReviewSummary(normalized.review_summary || context.review_summary);
  }
  if (type === 'creator_signal') {
    return isAllowedCreatorConsensusBadge(normalized);
  }
  return false;
}

function filterDisplayableMarketSignalBadges(value, context = {}) {
  const normalizedBadges = normalizeMarketSignalBadges(value);
  const seen = new Set();
  const out = [];
  for (const badge of normalizedBadges) {
    if (!badgePassesDisplayPolicy(badge, context)) continue;
    const key = `${asString(badge.badge_type).toLowerCase()}::${asString(badge.badge_label).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(badge);
  }
  return out;
}

function buildReviewBadge(reviewSummary, formatCompactCount) {
  const review = normalizeReviewSummary(reviewSummary);
  if (!isVerifiedReviewSummary(review)) return null;
  const formatter =
    typeof formatCompactCount === 'function' ? formatCompactCount : (count) => String(Math.round(Number(count) || 0));
  return {
    badge_type: 'review_signal',
    badge_label: `${review.rating.toFixed(1)}★ (${formatter(review.review_count)})`,
    review_summary: review,
  };
}

function buildDisplayableProofBadge(context = {}, options = {}) {
  const explicit = filterDisplayableMarketSignalBadges(context.market_signal_badges, context);
  if (explicit.length) return explicit[0];
  return buildReviewBadge(context.review_summary, options.formatCompactCount);
}

function hasDisplayableBadgeEvidence(context = {}) {
  return Boolean(buildDisplayableProofBadge(context));
}

module.exports = {
  badgePassesDisplayPolicy,
  buildHighlightSourcesSummary,
  buildDisplayableProofBadge,
  computeHighlightSignalSurfaceable,
  buildReviewBadge,
  filterDisplayableMarketSignalBadges,
  filterSurfaceableExternalHighlightSignals,
  hasDisplayableBadgeEvidence,
  highlightSignalPassesDisplayPolicy,
  isVerifiedReviewSummary,
  normalizeCommunitySignals,
  normalizeExternalHighlightSignals,
  normalizeMarketSignalBadges,
  normalizeReviewSummary,
  normalizeSurfaceText,
  normalizeSupportingSources,
  pickSurfaceableExternalHighlightSignal,
  normalizeTimestamp,
};
