'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectRoutineLifecycleStage,
  hasNonEmptyRoutine,
  diffRoutines,
  buildRoutineLifecycleContext,
  assessProfileCompleteness,
  buildLifecyclePromptInstructions,
  buildSupplementaryPromptInstructions,
  detectActiveConflicts,
  parseRoutineForSupplementary,
} = require('../src/auroraBff/routineLifecycle');

const {
  getInteractionRules,
  getSafetyRules,
  findRelevantInteractionRules,
  buildKbGroundingForPrompt,
} = require('../src/auroraBff/routineKbLoader');

const {
  normalizeRoutineSteps,
  extractProductNamesFromNotes,
  detectUserIntent,
} = require('../src/auroraBff/skills/routineIntakeParserSkill');

const {
  extractExistingProducts,
} = require('../src/auroraBff/skills/routineRecommendationSkill');

const { extractRoutineProducts } = require('../src/auroraBff/skinSignalsDto');

// ---------------------------------------------------------------------------
// routineLifecycle — detectRoutineLifecycleStage
// ---------------------------------------------------------------------------

test('detectRoutineLifecycleStage: first_time when no previous routine', () => {
  const stage = detectRoutineLifecycleStage({
    routineCandidate: { am: [{ step: 'c', product: 'X' }], pm: [] },
    previousRoutine: null,
  });
  assert.equal(stage, 'first_time');
});

test('detectRoutineLifecycleStage: follow_up when previous exists', () => {
  const stage = detectRoutineLifecycleStage({
    routineCandidate: { am: [{ step: 'c', product: 'Y' }], pm: [] },
    previousRoutine: { am: [{ step: 'c', product: 'X' }], pm: [] },
  });
  assert.equal(stage, 'follow_up');
});

test('detectRoutineLifecycleStage: optimization on intent=optimize', () => {
  assert.equal(
    detectRoutineLifecycleStage({ routineCandidate: { am: [], pm: [] }, intent: 'optimize' }),
    'optimization',
  );
  assert.equal(
    detectRoutineLifecycleStage({ intent: 'analysis_optimize_existing' }),
    'optimization',
  );
  assert.equal(
    detectRoutineLifecycleStage({ intent: 'analysis_review_products' }),
    'optimization',
  );
});

test('detectRoutineLifecycleStage: null when no routine', () => {
  assert.equal(detectRoutineLifecycleStage({ routineCandidate: null }), null);
  assert.equal(detectRoutineLifecycleStage({}), null);
});

test('detectRoutineLifecycleStage: photo_trigger for 6-21 day window', () => {
  const ts = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(
    detectRoutineLifecycleStage({ lastRoutineUpdateTs: ts }),
    'photo_trigger',
  );
});

test('detectRoutineLifecycleStage: optimization when expert issues exist', () => {
  assert.equal(
    detectRoutineLifecycleStage({ routineExpertIssues: [{ id: 'conflict' }] }),
    'optimization',
  );
});

// ---------------------------------------------------------------------------
// routineLifecycle — hasNonEmptyRoutine
// ---------------------------------------------------------------------------

test('hasNonEmptyRoutine: null/undefined → false', () => {
  assert.equal(hasNonEmptyRoutine(null), false);
  assert.equal(hasNonEmptyRoutine(undefined), false);
  assert.equal(hasNonEmptyRoutine(''), false);
});

test('hasNonEmptyRoutine: non-empty string → true', () => {
  assert.equal(hasNonEmptyRoutine('some routine'), true);
});

test('hasNonEmptyRoutine: object with am steps → true', () => {
  assert.equal(hasNonEmptyRoutine({ am: [{ step: 'c', product: 'X' }], pm: [] }), true);
});

test('hasNonEmptyRoutine: object with only notes → true', () => {
  assert.equal(hasNonEmptyRoutine({ am: [], pm: [], notes: 'hello' }), true);
});

test('hasNonEmptyRoutine: empty object → false', () => {
  assert.equal(hasNonEmptyRoutine({ am: [], pm: [], notes: '' }), false);
});

// ---------------------------------------------------------------------------
// routineLifecycle — diffRoutines
// ---------------------------------------------------------------------------

