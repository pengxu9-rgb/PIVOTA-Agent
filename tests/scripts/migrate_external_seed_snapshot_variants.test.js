jest.mock('../../src/db', () => ({
  withClient: jest.fn(),
  query: jest.fn(),
}));

const { migrateSeedDataSnapshotVariants } = require('../../scripts/migrate-external-seed-snapshot-variants.cjs');
const {
  canonicalizeExternalSeedSnapshot,
  canonicalizeExternalSeedSnapshotForPersistence,
} = require('../../src/services/externalSeedProducts');

const refreshedMainList = () => [
  {
    id: 'SKU-1',
    sku: 'SKU-1',
    option_name: 'Size',
    option_value: '30ml',
    price: '30.00',
    currency: 'USD',
    availability: 'out_of_stock',
    in_stock: false,
  },
];
const staleSnapshotList = () => [
  {
    id: 'SKU-1',
    sku: 'SKU-1',
    option_name: 'Size',
    option_value: '30ml',
    price: '25.00',
    currency: 'USD',
    availability: 'in_stock',
    in_stock: true,
  },
];

describe('migrate-external-seed-snapshot-variants persisting transform', () => {
  test.each([[false], [true]])('keeps the stored main list exactly as stored (stripLegacy=%s)', (stripLegacy) => {
    const seedData = {
      variants: refreshedMainList(),
      product: { title: 'P', variants: refreshedMainList() },
      snapshot: { variants: staleSnapshotList() },
    };
    const before = JSON.parse(JSON.stringify(seedData));

    const out = migrateSeedDataSnapshotVariants(seedData, { id: 'eps_migrate_1' }, { stripLegacy });

    expect(JSON.stringify(out.variants)).toBe(JSON.stringify(before.variants));
    expect(JSON.stringify(out.product.variants)).toBe(JSON.stringify(before.product.variants));
    expect(out.snapshot.variants[0].price).toBe(25);
    expect(out.snapshot.variants[0].options).toEqual([
      expect.objectContaining({ name: 'Size', value: '30 mL' }),
    ]);
    expect(seedData).toEqual(before);
  });

  test('never creates a main list from the snapshot when none was stored', () => {
    const seedData = {
      product: { title: 'P' },
      snapshot: { variants: staleSnapshotList() },
    };

    const out = migrateSeedDataSnapshotVariants(seedData, { id: 'eps_migrate_2' }, { stripLegacy: false });

    expect(Object.prototype.hasOwnProperty.call(out, 'variants')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out.product, 'variants')).toBe(false);
    expect(out.snapshot.variants).toHaveLength(1);
  });

  test('still fills an empty snapshot copy from the main list (main -> snapshot only)', () => {
    const seedData = { variants: refreshedMainList(), snapshot: {} };

    const out = migrateSeedDataSnapshotVariants(seedData, { id: 'eps_migrate_3' }, { stripLegacy: true });

    expect(JSON.stringify(out.variants)).toBe(JSON.stringify(refreshedMainList()));
    expect(out.snapshot.variants).toHaveLength(1);
    expect(out.snapshot.variants[0].price).toBe(30);
  });

  test('accepts seed_data stored as a JSON string', () => {
    const stored = { variants: refreshedMainList(), snapshot: { variants: staleSnapshotList() } };

    const out = canonicalizeExternalSeedSnapshotForPersistence(JSON.stringify(stored), { id: 'eps_migrate_4' });

    expect(JSON.stringify(out.variants)).toBe(JSON.stringify(stored.variants));
  });

  test('the in-memory display canonicalizer is unchanged (still syncs every container)', () => {
    const seedData = { variants: refreshedMainList(), snapshot: { variants: staleSnapshotList() } };

    const out = canonicalizeExternalSeedSnapshot(seedData, { id: 'eps_migrate_5' }, { stripLegacy: false });

    expect(out.variants[0].price).toBe(25);
    expect(JSON.stringify(out.variants)).toBe(JSON.stringify(out.snapshot.variants));
  });
});
