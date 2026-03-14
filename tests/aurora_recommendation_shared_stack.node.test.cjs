const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveRecommendationTargetContext,
  buildSameFamilyQueryLevels,
  finalizeRecommendationCandidatePools,
} = require('../src/auroraBff/recommendationSharedStack');

test('step resolution parity keeps moisturizer aliases aligned across direct/chat', () => {
  const aliases = ['moisturizer', 'cream', '面霜', '保湿霜', '日霜'];
  for (const input of aliases) {
    const direct = resolveRecommendationTargetContext({
      focus: input,
      text: `Recommend ${input} for me`,
      entryType: 'direct',
    });
    const chat = resolveRecommendationTargetContext({
      text: `Recommend a ${input} for me`,
      entryType: 'chat',
    });
    assert.equal(direct.resolved_target_step, 'moisturizer');
    assert.equal(chat.resolved_target_step, 'moisturizer');
    assert.equal(direct.resolved_target_step_confidence, 'high');
    assert.equal(chat.resolved_target_step_confidence, 'high');
  }
});

test('direct focus negatives do not escalate to high-confidence hard target', () => {
  for (const input of ['repair', 'hydrating', 'barrier support', 'something for night']) {
    const result = resolveRecommendationTargetContext({
      focus: input,
      text: input,
      entryType: 'direct',
    });
    assert.notEqual(result.resolved_target_step_confidence, 'high');
  }
});

test('same-family ladder never broadens moisturizer into cleanser or sunscreen family', () => {
  const targetContext = resolveRecommendationTargetContext({
    focus: 'moisturizer',
    text: 'Recommend a moisturizer for barrier support',
    entryType: 'chat',
  });
  const levels = buildSameFamilyQueryLevels({
    targetContext,
    profileSummary: { goals: ['barrier repair'] },
    ingredientContext: { query: 'ceramide' },
    lang: 'EN',
  });
  const queries = levels.flatMap((level) => level.queries.map((row) => row.query.toLowerCase()));
  assert.ok(queries.some((query) => query.includes('moisturizer') || query.includes('cream')));
  assert.ok(!queries.some((query) => query.includes('cleanser')));
  assert.ok(!queries.some((query) => query.includes('sunscreen')));
});

test('viability stage rejects non-skincare and preserves moisturizer candidates', () => {
  const targetContext = resolveRecommendationTargetContext({
    focus: 'moisturizer',
    text: 'Recommend a moisturizer for me',
    entryType: 'direct',
  });
  const pool = finalizeRecommendationCandidatePools(
    [
      {
        product_id: 'face_cream_1',
        merchant_id: 'mid_cream',
        brand: 'GoodSkin',
        name: 'Barrier Cream',
        display_name: 'Barrier Cream',
        category: 'face cream',
        product_type: 'cream',
      },
      {
        product_id: 'brush_1',
        merchant_id: 'mid_brush',
        brand: 'BrushCo',
        name: 'Small Eyeshadow Brush',
        display_name: 'Small Eyeshadow Brush',
        category: 'makeup brush',
        product_type: 'tool',
      },
    ],
    { targetContext },
  );

  assert.equal(pool.viable_candidate_count, 1);
  assert.equal(pool.hard_reject_count, 1);
  assert.equal(pool.selected_candidate_count, 1);
  assert.equal(pool.selected_recommendations[0].product_id, 'face_cream_1');
  assert.equal(pool.terminal_success, true);
});

test('medium-confidence target only succeeds when same-family viable candidates exist', () => {
  const targetContext = resolveRecommendationTargetContext({
    text: 'I need something for night',
    entryType: 'chat',
  });
  assert.equal(targetContext.resolved_target_step_confidence, 'medium');

  const successPool = finalizeRecommendationCandidatePools(
    [
      {
        product_id: 'night_cream_1',
        merchant_id: 'mid_night_cream',
        brand: 'GoodSkin',
        name: 'Night Barrier Cream',
        display_name: 'Night Barrier Cream',
        category: 'night cream',
        product_type: 'cream',
      },
    ],
    { targetContext },
  );
  assert.equal(successPool.terminal_success, true);

  const clarifyPool = finalizeRecommendationCandidatePools(
    [
      {
        product_id: 'sleep_mask_1',
        merchant_id: 'mid_sleep_mask',
        brand: 'GoodSkin',
        name: 'Sleeping Mask',
        display_name: 'Sleeping Mask',
        category: 'sleeping mask',
        product_type: 'mask',
      },
    ],
    { targetContext },
  );
  assert.equal(clarifyPool.terminal_success, false);
  assert.equal(clarifyPool.viable_candidate_count, 0);
  assert.equal(clarifyPool.soft_mismatch_count, 1);
  assert.equal(clarifyPool.weak_viable_pool, true);
});
