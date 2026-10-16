// Main-list freeze: production serves seed_data.variants (the main list). No persisting
// path of the catalog backfill may write it from snapshot-derived data, and a failed
// extraction must not drop it. Every test runs the real processRow with the DB stubbed at
// the boundary and asserts on the captured UPDATE / INSERT payload.
jest.mock('../../src/db', () => {
  const actual = jest.requireActual('../../src/db');
  return {
    ...actual,
    query: jest.fn(),
    withClient: jest.fn(),
  };
});

const axios = require('axios');
const { query, withClient } = require('../../src/db');
const { processRow } = require('../../scripts/backfill-external-product-seeds-catalog');

const TARGET_URL = 'https://shop.example.com/products/freeze-serum';
const IMG_A = 'https://cdn.example.com/files/freeze-serum-30ml.jpg';
const IMG_B = 'https://cdn.example.com/files/freeze-serum-50ml.jpg';
const SVG_ICON = 'https://cdn.example.com/files/swatch-icon.svg';

const clone = (value) => JSON.parse(JSON.stringify(value));

// Refreshed main list (nightly refresh reconciles price/stock here).
const refreshedMainList = () => [
  {
    variant_id: '111',
    sku: 'FS-30',
    title: '30 ml',
    option_name: 'Size',
    option_value: '30 ml',
    url: `${TARGET_URL}?variant=111`,
    price: '30.00',
    currency: 'USD',
    availability: 'out_of_stock',
    in_stock: false,
    inventory_quantity: 0,
    image_url: IMG_A,
  },
];

// Stale snapshot copy: old price, still in stock, plus a variant the main list no longer has.
const staleSnapshotList = () => [
  {
    variant_id: '111',
    sku: 'FS-30',
    title: '30 ml',
    option_name: 'Size',
    option_value: '30 ml',
    url: `${TARGET_URL}?variant=111`,
    price: '25.00',
    currency: 'USD',
    availability: 'in_stock',
    in_stock: true,
    inventory_quantity: 12,
    image_url: IMG_A,
  },
  {
    variant_id: '222',
    sku: 'FS-50',
    title: '50 ml',
    option_name: 'Size',
    option_value: '50 ml',
    url: `${TARGET_URL}?variant=222`,
    price: '40.00',
    currency: 'USD',
    availability: 'in_stock',
    in_stock: true,
    inventory_quantity: 4,
    image_url: IMG_B,
  },
];

function buildRow(seedData) {
  return {
    id: 'eps_freeze_main_list',
    external_product_id: 'ext_freeze_main_list',
    market: 'US',
    tool: '*',
    domain: 'shop.example.com',
    title: 'Freeze Serum',
    canonical_url: TARGET_URL,
    destination_url: TARGET_URL,
    image_url: IMG_A,
    price_amount: 30,
    price_currency: 'USD',
    availability: 'out_of_stock',
    status: 'active',
    seed_data: {
      brand: 'Freeze',
      title: 'Freeze Serum',
      ...seedData,
    },
  };
}

function mockExtraction(variants) {
  return jest.spyOn(axios, 'post').mockResolvedValue({
    data: {
      products: [
        {
          title: 'Freeze Serum',
          url: TARGET_URL,
          image_url: IMG_A,
          image_urls: [IMG_A],
          description: 'A refreshed serum description for the freeze test.',
          variants,
        },
      ],
      variants: [],
      diagnostics: {},
    },
  });
}

const RUN_OPTIONS = {
  dryRun: false,
  baseUrl: 'https://catalog.test',
  validateImageHealth: false,
  expandVariants: false,
  includeCommerceFacts: false,
  skipInsights: true,
  targetUrlOverrides: {},
};

let clientQuery;

function capturedSeedUpdates() {
  const calls = [...query.mock.calls, ...clientQuery.mock.calls];
  return calls
    .filter((call) => /UPDATE external_product_seeds/.test(String(call[0])) && /seed_data\s*=/.test(String(call[0])))
    .map((call) => {
      const params = call[1];
      const jsonParam = [...params].reverse().find((value) => typeof value === 'string' && value.startsWith('{'));
      return JSON.parse(jsonParam);
    });
}

