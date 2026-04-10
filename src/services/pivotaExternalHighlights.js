const {
  buildSearchCardPayload,
  buildShoppingCardPayload,
} = require('./pivotaShoppingCard');
const {
  filterSurfaceableExternalHighlightSignals,
  normalizeExternalHighlightSignals,
  normalizeMarketSignalBadges,
  normalizeReviewSummary,
  normalizeTimestamp,
} = require('./pivotaEvidenceSignals');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function toList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      toList(values)
        .map((item) => asString(item))
        .filter(Boolean),
    ),
  );
}

function inferClaimType(text, fallback = 'standout') {
  const normalized = asString(text).toLowerCase();
  if (!normalized) return fallback;
  if (
    /(texture|finish|dewy|matte|glow|glowy|sticky|greasy|heavy|weightless|pilling|pill|cast|white cast)/.test(
      normalized,
    )
  ) {
    return 'texture_finish';
  }
  if (/(under makeup|morning routine|night routine|layer|layers|routine|daytime|overnight)/.test(normalized)) {
    return 'routine_fit';
  }
  if (/(irritat|sting|burn|drying|too rich|too heavy|pilling|cast|scent|fragrance|breakout)/.test(normalized)) {
    return 'watchout';
  }
  return fallback;
}

function createSignal({
  signalId,
  sourceType,
  claimType,
  claimText,
  stance = 'positive',
  independenceCount = 0,
  ratingSummary = null,
  sponsorshipStatus = 'organic',
  evidenceStrength = 'moderate',
  surfaceable = null,
  surfaceTargets = [],
  supportingSources = [],
  freshness = null,
}) {
  return normalizeExternalHighlightSignals([
    {
      signal_id: signalId,
      source_type: sourceType,
      claim_type: claimType,
      claim_text: claimText,
      stance,
      independence_count: independenceCount,
      rating_summary: ratingSummary,
      sponsorship_status: sponsorshipStatus,
      evidence_strength: evidenceStrength,
      surfaceable,
      surface_targets: surfaceTargets,
      supporting_sources: supportingSources,
      freshness,
    },
  ])[0] || null;
}

function buildSignalsFromCommunity(product, rawEvidencePack = null) {
  const community =
    asObject(product?.community_signals) ||
    asObject(product?.communitySignals) ||
    asObject(rawEvidencePack?.community_signals) ||
    null;
  if (!community) return [];
  const sourceCounts = asObject(community.source_counts || community.sourceCounts) || {};
  const creatorCount =
    Number(sourceCounts.creator_mentions || sourceCounts.creatorMentions || sourceCounts.creator || 0) || 0;
  const editorialCount = Number(sourceCounts.editorial || 0) || 0;
  const reviewsCount = Number(sourceCounts.reviews || 0) || 0;
  const sourceType =
    creatorCount >= 3
      ? 'creator_social_consensus'
      : reviewsCount > 0
        ? 'verified_reviews'
        : editorialCount > 0
          ? 'editorial_support'
          : '';
  if (!sourceType) return [];

  const supportingSources =
    toList(rawEvidencePack?.supporting_sources).map((item) => ({
      label: asString(item?.label),
      url: asString(item?.url),
      published_at: normalizeTimestamp(item?.published_at),
      sponsorship_status: asString(item?.sponsorship_status || item?.sponsorship) || 'unknown',
    })) || [];
  const ratingSummary = normalizeReviewSummary(product?.review_summary || rawEvidencePack?.review_summary);
  const freshness = normalizeTimestamp(
    community.last_refreshed_at || community.lastRefreshedAt || rawEvidencePack?.observed_at,
  );
  const sponsorshipStatus = asString(rawEvidencePack?.sponsorship_status) || 'organic';
  const evidenceStrength =
    creatorCount >= 5 || reviewsCount >= 25 ? 'strong' : creatorCount >= 3 || reviewsCount >= 5 ? 'moderate' : 'weak';

  const out = [];
  const topLoves = uniqueStrings(community.top_loves || community.topLoveThemes || community.typical_positive);
  const topComplaints = uniqueStrings(
    community.top_complaints || community.topComplaintThemes || community.typical_negative,
  );
  const mixedFeedback = uniqueStrings(community.mixed_feedback || community.mixedFeedback);

  for (const love of topLoves.slice(0, 2)) {
    out.push(
      createSignal({
        signalId: `community_love_${out.length + 1}`,
        sourceType,
        claimType: inferClaimType(love),
        claimText: love,
        stance: 'positive',
        independenceCount: creatorCount || reviewsCount || editorialCount,
        ratingSummary,
        sponsorshipStatus,
        evidenceStrength,
        supportingSources,
        freshness,
      }),
    );
  }

  for (const complaint of [...mixedFeedback, ...topComplaints].slice(0, 2)) {
    out.push(
      createSignal({
        signalId: `community_watchout_${out.length + 1}`,
        sourceType,
        claimType: 'watchout',
        claimText: complaint,
        stance: 'mixed',
        independenceCount: creatorCount || reviewsCount || editorialCount,
        ratingSummary,
        sponsorshipStatus,
        evidenceStrength,
        surfaceTargets: ['watchouts'],
        supportingSources,
        freshness,
      }),
    );
  }

  return out.filter(Boolean);
}

