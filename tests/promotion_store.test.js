describe('promotionStore remote cache', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      PROMOTIONS_MODE: 'remote',
      PROMOTIONS_BACKEND_BASE_URL: 'https://promo-backend.test',
      PROMOTIONS_ADMIN_KEY: 'promo_admin_test_key',
      PROMO_REMOTE_CACHE_TTL_MS: '30000',
      PROMO_REMOTE_STALE_WHILE_REVALIDATE: 'true',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
    jest.resetModules();
  });

  test('caches empty remote promotion snapshots within ttl', async () => {
    const axiosMock = jest.fn().mockResolvedValue({ data: { promotions: [] } });
    jest.doMock('axios', () => axiosMock);

    const { getAllPromotions } = require('../src/promotionStore');

    await expect(getAllPromotions()).resolves.toEqual([]);
    await expect(getAllPromotions()).resolves.toEqual([]);

    expect(axiosMock).toHaveBeenCalledTimes(1);
  });

  test('serves stale empty snapshot while revalidating after ttl expiry', async () => {
    jest.useFakeTimers();
    const axiosMock = jest
      .fn()
      .mockResolvedValueOnce({ data: { promotions: [] } })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ data: { promotions: [] } }), 1000);
          }),
      );
    jest.doMock('axios', () => axiosMock);

    const { getAllPromotions } = require('../src/promotionStore');

    await expect(getAllPromotions()).resolves.toEqual([]);
    jest.advanceTimersByTime(30001);

    const stalePromise = getAllPromotions();
    await expect(stalePromise).resolves.toEqual([]);
    expect(axiosMock).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    jest.useRealTimers();
  });
});
