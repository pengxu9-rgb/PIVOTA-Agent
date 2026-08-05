jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  closePool: jest.fn(async () => {}),
}));

const db = require('../../src/db');

const {
  CONFIRM_TOKEN,
  COHORT_SQL,
  buildCohortSql,
  assertWriteConfirmed,
  blockReasonFor,
  isDowngradedUrl,
  titleKey,
  fetchCohort,
  archiveBatch,
  run,
} = require('../../scripts/archive-stranded-external-seed-mirrors.cjs');

function safeRow(overrides = {}) {
  return {
    product_key: 'prod::external_seed::external_seed::ext_a',
    content_key: 'ck_shared',
    title: 'Boox Page',
    sync_status: 'live',
    canonical_key: 'prod::merch_x::shopify::1',
    canonical_exists: true,
    canonical_sync_status: 'live',
    canonical_content_key: 'ck_shared',
    canonical_title: 'Boox Page',
    canonical_url: 'https://shop.boox.com/products/boox-page',
    canonical_canonical_url: 'https://shop.boox.com/products/boox-page',
    ...overrides,
  };
}

describe('blockReasonFor (duplicate-proof guards)', () => {
  test('passes a row whose canonical is live and shares content_key + title', () => {
    expect(blockReasonFor(safeRow())).toBeNull();
  });

  test('title comparison ignores case and surrounding whitespace', () => {
    expect(blockReasonFor(safeRow({ title: '  boox PAGE ' }))).toBeNull();
  });

  test('blocks when the canonical row is missing or not live', () => {
    expect(blockReasonFor(safeRow({ canonical_exists: false }))).toBe('canonical_missing');
    expect(blockReasonFor(safeRow({ canonical_sync_status: 'archived' }))).toBe('canonical_not_live');
  });

  test('blocks when content_key differs — the duplicate proof', () => {
    expect(blockReasonFor(safeRow({ canonical_content_key: 'ck_other' }))).toBe('content_key_mismatch');
  });

  test('blocks when the stranded row has no content_key at all', () => {
    expect(blockReasonFor(safeRow({ content_key: null, canonical_content_key: null })))
      .toBe('content_key_mismatch');
  });

  test('blocks when titles disagree', () => {
    expect(blockReasonFor(safeRow({ canonical_title: 'Something Else' }))).toBe('title_mismatch');
  });

  test('treats trademark glyphs and whitespace runs as presentation, not identity', () => {
    // Prod 2026-08-05: "MakeWaves® Mascara" vs "MakeWaves Mascara" held a
    // genuine duplicate live. Same mascara.
    expect(titleKey('MakeWaves® Mascara')).toBe(titleKey('MakeWaves Mascara'));
    expect(titleKey('Brow  1980™')).toBe(titleKey('brow 1980'));
    expect(titleKey('  Bronze Balm©  ')).toBe('bronze balm');

    expect(blockReasonFor(safeRow({
      title: 'MakeWaves® Mascara',
      canonical_title: 'MakeWaves Mascara',
    }))).toBeNull();
  });

  test('normalization does not collapse genuinely different titles', () => {
    expect(titleKey('Brow 1980')).not.toBe(titleKey('Brow 1990'));
    expect(blockReasonFor(safeRow({
      title: 'MakeWaves® Mascara Mini',
      canonical_title: 'MakeWaves Mascara',
    }))).toBe('title_mismatch');
  });

  test('blocks when a title is empty after normalization', () => {
    expect(blockReasonFor(safeRow({ title: '®', canonical_title: '®' }))).toBe('title_mismatch');
  });

  test('is null-safe on garbage input', () => {
    expect(() => blockReasonFor(null)).not.toThrow();
    expect(blockReasonFor(null)).toBe('canonical_missing');
  });
});

