// Main-list freeze for scripts/force-fill-sig-pdp-content.cjs: every decision about the main
// list (seed_data.variants) reads the main list only, only a list that changed is written
// back, it is written as full entries, and the main list is never fabricated. Runs the real
// buildPlan -> applyPlans with a stub client and replays the captured UPDATE on the stored row.
const { buildPlan, applyPlans } = require('../../scripts/force-fill-sig-pdp-content.cjs');
const { buildExternalSeedProduct } = require('../../src/services/externalSeedProducts');

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

function buildRow(seedData, { complete = true, title = 'Glow Tint 30 ml', url = URL_BASE } = {}) {
  return {
    external_product_id: EPID,
    pivota_signature_id: 'sig_freeze',
    title,
    canonical_url: url,
    destination_url: url,
    seed_data: {
      title,
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

  describe('no snapshot information reaches main-list or root data', () => {
    const NEUTRAL = { title: 'Glow Tint', url: 'https://shop.example.com/products/glow-tint' };
    const ROOT_LABEL_KEYS = ['variant_detail_label', 'size_detail_label', 'net_size', 'shade_detail_label', 'format_detail_label'];
    const mirrorPayloads = (client) =>
      client.calls
        .filter((call) => /catalog_products|pdp_identity_listing/.test(call.sql))
        .map((call) => JSON.parse(call.params[1]));

    test('one-entry main list is not relabelled from snapshot evidence (controller case 1)', async () => {
      const row = buildRow(
        {
          variants: [{ variant_id: 'v1', title: 'Default Title', price: '30.00', availability: 'out_of_stock', in_stock: false }],
          snapshot: { variants: [{ variant_id: 'v1', title: '50 ml' }] },
        },
        NEUTRAL,
      );

      const { before, plan, after, client } = await runPlan(row);

      expect(plan.variant_lists_changed.root).toBe(false);
      expect(JSON.stringify(after.variants)).toBe(JSON.stringify(before.variants));
      for (const key of ROOT_LABEL_KEYS) expect(hasOwn(after, key)).toBe(false);
      expect(after.snapshot.variants[0].options).toEqual([expect.objectContaining({ value: '50 mL' })]);
      for (const payload of mirrorPayloads(client)) {
        expect(hasOwn(payload, 'variants')).toBe(false);
        for (const key of ROOT_LABEL_KEYS) expect(hasOwn(payload, key)).toBe(false);
      }
    });

    test('snapshot-only collapse writes no root labels, quality or mirror labels (controller case 2)', async () => {
      const row = buildRow(
        {
          variants: [
            { variant_id: 'A1', title: 'A1', price: '10.00' },
            { variant_id: 'B1', title: 'B1', price: '12.00' },
          ],
          snapshot: {
            size_detail_label: '15 ml',
            variants: [
              { variant_id: 'A1', title: 'Default Title' },
              { variant_id: 'B1', title: 'Default Title' },
            ],
          },
        },
        NEUTRAL,
      );

      const { before, plan, after, client, path, rootPatch } = await runPlan(row);

      expect(plan.root_variant_collapse_skipped).toBe(true);
      expect(path).toBe('variant_only');
      expect(rootPatch).toEqual({});
      expect(JSON.stringify(after.variants)).toBe(JSON.stringify(before.variants));
      for (const key of ROOT_LABEL_KEYS) expect(hasOwn(after, key)).toBe(false);
      expect(hasOwn(after, 'pdp_field_quality_summary')).toBe(false);
      expect(hasOwn(after, 'pdp_force_fill_v1')).toBe(false);
      expect(after.snapshot.size_detail_label).toBe('15 mL');
      expect(after.snapshot.variants).toHaveLength(1);
      expect(mirrorPayloads(client)).toEqual([]);
    });

    test('controller case 2 on the full-write path: no root labels persisted', async () => {
      const row = buildRow(
        {
          variants: [
            { variant_id: 'A1', title: 'A1', price: '10.00' },
            { variant_id: 'B1', title: 'B1', price: '12.00' },
          ],
          snapshot: {
            size_detail_label: '15 ml',
            variants: [
              { variant_id: 'A1', title: 'Default Title' },
              { variant_id: 'B1', title: 'Default Title' },
            ],
          },
        },
        { ...NEUTRAL, complete: false },
      );

      const { before, after, path, client } = await runPlan(row, new Set());

      expect(path).toBe('full');
      expect(JSON.stringify(after.variants)).toBe(JSON.stringify(before.variants));
      for (const key of ROOT_LABEL_KEYS) expect(hasOwn(after, key)).toBe(false);
      expect(after.snapshot.size_detail_label).toBe('15 mL');
      for (const payload of mirrorPayloads(client)) {
        for (const key of ROOT_LABEL_KEYS) expect(hasOwn(payload, key)).toBe(false);
      }
    });

    test('an existing root quality summary is not cross-merged from the snapshot on the full-write path', async () => {
      const row = buildRow(
        {
          pdp_field_quality_summary: { ingredients_raw: { source_quality_status: 'high' } },
          variants: repairedMainList(),
          snapshot: {
            pdp_field_quality_summary: { variants: { source_quality_status: 'snapshot_only' } },
            variants: staleDefaultSnapshotList(),
          },
        },
        { complete: false },
      );

      const { after, path } = await runPlan(row, new Set());

      expect(path).toBe('full');
      expect(after.pdp_field_quality_summary.how_to_use_raw).toBeTruthy();
      expect(hasOwn(asObjectOrEmpty(after.pdp_field_quality_summary), 'variants')).toBe(false);
    });
  });

  describe('display-gate fallback: never create a root quality summary', () => {
    // PDP readers take the FIRST summary object (root, then snapshot) without merging. A new root
    // summary would hide the snapshot's blocked statuses and surface a gated field.
    const GATED = 'Gated description that the snapshot quality summary blocks.';
    const gatedRow = (variants) => ({
      ...buildRow(
        {
          pdp_description_raw: GATED,
          ...(variants ? { variants } : {}),
          snapshot: {
            pdp_description_raw: GATED,
            pdp_field_quality_summary: { description_raw: { source_quality_status: 'blocked' } },
            ...(variants ? { variants: clone(variants) } : {}),
          },
        },
        { complete: false, title: 'Glow Tint', url: 'https://shop.example.com/products/glow-tint' },
      ),
      id: 'eps_display_gate',
      market: 'US',
    });

    test('a force-filled how-to on a row with no root summary keeps pdp_description_raw gated', async () => {
      const row = gatedRow();
      expect(buildExternalSeedProduct(row).pdp_description_raw).toBeUndefined();

      const { after, path } = await runPlan(row, new Set());

      expect(path).toBe('full');
      expect(buildExternalSeedProduct({ ...row, seed_data: after }).pdp_description_raw).toBeUndefined();
      expect(hasOwn(after, 'pdp_field_quality_summary')).toBe(false);
      expect(after.snapshot.pdp_field_quality_summary.description_raw.source_quality_status).toBe('blocked');
      expect(after.snapshot.pdp_field_quality_summary.how_to_use_raw).toBeTruthy();
    });

    test('a root-side variant change on a row with no root summary keeps it gated (variant-only path)', async () => {
      const flatMain = repairedMainList().map((variant) => {
        const { options, ...rest } = variant;
        return { ...rest, option_name: 'Shade', option_value: variant.title };
      });
      const row = gatedRow(flatMain);
      row.seed_data.pdp_how_to_use_raw = 'Apply to lips.';
      row.seed_data.pdp_ingredients_raw = 'Water, Glycerin.';
      row.seed_data.snapshot.variants = repairedMainList();

      const { after, path, plan } = await runPlan(row);

      expect(path).toBe('variant_only');
      expect(plan.variant_lists_changed).toEqual({ root: true, snapshot: false });
      expect(buildExternalSeedProduct({ ...row, seed_data: after }).pdp_description_raw).toBeUndefined();
      expect(hasOwn(after, 'pdp_field_quality_summary')).toBe(false);
      expect(after.snapshot.pdp_field_quality_summary.variants).toBeTruthy();
    });

    test('an existing root summary is still extended', async () => {
      const row = gatedRow();
      row.seed_data.pdp_field_quality_summary = { description_raw: { source_quality_status: 'blocked' } };

      const { after } = await runPlan(row, new Set());

      expect(after.pdp_field_quality_summary.how_to_use_raw).toBeTruthy();
      expect(after.pdp_field_quality_summary.description_raw.source_quality_status).toBe('blocked');
      expect(buildExternalSeedProduct({ ...row, seed_data: after }).pdp_description_raw).toBeUndefined();
    });

    test('H8: root force-fill meta is not taken from the snapshot meta', async () => {
      const row = gatedRow();
      row.seed_data.snapshot.pdp_force_fill_v1 = { fields: { snapshot_only_field: { source: 'snapshot' } } };

      const { after } = await runPlan(row, new Set());

      expect(hasOwn(after.pdp_force_fill_v1.fields, 'snapshot_only_field')).toBe(false);
      expect(hasOwn(after.snapshot.pdp_force_fill_v1.fields, 'snapshot_only_field')).toBe(true);
    });
  });

  describe('test gaps', () => {
    test('G2: both lists empty on the full-write path: the main list is not fabricated', async () => {
      const row = buildRow({ snapshot: {} }, { complete: false });

      const { after, path } = await runPlan(row, new Set());

      expect(path).toBe('full');
      expect(hasOwn(after, 'variants')).toBe(false);
      expect(after.snapshot.variants).toHaveLength(1);
      for (const key of ['variant_detail_label', 'size_detail_label', 'net_size']) expect(hasOwn(after, key)).toBe(false);
    });

    test('G7: hydrating the main list is persisted (root flag set) with every other field kept', async () => {
      const flatMain = repairedMainList().map((variant) => {
        const { options, ...rest } = variant;
        return { ...rest, option_name: 'Shade', option_value: variant.title };
      });
      const row = buildRow({ variants: flatMain, snapshot: { variants: repairedMainList() } });

      const { plan, after } = await runPlan(row);

      expect(plan.variant_lists_changed).toEqual({ root: true, snapshot: false });
      expect(after.variants).toHaveLength(2);
      after.variants.forEach((variant, index) => {
        expect(variant).toEqual(expect.objectContaining({
          ...flatMain[index],
          option_name: 'Shade',
          options: [expect.objectContaining({ name: 'Shade', value: flatMain[index].option_value })],
        }));
      });
    });

    test('G4: a plan without list flags writes neither variant list', async () => {
      const row = buildRow({ variants: repairedMainList(), snapshot: { variants: staleDefaultSnapshotList() } });
      const plan = await buildPlan(row, kbWithIntel(), { fetchSource: false });
      delete plan.variant_lists_changed;
      const client = makeClient();

      await applyPlans(client, [plan]);

      const { rootPatch, snapshotPatch } = replaySeedUpdate(clone(row.seed_data), client);
      expect(rootPatch).toEqual({});
      expect(snapshotPatch).toEqual({});
    });
  });
});

function asObjectOrEmpty(value) {
  return value && typeof value === 'object' ? value : {};
}