test('diffRoutines: detects replaced, removed, unchanged correctly', () => {
  const diff = diffRoutines(
    { am: [{ step: 'cleanser', product: 'A' }, { step: 'spf', product: 'B' }], pm: [{ step: 'treatment', product: 'C' }] },
    { am: [{ step: 'cleanser', product: 'D' }, { step: 'spf', product: 'B' }], pm: [] },
  );
  assert.equal(diff.replaced.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.unchanged.length, 1);
  assert.equal(diff.magnitude, 'minor');
});

test('diffRoutines: empty routines → magnitude none', () => {
  const diff = diffRoutines({ am: [], pm: [] }, { am: [], pm: [] });
  assert.equal(diff.magnitude, 'none');
});

test('diffRoutines: many changes → magnitude major', () => {
  const diff = diffRoutines(
    { am: [{ step: 'a', product: 'X' }, { step: 'b', product: 'Y' }, { step: 'c', product: 'Z' }], pm: [] },
    { am: [{ step: 'a', product: 'X2' }, { step: 'b', product: 'Y2' }, { step: 'c', product: 'Z2' }], pm: [] },
  );
  assert.equal(diff.magnitude, 'major');
});

test('diffRoutines: notes_changed flag', () => {
  const diff = diffRoutines({ am: [], pm: [], notes: 'old' }, { am: [], pm: [], notes: 'new' });
  assert.equal(diff.notes_changed, true);
});

test('diffRoutines: handles null/invalid inputs gracefully', () => {
  const diff = diffRoutines(null, null);
  assert.equal(diff.magnitude, 'none');
});

// ---------------------------------------------------------------------------
// routineLifecycle — assessProfileCompleteness
// ---------------------------------------------------------------------------

test('assessProfileCompleteness: complete profile', () => {
  const result = assessProfileCompleteness({
    skinType: 'oily', sensitivity: 'low', barrierStatus: 'healthy', goals: ['acne'],
    pregnancy_status: 'not_pregnant', age_band: '25-34',
  });
  assert.equal(result.complete_pct, 100);
  assert.equal(result.missing_fields.length, 0);
  assert.equal(result.missing_safety_fields.length, 0);
});

test('assessProfileCompleteness: empty profile', () => {
  const result = assessProfileCompleteness({});
  assert.equal(result.complete_pct, 0);
  assert.equal(result.missing_fields.length, 4);
});

// ---------------------------------------------------------------------------
// routineLifecycle — buildLifecyclePromptInstructions
// ---------------------------------------------------------------------------

test('buildLifecyclePromptInstructions: first_time EN with diagnosis', () => {
  const ctx = buildRoutineLifecycleContext({
    stage: 'first_time',
    routineCandidate: { am: [{ step: 'c', product: 'X' }], pm: [] },
    profileSummary: { skinType: 'oily', goals: ['acne'] },
    language: 'EN',
  });
  const instr = buildLifecyclePromptInstructions(ctx, 'EN');
  assert.ok(instr.includes('Cross-match'));
  assert.ok(instr.includes('first_time'));
});

test('buildLifecyclePromptInstructions: first_time CN without diagnosis', () => {
  const ctx = buildRoutineLifecycleContext({
    stage: 'first_time',
    routineCandidate: { am: [{ step: 'c', product: 'X' }], pm: [] },
    profileSummary: {},
    language: 'CN',
  });
  const instr = buildLifecyclePromptInstructions(ctx, 'CN');
  assert.ok(instr.includes('无历史诊断'));
});

test('buildLifecyclePromptInstructions: follow_up includes diff summary', () => {
  const ctx = buildRoutineLifecycleContext({
    stage: 'follow_up',
    routineCandidate: { am: [{ step: 'c', product: 'New' }], pm: [] },
    previousRoutine: { am: [{ step: 'c', product: 'Old' }], pm: [] },
    language: 'EN',
  });
  const instr = buildLifecyclePromptInstructions(ctx, 'EN');
  assert.ok(instr.includes('follow_up'));
  assert.ok(instr.includes('routine_diff_summary'));
});

test('buildLifecyclePromptInstructions: optimization includes issue ids', () => {
  const ctx = buildRoutineLifecycleContext({
    stage: 'optimization',
    routineExpert: { key_issues: [{ id: 'conflict_retinoid_aha' }] },
    language: 'EN',
  });
  const instr = buildLifecyclePromptInstructions(ctx, 'EN');
  assert.ok(instr.includes('optimization'));
  assert.ok(instr.includes('conflict_retinoid_aha'));
});

