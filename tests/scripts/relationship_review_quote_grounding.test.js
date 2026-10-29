const {
  validateRecommendationDecision, consumerCopyForKind, recommendationFields, isRememberedNegative, REVIEW_VALIDATOR_VERSION, buildNegativeReviewMemo,
  applyApproval, __quoteGrounding,
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
  expect(ok.shared_evidence[0].anchor_fact).toBe('Gently calms redness. Lightweight watery texture absorbs fast');
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

describe('controller review round 3 (2026-10-20)', () => {
  const cand = 'Suitable for sensitive skin';
  const b = { ...TONER_B, description: 'Suitable for sensitive skin. Non-comedogenic.' };

  test('a skipped stretch may not negate or contrast, whatever apostrophe it uses', () => {
    const curly = { ...TONER_A, description: 'Suitable for normal skin. Isn’t recommended for sensitive skin.' };
    expect(verdict(curly, b, [{ anchor_fact: 'Suitable for … sensitive skin', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
    const unlike = { ...TONER_A, description: 'A watery toner, unlike gels made for oily skin.' };
    expect(verdict(unlike, b, [{ anchor_fact: 'A watery toner … for oily skin', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
    for (const word of ['although', 'though', 'whereas', 'excluding', 'other than', 'rather than', "won't", "can't"]) {
      const a = { ...TONER_A, description: `Calming toner layers well ${word} heavy creams soothe redness fast.` };
      expect(verdict(a, b, [{ anchor_fact: 'Calming toner layers well … soothe redness fast', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
    }
  });

  test('"oil-free" and "but" in a skipped stretch do not refuse a true elision', () => {
    const a = { ...TONER_A, description: 'Lightweight gel texture, oil-free, absorbs quickly into the skin.' };
    expect(verdict(a, b, [{ anchor_fact: 'Lightweight gel texture … absorbs quickly', candidate_fact: cand }])).toBe('approve');
    const rich = { ...TONER_A, description: 'Rich but non-greasy hydration for very dry skin.' };
    // "non" in the gap is a negation of "greasy", so it is still refused; "but" alone is not.
    expect(verdict(rich, b, [{ anchor_fact: 'Rich … hydration for very dry skin', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
    // A contrast or caveat in the skipped stretch refuses, even where it would have been harmless:
    // "but too heavy for oily skin" is the case that matters (controller round 4).
    for (const gap of ['but too heavy and', 'yet unsuitable and', 'while it can clog pores and', 'too rich and', 'but problematic and',
      'but a lightweight feel and']) {
      const a = { ...TONER_A, description: `Deeply hydrating texture, ${gap} lasts all day on skin.` };
      expect(verdict(a, b, [{ anchor_fact: 'Deeply hydrating texture … lasts all day', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
    }
    // "fragrance free" as a phrase in the gap is a negation too (N31)
    const ff = { ...TONER_A, description: 'Calming toner formula, fragrance free, soothes redness fast.' };
    expect(verdict(ff, b, [{ anchor_fact: 'Calming toner formula … soothes redness fast', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
  });

  test('a passage that cannot be shown is not evidence, so an approval never stores nothing', () => {
    const a = { ...TONER_A, description: 'Calming toner … soothes redness [clinically] in one week.' };
    expect(verdict(a, b, [{ anchor_fact: 'Calming toner … in one week', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
  });

  test('stopwords and category nouns are not facts', () => {
    const a = { ...TONER_A, description: 'A toner with a calming finish of the day.' }; const c = { ...TONER_B, description: 'A toner with a soft finish of the night.' };
    for (const q of ['of the', 'with a', 'with', 'toner']) expect(verdict(a, c, [{ anchor_fact: q, candidate_fact: q }])).toBe('recommendation_facts_not_supplied');
  });

  test('what the model is shown about the catalog row, seed and highlights can ground a quote', () => {
    const { buildEvidence } = require('../../scripts/review-relationship-candidate-labels');
    const evidenceRow = row(TONER_A, TONER_B);
    const supplement = { catalog: { title: 'Soothing Toner', tags: ['barrier repair', 'alcohol free'], canonical_url: 'https://shop.example/p' },
      external_seed: { title: 'Soothing Toner Value Size', domain: 'shop.example', price_currency: 'USD' } };
    const ev = buildEvidence(evidenceRow, new Map([['a', supplement], ['b', supplement]]));
    expect(ev.anchor.catalog.tags).toEqual(['barrier repair', 'alcohol free']);
    const decide = (quotes) => validateRecommendationDecision(evidenceRow, approve(quotes), ev).verdict;
    expect(decide([{ anchor_fact: 'barrier repair', candidate_fact: 'barrier repair' }])).toBe('approve');
    expect(decide([{ anchor_fact: 'Value Size', candidate_fact: 'Value Size' }])).toBe('approve');
    // URLs, domains and currency are never facts.
    expect(decide([{ anchor_fact: 'shop.example', candidate_fact: 'shop.example' }])).toBe('reject');
  });

  test('a long many-part quote cannot stall the review', () => {
    const text = Array.from({ length: 12 }, (_, i) => `soft calm word${i % 3} calm soft`).join(' ');
    const a = { ...TONER_A, description: text };
    const parts = Array.from({ length: 8 }, () => 'calm soft').join(' … ');
    const t0 = Date.now();
    expect(verdict(a, b, [{ anchor_fact: parts, candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
    const six = Array.from({ length: 6 }, () => 'calm soft').join(' … ');
    verdict(a, b, [{ anchor_fact: six, candidate_fact: cand }]);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test('gap bound, order across three parts, and two words per part each decide (N4, N5, N7)', () => {
    const far = { ...TONER_A, description: `Calms redness quickly ${'and keeps going '.repeat(12)}absorbs fast overnight.` };
    expect(verdict(far, b, [{ anchor_fact: 'Calms redness quickly … absorbs fast overnight', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
    const near = { ...TONER_A, description: 'Calms redness quickly and keeps going, absorbs fast overnight, leaves skin soft.' };
    expect(verdict(near, b, [{ anchor_fact: 'Calms redness quickly … absorbs fast overnight … leaves skin soft', candidate_fact: cand }])).toBe('approve');
    expect(verdict(near, b, [{ anchor_fact: 'Calms redness quickly … leaves skin soft … absorbs fast overnight', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
    // a part too thin to place (one generic word) makes the quote prove nothing (N7)...
    expect(verdict(near, b, [{ anchor_fact: 'Calms redness quickly … skin', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
    // ...but a specific single word may be a part, and an ignored quote does not sink a good pair
    expect(verdict(near, b, [{ anchor_fact: 'Calms redness quickly … overnight', candidate_fact: cand }])).toBe('approve');
    expect(verdict(near, b, [{ anchor_fact: 'Calms redness quickly … skin', candidate_fact: cand }, { anchor_fact: 'Allantoin', candidate_fact: 'Allantoin' }]))
      .toBe('approve');
  });

  test('every word of a multi-word brand is the brand (N13)', () => {
    const a = product('The Ordinary', 'The Ordinary Toner', { category: 'toner' }); const c = product('Good Molecules', 'Good Molecules Toner', { category: 'toner' });
    expect(verdict(a, c, [{ anchor_fact: 'Ordinary', candidate_fact: 'Molecules' }])).toBe('recommendation_facts_not_supplied');
  });

  test('metadata keys never ground, wherever they sit (N14)', () => {
    const a = { ...TONER_A, ingredient_evidence: [{ table: 'calming_reviewed_table', review_status: 'approved_by_expert', ingredient_text: 'Water' }] };
    expect(verdict(a, TONER_B, [{ anchor_fact: 'calming_reviewed_table', candidate_fact: 'Niacinamide' }])).toBe('recommendation_facts_not_supplied');
    expect(verdict(a, TONER_B, [{ anchor_fact: 'approved_by_expert', candidate_fact: 'Niacinamide' }])).toBe('recommendation_facts_not_supplied');
  });

  test('applyApproval writes the validated quotes, never the model\'s raw ones (N18)', async () => {
    const writes = [];
    const queryFn = async (sql, params) => { writes.push({ sql, params }); return { rows: [{ id: 'q', old_label_state: 'generated', new_label_state: 'ai_approved' }] }; };
    const raw = approve([{ anchor_fact: 'category": "toner', candidate_fact: 'category": "toner' }, { anchor_fact: 'ingredients": "Allantoin', candidate_fact: 'Allantoin' }]);
    await applyApproval(row(TONER_A, TONER_B), raw, queryFn);
    const update = writes.find((w) => /SET\s+label_state = 'ai_approved'/.test(w.sql));
    const stored = JSON.stringify(update.params);
    expect(stored).toContain('Allantoin');
    expect(stored).not.toMatch(/category\\?":/);
    expect(stored).not.toMatch(/ingredients\\?":/);
  });

  test('a passage keeps the fact\'s own case', () => {
    const a = { ...TONER_A, description: 'Gently Calms Redness. Lightweight Watery Texture absorbs fast.' };
    const ok = validateRecommendationDecision(row(a, b), approve([{ anchor_fact: 'gently calms redness … watery texture absorbs fast', candidate_fact: cand }]));
    expect(ok.shared_evidence[0].anchor_fact).toBe('Gently Calms Redness. Lightweight Watery Texture absorbs fast');
  });
});

test('metadata keys are never read, even nested inside a descriptive field (N14)', () => {
  const values = __quoteGrounding.quoteFactValues({ beauty_attrs: { product_form: 'gel', confidence: 'clinically proven', source_refs: [{ name: 'lab tested' }] } })
    .map((v) => v.norm);
  expect(values).toContain('gel');
  expect(values).not.toContain('clinically proven');
  expect(values).not.toContain('lab tested');
});

test('a part still JSON-shaped after parsing fails the quote; it cannot hide an invented claim', () => {
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'niacinamide', candidate_fact: 'niacinamide' },
    { anchor_fact: 'invented_claim":"', candidate_fact: 'whatever_key": "' }])).toBe('recommendation_facts_not_supplied');
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'niacinamide', candidate_fact: 'niacinamide' },
    { anchor_fact: '{ "clinically proven" }', candidate_fact: 'Allantoin' }])).toBe('recommendation_facts_not_supplied');
  // Malformed output is refused even when its words are only generic: it is not skipped as harmless.
  expect(verdict(TONER_A, TONER_B, [{ anchor_fact: 'niacinamide', candidate_fact: 'niacinamide' },
    { anchor_fact: 'skin": "', candidate_fact: 'face": "' }])).toBe('recommendation_facts_not_supplied');
});

describe('controller review round 4 (2026-10-20)', () => {
  const cand = 'Suitable for sensitive skin';
  const b = { ...TONER_B, description: 'Suitable for sensitive skin. Non-comedogenic.' };

  test('an affix that flips the fact is part of the word', () => {
    const a = { ...TONER_A, description: 'A Vitamin C-free gentle formula. Non-comedogenic finish.' };
    expect(verdict(a, b, [{ anchor_fact: 'A Vitamin C … gentle formula', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
    expect(verdict(a, b, [{ anchor_fact: 'Vitamin C', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
    expect(verdict(a, b, [{ anchor_fact: 'comedogenic finish', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
  });

  test('a key never reaches a sibling field: title": "x" is looked for in titles only', () => {
    const { buildEvidence } = require('../../scripts/review-relationship-candidate-labels');
    const evidenceRow = row(TONER_A, TONER_B);
    const supplement = { catalog: { title: 'Soothing Toner', tags: ['barrier repair'] } };
    const ev = buildEvidence(evidenceRow, new Map([['a', supplement], ['b', supplement]]));
    const decide = (quotes) => validateRecommendationDecision(evidenceRow, approve(quotes), ev).verdict;
    expect(decide([{ anchor_fact: 'title": "barrier repair', candidate_fact: 'barrier repair' }])).toBe('reject');
    expect(decide([{ anchor_fact: 'tags": "barrier repair', candidate_fact: 'barrier repair' }])).toBe('approve');
  });

  test('sponsored or unreviewed signal claims never ground a quote', () => {
    const { buildEvidence } = require('../../scripts/review-relationship-candidate-labels');
    const evidenceRow = row(TONER_A, TONER_B);
    const claim = 'clinically proven to reduce wrinkles by 50%';
    const intel = { product_intel: { product_intel_core: {}, external_highlight_signals: [{ claim_text: claim, sponsored: true, review_status: 'rejected' }],
      market_signal_badges: [{ claim_text: claim }] } };
    const ev = buildEvidence({ ...evidenceRow, anchor_snapshot: { ...TONER_A, ...intel }, candidate_snapshot: { ...TONER_B, ...intel } }, new Map());
    expect(validateRecommendationDecision(evidenceRow, approve([{ anchor_fact: claim, candidate_fact: claim }]), ev).verdict).toBe('reject');
  });

  test('"rose" is not in "rosemary" (N10)', () => {
    const a = { ...TONER_A, description: 'Rosemary and clary sage toner.' };
    expect(verdict(a, b, [{ anchor_fact: 'rose', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
  });

  test('the elision search stays linear: many repeated parts over repeated text (N42)', () => {
    const { __quoteGrounding } = require('../../scripts/review-relationship-candidate-labels');
    const fact = 'calm soft '.repeat(400);
    const values = [{ norm: fact, raw: fact }];
    const t0 = Date.now();
    // five parts that chain everywhere, and a sixth that never appears: without the memo this is
    // exponential in the positions.
    expect(__quoteGrounding.elidedPassage(values, ['calm soft', 'calm soft', 'calm soft', 'calm soft', 'calm soft', 'missing words'])).toBe('');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('the fragrance rule judges the grounded quotes', () => {
    const fragrance = (title, description) => product('P' + title, title, { category: 'fragrance', description });
    const a = fragrance('Noir Eau de Parfum', 'Woody amber accord with vanilla.');
    const c = fragrance('Ambre Eau de Parfum', 'A warm amber accord.');
    expect(verdict(a, c, [{ anchor_fact: 'description": "Woody amber accord', candidate_fact: 'warm amber accord' }])).toBe('approve');
  });
});

describe('controller review round 5 (2026-10-20)', () => {
  const cand = 'Suitable for sensitive skin';
  const b = { ...TONER_B, description: 'Suitable for sensitive skin. Non-comedogenic.' };
  const good = { anchor_fact: 'Niacinamide', candidate_fact: 'Niacinamide' };

  test('an ignored quote is still checked: an invented specific part refuses the pair', () => {
    expect(verdict(TONER_A, TONER_B, [good, { anchor_fact: 'Allantoin', candidate_fact: 'cream … clinically proven to erase wrinkles' }]))
      .toBe('recommendation_facts_not_supplied');
    const seven = Array.from({ length: 6 }, () => 'Niacinamide').concat(['miraculous overnight results']).join(' … ');
    expect(verdict(TONER_A, TONER_B, [good, { anchor_fact: 'Allantoin', candidate_fact: seven }])).toBe('recommendation_facts_not_supplied');
    expect(verdict(TONER_A, TONER_B, [good, { anchor_fact: 'Allantoin', candidate_fact: 'water … miraculous' }])).toBe('recommendation_facts_not_supplied');
    // an ignored quote whose specific parts are all real still does not sink the pair
    expect(verdict(TONER_A, TONER_B, [good, { anchor_fact: 'Allantoin', candidate_fact: 'water … Niacinamide' }])).toBe('approve');
  });

  test('a dash is a hyphen: "oil" is not in "oil–free"', () => {
    const a = { ...TONER_A, description: 'A lightweight oil–free gel. Calms redness fast.' };
    expect(verdict(a, b, [{ anchor_fact: 'lightweight oil', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
  });

  test('an un-...-able caveat in the gap refuses on its own (N48)', () => {
    const a = { ...TONER_A, description: 'Deeply hydrating texture, unsuitable for oily skin, lasts all day on skin.' };
    expect(verdict(a, b, [{ anchor_fact: 'Deeply hydrating texture … lasts all day', candidate_fact: cand }])).toBe('recommendation_facts_not_supplied');
  });
});