function capturedChildInserts() {
  return clientQuery.mock.calls
    .filter((call) => /INSERT INTO external_product_seeds/.test(String(call[0])))
    .map((call) => ({ id: call[1][0], seed_data: JSON.parse(call[1][16]) }));
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

beforeEach(() => {
  jest.restoreAllMocks();
  query.mockReset();
  withClient.mockReset();
  clientQuery = jest.fn(async () => ({ rows: [], rowCount: 0 }));
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  withClient.mockImplementation(async (fn) => fn({ query: clientQuery }));
  // Never reach a merchant page or CDN from a test.
  jest.spyOn(axios, 'get').mockRejectedValue(Object.assign(new Error('network disabled in test'), { code: 'ENETDOWN' }));
  jest.spyOn(axios, 'head').mockResolvedValue({ status: 200, headers: { 'content-type': 'image/jpeg' } });
});

describe('processRow main write (fix 1): main list only from a fresh extraction', () => {
  test('no fresh variants: the stored main list is persisted exactly as stored', async () => {
    const row = buildRow({ variants: refreshedMainList(), snapshot: { variants: staleSnapshotList() } });
    const before = clone(row.seed_data);
    mockExtraction([]);

    const result = await processRow(row, RUN_OPTIONS);

    expect(result.status).toBe('updated');
    const [persisted] = capturedSeedUpdates();
    expect(persisted).toBeTruthy();
    expect(JSON.stringify(persisted.variants)).toBe(JSON.stringify(before.variants));
  });

  test('no fresh variants and no stored main list: the persisted row still has no main list', async () => {
    const row = buildRow({ snapshot: { variants: staleSnapshotList() } });
    mockExtraction([]);

    const result = await processRow(row, RUN_OPTIONS);

    expect(result.status).toBe('updated');
    const [persisted] = capturedSeedUpdates();
    expect(persisted).toBeTruthy();
    expect(hasOwn(persisted, 'variants')).toBe(false);
    expect(persisted.snapshot.variants.length).toBeGreaterThan(0);
  });

  test('preserveCommerce: the stored main list is persisted exactly as stored', async () => {
    const row = buildRow({ variants: refreshedMainList(), snapshot: { variants: staleSnapshotList() } });
    const before = clone(row.seed_data);
    mockExtraction([
      { id: '111', sku: 'FS-30', url: `${TARGET_URL}?variant=111`, option_name: 'Size', option_value: '30 ml', price: '31.00', currency: 'USD', stock: 'In Stock' },
    ]);

    await processRow(row, { ...RUN_OPTIONS, preserveCommerce: true });

    const [persisted] = capturedSeedUpdates();
    expect(persisted).toBeTruthy();
    expect(JSON.stringify(persisted.variants)).toBe(JSON.stringify(before.variants));
  });

  test('fresh variants: the main list is written from the extraction, not from the snapshot', async () => {
    const row = buildRow({ variants: refreshedMainList(), snapshot: { variants: staleSnapshotList() } });
    mockExtraction([
      { id: '111', sku: 'FS-30', url: `${TARGET_URL}?variant=111`, option_name: 'Size', option_value: '30 ml', price: '33.00', currency: 'USD', stock: 'Out of Stock' },
    ]);

    await processRow(row, RUN_OPTIONS);

    const [persisted] = capturedSeedUpdates();
    expect(persisted.variants).toHaveLength(1);
    expect(Number(persisted.variants[0].price)).toBe(33);
  });
});

describe('applySanitizedNestedVariantImages (fix 2): each list sanitized on its own entries', () => {
  test('persist path: main list keeps its entries, ids, prices and stock; only the unsafe image goes', async () => {
    const main = refreshedMainList();
    main[0].image_urls = [IMG_A, SVG_ICON];
    const row = buildRow({ variants: main, snapshot: { variants: staleSnapshotList() } });
    const before = clone(row.seed_data);
    mockExtraction([]);

    await processRow(row, { ...RUN_OPTIONS, validateImageHealth: true });

    const [persisted] = capturedSeedUpdates();
    expect(persisted).toBeTruthy();
    const expectedMain = clone(before.variants);
    expectedMain[0].image_urls = [IMG_A];
    expect(JSON.stringify(persisted.variants)).toBe(JSON.stringify(expectedMain));
  });

  test('preserved-image-health path (empty catalog): main list is not rebuilt from the snapshot', async () => {
    const main = refreshedMainList();
    main[0].image_urls = [IMG_A, SVG_ICON];
    const row = buildRow({
      image_urls: [IMG_A],
      variants: main,
      snapshot: { image_urls: [IMG_A], variants: staleSnapshotList() },
    });
    const before = clone(row.seed_data);
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { products: [], variants: [], diagnostics: {} } });

    const result = await processRow(row, { ...RUN_OPTIONS, validateImageHealth: true });

    expect(result.status).toBe('updated');
    const [persisted] = capturedSeedUpdates();
    const expectedMain = clone(before.variants);
    expectedMain[0].image_urls = [IMG_A];
    expect(JSON.stringify(persisted.variants)).toBe(JSON.stringify(expectedMain));
    // The snapshot list keeps its own (stale) entries, not the main list's.
    expect(persisted.snapshot.variants.map((variant) => variant.price)).toEqual(['25.00', '40.00']);
  });

  test('a main list absent before sanitization stays absent', async () => {
    const snapshotVariants = staleSnapshotList();
    snapshotVariants[0].image_urls = [IMG_A, SVG_ICON];
    const row = buildRow({
      image_urls: [IMG_A],
      snapshot: { image_urls: [IMG_A], variants: snapshotVariants },
    });
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { products: [], variants: [], diagnostics: {} } });

    await processRow(row, { ...RUN_OPTIONS, validateImageHealth: true });

    const [persisted] = capturedSeedUpdates();
    expect(persisted).toBeTruthy();
    expect(hasOwn(persisted, 'variants')).toBe(false);
    expect(persisted.snapshot.variants[0].image_urls).toEqual([IMG_A]);
  });
});

