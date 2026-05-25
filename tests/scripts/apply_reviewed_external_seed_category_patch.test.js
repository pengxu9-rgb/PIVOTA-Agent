jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })) })),
  closePool: jest.fn(async () => {}),
}));

const {
  _internals: {
    buildCategoryPatchPlanForRow,
    buildServingPatch,
    normalizeCategoryPath,
    readManifestEntries,
    scoreTitleMatch,
    summarizePlans,
    validateEntry,
  },
} = require('../../scripts/apply-reviewed-external-seed-category-patch.cjs');

describe('apply-reviewed-external-seed-category-patch', () => {
  test('normalizes category paths for reviewed beauty taxonomy', () => {
    expect(normalizeCategoryPath(' Beauty / Makeup / Nails / Nail Polish ')).toBe('beauty/makeup/nails/nail-polish');
  });

  test('plans missing category into root, snapshot, and recall without touching price', () => {
    const [entry] = readManifestEntries({
      reviewed_by: 'codex_review',
      entries: [
        {
          external_product_id: 'ext_miss_nella_polish',
          title: 'MN06 Butterfly Wings: Glittery Lilac Peel Off Nail Polish',
          category: 'Nail Polish',
          category_path: 'beauty/makeup/nails/nail-polish',
          source_url: 'https://www.missnella.com/products/mn06-butterfly-wings-3-pack',
          evidence: 'Official Miss Nella product title and URL identify this row as peel-off nail polish.',
          confidence: 0.95,
        },
      ],
    });
    expect(validateEntry(entry)).toEqual([]);

    const row = {
      id: 'eps_fixture',
      external_product_id: 'ext_miss_nella_polish',
      title: 'MN06 Butterfly Wings: Glittery Lilac Peel Off Nail Polish',
      canonical_url: 'https://www.missnella.com/products/mn06-butterfly-wings-3-pack',
      seed_data: {
        title: 'MN06 Butterfly Wings: Glittery Lilac Peel Off Nail Polish',
        price_amount: 2.65,
        price_currency: 'USD',
        snapshot: {
          title: 'MN06 Butterfly Wings: Glittery Lilac Peel Off Nail Polish',
          price_amount: 2.65,
          price_currency: 'USD',
        },
      },
    };

    const plan = buildCategoryPatchPlanForRow(row, entry, { now: '2026-05-22T00:00:00.000Z' });

    expect(plan.status).toBe('planned');
    expect(plan.next_seed_data.category).toBe('Nail Polish');
    expect(plan.next_seed_data.snapshot.category).toBe('Nail Polish');
    expect(plan.next_seed_data.derived.recall.category).toBe('Nail Polish');
    expect(plan.next_seed_data.category_path).toBe('beauty/makeup/nails/nail-polish');
    expect(plan.next_seed_data.snapshot.catalog_category_path).toBe('beauty/makeup/nails/nail-polish');
    expect(plan.next_seed_data.price_amount).toBe(2.65);
    expect(plan.next_seed_data.snapshot.price_amount).toBe(2.65);
    expect(plan.next_seed_data.reviewed_category_patch_v1).toEqual(
      expect.objectContaining({
        contract_version: 'external_seed.reviewed_category_patch.v1',
        review_state: 'assistant_reviewed',
        category: 'Nail Polish',
      }),
    );

    const servingPatch = buildServingPatch(plan.next_seed_data, plan.patch_keys);
    expect(servingPatch).toEqual(
      expect.objectContaining({
        category: 'Nail Polish',
        product_type: 'Nail Polish',
        category_path: 'beauty/makeup/nails/nail-polish',
      }),
    );
    expect(servingPatch).not.toHaveProperty('price');
    expect(servingPatch).not.toHaveProperty('price_amount');
  });

  test('blocks conflicting existing categories by default', () => {
    const [entry] = readManifestEntries({
      entries: [
        {
          external_product_id: 'ext_fixture',
          title: 'Gentle Face Cream',
          category: 'Moisturizer',
          category_path: 'beauty/skincare/moisturize/cream',
          source_url: 'https://example.com/products/gentle-face-cream',
          evidence: 'Official product title and URL identify this as a face cream.',
        },
      ],
    });
    const plan = buildCategoryPatchPlanForRow(
      {
        external_product_id: 'ext_fixture',
        title: 'Gentle Face Cream',
        seed_data: {
          category: 'Eyeshadow',
          snapshot: { category: 'Eyeshadow' },
        },
      },
      entry,
    );

    expect(plan.status).toBe('blocked');
    expect(plan.blocking_reasons.join('|')).toContain('existing_category_conflict');
  });

  test('allows reviewed overwrite when explicitly requested', () => {
    const [entry] = readManifestEntries({
      entries: [
        {
          external_product_id: 'ext_fixture',
          title: 'Ginseng Essence Water',
          category: 'Toner / Essence',
          category_path: 'beauty/skincare/treat/toner',
          source_url: 'https://beautyofjoseon.com/products/ginseng-essence-water',
          evidence: 'Official product title and product page identify this as an essence water toner, not a serum.',
          confidence: 0.95,
        },
      ],
    });
    const plan = buildCategoryPatchPlanForRow(
      {
        external_product_id: 'ext_fixture',
        title: 'Ginseng Essence Water',
        seed_data: {
          category: 'Serum',
          category_path: 'beauty/skincare/treat/serum',
          snapshot: {
            category: 'Serum',
            category_path: 'beauty/skincare/treat/serum',
          },
        },
      },
      entry,
      { allowOverwrite: true, now: '2026-05-25T00:00:00.000Z' },
    );

    expect(plan.status).toBe('planned');
    expect(plan.before.category_path).toBe('beauty/skincare/treat/serum');
    expect(plan.after.category_path).toBe('beauty/skincare/treat/toner');
    expect(plan.next_seed_data.reviewed_category_patch_v1).toEqual(
      expect.objectContaining({
        review_state: 'assistant_reviewed',
        previous_values: expect.objectContaining({
          category_path: 'beauty/skincare/treat/serum',
        }),
      }),
    );
  });

  test('is idempotent when reviewed category fields already exist', () => {
    const [entry] = readManifestEntries({
      entries: [
        {
          external_product_id: 'ext_fixture',
          title: 'Lav Kids Skincare by Miss Nella Facial Foaming Cleanser 100ml',
          category: 'Cleanser',
          category_path: 'beauty/skincare/cleanse/cleanser',
          source_url: 'https://www.missnella.com/products/lavkids-skincare-by-miss-nella-facial-foaming-cleanser-100ml',
          evidence: 'Official product title and URL identify this as a facial foaming cleanser.',
        },
      ],
    });
    const existingContract = {
      contract_version: 'external_seed.reviewed_category_patch.v1',
      review_state: 'assistant_reviewed',
      category: 'Cleanser',
      category_path: 'beauty/skincare/cleanse/cleanser',
    };
    const seedData = {
      category: 'Cleanser',
      product_type: 'Cleanser',
      category_path: 'beauty/skincare/cleanse/cleanser',
      catalog_category_path: 'beauty/skincare/cleanse/cleanser',
      reviewed_category_patch_v1: existingContract,
      snapshot: {
        category: 'Cleanser',
        product_type: 'Cleanser',
        category_path: 'beauty/skincare/cleanse/cleanser',
        catalog_category_path: 'beauty/skincare/cleanse/cleanser',
        reviewed_category_patch_v1: existingContract,
      },
      derived: { recall: { category: 'Cleanser' } },
    };
    const plan = buildCategoryPatchPlanForRow(
      {
        external_product_id: 'ext_fixture',
        title: 'Lav Kids Skincare by Miss Nella Facial Foaming Cleanser 100ml',
        seed_data: seedData,
      },
      entry,
    );

    expect(plan.status).toBe('unchanged');
    expect(plan.changed).toBe(false);
  });

  test('blocks weak evidence and mismatched titles', () => {
    const [weak] = readManifestEntries({
      entries: [
        {
          external_product_id: 'ext_fixture',
          category: 'Lip Gloss',
          category_path: 'beauty/makeup/lips/lip-gloss',
          source_url: 'https://example.com/products/lip-gloss',
        },
      ],
    });
    expect(validateEntry(weak)).toContain('missing_review_evidence');

    const [entry] = readManifestEntries({
      entries: [
        {
          external_product_id: 'ext_fixture',
          title: 'Lip Gloss',
          category: 'Lip Gloss',
          category_path: 'beauty/makeup/lips/lip-gloss',
          source_url: 'https://example.com/products/lip-gloss',
          evidence: 'Official product title and URL identify this row as lip gloss.',
        },
      ],
    });
    const plan = buildCategoryPatchPlanForRow(
      {
        external_product_id: 'ext_fixture',
        title: 'Facial Foaming Cleanser',
        seed_data: { snapshot: { title: 'Facial Foaming Cleanser' } },
      },
      entry,
    );

    expect(scoreTitleMatch('Lip Gloss', 'Facial Foaming Cleanser')).toBe(0);
    expect(plan.status).toBe('blocked');
    expect(plan.blocking_reasons).toContain('title_mismatch');
  });

  test('summarizes plans for dry-run and apply reports', () => {
    const summary = summarizePlans([
      { status: 'planned', patch_keys: ['category', 'category_path'] },
      { status: 'blocked', blocking_reasons: ['title_mismatch'] },
      { status: 'missing', blocking_reasons: ['row_not_found'] },
    ]);

    expect(summary.planned).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.missing).toBe(1);
    expect(summary.by_patch_key.category).toBe(1);
    expect(summary.blocking_reasons.title_mismatch).toBe(1);
  });
});
