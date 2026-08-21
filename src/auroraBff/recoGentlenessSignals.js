'use strict';

// GENTLENESS-AWARE RANKING, inside the conforming pool.
//
// Live 2026-08-21 (PRICE_MAX=40) the shortlist was 3/3 conforming and semantically weak:
//   #1 The Ordinary Salicylic Acid 2%  $5.16  (right)
//   #2 NUXE Radiance Face SCRUB        $29
//   #3 TIRTIR Matcha Bubble Tea SCRUB  $20
// ...for "a gentle exfoliant for SENSITIVE skin", while the catalog held conforming chemical options
// (AXIS-Y PHA Resurfacing Glow Peel $6, COSRX AHA/BHA $23, Naturium BHA 2% $19). Price and recall were
// already solved; this is ordering WITHIN the conforming pool.
//
// WHY THIS LIVES IN ITS OWN MODULE, AND NOT IN computeCandidateContextSignals.
//
// That function already has sensitivity-aware scoring (+0.18 for gentle/fragrance-free/soothing text)
// -- but it reads `recoContext.task_hard_context.sensitivity`, which comes from the PROFILE, and the
// agent lane passes `profile: null`. The obvious "fix" is to derive sensitivity from the need text and
// feed it in. THAT WOULD MAKE THIS DEFECT WORSE. The same function sets `constraint_conflict = true`
// (score forced to 0) when sensitivity === 'high' or the barrier is impaired/reactive AND the product
// matches /\b(retinol|retinoid|aha|bha|acid|peel|exfoliat|benzoyl)\b/. Deriving high sensitivity from
// "gentle ... for sensitive skin" would HARD-ZERO every chemical exfoliant and fill the shortlist with
// scrubs -- the exact failure, amplified.
//
// So: the signals here are RANKING-ONLY. They never reach constraint_conflict, never filter, never
// zero a score. Profile-derived clinical constraints keep working exactly as they do today -- a user
// whose PROFILE says high sensitivity or an impaired barrier is still steered off strong actives.

const RECO_GENTLENESS_SIGNALS_VERSION = 'reco_gentleness_signals_v1';

// --- need-text vocabularies (word-anchored EN, substring CN -- recoTargetStep.js is the precedent) --

// "I want something that will not sting." Ranking preference, never a clinical claim.
const NEED_GENTLENESS_PATTERNS = Object.freeze([
  /\b(gentle|gentlest|gently|mild|milder|non[- ]?irritating|non[- ]?abrasive|non[- ]?stripping)\b/i,
  /\b(sensitive skin|for sensitive|sensitive[- ]skinned|easily irritated|reactive skin)\b/i,
  /\b(soothing|calming|fragrance[- ]?free|unscented)\b/i,
  /温和/, /敏感肌/, /敏感肌肤/, /舒缓/, /无香/, /低刺激/,
]);

const NEED_FRAGRANCE_FREE_PATTERNS = Object.freeze([
  /\b(fragrance[- ]?free|unscented|no fragrance|without fragrance|parfum[- ]?free)\b/i,
  /无香/, /无香精/, /不含香精/,
]);

// The buyer explicitly asked for a scrub. This SUPPRESSES the demotion entirely: someone who wants a
// face scrub must still be shown face scrubs, even if they also said "gentle".
const NEED_SCRUB_REQUEST_PATTERNS = Object.freeze([
  /\b(scrub|scrubs|scrubbing|polish|gommage|microbead|micro[- ]?beads?|granular)\b/i,
  /\b(physical exfoliant|physical exfoliation|manual exfoliant)\b/i,
  /磨砂/,
]);

// --- candidate abrasion vocabularies ---

// Physical/abrasive. Checked FIRST: an "Enzyme Scrub" is still something you rub on your face.
const CANDIDATE_PHYSICAL_PATTERNS = Object.freeze([
  /\b(scrub|scrubs|gommage|microbead|micro[- ]?beads?|granular|buffing|exfoliating beads)\b/i,
  /\b(sugar scrub|salt scrub|apricot scrub|walnut|crushed shell|pumice)\b/i,
  // "polish" but NOT "polishing" (word-anchored) and not nail polish.
  /\bpolish\b/i,
  /磨砂/,
]);

// Chemical / enzymatic.
const CANDIDATE_CHEMICAL_PATTERNS = Object.freeze([
  /\b(pha|lha|bha|aha)\b/i,
  /\b(salicylic|glycolic|lactic acid|mandelic|malic acid|tartaric acid|azelaic|gluconolactone)\b/i,
  /\b(poly[- ]?hydroxy|beta[- ]?hydroxy|alpha[- ]?hydroxy)\b/i,
  /\b(enzyme|enzymatic|papain|bromelain)\b/i,
  /\b(chemical exfoliant|chemical exfoliation)\b/i,
  /果酸/, /水杨酸/, /杏仁酸/, /乳酸/, /酵素/, /壬二酸/, /化学去角质/,
]);

// A chemical exfoliant at 10% or above is not what "gentle" asks for. Deliberately percentage-based
// and NOT keyed on the word "peel": the catalog's own gentle PHA option is literally named
// "AXIS-Y PHA Resurfacing Glow Peel", so a "peel" rule would demote the very product this exists to
// promote. "The Ordinary Salicylic Acid 2%" and "Naturium BHA 2%" stay gentle; "AHA 30% + BHA 2%
// Peeling Solution" does not.
const CANDIDATE_STRONG_PERCENT_THRESHOLD = 10;
const CANDIDATE_STRONG_PATTERNS = Object.freeze([/\b(tca|jessner|trichloroacetic)\b/i]);

