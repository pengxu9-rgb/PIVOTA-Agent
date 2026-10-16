// Main-list freeze for scripts/force-fill-sig-pdp-content.cjs: every decision about the main
// list (seed_data.variants) reads the main list only, only a list that changed is written
// back, it is written as full entries, and the main list is never fabricated. Runs the real
// buildPlan -> applyPlans with a stub client and replays the captured UPDATE on the stored row.
const { buildPlan, applyPlans } = require('../../scripts/force-fill-sig-pdp-content.cjs');

const EPID = 'ext_freeze_force_fill';
const URL_BASE = 'https://shop.example.com/products/glow-tint-30ml';
const clone = (value) => JSON.parse(JSON.stringify(value));
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

// The repaired main list: two shade variants with options, price, stock, url and images.
const repairedMainList = () => [
  {
    variant_id: 'v-rose',
    sku: 'GT-ROSE',
    title: 'Rose',
    options: [{ name: 'Shade', value: 'Rose', axis_kind: 'shade' }],
    price: '24.00',
    currency: 'USD',
    in_stock: false,
    availability: 'out_of_stock',
    inventory_quantity: 0,
    url: `${URL_BASE}?variant=1`,
    deep_link: `${URL_BASE}?variant=1`,
    image_urls: ['https://cdn.example.com/rose.jpg'],
    refreshed_at: '2026-10-15T02:00:00.000Z',
  },
  {
    variant_id: 'v-coral',
    sku: 'GT-CORAL',
    title: 'Coral',
    options: [{ name: 'Shade', value: 'Coral', axis_kind: 'shade' }],
    price: '24.00',
    currency: 'USD',
    in_stock: true,
    availability: 'in_stock',
    inventory_quantity: 7,
    url: `${URL_BASE}?variant=2`,
    deep_link: `${URL_BASE}?variant=2`,
    image_urls: ['https://cdn.example.com/coral.jpg'],
    refreshed_at: '2026-10-15T02:00:00.000Z',
  },
];

// The stale snapshot: two "Default Title" entries with no displayable options.
const staleDefaultSnapshotList = () => [
  { variant_id: 'v-rose', title: 'Default Title', option_name: 'Title', option_value: 'Default Title', price: '20.00' },
  { variant_id: 'v-coral', title: 'Default Title', option_name: 'Title', option_value: 'Default Title', price: '20.00' },
];

function buildRow(seedData, { complete = true } = {}) {
  return {
    external_product_id: EPID,
    pivota_signature_id: 'sig_freeze',
    title: 'Glow Tint 30 ml',
    canonical_url: URL_BASE,
    destination_url: URL_BASE,
    seed_data: {
      title: 'Glow Tint 30 ml',
      ...(complete
        ? { pdp_how_to_use_raw: 'Apply to lips.', pdp_ingredients_raw: 'Water, Glycerin.' }
        : {}),
      ...seedData,
    },
  };
}

const kbWithIntel = () => new Set([`product:${EPID}`]);

function makeClient() {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows: [], rowCount: 1 };
    }),
  };
}

// Replays the captured seed UPDATE against the stored seed_data, mirroring the SQL:
// variant-only path: jsonb_set(seed_data || $2, '{snapshot}', snapshot || $3)
// full path: seed_data = $2
function replaySeedUpdate(storedSeedData, client) {
  const update = client.calls.find((call) => /UPDATE external_product_seeds/.test(call.sql));
  if (!update) return { after: storedSeedData, path: 'none' };
  if (/jsonb_set/.test(update.sql)) {
    const rootPatch = JSON.parse(update.params[1]);
    const snapshotPatch = JSON.parse(update.params[2]);
    const after = { ...clone(storedSeedData), ...rootPatch };
    after.snapshot = { ...clone(storedSeedData.snapshot || {}), ...snapshotPatch };
    return { after, path: 'variant_only', rootPatch, snapshotPatch };
  }
  return { after: JSON.parse(update.params[1]), path: 'full' };
}

async function runPlan(row, kbKeys = kbWithIntel()) {
  const before = clone(row.seed_data);
  const plan = await buildPlan(row, kbKeys, { fetchSource: false });
  const client = makeClient();
  await applyPlans(client, [plan]);
  return { before, plan, client, ...replaySeedUpdate(before, client) };
}