function buildSignalsFromBadges(product, rawEvidencePack = null) {
  const badges = normalizeMarketSignalBadges(
    rawEvidencePack?.market_signal_badges || product?.market_signal_badges,
  );
  if (!badges.length) return [];
  return badges
    .map((badge, index) => {
      const sourceType =
        badge.source_type === 'creator_consensus' || badge.source_type === 'social_consensus'
          ? 'creator_social_consensus'
          : badge.badge_type === 'review_signal'
            ? 'verified_reviews'
            : badge.badge_type === 'editorial_signal' || badge.badge_type === 'media_signal'
              ? 'editorial_support'
              : '';
      if (!sourceType) return null;
      return createSignal({
        signalId: `badge_signal_${index + 1}`,
        sourceType,
        claimType: 'card_hook',
        claimText: asString(badge.badge_label),
        stance: 'positive',
        independenceCount: Number(badge.independence_count || 0) || 0,
        ratingSummary: normalizeReviewSummary(badge.review_summary || product?.review_summary),
        sponsorshipStatus: asString(badge.sponsorship_status) || 'unknown',
        evidenceStrength: asString(badge.evidence_strength) || 'weak',
        supportingSources: [],
        freshness: normalizeTimestamp(rawEvidencePack?.observed_at),
      });
    })
    .filter(Boolean);
}

function collectExternalHighlightSignals({ product, rawEvidencePack = null } = {}) {
  const signals = normalizeExternalHighlightSignals([
    ...toList(rawEvidencePack?.external_highlight_signals),
    ...toList(product?.external_highlight_signals),
    ...buildSignalsFromCommunity(product, rawEvidencePack),
    ...buildSignalsFromBadges(product, rawEvidencePack),
  ]);
  return {
    raw_evidence_pack: {
      review_summary: normalizeReviewSummary(product?.review_summary || rawEvidencePack?.review_summary),
      community_signals:
        asObject(product?.community_signals) ||
        asObject(product?.communitySignals) ||
        asObject(rawEvidencePack?.community_signals) ||
        null,
      market_signal_badges: normalizeMarketSignalBadges(
        rawEvidencePack?.market_signal_badges || product?.market_signal_badges,
      ),
      supporting_sources: toList(rawEvidencePack?.supporting_sources).map((item) => ({
        label: asString(item?.label),
        url: asString(item?.url),
        published_at: normalizeTimestamp(item?.published_at),
        sponsorship_status: asString(item?.sponsorship_status || item?.sponsorship) || 'unknown',
      })),
      observed_at: normalizeTimestamp(rawEvidencePack?.observed_at) || new Date().toISOString(),
    },
    external_highlight_signals: signals,
  };
}

