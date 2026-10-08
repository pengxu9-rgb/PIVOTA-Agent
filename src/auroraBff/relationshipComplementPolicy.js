'use strict';

// One meaning for related_product: a COMPLEMENT, i.e. a different routine step or area used
// alongside the anchor. The builder decides which relation a same-brand pair may claim with this
// policy, and the reviewer refuses a related_product approval with the same policy, so a pair the
// builder proposes as a complement is judged by the rule that proposed it.
//
//   same_job    -> the pair replaces one shopper job: competitive_alternative, never related_product
//   complement  -> both routine roles are known and different: related_product
//   unresolved  -> a role is unknown: no relation can be claimed from roles alone
//
// Identity (same product / variant) is decided before this policy, by relationshipProductIdentity.

const { optionRole } = require('./relationshipPairPolicy');

const SAME_JOB_REASON = 'same_step_substitutes_are_not_complements';
const UNRESOLVED_REASON = 'complement_role_evidence_unresolved';

function snapshotText(snapshot = {}) {
  const raw = snapshot.title || snapshot.name || snapshot.display_name || snapshot.product_name || '';
  // Marks go before NFKC, which would turn "Brushampoo™" into "brushampootm".
  return String(typeof raw === 'string' ? raw : '').replace(/[\u2122\u00ae\u00a9]/g, ' ').normalize('NFKC').toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
}

// Generic skincare forms: a sun cream or SPF serum is a sun-protection step, not a moisturizer step.
const FORM_ROLES = new Set(['cream', 'serum', 'essence', 'emulsion', 'ampoule', 'toner']);

// Routine roles the option-role vocabulary does not name. Sun protection is a routine step of its
// own whatever its form ("Sun Cream", "Sun Stick"); a named cosmetic (BB cream, lip balm) with SPF
// keeps its cosmetic role.
// Text-named jobs that precede the option-role vocabulary, whose category fallback calls a fragranced
// body product 'perfume' and whose tool rule calls a brush shampoo a 'brush'.
const LEADING_ROLES = [
  ['tool_cleaner', /\bbrushampoo\b|\bbrush\s*(?:shampoo|cleanser|cleaner|cleaning|soap)\b|\bcleaning\s*(?:mat|glove|pad)\b/],
  // A "micellar shampoo" is a shampoo; hair-wash nouns precede first-cleanse words.
  ['shampoo', /^(?!.*\bconditioners?\b).*\bshampoos?\b/],
  ['conditioner', /^(?!.*\bshampoos?\b).*\bconditioners?\b/],
  ['first_cleanser', /\b(?:makeup|make-up)\s*remover\b|\bmicellar\b|\bcleansing\s*(?:oil|balm|milk|water)\b|\b(?:oil|balm)\s*cleanser\b/],
  ['remover', /\bremover\b/],
  ['deodorant', /\b(?:deodorant|antiperspirant)s?\b/],
  ['body_wash', /\b(?:hand|body)\s*wash\b|\bshower\s*(?:gel|oil|cream)\b|\bbath\s*oil\b/],
  ['body_moisturizer', /\b(?:body|hand|foot)\s*(?:lotion|cream|butter|balm|souffle|milk)\b/],
  // Oils for different areas are different jobs.
  ['face_oil', /\b(?:face|facial)\s*oil\b/],
  ['hair_oil', /\b(?:hair|scalp)\s*oil\b/],
  ['body_oil', /\b(?:body|dry)\s*oil\b/],
];

function routineRole(snapshot = {}) {
  const value = snapshotText(snapshot);
  const leading = LEADING_ROLES.find(([, pattern]) => pattern.test(value));
  if (leading) return leading[0];
  if (/\bbrush[\s_-]*clean/.test(String(snapshot.category || snapshot.product_type || '').toLowerCase())) return 'tool_cleaner';
  const role = optionRole(snapshot);
  if (role && !FORM_ROLES.has(role) && role !== 'cleanser') return role;
  if (/\b(?:sunscreen|sun\s*(?:cream|milk|stick|serum|lotion|gel|essence|block)|sunblock)\b/.test(value) || /\bspf\s*\d+/.test(value)) {
    return 'sunscreen';
  }
  // A "Cream Mask" or "Serum Mask" is a mask step; the form word names its texture.
  if (/\b(?:sheet\s*)?masks?\b/.test(value)) return 'mask';
  if (role) return role;
  if (/\blip\s*colou?rs?\b/.test(value)) return 'lipstick';
  if (/\bnail\s*(?:polish|lacquer|colou?r)\b/.test(value)) return 'nail_polish';
  if (/\bpatch(?:es)?\b/.test(value)) return /\beye\b/.test(value) ? 'eye_patch' : 'patch';
  if (/\b(?:body|hair|face)?\s*oil\b/.test(value) && !/\bcleansing\b/.test(value)) return 'oil';
  if (/\bmist\b/.test(value)) return 'mist';
  if (/\b(?:scrub|exfoliant|exfoliator)\b|\bpeel(?:ing)?\b(?![ -]?off)/.test(value)) return 'exfoliant';
  return '';
}

function classifyComplementPair(anchor = {}, candidate = {}, { substitutable = false } = {}) {
  const anchorRole = routineRole(anchor);
  const candidateRole = routineRole(candidate);
  const base = { anchor_role: anchorRole, candidate_role: candidateRole };
  if (substitutable || (anchorRole && anchorRole === candidateRole)) {
    return { ...base, kind: 'same_job', reason: SAME_JOB_REASON, suggested_relation_type: 'competitive_alternative' };
  }
  if (!anchorRole || !candidateRole) return { ...base, kind: 'unresolved', reason: UNRESOLVED_REASON };
  return { ...base, kind: 'complement', reason: '' };
}

module.exports = {
  SAME_JOB_REASON,
  UNRESOLVED_REASON,
  routineRole,
  classifyComplementPair,
};
