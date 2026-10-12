const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildCatalogAffectedRow,
  buildExternalSeedAffectedRow,
  parseArgs,
  run,
} = require('../../scripts/select-relationship-graph-affected-products');

const NOW = new Date('2026-06-08T00:00:00.000Z');

describe('select-relationship-graph-affected-products', () => {
  test('parseArgs computes updated-since from select-hours', () => {
    const options = parseArgs([
      '--select-hours',
      '24',
      '--sources',
      'catalog,external_seed',
      '--select-limit',
      '50',
    ], { now: NOW });

    expect(options.updatedSince).toBe('2026-06-07T00:00:00.000Z');
    expect(options.sources).toEqual(['catalog_products', 'external_product_seeds']);
    expect(options.limit).toBe(50);
  });

  test('normalizes catalog rows into graph affected refs', () => {
    const row = buildCatalogAffectedRow({
      product_key: 'prod_1',
      source_product_id: 'shopify_1',
      pivota_signature_id: 'sig_1',
      content_key: 'ck_1',
      merchant_id: 'm_1',
      platform: 'shopify',
      brand: 'Brand',
      title: 'Serum',
      canonical_url: 'https://brand.example/products/serum',
    }, 'US');

    expect(row).toEqual(expect.objectContaining({
      source: 'catalog_products',
      product_ref: 'product:sig_1',
      product_key: 'prod_1',
      source_product_id: 'shopify_1',
      merchant_id: 'm_1',
      domain: 'brand.example',
    }));
    expect(row.product_refs).toEqual(expect.arrayContaining([
      'product:sig_1',
      'prod_1',
      'shopify_1',
      'product:shopify_1',
      'ck_1',
    ]));
  });

  test('normalizes external seed rows into graph affected refs', () => {
    const row = buildExternalSeedAffectedRow({
      external_product_id: 'ext_1',
      attached_product_key: 'prod_ext_1',
      market: 'US',
      title: 'Cleanser',
      canonical_url: 'https://brand.example/products/cleanser',
    }, 'US');

    expect(row).toEqual(expect.objectContaining({
      source: 'external_product_seeds',
      product_ref: 'product:ext_1',
      external_product_id: 'ext_1',
      source_product_id: 'ext_1',
      product_key: 'prod_ext_1',
    }));
    expect(row.product_refs).toEqual(expect.arrayContaining(['product:ext_1', 'ext_1', 'prod_ext_1']));
  });

  test('run writes a manifest from catalog and seed sources', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-selector-'));
    const out = path.join(outDir, 'affected-products.json');
    const queryFn = jest.fn(async (sql) => {
      if (sql.includes('FROM catalog_products cp') && !sql.includes('external_product_seeds')) {
        return {
          rows: [{
            product_key: 'prod_1',
            source_product_id: 'shopify_1',
            pivota_signature_id: 'sig_1',
            content_key: 'ck_1',
            merchant_id: 'm_1',
            platform: 'shopify',
            brand: 'Brand',
            title: 'Serum',
            canonical_url: 'https://brand.example/products/serum',
            updated_at: '2026-06-07T10:00:00.000Z',
          }],
        };
      }
      return {
        rows: [{
          external_product_id: 'ext_1',
          attached_product_key: 'prod_ext_1',
          market: 'US',
          title: 'Cleanser',
          canonical_url: 'https://brand.example/products/cleanser',
          updated_at: '2026-06-07T11:00:00.000Z',
        }],
      };
    });

    const manifest = await run([
      '--updated-since',
      '2026-06-07T00:00:00Z',
      '--out',
      out,
    ], { queryFn, now: NOW });

    expect(manifest.affected_count).toBe(2);
    expect(manifest.selection.source_counts).toEqual({
      catalog_products: 1,
      external_product_seeds: 1,
    });
    expect(manifest.affected_refs).toEqual(expect.arrayContaining([
      'product:sig_1',
      'product:ext_1',
    ]));
    expect(fs.existsSync(out)).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  test('the uncovered backfill adds never-labelled products FIRST, whenever they changed, and rotates by cooldown', async () => {
    const recencyRow = { product_key: 'prod_recent', source_product_id: 'shopify_r', pivota_signature_id: 'sig_r', merchant_id: 'm', platform: 'shopify', title: 'Serum' };
    const backfillRows = [
      { product_key: 'prod_old_1', source_product_id: 'ext_old_1', pivota_signature_id: 'sig_old_1', merchant_id: 'external_seed', platform: 'external_seed', title: 'Toner' },
      // Also in the recency window: kept once, as a recency row.
      { ...recencyRow },
    ];
    const queryFn = jest.fn(async (sql) => {
      if (sql.includes('relationship_graph_anchor_attempts')) return { rows: backfillRows };
      if (sql.includes('FROM catalog_products cp') && !sql.includes('external_product_seeds')) return { rows: [recencyRow] };
      return { rows: [] };
    });
    const manifest = await run(['--updated-since', '2026-06-07T00:00:00Z', '--uncovered-backfill-limit', '2', '--uncovered-cooldown-days', '5'], { queryFn, now: NOW });
    expect(manifest.rows.map((row) => [row.source, row.product_key])).toEqual([
      ['uncovered_backfill', 'prod_old_1'],
      ['catalog_products', 'prod_recent'],
    ]);
    expect(manifest.selection.uncovered_backfill_limit).toBe(2);
    expect(manifest.affected_refs).toEqual(expect.arrayContaining(['product:sig_old_1']));
    const [sql, params] = queryFn.mock.calls.find(([text]) => text.includes('relationship_graph_anchor_attempts'));
    expect(params[0]).toBe(2);
    expect(params[2]).toBe('US');
    // Never labelled on its signature or source ref; renderable now; not attempted within the cooldown;
    // no recency predicate; a catalog-wide hash order.
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM relationship_candidate_labels/);
    expect(sql).toContain("interval '5 days'");
    expect(sql).toContain('pdp_will_render IS TRUE');
    expect(sql).not.toMatch(/updated_at >= \$/);
    expect(sql).toContain('ORDER BY md5(cp.product_key)');
  });

  test('without --uncovered-backfill-limit no backfill query runs', async () => {
    const queryFn = jest.fn(async () => ({ rows: [] }));
    await run(['--updated-since', '2026-06-07T00:00:00Z', '--allow-empty-selection'], { queryFn, now: NOW });
    expect(queryFn.mock.calls.some(([sql]) => sql.includes('relationship_graph_anchor_attempts'))).toBe(false);
  });

  test('run fails closed on empty selection unless allow-empty-selection is set', async () => {
    const queryFn = jest.fn(async () => ({ rows: [] }));

    await expect(run([
      '--updated-since',
      '2026-06-07T00:00:00Z',
    ], { queryFn, now: NOW })).rejects.toThrow(/no_affected_products_selected/);

    const manifest = await run([
      '--updated-since',
      '2026-06-07T00:00:00Z',
      '--allow-empty-selection',
    ], { queryFn, now: NOW });

    expect(manifest.affected_count).toBe(0);
  });
});