function signalToWhyItem(signal) {
  const claimText = asString(signal?.claim_text);
  if (!claimText) return null;
  const sourceType = asString(signal?.source_type);
  const claimType = asString(signal?.claim_type);
  const headline =
    sourceType === 'creator_social_consensus'
      ? 'Creator-backed signal'
      : sourceType === 'verified_reviews'
        ? 'Review-backed signal'
        : claimType === 'texture_finish'
          ? 'Texture signal'
          : 'External highlight';
  return {
    headline,
    body: claimText.endsWith('.') ? claimText : `${claimText}.`,
    evidence_strength: 'external_highlight',
    source_type: sourceType || null,
    claim_type: claimType || null,
    signal_id: asString(signal?.signal_id) || null,
  };
}

function augmentProductIntelWithHighlights({
  baseBundle,
  product = null,
  externalHighlightSignals = [],
  evidenceModel = 'external_highlight_pipeline_v1',
  generatedAt = new Date().toISOString(),
} = {}) {
  const bundle = deepClone(baseBundle);
  if (!bundle || typeof bundle !== 'object') return null;
  const normalizedSignals = normalizeExternalHighlightSignals(externalHighlightSignals);
  bundle.external_highlight_signals = normalizedSignals;

  const applied = {
    why_it_stands_out_signal_ids: [],
    watchout_signal_ids: [],
    texture_finish_notes: [],
  };

  const whySignals = filterSurfaceableExternalHighlightSignals(normalizedSignals, {
    surfaceTarget: 'why_it_stands_out',
  });
  const fallbackWhySignal =
    whySignals[0] ||
    filterSurfaceableExternalHighlightSignals(normalizedSignals, {
      surfaceTarget: 'shopping_card_highlight',
    })[0] ||
    null;
  if (fallbackWhySignal) {
    const whyItem = signalToWhyItem(fallbackWhySignal);
    const existing = toList(bundle?.product_intel_core?.why_it_stands_out);
    const deduped = existing.filter(
      (item) => asString(item?.evidence_strength).toLowerCase() !== 'external_highlight',
    );
    if (whyItem) {
      deduped.push(whyItem);
      applied.why_it_stands_out_signal_ids.push(asString(fallbackWhySignal.signal_id));
    }
    bundle.product_intel_core = {
      ...(bundle.product_intel_core || {}),
      why_it_stands_out: deduped.slice(0, 4),
    };
  }

  const watchoutSignals = filterSurfaceableExternalHighlightSignals(normalizedSignals, {
    surfaceTarget: 'watchouts',
    allowNegative: true,
  }).filter((signal) => ['mixed', 'negative'].includes(asString(signal.stance)));
  if (watchoutSignals.length) {
    const existing = toList(bundle?.product_intel_core?.watchouts).filter(
      (item) => asString(item?.type).toLowerCase() !== 'external_highlight',
    );
    for (const signal of watchoutSignals.slice(0, 2)) {
      const label = asString(signal.claim_text);
      if (!label) continue;
      if (existing.some((item) => asString(item?.label).toLowerCase() === label.toLowerCase())) continue;
      existing.push({
        type: 'external_highlight',
        label: label.endsWith('.') ? label : `${label}.`,
        severity: asString(signal.stance) === 'negative' ? 'high' : 'medium',
        signal_id: asString(signal.signal_id),
      });
      applied.watchout_signal_ids.push(asString(signal.signal_id));
    }
    bundle.product_intel_core = {
      ...(bundle.product_intel_core || {}),
      watchouts: existing.slice(0, 4),
    };
  }

  const textureSignals = filterSurfaceableExternalHighlightSignals(normalizedSignals, {
    surfaceTarget: 'texture_finish',
  });
  if (textureSignals.length && asObject(bundle.texture_finish)) {
    const existingNotes = uniqueStrings(bundle.texture_finish.sensory_notes);
    for (const signal of textureSignals.slice(0, 1)) {
      const note = asString(signal.claim_text);
      if (!note) continue;
      if (existingNotes.some((item) => item.toLowerCase() === note.toLowerCase())) continue;
      existingNotes.push(note);
      applied.texture_finish_notes.push(note);
    }
    bundle.texture_finish = {
      ...bundle.texture_finish,
      sensory_notes: existingNotes.slice(0, 4),
    };
  }

  bundle.provenance = {
    ...(bundle.provenance || {}),
    external_highlight_review_status: 'pending',
    external_evidence_generated_at: normalizeTimestamp(generatedAt) || generatedAt,
    external_evidence_model: asString(evidenceModel) || 'external_highlight_pipeline_v1',
    external_highlight_applied: applied,
  };

  bundle.shopping_card = buildShoppingCardPayload({ product, bundle });
  bundle.search_card = buildSearchCardPayload({ product, bundle });
  return bundle;
}

