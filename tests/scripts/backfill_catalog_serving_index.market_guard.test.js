// Flag CATALOG_SERVING_INDEX_NO_DEFAULT_MARKET_ENABLED on: the backfill script passes an absent --market through
// (so the backfill refuses it by name) instead of silently scoping the run to a default market.
jest.mock('../../src/db', () => ({ query: jest.fn(), closePool: jest.fn(async () => {}) }));
jest.mock('../../src/services/catalogServingIndex', () => ({
  backfillCatalogServingIndex: jest.fn(async () => ({ source: 'dry_run', document_memberships: [] })),
  getCatalogServingIndexConfig: jest.fn(() => ({ enabled: false })),
}));

const { backfillCatalogServingIndex } = require('../../src/services/catalogServingIndex');
const { main } = require('../../scripts/backfill-catalog-serving-index');

const FLAG = 'CATALOG_SERVING_INDEX_NO_DEFAULT_MARKET_ENABLED';
const SEED_MARKET_ENV = 'DEFAULT_DISCOVERY_EXTERNAL_SEED_MARKET';

describe('backfill script market guard', () => {
  const saved = { argv: process.argv, flag: process.env[FLAG], seed: process.env[SEED_MARKET_ENV] };
  let write;
  beforeEach(() => {
    backfillCatalogServingIndex.mockClear();
    write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    delete process.env[SEED_MARKET_ENV];
  });
  afterEach(() => {
    write.mockRestore();
    process.argv = saved.argv;
    for (const [key, value] of [[FLAG, saved.flag], [SEED_MARKET_ENV, saved.seed]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  test.each([
    [undefined, [], 'US'],
    [undefined, ['--market', 'SG'], 'SG'],
    ['true', [], undefined],
    ['true', ['--market', 'SG'], 'SG'],
    ['true', ['--market', '*'], '*'],
  ])('flag %s, args %j -> market %s', async (flag, args, expected) => {
    if (flag === undefined) delete process.env[FLAG]; else process.env[FLAG] = flag;
    process.argv = ['node', 'backfill', '--dry-run', ...args];
    await main();
    const [options] = backfillCatalogServingIndex.mock.calls[0];
    expect(options.market).toBe(expected);
    expect(Object.keys(options)).toEqual(['limit', 'brand', 'market', 'dryRun', 'refresh', 'includeNonPublic']);
  });
});
