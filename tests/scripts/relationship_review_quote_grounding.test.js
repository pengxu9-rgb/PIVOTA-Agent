const {
  validateRecommendationDecision, consumerCopyForKind, recommendationFields, isRememberedNegative, REVIEW_VALIDATOR_VERSION, buildNegativeReviewMemo,
} = require('../../scripts/review-relationship-candidate-labels');

// 2026-10-20: on a prod dry run of uncovered anchors, 36 of 37 approvals the validator overturned as
// recommendation_facts_not_supplied quoted real facts in the shape the model was shown them (JSON),
// joined by an ellipsis, or with different spacing around punctuation. These shapes are copied from
// that run. A quote must still name a fact the product's own data carries.
const product = (brand, title, other = {}) => ({ product_id: `${brand}-${title}`, brand, title, name: title, price: 30, price_currency: 'USD', ...other });
const TONER_A = product('FINDIVE', 'Calming Toner', { category: 'toner', ingredient_text: 'Water, Niacinamide, Allantoin, Panthenol' });
const TONER_B = product('DERMAFIRM', 'Soothing Toner', { category: 'toner', ingredient_text: 'Water, Glycerin, Niacinamide, Allantoin' });
const row = (a, b) => ({ id: 'q', anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: 'product:b', anchor_snapshot: a,
  candidate_snapshot: b, relation_type: 'competitive_alternative', label_state: 'generated', score_total: 0.9,
  score_breakdown: { category_use_case_match: 0.9 }, source_refs: [{ type: 'catalog_products' }] });
const approve = (shared_evidence) => ({ verdict: 'approve', confidence: 0.9, rationale: 'Shared job and actives from the supplied facts.',
  relationship_kind: 'alternative', ...consumerCopyForKind('alternative'), shared_evidence });
const verdict = (a, b, quotes) => {
  const out = validateRecommendationDecision(row(a, b), approve(quotes));
  return out.verdict === 'approve' ? 'approve' : out.utility_rejection;
};

test('a quote copied with its JSON key grounds on the value it quotes', () => {
  expect(verdict(TONER_A, TONER_B, [
    { anchor_fact: 'category": "toner', candidate_fact: 'category": "toner' },
    { anchor_fact: 'niacinamide', candidate_fact: 'Niacinamide' },
  ])).toBe('approve');
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: '"title": "Calming Toner"', candidate_fact: '"title": "Soothing Toner"' }])).toBe('approve');
});

test('a JSON array fragment grounds item by item, and every item must be there', () => {
  const a = { ...TONER_A, tags: ['lip comfort', 'shine finish'] }; const b = { ...TONER_B, tags: ['lip comfort', 'shine finish', 'vegan'] };
  expect(verdict(a, b, [{ anchor_fact: 'tags": [ "lip comfort", "shine finish" ]', candidate_fact: 'lip comfort", "shine finish' }])).toBe('approve');
  expect(verdict(a, b, [{ anchor_fact: 'tags": [ "lip comfort", "long wear" ]', candidate_fact: 'lip comfort", "shine finish' }]))
    .toBe('recommendation_facts_not_supplied');
});

test('an ellipsis joins spans that must each be the product\'s own text', () => {
  const b = { ...TONER_B, description: 'Smudge-proof. Lasts through sweat, humidity, and tears. Removes easily with warm water.' };
  expect(verdict(TONER_A, b, [{ anchor_fact: 'Calming Toner', candidate_fact: 'Smudge-proof. Lasts through sweat ... removes easily with warm water.' }])).toBe('approve');
  expect(verdict(TONER_A, b, [{ anchor_fact: 'Calming Toner', candidate_fact: 'Smudge-proof … thanks to thermal technology.' }]))
    .toBe('recommendation_facts_not_supplied');
});

test('ellipsis parts must come from one fact, never a title stitched to a description', () => {
  const b = { ...TONER_B, title: 'Daily Renewing Toner', name: 'Daily Renewing Toner',
    description: 'Soothes and hydrates. Balances the skin after cleansing.' };
  // Each part is real, but no single fact says both.
  expect(verdict(TONER_A, b, [{ anchor_fact: 'Calming Toner', candidate_fact: 'Daily Renewing Toner ... Soothes and hydrates' }]))
    .toBe('recommendation_facts_not_supplied');
  expect(verdict(TONER_A, b, [{ anchor_fact: 'Calming Toner', candidate_fact: 'Soothes and hydrates … Balances the skin after cleansing.' }])).toBe('approve');
  // Array items are separate facts, so they may come from different items of a list.
  const a = { ...TONER_A, tags: ['alcohol free', 'fragrance free'] };
  expect(verdict(a, TONER_B, [{ anchor_fact: 'alcohol free", "fragrance free', candidate_fact: 'Soothing Toner' }])).toBe('approve');
});