const CANDIDATE_TEXT_FIELDS = Object.freeze([
  'name', 'title', 'display_name', 'displayName',
  'brand', 'brand_name', 'brandName',
  'category', 'category_name', 'categoryName',
  'product_type', 'productType', 'type',
  'description', 'short_description', 'subtitle', 'why_match',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function matchesAny(patterns, text) {
  if (!text) return false;
  for (const pattern of patterns) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function buildRecoGentlenessCandidateText(candidate) {
  if (!isPlainObject(candidate)) return '';
  const parts = [];
  for (const field of CANDIDATE_TEXT_FIELDS) {
    const value = candidate[field];
    if (typeof value === 'string' && value.trim()) parts.push(value.trim());
  }
  if (isPlainObject(candidate.sku)) {
    for (const field of CANDIDATE_TEXT_FIELDS) {
      const value = candidate.sku[field];
      if (typeof value === 'string' && value.trim()) parts.push(value.trim());
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

/**
 * Ranking-only intent flags derived from the buyer's own words.
 *
 * NEVER an input to constraint_conflict, a hard filter, or a score floor. See the module header.
 */
function deriveRecoNeedIntentSignals({ text = '', focus = '' } = {}) {
  const combined = [String(focus || ''), String(text || '')]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 600);
  if (!combined) {
    return {
      gentleness_preferred: false,
      fragrance_free_preferred: false,
      scrub_requested: false,
      version: RECO_GENTLENESS_SIGNALS_VERSION,
    };
  }
  return {
    gentleness_preferred: matchesAny(NEED_GENTLENESS_PATTERNS, combined),
    fragrance_free_preferred: matchesAny(NEED_FRAGRANCE_FREE_PATTERNS, combined),
    scrub_requested: matchesAny(NEED_SCRUB_REQUEST_PATTERNS, combined),
    version: RECO_GENTLENESS_SIGNALS_VERSION,
  };
}

function hasStrongChemicalConcentration(text) {
  if (matchesAny(CANDIDATE_STRONG_PATTERNS, text)) return true;
  const matches = String(text || '').match(/(\d{1,3}(?:\.\d+)?)\s*%/g) || [];
  for (const raw of matches) {
    const value = Number(String(raw).replace('%', '').trim());
    if (Number.isFinite(value) && value >= CANDIDATE_STRONG_PERCENT_THRESHOLD) return true;
  }
  return false;
}

/**
 * 'physical' | 'chemical_gentle' | 'chemical_strong' | 'unknown'.
 *
 * UNKNOWN IS NEUTRAL: a candidate whose text says nothing about how it exfoliates gets no bonus and
 * no penalty. Most of the catalog is unknown, so a penalty here would be a silent global re-rank.
 */
function classifyRecoCandidateAbrasion(candidate) {
  const text = buildRecoGentlenessCandidateText(candidate);
  if (!text) return 'unknown';
  // Physical first: an "Enzyme Scrub" is abrasive whatever else it contains.
  if (matchesAny(CANDIDATE_PHYSICAL_PATTERNS, text)) return 'physical';
  if (!matchesAny(CANDIDATE_CHEMICAL_PATTERNS, text)) return 'unknown';
  return hasStrongChemicalConcentration(text) ? 'chemical_strong' : 'chemical_gentle';
}

// 0 = preferred, 1 = neutral, 2 = demoted. Everything is neutral unless the buyer asked for gentle,
// and a buyer who asked for a scrub gets a flat ranking -- no promotion, no demotion.
function resolveRecoGentlenessRankTier(candidate, signals) {
  if (!isPlainObject(signals)) return 1;
  if (signals.gentleness_preferred !== true) return 1;
  if (signals.scrub_requested === true) return 1;
  const abrasion = classifyRecoCandidateAbrasion(candidate);
  if (abrasion === 'chemical_gentle') return 0;
  if (abrasion === 'physical') return 2;
  return 1;
}

/**
 * Stable three-tier partition: chemical/enzymatic > everything else > physical scrubs.
 *
 * A partition, not a score nudge. A nudge's effect depends on the relevance gaps it is competing
 * with, which are not knowable from here -- so it cannot be tested to actually achieve the outcome.
 * This can. It only ever reorders WITHIN the viable pool (one family bucket), so it cannot promote a
 * candidate across a step/family boundary, and it never drops anything.
 */
function applyRecoGentlenessPreference(rows, signals, { getCandidate = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!isPlainObject(signals) || signals.gentleness_preferred !== true) return list.slice();
  if (signals.scrub_requested === true) return list.slice();
  if (list.length < 2) return list.slice();
  const pick = typeof getCandidate === 'function' ? getCandidate : (row) => row;
  const tiers = [[], [], []];
  for (const row of list) {
    tiers[resolveRecoGentlenessRankTier(pick(row), signals)].push(row);
  }
  return [...tiers[0], ...tiers[1], ...tiers[2]];
}

module.exports = {
  RECO_GENTLENESS_SIGNALS_VERSION,
  CANDIDATE_STRONG_PERCENT_THRESHOLD,
  buildRecoGentlenessCandidateText,
  deriveRecoNeedIntentSignals,
  classifyRecoCandidateAbrasion,
  resolveRecoGentlenessRankTier,
  applyRecoGentlenessPreference,
};
