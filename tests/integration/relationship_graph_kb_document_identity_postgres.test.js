const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { enrichProductRelationshipGraphProducts } = require('../../src/auroraBff/productRelationshipGraphSources');

// KB evidence enrichment per-call (document_identity re-materialized by every 200-product batch)
// versus build-once (materialized once into a run-scoped temp table): the same rows either way.
const DATABASE_URL = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const BIN = process.env.RELGRAPH_TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@15/bin';
const postgresDescribe = (DATABASE_URL || process.env.RELGRAPH_TEST_POSTGRES === '1') ? describe : describe.skip;
postgresDescribe('KB document identity built once per run on isolated Postgres', () => {
  let dir; let client; let clientConfig; let started = false;
  const env = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  const run = (name, args) => execFileSync(path.join(BIN, name), args, { env, stdio: 'pipe' });
  const queryFn = jest.fn((sql, params) => client.query(sql, params));
  const clientQuery = jest.fn((sql, params) => client.query(sql, params));
  const withClientFn = jest.fn((fn) => fn({ query: clientQuery }));
  const identityScans = () => clientQuery.mock.calls.filter(([sql]) => /^CREATE TEMP TABLE relgraph_kb_document_identity/.test(sql.trim())).length;
  beforeAll(async () => {
    if (DATABASE_URL) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(DATABASE_URL).hostname)) throw new Error('KB identity Postgres tests require local database');
      clientConfig = { connectionString: DATABASE_URL };
      client = new Client(clientConfig);
    } else {
      const net = require('node:net');
      const port = await new Promise((resolve, reject) => {
        const server = net.createServer(); server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
      });
      dir = fs.mkdtempSync('/tmp/relgraph-kb-identity-');
      run('initdb', ['-D', dir, '-A', 'trust', '--no-locale', '--encoding=UTF8']);
      run('pg_ctl', ['-D', dir, '-l', path.join(dir, 'server.log'), '-o', `-k /tmp -c listen_addresses=127.0.0.1 -p ${port}`, '-w', 'start']);
      started = true;
      clientConfig = { host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' };
      client = new Client(clientConfig);
    }
    await client.connect();
    await client.query('CREATE SCHEMA relgraph_kb_identity_test; SET search_path TO relgraph_kb_identity_test');
    await client.query(`CREATE TABLE aurora_product_intel_kb (kb_key text PRIMARY KEY, analysis jsonb, source text,
      source_meta jsonb DEFAULT '{}', last_success_at timestamptz, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now())`);
  }, 30000);
  afterAll(async () => {
    try { if (client) { await client.query('DROP SCHEMA IF EXISTS relgraph_kb_identity_test CASCADE'); await client.end(); } }
    finally { if (started) run('pg_ctl', ['-D', dir, '-m', 'immediate', '-w', 'stop']); if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
  });
  beforeEach(async () => {
    queryFn.mockClear(); clientQuery.mockClear(); withClientFn.mockClear();
    await client.query('TRUNCATE aurora_product_intel_kb');
  });

  async function doc(kbKey, canonical, { decision, quality, brand = '', daysAgo = 1 } = {}) {
    await client.query(`INSERT INTO aurora_product_intel_kb (kb_key, analysis, source, source_meta, last_success_at, updated_at)
      VALUES ($1, $2, 'fixture', $3, now() - make_interval(days => $4), now() - make_interval(days => $4))`, [kbKey,
      { product_intel_v1: { canonical_product_ref: canonical, product_intel_core: { summary: `intel for ${kbKey}` },
        ...(quality ? { quality_state: quality } : {}), ...(decision ? { provenance: { review_decision: decision } } : {}) } },
      brand ? { brand } : {}, daysAgo]);
  }

  // 450 listings (three 200-product batches) and KB documents that identify them every way the
  // matcher supports, plus rejected, conflicting and over-cap documents.
  async function fixture() {
    const products = [];
    for (let i = 1; i <= 450; i += 1) {
      const lane = i % 5;
      const product = { product_ref: `product:sig_p${i}`, pivota_signature_id: `sig_p${i}`, name: `Listing ${i}`,
        brand: `Brand ${i % 7}`, category: 'Face Serum', market: 'US',
        ...(lane === 0 ? { product_key: `pk_${i}` } : {}),
        ...(lane === 2 ? { url: `https://shop.example/p/${i}` } : {}),
        ...(lane === 3 ? { product_id: `ext_${i}`, source_product_id: `ext_${i}` } : {}),
        ...(lane === 4 ? { merchant_id: 'merch_a', platform: 'shopify', source_product_id: `${i}` } : {}) };
      products.push(product);
      if (i % 3 === 0) continue; // a third of the listings have no KB document
      const canonical = [
        { product_key: `pk_${i}` },
        { pivota_signature_id: `sig_p${i}` },
        { canonical_url: `https://shop.example/p/${i}`, pivota_signature_id: `sig_p${i}` },
        { product_id: `ext_${i}` },
        { merchant_id: 'merch_a', platform: 'shopify', product_id: `${i}`, pivota_signature_id: `sig_p${i}` },
      ][lane];
      await doc(`kb_${i}`, { ...canonical, brand: `brand ${i % 7}` }, { daysAgo: i % 11 });
      if (lane === 2) await client.query(`UPDATE aurora_product_intel_kb SET analysis = jsonb_set(analysis,
        '{product_intel_v1,source_coverage}', $2::jsonb) WHERE kb_key = $1`, [`kb_${i}`, { canonical_url: `https://shop.example/p/${i}` }]);
    }
    // Over the per-listing cap of 5: the newest 5 load and the listing is flagged incomplete.
    for (let n = 0; n < 7; n += 1) await doc(`kb_many_${n}`, { pivota_signature_id: 'sig_p7' }, { daysAgo: 20 + n });
    // Excluded or conflicting documents.
    await doc('kb_rejected', { pivota_signature_id: 'sig_p8' }, { decision: 'rejected' });
    await doc('kb_needs_review', { pivota_signature_id: 'sig_p11' }, { quality: 'needs_review' });
    await doc('kb_wrong_market', { pivota_signature_id: 'sig_p13', market: 'JP' });
    await doc('kb_wrong_brand', { pivota_signature_id: 'sig_p14', brand: 'someone else' });
    await doc('kb_signature_conflict', { pivota_signature_id: 'sig_p16', pivotaSignatureId: 'sig_other' });
    // Every other identity spelling the matcher accepts, each for a listing with no other document.
    await doc('kb_alias_productKey', { productKey: 'pk_30' });
    await doc('kb_alias_pivotaSignatureId', { pivotaSignatureId: 'sig_p31' });
    await doc('kb_alias_product_id_sig', { product_id: 'sig_p33' });
    await doc('kb_alias_product_id_prefixed', { product_id: 'product:sig_p36' });
    await doc('kb_alias_productId_prefixed', { productId: 'product:sig_p39' });
    await doc('kb_alias_product_ref', { product_ref: 'product:sig_p42' });
    await doc('kb_alias_productRef', { productRef: 'product:sig_p48' });
    await doc('product:sig_p51', { brand: 'brand 2' });
    await doc('product:ext_63', { brand: 'brand 0' });
    await doc('kb_alias_ext_ref', { product_id: 'product:ext_93' });
    await doc('kb_alias_merchant_ref', { merchant_id: 'merch_a', platform: 'shopify', product_id: 'product:sig_p99' });
    // Matched by URL alone: no product key or signature in the document.
    await doc('kb_url_only', { canonical_url: 'https://shop.example/p/57', brand: 'brand 1' });
    await client.query(`UPDATE aurora_product_intel_kb SET analysis = jsonb_set(analysis, '{product_intel_v1,source_coverage}',
      '{"canonical_url":"https://shop.example/p/57"}'::jsonb) WHERE kb_key = 'kb_url_only'`);
    // Five newer unreviewed documents must not take the per-listing cap from the reviewed one.
    for (let n = 0; n < 5; n += 1) await doc(`kb_unreviewed_${n}`, { pivota_signature_id: 'sig_p19' }, { quality: 'needs_review', daysAgo: 0 });
    // A listing repeated in two batches (same signature) and an identical duplicate listing.
    products.push({ ...products[0] }, { ...products[1], product_ref: 'product:sig_p2', name: 'Listing 2 again' });
    await client.query('ANALYZE aurora_product_intel_kb');
    return products;
  }

  const strip = ({ kb_document_identity_scan_count: _scans, ...rest }) => rest;

  // The pre-change path: every batch re-materializes the identity set and tests every
  // document x target pair (RELGRAPH_KB_KEY_PREFILTER_DISABLED).
  async function legacyEnrichment(options) {
    process.env.RELGRAPH_KB_KEY_PREFILTER_DISABLED = '1';
    try { return await enrichProductRelationshipGraphProducts({ queryFn, ...options }); }
    finally { delete process.env.RELGRAPH_KB_KEY_PREFILTER_DISABLED; }
  }

  test('build-once with the key prefilter returns exactly the legacy per-call enrichment', async () => {
    const products = await fixture();
    const options = { products, market: 'US', limit: products.length };
    const perCall = await legacyEnrichment(options);
    const prefilterPerCall = await enrichProductRelationshipGraphProducts({ queryFn, ...options });
    queryFn.mockClear();
    const buildOnce = await enrichProductRelationshipGraphProducts({ queryFn, withClientFn, ...options });
    expect(strip(prefilterPerCall.diagnostics)).toEqual(strip(perCall.diagnostics));
    expect(prefilterPerCall.intelRows).toEqual(perCall.intelRows);
    for (const key of ['kb_alias_productKey', 'kb_alias_pivotaSignatureId', 'kb_alias_product_id_sig', 'kb_alias_product_id_prefixed',
      'kb_alias_productId_prefixed', 'kb_alias_product_ref', 'kb_alias_productRef', 'product:sig_p51', 'product:ext_63',
      'kb_alias_ext_ref', 'kb_alias_merchant_ref', 'kb_url_only']) {
      expect(JSON.stringify(perCall.products)).toContain(`intel for ${key}`);
    }
    expect(perCall.diagnostics.kb_document_identity_scan_count).toBe(3);
    expect(perCall.diagnostics.products_with_intel).toBeGreaterThan(250);
    expect(perCall.diagnostics.intel_loads_incomplete).toBeGreaterThan(0);
    expect(JSON.stringify(perCall.products.find((product) => product.pivota_signature_id === 'sig_p19').product_intel))
      .toContain('intel for kb_19');
    expect(buildOnce.products).toEqual(perCall.products);
    expect(buildOnce.intelRows).toEqual(perCall.intelRows);
    expect(buildOnce.ingredientRows).toEqual(perCall.ingredientRows);
    expect(strip(buildOnce.diagnostics)).toEqual(strip(perCall.diagnostics));
    expect(buildOnce.diagnostics.kb_document_identity_scan_count).toBe(1);
    expect(identityScans()).toBe(1);
  });

  test('excluded and conflicting documents stay out in both modes', async () => {
    const products = await fixture();
    for (const options of [{ queryFn }, { queryFn, withClientFn }]) {
      const { products: enriched } = await enrichProductRelationshipGraphProducts({ ...options, products, market: 'US', limit: 500 });
      const intelFor = (signature) => enriched.find((product) => product.pivota_signature_id === signature)?.product_intel;
      for (const signature of ['sig_p8', 'sig_p11', 'sig_p13', 'sig_p14', 'sig_p16']) {
        expect(JSON.stringify(intelFor(signature) || {})).not.toMatch(/kb_(rejected|needs_review|wrong_market|wrong_brand|signature_conflict)/);
      }
    }
  });

  test('build-once leaves no temp table behind and drops it when a batch fails', async () => {
    const products = await fixture();
    await enrichProductRelationshipGraphProducts({ queryFn, withClientFn, products, market: 'US', limit: 500 });
    const leftover = async () => (await client.query("SELECT to_regclass('pg_temp.relgraph_kb_document_identity') AS t")).rows[0].t;
    expect(await leftover()).toBeNull();
    let intelCalls = 0;
    const failing = (fn) => fn({ query: (sql, params) => {
      if (/document_identity AS \(/.test(sql) && (intelCalls += 1) === 2) return Promise.reject(new Error('boom'));
      return client.query(sql, params);
    } });
    const failingFn = jest.fn(failing);
    await expect(enrichProductRelationshipGraphProducts({ queryFn, withClientFn: failingFn, products, market: 'US', limit: 500 }))
      .rejects.toThrow('boom');
    expect(failingFn).toHaveBeenCalledTimes(1); // not a connection error: no retry
    expect(await leftover()).toBeNull();
  });

  test('a missing KB table yields no intel in both modes, without poisoning later batches', async () => {
    const products = await fixture();
    await client.query('ALTER TABLE aurora_product_intel_kb RENAME TO aurora_product_intel_kb_hidden');
    try {
      const perCall = await enrichProductRelationshipGraphProducts({ queryFn, products, market: 'US', limit: 500 });
      const buildOnce = await enrichProductRelationshipGraphProducts({ queryFn, withClientFn, products, market: 'US', limit: 500 });
      expect(perCall.intelRows).toEqual([]);
      expect(buildOnce.intelRows).toEqual([]);
      expect(buildOnce.products).toEqual(perCall.products);
      expect(buildOnce.diagnostics.kb_document_identity_scan_count).toBe(0);
    } finally {
      await client.query('ALTER TABLE aurora_product_intel_kb_hidden RENAME TO aurora_product_intel_kb');
    }
  });

  test('RELGRAPH_RUN_SCOPED_TABLES_DISABLED keeps the per-call identity scan', async () => {
    const products = await fixture();
    process.env.RELGRAPH_RUN_SCOPED_TABLES_DISABLED = '1';
    try {
      const loaded = await enrichProductRelationshipGraphProducts({ queryFn, withClientFn, products, market: 'US', limit: 500 });
      expect(withClientFn).not.toHaveBeenCalled();
      expect(loaded.diagnostics.kb_document_identity_scan_count).toBe(3);
    } finally {
      delete process.env.RELGRAPH_RUN_SCOPED_TABLES_DISABLED;
    }
  });

  // A connection whose first stage attempt (or every attempt) loses the identity table before
  // its second targeted intel query.
  function droppingConnection({ everyAttempt }) {
    let attempts = 0;
    return jest.fn((stage) => {
      attempts += 1;
      const attempt = attempts;
      let intelQueries = 0;
      return stage({ query: async (sql, params) => {
        if (/document_identity AS \(/.test(sql) && (intelQueries += 1) === 2 && (everyAttempt || attempt === 1)) {
          await client.query('DROP TABLE pg_temp.relgraph_kb_document_identity');
        }
        return client.query(sql, params);
      } });
    });
  }

  test('a lost identity table is retried once, and never yields silently empty intel', async () => {
    const products = await fixture();
    const options = { products, market: 'US', limit: 500 };
    const perCall = await legacyEnrichment(options);
    const dropOnce = droppingConnection({ everyAttempt: false });
    const retried = await enrichProductRelationshipGraphProducts({ queryFn, withClientFn: dropOnce, ...options });
    expect(dropOnce).toHaveBeenCalledTimes(2);
    expect(retried.products).toEqual(perCall.products);
    expect(retried.intelRows).toEqual(perCall.intelRows);
    const dropAlways = droppingConnection({ everyAttempt: true });
    await expect(enrichProductRelationshipGraphProducts({ queryFn, withClientFn: dropAlways, ...options }))
      .rejects.toMatchObject({ code: 'RELGRAPH_RUN_SCOPED_TABLE_LOST' });
    expect(dropAlways).toHaveBeenCalledTimes(2);
  });

  test('a transient connection error retries the KB stage once on a fresh connection', async () => {
    const products = await fixture();
    const options = { products, market: 'US', limit: 500 };
    const perCall = await legacyEnrichment(options);
    let attempts = 0;
    const flaky = jest.fn((stage) => {
      attempts += 1;
      const attempt = attempts;
      let intelQueries = 0;
      return stage({ query: (sql, params) => {
        if (attempt === 1 && /document_identity AS \(/.test(sql) && (intelQueries += 1) === 3) {
          return Promise.reject(Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }));
        }
        return client.query(sql, params);
      } });
    });
    const retried = await enrichProductRelationshipGraphProducts({ queryFn, withClientFn: flaky, ...options });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(retried.products).toEqual(perCall.products);
    expect(retried.intelRows).toEqual(perCall.intelRows);
  });

  test('a one-connection pool keeps the per-call identity scan (the stage would wait on itself)', async () => {
    const products = await fixture();
    const options = { products, market: 'US', limit: 500 };
    const perCall = await legacyEnrichment(options);
    const previous = process.env.DB_POOL_MAX;
    process.env.DB_POOL_MAX = '1';
    try {
      const loaded = await enrichProductRelationshipGraphProducts({ queryFn, withClientFn, ...options });
      expect(withClientFn).not.toHaveBeenCalled();
      expect(loaded.products).toEqual(perCall.products);
      expect(loaded.diagnostics.kb_document_identity_scan_count).toBe(3);
    } finally {
      if (previous === undefined) delete process.env.DB_POOL_MAX; else process.env.DB_POOL_MAX = previous;
    }
  });

  // A client that opens a NEW backend session for every statement, as a transaction-mode pooler
  // would: a temp table never survives to the next statement.
  const perStatementSession = () => ({ query: async (sql, params) => {
    const session = new Client(clientConfig);
    await session.connect();
    try {
      await session.query('SET search_path TO relgraph_kb_identity_test');
      return await session.query(sql, params);
    } finally {
      await session.end();
    }
  } });

  test('an identity table that never survives its statement is LOST, never empty intel', async () => {
    // CTAS succeeds; the ANALYZE on the next session fails with 3F000 schema "pg_temp" does not
    // exist, which names no table.
    const products = await fixture();
    const perSession = jest.fn((stage) => stage(perStatementSession()));
    await expect(enrichProductRelationshipGraphProducts({ queryFn, withClientFn: perSession, products, market: 'US', limit: 500 }))
      .rejects.toMatchObject({ code: 'RELGRAPH_RUN_SCOPED_TABLE_LOST' });
    expect(perSession).toHaveBeenCalledTimes(2);
  });

  test('RELGRAPH_DB_DUTY_CYCLE paces each KB batch without changing the enrichment', async () => {
    const pacing = require('../../src/auroraBff/relationshipGraphDbPacing');
    const products = await fixture();
    const options = { products, market: 'US', limit: 500 };
    const off = await enrichProductRelationshipGraphProducts({ queryFn, withClientFn, ...options });
    const sleeps = [];
    pacing.__setSleepForTests((ms) => { sleeps.push(ms); return new Promise((resolve) => setTimeout(resolve, ms)); });
    process.env.RELGRAPH_DB_DUTY_CYCLE = '1';
    try {
      const on = await enrichProductRelationshipGraphProducts({ queryFn, withClientFn, ...options });
      expect(on.products).toEqual(off.products);
      expect(on.intelRows).toEqual(off.intelRows);
      expect(on.ingredientRows).toEqual(off.ingredientRows);
      expect(on.diagnostics).toEqual(off.diagnostics);
      // At most one per 200-product batch (a sub-millisecond batch earns no sleep).
      expect(sleeps.length).toBeGreaterThan(0);
      expect(sleeps.length).toBeLessThanOrEqual(3);
      expect(sleeps.every((ms) => ms > 0)).toBe(true);
    } finally {
      delete process.env.RELGRAPH_DB_DUTY_CYCLE;
      pacing.__setSleepForTests(null);
    }
  });
});