test('spacing around punctuation does not decide grounding', () => {
  const a = { ...TONER_A, description: 'keeps curls smooth, hydrated, and naturally bouncy . ideal for permed hair' };
  expect(verdict(a, TONER_B, [{ anchor_fact: 'keeps curls smooth, hydrated, and naturally bouncy.', candidate_fact: 'Soothing Toner' }])).toBe('approve');
});

test('a generic-word quote neither grounds a pair nor sinks one', () => {
  const a = { ...TONER_A, category: 'cream' }; const b = { ...TONER_B, category: 'cream' };
  expect(verdict(a, b, [{ anchor_fact: 'category": "cream', candidate_fact: 'cream' }, { anchor_fact: 'allantoin', candidate_fact: 'Allantoin' }])).toBe('approve');
  expect(verdict(a, b, [{ anchor_fact: 'category": "cream', candidate_fact: 'cream' }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(a, b, [{ anchor_fact: 'FINDIVE', candidate_fact: 'DERMAFIRM' }])).toBe('recommendation_facts_not_supplied');
});

test('an invented fact is still refused, however it is shaped', () => {
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'clinically proven 48 hour hydration', candidate_fact: 'Soothing Toner' }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'title": "Barrier Repair Cream', candidate_fact: 'Soothing Toner' }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'ingredients": "retinol', candidate_fact: 'Niacinamide' }])).toBe('recommendation_facts_not_supplied');
});

test('what is stored and shown is the grounded facts: no JSON, no stitching, no generic or brand quote', () => {
  const a = { ...TONER_A, category: 'cream', tags: ['alcohol free', 'fragrance free'] }; const b = { ...TONER_B, category: 'cream' };
  const validated = validateRecommendationDecision(row(a, b), approve([
    { anchor_fact: 'category": "cream', candidate_fact: 'category": "cream' },
    { anchor_fact: 'FINDIVE', candidate_fact: 'DERMAFIRM' },
    { anchor_fact: 'tags": [ "alcohol free", "fragrance free" ]', candidate_fact: '"title": "Soothing Toner"' },
  ]));
  expect(validated.verdict).toBe('approve');
  expect(validated.shared_evidence).toEqual([
    { anchor_fact: 'alcohol free', candidate_fact: 'Soothing Toner' },
    { anchor_fact: 'fragrance free', candidate_fact: 'Soothing Toner' },
  ]);
  expect(recommendationFields(validated).reasons_user_visible).toEqual(['alcohol free / Soothing Toner', 'fragrance free / Soothing Toner']);
  // Defence in depth when called with raw quotes: nothing stitched, JSON-shaped or generic-only is shown.
  expect(recommendationFields(approve([
    { anchor_fact: 'non … comedogenic', candidate_fact: 'Non-comedogenic' },
    { anchor_fact: 'category": "toner', candidate_fact: 'toner' },
    { anchor_fact: 'cream', candidate_fact: 'cream' },
  ])).reasons_user_visible).toEqual([]);
});