describe('survivor-quality guard (regression: prod 2026-08-05)', () => {
  test('isDowngradedUrl flags regional storefronts and promo pages, not clean PDPs', () => {
    expect(isDowngradedUrl('https://meritbeauty.com/products/bronze-balm-eu', 'Bronze Balm')).toBe(true);
    expect(isDowngradedUrl('https://meritbeauty.com/products/clean-lash-uk', 'Clean Lash')).toBe(true);
    expect(isDowngradedUrl('https://tower28beauty.com/products/makewaves-mascara-gift-with-purchase', 'MakeWaves Mascara')).toBe(true);
    expect(isDowngradedUrl('https://x.com/products/thing-bundle', 'Thing')).toBe(true);

    expect(isDowngradedUrl('https://meritbeauty.com/products/bronze-balm', 'Bronze Balm')).toBe(false);
    expect(isDowngradedUrl('')).toBe(false);
    expect(isDowngradedUrl(null)).toBe(false);
    // A hyphenated word that merely ends in a region code must not trip it.
    expect(isDowngradedUrl('https://x.com/products/mascara-deuxieme', 'Mascara')).toBe(false);
  });

  test('a marker carried by the title is describing the product, not degrading it', () => {
    // All four observed on prod 2026-08-05 as false positives of the naive form.
    expect(isDowngradedUrl(
      'https://iliabeauty.com/products/barrier-build-skin-protectant-cream-sample',
      'Barrier Build Skin Protectant Cream - Sample',
    )).toBe(false);
    expect(isDowngradedUrl(
      'https://saiehello.com/products/bestsellers-bundle',
      'Bestsellers Bundle',
    )).toBe(false);
    expect(isDowngradedUrl(
      'https://meritbeauty.com/products/pre-seeding-lip-liner-ext-eu',
      '[Pre-Seeding] Lip Liner Ext (EU)',
    )).toBe(false);
    // `free-` is gone entirely: "shimmer-free" is a product descriptor.
    expect(isDowngradedUrl(
      'https://tower28beauty.com/products/superdew-shimmer-free-highlighter',
      'SuperDew Highlighter',
    )).toBe(false);

    // But the same marker with no title support still flags.
    expect(isDowngradedUrl('https://x.com/products/thing-sample', 'Thing')).toBe(true);
  });

  test('the guard reads the title when judging a downgrade', () => {
    // Sample product: survivor URL says "sample", so does the title -> allowed.
    expect(blockReasonFor(safeRow({
      title: 'Multi-Stick - Sample',
      canonical_title: 'Multi-Stick - Sample',
      canonical_url: 'https://iliabeauty.com/products/multi-stick',
      canonical_canonical_url: 'https://iliabeauty.com/products/multi-stick-sample-card',
    }))).toBeNull();

    // Same URL shape, but nothing in the title supports it -> blocked.
    expect(blockReasonFor(safeRow({
      title: 'Multi-Stick',
      canonical_title: 'Multi-Stick',
      canonical_url: 'https://iliabeauty.com/products/multi-stick',
      canonical_canonical_url: 'https://iliabeauty.com/products/multi-stick-sample-card',
    }))).toBe('survivor_url_downgraded');
  });

  test('blocks when the survivor URL is regional and the stranded one is clean', () => {
    // The exact prod shape: .../bronze-balm archived, .../bronze-balm-eu survived.
    expect(blockReasonFor(safeRow({
      canonical_url: 'https://meritbeauty.com/products/bronze-balm',
      canonical_canonical_url: 'https://meritbeauty.com/products/bronze-balm-eu',
    }))).toBe('survivor_url_downgraded');
  });

  test('blocks when the survivor URL is a promo page and the stranded one is the PDP', () => {
    // Tower 28 MakeWaves: survivor pointed at a gift-with-purchase page.
    expect(blockReasonFor(safeRow({
      canonical_url: 'https://tower28beauty.com/products/makewaves-mascara',
      canonical_canonical_url: 'https://tower28beauty.com/products/makewaves-mascara-gift-with-purchase',
    }))).toBe('survivor_url_downgraded');
  });

  test('allows the correct direction — stranded regional, survivor clean', () => {
    expect(blockReasonFor(safeRow({
      canonical_url: 'https://iliabeauty.com/products/barrier-build-uk',
      canonical_canonical_url: 'https://iliabeauty.com/products/barrier-build',
    }))).toBeNull();
  });

  test('allows when both URLs are equally downgraded', () => {
    expect(blockReasonFor(safeRow({
      canonical_url: 'https://x.com/products/a-eu',
      canonical_canonical_url: 'https://x.com/products/b-uk',
    }))).toBeNull();
  });

  test('blocks a missing survivor URL only for non-first-party survivors', () => {
    // External survivor with no URL: the stranded row was the only one with a
    // destination, so archiving it loses the link.
    expect(blockReasonFor(safeRow({
      canonical_key: 'ext:some-external-row::abc',
      canonical_url: 'https://x.com/products/thing',
      canonical_canonical_url: null,
    }))).toBe('survivor_url_missing');

    // First-party merchant rows transact through the merchant integration and
    // legitimately store no external URL — these 50 prod rows were fine.
    expect(blockReasonFor(safeRow({
      canonical_key: 'prod::merch_efbc46b4619cfbdf::shopify::10064572776745',
      canonical_url: 'https://jwx893-fz.myshopify.com/products/moyu-5560894018009',
      canonical_canonical_url: null,
    }))).toBeNull();
  });

  test('does not fire when the stranded row has no URL to lose', () => {
    expect(blockReasonFor(safeRow({
      canonical_url: null,
      canonical_canonical_url: null,
      canonical_key: 'ext:whatever::abc',
    }))).toBeNull();
  });
});

