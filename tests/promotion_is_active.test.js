// Pins isPromoActive behavior — gate 1 of findApplicablePromotionsForProduct.
// Regression target: a null/missing endAt previously yielded `new Date(null).getTime()
// === 0`, which silently filtered out every open-ended promo (FREESHIP, COMBO_B,
// PIVOTA_AUDIT_*). See PIVOTA-Agent #1397.

describe('isPromoActive', () => {
  let isPromoActive;
  let prevEnv;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    prevEnv = {
      ADMIN_API_KEY: process.env.ADMIN_API_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
    };
    process.env.ADMIN_API_KEY = 'admin_test_key';
    process.env.DATABASE_URL = 'postgres://test';
    const server = require('../src/server');
    isPromoActive = server._debug.isPromoActive;
  });

  afterAll(() => {
    jest.resetModules();
    if (prevEnv.ADMIN_API_KEY === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevEnv.ADMIN_API_KEY;
    if (prevEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevEnv.DATABASE_URL;
  });

  const NOW = Date.parse('2026-05-18T00:00:00Z');

  test('returns true for fully-bounded active window', () => {
    expect(
      isPromoActive(
        { startAt: '2026-01-01T00:00:00Z', endAt: '2099-01-01T00:00:00Z' },
        NOW,
      ),
    ).toBe(true);
  });

  test('returns false before startAt', () => {
    expect(
      isPromoActive(
        { startAt: '2099-01-01T00:00:00Z', endAt: '2099-12-31T00:00:00Z' },
        NOW,
      ),
    ).toBe(false);
  });

  test('returns false after endAt', () => {
    expect(
      isPromoActive(
        { startAt: '2020-01-01T00:00:00Z', endAt: '2020-12-31T00:00:00Z' },
        NOW,
      ),
    ).toBe(false);
  });

  // --- The regression cases that #1397 surfaced ---

  test('returns true when endAt is null (open-ended promo)', () => {
    expect(
      isPromoActive(
        { startAt: '2026-01-01T00:00:00Z', endAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  test('returns true when endAt is undefined / missing', () => {
    expect(
      isPromoActive({ startAt: '2026-01-01T00:00:00Z' }, NOW),
    ).toBe(true);
  });

  test('returns true when both startAt and endAt are null (open both ends)', () => {
    expect(isPromoActive({ startAt: null, endAt: null }, NOW)).toBe(true);
  });

  test('returns true when startAt is null but endAt is in the future', () => {
    expect(
      isPromoActive({ startAt: null, endAt: '2099-12-31T00:00:00Z' }, NOW),
    ).toBe(true);
  });

  // --- Deletion gates ---

  test('returns false when deletedAt is set (camelCase)', () => {
    expect(
      isPromoActive(
        { startAt: '2026-01-01T00:00:00Z', endAt: null, deletedAt: '2026-04-01T00:00:00Z' },
        NOW,
      ),
    ).toBe(false);
  });

  test('returns false when deleted_at is set (snake_case fallback)', () => {
    expect(
      isPromoActive(
        { startAt: '2026-01-01T00:00:00Z', endAt: null, deleted_at: '2026-04-01T00:00:00Z' },
        NOW,
      ),
    ).toBe(false);
  });

  // --- Safety guards ---

  test('returns false for null/undefined promo', () => {
    expect(isPromoActive(null, NOW)).toBe(false);
    expect(isPromoActive(undefined, NOW)).toBe(false);
  });

  test('invalid date strings are ignored (treated as no bound)', () => {
    // An invalid endAt shouldn't reject an otherwise-active promo. The bug
    // path would be NaN comparisons returning false; the guard converts
    // invalid bounds to "no constraint" rather than blocking.
    expect(
      isPromoActive(
        { startAt: '2026-01-01T00:00:00Z', endAt: 'not-a-date' },
        NOW,
      ),
    ).toBe(true);
  });

  test('matches the FREESHIP fixture from #1397 (startAt past, endAt null, not deleted)', () => {
    expect(
      isPromoActive(
        {
          id: 'shopify_discount_merch_efbc46b4619cfbdf_80587dcfcbc5b4b310c1467a',
          name: 'PIVOTA_TEST_FREESHIP',
          startAt: '2026-04-19T22:12:00.000Z',
          endAt: null,
          deletedAt: null,
        },
        NOW,
      ),
    ).toBe(true);
  });
});