test('an elided quote is one passage of one fact: in order, short gaps, nothing negated skipped', () => {
  const a = { ...TONER_A, description: 'Suitable for all skin types except sensitive skin. May be comedogenic for some users. Non-sticky texture.' };
  const b = { ...TONER_B, description: 'Suitable for sensitive skin. Non-comedogenic.' };
  const cand = 'Suitable for sensitive skin';
  // skipping "all skin types except" is refused, and so is a one-word part
  expect(verdict(a, b, [{ anchor_fact: 'Suitable for ... sensitive skin', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(a, b, [{ anchor_fact: 'non … comedogenic', candidate_fact: 'Non-comedogenic' }])).toBe('recommendation_facts_not_supplied');
  // out of order is refused; in order without a negation is kept, as the fact's own text
  const c = { ...TONER_A, description: 'Gently calms redness. Lightweight watery texture absorbs fast.' };
  expect(verdict(c, b, [{ anchor_fact: 'watery texture absorbs fast … Gently calms redness', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
  const ok = validateRecommendationDecision(row(c, b), approve([{ anchor_fact: 'Gently calms redness ... watery texture absorbs fast', candidate_fact: cand }]));
  expect(ok.verdict).toBe('approve');
  expect(ok.shared_evidence[0].anchor_fact).toBe('gently calms redness. lightweight watery texture absorbs fast');
});

test('words never merge: whole words only, whitespace normalised around punctuation alone', () => {
  const a = { ...TONER_A, description: 'Volume and form enhancing. A piano fragrance accord.' };
  const b = { ...TONER_B, description: 'Toner for men. No fragrance.' };
  expect(verdict(a, b, [{ anchor_fact: 'for men', candidate_fact: 'for men' }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(a, b, [{ anchor_fact: 'no fragrance', candidate_fact: 'No fragrance' }])).toBe('recommendation_facts_not_supplied');
});

test('a key keeps its subject: it must name a fact field, and the fact must be in that field', () => {
  const a = { ...TONER_A, description: 'Salicylic acid 1% exfoliating toner.', product_intel: { product_intel_core: { best_for: ['dry skin'], watchouts: ['not for oily skin'] } } };
  const b = { ...TONER_B, description: 'Retinol 1% night toner.', product_intel: { product_intel_core: { best_for: ['oily skin'] } } };
  expect(verdict(a, b, [{ anchor_fact: 'best_for": "oily skin', candidate_fact: 'best_for": "oily skin' }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(a, b, [{ anchor_fact: 'best_for": ["dry skin", "oily skin"]', candidate_fact: 'oily skin' }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(a, b, [{ anchor_fact: 'best_for": "dry skin', candidate_fact: 'best_for": "oily skin' }])).toBe('approve');
  expect(verdict(a, b, [{ anchor_fact: 'Retinol: 1%', candidate_fact: 'Retinol 1%' }])).toBe('recommendation_facts_not_supplied');
  // a known key with nothing after it fails; it is not silently dropped
  expect(verdict(a, b, [{ anchor_fact: 'niacinamide', candidate_fact: 'niacinamide' }, { anchor_fact: 'description": "', candidate_fact: 'Niacinamide' }]))
    .toBe('recommendation_facts_not_supplied');
});

test('specific means a real fact: not metadata, base ingredients, the brand, or a few letters', () => {
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'USD', candidate_fact: 'USD' }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'water', candidate_fact: 'Water' }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'n … a … t', candidate_fact: 'n … a … t' }])).toBe('recommendation_facts_not_supplied');
  const a = product('AAA', 'AAA Cream Toner', { category: 'toner' }); const b = product('BBB', 'BBB Cream Toner', { category: 'toner' });
  expect(verdict(a, b, [{ anchor_fact: 'AAA Cream', candidate_fact: 'BBB Cream' }])).toBe('recommendation_facts_not_supplied');
});

test('both sides must hold, and a quote counts as specific only when both sides are', () => {
  // one side invented sinks the pair, even next to a good quote
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'niacinamide', candidate_fact: 'niacinamide' },
    { anchor_fact: 'allantoin', candidate_fact: 'clinically proven' }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'clinically proven', candidate_fact: 'allantoin' },
    { anchor_fact: 'niacinamide', candidate_fact: 'niacinamide' }])).toBe('recommendation_facts_not_supplied');
  // specific on one side, generic-only on the other, is not a specific quote
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'allantoin', candidate_fact: 'water' }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'water', candidate_fact: 'allantoin' }])).toBe('recommendation_facts_not_supplied');
});

test('the version moves, and releases only the v2 memos the grounding change could reverse', () => {
  expect(REVIEW_VALIDATOR_VERSION).toBe('relgraph_review_validator.v3');
  const memo = (validator_version, rationale_code) => ({ provenance: { ai_review_last: { verdict: 'reject', rationale_code,
    pair_fingerprint: 'fp', validator_version, rubric: 'v4', reviewed_at: '2026-10-19T10:00:00.000Z', model: null } } });
  const nowMs = Date.parse('2026-10-20T10:00:00.000Z');
  const remembered = (m) => isRememberedNegative(m, 'fp', { nowMs });
  expect(remembered(memo('relgraph_review_validator.v2', 'recommendation_facts_not_supplied'))).toBe(false);
  expect(remembered(memo('relgraph_review_validator.v2', 'model_reject_none'))).toBe(true);
  expect(remembered(memo('relgraph_review_validator.v2', 'structural_or_dupe_evidence_mismatch'))).toBe(true);
  expect(remembered(memo('relgraph_review_validator.v2', undefined))).toBe(false);
  expect(remembered(memo('relgraph_review_validator.v1', 'model_reject_none'))).toBe(false);
  expect(remembered(memo(REVIEW_VALIDATOR_VERSION, 'recommendation_facts_not_supplied'))).toBe(true);
});

test('the released code is exactly what a validator overturn records', () => {
  const overturned = validateRecommendationDecision(row(TONER_A, TONER_B), approve([{ anchor_fact: 'clinically proven', candidate_fact: 'Soothing Toner' }]));
  const memo = buildNegativeReviewMemo(overturned, { fingerprint: 'fp', reviewedAt: '2026-10-19T10:00:00.000Z' });
  expect(memo.rationale_code).toBe('recommendation_facts_not_supplied');
  const v2 = { provenance: { ai_review_last: { ...memo, validator_version: 'relgraph_review_validator.v2' } } };
  expect(isRememberedNegative(v2, 'fp', { nowMs: Date.parse('2026-10-20T10:00:00.000Z') })).toBe(false);
});
