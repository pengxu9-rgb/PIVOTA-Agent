function hasRuntimeDeps() {
  for (const dep of ['dotenv', 'express', 'axios']) {
    try {
      require.resolve(dep);
    } catch {
      return false;
    }
  }
  return true;
}

const describeIfRuntimeDeps = hasRuntimeDeps() ? describe : describe.skip;

describeIfRuntimeDeps('PDP similar first-paint budget', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('returns a deferred similar envelope when the recommendation promise exceeds budget', async () => {
    jest.resetModules();
    const app = require('../../src/server');
    const startedAt = Date.now();

    const envelope = await app._debug.resolvePdpSimilarWithBudget(
      new Promise(() => {}),
      20,
    );

    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(envelope).toEqual(
      expect.objectContaining({
        status: 'deferred',
        strategy: 'related_products',
        reason_code: 'SIMILAR_DEFERRED_FIRST_PAINT',
        items: [],
        metadata: expect.objectContaining({
          similar_status: 'deferred',
          reason_code: 'SIMILAR_DEFERRED_FIRST_PAINT',
          sync_budget_ms: 20,
        }),
      }),
    );
  });
});