test('buildLifecyclePromptInstructions: photo_trigger mentions days', () => {
  const ts = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const ctx = buildRoutineLifecycleContext({
    stage: 'photo_trigger',
    lastRoutineUpdateTs: ts,
    language: 'EN',
  });
  const instr = buildLifecyclePromptInstructions(ctx, 'EN');
  assert.ok(instr.includes('photo_trigger'));
});

test('buildLifecyclePromptInstructions: null stage → empty string', () => {
  assert.equal(buildLifecyclePromptInstructions(null), '');
  assert.equal(buildLifecyclePromptInstructions({}), '');
});

// ---------------------------------------------------------------------------
// routineLifecycle — buildSupplementaryPromptInstructions
// ---------------------------------------------------------------------------

test('buildSupplementaryPromptInstructions: tolerance_ladder for retinoid', () => {
  const supp = buildSupplementaryPromptInstructions({
    routineCandidate: { am: [{ step: 't', product: 'Retinol 1%' }], pm: [] },
    profileSummary: {},
    language: 'EN',
  });
  assert.ok(supp.includes('tolerance_ladder'));
});

test('buildSupplementaryPromptInstructions: conflict_alert for multiple actives', () => {
  const supp = buildSupplementaryPromptInstructions({
    routineCandidate: {
      am: [{ step: 't', product: 'Retinol 1%' }, { step: 't', product: 'BHA Toner' }],
      pm: [{ step: 't', product: 'Glycolic Acid' }],
    },
    profileSummary: {},
    language: 'EN',
  });
  assert.ok(supp.includes('conflict_alert'));
});

test('buildSupplementaryPromptInstructions: sensitivity_guard for high sensitivity', () => {
  const supp = buildSupplementaryPromptInstructions({
    routineCandidate: { am: [{ step: 't', product: 'Retinol' }], pm: [] },
    profileSummary: { sensitivity: 'high' },
    language: 'EN',
  });
  assert.ok(supp.includes('sensitivity_guard'));
});

test('buildSupplementaryPromptInstructions: simplification for many steps', () => {
  const steps = Array.from({ length: 8 }, (_, i) => ({ step: `s${i}`, product: `P${i}` }));
  const supp = buildSupplementaryPromptInstructions({
    routineCandidate: { am: steps, pm: [] },
    profileSummary: {},
    language: 'EN',
  });
  assert.ok(supp.includes('simplification'));
});

test('buildSupplementaryPromptInstructions: empty string for no routine', () => {
  assert.equal(buildSupplementaryPromptInstructions({ routineCandidate: null }), '');
  assert.equal(buildSupplementaryPromptInstructions({}), '');
});

// ---------------------------------------------------------------------------
// routineLifecycle — parseRoutineForSupplementary
// ---------------------------------------------------------------------------

test('parseRoutineForSupplementary: detects retinoid, aha, bha', () => {
  const result = parseRoutineForSupplementary({
    am: [{ step: 't', product: 'Retinol Serum' }],
    pm: [{ step: 't', product: 'Glycolic Acid Toner' }, { step: 't', product: 'BHA Exfoliant' }],
  });
  assert.ok(result.actives.includes('retinoid'));
  assert.ok(result.actives.includes('aha'));
  assert.ok(result.actives.includes('bha'));
  assert.equal(result.amSteps.length, 1);
  assert.equal(result.pmSteps.length, 2);
});

test('parseRoutineForSupplementary: detects CN actives in notes', () => {
  const result = parseRoutineForSupplementary({
    am: [], pm: [],
    notes: '我用了维A和水杨酸',
  });
  assert.ok(result.actives.includes('retinoid'));
  assert.ok(result.actives.includes('bha'));
});

test('parseRoutineForSupplementary: null input → empty', () => {
  const result = parseRoutineForSupplementary(null);
  assert.deepEqual(result, { actives: [], amSteps: [], pmSteps: [] });
});

// ---------------------------------------------------------------------------
// routineLifecycle — detectActiveConflicts
// ---------------------------------------------------------------------------

