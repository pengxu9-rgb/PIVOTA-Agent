const {
  buildStructuredPdpIngredientModules,
} = require('../../src/services/pdpIngredientAuthority');
const {
  fetchReviewedIngredientAuthority,
  hydrateProductWithReviewedIngredientAuthority,
  _internals,
} = require('../../src/services/pdpReviewedIngredientAuthority');

describe('pdpReviewedIngredientAuthority', () => {
  beforeEach(() => {
    _internals.resetTableAvailabilityCacheForTest();
  });

  test('hydrates authoritative PDP ingredient modules from exact beauty_sku_ingredients rows', async () => {
    const queryFn = jest.fn(async (sql, params) => {
      if (/to_regclass/i.test(sql)) {
        expect(params).toEqual(['public.beauty_sku_ingredients']);
        return { rows: [{ table_name: 'public.beauty_sku_ingredients' }] };
      }
      expect(sql).toContain('FROM public.beauty_sku_ingredients');
      expect(params[0]).toEqual(
        expect.arrayContaining([
          '9886500749640',
          'product:9886500749640',
          'merch_efbc46b4619cfbdf:9886500749640',
        ]),
      );
      expect(params[1]).toBe('merch_efbc46b4619cfbdf');
      return {
        rows: [
          {
            sku_key: 'merch_efbc46b4619cfbdf:9886500749640',
            product_key: '9886500749640',
            merchant_id: 'merch_efbc46b4619cfbdf',
            raw_inci: 'Water, Glycerin, Ectoin, Sodium Hyaluronate',
            normalized_ingredients_json: ['Water', 'Glycerin', 'Ectoin', 'Sodium Hyaluronate'],
            active_ingredients_json: ['Ectoin', 'Sodium Hyaluronate'],
            source_system: 'reviewed_operator_entry',
            updated_at: '2026-04-14T09:00:00.000Z',
          },
        ],
      };
    });

    const hydrated = await hydrateProductWithReviewedIngredientAuthority({
      product: {
        merchant_id: 'merch_efbc46b4619cfbdf',
        product_id: '9886500749640',
        title: 'Winona Soothing Repair Serum',
        description: 'Test fixture for PDP. Replace with your own description if needed.',
      },
      canonicalProductRef: {
        merchant_id: 'merch_efbc46b4619cfbdf',
        product_id: '9886500749640',
      },
      queryFn,
    });

    expect(hydrated.ingredient_intel.authoritative).toEqual(
      expect.objectContaining({
        source_origin: 'kb_reviewed',
        purity_status: 'authoritative',
        items: ['Water', 'Glycerin', 'Ectoin', 'Sodium Hyaluronate'],
        active_items: ['Ectoin', 'Sodium Hyaluronate'],
      }),
    );

    const modules = buildStructuredPdpIngredientModules(hydrated);
    expect(modules.ingredientsInciData.items).toEqual(
      expect.arrayContaining(['Ectoin', 'Sodium Hyaluronate']),
    );
    expect(modules.activeIngredientsData.items).toEqual(['Ectoin', 'Sodium Hyaluronate']);
  });

  test('does not query reviewed ingredient KB when the product already has usable authority', async () => {
    const queryFn = jest.fn();
    const product = {
      product_id: 'p_1',
      ingredient_intel: {
        authoritative: {
          raw_text: 'Water, Glycerin, Niacinamide',
          items: ['Water', 'Glycerin', 'Niacinamide'],
          active_items: ['Niacinamide'],
          source_origin: 'kb_reviewed',
          purity_status: 'authoritative',
        },
      },
    };

    const hydrated = await hydrateProductWithReviewedIngredientAuthority({
      product,
      canonicalProductRef: { product_id: 'p_1' },
      queryFn,
    });

    expect(hydrated).toBe(product);
    expect(queryFn).not.toHaveBeenCalled();
  });

  test('uses reviewed pci_kb.sku_ingredients only after the primary reviewed table is unavailable', async () => {
    const queryFn = jest.fn(async (sql, params) => {
      if (/to_regclass/i.test(sql) && params[0] === 'public.beauty_sku_ingredients') {
        return { rows: [{ table_name: null }] };
      }
      if (/to_regclass/i.test(sql) && params[0] === 'pci_kb.sku_ingredients') {
        return { rows: [{ table_name: 'pci_kb.sku_ingredients' }] };
      }
      expect(sql).toContain('FROM pci_kb.sku_ingredients');
      expect(params[0]).toEqual(expect.arrayContaining(['product:ext_case']));
      return {
        rows: [
          {
            sku_key: 'product:ext_case',
            raw_ingredient_text_clean: 'Aqua, Glycerin, Panthenol',
            inci_list: 'Aqua, Glycerin, Panthenol',
            parse_status: 'OK',
            review_status: 'pass',
            audit_status: 'pass',
            ingest_allowed: true,
            created_at: '2026-04-14T09:00:00.000Z',
          },
        ],
      };
    });

    const hydrated = await hydrateProductWithReviewedIngredientAuthority({
      product: { product_id: 'ext_case', merchant_id: 'external_seed' },
      canonicalProductRef: { product_id: 'ext_case', merchant_id: 'external_seed' },
      queryFn,
    });

    expect(hydrated.ingredient_intel.authoritative.items).toEqual(['Aqua', 'Glycerin', 'Panthenol']);
    expect(hydrated.ingredient_intel.authoritative.source_ref.table).toBe('pci_kb.sku_ingredients');
  });

  test('caches exact reviewed ingredient misses to avoid repeated PDP DB hits', async () => {
    const queryFn = jest.fn(async (sql, params) => {
      if (/to_regclass/i.test(sql)) {
        if (params[0] === 'public.beauty_sku_ingredients') {
          return { rows: [{ table_name: 'public.beauty_sku_ingredients' }] };
        }
        return { rows: [{ table_name: null }] };
      }
      return { rows: [] };
    });
    const input = {
      product: { product_id: 'missing_case', merchant_id: 'external_seed' },
      canonicalProductRef: { product_id: 'missing_case', merchant_id: 'external_seed' },
      queryFn,
    };

    await expect(fetchReviewedIngredientAuthority(input)).resolves.toBeNull();
    await expect(fetchReviewedIngredientAuthority(input)).resolves.toBeNull();

    const beautySelectCalls = queryFn.mock.calls.filter((call) =>
      String(call[0]).includes('FROM public.beauty_sku_ingredients'),
    );
    expect(beautySelectCalls).toHaveLength(1);
  });
});
