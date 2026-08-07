'use strict';

/**
 * ADR-020 Phase 1 — relevance judgement for the recall acceptance corpus.
 *
 * WHY THIS EXISTS
 * ---------------
 * The original Phase 1 acceptance corpus (tests/fixtures/adr020_phase1_gap_scope.json
 * @ 2026-07-30) recorded a raw PARITY DIFF: every product the seed lane returned
 * and the catalog lane did not. No relevance judgement was attached, so the diff
 * inherited the seed lane's own mistakes as acceptance targets — "running shoes"
 * expected five tinted moisturizers, "black leather sneakers" expected Ombré
 * Leather Eau de Parfum (a substring hit on "leather"), "vanilla perfume"
 * expected three lip balms. Tuning the ranker to reproduce that corpus would
 * actively degrade results.
 *
 * A gap must mean "a GOOD answer the catalog lane misses", not "anything the
 * seed lane happened to return". This module supplies the missing judgement.
 *
 * HOW IT JUDGES
 * -------------
 * Two axes, deliberately kept apart:
 *
 *   1. FORM (decisive) — what the product actually IS, classified from its
 *      brand + title: cleanser, serum, moisturizer, sunscreen, foundation,
 *      lipstick, mascara, fragrance, body_care, ... A title reliably supports
 *      this judgement, so form drives the grade.
 *
 *   2. ATTRIBUTES (recorded, never decisive) — the query's modifiers:
 *      "long-lasting", "under $30", "for oily skin". A title usually CANNOT
 *      settle these, so they are recorded as matched/unknown for a human
 *      reviewer and never downgrade a product on their own. Judging marketing
 *      copy from a title is how the first corpus went wrong; we do not repeat it
 *      in a different direction.
 *
 * Classification is MULTI-LABEL: a mineral SPF tinted moisturizer is genuinely
 * both `sunscreen` and `foundation`, and scores as whichever form the query
 * rates highest. Compound phrases are consumed before the single-token patterns
 * run, so "tinted moisturizer" reads as foundation and not as `moisturizer`, and
 * "fragrance free" never reads as `fragrance`.
 *
 * GRADES
 * ------
 *   2 RELEVANT   — the product form is a direct answer to the query.
 *   1 PARTIAL    — right product family, wrong sub-form (a lip liner for a
 *                  lipstick query; a barrier serum for a barrier moisturizer
 *                  query). Defensible to return, not the target answer.
 *   0 IRRELEVANT — wrong product form. This is the grade that the 2026-07-30
 *                  corpus handed out acceptance targets to.
 *
 * Every judgement carries the matched forms and the rule that produced it, so
 * the fixture can be audited product-by-product and overridden by an owner.
 */

const GRADE = Object.freeze({ IRRELEVANT: 0, PARTIAL: 1, RELEVANT: 2 });

const GRADE_LABEL = Object.freeze({ 0: 'irrelevant', 1: 'partial', 2: 'relevant' });

/**
 * Compound phrases resolved BEFORE single-token form patterns run.
 * Each entry rewrites the phrase to a marker token so a later, broader pattern
 * cannot re-read it as a different form. Order matters: longest/most specific
 * first.
 */
