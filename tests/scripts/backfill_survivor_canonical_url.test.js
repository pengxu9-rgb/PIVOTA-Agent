jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  closePool: jest.fn(async () => {}),
}));

const db = require('../../src/db');

const {
  CONFIRM_TOKEN,
  EXTRA_SURVIVOR_KEYS,
  SURVIVOR_SQL,
  assertWriteConfirmed,
  planFor,
  fetchSurvivors,
  repairBatch,
  run,
} = require('../../scripts/backfill-survivor-canonical-url.cjs');

describe('planFor (which survivors get repaired)', () => {
  test('repairs a downgraded survivor URL from a clean seed URL', () => {
    expect(planFor({
      survivor_url: 'https://meritbeauty.com/products/bronze-balm-eu',
      seed_url: 'https://meritbeauty.com/products/bronze-balm',
    })).toEqual({ action: 'repair', reason: 'survivor_url_downgraded' });
  });

  test('repairs the Tower 28 promo case', () => {
    expect(planFor({
      survivor_url: 'https://tower28beauty.com/products/makewaves-mascara-gift-with-purchase',
      seed_url: 'https://tower28beauty.com/products/makewaves-mascara',
    })).toEqual({ action: 'repair', reason: 'survivor_url_downgraded' });
  });

  test('repairs an empty survivor URL when the seed has a clean one', () => {
    expect(planFor({
      product_key: 'ext:some-external-row::abc',
      survivor_url: null,
      seed_url: 'https://x.com/products/thing',
    })).toEqual({ action: 'repair', reason: 'survivor_url_missing' });
  });

  test('leaves blank first-party merchant URLs alone', () => {
    // Prod 2026-08-05: all 47 blank-URL candidates were internal_merchant rows
    // from one merchant whose seeds carried a DIFFERENT Shopify store than the
    // merchant itself — writing the seed URL would misdirect the row.
    expect(planFor({
      product_key: 'prod::merch_efbc46b4619cfbdf::shopify::10064558129449',
      survivor_url: null,
      seed_url: 'https://jwx893-fz.myshopify.com/products/winona-soothing-repair-serum',
    })).toEqual({ action: 'skip', reason: 'first_party_blank_url_is_normal' });
  });

  test('still repairs a first-party row whose URL is downgraded rather than blank', () => {
    expect(planFor({
      product_key: 'prod::merch_x::shopify::1',
      survivor_url: 'https://x.com/products/a-eu',
      seed_url: 'https://x.com/products/a',
    })).toEqual({ action: 'repair', reason: 'survivor_url_downgraded' });
  });

  test('skips when there is no seed URL to source from — never invents data', () => {
    expect(planFor({ survivor_url: 'https://x.com/a-eu', seed_url: '' }).action).toBe('skip');
    expect(planFor({ survivor_url: 'https://x.com/a-eu', seed_url: null }).reason).toBe('no_seed_url');
  });

  test('skips when the seed URL is itself downgraded — no lateral moves', () => {
    expect(planFor({
      survivor_url: 'https://x.com/products/a-eu',
      seed_url: 'https://x.com/products/a-uk',
    })).toEqual({ action: 'skip', reason: 'seed_url_also_downgraded' });
  });

  test('skips when the survivor already matches its seed', () => {
    expect(planFor({
      survivor_url: 'https://x.com/products/a',
      seed_url: 'https://x.com/products/a',
    })).toEqual({ action: 'skip', reason: 'already_matches_seed' });
  });

  test('skips a divergent-but-already-clean survivor rather than churning it', () => {
    expect(planFor({
      survivor_url: 'https://x.com/products/a',
      seed_url: 'https://x.com/products/b',
    })).toEqual({ action: 'skip', reason: 'survivor_url_already_clean' });
  });

  test('is null-safe', () => {
    expect(() => planFor(null)).not.toThrow();
    expect(planFor(null).action).toBe('skip');
  });
});

describe('survivor cohort SQL', () => {
  test('scopes to survivors of archived rows plus the explicitly-held-back key', () => {
    expect(SURVIVOR_SQL).toContain(`cp.sync_status = 'archived'`);
    expect(SURVIVOR_SQL).toContain('eps.attached_product_key');
    expect(SURVIVOR_SQL).toContain(`t.sync_status = 'live'`);
    // Freshest ACTIVE seed is the source of truth.
    expect(SURVIVOR_SQL).toContain(`eps.status = 'active'`);
    expect(SURVIVOR_SQL).toContain('ORDER BY eps.updated_at DESC NULLS LAST');
    expect(EXTRA_SURVIVOR_KEYS).toContain('ext:tower-28-beauty-makewaves-mascara::eabe44e4');
  });

  test('lookback and extras are parameterized', async () => {
    db.query.mockClear();
    await fetchSurvivors({ lookbackDays: 2 });
    const [, params] = db.query.mock.calls[0];
    expect(params[0]).toBe(2);
    expect(params[1]).toEqual(EXTRA_SURVIVOR_KEYS);
  });
});

describe('repairBatch', () => {
  beforeEach(() => db.query.mockClear());

  test('pins the expected current value so concurrent edits are skipped', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    const landed = await repairBatch([
      { product_key: 'k1', seed_url: 'https://x.com/a', survivor_url: 'https://x.com/a-eu' },
    ]);
    expect(landed).toBe(1);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('SET canonical_url = d.seed_url');
    expect(sql).toContain(`cp.sync_status = 'live'`);
    expect(sql).toContain(`coalesce(cp.canonical_url, '') = d.expected_current`);
    expect(params[2]).toEqual(['https://x.com/a-eu']);
  });

  test('an empty survivor URL is pinned as the empty string, not null', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    await repairBatch([{ product_key: 'k1', seed_url: 'https://x.com/a', survivor_url: null }]);
    expect(db.query.mock.calls[0][1][2]).toEqual(['']);
  });

  test('writes nothing when the batch is empty', async () => {
    await expect(repairBatch([])).resolves.toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('write confirm gate', () => {
  beforeEach(() => {
    db.query.mockClear();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  test('write intent without the exact token throws before any db access', async () => {
    await expect(run({ write: true, lookbackDays: 2, batchSize: 10 })).rejects.toThrow(
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

describe('run() partitioning', () => {
  test('dry-run partitions repairs vs skips and issues no UPDATE', async () => {
    db.query.mockReset();
    db.query.mockResolvedValueOnce({
      rows: [
        { product_key: 'ext:k1::a', survivor_url: 'https://x.com/a-eu', seed_url: 'https://x.com/a' },
        { product_key: 'ext:k2::b', survivor_url: null, seed_url: 'https://x.com/b' },
        { product_key: 'ext:k3::c', survivor_url: 'https://x.com/c', seed_url: 'https://x.com/c' },
        { product_key: 'ext:k4::d', survivor_url: 'https://x.com/d-eu', seed_url: '' },
      ],
    });

    const result = await run({ write: false, lookbackDays: 2, batchSize: 10 });
    expect(result.counters).toEqual({
      survivors_examined: 4,
      repair_candidates: 2,
      skipped: 2,
      rows_repaired: 0,
    });
    expect(result.by_repair_reason).toEqual({
      survivor_url_downgraded: 1,
      survivor_url_missing: 1,
    });
    expect(result.by_skip_reason).toEqual({ already_matches_seed: 1, no_seed_url: 1 });
    for (const [sql] of db.query.mock.calls) {
      expect(sql).not.toContain('UPDATE catalog_products');
    }
  });
});
