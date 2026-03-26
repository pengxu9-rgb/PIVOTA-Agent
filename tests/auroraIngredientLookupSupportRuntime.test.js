const {
  createIngredientLookupSupportRuntime,
} = require('../src/auroraBff/ingredientLookupSupportRuntime');

describe('createIngredientLookupSupportRuntime', () => {
  let runtime;

  beforeEach(() => {
    runtime = createIngredientLookupSupportRuntime();
  });

  afterEach(() => {
    runtime.__resetGetBestIngredientReferenceMatchForTest();
    runtime.__resetGetBestIngredientSignalMatchForTest();
  });

  test('matches common aliases to canonical ingredient keys', () => {
    expect(runtime.ingredientEntityMatchFromText('Vitamin A', 'EN')).toMatchObject({
      entity_key: 'retinol',
      entity_match_type: 'exact',
    });
    expect(runtime.normalizeIngredientLookupToken('Vitamin A')).toBe('retinol');
    expect(runtime.ingredient_query_normalize('  AHA—Acid  ')).toBe('aha acid');
  });

  test('prefers reviewed ingredient reference canonical query', async () => {
    runtime.__setGetBestIngredientReferenceMatchForTest(async (input) => {
      if (String(input || '').trim() !== 'MCI') return null;
      return {
        record_id: 'ING-0400',
        normalized_key: 'methylchloroisothiazolinone',
        canonical_inci_name: 'Methylchloroisothiazolinone',
        canonical_display_name: 'Methylchloroisothiazolinone',
        ingredient_family: 'preservative',
        primary_bucket: 'preservative',
        aliases_common_list: ['MCI'],
      };
    });

    await expect(runtime.extractIngredientLookupTargetFromText('MCI', 'EN')).resolves.toBe('Methylchloroisothiazolinone');
  });

  test('prefers reviewed signal umbrella when no reference exists', async () => {
    runtime.__setGetBestIngredientSignalMatchForTest(async (input) => {
      const raw = String(input || '').trim();
      if (raw !== 'Alpha Hydroxy Acids' && raw !== 'AHA') return null;
      return {
        signal_bucket: 'acid_family_signal',
        signal_key: 'aha',
        display_signal_name: 'AHA',
        raw_token_variants_list: ['AHA', 'Alpha Hydroxy Acids'],
      };
    });

    await expect(runtime.extractIngredientLookupTargetFromText('Alpha Hydroxy Acids', 'EN')).resolves.toBe('AHA');
  });

  test('builds deterministic reference and signal fallbacks', () => {
    const referenceFallback = runtime.buildIngredientReferenceFallback(
      {
        canonical_inci_name: 'Retinol',
        canonical_display_name: 'Retinol',
        ingredient_family: 'retinoid',
        primary_bucket: 'anti-aging',
        aliases_common_list: ['Vitamin A'],
        benefit_tags_list: ['anti-aging'],
        function_tags_list: ['retinoid'],
        risk_flags_list: [],
        flags: { is_retinoid: true },
      },
      'EN',
      'Vitamin A',
    );
    const signalFallback = runtime.buildIngredientSignalFallback(
      {
        signal_bucket: 'acid_family_signal',
        signal_key: 'aha',
        display_signal_name: 'AHA',
        raw_token_variants_list: ['AHA', 'Alpha Hydroxy Acids'],
      },
      'EN',
      'Alpha Hydroxy Acids',
    );

    expect(referenceFallback.category).toMatch(/retinoid/i);
    expect(referenceFallback.aliases).toContain('Vitamin A');
    expect(signalFallback.category).toMatch(/acid family signal/i);
    expect(signalFallback.aliases).toContain('Alpha Hydroxy Acids');
  });
});