describe('buildVariantSeedRows (fix 3): child main list only from the parent main list', () => {
  test('child with a matching parent main entry gets that entry; child without one gets no main list', async () => {
    const row = buildRow({ variants: refreshedMainList(), snapshot: { variants: staleSnapshotList() } });
    const parentMain = clone(row.seed_data.variants);
    mockExtraction([]);

    await processRow(row, { ...RUN_OPTIONS, expandVariants: true });

    const children = capturedChildInserts();
    expect(children).toHaveLength(2);
    const byVariant = Object.fromEntries(children.map((child) => [child.seed_data.selected_variant_id, child.seed_data]));
    // 111 exists in the parent's main list: the child's main entry carries the main-list price/stock.
    expect(byVariant['111'].variants).toHaveLength(1);
    expect(byVariant['111'].variants[0]).toEqual(expect.objectContaining({
      ...parentMain[0],
      variant_id: '111',
      id: '111',
    }));
    // 222 exists only in the stale snapshot: no main list at all.
    expect(hasOwn(byVariant['222'], 'variants')).toBe(false);
    expect(byVariant['222'].snapshot.variants[0].variant_id).toBe('222');
  });
});

describe('buildMinimalFailureSeedData (fix 4): a failed extraction keeps the stored main list', () => {
  const failOnFirstSeedWrite = () => {
    let seedWrites = 0;
    query.mockImplementation(async (sql) => {
      if (/UPDATE external_product_seeds/.test(String(sql))) {
        seedWrites += 1;
        if (seedWrites === 1) throw Object.assign(new Error('invalid byte sequence'), { code: '22021' });
      }
      return { rows: [], rowCount: 0 };
    });
  };

  test('the minimal fallback write carries seed_data.variants through unchanged', async () => {
    const row = buildRow({ variants: refreshedMainList(), snapshot: { variants: staleSnapshotList() } });
    const before = clone(row.seed_data);
    jest.spyOn(axios, 'post').mockRejectedValue(Object.assign(new Error('extract failed'), { response: { status: 503 } }));
    failOnFirstSeedWrite();

    const result = await processRow(row, RUN_OPTIONS);

    expect(result.status).toBe('failed');
    const writes = capturedSeedUpdates();
    expect(writes).toHaveLength(2);
    const minimal = writes[1];
    expect(minimal.snapshot.diagnostics).toBeTruthy();
    expect(JSON.stringify(minimal.variants)).toBe(JSON.stringify(before.variants));
    // The first (full) failure candidate also keeps the main list.
    expect(JSON.stringify(writes[0].variants)).toBe(JSON.stringify(before.variants));
  });

  test('the minimal fallback write does not create a main list when none was stored', async () => {
    const row = buildRow({ snapshot: { variants: staleSnapshotList() } });
    jest.spyOn(axios, 'post').mockRejectedValue(Object.assign(new Error('extract failed'), { response: { status: 503 } }));
    failOnFirstSeedWrite();

    await processRow(row, RUN_OPTIONS);

    const writes = capturedSeedUpdates();
    expect(writes).toHaveLength(2);
    expect(hasOwn(writes[1], 'variants')).toBe(false);
  });
});
