jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  closePool: jest.fn(async () => {}),
}));

const db = require('../../src/db');

const {
  CONFIRM_TOKEN,
  DEFAULT_TRACK,
  assertWriteConfirmed,
  buildClassifierInput,
  planFor,
  fetchBatch,
  stampBatch,
  run,
} = require('../../scripts/backfill-catalog-product-family.cjs');

describe('buildClassifierInput', () => {
  test('feeds row text plus payload standing in for seed_data/snapshot', () => {
    const input = buildClassifierInput({
      title: '5-step Korean Skincare Set',
      brand: 'Some Brand',
      description: 'Five full-size products',
      category: 'skincare',
      product_type: 'set',
      category_path: 'beauty/skincare',
      product_payload: { snapshot: { vendor: 'x' }, extra: 1 },
    });
    expect(input.title).toBe('5-step Korean Skincare Set');
    expect(input.seed_data.category).toBe('skincare');
    expect(input.seed_data.snapshot.product_type).toBe('set');
    expect(input.seed_data.catalog_category_path).toBe('beauty/skincare');
    // payload keys survive so the classifier sees everything sync would
    expect(input.extra).toBe(1);
  });

  test('accepts a payload delivered as a JSON string, and is null-safe', () => {
    const input = buildClassifierInput({
      title: 'T',
      product_payload: JSON.stringify({ category: 'from-payload' }),
    });
    expect(input.category).toBe('from-payload');
    expect(() => buildClassifierInput(null)).not.toThrow();
    expect(() => buildClassifierInput({ product_payload: 'not json{{' })).not.toThrow();
  });

  test('row columns win over payload for the same field', () => {
    const input = buildClassifierInput({
      title: 'row title',
      product_payload: { title: 'payload title' },
    });
    expect(input.title).toBe('row title');
  });
});

describe('planFor', () => {
  test('classifies a set using the real classifier', () => {
    const plan = planFor({ title: '7 day Ultimate Glass Glow Set', product_payload: {} });
    expect(plan.action).toBe('stamp');
    expect(plan.family).toBe('set_or_collection');
  });

  test('classifies a single product', () => {
    const plan = planFor({ title: 'Ceramide Skin Barrier Moisturizer', product_payload: {} });
    expect(plan.action).toBe('stamp');
    expect(plan.family).toBe('single_formula');
  });

  test('never overwrites an existing family', () => {
    expect(planFor({
      title: '5-step Korean Skincare Set',
      existing_family: 'single_formula',
      product_payload: {},
    })).toEqual({ action: 'skip', reason: 'already_classified' });
  });

  test('skips rather than stamps unknown_product, so a better classifier can claim it later', () => {
    const plan = planFor({ title: '', product_payload: {} });
    expect(plan.action).toBe('skip');
    expect(['unknown_product', 'no_family_returned']).toContain(plan.reason);
  });

  test('is null-safe', () => {
    expect(() => planFor(null)).not.toThrow();
    expect(planFor(null).action).toBe('skip');
  });
});

describe('cohort SQL', () => {
  test('scopes to live rows of the given track with no existing family', async () => {
    db.query.mockClear();
    await fetchBatch({ track: DEFAULT_TRACK, batchSize: 10, offset: 0 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain(`cp.sync_status = 'live'`);
    expect(sql).toContain('cp.catalog_track = $1');
    expect(sql).toContain(`coalesce(cp.product_payload->>'product_family', '') = ''`);
    expect(sql).toContain('row_to_json');
    expect(params).toEqual(['external_referral', 10, 0]);
  });
});

describe('stampBatch', () => {
  beforeEach(() => db.query.mockClear());

  test('re-asserts the cohort predicate so concurrent sync writes are not overwritten', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 2 });
    const landed = await stampBatch([
      { product_key: 'k1', family: 'set_or_collection' },
      { product_key: 'k2', family: 'single_formula' },
    ]);
    expect(landed).toBe(2);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('jsonb_set');
    expect(sql).toContain(`'{product_family}'`);
    // Guards repeated inside the UPDATE, not trusted from the SELECT.
    expect(sql).toContain(`cp.sync_status = 'live'`);
    expect(sql).toContain(`coalesce(cp.product_payload->>'product_family', '') = ''`);
    expect(params[0]).toEqual(['k1', 'k2']);
    expect(params[1]).toEqual(['set_or_collection', 'single_formula']);
  });

  test('preserves the rest of the payload rather than replacing it', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    await stampBatch([{ product_key: 'k1', family: 'sample' }]);
    const [sql] = db.query.mock.calls[0];
    expect(sql).toContain(`coalesce(cp.product_payload, '{}'::jsonb)`);
    expect(sql).not.toMatch(/SET\s+product_payload\s*=\s*\$/);
  });

  test('writes nothing when the batch is empty', async () => {
    await expect(stampBatch([])).resolves.toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('write confirm gate', () => {
  beforeEach(() => {
    db.query.mockClear();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  test('write intent without the exact token throws before any db access', async () => {
    await expect(run({ write: true, track: DEFAULT_TRACK, batchSize: 10 })).rejects.toThrow(
      `Refusing write without --confirm ${CONFIRM_TOKEN}`,
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  test('assertWriteConfirmed is the shared gate', () => {
    expect(() => assertWriteConfirmed({ write: true })).toThrow(/Refusing write/);
    expect(() => assertWriteConfirmed({ write: true, confirm: CONFIRM_TOKEN })).not.toThrow();
    expect(() => assertWriteConfirmed({ write: false })).not.toThrow();
  });
});

describe('run()', () => {
  test('dry-run tallies families and issues no UPDATE', async () => {
    db.query.mockReset();
    db.query.mockResolvedValueOnce({
      rows: [
        { j: { product_key: 'k1', title: '7 day Ultimate Glass Glow Set', product_payload: {} } },
        { j: { product_key: 'k2', title: 'Ceramide Skin Barrier Moisturizer', product_payload: {} } },
        { j: { product_key: 'k3', title: 'Whatever', existing_family: 'accessory', product_payload: {} } },
      ],
    });
    db.query.mockResolvedValue({ rows: [] });

    const result = await run({ write: false, track: DEFAULT_TRACK, batchSize: 3, maxRows: 3 });
    expect(result.counters.rows_scanned).toBe(3);
    expect(result.counters.would_stamp).toBe(2);
    expect(result.counters.rows_stamped).toBe(0);
    expect(result.by_family.set_or_collection).toBe(1);
    expect(result.by_family.single_formula).toBe(1);
    expect(result.by_skip_reason.already_classified).toBe(1);
    for (const [sql] of db.query.mock.calls) {
      expect(sql).not.toContain('UPDATE catalog_products');
    }
  });

  test('write mode stamps only planned rows', async () => {
    db.query.mockReset();
    db.query.mockResolvedValueOnce({
      rows: [{ j: { product_key: 'k1', title: 'Double Cleansing Duo Set', product_payload: {} } }],
    });
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    db.query.mockResolvedValue({ rows: [] });

    const result = await run({
      write: true, confirm: CONFIRM_TOKEN, track: DEFAULT_TRACK, batchSize: 1, maxRows: 1,
    });
    expect(result.counters.rows_stamped).toBe(1);
    expect(result.by_family.set_or_collection).toBe(1);
  });
});
