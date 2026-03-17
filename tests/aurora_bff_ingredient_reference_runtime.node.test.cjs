const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal: routeInternals } = require('../src/auroraBff/routes');

test.afterEach(() => {
  routeInternals.__resetGetBestIngredientReferenceMatchForTest();
});

test('ingredient reference runtime: canonicalizes short alias through reference seed fallback', async () => {
  routeInternals.__setGetBestIngredientReferenceMatchForTest(async (input) => {
    if (String(input || '').trim() !== 'MCI') return null;
    return {
      record_id: 'ING-0400',
      normalized_key: 'methylchloroisothiazolinone',
      canonical_inci_name: 'Methylchloroisothiazolinone',
      canonical_display_name: 'Methylchloroisothiazolinone',
      ingredient_family: 'preservative',
      primary_bucket: 'preservative',
      aliases_common_list: ['MCI'],
      deprecated_aliases_list: [],
      benefit_tags_list: ['formula_stability'],
      function_tags_list: ['preservative'],
      risk_flags_list: ['sensitizer'],
      flags: { is_preservative: true },
    };
  });

  const target = await routeInternals.extractIngredientLookupTargetFromText('MCI', 'EN');
  assert.equal(target, 'Methylchloroisothiazolinone');
});

test('ingredient reference runtime: canonicalizes common-name alias through reference seed fallback', async () => {
  routeInternals.__setGetBestIngredientReferenceMatchForTest(async (input) => {
    if (String(input || '').trim() !== 'Vitamin A') return null;
    return {
      record_id: 'ING-0209',
      normalized_key: 'retinol',
      canonical_inci_name: 'Retinol',
      canonical_display_name: 'Retinol',
      ingredient_family: 'retinoid',
      primary_bucket: 'anti-aging',
      aliases_common_list: ['Vitamin A'],
      deprecated_aliases_list: [],
      benefit_tags_list: ['anti-aging'],
      function_tags_list: ['retinoid'],
      risk_flags_list: [],
      flags: { is_retinoid: true },
    };
  });

  const target = await routeInternals.extractIngredientLookupTargetFromText('Vitamin A', 'EN');
  assert.equal(target, 'Retinol');
});

test('ingredient reference runtime: payload overlay upgrades generic ingredient into deterministic reference-backed report', () => {
  const payload = routeInternals.buildIngredientReportPayload({
    language: 'EN',
    query: 'Methylchloroisothiazolinone',
    research: null,
    meta: {
      normalized_query: 'methylchloroisothiazolinone',
      ingredient_reference: {
        record_id: 'ING-0400',
        normalized_key: 'methylchloroisothiazolinone',
        canonical_inci_name: 'Methylchloroisothiazolinone',
        canonical_display_name: 'Methylchloroisothiazolinone',
        ingredient_family: 'preservative',
        primary_bucket: 'preservative',
        aliases_common_list: ['MCI'],
        deprecated_aliases_list: [],
        benefit_tags_list: ['formula_stability'],
        function_tags_list: ['preservative'],
        risk_flags_list: ['sensitizer'],
        flags: {
          is_preservative: true,
        },
      },
    },
  });

  assert.ok(payload);
  assert.equal(payload.ingredient.inci, 'Methylchloroisothiazolinone');
  assert.equal(payload.ingredient.display_name, 'Methylchloroisothiazolinone');
  assert.ok(Array.isArray(payload.ingredient.aliases));
  assert.equal(payload.ingredient.aliases.includes('MCI'), true);
  assert.match(payload.ingredient.category, /preservative/i);
  assert.equal(payload.verdict.evidence_grade, 'B');
  assert.equal(payload.verdict.personalization_basis, 'ingredient_reference');
  assert.equal(payload.report_state.reason_code, 'reference_seed_hit');
  assert.equal(payload.confidence, 'medium');
  assert.ok(Array.isArray(payload.benefits) && payload.benefits.length >= 1);
  assert.ok(Array.isArray(payload.watchouts) && payload.watchouts.length >= 1);
});

test('ingredient reference runtime: reviewed reference beats conflicting legacy alias library profile', () => {
  const payload = routeInternals.buildIngredientReportPayload({
    language: 'EN',
    query: 'Alpha-Arbutin',
    research: null,
    meta: {
      normalized_query: 'alpha_arbutin',
      ingredient_reference: {
        record_id: 'ING-0501',
        normalized_key: 'alphaarbutin',
        canonical_inci_name: 'Alpha-Arbutin',
        canonical_display_name: 'Alpha-Arbutin',
        ingredient_family: 'other',
        primary_bucket: 'brightening',
        aliases_common_list: ['Alpha Arbutin'],
        deprecated_aliases_list: [],
        benefit_tags_list: ['brightening'],
        function_tags_list: ['depigmenting'],
        risk_flags_list: [],
        flags: {},
      },
    },
  });

  assert.ok(payload);
  assert.equal(payload.ingredient.key, 'alphaarbutin');
  assert.equal(payload.ingredient.inci, 'Alpha-Arbutin');
  assert.equal(payload.ingredient.display_name, 'Alpha-Arbutin');
  assert.equal(payload.ingredient.aliases.includes('Alpha Arbutin'), true);
  assert.match(payload.ingredient.category, /brightening/i);
  assert.equal(payload.verdict.personalization_basis, 'ingredient_reference');
  assert.equal(payload.report_state.reason_code, 'reference_seed_hit');
});

test('ingredient reference runtime: aligned reviewed reference still wins final report semantics over legacy library hits', () => {
  const payload = routeInternals.buildIngredientReportPayload({
    language: 'EN',
    query: 'Vitamin C',
    research: null,
    meta: {
      normalized_query: 'vitamin c',
      ingredient_reference: {
        record_id: 'ING-0301',
        normalized_key: 'ascorbicacid',
        canonical_inci_name: 'Ascorbic Acid',
        canonical_display_name: 'Ascorbic Acid',
        ingredient_family: 'vitamin',
        primary_bucket: 'anti-aging',
        aliases_common_list: ['Vitamin C'],
        deprecated_aliases_list: [],
        benefit_tags_list: ['brightening', 'antioxidant'],
        function_tags_list: ['antioxidant'],
        risk_flags_list: [],
        flags: {},
      },
    },
  });

  assert.ok(payload);
  assert.equal(payload.ingredient.key, 'ascorbicacid');
  assert.equal(payload.ingredient.inci, 'Ascorbic Acid');
  assert.equal(payload.verdict.personalization_basis, 'ingredient_reference');
  assert.equal(payload.report_state.reason_code, 'reference_seed_hit');
});
