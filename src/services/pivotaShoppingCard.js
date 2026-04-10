const {
  filterSurfaceableExternalHighlightSignals,
  normalizeExternalHighlightSignals,
  pickSurfaceableExternalHighlightSignal,
  buildDisplayableProofBadge,
  filterDisplayableMarketSignalBadges,
  normalizeMarketSignalBadges,
  normalizeSurfaceText,
} = require('./pivotaEvidenceSignals');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function toList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function formatCompactCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function toHeadlineCase(value) {
  return asString(value)
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((token) =>
      token
        .split('-')
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
        .join('-'),
    )
    .join(' ');
}

function compactText(value, maxChars) {
  const text = asString(value).replace(/\s+/g, ' ').trim();
  if (!text || !Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const trimmed = text.slice(0, maxChars);
  const boundary = trimmed.lastIndexOf(' ');
  return (boundary >= Math.floor(maxChars * 0.6) ? trimmed.slice(0, boundary) : trimmed).trim();
}

function inferRoutineLabel(step, fallbackCategory) {
  const stepText = asString(step).toLowerCase();
  if (stepText === 'serum') return 'serum';
  if (stepText === 'moisturizer') return 'moisturizer';
  if (stepText === 'sunscreen') return 'sunscreen';
  if (stepText === 'cleanser') return 'cleanser';
  if (stepText === 'eye treatment') return 'eye treatment';
  if (stepText === 'eye stick') return 'eye stick';
  const category = asString(fallbackCategory).toLowerCase();
  if (category.includes('serum')) return 'serum';
  if (category.includes('moisturizer') || category.includes('cream')) return 'cream';
  if (category.includes('sunscreen') || category.includes('spf')) return 'sunscreen';
  if (category.includes('cleanser')) return 'cleanser';
  if (category.includes('eye')) return 'eye treatment';
  return '';
}

function compactWhatItIsHeadline(headline) {
  const text = toHeadlineCase(headline);
  if (!text || /^Pivota Insights$/i.test(text)) return '';
  return text.length <= 42 ? text : '';
}

function normalizeBadgeCandidates(value) {
  return normalizeMarketSignalBadges(toList(value)).map((badge) => ({
    badge_type: asString(badge.badge_type),
    badge_label: asString(badge.badge_label),
  }));
}

function normalizeHighlightCandidates(value) {
  return normalizeExternalHighlightSignals(value).map((signal) => ({
    signal_id: asString(signal.signal_id),
    source_type: asString(signal.source_type),
    claim_type: asString(signal.claim_type),
    claim_text: asString(signal.claim_text),
    ...(asString(signal.surface_text) ? { surface_text: asString(signal.surface_text) } : {}),
    stance: asString(signal.stance),
    evidence_strength: asString(signal.evidence_strength),
    sponsorship_status: asString(signal.sponsorship_status),
    independence_count: Number(signal.independence_count || 0) || 0,
    surfaceable: signal.surfaceable === true,
    surface_targets: toList(signal.surface_targets),
  }));
}

function buildCompactSubtitle({ product, bundle }) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const core = bundle?.product_intel_core || {};
  const stepLabel = inferRoutineLabel(core?.routine_fit?.step, safeProduct.category || safeProduct.product_type);
  const whatBody = asString(core?.what_it_is?.body).toLowerCase();

  if (whatBody.includes('multi-active') && stepLabel) {
    return toHeadlineCase(`multi-active ${stepLabel}`);
  }
  if (whatBody.includes('vitamin c') && whatBody.includes('niacinamide') && stepLabel) {
    return toHeadlineCase(`vitamin c + niacinamide ${stepLabel}`);
  }
  if (whatBody.includes('amla') && stepLabel) {
    return toHeadlineCase(`amla brightening ${stepLabel}`);
  }
  if (
    (whatBody.includes('broad-spectrum') || whatBody.includes('spf') || whatBody.includes('sunscreen')) &&
    stepLabel === 'moisturizer'
  ) {
    return 'SPF moisturizer';
  }
  if (whatBody.includes('color-correcting') && whatBody.includes('eye') && stepLabel) {
    return toHeadlineCase(`color-correcting ${stepLabel}`);
  }

  const compactHeadline = compactWhatItIsHeadline(core?.what_it_is?.headline);
  if (compactHeadline) return compactHeadline;

  return toHeadlineCase(safeProduct.product_type || safeProduct.category).slice(0, 42);
}

