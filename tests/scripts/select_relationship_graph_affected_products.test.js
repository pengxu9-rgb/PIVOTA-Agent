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
