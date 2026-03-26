const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal: routeInternals } = require('../src/auroraBff/routes');

test.afterEach(() => {
  routeInternals.__resetGetBestIngredientReferenceMatchForTest();
  routeInternals.__resetGetBestIngredientSignalMatchForTest();
});

test('ingredient signal runtime: canonicalizes reviewed signal umbrella term when no exact ingredient reference exists', async () => {
  routeInternals.__setGetBestIngredientSignalMatchForTest(async (input) => {
    const raw = String(input || '').trim();
    if (raw !== 'Alpha Hydroxy Acids' && raw !== 'AHA') return null;
    return {
      signal_bucket: 'acid_family_signal',
      signal_key: 'aha',
      display_signal_name: 'AHA',
      raw_token_variants_list: ['AHA', 'Alpha Hydroxy Acids'],
      normalized_token_variants_list: ['aha', 'alphahydroxyacids'],
      resolution_rationales_list: ['Approved as acid-family umbrella signal.'],
    };
  });

  const target = await routeInternals.extractIngredientLookupTargetFromText('Alpha Hydroxy Acids', 'EN');
  assert.equal(target, 'AHA');

  const shortTarget = await routeInternals.extractIngredientLookupTargetFromText('AHA', 'EN');
  assert.equal(shortTarget, 'AHA');
});

test('ingredient signal runtime: payload overlay upgrades generic query into signal-backed report', () => {
  const payload = routeInternals.buildIngredientReportPayload({
    language: 'EN',
    query: 'AHA',
    research: null,
    meta: {
      normalized_query: 'aha',
      ingredient_signal_preferred: true,
      ingredient_signal: {
        signal_bucket: 'acid_family_signal',
        signal_key: 'aha',
        display_signal_name: 'AHA',
        raw_token_variants_list: ['AHA', 'Alpha Hydroxy Acids'],
        normalized_token_variants_list: ['aha', 'alphahydroxyacids'],
        resolution_rationales_list: ['Approved as acid-family umbrella signal.'],
      },
    },
  });

  assert.ok(payload);
  assert.equal(payload.ingredient.key, 'aha');
  assert.equal(payload.ingredient.inci, 'AHA');
  assert.equal(payload.ingredient.display_name, 'AHA');
  assert.equal(payload.ingredient.aliases.includes('Alpha Hydroxy Acids'), true);
  assert.match(payload.ingredient.category, /acid family signal/i);
  assert.match(String(payload.ingredient.what_it_is || ''), /signal-dictionary term/i);
  assert.equal(payload.verdict.evidence_grade, 'B');
  assert.equal(payload.verdict.personalization_basis, 'ingredient_signal');
  assert.equal(payload.report_state.reason_code, 'signal_dict_hit');
  assert.equal(payload.confidence, 'medium');
  assert.ok(Array.isArray(payload.benefits) && payload.benefits.length >= 1);
  assert.ok(Array.isArray(payload.watchouts) && payload.watchouts.length >= 1);
});

test('ingredient signal runtime: reviewed ingredient reference keeps precedence over signal fallback', () => {
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
      ingredient_signal: {
        signal_bucket: 'marketing_or_blend_signal',
        signal_key: 'alpha_arbutin_complex',
        display_signal_name: 'Alpha-Arbutin Complex',
        raw_token_variants_list: ['Alpha-Arbutin Complex'],
        normalized_token_variants_list: ['alphaarbutincomplex'],
      },
    },
  });

  assert.ok(payload);
  assert.equal(payload.ingredient.inci, 'Alpha-Arbutin');
  assert.equal(payload.verdict.personalization_basis, 'ingredient_reference');
  assert.equal(payload.report_state.reason_code, 'reference_seed_hit');
});