test('detectActiveConflicts: retinoid+aha is high-risk pair', () => {
  const conflicts = detectActiveConflicts(['retinoid', 'aha']);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], ['retinoid', 'aha']);
});

test('detectActiveConflicts: no conflicts for safe combination', () => {
  const conflicts = detectActiveConflicts(['niacinamide', 'azelaic_acid']);
  assert.equal(conflicts.length, 0);
});

test('detectActiveConflicts: multiple conflicts detected', () => {
  const conflicts = detectActiveConflicts(['retinoid', 'aha', 'bha', 'benzoyl_peroxide']);
  assert.ok(conflicts.length >= 4);
});

// ---------------------------------------------------------------------------
// routineKbLoader — findRelevantInteractionRules
// ---------------------------------------------------------------------------

test('routineKbLoader: findRelevantInteractionRules returns high risk for RETINOID+AHA', () => {
  const rules = findRelevantInteractionRules(['RETINOID', 'AHA']);
  assert.ok(rules.length >= 1);
  assert.equal(rules[0].risk, 'high');
});

test('routineKbLoader: findRelevantInteractionRules returns empty for single concept', () => {
  assert.deepEqual(findRelevantInteractionRules(['RETINOID']), []);
  assert.deepEqual(findRelevantInteractionRules(null), []);
});

// ---------------------------------------------------------------------------
// routineKbLoader — buildKbGroundingForPrompt
// ---------------------------------------------------------------------------

test('routineKbLoader: buildKbGroundingForPrompt returns non-empty for matching concepts', () => {
  const grounding = buildKbGroundingForPrompt({
    activeConcepts: ['RETINOID', 'BHA'],
    profileSummary: {},
    language: 'EN',
  });
  assert.ok(grounding.length > 50);
  assert.ok(grounding.includes('kb_interaction_rules'));
});

test('routineKbLoader: buildKbGroundingForPrompt CN language', () => {
  const grounding = buildKbGroundingForPrompt({
    activeConcepts: ['RETINOID', 'AHA'],
    profileSummary: {},
    language: 'CN',
  });
  assert.ok(grounding.includes('知识库'));
});

test('routineKbLoader: buildKbGroundingForPrompt empty for no matches', () => {
  const grounding = buildKbGroundingForPrompt({
    activeConcepts: ['NIACINAMIDE'],
    profileSummary: {},
    language: 'EN',
  });
  assert.equal(grounding, '');
});

// ---------------------------------------------------------------------------
// routineKbLoader — cache TTL
// ---------------------------------------------------------------------------

test('routineKbLoader: getInteractionRules returns consistent data from cache', () => {
  const first = getInteractionRules();
  const second = getInteractionRules();
  assert.equal(first, second);
  assert.ok(Array.isArray(first));
});

test('routineKbLoader: getSafetyRules returns consistent data from cache', () => {
  const first = getSafetyRules();
  const second = getSafetyRules();
  assert.equal(first, second);
  assert.ok(first.rules !== undefined);
  assert.ok(first.templates !== undefined);
});

// ---------------------------------------------------------------------------
// routineIntakeParserSkill — normalizeRoutineSteps
// ---------------------------------------------------------------------------

