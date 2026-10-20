// What a relationship quote must be before it can stand as evidence or reach a shopper (2026-10-20).
// The reviewer's validator (scripts/review-relationship-candidate-labels.js) grounds each quote in the
// product's facts and stores only specific ones; the edge reader (productRelationshipGraph.js
// coerceRelationshipEdge) applies the display half to rows written before that, so every serving path
// (similar items, PDP rails, agent signals) reads the same filtered why_candidate.

// Words that prove nothing about a pair: category words and base ingredients nearly every product has.
const GENERIC_QUOTE_SPAN = /^(?:beauty|skincare|makeup|cosmetics|face|body|skin|cream|serum|water|aqua|glycerin|fragrance|parfum|alcohol)$/;

function normalizeQuoteText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?)\]])/g, '$1').replace(/([.,;:!?])(?=[a-z])/g, '$1 ').trim();
}

// Two words with one that is not generic ("dry skin"), or one non-generic word of four or more
// letters; the brand never counts.
function quotePartIsSpecific(part, brandValue = '') {
  let rest = ` ${normalizeQuoteText(part)} `;
  const brand = normalizeQuoteText(brandValue);
  if (brand) rest = rest.split(` ${brand} `).join(' ');
  const words = rest.split(/[^a-z0-9%]+/).filter((word) => word && !(brand && word === brand));
  const meaningful = words.filter((word) => !GENERIC_QUOTE_SPAN.test(word));
  if (words.length >= 2) return meaningful.length >= 1 && meaningful.join('').replace(/[^a-z0-9]/g, '').length >= 2;
  return meaningful.length === 1 && meaningful[0].replace(/[^a-z0-9]/g, '').length >= 4;
}

// Shown only when it is one specific fact: never stitched (an ellipsis), never JSON-shaped.
function isShowableQuote(text, brand = '') {
  const value = typeof text === 'string' ? text : '';
  if (!value.trim() || /\.\.\.|…|":|[[\]{}]/.test(value)) return false;
  return quotePartIsSpecific(value, brand);
}

// why_candidate with unshowable shared_evidence pairs removed, and the "anchor / candidate" reasons
// built from them. Other reasons (the builder's own copy) are left alone.
function sanitizeWhyCandidateQuotes(why, { anchorBrand = '', candidateBrand = '' } = {}) {
  if (!why || typeof why !== 'object' || Array.isArray(why) || !Array.isArray(why.shared_evidence)) return why;
  const kept = [];
  const dropped = new Set();
  for (const item of why.shared_evidence) {
    const anchor = item && item.anchor_fact; const candidate = item && item.candidate_fact;
    if (isShowableQuote(anchor, anchorBrand) && isShowableQuote(candidate, candidateBrand)) kept.push(item);
    else dropped.add(`${anchor} / ${candidate}`);
  }
  if (!dropped.size) return why;
  const out = { ...why, shared_evidence: kept };
  if (Array.isArray(why.reasons_user_visible)) out.reasons_user_visible = why.reasons_user_visible.filter((reason) => !dropped.has(reason));
  return out;
}

module.exports = { GENERIC_QUOTE_SPAN, normalizeQuoteText, quotePartIsSpecific, isShowableQuote, sanitizeWhyCandidateQuotes };
