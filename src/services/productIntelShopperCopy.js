// Review criteria belong in operator evidence, never in product narratives.
// Omit contaminated copy rather than turning a review observation into a claim.
const INTERNAL_EVALUATION_COPY = [
  /\breviewed (?:pdp|sku|lip|color|scent|nail(?:-polish|-care)?|set|mist|complexion|primer|skincare|shimmer|spf|tool|oral-care) (?:cues|fields)\b/i,
  /\breviewed (?:usage context|key-ingredient fields|directions)\b/i,
  /\b(?:reviewed and normalized by pivota|pivota-reviewed|source-backed cues around)\b/i,
  /\b(?:cues|shade and size|configuration|accessory format|sample format|application sequence|shade selection) (?:are|is) (?:specific|explicit|clear|unambiguous|source-backed)\b/i,
  /\bvariant labels such as\b.*\breducing ambiguity\b/i,
  /\b(?:before (?:the shopper|a shopper|leaving).*pivota|before a shopper clicks through)\b/i,
  /\b(?:full inci is present for formula-sensitive review|safer to evaluate than a claim-only listing)\b/i,
  /\b(?:without (?:inventing unsupported|treating (?:it|the parent row)|turning (?:it|regulated language))|rather than (?:category-only|unsupported benefit) copy)\b/i,
  /\b(?:official pdp evidence only|insight is limited to the official product fields|public copy is kept to ingredient-level context|generic (?:color-copy|scent copy|blush\/bronzer\/highlighter card|default variant))\b/i,
];

function isInternalEvaluationCopy(value) {
  if (typeof value !== 'string') return false;
  const text = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return INTERNAL_EVALUATION_COPY.some((pattern) => pattern.test(text));
}

const NARRATIVE_KEYS = new Set([
  'headline', 'body', 'label', 'title', 'subtitle', 'highlight', 'intro',
  'title_candidate', 'compact_candidate', 'highlight_candidate', 'intro_candidate',
  'proof_badge', 'proof_badge_candidate', 'claim_text', 'surface_text',
  'texture', 'finish', 'step',
]);

function cleanNarrative(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => {
      if (typeof item === 'string') return !isInternalEvaluationCopy(item);
      if (!item || typeof item !== 'object') return true;
      return !Object.entries(item).some(([key, text]) => NARRATIVE_KEYS.has(key) && isInternalEvaluationCopy(text));
    }).map(cleanNarrative);
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key, text]) =>
    !NARRATIVE_KEYS.has(key) || !isInternalEvaluationCopy(text)
  ).map(([key, item]) => [key, cleanNarrative(item)]));
}

function sanitizeProductIntelShopperCopy(bundle) {
  if (!bundle || typeof bundle !== 'object') return bundle;
  const next = { ...bundle };
  for (const key of ['product_intel_core', 'shopping_card', 'search_card', 'texture_finish', 'community_signals', 'external_highlight_signals']) {
    if (key in bundle) next[key] = cleanNarrative(bundle[key]);
  }
  if (bundle.agent_context?.facts) {
    next.agent_context = { ...bundle.agent_context, facts: cleanNarrative(bundle.agent_context.facts) };
  }
  return next;
}

module.exports = { isInternalEvaluationCopy, sanitizeProductIntelShopperCopy };