test('normalizeRoutineSteps: normalizes valid steps', () => {
  const result = normalizeRoutineSteps([
    { step: 'Cleanser', product: 'CeraVe' },
    { step: 'SPF', product: 'La Roche-Posay' },
    null,
    'invalid',
    { step: '', product: 'X' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].step, 'cleanser');
  assert.equal(result[1].step, 'spf');
});

test('normalizeRoutineSteps: non-array → empty', () => {
  assert.deepEqual(normalizeRoutineSteps(null), []);
  assert.deepEqual(normalizeRoutineSteps('foo'), []);
});

test('normalizeRoutineSteps: preserves product_id/sku_id', () => {
  const result = normalizeRoutineSteps([{ step: 'c', product: 'X', product_id: 'P1', sku_id: 'S1' }]);
  assert.equal(result[0].product_id, 'P1');
  assert.equal(result[0].sku_id, 'S1');
});

test('normalizeRoutineSteps: limits to 8 entries', () => {
  const steps = Array.from({ length: 12 }, (_, i) => ({ step: `s${i}`, product: `P${i}` }));
  assert.equal(normalizeRoutineSteps(steps).length, 8);
});

// ---------------------------------------------------------------------------
// routineIntakeParserSkill — extractProductNamesFromNotes
// ---------------------------------------------------------------------------

test('extractProductNamesFromNotes: extracts products with action verbs', () => {
  const products = extractProductNamesFromNotes('Started using CeraVe Hydrating Cleanser, and switched to La Roche-Posay SPF');
  assert.ok(products.length >= 1);
});

test('extractProductNamesFromNotes: extracts capitalized product names with type suffix', () => {
  const products = extractProductNamesFromNotes('My routine includes EViDenS Cream and Tatcha Cleanser');
  assert.ok(products.length >= 1);
});

test('extractProductNamesFromNotes: null/empty → empty array', () => {
  assert.deepEqual(extractProductNamesFromNotes(null), []);
  assert.deepEqual(extractProductNamesFromNotes(''), []);
});

// ---------------------------------------------------------------------------
// routineIntakeParserSkill — detectUserIntent
// ---------------------------------------------------------------------------

test('detectUserIntent: add product', () => {
  assert.equal(detectUserIntent('I added a new serum'), 'add_product');
  assert.equal(detectUserIntent('新增了一个面霜'), 'add_product');
});

test('detectUserIntent: replace product', () => {
  assert.equal(detectUserIntent('Switched to a gentler cleanser'), 'replace_product');
  assert.equal(detectUserIntent('换了洗面奶'), 'replace_product');
});

test('detectUserIntent: remove product', () => {
  assert.equal(detectUserIntent('Stopped using retinol'), 'remove_product');
  assert.equal(detectUserIntent('停用了精华'), 'remove_product');
});

test('detectUserIntent: report reaction', () => {
  assert.equal(detectUserIntent('My skin is stinging after the serum'), 'report_reaction');
  assert.equal(detectUserIntent('用完后脸刺痛泛红'), 'report_reaction');
});

test('detectUserIntent: general update', () => {
  assert.equal(detectUserIntent('Updated my routine for summer'), 'general_update');
});

test('detectUserIntent: null → unknown', () => {
  assert.equal(detectUserIntent(null), 'unknown');
});

// ---------------------------------------------------------------------------
// routineRecommendationSkill — extractExistingProducts
// ---------------------------------------------------------------------------

test('extractExistingProducts: extracts from am/pm slots', () => {
  const products = extractExistingProducts({
    am: [{ step: 'cleanser', product: 'CeraVe Cleanser' }],
    pm: [{ step: 'treatment', product: 'Retinol Serum', product_id: 'R1' }],
  });
  assert.equal(products.length, 2);
  assert.equal(products[0].slot, 'am');
  assert.equal(products[1].product_id, 'R1');
});

test('extractExistingProducts: null/invalid → empty', () => {
  assert.deepEqual(extractExistingProducts(null), []);
  assert.deepEqual(extractExistingProducts('string'), []);
});

test('extractExistingProducts: skips empty product entries', () => {
  const products = extractExistingProducts({
    am: [{ step: 'c', product: '' }, null, { step: 's', product: 'SPF 50' }],
    pm: [],
  });
  assert.equal(products.length, 1);
  assert.equal(products[0].product, 'SPF 50');
});

// ---------------------------------------------------------------------------
// skinSignalsDto — extractRoutineProducts
// ---------------------------------------------------------------------------

test('extractRoutineProducts: extracts am/pm/notes', () => {
  const rp = extractRoutineProducts({
    am: [{ step: 'cleanser', product: 'CeraVe Cleanser' }],
    pm: [{ step: 'treatment', product: 'Retinol Serum' }],
    notes: 'EViDenS mask at night',
  });
  assert.equal(rp.am.length, 1);
  assert.equal(rp.pm.length, 1);
  assert.equal(rp.notes, 'EViDenS mask at night');
});

test('extractRoutineProducts: null input returns null', () => {
  assert.equal(extractRoutineProducts(null), null);
  assert.equal(extractRoutineProducts(undefined), null);
});

test('extractRoutineProducts: non-object returns null', () => {
  assert.equal(extractRoutineProducts('string'), null);
  assert.equal(extractRoutineProducts(42), null);
});