const PHRASE_RESOLUTIONS = Object.freeze([
  // "fragrance free" / "unscented" are skincare ATTRIBUTES, not a fragrance.
  [/\bfragrance[\s-]*free\b/g, ' attr_fragrancefree '],
  [/\bunscented\b/g, ' attr_fragrancefree '],
  // Complexion products that would otherwise read as skincare.
  [/\btinted\s+moisturi[sz]er\b/g, ' form_foundation '],
  [/\bskin\s+tint\b/g, ' form_foundation '],
  [/\b(bb|cc)\s+cream\b/g, ' form_foundation '],
  [/\bcushion\b/g, ' form_foundation '],
  // Lip products that would otherwise read as lipstick or as skincare balm.
  [/\blip\s+liner\b/g, ' form_lipother '],
  [/\blip\s+balm\b/g, ' form_lipother '],
  [/\blip\s+(tint|gloss|oil|mask)\b/g, ' form_lipother '],
  [/\blip\s+(color|colour|lacquer|crayon|stick)\b/g, ' form_lipstick '],
  // Scent-adjacent formats that are not perfume.
  [/\bfragrance\s+layering\s+balm\b/g, ' form_fragranceadjacent '],
  [/\baromatherapy\b/g, ' form_fragranceadjacent '],
  // Cleansing formats, resolved before the generic oil/balm/gel patterns.
  [/\bcleansing\s+(oil|balm|gel|milk|water|foam|cream|pad)\b/g, ' form_cleanser '],
  [/\bface\s*wash\b/g, ' form_cleanser '],
  [/\bfacial\s+(soap|wash|cleanser)\b/g, ' form_cleanser '],
  [/\bmakeup\s+remover\b/g, ' form_cleanser '],
  // Toner pads read as their own form, not as cleansers.
  [/\b(toner|calming|clarifying|clear\s+skin|blemish\s+pore\s+clear|glow)\s+pad\b/g, ' form_tonerpad '],
  // Surfaces that disqualify a face-care read.
  [/\bhand\s*(&|and)\s*body\b/g, ' surface_body '],
  [/\bbody\s+(wash|lotion|cream|milk|butter|oil|scrub|moisturi[sz]er)\b/g, ' surface_body form_bodycare '],
  [/\bshower\s+gel\b/g, ' surface_body form_bodycare '],
]);

/**
 * Single-token form patterns, applied to the phrase-resolved text.
 * A product may match several — classification is multi-label by design.
 */
const FORM_PATTERNS = Object.freeze([
  ['fragrance', /\b(form_fragrance\b|eau\s+de\s+(parfum|toilette|cologne)|\bparfum\b|\bperfume\b|\bcologne\b|\bedp\b|\bedt\b)/],
  ['fragrance_adjacent', /\bform_fragranceadjacent\b/],
  ['lipstick', /\b(form_lipstick|lipstick)\b/],
  ['lip_other', /\bform_lipother\b/],
  ['mascara', /\b(mascara|lash\s+(primer|serum|conditioner))\b/],
  ['eyeshadow', /\b(eye\s*shadow|eyeshadow|palette|quad|quartet)\b/],
  ['concealer', /\b(concealer|corrector)\b/],
  ['foundation', /\b(form_foundation|foundation)\b/],
  ['sunscreen', /\b(sunscreen|spf\s*\d+|\bspf\b|sun\s+(cream|milk|fluid|stick)|uv\s+(protector|defen[cs]e|shield))\b/],
  ['cleanser', /\b(form_cleanser|cleanser|micellar)\b/],
  ['toner_pad', /\b(form_tonerpad|toner|essence\s+pad)\b/],
  ['serum', /\b(serum|ampoule|essence|booster|concentrate)\b/],
  ['moisturizer', /\b(moisturi[sz]er|moisture\s+(cream|gel)|water\s+gel|gel\s+cream|cream|lotion|emulsion)\b/],
  ['body_care', /\b(form_bodycare|surface_body)\b/],
  ['hair_care', /\b(shampoo|conditioner|curl|scalp|hair|beard|pomade|styling)\b/],
  // Applicators and implements. A "Foundation Brush" matches the `foundation`
  // token but is not a foundation, and a "Moisturizer Applicator" is not a
  // moisturizer — both were graded RELEVANT before this arm existed.
  ['tool', /\b(brush|applicator|sponge|puff|tweezer|gua\s*sha|massager|spatula|mirror|tool|tools)\b/],
]);

/**
 * Forms that describe a surface other than the face. When one of these is
 * present alongside a face-care form, the face-care form is dropped: a
 * "Hand and Body Moisturizer" is not an answer to "barrier moisturizer".
 */
const NON_FACE_FORMS = Object.freeze(['body_care', 'hair_care']);
const FACE_CARE_FORMS = Object.freeze(['cleanser', 'serum', 'moisturizer', 'toner_pad', 'sunscreen']);

