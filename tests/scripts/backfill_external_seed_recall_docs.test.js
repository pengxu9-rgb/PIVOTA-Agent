jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
}));

const { query } = require('../../src/db');
const {
  buildRecallDocUpdate,
  fetchRows,
  processRow,
  recallDocHasSearchSurface,
  summarizeResults,
} = require('../../scripts/backfill-external-seed-recall-docs');

describe('backfill-external-seed-recall-docs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('fetchRows defaults to rows missing persisted recall docs', async () => {
    await fetchRows({ market: 'US', limit: 25, offset: 10 });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("seed_data#>>'{derived,recall,retrieval_title}'");
    expect(sql).toContain("seed_data#>>'{derived,recall,retrieval_summary}'");
    expect(sql).toContain("seed_data#>>'{derived,recall,retrieval_body}'");
    expect(sql).toContain('ORDER BY id::text ASC');
    expect(params).toEqual(['US', 25, 10]);
  });

  test('fetchRows can include existing recall docs and preserve seed-id ordering', async () => {
    await fetchRows({
      market: 'US',
      seedIds: ['eps_beta', 'eps_alpha'],
      limit: 2,
      offset: 0,
      onlyMissing: false,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain("seed_data#>>'{derived,recall,retrieval_title}'");
    expect(sql).toContain('id::text = ANY($2::text[])');
    expect(sql).toContain('array_position($2::text[], id::text) ASC NULLS LAST');
    expect(params).toEqual(['US', ['eps_beta', 'eps_alpha'], 2, 0]);
  });

  test('fetchRows category-repair mode scans broad or raw-category candidates without missing-doc filter', async () => {
    await fetchRows({
      market: 'US',
      limit: 50,
      offset: 0,
      categoryRepair: true,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("seed_data#>>'{derived,recall,category}'");
    expect(sql).toContain("seed_data->>'product_type'");
    expect(sql).toContain("seed_data->'snapshot'->>'product_type'");
    expect(sql).not.toContain("seed_data#>>'{derived,recall,retrieval_title}'");
    expect(sql).not.toContain("seed_data#>>'{derived,recall,retrieval_summary}'");
    expect(sql).not.toContain("seed_data#>>'{derived,recall,retrieval_body}'");
    expect(params[0]).toBe('US');
    expect(params[1]).toEqual(expect.arrayContaining(['skincare', 'makeup', 'hair care']));
    expect(params.slice(-2)).toEqual([50, 0]);
  });

  test('buildRecallDocUpdate adds derived recall without mutating snapshot', () => {
    const row = {
      id: 'eps_one',
      external_product_id: 'ext_one',
      title: 'Fenty Skin Instant Reset Overnight Recovery Gel-Cream',
      canonical_url: 'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
      destination_url: 'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
      seed_data: {
        brand: 'Fenty Skin',
        description: 'A plush overnight gel-cream that helps recharge skin with hydration and barrier support.',
        snapshot: {
          title: 'Instant Reset Overnight Recovery Gel-Cream',
          description: 'A plush overnight gel-cream that helps recharge skin with hydration and barrier support.',
          canonical_url: 'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
        },
      },
    };
    const snapshotBefore = JSON.parse(JSON.stringify(row.seed_data.snapshot));

    const update = buildRecallDocUpdate(row);

    expect(update.changed).toBe(true);
    expect(update.nextSeedData.snapshot).toEqual(snapshotBefore);
    expect(update.nextSeedData.derived.recall).toEqual(
      expect.objectContaining({
        retrieval_title: 'Instant Reset Overnight Recovery Gel-Cream',
        retrieval_summary: expect.stringContaining('plush overnight gel-cream'),
        brand: 'Fenty Skin',
        version: 'v1',
      }),
    );
  });

  test('buildRecallDocUpdate repairs broad recall category to leaf product_type', () => {
    const row = {
      id: 'eps_serum_repair',
      title: 'Brightening Vitamin C Serum',
      seed_data: {
        brand: 'Example Beauty',
        category: 'Skincare',
        product_type: 'Serum',
        description: 'A brightening vitamin C serum for daily use.',
        derived: {
          recall: {
            retrieval_title: 'Brightening Vitamin C Serum',
            retrieval_summary: 'A brightening vitamin C serum for daily use.',
            retrieval_body: 'A brightening vitamin C serum for daily use.',
            brand: 'Example Beauty',
            category: 'Skincare',
            vertical: 'skincare',
            version: 'v1',
          },
        },
      },
    };

    const update = buildRecallDocUpdate(row);

    expect(update.changed).toBe(true);
    expect(update.category_changed).toBe(true);
    expect(update.previous_recall_category).toBe('Skincare');
    expect(update.next_recall_category).toBe('Serum');
    expect(update.nextSeedData.derived.recall.category).toBe('Serum');
  });

  test('processRow dry-run does not persist updates', async () => {
    const row = {
      id: 'eps_two',
      title: 'Poutsicle Hydrating Lip Stain',
      seed_data: {
        brand: 'Fenty Beauty',
        description: 'A lip stain that delivers juicy, long-lasting color.',
        snapshot: {
          title: 'Poutsicle Hydrating Lip Stain',
          description: 'A lip stain that delivers juicy, long-lasting color.',
        },
      },
    };

    const result = await processRow(row, { dryRun: true });

    expect(result.status).toBe('dry_run');
    expect(result.recall.retrieval_title).toBe('Poutsicle Hydrating Lip Stain');
    expect(query).not.toHaveBeenCalled();
  });

  test('processRow persists changed seed_data recall docs', async () => {
    const row = {
      id: 'eps_three',
      title: 'Noir de Noir Eau de Parfum',
      seed_data: {
        brand: 'Tom Ford',
        description: 'A dark, floral fragrance with saffron, black rose and truffle.',
        snapshot: {
          title: 'Noir de Noir Eau de Parfum',
          description: 'A dark, floral fragrance with saffron, black rose and truffle.',
        },
      },
    };

    const result = await processRow(row, { dryRun: false });

    expect(result.status).toBe('updated');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('UPDATE external_product_seeds');
    expect(sql).not.toContain('updated_at = now()');
    expect(params[0]).toBe('eps_three');
    const persistedSeedData = JSON.parse(params[1]);
    expect(persistedSeedData.derived.recall).toEqual(
      expect.objectContaining({
        retrieval_title: 'Noir de Noir Eau de Parfum',
        vertical: 'fragrance',
      }),
    );
  });

  test('processRow can opt into touching updated_at explicitly', async () => {
    const row = {
      id: 'eps_four',
      title: 'Lip Butter Balm',
      seed_data: {
        brand: 'Summer Fridays',
        description: 'A buttery lip balm with cushiony hydration.',
        snapshot: {
          title: 'Lip Butter Balm',
          description: 'A buttery lip balm with cushiony hydration.',
        },
      },
    };

    const result = await processRow(row, { dryRun: false, touchUpdatedAt: true });

    expect(result.status).toBe('updated');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('updated_at = now()');
  });

  test('summarizeResults returns domain status counts', () => {
    expect(
      summarizeResults([
        { status: 'updated', had_recall: false, row: { domain: 'fentybeauty.com' } },
        { status: 'dry_run', had_recall: true, row: { domain: 'fentybeauty.com' } },
        { status: 'skipped', had_recall: false, row: { domain: 'pixibeauty.com' } },
      ]),
    ).toEqual(
      expect.objectContaining({
        scanned: 3,
        updated: 1,
        dry_run: 1,
        skipped: 1,
        had_recall: 1,
        by_domain: {
          'fentybeauty.com': { scanned: 2, updated: 1, dry_run: 1, skipped: 0 },
          'pixibeauty.com': { scanned: 1, updated: 0, dry_run: 0, skipped: 1 },
        },
      }),
    );
  });

  test('recallDocHasSearchSurface recognizes persisted recall search fields', () => {
    expect(recallDocHasSearchSurface({ retrieval_title: 'Noir de Noir' })).toBe(true);
    expect(recallDocHasSearchSurface({ vertical: 'fragrance' })).toBe(false);
  });
});