describe('cohort SQL', () => {
  test('selects only live external_referral rows with no active seed back-pointer', () => {
    expect(COHORT_SQL).toContain(`cp.catalog_track = 'external_referral'`);
    expect(COHORT_SQL).toContain(`cp.sync_status = 'live'`);
    expect(COHORT_SQL).toContain('NOT EXISTS');
    expect(COHORT_SQL).toContain('a.attached_product_key = cp.product_key');
    // The seed must itself be active and re-pointed somewhere else.
    expect(COHORT_SQL).toContain(`eps.status = 'active'`);
    expect(COHORT_SQL).toContain(`coalesce(eps.attached_product_key, '') NOT IN ('', cp.product_key)`);
  });

  test('domain and limit filters are parameterized, not interpolated', async () => {
    db.query.mockClear();
    await fetchCohort({ domain: 'Example.COM', limit: 25 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(params).toEqual(['example.com', 25]);
  });

  test('inactive seeds are excluded unless explicitly opted in', () => {
    expect(buildCohortSql()).toContain(`eps.status = 'active'`);
    expect(buildCohortSql({ includeInactiveSeeds: false })).toContain(`eps.status = 'active'`);
    // Opt-in drops only the seed-status filter; the re-pointed and
    // no-active-backpointer conditions still hold.
    const opened = buildCohortSql({ includeInactiveSeeds: true });
    expect(opened).not.toContain(`eps.status = 'active'`);
    expect(opened).toContain(`coalesce(eps.attached_product_key, '') NOT IN ('', cp.product_key)`);
    expect(opened).toContain('NOT EXISTS');
  });

  test('--product-key narrows the cohort but is not a guard bypass', async () => {
    db.query.mockClear();
    await fetchCohort({ productKeys: ['k1', 'k2'] });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('cp.product_key = ANY($1::text[])');
    expect(params).toEqual([['k1', 'k2']]);
    // Guards live in blockReasonFor, which run() applies to every fetched row
    // regardless of how the cohort was narrowed.
    expect(blockReasonFor(safeRow({ canonical_content_key: 'other' }))).toBe('content_key_mismatch');
  });
});

describe('archiveBatch', () => {
  beforeEach(() => db.query.mockClear());

  test('re-asserts the cohort predicate so stale rows are skipped, and never touches the index', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 2 });
    const landed = await archiveBatch(['k1', 'k2']);
    expect(landed).toBe(2);

    const [sql] = db.query.mock.calls[0];
    expect(sql).toContain(`SET sync_status = 'archived'`);
    // Guards repeated inside the UPDATE, not trusted from the SELECT.
    expect(sql).toContain(`cp.sync_status = 'live'`);
    expect(sql).toContain(`cp.catalog_track = 'external_referral'`);
    expect(sql).toContain('NOT EXISTS');
    // index_pipeline_state is keyed on the SHARED content_key and belongs to
    // the surviving canonical row — touching it would de-index the survivor.
    expect(sql).not.toMatch(/index_pipeline_state/i);
    expect(sql).not.toMatch(/serving_eligible/i);
  });

  test('writes nothing when the batch is empty', async () => {
    await expect(archiveBatch([])).resolves.toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('write confirm gate', () => {
  beforeEach(() => {
    db.query.mockClear();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  test('write intent without the exact token throws before any db access', async () => {
    await expect(run({ write: true, batchSize: 10 })).rejects.toThrow(
      `Refusing write without --confirm ${CONFIRM_TOKEN}`,
    );
    await expect(run({ write: true, confirm: 'nope', batchSize: 10 })).rejects.toThrow(/Refusing write/);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('assertWriteConfirmed is the shared gate', () => {
    expect(() => assertWriteConfirmed({ write: true })).toThrow(/Refusing write/);
    expect(() => assertWriteConfirmed({ write: true, confirm: CONFIRM_TOKEN })).not.toThrow();
    expect(() => assertWriteConfirmed({ write: false })).not.toThrow();
  });
});

describe('run() partitioning', () => {
  test('dry-run reports eligible vs blocked and issues no UPDATE', async () => {
    db.query.mockReset();
    db.query.mockResolvedValueOnce({
      rows: [
        safeRow({ product_key: 'k_ok' }),
        safeRow({ product_key: 'k_bad_ck', canonical_content_key: 'ck_other' }),
        safeRow({ product_key: 'k_dead_canon', canonical_sync_status: 'archived' }),
      ],
    });

    const result = await run({ write: false, batchSize: 10 });
    expect(result.counters).toEqual({
      cohort_rows: 3,
      eligible_rows: 1,
      blocked_rows: 2,
      archived_rows: 0,
    });
    expect(result.by_block_reason).toEqual({ content_key_mismatch: 1, canonical_not_live: 1 });
    expect(result.sample[0].product_key).toBe('k_ok');
    for (const [sql] of db.query.mock.calls) {
      expect(sql).not.toContain('UPDATE catalog_products');
    }
  });

  test('write mode archives only eligible rows, in batches', async () => {
    db.query.mockReset();
    db.query.mockResolvedValueOnce({
      rows: [
        safeRow({ product_key: 'k1' }),
        safeRow({ product_key: 'k2' }),
        safeRow({ product_key: 'k3', canonical_title: 'Different' }),
      ],
    });
    db.query.mockResolvedValue({ rowCount: 1 });

    const result = await run({ write: true, confirm: CONFIRM_TOKEN, batchSize: 1 });
    expect(result.counters.eligible_rows).toBe(2);
    expect(result.counters.blocked_rows).toBe(1);
    // batchSize 1 -> two separate UPDATE calls, each landing 1
    expect(result.counters.archived_rows).toBe(2);

    const updateCalls = db.query.mock.calls.filter(([sql]) => sql.includes('UPDATE catalog_products'));
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0][1]).toEqual([['k1']]);
    expect(updateCalls[1][1]).toEqual([['k2']]);
  });
});