function normalizeTitleText(brand, title) {
  return `${String(brand ?? '')} ${String(title ?? '')}`
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}$&]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolvePhrases(text) {
  let out = ` ${text} `;
  for (const [pattern, replacement] of PHRASE_RESOLUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Classify a product into zero or more forms from its brand + title.
 * Returns { forms, resolved_text } — `resolved_text` is retained so a reviewer
 * can see exactly what the classifier read.
 */
function classifyForms(brand, title) {
  const resolved = resolvePhrases(normalizeTitleText(brand, title));
  const forms = [];
  for (const [form, pattern] of FORM_PATTERNS) {
    if (pattern.test(resolved)) forms.push(form);
  }
  // An implement is only ever an implement: a Foundation Brush is not a
  // foundation. Tool wins over every product form it co-occurs with.
  if (forms.includes('tool')) return { forms: ['tool'], resolved_text: resolved };
  // A non-face surface suppresses face-care reads on the same product.
  const hasNonFace = forms.some((f) => NON_FACE_FORMS.includes(f));
  const kept = hasNonFace ? forms.filter((f) => !FACE_CARE_FORMS.includes(f)) : forms;
  return { forms: kept, resolved_text: resolved };
}

/**
 * Per-query grading table.
 *
 * `relevant` / `partial` are FORM sets. `attributes` are the query modifiers a
 * title generally cannot settle; they are recorded, never decisive (see the
 * module header). Chinese queries map to the same form sets as their English
 * equivalents — the catalog is English-titled, so "is this a lipstick" is the
 * same question in either language.
 */
const QUERY_RUBRICS = Object.freeze({
  // ---- skincare ---------------------------------------------------------
  'acne cleanser': { relevant: ['cleanser'], partial: ['toner_pad'], attributes: ['acne'] },
  'gentle cleanser': { relevant: ['cleanser'], partial: ['toner_pad'], attributes: ['gentle'] },
  'salicylic acid serum for acne and pores': {
    relevant: ['serum'],
    partial: ['toner_pad'],
    attributes: ['salicylic acid', 'acne', 'pores'],
  },
  'hyaluronic acid hydrating serum': {
    relevant: ['serum'],
    partial: [],
    attributes: ['hyaluronic acid', 'hydrating'],
  },
  'barrier moisturizer': { relevant: ['moisturizer'], partial: ['serum'], attributes: ['barrier'] },
  'hydrating barrier moisturizer fragrance free': {
    relevant: ['moisturizer'],
    partial: ['serum'],
    attributes: ['hydrating', 'barrier', 'fragrance free'],
  },
  'lightweight gel moisturizer for acne-prone skin': {
    relevant: ['moisturizer'],
    partial: ['serum'],
    attributes: ['lightweight', 'gel', 'acne-prone'],
  },
  moisturizer: { relevant: ['moisturizer'], partial: [], attributes: [] },
  sunscreen: { relevant: ['sunscreen'], partial: [], attributes: [] },
  'spf 50': { relevant: ['sunscreen'], partial: [], attributes: ['spf 50'] },
  精华: { relevant: ['serum'], partial: [], attributes: [] },
  面霜: { relevant: ['moisturizer'], partial: [], attributes: [] },
  防晒霜: { relevant: ['sunscreen'], partial: [], attributes: [] },

  // ---- makeup -----------------------------------------------------------
  lipstick: { relevant: ['lipstick'], partial: ['lip_other'], attributes: [] },
  'matte lipstick under $30': {
    relevant: ['lipstick'],
    partial: ['lip_other'],
    attributes: ['matte', 'under $30'],
  },
  'nude lipstick everyday': {
    relevant: ['lipstick'],
    partial: ['lip_other'],
    attributes: ['nude', 'everyday'],
  },
  'red lipstick long-lasting': {
    relevant: ['lipstick'],
    partial: ['lip_other'],
    attributes: ['red', 'long-lasting'],
  },
  'cushion foundation': { relevant: ['foundation'], partial: [], attributes: ['cushion'] },
  'full coverage foundation oily skin': {
    relevant: ['foundation'],
    partial: [],
    attributes: ['full coverage', 'oily skin'],
  },
  'concealer for dark circles': {
    relevant: ['concealer'],
    partial: ['foundation'],
    attributes: ['dark circles'],
  },
  mascara: { relevant: ['mascara'], partial: [], attributes: [] },
  'waterproof volumizing mascara': {
    relevant: ['mascara'],
    partial: [],
    attributes: ['waterproof', 'volumizing'],
  },
  'neutral eyeshadow palette': {
    relevant: ['eyeshadow'],
    partial: [],
    attributes: ['neutral'],
  },
  推荐口红: { relevant: ['lipstick'], partial: ['lip_other'], attributes: [] },
  口红: { relevant: ['lipstick'], partial: ['lip_other'], attributes: [] },
  平价口红: { relevant: ['lipstick'], partial: ['lip_other'], attributes: ['平价'] },
  适合黄皮的口红: { relevant: ['lipstick'], partial: ['lip_other'], attributes: ['黄皮'] },
  哑光口红: { relevant: ['lipstick'], partial: ['lip_other'], attributes: ['哑光'] },
  气垫粉底: { relevant: ['foundation'], partial: [], attributes: ['气垫'] },
  控油遮瑕粉底液: { relevant: ['foundation'], partial: ['concealer'], attributes: ['控油', '遮瑕'] },
  睫毛膏: { relevant: ['mascara'], partial: [], attributes: [] },
  防水睫毛膏: { relevant: ['mascara'], partial: [], attributes: ['防水'] },

  // ---- fragrance --------------------------------------------------------
  'unisex fragrance for daily wear': {
    relevant: ['fragrance'],
    partial: ['fragrance_adjacent'],
    attributes: ['unisex', 'daily wear'],
  },
  'vanilla perfume': {
    relevant: ['fragrance'],
    partial: ['fragrance_adjacent'],
    attributes: ['vanilla'],
  },
  'woody fragrance under $80': {
    relevant: ['fragrance'],
    partial: ['fragrance_adjacent'],
    attributes: ['woody', 'under $80'],
  },
  木质香水: { relevant: ['fragrance'], partial: ['fragrance_adjacent'], attributes: ['木质'] },
  小众淡香水: { relevant: ['fragrance'], partial: ['fragrance_adjacent'], attributes: ['小众'] },
});

/**
 * Judge one product against one query.
 * Returns null when the query has no rubric (an unjudged query must not be
 * silently graded 0 — the caller surfaces it instead).
 */
function judgeProduct(query, product) {
  const rubric = QUERY_RUBRICS[String(query ?? '').trim()];
  if (!rubric) return null;

  const { forms, resolved_text: resolvedText } = classifyForms(product?.brand, product?.title);
  const hitRelevant = forms.filter((f) => rubric.relevant.includes(f));
  const hitPartial = forms.filter((f) => rubric.partial.includes(f));

  let grade = GRADE.IRRELEVANT;
  let reason = 'no rubric form matched the product';
  if (hitRelevant.length) {
    grade = GRADE.RELEVANT;
    reason = `product form ${hitRelevant.join('/')} directly answers the query`;
  } else if (hitPartial.length) {
    grade = GRADE.PARTIAL;
    reason = `product form ${hitPartial.join('/')} is adjacent to the query's target form`;
  }

  return {
    grade,
    grade_label: GRADE_LABEL[grade],
    forms,
    matched_forms: hitRelevant.length ? hitRelevant : hitPartial,
    // Recorded for review only — never decisive (see module header).
    unverified_attributes: rubric.attributes,
    reason,
    resolved_text: resolvedText,
  };
}

function hasRubric(query) {
  return Object.prototype.hasOwnProperty.call(QUERY_RUBRICS, String(query ?? '').trim());
}

module.exports = {
  GRADE,
  GRADE_LABEL,
  PHRASE_RESOLUTIONS,
  FORM_PATTERNS,
  QUERY_RUBRICS,
  normalizeTitleText,
  resolvePhrases,
  classifyForms,
  judgeProduct,
  hasRubric,
};