describe('force-fill main-list freeze', () => {
  test("controller's case: repaired 2-shade main list next to a stale 2x Default Title snapshot is untouched", async () => {
    const row = buildRow({ variants: repairedMainList(), snapshot: { variants: staleDefaultSnapshotList() } });

    const { before, plan, after, path, rootPatch } = await runPlan(row);

    expect(plan.changed).toBe(true);
    expect(path).toBe('variant_only');
    expect(hasOwn(rootPatch, 'variants')).toBe(false);
    expect(JSON.stringify(after.variants)).toBe(JSON.stringify(before.variants));
    // The snapshot copy alone is collapsed.
    expect(after.snapshot.variants).toHaveLength(1);
    expect(after.snapshot.variants[0].variant_id).toBe(`${EPID}:single`);
  });

  test("controller's case on the full-write path keeps the main list too", async () => {
    const row = buildRow(
      { variants: repairedMainList(), snapshot: { variants: staleDefaultSnapshotList() } },
      { complete: false },
    );

    const { before, after, path } = await runPlan(row, new Set());

    expect(path).toBe('full');
    expect(JSON.stringify(after.variants)).toBe(JSON.stringify(before.variants));
  });

  test('a snapshot-only change does not rewrite main entries (no field stripping)', async () => {
    const snapshotVariants = [
      { variant_id: 'v-rose', title: 'Rose', option_name: 'Color', option_value: 'Rose' },
      { variant_id: 'v-coral', title: 'Coral', option_name: 'Color', option_value: 'Coral' },
    ];
    const row = buildRow({ variants: repairedMainList(), snapshot: { variants: snapshotVariants } });

    const { before, plan, after, path, rootPatch, client } = await runPlan(row);

    expect(plan.variant_lists_changed).toEqual({ root: false, snapshot: true });
    expect(path).toBe('variant_only');
    expect(hasOwn(rootPatch, 'variants')).toBe(false);
    expect(JSON.stringify(after.variants)).toBe(JSON.stringify(before.variants));
    // Serving mirrors get no variants either when the main list did not change.
    const mirrorUpdates = client.calls.filter((call) => /catalog_products|pdp_identity_listing/.test(call.sql));
    for (const call of mirrorUpdates) expect(hasOwn(JSON.parse(call.params[1]), 'variants')).toBe(false);
  });

  test('a single-entry decision on the snapshot does not patch a displayable main entry', async () => {
    const main = [repairedMainList()[0]];
    const row = buildRow({
      variants: main,
      snapshot: { variants: [{ variant_id: 'v-rose', title: 'Default Title', price: '20.00' }] },
    });

    const { before, after } = await runPlan(row);

    expect(JSON.stringify(after.variants)).toBe(JSON.stringify(before.variants));
    expect(after.snapshot.variants[0].options).toEqual([expect.objectContaining({ value: '30 mL' })]);
  });

  test('a locale-axis decision on the snapshot does not patch the main entry', async () => {
    const main = [repairedMainList()[0]];
    const row = buildRow({
      variants: main,
      snapshot: { variants: [{ variant_id: 'v-rose', title: 'US', option_name: 'Color', option_value: 'US', image_url: 'https://cdn.example.com/rose.jpg' }] },
    });
    row.title = 'Glow Tint Mini';
    row.seed_data.title = 'Glow Tint Mini';

    const { before, after, plan } = await runPlan(row);

    expect(plan.variant_lists_changed.snapshot).toBe(true);
    expect(JSON.stringify(after.variants)).toBe(JSON.stringify(before.variants));
    expect(after.snapshot.variants[0].option_value).not.toBe('US');
  });

  test("the main list's own single-entry decision patches options and keeps every other field", async () => {
    const mainEntry = {
      variant_id: 'v-only',
      title: 'Default Title',
      price: '24.00',
      in_stock: true,
      inventory_quantity: 3,
      url: `${URL_BASE}?variant=9`,
      image_urls: ['https://cdn.example.com/only.jpg'],
      refreshed_at: '2026-10-15T02:00:00.000Z',
    };
    const row = buildRow({ variants: [mainEntry], snapshot: { variants: [clone(mainEntry)] } });

    const { after } = await runPlan(row);

    expect(after.variants).toHaveLength(1);
    expect(after.variants[0]).toEqual(expect.objectContaining({
      price: '24.00',
      in_stock: true,
      inventory_quantity: 3,
      url: `${URL_BASE}?variant=9`,
      image_urls: ['https://cdn.example.com/only.jpg'],
      refreshed_at: '2026-10-15T02:00:00.000Z',
      options: [expect.objectContaining({ name: 'Size', value: '30 mL' })],
    }));
  });

  test.each([
    ['absent', {}],
    ['empty', { variants: [] }],
  ])('no variants anywhere: the main list is never fabricated (%s stays %s)', async (_label, mainShape) => {
    const row = buildRow({ ...mainShape, snapshot: {} });

    const { before, after, plan } = await runPlan(row);

    expect(plan.changed).toBe(true);
    expect(hasOwn(after, 'variants')).toBe(hasOwn(before, 'variants'));
    if (hasOwn(before, 'variants')) expect(after.variants).toEqual([]);
    expect(after.snapshot.variants).toHaveLength(1);
    expect(after.snapshot.variants[0].force_filled).toBe(true);
  });
});
