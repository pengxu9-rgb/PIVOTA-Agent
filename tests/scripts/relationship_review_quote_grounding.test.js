const {
  validateRecommendationDecision, consumerCopyForKind, recommendationFields, isRememberedNegative, REVIEW_VALIDATOR_VERSION,
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

test('what a shopper sees is the cleaned quote, never JSON and never a generic-only quote', () => {
  const fields = recommendationFields(approve([
    { anchor_fact: 'category": "cream', candidate_fact: 'category": "cream' },
    { anchor_fact: 'tags": [ "lip comfort", "shine finish" ]', candidate_fact: '"title": "Soothing Toner"' },
  ]));
  expect(fields.reasons_user_visible).toEqual(['lip comfort … shine finish / Soothing Toner']);
  for (const reason of fields.reasons_user_visible) expect(reason).not.toMatch(/[":[\]]/);
});

test('the validator version moves, so memos written under v2 are reviewed again', () => {
  expect(REVIEW_VALIDATOR_VERSION).toBe('relgraph_review_validator.v3');
  const memo = (validator_version) => ({ provenance: { ai_review_last: { verdict: 'reject', pair_fingerprint: 'fp', validator_version, rubric: 'v4',
    reviewed_at: '2026-10-19T10:00:00.000Z', model: null } } });
  const nowMs = Date.parse('2026-10-20T10:00:00.000Z');
  expect(isRememberedNegative(memo('relgraph_review_validator.v2'), 'fp', { nowMs })).toBe(false);
  expect(isRememberedNegative(memo(REVIEW_VALIDATOR_VERSION), 'fp', { nowMs })).toBe(true);
});
