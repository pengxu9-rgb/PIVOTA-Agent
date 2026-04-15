const PRODUCT_INTEL_CONTRACT_VERSION = 'pivota.product_intel.v1';
const PRODUCT_FEEDBACK_CONTRACT_VERSION = 'pivota.product_feedback.v1';
const PRODUCT_RECOMMENDATION_INTENTS_CONTRACT_VERSION = 'pivota.product_recommendation_intents.v1';
const PIVOTA_INSIGHTS_DISPLAY_NAME = 'Pivota Insights';
const { buildAuthoritativeIngredientView } = require('./services/pdpIngredientAuthority');
const {
  buildSearchCardPayload,
  buildShoppingCardPayload,
  normalizeCardIntroCandidate,
} = require('./services/pivotaShoppingCard');
const {
  filterDisplayableMarketSignalBadges,
  normalizeExternalHighlightSignals,
  normalizeMarketSignalBadges,
  normalizeReviewSummary,
  normalizeSurfaceText,
} = require('./services/pivotaEvidenceSignals');
const PRODUCT_INTEL_ALLOWLIST = new Set(
  String(process.env.PDP_PRODUCT_INTEL_ALLOWLIST || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return '';
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of asArray(values)) {
    const text = asString(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function stripHtml(input) {
  return String(input || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toSentence(text, fallback) {
  const clean = stripHtml(text);
  if (!clean) return fallback;
  if (/[.!?]$/.test(clean)) return clean;
  return `${clean}.`;
}

function stripWhatItIsPromoPrefixes(text) {
  return String(text || '')
    .replace(/^double up and save with\s+/i, '')
    .replace(/^this\s+jumbo\s+size\s+of\s+/i, '')
    .replace(/^jumbo\s+size\s+of\s+/i, '')
    .replace(/^our\s+jumbo\s+size\s+of\s+/i, '')
    .trim();
}

function stripWhatItIsFootnotes(text) {
  return String(text || '')
    .replace(/\*{1,2}\s*in an?\s+\d+[-\s]?week clinical study[\s\S]*$/i, '')
    .replace(/in an?\s+\d+[-\s]?week clinical study[\s\S]*$/i, '')
    .trim();
}

function stripSellerMerchandisingLead(text) {
  return String(text || '')
    .replace(/^double up and save with\s+/i, '')
    .replace(/^stock up with\s+/i, '')
    .replace(/^save with\s+/i, '')
    .replace(/^offered in (an? )?/i, '')
    .replace(/^available in (an? )?/i, '')
    .replace(/^this\s+jumbo\s+size\s+of\s+/i, '')
    .replace(/^jumbo\s+size\s+of\s+/i, '')
    .replace(/^our\s+jumbo\s+size\s+of\s+/i, '')
    .trim();
}

function isLowSignalSellerHighlightText(text) {
  const normalized = stripHtml(text).toLowerCase();
  if (!normalized) return false;
  return /(^|\b)(double up and save|stock up|save with|jumbo size|travel size|value size|value pack|limited edition|extended use)(\b|$)/.test(
    normalized,
  );
}

function isGenericSellerHighlightText(text) {
  const normalized = stripHtml(text).toLowerCase();
  if (!normalized) return false;
  return [
    /\bpositions? itself\b/,
    /\bcenters? its\b.*\bstory\b/,
    /\bbuilds? its\b.*\bstory\b/,
    /\bformula story\b/,
    /\bvisible-[a-z-]+\s+story\b/,
    /\bpositioning\b/,
    /\bframes? itself as\b/,
    /\blisting[-\s]?grounded\b/,
    /\bdefines? the product around the title\b/,
    /\btitle[-\s]?driven\b/,
    /\bleans toward\b/,
    /\bdedicated treatment step\b/,
    /\bplain barrier cream\b/,
    /\bgeneral face brightening serum\b/,
    /\bpresented through merchant product data\b/,
    /\bfocused on .* within a .* routine\b/,
    /\banchors? the product\b/,
    /\bdaytime uv step\b/,
    /\bdaytime skin-?care routines?\b/,
    /\bproduct data\b.*\broutine\b/,
    /\broutine context\b/,
    /\bfunctioning as\b/,
    /\bacting like\b/,
    /\brole\b/,
    /\bformat\b/,
  ].some((pattern) => pattern.test(normalized));
}

function shouldSuppressSellerHighlightText(text) {
  return isLowSignalSellerHighlightText(text) || isGenericSellerHighlightText(text);
}

function readBestForLabel(item) {
  if (typeof item === 'string') return asString(item);
  const row = asPlainObject(item) || {};
  return firstNonEmptyString(row.label, row.tag);
}

function isGenericBestForItem(item) {
  const row = asPlainObject(item) || {};
  const label = readBestForLabel(item);
  const tag = asString(row.tag).toLowerCase();
  const confidence = asString(row.confidence).toLowerCase();
  const normalizedLabel = label.toLowerCase();
  const combined = `${normalizedLabel} ${tag}`.trim();
  if (!combined) return true;
  if (/\bshoppers?\b/.test(combined)) return true;
  if (/^(daily use|everyday use|daytime wear|daily uv protection|general use|all skin types?)$/.test(normalizedLabel)) {
    return true;
  }
  if (
    ['daily', 'daytime_use', 'general_use', 'category', 'product'].includes(tag) &&
    (!label || confidence === 'low')
  ) {
    return true;
  }
  return false;
}

function sanitizeBestForItems(items) {
  return asArray(items).filter((item) => !isGenericBestForItem(item));
}

function hasProductSpecificIntelText(text) {
  const normalized = stripHtml(text).toLowerCase();
  if (!normalized) return false;
  return [
    /\bspf\s*\d+\b/,
    /\bzinc oxide\b/,
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
  ].some((pattern) => pattern.test(normalized));
}

function isHumanReviewedProductIntelBundle(bundle) {
  const source = asPlainObject(bundle);
  const provenance = asPlainObject(source?.provenance);
  const qualityGate = asPlainObject(provenance?.gemini_quality_gate);
  const fieldSources = asPlainObject(provenance?.field_sources);
  const core = asPlainObject(source?.product_intel_core);
  const freshness = asPlainObject(source?.freshness) || asPlainObject(core?.freshness);
  const sourceVersion = asString(freshness?.source_version);
  const sourceQualityState = asString(source?.quality_state || core?.quality_state).toLowerCase();
  const sourceEvidenceProfile = asString(source?.evidence_profile || core?.evidence_profile).toLowerCase();
  const provenanceSource = asString(provenance?.source).toLowerCase();
  const reviewStatus = asString(provenance?.review_status).toLowerCase();
  const reviewDecision = asString(provenance?.review_decision).toLowerCase();
  const generator = asString(provenance?.generator).toLowerCase();
  const reviewerKind = asString(provenance?.reviewer_kind).toLowerCase();
  const selectedStrategy = asString(provenance?.selection_strategy).toLowerCase();
  const hasHumanField = Object.values(fieldSources || {}).some(
    (value) => asString(value).toLowerCase() === 'human_standard',
  );

  if (sourceVersion === 'pilot_selected:strict_human_reviewed') return true;
  if (generator === 'strict_human_manual_rewrite') return true;
  if (hasHumanField && qualityGate?.human_standard_rewrite === true) return true;
  if (
    reviewerKind === 'assistant' &&
    reviewStatus === 'completed' &&
    ['pass', 'rewrite', 'seller_only_fallback'].includes(reviewDecision) &&
    selectedStrategy === 'curated_override' &&
    ['seller_only', 'seller_plus_formula'].includes(sourceEvidenceProfile)
  ) {
    return true;
  }
  if (
    provenanceSource === 'aurora_product_intel_kb' &&
    sourceQualityState === 'verified' &&
    sourceEvidenceProfile === 'pivota_reviewed'
  ) {
    return true;
  }
  return (
    reviewerKind === 'human' &&
    reviewStatus === 'completed' &&
    ['pass', 'rewrite'].includes(reviewDecision) &&
    selectedStrategy.includes('strict_human')
  );
}

function shouldRejectGenericProductIntelBundle(bundle) {
  const source = asPlainObject(bundle);
  const core = asPlainObject(source?.product_intel_core);
  if (!core) return true;
  const whyText = asArray(core.why_it_stands_out)
    .map((item) => {
      const row = asPlainObject(item) || {};
      return `${row.headline || ''} ${row.body || ''}`;
    })
    .join(' ');
  const bestForText = sanitizeBestForItems(core.best_for)
    .map((item) => {
      const row = asPlainObject(item) || {};
      return `${readBestForLabel(item) || ''} ${row.tag || ''}`;
    })
    .join(' ');
  const primaryText = [
    core.what_it_is?.headline,
    core.what_it_is?.body,
    bestForText,
    core.routine_fit?.step,
    ...asArray(core.routine_fit?.pairing_notes),
  ]
    .map((value) => asString(value))
    .filter(Boolean)
    .join(' ');
  const combined = [primaryText, whyText].filter(Boolean).join(' ');
  if (!combined) return true;
  if (isHumanReviewedProductIntelBundle(source)) return false;
  if (isGenericSellerHighlightText(primaryText) && !hasProductSpecificIntelText(combined)) return true;
  return false;
}

function joinWithCommasAnd(values) {
  const items = asArray(values).map((value) => asString(value)).filter(Boolean);
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function describeConcernCoverage(concerns, step) {
  const labels = asArray(concerns).map((item) => asString(item)).filter(Boolean);
  if (!labels.length) return '';
  const joined = joinWithCommasAnd(labels);
  if (step === 'serum') return `Addresses ${joined} in one serum step.`;
  if (step === 'moisturizer') return `Covers ${joined} in a daily moisturizer step.`;
  if (step === 'sunscreen') return `Combines ${joined} with daytime sun protection in one morning step.`;
  return `Covers ${joined} in one product step.`;
}

function firstMeaningfulHighlightSentence(text, { sellerOnly = false } = {}) {
  const clean = stripWhatItIsFootnotes(stripHtml(text));
  if (!clean) return '';
  const sentences = clean.match(/[^.!?]+[.!?]?/g) || [];
  for (const sentence of sentences) {
    const normalized = toSentence(stripSellerMerchandisingLead(sentence), '').trim();
    if (!normalized || normalized.length < 24) continue;
    if (sellerOnly && shouldSuppressSellerHighlightText(normalized)) continue;
    return normalized;
  }
  const fallback = toSentence(stripSellerMerchandisingLead(clean), '').trim();
  if (!fallback) return '';
  if (sellerOnly && shouldSuppressSellerHighlightText(fallback)) return '';
  return fallback;
}

function compactWhatItIsBody(text, { sellerOnly = false, fallback = '' } = {}) {
  const maxChars = sellerOnly ? 320 : 420;
  const clean = stripHtml(stripWhatItIsFootnotes(stripWhatItIsPromoPrefixes(text)));
  if (!clean) return toSentence(fallback, fallback);
  if (clean.length <= maxChars) return toSentence(clean, fallback);

  const sentences = clean.match(/[^.!?]+[.!?]?/g) || [];
  let picked = '';
  for (const sentence of sentences) {
    const next = picked ? `${picked} ${sentence.trim()}` : sentence.trim();
    if (next.length > maxChars) break;
    picked = next;
    if (picked.length >= Math.floor(maxChars * 0.72)) break;
  }
  if (picked) return toSentence(picked, fallback);

  const trimmed = clean.slice(0, maxChars);
  const boundary = trimmed.lastIndexOf(' ');
  const compact =
    boundary >= Math.floor(maxChars * 0.6) ? trimmed.slice(0, boundary).trim() : trimmed.trim();
  return toSentence(compact, fallback);
}

function normalizeTimestamp(value) {
  const text = asString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampConfidence(level, { sellerOnly = false } = {}) {
  const normalized = asString(level).toLowerCase();
  if (sellerOnly && normalized === 'high') return 'moderate';
  if (normalized === 'high' || normalized === 'moderate' || normalized === 'low') return normalized;
  return sellerOnly ? 'moderate' : 'low';
}

function confidenceFromScore(score, { sellerOnly = false } = {}) {
  const value = typeof score === 'number' ? score : Number(score);
  if (!Number.isFinite(value)) return sellerOnly ? 'moderate' : 'low';
  if (value >= 0.75) return sellerOnly ? 'moderate' : 'high';
  if (value >= 0.4) return 'moderate';
  return 'low';
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  if (typeof value === 'string') {
    return uniqueStrings(
      value
        .split(/[•,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
  return [];
}

function canonicalizeProductUrlForIntelKb(rawUrl) {
  const text = asString(rawUrl);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    parsed.hash = '';
    const trackingParams = new Set(['fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid', 'ref', 'ref_src']);
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = String(key || '').toLowerCase();
      if (lower.startsWith('utm_') || trackingParams.has(lower)) parsed.searchParams.delete(key);
    }
    if (typeof parsed.searchParams.sort === 'function') parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return text;
  }
}

function readAssessment(product) {
  return asPlainObject(product.assessment) || null;
}

function readAssessmentStrings(product, ...keys) {
  const assessment = readAssessment(product);
  if (!assessment) return [];
  for (const key of keys) {
    const value = assessment[key];
    const normalized = normalizeStringList(value);
    if (normalized.length) return normalized;
  }
  return [];
}

function readCategory(product) {
  return firstNonEmptyString(product.category, product.product_type, product.productType);
}

function readTags(product) {
  const raw = product.tags;
  if (Array.isArray(raw)) return uniqueStrings(raw.map((tag) => asString(tag)).filter(Boolean));
  if (typeof raw === 'string') return uniqueStrings(raw.split(',').map((tag) => tag.trim()));
  return [];
}

function buildCombinedText(product) {
  return [
    product.title,
    product.name,
    product.subtitle,
    product.description,
    readCategory(product),
    readTags(product).join(' '),
  ]
    .map((value) => stripHtml(value))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function readRawIngredients(product) {
  const authority = buildAuthoritativeIngredientView(product);
  if (Array.isArray(authority.items) && authority.items.length) return authority.items;
  return [];
}

function readPublishedIntelSource(product) {
  const intelContainer = asPlainObject(product.product_intel) || asPlainObject(product.productIntel) || null;
  const assessment =
    asPlainObject(intelContainer?.assessment) ||
    asPlainObject(product.assessment) ||
    null;
  const evidence =
    asPlainObject(intelContainer?.evidence) ||
    asPlainObject(product.evidence) ||
    null;
  const socialSignals =
    asPlainObject(intelContainer?.social_signals) ||
    asPlainObject(intelContainer?.socialSignals) ||
    asPlainObject(evidence?.social_signals) ||
    asPlainObject(evidence?.socialSignals) ||
    asPlainObject(product.community_signals) ||
    asPlainObject(product.communitySignals) ||
    asPlainObject(product.social_signals) ||
    asPlainObject(product.socialSignals) ||
    null;
  const provenance =
    asPlainObject(intelContainer?.provenance) ||
    asPlainObject(product.provenance) ||
    null;

  if (!assessment && !evidence && !socialSignals && !intelContainer) return null;

  return {
    intel_container: intelContainer,
    assessment,
    evidence,
    social_signals: socialSignals,
    provenance,
  };
}

function normalizePublishedProductIntelBundle(bundle, {
  relatedProducts = [],
  offersData = null,
  canonicalProductRef = null,
  productGroupId = null,
  provenance = null,
  requireReviewed = false,
} = {}) {
  const source = asPlainObject(bundle);
  if (!source) return null;
  const core = asPlainObject(source.product_intel_core);
  if (!core) return null;
  const reviewedForPublicDisplay = isHumanReviewedProductIntelBundle(source);
  if (requireReviewed && !reviewedForPublicDisplay) return null;
  if (shouldRejectGenericProductIntelBundle(source)) return null;

  const recommendationIntents =
    asPlainObject(source.recommendation_intents) ||
    buildRecommendationIntents(relatedProducts);
  const offers = Array.isArray(offersData?.offers) ? offersData.offers : [];
  const commerceModes = uniqueStrings(offers.map((offer) => asString(offer?.commerce_mode)));
  const marketSignalBadges = asArray(source.market_signal_badges).map(asPlainObject).filter(Boolean);
  const coreEvidenceProfile =
    asString(core.evidence_profile) || asString(source.evidence_profile) || 'seller_only';
  const normalizedCore = {
    ...core,
    what_it_is: {
      ...(asPlainObject(core.what_it_is) || {}),
      body: compactWhatItIsBody(core.what_it_is?.body, {
        sellerOnly:
          coreEvidenceProfile === 'seller_only' || coreEvidenceProfile === 'seller_plus_formula',
        fallback: core.what_it_is?.body || '',
      }),
    },
    best_for: sanitizeBestForItems(core.best_for),
    why_it_stands_out: asArray(core.why_it_stands_out)
      .filter((item) => {
        const row = asPlainObject(item) || {};
        const sellerOnly =
          coreEvidenceProfile === 'seller_only' || coreEvidenceProfile === 'seller_plus_formula';
        if (!sellerOnly) return true;
        return !shouldSuppressSellerHighlightText(`${row.headline || ''} ${row.body || ''}`);
      })
      .map((item) => {
        const row = asPlainObject(item) || {};
        return {
          ...row,
          body: toSentence(stripSellerMerchandisingLead(row.body), row.body),
        };
      }),
  };
  const reviewSummary = normalizeReviewSummary(source.review_summary || source.reviewSummary);
  const normalizedMarketSignalBadges = filterDisplayableMarketSignalBadges(
    source.market_signal_badges || source.marketSignalBadges,
    {
      review_summary: reviewSummary,
      community_signals: asPlainObject(source.community_signals) || null,
    },
  );
  const externalHighlightSignals = normalizeExternalHighlightSignals(
    source.external_highlight_signals || source.externalHighlightSignals,
  );
  const shoppingCardSource = asPlainObject(source.shopping_card) || asPlainObject(source.shoppingCard) || null;
  const searchCardSource = asPlainObject(source.search_card) || asPlainObject(source.searchCard) || null;
  const shoppingCardHighlight = normalizeSurfaceText(
    firstNonEmptyString(shoppingCardSource?.highlight, searchCardSource?.highlight_candidate),
  );
  const searchCardHighlight = normalizeSurfaceText(
    firstNonEmptyString(searchCardSource?.highlight_candidate, shoppingCardSource?.highlight),
  );
  const shoppingCardIntro = normalizeCardIntroCandidate(
    firstNonEmptyString(shoppingCardSource?.intro, searchCardSource?.intro_candidate),
    { fallback: normalizedCore.what_it_is?.body },
  );
  const searchCardIntro = normalizeCardIntroCandidate(
    firstNonEmptyString(searchCardSource?.intro_candidate, shoppingCardSource?.intro),
    { fallback: normalizedCore.what_it_is?.body },
  );

  return {
    contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
    display_name: PIVOTA_INSIGHTS_DISPLAY_NAME,
    canonical_product_ref: canonicalProductRef || source.canonical_product_ref || null,
    product_group_id: productGroupId || source.product_group_id || null,
    product_intel_core: {
      ...normalizedCore,
      display_name: PIVOTA_INSIGHTS_DISPLAY_NAME,
      freshness: asPlainObject(core.freshness) || asPlainObject(source.freshness) || buildFreshness({}),
      quality_state:
        asString(core.quality_state) || asString(source.quality_state) || 'limited',
      evidence_profile: coreEvidenceProfile,
      source_coverage:
        asPlainObject(core.source_coverage) ||
        asPlainObject(source.source_coverage) ||
        null,
    },
    texture_finish: asPlainObject(source.texture_finish) || null,
    community_signals: asPlainObject(source.community_signals) || {
      status: 'unavailable',
      unavailable_reason: 'insufficient_feedback',
      confidence: 'low',
      evidence_profile: asString(source.evidence_profile) || 'seller_only',
    },
    recommendation_intents: recommendationIntents,
    ...(reviewSummary ? { review_summary: reviewSummary } : {}),
    ...(normalizedMarketSignalBadges.length ? { market_signal_badges: normalizedMarketSignalBadges } : {}),
    external_highlight_signals: externalHighlightSignals,
    ...(shoppingCardSource
      ? {
          shopping_card: {
            contract_version: asString(shoppingCardSource.contract_version) || 'pivota.shopping_card.v1',
            ...(asString(shoppingCardSource.title) ? { title: asString(shoppingCardSource.title) } : {}),
            ...(asString(shoppingCardSource.subtitle) ? { subtitle: asString(shoppingCardSource.subtitle) } : {}),
            ...(shoppingCardHighlight ? { highlight: shoppingCardHighlight } : {}),
            ...(asString(shoppingCardSource.proof_badge) ? { proof_badge: asString(shoppingCardSource.proof_badge) } : {}),
            ...(shoppingCardIntro ? { intro: shoppingCardIntro } : {}),
            ...(Array.isArray(shoppingCardSource.market_signal_badges)
              ? { market_signal_badges: normalizeMarketSignalBadges(shoppingCardSource.market_signal_badges) }
              : {}),
            ...(asString(shoppingCardSource.evidence_profile)
              ? { evidence_profile: asString(shoppingCardSource.evidence_profile) }
              : {}),
          },
        }
      : {}),
    ...(searchCardSource
      ? {
          search_card: {
            ...(asString(searchCardSource.title_candidate)
              ? { title_candidate: asString(searchCardSource.title_candidate) }
              : {}),
            ...(asString(searchCardSource.compact_candidate)
              ? { compact_candidate: asString(searchCardSource.compact_candidate) }
              : {}),
            ...(searchCardHighlight ? { highlight_candidate: searchCardHighlight } : {}),
            ...(asString(searchCardSource.proof_badge_candidate)
              ? { proof_badge_candidate: asString(searchCardSource.proof_badge_candidate) }
              : {}),
            ...(searchCardIntro ? { intro_candidate: searchCardIntro } : {}),
          },
        }
      : {}),
    quality_state: asString(source.quality_state) || asString(core.quality_state) || 'limited',
    evidence_profile:
      asString(source.evidence_profile) || asString(core.evidence_profile) || 'seller_only',
    source_coverage:
      asPlainObject(source.source_coverage) ||
      asPlainObject(core.source_coverage) ||
      null,
    confidence:
      asPlainObject(source.confidence) ||
      asPlainObject(core.confidence) ||
      null,
    freshness:
      asPlainObject(source.freshness) ||
      asPlainObject(core.freshness) ||
      buildFreshness({}),
    ...(marketSignalBadges.length ? { market_signal_badges: marketSignalBadges } : {}),
    offer_pointers: {
      ...(asPlainObject(source.offer_pointers) || {}),
      offers_count: offers.length,
      default_offer_id: offersData?.default_offer_id || source.offer_pointers?.default_offer_id || null,
      best_price_offer_id:
        offersData?.best_price_offer_id || source.offer_pointers?.best_price_offer_id || null,
      commerce_modes: commerceModes,
    },
    provenance: (() => {
      const sourceProvenance = asPlainObject(source.provenance);
      const overlayProvenance = asPlainObject(provenance);
      if (!sourceProvenance && !overlayProvenance) return null;
      return {
        ...(sourceProvenance || {}),
        ...(overlayProvenance || {}),
      };
    })(),
  };
}

function readPublishedProductIntelBundle(product, context = {}) {
  const intelContainer = asPlainObject(product.product_intel) || asPlainObject(product.productIntel) || null;
  if (!intelContainer) return null;
  const contractVersion = asString(intelContainer.contract_version || intelContainer.contractVersion);
  if (contractVersion !== PRODUCT_INTEL_CONTRACT_VERSION) return null;
  if (!asPlainObject(intelContainer.product_intel_core)) return null;
  return normalizePublishedProductIntelBundle(intelContainer, context);
}

function buildPublishedIntelKbKeys(product, canonicalProductRef = null, options = {}) {
  const keys = [];
  const push = (value) => {
    const text = asString(value);
    if (!text) return;
    if (keys.includes(text)) return;
    keys.push(text);
  };

  push(`product:${firstNonEmptyString(canonicalProductRef?.product_id, product.product_id, product.id)}`);
  push(`product:${firstNonEmptyString(product.platform_product_id, product.platformProductId, product.shopify_id)}`);
  const productLineOptions = Array.isArray(product.product_line_options)
    ? product.product_line_options
    : Array.isArray(product.productLineOptions)
      ? product.productLineOptions
      : [];
  for (const option of productLineOptions) {
    const optionProductId = firstNonEmptyString(option?.product_id, option?.productId, option?.id);
    if (!optionProductId) continue;
    push(`product:${optionProductId}`);
  }
  for (const ref of asArray(options.alternateCanonicalProductRefs).slice(0, 24)) {
    const refProductId = firstNonEmptyString(ref?.product_id, ref?.productId, ref?.id);
    if (!refProductId) continue;
    push(`product:${refProductId}`);
  }

  const urls = [
    product.product_url,
    product.productUrl,
    product.url,
    product.canonical_url,
    product.canonicalUrl,
    product.source_url,
    product.sourceUrl,
    product.handle_url,
    product.handleUrl,
  ]
    .map((value) => canonicalizeProductUrlForIntelKb(value))
    .filter(Boolean);
  for (const url of urls) push(`url:${url}`);

  return keys;
}

async function hydrateProductWithPublishedIntel({
  product,
  canonicalProductRef = null,
  alternateCanonicalProductRefs = [],
  requireReviewedBundle = false,
  allowLegacyAnalysisFallback = true,
} = {}) {
  const sourceProduct = asPlainObject(product) || {};
  const embeddedBundle = readPublishedProductIntelBundle(sourceProduct, { canonicalProductRef });

  let getProductIntelKbEntry = null;
  let getProductIntelKbEntries = null;
  let normalizeProductAnalysis = null;
  try {
    ({ getProductIntelKbEntry, getProductIntelKbEntries } = require('./auroraBff/productIntelKbStore'));
    ({ normalizeProductAnalysis } = require('./auroraBff/normalize'));
  } catch {
    return sourceProduct;
  }

  if (
    typeof getProductIntelKbEntry !== 'function' ||
    typeof normalizeProductAnalysis !== 'function'
  ) {
    return sourceProduct;
  }

  const kbKeys = buildPublishedIntelKbKeys(sourceProduct, canonicalProductRef, {
    alternateCanonicalProductRefs,
  });
  let kbEntryMap = null;
  if (typeof getProductIntelKbEntries === 'function' && kbKeys.length > 1) {
    try {
      kbEntryMap = await getProductIntelKbEntries(kbKeys);
    } catch {
      kbEntryMap = null;
    }
  }
  let firstUnavailableProduct = null;
  for (const kbKey of kbKeys) {
    let kbEntry = null;
    if (kbEntryMap && typeof kbEntryMap.get === 'function') {
      kbEntry = kbEntryMap.get(kbKey) || null;
    } else {
      try {
        // eslint-disable-next-line no-await-in-loop
        kbEntry = await getProductIntelKbEntry(kbKey);
      } catch {
        kbEntry = null;
      }
    }
    const kbAnalysis = asPlainObject(kbEntry?.analysis);
    if (!kbAnalysis) continue;
    const directBundleSource =
      asPlainObject(kbAnalysis.product_intel_v1) ||
      asPlainObject(kbAnalysis.product_intel) ||
      (asString(kbAnalysis.contract_version) === PRODUCT_INTEL_CONTRACT_VERSION ? kbAnalysis : null);
    const directBundle =
      normalizePublishedProductIntelBundle(
        directBundleSource,
        {
          canonicalProductRef,
          requireReviewed: requireReviewedBundle,
          provenance: {
            ...(asPlainObject(sourceProduct.provenance) || {}),
            kb_key: kbKey,
            source: asString(kbEntry?.source) || 'aurora_product_intel_kb',
            generated_at:
              normalizeTimestamp(kbEntry?.last_success_at) ||
              normalizeTimestamp(kbEntry?.updated_at) ||
              new Date().toISOString(),
          },
        },
      );
    if (directBundle) {
      return {
        ...sourceProduct,
        product_intel: directBundle,
        provenance: directBundle.provenance,
        product_intel_generated_at:
          normalizeTimestamp(kbEntry?.last_success_at) ||
          normalizeTimestamp(kbEntry?.updated_at) ||
          sourceProduct.product_intel_generated_at ||
          sourceProduct.productIntelGeneratedAt ||
          null,
        };
    }
    if (directBundleSource) {
      const unavailableProduct = {
        ...sourceProduct,
        product_intel_unavailable: {
          reason: requireReviewedBundle ? 'needs_review' : 'invalid_product_intel_bundle',
          kb_key: kbKey,
          source: asString(kbEntry?.source) || 'aurora_product_intel_kb',
        },
        provenance: {
          ...(asPlainObject(sourceProduct.provenance) || {}),
          kb_key: kbKey,
          source: asString(kbEntry?.source) || 'aurora_product_intel_kb',
          generated_at:
            normalizeTimestamp(kbEntry?.last_success_at) ||
            normalizeTimestamp(kbEntry?.updated_at) ||
            new Date().toISOString(),
        },
      };
      if (requireReviewedBundle) {
        if (!firstUnavailableProduct) firstUnavailableProduct = unavailableProduct;
        continue;
      }
      return unavailableProduct;
    }
    if (!allowLegacyAnalysisFallback) continue;
    const normalized = normalizeProductAnalysis(kbAnalysis);
    const payload = asPlainObject(normalized?.payload);
    const assessment = asPlainObject(payload?.assessment);
    const evidence = asPlainObject(payload?.evidence);
    if (!assessment && !evidence) continue;

    const socialSignals =
      asPlainObject(evidence?.social_signals) ||
      asPlainObject(evidence?.socialSignals) ||
      null;

    return {
      ...sourceProduct,
      ...(assessment ? { assessment } : {}),
      ...(evidence ? { evidence } : {}),
      ...(socialSignals ? { social_signals: socialSignals } : {}),
      provenance: {
        ...(asPlainObject(sourceProduct.provenance) || {}),
        kb_key: kbKey,
        source: asString(kbEntry?.source) || 'aurora_product_intel_kb',
        generated_at:
          normalizeTimestamp(kbEntry?.last_success_at) ||
          normalizeTimestamp(kbEntry?.updated_at) ||
          new Date().toISOString(),
      },
      product_intel_generated_at:
        normalizeTimestamp(kbEntry?.last_success_at) ||
        normalizeTimestamp(kbEntry?.updated_at) ||
        sourceProduct.product_intel_generated_at ||
        sourceProduct.productIntelGeneratedAt ||
        null,
    };
  }

  if (firstUnavailableProduct) return firstUnavailableProduct;
  if (embeddedBundle) return sourceProduct;
  return sourceProduct;
}

function isRolloutAllowed(product, canonicalProductRef) {
  if (!PRODUCT_INTEL_ALLOWLIST.size) return true;
  const productId = firstNonEmptyString(
    canonicalProductRef?.product_id,
    product.product_id,
    product.id,
  );
  const merchantId = firstNonEmptyString(
    canonicalProductRef?.merchant_id,
    product.merchant_id,
    product.merchant?.id,
  );
  if (productId && PRODUCT_INTEL_ALLOWLIST.has(productId)) return true;
  if (merchantId && productId && PRODUCT_INTEL_ALLOWLIST.has(`${merchantId}:${productId}`)) return true;
  return false;
}

function readKeyIngredients(product) {
  const authority = buildAuthoritativeIngredientView(product);
  if (Array.isArray(authority.active_items) && authority.active_items.length) {
    return authority.active_items.slice(0, 6);
  }
  const direct = normalizeStringList(
    product.key_ingredients ||
      product.keyIngredients ||
      product.hero_ingredients ||
      product.heroIngredients,
  );
  if (direct.length) return direct.slice(0, 6);

  const assessment = asPlainObject(product.assessment) || asPlainObject(product.product_intel) || null;
  const ingredientIntel = asPlainObject(assessment?.ingredient_intel || assessment?.ingredientIntel) || null;
  const evidence = asPlainObject(product.evidence) || null;
  const science = asPlainObject(evidence?.science) || null;
  return normalizeStringList(
    ingredientIntel?.hero_ingredients ||
      ingredientIntel?.heroIngredients ||
      science?.key_ingredients ||
      science?.keyIngredients,
  ).slice(0, 6);
}

function inferNamedActivesFromText(product) {
  const text = buildCombinedText(product);
  const patterns = [
    ['Vitamin C', /\bvitamin c\b/],
    ['Retinol', /\bretinol\b/],
    ['Niacinamide', /\bniacinamide\b/],
    ['Hyaluronic acid', /\bhyaluronic acid\b/],
    ['Salicylic acid', /\bsalicylic acid\b/],
    ['Glycolic acid', /\bglycolic acid\b/],
    ['Lactic acid', /\blactic acid\b/],
    ['Ceramides', /\bceramide\b/],
    ['Peptides', /\bpeptide\b/],
    ['Zinc oxide', /\bzinc oxide\b/],
  ];
  return patterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label)
    .slice(0, 5);
}

function inferConcernCoverageFromText(product) {
  const text = buildCombinedText(product);
  const concerns = [];
  const pushConcern = (label) => {
    if (!concerns.includes(label)) concerns.push(label);
  };
  if (/\b(bright|brighten|dark spot|uneven tone|tone)\b/.test(text)) pushConcern('brightness');
  if (/\b(texture|smooth|refine|resurface)\b/.test(text)) pushConcern('smoother texture');
  if (/\b(fine lines?|wrinkles?|aging)\b/.test(text)) pushConcern('fine-line support');
  if (/\b(hydrat|plump|dehydrat)\b/.test(text)) pushConcern('hydration support');
  return concerns.slice(0, 3);
}

function hasStructuredCommunitySignals(product) {
  const community =
    asPlainObject(product.community_signals) ||
    asPlainObject(product.communitySignals) ||
    asPlainObject(product.social_signals) ||
    asPlainObject(product.socialSignals);
  if (!community) return false;
  const positives = normalizeStringList(
    community.top_loves ||
      community.topLoveThemes ||
      community.top_pos_themes ||
      community.topPosThemes ||
      community.typical_positive ||
      community.typicalPositive,
  );
  const negatives = normalizeStringList(
    community.top_complaints ||
      community.topComplaintThemes ||
      community.top_neg_themes ||
      community.topNegThemes ||
      community.typical_negative ||
      community.typicalNegative,
  );
  return positives.length > 0 || negatives.length > 0;
}

function readReviewCount(product) {
  const summary =
    asPlainObject(product.review_summary) ||
    asPlainObject(product.reviewSummary) ||
    asPlainObject(product.reviews_summary) ||
    asPlainObject(product.reviews?.summary);
  const raw =
    summary?.review_count ??
    summary?.reviewCount ??
    summary?.count ??
    summary?.total ??
    product.review_count ??
    product.reviewCount;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function readReviewSummary(product) {
  return normalizeReviewSummary(
    product.review_summary ||
      product.reviewSummary ||
      product.reviews_summary ||
      product.reviewsSummary ||
      product.reviews?.summary ||
      {
        rating: product.rating,
        review_count: product.review_count ?? product.reviewCount,
      },
  );
}

function formatInsightReviewCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function buildVerifiedBuyerReviewStat(reviewSummary) {
  const review = normalizeReviewSummary(reviewSummary);
  const rating = Number(review?.rating || 0);
  const reviewCount = Number(review?.review_count || 0);
  if (!Number.isFinite(rating) || !Number.isFinite(reviewCount)) return '';
  if (rating < 4.5 || reviewCount < 100) return '';
  return `${rating.toFixed(1)}★ average across ${formatInsightReviewCount(reviewCount)} buyer reviews.`;
}

function buildSourceCoverage(product) {
  const rawIngredients = readRawIngredients(product);
  const keyIngredients = readKeyIngredients(product);
  const reviewCount = readReviewCount(product);
  const community =
    asPlainObject(product.community_signals) ||
    asPlainObject(product.communitySignals) ||
    asPlainObject(product.social_signals) ||
    asPlainObject(product.socialSignals);
  const sourceCounts = asPlainObject(community?.source_counts || community?.sourceCounts) || {};
  const creatorCount = Number(sourceCounts.creator || sourceCounts.creator_mentions || sourceCounts.creatorMentions || 0) || 0;
  const editorialCount = Number(sourceCounts.editorial || 0) || 0;

  return {
    seller: {
      available: Boolean(
        firstNonEmptyString(product.title, product.name) ||
          stripHtml(product.description) ||
          readCategory(product),
      ),
    },
    formula: {
      available: rawIngredients.length > 0 || keyIngredients.length > 0,
    },
    reviews: {
      available: reviewCount > 0,
      count: reviewCount,
    },
    creator: {
      available: creatorCount > 0,
      count: creatorCount,
    },
    editorial: {
      available: editorialCount > 0,
      count: editorialCount,
    },
  };
}

function inferEvidenceProfile(sourceCoverage, product) {
  const explicit = asString(product.evidence_profile || product.evidenceProfile).toLowerCase();
  const reviewsCount = Number(sourceCoverage?.reviews?.count || 0);
  const creatorCount = Number(sourceCoverage?.creator?.count || 0);
  const editorialCount = Number(sourceCoverage?.editorial?.count || 0);
  const communitySignals = hasStructuredCommunitySignals(product);

  if (
    explicit === 'mixed' ||
    explicit === 'community_supported'
  ) {
    return explicit;
  }
  if (explicit === 'seller_only' || explicit === 'seller_plus_formula') {
    if (communitySignals || reviewsCount >= 10 || creatorCount >= 5 || editorialCount >= 3) {
      return 'community_supported';
    }
    if (reviewsCount > 0 || creatorCount > 0 || editorialCount > 0) {
      return 'mixed';
    }
    return explicit;
  }

  if (communitySignals || reviewsCount >= 10 || creatorCount >= 5 || editorialCount >= 3) {
    return 'community_supported';
  }
  if (reviewsCount > 0 || creatorCount > 0 || editorialCount > 0) {
    return 'mixed';
  }
  if (sourceCoverage?.formula?.available) {
    return 'seller_plus_formula';
  }
  return 'seller_only';
}

function inferQualityState(product, evidenceProfile) {
  const explicit = asString(product.quality_state || product.qualityState).toLowerCase();
  if (explicit === 'eligible' || explicit === 'limited' || explicit === 'blocked') return explicit;
  if (product.blocked === true || product.exclude_from_recall === true) return 'blocked';
  if (!firstNonEmptyString(product.title, product.name)) return 'blocked';
  if (evidenceProfile === 'seller_only' || evidenceProfile === 'mixed') return 'limited';
  return 'eligible';
}

function inferRoutineStep(product) {
  const explicit = firstNonEmptyString(
    product.routine_step,
    product.routineStep,
    product.step,
    product.product_role,
    product.productRole,
  ).toLowerCase();
  if (explicit) return explicit.replace(/\s+/g, '_');

  const text = buildCombinedText(product);
  if (/(spf|sunscreen|sun screen|sun protection)/.test(text)) return 'sunscreen';
  if (/(cleanser|cleansing|face wash|wash off)/.test(text)) return 'cleanser';
  if (/(serum|essence|ampoule)/.test(text)) return 'serum';
  if (/(moisturizer|moisturiser|cream|lotion)/.test(text)) return 'moisturizer';
  if (/(mask|sleeping mask)/.test(text)) return 'mask';
  if (/(toner|mist)/.test(text)) return 'toner';
  if (/(primer|foundation|concealer|blush|bronzer|highlighter|eyeliner|lip)/.test(text)) {
    return 'makeup';
  }
  if (/(perfume|fragrance|eau de parfum|eau de toilette)/.test(text)) return 'fragrance';
  return 'product';
}

function inferProductRoleLabel(step) {
  const map = {
    sunscreen: 'Daily sunscreen',
    cleanser: 'Cleansing product',
    serum: 'Treatment serum',
    moisturizer: 'Daily moisturizer',
    mask: 'Treatment mask',
    toner: 'Prep or toner step',
    makeup: 'Makeup product',
    fragrance: 'Fragrance product',
    product: 'Product',
  };
  return map[step] || 'Product';
}

function inferBestFor(product) {
  const assessmentBestFor = readAssessmentStrings(product, 'best_for', 'bestFor');
  const explicit = (assessmentBestFor.length ? assessmentBestFor : asArray(product.best_for || product.bestFor)).map((item) =>
    typeof item === 'string'
      ? { tag: item.toLowerCase().replace(/\s+/g, '_'), label: item, confidence: 'moderate' }
      : item,
  );
  if (explicit.length) return explicit.slice(0, 4);

  const text = buildCombinedText(product);
  const bestFor = [];
  const pushBestFor = (tag, label, confidence = 'moderate') => {
    if (bestFor.some((item) => item.tag === tag)) return;
    bestFor.push({ tag, label, confidence });
  };

  if (/(dry|dehydrated|barrier)/.test(text)) pushBestFor('dryness', 'Dry or dehydrated skin', 'moderate');
  if (/(oily|shine|sebum|matte)/.test(text)) pushBestFor('oil_control', 'Oily or combination skin', 'moderate');
  if (/(sensitive|gentle|soothing|fragrance[-\s]?free)/.test(text)) {
    pushBestFor('sensitive_skin', 'Sensitive skin', 'moderate');
  }
  if (/(acne|blemish|spot|breakout)/.test(text)) pushBestFor('breakouts', 'Breakout-prone skin', 'moderate');
  if (/(brighten|dark spot|hyperpigment|tone)/.test(text)) pushBestFor('uneven_tone', 'Uneven tone concerns', 'moderate');
  if (/(spf|sunscreen|uv)/.test(text)) pushBestFor('daytime_use', 'Daytime wear', 'high');

  if (!bestFor.length) {
    const category = readCategory(product);
    if (category) {
      pushBestFor(
        category.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        `${category} shoppers`,
        'low',
      );
    }
  }
  return bestFor.slice(0, 4);
}

function inferWhyItStandsOut(product, evidenceProfile) {
  const assessmentReasons = readAssessmentStrings(product, 'reasons', 'formula_intent', 'formulaIntent');
  const explicit = assessmentReasons.length
    ? assessmentReasons
    : normalizeStringList(
        product.why_it_stands_out ||
          product.whyItStandsOut ||
          product.highlights ||
          product.highlight_bullets ||
          product.highlightBullets ||
          product.selling_points ||
          product.sellingPoints,
      );

  const out = [];
  const sellerOnly = evidenceProfile === 'seller_only' || evidenceProfile === 'seller_plus_formula';
  const step = inferRoutineStep(product);
  const pushHighlight = (headline, body, evidenceStrength = 'seller_grounded') => {
    if (!headline || !body) return;
    const normalizedHeadline = asString(headline);
    const normalizedBody = toSentence(stripSellerMerchandisingLead(body), body);
    if (!normalizedBody) return;
    if (sellerOnly && shouldSuppressSellerHighlightText(`${normalizedHeadline} ${normalizedBody}`)) return;
    if (out.some((item) => item.headline.toLowerCase() === String(headline).toLowerCase())) return;
    out.push({
      headline: normalizedHeadline,
      body: normalizedBody,
      evidence_strength: evidenceStrength,
    });
  };

  explicit.slice(0, evidenceProfile === 'seller_only' ? 2 : 4).forEach((text, index) => {
    pushHighlight(index === 0 ? 'Key highlight' : `Highlight ${index + 1}`, text, 'seller_grounded');
  });

  const keyIngredients = readKeyIngredients(product);
  if (keyIngredients.length) {
    pushHighlight(
      'Formula focus',
      `Built around ${joinWithCommasAnd(keyIngredients.slice(0, 3))} as key formula ingredients.`,
      'formula_supported',
    );
  }

  const namedActives = keyIngredients.length ? [] : inferNamedActivesFromText(product);
  if (namedActives.length >= 3) {
    pushHighlight(
      'Multi-active formula',
      `Brings together ${namedActives.slice(0, 4).join(', ')} in one treatment step.`,
      'seller_grounded',
    );
  }
  const concernCoverage = inferConcernCoverageFromText(product);
  if (concernCoverage.length >= 2) {
    pushHighlight(
      'Multi-concern coverage',
      describeConcernCoverage(concernCoverage, step),
      'seller_grounded',
    );
  }

  const desc = stripHtml(product.description);
  if (desc && out.length < (evidenceProfile === 'seller_only' ? 2 : 4)) {
    const descSentence = firstMeaningfulHighlightSentence(desc, { sellerOnly });
    if (descSentence) pushHighlight('Formula angle', descSentence, 'seller_grounded');
  }

  return out.slice(0, evidenceProfile === 'seller_only' ? 2 : 4);
}

function inferRoutineFit(product, step) {
  const assessment = readAssessment(product);
  const explicit =
    asPlainObject(assessment?.how_to_use || assessment?.howToUse) ||
    asPlainObject(product.routine_fit || product.routineFit) ||
    {};
  const amPm = uniqueStrings(
    asArray(explicit.am_pm || explicit.amPm || explicit.timing || explicit.when).map((item) =>
      asString(item).toLowerCase(),
    ),
  );
  const pairingNotes = normalizeStringList(explicit.pairing_notes || explicit.pairingNotes);
  const orderInRoutine = firstNonEmptyString(explicit.order_in_routine, explicit.orderInRoutine);

  if (step === 'sunscreen') {
    return {
      step,
      am_pm: amPm.length ? amPm : ['am'],
      pairing_notes: pairingNotes.length
        ? pairingNotes
        : [orderInRoutine || 'Use as the last skincare step before makeup in the daytime.'],
    };
  }
  if (step === 'cleanser') {
    return {
      step,
      am_pm: amPm.length ? amPm : ['am', 'pm'],
      pairing_notes: pairingNotes.length
        ? pairingNotes
        : [orderInRoutine || 'Use before treatment serums and moisturizers.'],
    };
  }
  if (step === 'moisturizer') {
    return {
      step,
      am_pm: amPm.length ? amPm : ['am', 'pm'],
      pairing_notes: pairingNotes.length
        ? pairingNotes
        : [orderInRoutine || 'Layer after watery treatments and before SPF in the daytime.'],
    };
  }
  if (step === 'serum') {
    return {
      step,
      am_pm: amPm.length ? amPm : ['am', 'pm'],
      pairing_notes: pairingNotes.length
        ? pairingNotes
        : [orderInRoutine || 'Apply before moisturizer; follow with SPF if used in the morning.'],
    };
  }
  return {
    step,
    am_pm: amPm,
    pairing_notes: pairingNotes,
  };
}

function inferWatchouts(product, { sellerOnly = false } = {}) {
  const assessmentNotFor = readAssessmentStrings(product, 'not_for', 'notFor', 'if_not_ideal', 'ifNotIdeal');
  const science = asPlainObject(product.evidence?.science) || null;
  const explicit = (assessmentNotFor.length ? assessmentNotFor : asArray(product.watchouts || product.watchout || product.risk_notes || product.riskNotes)).map((item) => {
    if (typeof item === 'string') {
      return { type: 'notice', label: item, severity: 'medium' };
    }
    return item;
  });
  if (explicit.length) {
    return explicit.slice(0, sellerOnly ? 2 : 4).map((item) => ({
      type: asString(item.type) || 'notice',
      label: firstNonEmptyString(item.label, item.text, item.note),
      severity: asString(item.severity) || 'medium',
    }));
  }

  const text = buildCombinedText(product);
  const watchouts = [];
  const pushWatchout = (type, label, severity = 'medium') => {
    if (watchouts.some((item) => item.type === type || item.label === label)) return;
    watchouts.push({ type, label, severity });
  };

  if (/(fragrance|parfum)/.test(text)) pushWatchout('fragrance', 'Contains fragrance or fragrance-like positioning.', 'medium');
  if (/(retinol|retinal|retinoid)/.test(text)) pushWatchout('retinoid', 'Start slowly if your skin is sensitive to retinoids.', 'high');
  if (/(aha|bha|pha|salicylic|glycolic|lactic acid|exfoliat)/.test(text)) {
    pushWatchout('acid', 'May be too active for very sensitive or over-exfoliated skin.', 'high');
  }
  if (/(spf|sunscreen|sun protection)/.test(text)) {
    pushWatchout('spf', 'Reapplication still matters for daytime UV protection.', 'medium');
  }
  normalizeStringList(science?.risk_notes || science?.riskNotes).forEach((note) =>
    pushWatchout('science_note', note, 'medium'),
  );

  return watchouts.slice(0, sellerOnly ? 2 : 4);
}

function inferTextureFinish(product, evidenceProfile) {
  const explicit = asPlainObject(product.texture_finish || product.textureFinish) || {};
  const text = buildCombinedText(product);

  const texture =
    firstNonEmptyString(explicit.texture, product.texture) ||
    (/(gel cream|gel-cream)/.test(text)
      ? 'gel-cream'
      : /(gel)/.test(text)
        ? 'gel'
        : /(balm)/.test(text)
          ? 'balm'
          : /(oil)/.test(text)
            ? 'oil'
            : /(cream)/.test(text)
              ? 'cream'
              : /(lotion)/.test(text)
                ? 'lotion'
                : '');

  const finish =
    firstNonEmptyString(explicit.finish, product.finish) ||
    (/(matte)/.test(text)
      ? 'matte'
      : /(dewy|glow)/.test(text)
        ? 'dewy'
        : /(natural)/.test(text)
          ? 'natural'
          : '');

  const sensoryNotes = uniqueStrings([
    ...normalizeStringList(explicit.sensory_notes || explicit.sensoryNotes),
    ...(evidenceProfile === 'seller_only' ? [] : /(lightweight)/.test(text) ? ['Lightweight feel'] : []),
    ...(evidenceProfile === 'seller_only' ? [] : /(rich|cushion)/.test(text) ? ['Richer feel'] : []),
    ...(evidenceProfile === 'seller_only' ? [] : /(fragrance[-\s]?free)/.test(text) ? ['Fragrance-free positioning'] : []),
  ]);

  const layeringNotes = uniqueStrings([
    ...normalizeStringList(explicit.layering_notes || explicit.layeringNotes),
    ...(inferRoutineStep(product) === 'sunscreen'
      ? ['Best used as the last skincare step before makeup.']
      : inferRoutineStep(product) === 'moisturizer'
        ? ['Usually layers after serums and before daytime SPF.']
        : []),
  ]);

  if (!texture && !finish && sensoryNotes.length === 0 && layeringNotes.length === 0) return null;
  return {
    texture,
    finish,
    sensory_notes: sensoryNotes,
    layering_notes: layeringNotes,
    confidence: clampConfidence(evidenceProfile === 'seller_only' ? 'moderate' : 'moderate', {
      sellerOnly: evidenceProfile === 'seller_only',
    }),
    evidence_profile: evidenceProfile,
  };
}

function normalizeCommunitySignals(product, evidenceProfile) {
  const community =
    asPlainObject(product.community_signals) ||
    asPlainObject(product.communitySignals) ||
    asPlainObject(product.social_signals) ||
    asPlainObject(product.socialSignals);
  const reviewSummary = readReviewSummary(product);
  const verifiedReviewStat = buildVerifiedBuyerReviewStat(reviewSummary);
  const reviewCount = readReviewCount(product);

  if (evidenceProfile === 'seller_only' || evidenceProfile === 'seller_plus_formula') {
    return {
      status: 'unavailable',
      unavailable_reason: 'insufficient_feedback',
      confidence: 'low',
      evidence_profile: evidenceProfile,
    };
  }

  const topLoves = normalizeStringList(
    community?.top_loves ||
      community?.topLoveThemes ||
      community?.top_pos_themes ||
      community?.topPosThemes ||
      community?.typical_positive ||
      community?.typicalPositive,
  );
  const reviewStats = uniqueStrings([
    ...normalizeStringList(community?.review_stats || community?.reviewStats),
    verifiedReviewStat,
  ]);
  const mergedTopLoves = uniqueStrings([...reviewStats, ...topLoves]);
  const topComplaints = normalizeStringList(
    community?.top_complaints ||
      community?.topComplaintThemes ||
      community?.top_neg_themes ||
      community?.topNegThemes ||
      community?.typical_negative ||
      community?.typicalNegative,
  );
  const bestFitUsers = normalizeStringList(
    community?.best_fit_users ||
      community?.bestFitUsers ||
      community?.risk_for_groups ||
      community?.riskForGroups,
  );
  const mixedFeedback = normalizeStringList(community?.mixed_feedback || community?.mixedFeedback || community?.watchouts);
  const sourceCounts = asPlainObject(community?.source_counts || community?.sourceCounts) || {};
  const normalizedSourceCounts = {
    reviews: Number(sourceCounts.reviews || reviewCount || 0) || 0,
    creator_mentions:
      Number(sourceCounts.creator_mentions || sourceCounts.creatorMentions || sourceCounts.creator || 0) || 0,
    editorial: Number(sourceCounts.editorial || 0) || 0,
  };

  const availableSignals =
    mergedTopLoves.length + topComplaints.length + bestFitUsers.length + mixedFeedback.length;
  const totalEvidence =
    normalizedSourceCounts.reviews +
    normalizedSourceCounts.creator_mentions +
    normalizedSourceCounts.editorial;

  if (availableSignals === 0 || totalEvidence < 5) {
    return {
      status: 'unavailable',
      unavailable_reason: 'insufficient_feedback',
      confidence: 'low',
      evidence_profile: evidenceProfile,
    };
  }

  const sourceMix = [];
  if (normalizedSourceCounts.reviews > 0) sourceMix.push('reviews');
  if (normalizedSourceCounts.creator_mentions > 0) sourceMix.push('creator');
  if (normalizedSourceCounts.editorial > 0) sourceMix.push('editorial');

  return {
    status: 'available',
    top_loves: mergedTopLoves.slice(0, 4),
    ...(reviewStats.length ? { review_stats: reviewStats.slice(0, 2) } : {}),
    top_complaints: topComplaints.slice(0, 4),
    best_fit_users: bestFitUsers.slice(0, 3),
    mixed_feedback: mixedFeedback.slice(0, 3),
    source_counts: normalizedSourceCounts,
    source_mix: sourceMix,
    last_refreshed_at:
      normalizeTimestamp(
        community?.last_refreshed_at ||
          community?.lastRefreshedAt ||
          product.updated_at ||
          product.updatedAt,
      ) || new Date().toISOString(),
    confidence: clampConfidence(
      confidenceFromScore(totalEvidence >= 20 ? 0.76 : 0.55),
      { sellerOnly: false },
    ),
    evidence_profile: evidenceProfile,
  };
}

function buildFreshness(product) {
  return {
    generated_at:
      normalizeTimestamp(product.product_intel_generated_at || product.productIntelGeneratedAt) ||
      normalizeTimestamp(product.updated_at || product.updatedAt) ||
      new Date().toISOString(),
    source_version: PRODUCT_INTEL_CONTRACT_VERSION,
  };
}

function buildProductIntelCore(product, { evidenceProfile, qualityState, sourceCoverage } = {}) {
  const finalEvidenceProfile = evidenceProfile || inferEvidenceProfile(buildSourceCoverage(product), product);
  const finalQualityState = qualityState || inferQualityState(product, finalEvidenceProfile);
  const finalSourceCoverage = sourceCoverage || buildSourceCoverage(product);
  const sellerOnly = finalEvidenceProfile === 'seller_only';
  const step = inferRoutineStep(product);
  const roleLabel = inferProductRoleLabel(step);
  const description = stripHtml(product.description);

  const whatItIsBody =
    firstNonEmptyString(
      product.assessment?.summary,
      product.assessment?.quick_summary,
      product.assessment?.quickSummary,
      product.what_it_is?.body,
      product.what_it_is_body,
      product.whatItIs?.body,
      product.summary,
      product.short_description,
      product.shortDescription,
      description,
    ) || `${roleLabel} presented through merchant product data.`;

  const core = {
    display_name: PIVOTA_INSIGHTS_DISPLAY_NAME,
    what_it_is: {
      headline:
        firstNonEmptyString(
          product.what_it_is?.headline,
          product.what_it_is_headline,
          product.whatItIs?.headline,
        ) || roleLabel,
      body: compactWhatItIsBody(whatItIsBody, {
        sellerOnly,
        fallback: `${roleLabel}.`,
      }),
    },
    best_for: inferBestFor(product),
    why_it_stands_out: inferWhyItStandsOut(product, finalEvidenceProfile),
    routine_fit: inferRoutineFit(product, step),
    watchouts: inferWatchouts(product, { sellerOnly }),
    confidence: {
      overall: clampConfidence(
        confidenceFromScore(
          finalEvidenceProfile === 'community_supported'
            ? 0.82
            : finalEvidenceProfile === 'mixed'
              ? 0.55
              : finalEvidenceProfile === 'seller_plus_formula'
                ? 0.62
                : 0.5,
          { sellerOnly },
        ),
        { sellerOnly },
      ),
      fields: {
        what_it_is: 'high',
        best_for: clampConfidence(finalEvidenceProfile === 'community_supported' ? 'high' : 'moderate', {
          sellerOnly,
        }),
        why_it_stands_out: clampConfidence(
          finalEvidenceProfile === 'community_supported' ? 'high' : 'moderate',
          { sellerOnly },
        ),
        routine_fit: clampConfidence('moderate', { sellerOnly }),
        watchouts: clampConfidence('moderate', { sellerOnly }),
      },
    },
    freshness: buildFreshness(product),
    quality_state: finalQualityState,
    evidence_profile: finalEvidenceProfile,
    source_coverage: finalSourceCoverage,
  };

  if (sellerOnly && core.why_it_stands_out.length > 2) {
    core.why_it_stands_out = core.why_it_stands_out.slice(0, 2);
  }
  return core;
}

function buildRecommendationIntents(relatedProducts, { defaultLimit = 6 } = {}) {
  const items = asArray(relatedProducts)
    .map((item) => {
      const row = asPlainObject(item);
      if (!row) return null;
      const productId = firstNonEmptyString(row.product_id, row.id);
      if (!productId) return null;
      return {
        product_id: productId,
        merchant_id: firstNonEmptyString(row.merchant_id, row.merchant?.id, row.merchant_uuid) || undefined,
        title: firstNonEmptyString(row.title, row.name) || undefined,
        reason: firstNonEmptyString(row.reason, row.recommendation_reason) || undefined,
        confidence: clampConfidence(
          confidenceFromScore(typeof row.x_score === 'number' ? row.x_score : 0.55),
        ),
      };
    })
    .filter(Boolean)
    .slice(0, defaultLimit);

  return {
    similar: items,
    complementary: [],
    routine_pairing: [],
    underfill_reason: items.length > 0 && items.length < defaultLimit ? 'insufficient_candidates' : null,
    confidence: items.length >= defaultLimit ? 'moderate' : items.length > 0 ? 'low' : 'low',
  };
}

function resolveIntelProductSource(sourceProduct, { requirePublishedIntel = true } = {}) {
  const publishedIntel = readPublishedIntelSource(sourceProduct);
  if (publishedIntel) {
    return {
      normalizedProduct: {
        ...sourceProduct,
        ...(publishedIntel.assessment ? { assessment: publishedIntel.assessment } : {}),
        ...(publishedIntel.evidence ? { evidence: publishedIntel.evidence } : {}),
        ...(publishedIntel.social_signals ? { social_signals: publishedIntel.social_signals } : {}),
        ...(publishedIntel.provenance ? { provenance: publishedIntel.provenance } : {}),
      },
      provenance: publishedIntel.provenance || null,
    };
  }

  if (requirePublishedIntel) return null;

  return {
    normalizedProduct: { ...sourceProduct },
    provenance: asPlainObject(sourceProduct.provenance) || null,
  };
}

function buildProductIntelBundleInternal({
  product,
  relatedProducts = [],
  offersData = null,
  canonicalProductRef = null,
  productGroupId = null,
  requirePublishedIntel = true,
  requireReviewedBundle = false,
  applyRolloutGate = true,
} = {}) {
  const sourceProduct = product || {};
  if (requireReviewedBundle) {
    if (applyRolloutGate && !isRolloutAllowed(sourceProduct, canonicalProductRef)) return null;
    return readPublishedProductIntelBundle(sourceProduct, {
      relatedProducts,
      offersData,
      canonicalProductRef,
      productGroupId,
      provenance: asPlainObject(sourceProduct.provenance) || null,
      requireReviewed: true,
    });
  }

  const resolvedSource = resolveIntelProductSource(sourceProduct, { requirePublishedIntel });
  if (!resolvedSource) return null;
  if (applyRolloutGate && !isRolloutAllowed(sourceProduct, canonicalProductRef)) return null;

  const { normalizedProduct, provenance } = resolvedSource;
  const directBundle = readPublishedProductIntelBundle(normalizedProduct, {
    relatedProducts,
    offersData,
    canonicalProductRef,
    productGroupId,
    provenance,
  });
  if (directBundle) return directBundle;

  const sourceCoverage = buildSourceCoverage(normalizedProduct);
  const evidenceProfile = inferEvidenceProfile(sourceCoverage, normalizedProduct);
  const qualityState = inferQualityState(normalizedProduct, evidenceProfile);
  const core = buildProductIntelCore(normalizedProduct, {
    evidenceProfile,
    qualityState,
    sourceCoverage,
  });
  const textureFinish = inferTextureFinish(normalizedProduct, evidenceProfile);
  const communitySignals = normalizeCommunitySignals(normalizedProduct, evidenceProfile);
  const recommendationIntents = buildRecommendationIntents(relatedProducts);
  const offers = Array.isArray(offersData?.offers) ? offersData.offers : [];
  const commerceModes = uniqueStrings(offers.map((offer) => asString(offer?.commerce_mode)));
  const reviewSummary = normalizeReviewSummary(normalizedProduct.review_summary);
  const bundle = {
    contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
    display_name: PIVOTA_INSIGHTS_DISPLAY_NAME,
    canonical_product_ref: canonicalProductRef || null,
    product_group_id: productGroupId || null,
    product_intel_core: core,
    texture_finish: textureFinish,
    community_signals: communitySignals,
    recommendation_intents: recommendationIntents,
    ...(reviewSummary ? { review_summary: reviewSummary } : {}),
    market_signal_badges: filterDisplayableMarketSignalBadges(normalizedProduct.market_signal_badges, {
      review_summary: reviewSummary,
      community_signals: communitySignals,
    }),
    external_highlight_signals: normalizeExternalHighlightSignals(
      normalizedProduct.external_highlight_signals || normalizedProduct.externalHighlightSignals,
    ),
    quality_state: qualityState,
    evidence_profile: evidenceProfile,
    source_coverage: sourceCoverage,
    confidence: core.confidence,
    freshness: core.freshness,
    offer_pointers: {
      offers_count: offers.length,
      default_offer_id: offersData?.default_offer_id || null,
      best_price_offer_id: offersData?.best_price_offer_id || null,
      commerce_modes: commerceModes,
    },
    provenance,
  };

  const shoppingCard = buildShoppingCardPayload({ product: normalizedProduct, bundle });
  const searchCard = buildSearchCardPayload({ product: normalizedProduct, bundle });
  return {
    ...bundle,
    ...(Array.isArray(shoppingCard.market_signal_badges) && shoppingCard.market_signal_badges.length
      ? { market_signal_badges: shoppingCard.market_signal_badges }
      : {}),
    shopping_card: shoppingCard,
    search_card: searchCard,
  };
}

function buildProductIntelBundle(args = {}) {
  return buildProductIntelBundleInternal({
    ...args,
    requirePublishedIntel: true,
    requireReviewedBundle: args.requireReviewedBundle === true,
    applyRolloutGate: true,
  });
}

function buildProductIntelDraftBundle(args = {}) {
  return buildProductIntelBundleInternal({
    ...args,
    requirePublishedIntel: false,
    applyRolloutGate: false,
  });
}

function inferStructuredDataMode(offersData) {
  const offers = Array.isArray(offersData?.offers) ? offersData.offers : [];
  if (offers.some((offer) => asString(offer?.commerce_mode) === 'merchant_embedded_checkout')) {
    return 'merchant_listing';
  }
  return 'product_snippet';
}

function buildNormalizedPdpMetadata({ productIntel, offersData } = {}) {
  const qualityState = asString(productIntel?.quality_state).toLowerCase() || 'limited';
  const structuredDataMode = inferStructuredDataMode(offersData);
  const isBlocked = qualityState === 'blocked';
  return {
    surface: 'pivota_normalized_pdp',
    display_name: PIVOTA_INSIGHTS_DISPLAY_NAME,
    insights_available: Boolean(productIntel),
    self_canonical: !isBlocked,
    indexability: isBlocked ? 'noindex' : 'index',
    structured_data_mode: structuredDataMode,
    page_positioning:
      structuredDataMode === 'merchant_listing'
        ? 'merchant_embedded_checkout_product_page'
        : 'editorial_normalized_product_page',
    quality_state: qualityState,
    evidence_profile: productIntel?.evidence_profile || null,
    truth_layers: {
      commerce_truth: 'merchant_store_platform',
      entity_truth: 'pivota_normalized_product_layer',
      experience_truth: 'pivota_pdp_chat_agent',
    },
  };
}

function buildProductFeedbackResponse({ productIntel, canonicalProductRef, productGroupId } = {}) {
  return {
    status: 'success',
    contract_version: PRODUCT_FEEDBACK_CONTRACT_VERSION,
    canonical_product_ref: canonicalProductRef || productIntel?.canonical_product_ref || null,
    product_group_id: productGroupId || productIntel?.product_group_id || null,
    community_signals: productIntel?.community_signals || {
      status: 'unavailable',
      unavailable_reason: 'insufficient_feedback',
      confidence: 'low',
      evidence_profile: productIntel?.evidence_profile || 'seller_only',
    },
    evidence_profile: productIntel?.evidence_profile || 'seller_only',
    source_coverage: productIntel?.source_coverage || null,
    freshness: productIntel?.freshness || null,
  };
}

function buildProductRecommendationIntentsResponse({ productIntel, canonicalProductRef, productGroupId } = {}) {
  return {
    status: 'success',
    contract_version: PRODUCT_RECOMMENDATION_INTENTS_CONTRACT_VERSION,
    canonical_product_ref: canonicalProductRef || productIntel?.canonical_product_ref || null,
    product_group_id: productGroupId || productIntel?.product_group_id || null,
    recommendation_intents: productIntel?.recommendation_intents || {
      similar: [],
      complementary: [],
      routine_pairing: [],
      underfill_reason: 'insufficient_candidates',
      confidence: 'low',
    },
    offer_pointers: productIntel?.offer_pointers || null,
    evidence_profile: productIntel?.evidence_profile || 'seller_only',
    freshness: productIntel?.freshness || null,
  };
}

module.exports = {
  PRODUCT_INTEL_CONTRACT_VERSION,
  PRODUCT_FEEDBACK_CONTRACT_VERSION,
  PRODUCT_RECOMMENDATION_INTENTS_CONTRACT_VERSION,
  PIVOTA_INSIGHTS_DISPLAY_NAME,
  buildProductIntelCore,
  buildRecommendationIntents,
  buildProductIntelBundle,
  buildProductIntelDraftBundle,
  hydrateProductWithPublishedIntel,
  buildNormalizedPdpMetadata,
  buildProductFeedbackResponse,
  buildProductRecommendationIntentsResponse,
  isHumanReviewedProductIntelBundle,
  normalizePublishedProductIntelBundle,
  readPublishedProductIntelBundle,
};
