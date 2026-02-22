const SNAPSHOT_PATH = '../src/auroraBff/competitorSnapshotStore';

describe('aurora competitor snapshot store', () => {
  const prevEnv = {
    AURORA_COMP_SNAPSHOT_SOFT_TTL_MS: process.env.AURORA_COMP_SNAPSHOT_SOFT_TTL_MS,
    AURORA_COMP_SNAPSHOT_HARD_TTL_MS: process.env.AURORA_COMP_SNAPSHOT_HARD_TTL_MS,
    AURORA_COMP_BACKFILL_COOLDOWN_MS: process.env.AURORA_COMP_BACKFILL_COOLDOWN_MS,
  };

  afterEach(() => {
    jest.resetModules();
    if (prevEnv.AURORA_COMP_SNAPSHOT_SOFT_TTL_MS === undefined) {
      delete process.env.AURORA_COMP_SNAPSHOT_SOFT_TTL_MS;
    } else {
      process.env.AURORA_COMP_SNAPSHOT_SOFT_TTL_MS = prevEnv.AURORA_COMP_SNAPSHOT_SOFT_TTL_MS;
    }
    if (prevEnv.AURORA_COMP_SNAPSHOT_HARD_TTL_MS === undefined) {
      delete process.env.AURORA_COMP_SNAPSHOT_HARD_TTL_MS;
    } else {
      process.env.AURORA_COMP_SNAPSHOT_HARD_TTL_MS = prevEnv.AURORA_COMP_SNAPSHOT_HARD_TTL_MS;
    }
    if (prevEnv.AURORA_COMP_BACKFILL_COOLDOWN_MS === undefined) {
      delete process.env.AURORA_COMP_BACKFILL_COOLDOWN_MS;
    } else {
      process.env.AURORA_COMP_BACKFILL_COOLDOWN_MS = prevEnv.AURORA_COMP_BACKFILL_COOLDOWN_MS;
    }
  });

  test('buildSnapshotKey is stable for canonicalized URL/query inputs', () => {
    const store = require(SNAPSHOT_PATH);
    const keyA = store.buildSnapshotKey({
      product_url: 'https://example.com/p?id=1&utm_source=ads&utm_medium=cpc',
      locale: 'EN',
      objective: 'competitors',
      category: 'serum',
    });
    const keyB = store.buildSnapshotKey({
      product_url: 'https://example.com/p?id=1&utm_medium=cpc&utm_source=ads',
      locale: 'en',
      objective: 'competitors',
      category: 'serum',
    });
    expect(keyA).toBeTruthy();
    expect(keyA).toBe(keyB);
  });

  test('readSnapshot reports stale and very_stale according to configured TTL', () => {
    process.env.AURORA_COMP_SNAPSHOT_SOFT_TTL_MS = '259200000';
    process.env.AURORA_COMP_SNAPSHOT_HARD_TTL_MS = '1209600000';
    jest.resetModules();
    const store = require(SNAPSHOT_PATH);
    store.__internal.resetForTest();

    const key = store.buildSnapshotKey({
      anchor_product_id: 'sku_1',
      locale: 'EN',
      objective: 'competitors',
      category: 'serum',
    });

    store.writeSnapshot(
      key,
      { competitors: [{ product_id: 'c1', brand: 'B', name: 'Comp One' }] },
      { created_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(), source: 'test' },
    );

    const staleRead = store.readSnapshot(key);
    expect(staleRead.hit).toBe(true);
    expect(staleRead.stale).toBe(true);
    expect(staleRead.very_stale).toBe(false);

    store.__internal.resetForTest();
    store.writeSnapshot(
      key,
      { competitors: [{ product_id: 'c2', brand: 'B', name: 'Comp Two' }] },
      { created_at: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString(), source: 'test' },
    );

    const veryStaleRead = store.readSnapshot(key);
    expect(veryStaleRead.hit).toBe(true);
    expect(veryStaleRead.stale).toBe(true);
    expect(veryStaleRead.very_stale).toBe(true);
  });

  test('cooldown prevents duplicate async backfill enqueue for same key', () => {
    process.env.AURORA_COMP_BACKFILL_COOLDOWN_MS = '120000';
    jest.resetModules();
    const store = require(SNAPSHOT_PATH);
    store.__internal.resetForTest();

    const key = store.buildSnapshotKey({
      anchor_product_id: 'sku_2',
      locale: 'EN',
      objective: 'competitors',
      category: 'serum',
    });

    const nowMs = Date.now();
    expect(store.canEnqueueBackfill(key, { nowMs })).toBe(true);
    const untilMs = store.markBackfillCooldown(key, { nowMs });
    expect(untilMs).toBeGreaterThan(nowMs);
    expect(store.canEnqueueBackfill(key, { nowMs: nowMs + 1000 })).toBe(false);
    expect(store.canEnqueueBackfill(key, { nowMs: untilMs + 1 })).toBe(true);
  });

  test('writeSnapshot keeps better existing record when incoming snapshot is older/weaker', () => {
    const store = require(SNAPSHOT_PATH);
    store.__internal.resetForTest();

    const key = store.buildSnapshotKey({
      anchor_product_id: 'sku_3',
      locale: 'EN',
      objective: 'competitors',
      category: 'serum',
    });

    const nowIso = new Date().toISOString();
    const first = store.writeSnapshot(
      key,
      {
        competitors: [
          { product_id: 'a1', brand: 'X', name: 'Alpha 1' },
          { product_id: 'a2', brand: 'Y', name: 'Alpha 2' },
          { product_id: 'a3', brand: 'Z', name: 'Alpha 3' },
        ],
      },
      { created_at: nowIso, source: 'seed', coverage: 3, confidence: 0.8 },
    );
    expect(first.ok).toBe(true);
    expect(first.written).toBe(true);

    const olderIso = new Date(Date.now() - 60_000).toISOString();
    const second = store.writeSnapshot(
      key,
      { competitors: [{ product_id: 'b1', brand: 'X', name: 'Beta 1' }] },
      { created_at: olderIso, source: 'seed', coverage: 1, confidence: 0.2 },
    );
    expect(second.ok).toBe(true);
    expect(second.written).toBe(false);
    expect(second.reason).toBe('cas_not_better');

    const read = store.readSnapshot(key);
    expect(read.hit).toBe(true);
    expect(Array.isArray(read.payload.competitors)).toBe(true);
    expect(read.payload.competitors).toHaveLength(3);
  });
});