function buildProofBadge({ product, bundle }) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  return buildDisplayableProofBadge(
    {
      market_signal_badges: bundle?.market_signal_badges || safeProduct.market_signal_badges,
      review_summary: bundle?.review_summary || safeProduct.review_summary,
      community_signals: bundle?.community_signals || safeProduct.community_signals,
    },
    { formatCompactCount },
  );
}

function buildTitleCandidate(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const brand = asString(safeProduct.brand);
  const title = asString(safeProduct.title || safeProduct.name);
  if (!brand || !title) return title || 'Untitled product';
  if (title.toLowerCase().startsWith(brand.toLowerCase())) return title;
  return `${brand} ${title}`.trim();
}

function buildCardIntro({ bundle }) {
  const explicitIntro = asString(
    bundle?.search_card?.intro_candidate || bundle?.shopping_card?.intro,
  );
  if (explicitIntro) return compactText(explicitIntro, 90);
  const signal = pickSurfaceableExternalHighlightSignal(bundle?.external_highlight_signals, {
    surfaceTarget: 'search_card_intro',
  });
  if (signal?.claim_text) return compactText(signal.claim_text, 90);
  return asString(bundle?.product_intel_core?.what_it_is?.body);
}

function buildCardHighlight({ bundle }) {
  const explicitHighlight = asString(
    bundle?.search_card?.highlight_candidate || bundle?.shopping_card?.highlight,
  );
  if (explicitHighlight) return normalizeSurfaceText(explicitHighlight);
  const signal = pickSurfaceableExternalHighlightSignal(bundle?.external_highlight_signals, {
    surfaceTarget: 'shopping_card_highlight',
  });
  return normalizeSurfaceText(signal?.surface_text) || normalizeSurfaceText(signal?.claim_text);
}

function buildShoppingCardPayload({ product, bundle }) {
  const title = buildTitleCandidate(product);
  const subtitle = buildCompactSubtitle({ product, bundle });
  const proofBadge = buildProofBadge({ product, bundle });
  const highlight = buildCardHighlight({ bundle });
  const intro = buildCardIntro({ bundle });
  const explicitBadges =
    Array.isArray(bundle?.market_signal_badges) && bundle.market_signal_badges.length
      ? bundle.market_signal_badges
      : proofBadge
        ? [proofBadge]
        : [];
  const evidenceContext = {
    market_signal_badges: bundle?.market_signal_badges || product?.market_signal_badges,
    review_summary: bundle?.review_summary || product?.review_summary,
    community_signals: bundle?.community_signals || product?.community_signals,
  };
  const marketSignalBadges = filterDisplayableMarketSignalBadges(
    explicitBadges,
    evidenceContext,
  ).map((badge) => ({
    badge_type: asString(badge.badge_type),
    badge_label: asString(badge.badge_label),
  }));
  const visibleExternalHighlights = filterSurfaceableExternalHighlightSignals(
    bundle?.external_highlight_signals,
  );

  return {
    contract_version: 'pivota.shopping_card.v1',
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(proofBadge?.badge_label ? { proof_badge: proofBadge.badge_label } : {}),
    ...(highlight ? { highlight } : {}),
    ...(intro ? { intro } : {}),
    ...(marketSignalBadges.length ? { market_signal_badges: marketSignalBadges } : {}),
    ...(visibleExternalHighlights.length
      ? { external_highlight_signals: normalizeHighlightCandidates(visibleExternalHighlights) }
      : {}),
    ...(asString(bundle?.evidence_profile) ? { evidence_profile: asString(bundle.evidence_profile) } : {}),
  };
}

function buildSearchCardPayload({ product, bundle }) {
  const shoppingCard = buildShoppingCardPayload({ product, bundle });
  return {
    title_candidate: shoppingCard.title,
    ...(shoppingCard.subtitle ? { compact_candidate: shoppingCard.subtitle } : {}),
    ...(shoppingCard.highlight ? { highlight_candidate: compactText(shoppingCard.highlight, 40) } : {}),
    ...(shoppingCard.proof_badge ? { proof_badge_candidate: shoppingCard.proof_badge } : {}),
    ...(shoppingCard.intro ? { intro_candidate: compactText(shoppingCard.intro, 90) } : {}),
  };
}

module.exports = {
  buildCompactSubtitle,
  buildCardHighlight,
  buildCardIntro,
  buildProofBadge,
  buildSearchCardPayload,
  buildShoppingCardPayload,
  buildTitleCandidate,
  normalizeBadgeCandidates,
  normalizeHighlightCandidates,
};