function stripAppliedExternalHighlightFields(bundle) {
  const next = deepClone(bundle);
  if (!next || typeof next !== 'object') return next;
  const applied = asObject(next?.provenance?.external_highlight_applied) || {};
  next.external_highlight_signals = [];
  if (asObject(next.shopping_card)) {
    delete next.shopping_card.highlight;
    delete next.shopping_card.external_highlight_signals;
  }
  if (asObject(next.search_card)) {
    delete next.search_card.highlight_candidate;
  }
  if (asObject(next.product_intel_core)) {
    next.product_intel_core = {
      ...next.product_intel_core,
      why_it_stands_out: toList(next.product_intel_core.why_it_stands_out).filter(
        (item) => asString(item?.evidence_strength).toLowerCase() !== 'external_highlight',
      ),
      watchouts: toList(next.product_intel_core.watchouts).filter(
        (item) => asString(item?.type).toLowerCase() !== 'external_highlight',
      ),
    };
  }
  if (asObject(next.texture_finish) && Array.isArray(next.texture_finish.sensory_notes)) {
    const appliedNotes = new Set(
      toList(applied.texture_finish_notes).map((item) => asString(item).toLowerCase()),
    );
    next.texture_finish = {
      ...next.texture_finish,
      sensory_notes: toList(next.texture_finish.sensory_notes).filter(
        (item) => !appliedNotes.has(asString(item).toLowerCase()),
      ),
    };
  }
  return next;
}

function applyExternalHighlightReviewDecision({
  bundle,
  product = null,
  decision = 'pass',
  rewrite = {},
  notes = '',
  reviewBatch = '',
} = {}) {
  const normalizedDecision = asString(decision).toLowerCase() || 'pass';
  let next = deepClone(bundle);
  if (!next || typeof next !== 'object') return null;

  if (normalizedDecision === 'reject_external' || normalizedDecision === 'seller_only_fallback') {
    next = stripAppliedExternalHighlightFields(next);
  } else if (normalizedDecision === 'rewrite') {
    if (Array.isArray(rewrite.external_highlight_signals)) {
      next.external_highlight_signals = normalizeExternalHighlightSignals(rewrite.external_highlight_signals);
    }
    if (asObject(rewrite.product_intel_core)) {
      next.product_intel_core = {
        ...(next.product_intel_core || {}),
        ...deepClone(rewrite.product_intel_core),
      };
    }
    if (asObject(rewrite.texture_finish)) {
      next.texture_finish = {
        ...(next.texture_finish || {}),
        ...deepClone(rewrite.texture_finish),
      };
    }
    if (asObject(rewrite.shopping_card)) {
      next.shopping_card = {
        ...(next.shopping_card || {}),
        ...deepClone(rewrite.shopping_card),
      };
    }
    if (asObject(rewrite.search_card)) {
      next.search_card = {
        ...(next.search_card || {}),
        ...deepClone(rewrite.search_card),
      };
    }
  }

  next.provenance = {
    ...(next.provenance || {}),
    external_highlight_review_status: normalizedDecision,
    external_review_batch: asString(reviewBatch) || undefined,
    external_review_notes: asString(notes) || undefined,
  };
  next.shopping_card = buildShoppingCardPayload({ product, bundle: next });
  next.search_card = buildSearchCardPayload({ product, bundle: next });
  return next;
}

module.exports = {
  applyExternalHighlightReviewDecision,
  augmentProductIntelWithHighlights,
  collectExternalHighlightSignals,
  inferClaimType,
};
