const { createPdpCorePrewarmRuntime } = require('../src/pdpCorePrewarmRuntime');

describe('pdpCorePrewarmRuntime', () => {
  test('reports unavailable snapshot when aurora prefetch snapshot is not exported', () => {
    const runtime = createPdpCorePrewarmRuntime({
      runPdpCorePrewarmPassBase: jest.fn(),
    });

    expect(runtime.snapshotPdpV2CoreHotCacheStats()).toEqual({
      available: false,
      reason: 'aurora_bff_prefetch_snapshot_not_exported',
    });
  });

  test('returns snapshot payload when getter succeeds', () => {
    const runtime = createPdpCorePrewarmRuntime({
      getAuroraPdpPrefetchStateSnapshot: jest.fn(() => ({
        runtime: { totals: { total: 2 } },
      })),
      runPdpCorePrewarmPassBase: jest.fn(),
    });

    expect(runtime.snapshotPdpV2CoreHotCacheStats()).toEqual({
      available: true,
      runtime: { totals: { total: 2 } },
    });
  });

  test('run wrapper delegates to base prewarm pass with configured runtime', async () => {
    const runPdpCorePrewarmPassBase = jest.fn(async () => ({ ok: true }));
    const axiosClient = { get: jest.fn() };
    const logger = { info: jest.fn() };
    const runtime = createPdpCorePrewarmRuntime({
      getAuroraPdpPrefetchStateSnapshot: jest.fn(),
      runPdpCorePrewarmPassBase,
      targets: [{ merchant_id: 'm1', product_id: 'p1' }],
      gatewayUrl: 'https://gateway.test',
      port: 3010,
      timeoutMs: 4000,
      intervalMs: 60000,
      axiosClient,
      logger,
    });

    await expect(runtime.runPdpCorePrewarmPass()).resolves.toEqual({ ok: true });
    expect(runPdpCorePrewarmPassBase).toHaveBeenCalledWith({
      targets: [{ merchant_id: 'm1', product_id: 'p1' }],
      gatewayUrl: 'https://gateway.test',
      port: 3010,
      timeoutMs: 4000,
      intervalMs: 60000,
      axios: axiosClient,
      logger,
    });
  });
});
