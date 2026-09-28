'use strict';

// CANONICAL_CATALOG_SERVED_PRICE_AS_OF: the served offer's price_checked_at rides the row the best-offer
// LATERAL already selected. Pinned under prod's hot-path flags (candidate-key prefilter + single payload
// read): still ONE query, and OFF names no column prod does not have yet.
// tests/integration/canonical_served_price_as_of_postgres.test.js runs the same SQL on PostgreSQL.

const {
  fetchCanonicalChainRows,
  isServedPriceAsOfEnabled,
} = require('../src/services/canonicalCatalogSearch');

const FLAGS = [
  'CANONICAL_CATALOG_SERVED_PRICE_AS_OF',
  'CANONICAL_CATALOG_SINGLE_PAYLOAD_READ',
  'CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER',
];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
  process.env.CANONICAL_CATALOG_SINGLE_PAYLOAD_READ = 'on';
  process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = 'on';
  delete process.env.CANONICAL_CATALOG_SERVED_PRICE_AS_OF;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

async function capture(includeSkuOffers) {
  const calls = [];
  await fetchCanonicalChainRows({
    query: 'toner',
    categoryPathPrefix: 'beauty/skincare/tone/',
    categoryMode: 'category_browse',
    tokenMatch: true,
    limit: 200,
    marketId: 'US',
    markets: ['US'],
    includeSkuOffers,
    deps: { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } },
  });
  expect(calls).toHaveLength(1);
  return calls[0].sql;
}

const count = (sql, needle) => sql.split(needle).length - 1;

test('the flag is off unless set', () => {
  expect(isServedPriceAsOfEnabled({})).toBe(false);
  expect(isServedPriceAsOfEnabled({ CANONICAL_CATALOG_SERVED_PRICE_AS_OF: 'off' })).toBe(false);
  expect(isServedPriceAsOfEnabled({ CANONICAL_CATALOG_SERVED_PRICE_AS_OF: 'on' })).toBe(true);
});

test.each([true, false])('OFF names no price_checked_at anywhere (sku offers: %s)', async (includeSkuOffers) => {
  const sql = await capture(includeSkuOffers);
  expect(sql).not.toContain('price_checked_at');
  // The single payload read is still what prod runs.
  expect(sql).toContain('jsonb_path_query_first(p.product_payload');
});

test.each([true, false])('ON reads it off the served offer row, once, in the same query (sku offers: %s)', async (includeSkuOffers) => {
  process.env.CANONICAL_CATALOG_SERVED_PRICE_AS_OF = 'on';
  const sql = await capture(includeSkuOffers);
  expect(count(sql, 'o.price_checked_at')).toBe(1);
  expect(count(sql, 'served.price_checked_at')).toBe(1);
  // Inside the best-offer LATERAL, next to the price it dates -- not from the product or payload.
  const lateral = sql.slice(sql.indexOf('LEFT JOIN LATERAL ('), sql.indexOf(') listing_offer ON TRUE'));
  expect(lateral).toContain('o.price_checked_at');
  expect(lateral).toContain('COALESCE(o.merchant_effective_price, o.list_price) AS served_price');
  expect(sql).not.toMatch(/\bupdated_at\s+AS\s+price_/i);
});

test('both branches carry the served offer\'s own price_confidence', async () => {
  for (const includeSkuOffers of [true, false]) {
    const sql = await capture(includeSkuOffers);
    expect(sql).not.toMatch(/NULL::text\s+AS price_confidence/);
    expect(sql).toMatch(/served\.price_confidence/);
    const lateral = sql.slice(sql.indexOf('LEFT JOIN LATERAL ('), sql.indexOf(') listing_offer ON TRUE'));
    expect(lateral).toContain('o.price_confidence');
  }
});

describe('armed without the column', () => {
  const { __internal: { servedPriceAsOfState, isMissingPriceCheckedAtColumn } } = require('../src/services/canonicalCatalogSearch');
  afterEach(() => { servedPriceAsOfState.unavailableUntil = 0; });

  const run = (fail) => {
    const calls = [];
    const done = fetchCanonicalChainRows({
      query: 'toner', categoryPathPrefix: 'beauty/skincare/tone/', categoryMode: 'category_browse',
      tokenMatch: true, limit: 200, marketId: 'US', markets: ['US'], includeSkuOffers: true,
      deps: { query: async (sql) => { calls.push(sql); const err = fail(sql, calls.length); if (err) throw err; return { rows: [] }; } },
    });
    return { calls, done };
  };
  const pgError = (code, message) => Object.assign(new Error(message), { code });

  test('only undefined_column about price_checked_at is the missing column', () => {
    expect(isMissingPriceCheckedAtColumn(pgError('42703', 'column o.price_checked_at does not exist'))).toBe(true);
    expect(isMissingPriceCheckedAtColumn(pgError('42703', 'column o.market does not exist'))).toBe(false);
    expect(isMissingPriceCheckedAtColumn(pgError('57014', 'price_checked_at canceling statement'))).toBe(false);
    expect(isMissingPriceCheckedAtColumn(null)).toBe(false);
  });

  test('the missing column retries once without it, then stays off', async () => {
    process.env.CANONICAL_CATALOG_SERVED_PRICE_AS_OF = 'on';
    const first = run((sql) => (sql.includes('price_checked_at') ? pgError('42703', 'column o.price_checked_at does not exist') : null));
    await first.done;
    expect(first.calls).toHaveLength(2);
    expect(first.calls[1]).not.toContain('price_checked_at');
    const second = run(() => null);
    await second.done;
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]).not.toContain('price_checked_at');
    // and comes back once the latch expires
    servedPriceAsOfState.unavailableUntil = Date.now() - 1;
    const third = run(() => null);
    await third.done;
    expect(third.calls[0]).toContain('price_checked_at');
  });

  test('any other failure is NOT retried: it propagates exactly as before', async () => {
    process.env.CANONICAL_CATALOG_SERVED_PRICE_AS_OF = 'on';
    const other = run(() => pgError('42703', 'column o.market does not exist'));
    await expect(other.done).rejects.toThrow('o.market');
    expect(other.calls).toHaveLength(1);
    const timeout = run(() => pgError('57014', 'canceling statement due to statement timeout'));
    await expect(timeout.done).rejects.toThrow('statement timeout');
    expect(timeout.calls).toHaveLength(1);
    expect(servedPriceAsOfState.unavailableUntil).toBe(0);
  });
});
