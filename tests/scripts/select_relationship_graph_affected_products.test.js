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

  test('the uncovered backfill selects with the build\'s coverage predicate, whenever products changed (review of #2418)', async () => {
    const recencyRow = { product_key: 'prod_recent', source_product_id: 'shopify_r', pivota_signature_id: 'sig_r', merchant_id: 'm', platform: 'shopify', title: 'Serum' };
    const backfillRows = [
      { product_key: 'prod_old_1', source_product_id: 'ext_old_1', pivota_signature_id: 'sig_old_1', merchant_id: 'external_seed', platform: 'external_seed', title: 'Toner', relgraph_priority: 3 },
      // Also in the recency window: kept once, as a recency row.
      { ...recencyRow, relgraph_priority: 3 },
    ];
    const queryFn = jest.fn(async (sql) => {
      if (sql.includes('schema_access')) return { rows: [{ has_schema_usage: true, table_name: 'relationship_graph_anchor_attempts', can_insert: true, can_select: true, can_update: true }] };
      if (sql.includes('backfill_window')) return { rows: backfillRows };
      // The recency catalog query (the seed query reads FROM external_product_seeds eps).
      if (sql.includes('FROM catalog_products cp') && sql.includes('cp.updated_at >= $1') && !sql.includes('FROM external_product_seeds eps')) return { rows: [recencyRow] };
      return { rows: [] };
    });
    const manifest = await run(['--updated-since', '2026-06-07T00:00:00Z', '--prioritize-uncovered', '--uncovered-backfill-limit', '2', '--uncovered-cooldown-days', '5'],
      { queryFn, now: NOW });
    expect(manifest.rows.filter((row) => row.source === 'uncovered_backfill').map((row) => row.product_key)).toEqual(['prod_old_1']);
    expect(manifest.rows.filter((row) => row.product_key === 'prod_recent')).toHaveLength(1);
    expect(manifest.selection.uncovered_backfill_limit).toBe(2);
    expect(manifest.affected_refs).toEqual(expect.arrayContaining(['product:sig_old_1']));
    const [sql, params] = queryFn.mock.calls.find(([text]) => text.includes('backfill_window'));
    // A window of 4x the limit, then the build's coverage predicate keeps priority > 0 (never-touched first).
    expect(params.slice(0, 2)).toEqual([8, 2]);
    expect(params[3]).toBe('US');
    expect(params[5]).toBe('2026-06-08');
    expect(sql).toContain('CROSS JOIN LATERAL');
    expect(sql).toMatch(/WHERE coverage\.relgraph_priority > 0\s+ORDER BY coverage\.relgraph_priority DESC/);
    // The window (before the shared coverage join): renderable, active, not suppressed, no live approval
    // and no label or attempt activity on its own refs within the cooldown; daily-rotating hash order.
    const windowSql = sql.slice(sql.indexOf('WITH backfill_window'), sql.indexOf('FROM backfill_window cp'));
    expect(windowSql).toContain('cp.pdp_will_render IS TRUE');
    expect(windowSql).toContain("cp.pdp_will_render_computed_at >= now() - interval '7 days'");
    expect(windowSql).toContain('cp.suppressed_at IS NULL AND cp.suppression_reason IS NULL');
    expect(windowSql).toContain("lower(labels.anchor_ref) IN (lower('product:' || cp.pivota_signature_id), lower('product:' || cp.source_product_id))");
    // Only this market's labels keep a product out (a label in another market does not cover it here).
    expect(windowSql).toContain("AND lower(labels.market) = lower($4) AND labels.vertical = 'beauty'");
    expect(windowSql).toContain("labels.label_state IN ('ai_approved', 'human_approved') AND labels.last_verified_at IS NOT NULL AND labels.expires_at > now()");
    expect(windowSql).toContain("GREATEST(labels.created_at, labels.updated_at, labels.reviewed_at) >= now() - interval '5 days'");
    expect(windowSql).toMatch(/attempt\.market = \$4 AND attempt\.vertical = 'beauty'/);
    expect(windowSql).toMatch(/ORDER BY md5\(cp\.product_key \|\| \$6\), cp\.product_key\s+LIMIT \$1/);
    expect(sql).not.toMatch(/cp\.updated_at >= \$/);
  });

  test('the backfill limit is capped at 400 (target recall\'s maximum), and the run reports its count on stderr', async () => {
    expect(parseArgs(['--updated-since', '2026-06-07T00:00:00Z', '--prioritize-uncovered', '--uncovered-backfill-limit', '900'], { now: NOW }).uncoveredBackfillLimit).toBe(400);
    const queryFn = jest.fn(async (sql) => {
      if (sql.includes('schema_access')) return { rows: [{ has_schema_usage: true, table_name: 'relationship_graph_anchor_attempts', can_insert: true, can_select: true, can_update: true }] };
      if (sql.includes('backfill_window')) return { rows: [{ product_key: 'prod_b', pivota_signature_id: 'sig_b', source_product_id: 'ext_b', relgraph_priority: 3 }] };
      return { rows: [] };
    });
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await run(['--updated-since', '2026-06-07T00:00:00Z', '--prioritize-uncovered', '--uncovered-backfill-limit', '3'], { queryFn, now: NOW });
      expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toContain('relgraph uncovered backfill: selected 1 of limit 3');
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  test('the backfill requires the prioritize-uncovered build', () => {
    expect(() => parseArgs(['--updated-since', '2026-06-07T00:00:00Z', '--uncovered-backfill-limit', '5'], { now: NOW }))
      .toThrow(/requires --prioritize-uncovered/);
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
