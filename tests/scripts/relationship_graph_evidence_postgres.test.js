const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const {
  enrichProductRelationshipGraphProducts, loadProductIntelKbRows,
} = require('../../src/auroraBff/productRelationshipGraphSources');

const BIN = process.env.RELGRAPH_TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@15/bin';
const TEST_DATABASE_URL = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const postgresDescribe = TEST_DATABASE_URL || process.env.RELGRAPH_TEST_POSTGRES === '1' ? describe : describe.skip;
const FORMULA = 'Water, Glycerin, Squalane, Ceramide NP, Panthenol, Phenoxyethanol';
const product = (key) => ({ product_ref: `product:sig_${key}`, product_id: `source_${key}`,
  source_product_id: `source_${key}`, product_key: `cp_${key}`, pivota_signature_id: `sig_${key}`,
  brand: `Lab ${key}`, name: `Daily Serum ${key}`, category: 'serum', price: 20, price_currency: 'USD', market: 'US' });

// Use only an explicitly selected loopback CI database or a self-started disposable database.
// All fixtures and any temporary table renames roll back; ambient DATABASE_URL is never read.
postgresDescribe('targeted evidence on disposable PostgreSQL', () => {
  let client;
  let dir;
  let started = false;
  let originalTables;
  const fixtureSchema = `relgraph_evidence_test_${process.pid}`;
  const env = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  const run = (name, args) => execFileSync(path.join(BIN, name), args, { env, stdio: 'pipe' });
  beforeAll(async () => {
    if (TEST_DATABASE_URL) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(TEST_DATABASE_URL).hostname)) {
        throw new Error('relgraph evidence Postgres tests require an explicitly selected loopback database');
      }
      client = new Client({ connectionString: TEST_DATABASE_URL });
    } else {
      const net = require('node:net');
      const port = await new Promise((resolve, reject) => {
        const server = net.createServer(); server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
      });
      dir = fs.mkdtempSync('/tmp/relgraph-evidence-');
      run('initdb', ['-D', dir, '-A', 'trust', '--no-locale', '--encoding=UTF8']);
      run('pg_ctl', ['-D', dir, '-l', path.join(dir, 'server.log'), '-o', `-k /tmp -c listen_addresses=127.0.0.1 -p ${port}`, '-w', 'start']);
      started = true;
      client = new Client({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' });
    }
    await client.connect();
    originalTables = (await client.query(`SELECT to_regclass('public.beauty_sku_ingredients')::oid AS beauty,
      to_regclass('pci_kb.sku_ingredients')::oid AS pci`)).rows[0];
    await client.query(`BEGIN; CREATE SCHEMA ${fixtureSchema}; SET LOCAL search_path TO ${fixtureSchema}, public`);
    // The loaders intentionally use two schema-qualified names. Rename pre-existing local CI
    // tables inside this transaction, leaving their data/dependencies intact for rollback.
    if (originalTables.beauty) await client.query(`ALTER TABLE public.beauty_sku_ingredients RENAME TO ${fixtureSchema}_original`);
    if (originalTables.pci) await client.query(`ALTER TABLE pci_kb.sku_ingredients RENAME TO ${fixtureSchema}_original`);
    await client.query(`
      CREATE TABLE aurora_product_intel_kb(kb_key text PRIMARY KEY, analysis jsonb, source text,
        source_meta jsonb, last_success_at timestamptz, updated_at timestamptz, created_at timestamptz);
      CREATE TABLE public.beauty_sku_ingredients(sku_key text PRIMARY KEY, product_key text, merchant_id text,
        raw_inci text, normalized_ingredients_json jsonb, active_ingredients_json jsonb,
        evidence_refs_json jsonb, source_system text, review_status text, audit_status text, ingest_allowed boolean,
        created_at timestamptz, updated_at timestamptz);
      CREATE INDEX ${fixtureSchema}_product_key ON public.beauty_sku_ingredients(product_key);
      CREATE SCHEMA IF NOT EXISTS pci_kb;
      CREATE TABLE pci_kb.sku_ingredients(sku_key text PRIMARY KEY, market text, brand text, product_name text,
        source_ref text, parse_status text, review_status text, audit_status text, ingest_allowed boolean,
        raw_ingredient_text_clean text, inci_list text, created_at timestamptz);
    `);
  }, 30000);
  afterAll(async () => {
    try {
      if (client) {
        try {
          await client.query('ROLLBACK');
          if (originalTables) {
            const restored = (await client.query(`SELECT to_regclass('public.beauty_sku_ingredients')::oid AS beauty,
              to_regclass('pci_kb.sku_ingredients')::oid AS pci`)).rows[0];
            expect(restored).toEqual(originalTables);
          }
        } finally { await client.end(); }
      }
    } finally {
      if (started) run('pg_ctl', ['-D', dir, '-m', 'immediate', '-w', 'stop']);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  beforeEach(async () => client.query('TRUNCATE aurora_product_intel_kb, public.beauty_sku_ingredients, pci_kb.sku_ingredients'));
  const queryFn = (sql, params) => client.query(sql, params);
  async function ingredient(key, overrides = {}) {
    await client.query(`INSERT INTO public.beauty_sku_ingredients(sku_key,product_key,raw_inci,review_status,audit_status,ingest_allowed,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [overrides.sku || `sku_${key}`, `cp_${key}`, FORMULA,
    overrides.review || 'approved', overrides.audit || 'passed', overrides.allowed ?? true, overrides.updated || '2020-01-01']);
  }
  async function intel(key, { style = 'product_intel_v1', productId = `source_${key}`, url, updated = '2020-01-01' } = {}) {
    const bundle = { canonical_product_ref: { product_id: productId, pivota_signature_id: `sig_${key}` },
      evidence_profile: 'seller_only', confidence: { tier: 'limited' },
      freshness: { generated_at: updated }, provenance: { source_signals: ['seller_description'] },
      ...(url ? { source_coverage: { canonical_url: url } } : {}),
      product_intel_core: { what_it_is: { body: 'Hydrating facial serum.' }, routine_fit: { step: 'serum' } } };
    await client.query(`INSERT INTO aurora_product_intel_kb(kb_key,analysis,last_success_at,updated_at)
      VALUES($1,$2::jsonb,$3,$3)`, [`opaque_${key}`, JSON.stringify(style ? { [style]: bundle } : bundle), updated]);
  }

  test('selected old anchor and candidate survive global recency limits with both trusted ingredient stores', async () => {
    await ingredient('a'); await ingredient('b');
    await ingredient('a', { sku: 'recent_reject', review: 'rejected', updated: '2026-10-01' });
    await ingredient('b', { sku: 'recent_block', audit: 'blocked', updated: '2026-10-01' });
    await intel('a'); await intel('b', { style: 'product_intel' });
    await intel('new', { updated: '2026-10-01' });
    await client.query(`INSERT INTO pci_kb.sku_ingredients(sku_key,market,parse_status,ingest_allowed,inci_list,created_at)
      VALUES('source_a','US','OK',false,'Water, Fragrance',now()),('source_b','JP','OK',true,'Water, Fragrance',now())`);
    const latest = await loadProductIntelKbRows({ queryFn, limit: 1 });
    expect(latest[0].pivota_signature_id).toBe('sig_new');
    const hydrated = await enrichProductRelationshipGraphProducts({ queryFn, products: [product('a'), product('b')], limit: 1 });
    expect(hydrated.products.map((row) => row.ingredient_text)).toEqual([FORMULA, FORMULA]);
    expect(hydrated.products.map((row) => row.product_intel.evidence_profile)).toEqual(['seller_only', 'seller_only']);
    expect(hydrated.products.every((row) => row.price === 20 && row.price_currency === 'USD')).toBe(true);
    expect(hydrated.diagnostics.targeted_products_complete).toBe(true);
    expect(hydrated.ingredientRows).toHaveLength(2);
  });

  test('exact canonical URL binds opaque KB keys without name matching', async () => {
    await intel('url', { productId: 'otherwise_unknown', url: 'https://example.test/serum' });
    const hydrated = await enrichProductRelationshipGraphProducts({ queryFn,
      products: [{ product_ref: 'product:catalog_a', url: 'https://example.test/serum', name: 'Catalog title' }] });
    expect(hydrated.products[0].product_intel.evidence_profile).toBe('seller_only');
    expect(hydrated.products[0].product_ref).toBe('product:catalog_a');
  });

  test('newer recycled raw IDs and conflicting exact identities cannot hide older selected Intel', async () => {
    const target = { ...product('a'), source_product_id: '123', merchant_id: 'store_a', platform: 'shopify' };
    const bundle = (canonical, body) => ({ product_intel_v1: { canonical_product_ref: canonical,
      product_intel_core: { what_it_is: { body } } } });
    await client.query(`INSERT INTO aurora_product_intel_kb(kb_key,analysis,last_success_at,updated_at)
      VALUES('correct_old',$1::jsonb,'2020-01-01','2020-01-01')`,
    [JSON.stringify(bundle({ product_id: '123', product_key: target.product_key,
      pivota_signature_id: target.pivota_signature_id, merchant_id: 'store_a', platform: 'shopify' }, 'Correct older evidence'))]);
    for (let i = 0; i < 11; i += 1) {
      // Include one same-store row with a conflicting key and one sparse unscoped
      // row, so merely adding merchant equality to raw-ID matching is insufficient.
      const canonical = i === 5 ? { product_id: '123' } : i >= 6 ? {
        product_id: i === 6 ? 'sig_other_6' : '123', product_key: target.product_key,
        ...(i === 7 ? { market: 'JP' } : {}), ...(i === 8 ? { pivota_signature_id: 'sig_other_8' } : {}),
        ...(i === 10 ? { productRef: 'product:sig_other_10' } : {}),
      } : { product_id: '123', product_key: `other_${i}`,
        merchant_id: i === 4 ? 'store_a' : 'store_b', platform: 'shopify' };
      await client.query(`INSERT INTO aurora_product_intel_kb(kb_key,analysis,source_meta,last_success_at,updated_at)
        VALUES($1,$2::jsonb,$3::jsonb,now(),now())`, [`other_${i}`, JSON.stringify(bundle(canonical, 'Unrelated newer evidence')),
      JSON.stringify(i === 9 ? { brand: 'Wrong Brand' } : {})]);
    }
    const hydrated = await enrichProductRelationshipGraphProducts({ queryFn, products: [target] });
    expect(hydrated.intelRows).toHaveLength(1);
    expect(hydrated.products[0].product_intel.product_intel_core.what_it_is.body).toBe('Correct older evidence');
    expect(hydrated.diagnostics).toMatchObject({ products_with_intel: 1, intel_loads_incomplete: 0 });
  });

  test.each([
    ['minted signature ref', { product_id: 'product:sig_route' }, { product_ref: 'product:sig_route', pivota_signature_id: 'sig_route' }],
    ['global external ref', { product_id: 'product:ext_route' }, { product_ref: 'product:ext_route', source_product_id: 'ext_route' }],
    ['scoped source ID', { product_id: '123', merchant_id: 'store_a', platform: 'shopify' },
      { product_ref: 'product:store_a_route', source_product_id: '123', merchant_id: 'store_a', platform: 'shopify' }],
  ])('targeted Intel retains authoritative %s binding', async (_kind, canonical, target) => {
    await client.query(`INSERT INTO aurora_product_intel_kb(kb_key,analysis,last_success_at,updated_at)
      VALUES('opaque',$1::jsonb,now(),now())`, [JSON.stringify({ product_intel_v1: {
      canonical_product_ref: canonical, product_intel_core: { what_it_is: { body: 'Exact selected context' } },
    } })]);
    const hydrated = await enrichProductRelationshipGraphProducts({ queryFn, products: [{ ...target, name: 'Selected serum' }] });
    expect(hydrated.products[0].product_intel.product_intel_core.what_it_is.body).toBe('Exact selected context');
    expect(hydrated.diagnostics.products_with_intel).toBe(1);
  });

  test('five exact listings sharing one group reference have independent ingredient and Intel caps', async () => {
    const products = [];
    for (let index = 0; index < 5; index += 1) {
      const key = `group_${index}`;
      products.push({ ...product(key), product_ref: 'product:pg_shared', ingredient_text: FORMULA });
      await ingredient(key);
      await intel(key);
    }
    const hydrated = await enrichProductRelationshipGraphProducts({ queryFn, products });
    expect(hydrated.products).toHaveLength(5);
    expect(hydrated.products.map((row) => row.ingredient_text)).toEqual(Array(5).fill(FORMULA));
    expect(hydrated.products.every((row) => !row.ingredient_evidence_incomplete && !row.product_intel_evidence_incomplete)).toBe(true);
    expect(hydrated.products.map((row) => row.ingredient_evidence[0].product_key)).toEqual(products.map((row) => row.product_key));
    expect(hydrated.products.map((row) => row.product_intel.canonical_product_ref.pivota_signature_id)).toEqual(products.map((row) => row.pivota_signature_id));
    expect(hydrated.diagnostics).toMatchObject({ targeted_products_complete: true, ingredient_loads_incomplete: 0, intel_loads_incomplete: 0 });
  });

  test('conflicting and audit-blocked URL ingredient rows do not consume the exact listing cap', async () => {
    const target = { ...product('a'), url: 'https://example.test/selected-serum' };
    await client.query(`INSERT INTO pci_kb.sku_ingredients(sku_key,market,brand,source_ref,parse_status,ingest_allowed,inci_list,created_at)
      VALUES('correct_old','US',$1,$2,'OK',true,$3,'2020-01-01')`, [target.brand, target.url, FORMULA]);
    for (let i = 0; i < 6; i += 1) {
      await client.query(`INSERT INTO pci_kb.sku_ingredients(sku_key,market,brand,source_ref,parse_status,ingest_allowed,inci_list,created_at)
        VALUES($1,'US',$2,$3,$4,true,'Water, Fragrance',now())`,
      [`other_${i}`, i < 3 ? 'Wrong Brand' : target.brand, target.url, i < 3 ? 'OK' : 'needs_review']);
    }
    const hydrated = await enrichProductRelationshipGraphProducts({ queryFn, products: [target] });
    expect(hydrated.products[0].ingredient_text).toBe(FORMULA);
    expect(hydrated.ingredientRows).toHaveLength(1);
    expect(hydrated.diagnostics).toMatchObject({ ingredient_conflicts: 0, ingredient_loads_incomplete: 0 });
  });

  test('denied, platform and variant-conflicting newer bundles cannot hide older exact reviewed metadata', async () => {
    const target={...product('a'),platform:'shopify',merchant_id:'fixture_shop',variant_title:'Shade27',variant_detail_label:'Cool'};
    const canonical={productKey:'cp_a',platform:'shopify',variant_title:'Shade27',variant_detail_label:'Cool'};
    const core={what_it_is:{body:'Hydrating facial serum.'}};
    await client.query(`INSERT INTO aurora_product_intel_kb(kb_key,analysis,source_meta,last_success_at,updated_at)
      VALUES('good_old',$1::jsonb,$2::jsonb,'2020-01-01','2020-01-01')`,
      [JSON.stringify({product_intel_v1:{canonical_product_ref:canonical,product_intel_core:core,evidence_profile:'seller_only'}}),
        JSON.stringify({quality_state:'reviewed',confidence:{tier:'limited'},freshness:{generated_at:'2020-01-01'}})]);
    for(const [index, conflict] of [{platform:'wix'},{variant_title:'Shade23'},{variantTitle:'Shade23'},
      {variant_detail_label:'Warm'},{variantDetailLabel:'Warm'},{pivotaSignatureId:'sig_other'},
      {product_id:'sig_a',productId:'sig_other'},{merchant_id:'fixture_shop',merchantId:'wrong_shop'},
      {source_product_id:'source_a',sourceProductId:'source_other'}].entries()) {
      await client.query(`INSERT INTO aurora_product_intel_kb(kb_key,analysis,last_success_at,updated_at)
        VALUES($1,$2::jsonb,now(),now())`, [`conflict_${index}`,JSON.stringify({product_intel_v1:{
          canonical_product_ref:{...canonical,...conflict},quality_state:'reviewed',product_intel_core:core}})]);
    }
    for(let i=0;i<6;i++) await client.query(`INSERT INTO aurora_product_intel_kb(kb_key,analysis,source_meta,last_success_at,updated_at)
      VALUES($1,$2::jsonb,'{"review_decision":"rejected"}'::jsonb,now(),now())`,
      [`denied_${i}`,JSON.stringify({product_intel_v1:{canonical_product_ref:canonical,quality_state:'reviewed',product_intel_core:core}})]);
    const hydrated=await enrichProductRelationshipGraphProducts({queryFn,products:[target]});
    expect(hydrated.intelRows).toHaveLength(1);
    expect(hydrated.products[0].product_intel).toMatchObject({quality_state:'reviewed',confidence:{tier:'limited'},freshness:{generated_at:'2020-01-01'}});
    expect(hydrated.products[0].product_intel_binding.source_record_ref).toBe('good_old');
    expect(hydrated.diagnostics.intel_loads_incomplete).toBe(0);
  });

  test('200 targets scan compact identity once and project matches once across 10,000 substantial bundles', async () => {
    await client.query(`INSERT INTO aurora_product_intel_kb(kb_key,analysis,last_success_at,updated_at)
      SELECT 'opaque_' || g, jsonb_build_object('product_intel_v1',jsonb_build_object(
        'canonical_product_ref',jsonb_build_object('product_id','source_' || g,'pivota_signature_id','sig_' || g),
        'evidence_profile','seller_only','confidence',jsonb_build_object('tier','limited'),
        'product_intel_core',jsonb_build_object('what_it_is',jsonb_build_object('body',
          (SELECT string_agg(md5((g * 200 + n)::text),'') FROM generate_series(1,200) n))))),
        now(),now() FROM generate_series(1,10000) g`);
    await client.query('ANALYZE aurora_product_intel_kb; SET statement_timeout = 30000');
    const targets = Array.from({ length: 200 }, (_, i) => product(String(i + 1)));
    let plan;
    const explainQueryFn = async (sql, params) => {
      // Record the public KB projection, not a later optional-store existence check.
      if (/\bFROM aurora_product_intel_kb\b/i.test(sql)) {
        plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
      }
      return client.query(sql, params);
    };
    const rows = await loadProductIntelKbRows({ queryFn: explainQueryFn, targetProducts: targets, limit: 1 });
    expect(rows).toHaveLength(200);
    const scans = [];
    const visit = (node) => { if (node['Relation Name'] === 'aurora_product_intel_kb') scans.push(node);
      for (const child of node.Plans || []) visit(child); };
    visit(plan.Plan);
    const identity = scans.find((node) => node['Actual Rows'] === 10000);
    expect(identity).toBeDefined();
    expect(identity['Actual Loops']).toBe(1);
    // Key lookups project only selected evidence, rather than copying 200 full KB pools.
    const totalScanRows = scans.reduce((sum, node) => sum + node['Actual Rows'] * node['Actual Loops'], 0);
    expect(totalScanRows).toBeLessThanOrEqual(20200);
    expect(plan['Execution Time']).toBeLessThan(30000);
    console.log(JSON.stringify({ fixture_rows: 10000, targets: 200, matched_rows: rows.length,
      execution_ms: Number(plan['Execution Time'].toFixed(1)), kb_scan_rows: totalScanRows,
      identity_scan_loops: identity['Actual Loops'] }));
  }, 60000);
});
