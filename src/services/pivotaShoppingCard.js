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
  return toList(value)
    .map((item) => {
      const row = item && typeof item === 'object' ? item : null;
      const badgeLabel = asString(row?.badge_label || row?.label || item);
      if (!badgeLabel) return null;
      return {
        badge_type: asString(row?.badge_type || row?.type),
        badge_label: badgeLabel,
      };
    })
    .filter(Boolean);
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
  const explicit = normalizeBadgeCandidates(
    bundle?.market_signal_badges || safeProduct.market_signal_badges,
  );
  if (explicit.length) return explicit[0];

  const review =
    safeProduct.review_summary && typeof safeProduct.review_summary === 'object'
      ? safeProduct.review_summary
      : {};
  const rating = Number(review.rating || review.average_rating || 0) || 0;
  const reviewCount = Number(review.review_count || review.reviewCount || 0) || 0;
  if (rating >= 4.5 && reviewCount >= 100) {
    return {
      badge_type: 'review_signal',
      badge_label: `${rating.toFixed(1)}★ (${formatCompactCount(reviewCount)})`,
    };
  }

  const counts =
    safeProduct.community_signals && typeof safeProduct.community_signals === 'object'
      ? safeProduct.community_signals.source_counts || {}
      : {};
  const editorial = Number(counts.editorial || 0) || 0;
  const creatorMentions = Number(counts.creator_mentions || counts.creatorMentions || 0) || 0;
  const media = Number(counts.media || 0) || 0;
  if (editorial >= 3) {
    return {
      badge_type: 'editorial_signal',
      badge_label: `Seen in ${editorial} editor picks`,
    };
  }
  if (creatorMentions >= 8) {
    return {
      badge_type: 'creator_signal',
      badge_label: `Seen in ${creatorMentions} creator mentions`,
    };
  }
  if (media >= 3) {
    return {
      badge_type: 'media_signal',
      badge_label: `Seen in ${media} media mentions`,
    };
  }
  return null;
}

function buildTitleCandidate(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const brand = asString(safeProduct.brand);
  const title = asString(safeProduct.title || safeProduct.name);
  if (!brand || !title) return title || 'Untitled product';
  if (title.toLowerCase().startsWith(brand.toLowerCase())) return title;
  return `${brand} ${title}`.trim();
}

function buildShoppingCardPayload({ product, bundle }) {
  const title = buildTitleCandidate(product);
  const subtitle = buildCompactSubtitle({ product, bundle });
  const proofBadge = buildProofBadge({ product, bundle });
  const intro = asString(bundle?.product_intel_core?.what_it_is?.body);
  const marketSignalBadges = normalizeBadgeCandidates(
    bundle?.market_signal_badges || (proofBadge ? [proofBadge] : []),
  );

  return {
    contract_version: 'pivota.shopping_card.v1',
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(proofBadge?.badge_label ? { proof_badge: proofBadge.badge_label } : {}),
    ...(intro ? { intro } : {}),
    ...(marketSignalBadges.length ? { market_signal_badges: marketSignalBadges } : {}),
    ...(asString(bundle?.evidence_profile) ? { evidence_profile: asString(bundle.evidence_profile) } : {}),
  };
}

function buildSearchCardPayload({ product, bundle }) {
  const shoppingCard = buildShoppingCardPayload({ product, bundle });
  return {
    title_candidate: shoppingCard.title,
    ...(shoppingCard.subtitle ? { compact_candidate: shoppingCard.subtitle } : {}),
    ...(shoppingCard.proof_badge ? { proof_badge_candidate: shoppingCard.proof_badge } : {}),
    ...(shoppingCard.intro ? { intro_candidate: shoppingCard.intro } : {}),
  };
}

module.exports = {
  buildCompactSubtitle,
  buildProofBadge,
  buildSearchCardPayload,
  buildShoppingCardPayload,
  buildTitleCandidate,
  normalizeBadgeCandidates,
};
