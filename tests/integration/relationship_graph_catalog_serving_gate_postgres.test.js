const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const {
  loadExternalProductSeedCandidates,
  loadProductRelationshipGraphSourceInputs,
} = require('../../src/auroraBff/productRelationshipGraphSources');
const { buildEdgeForCandidate } = require('../../src/auroraBff/productRelationshipGraphBuilder');
const {
  readApprovedRelationshipEdgesForAnchorUncollapsed,
  upsertRelationshipCandidateLabel,
} = require('../../src/auroraBff/productRelationshipGraph');
const { fetchCandidates } = require('../../scripts/review-relationship-candidate-labels');
const {
  catalogGateKeys,
  catalogGateKeysSql,
  loadCatalogServingGateFailures,
} = require('../../src/auroraBff/relationshipCatalogServingGate');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const MIGRATIONS = ['046_relationship_candidate_labels', '048_relationship_label_prefilter_reasons',
  '050_relationship_review_priority', '051_product_relationship_edges_ai_label_state'];

// 2026-10-21: the relgraph rebuild proposed fentybeauty.com's "Donate To The Clara Lionel
// Foundation" (catalog row stale, seed active) as a competitive alternative for 8 anchors. The
// graph read no catalog state anywhere but target recall. Here every reader is driven against
// PostgreSQL with what the real producer emits: the seed lane's own SQL and normalizer, the
// builder's edge, the label writer's row, migration 051's view.
suite('relationship graph obeys the catalog serving gate, on PostgreSQL', () => {
  let db; let schema;
  const queryFn = (sql, params) => db.query(sql, params);
  const savedMode = process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE;

  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('requires a local database');
    db = new Client({ connectionString: url }); await db.connect();
    schema = `rg_catalog_gate_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`); await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE catalog_products (product_key text PRIMARY KEY, source_product_id text, pivota_signature_id text,
        content_key text, sync_status text DEFAULT 'live', suppressed_at timestamptz, suppression_reason text,
        title text, updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
      CREATE TABLE external_product_seeds (id text PRIMARY KEY, external_product_id text, attached_product_key text,
        title text, availability text, price_amount numeric, price_currency text, market text DEFAULT 'US',
        canonical_url text, destination_url text, seed_data jsonb, status text DEFAULT 'active',
        updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
      CREATE TABLE index_pipeline_state (content_key varchar(40) PRIMARY KEY, serving_eligible boolean);
    `);
    for (const name of MIGRATIONS) {
      // eslint-disable-next-line no-await-in-loop
      await db.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', `${name}.sql`), 'utf8'));
    }
  });
  afterAll(async () => {
    if (savedMode === undefined) delete process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE;
    else process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE = savedMode;
    if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); }
  });
  beforeEach(async () => {
    delete process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE;
    await db.query('TRUNCATE catalog_products, external_product_seeds, index_pipeline_state, relationship_candidate_labels');
  });

  // A seed exactly as the seed lane reads it, attached to its catalog row.
  async function seed(key, { title = 'Daily Barrier Face Serum', brand = `Brand ${key}`, price = 30, catalog = {},
    attach = 'both', ips } = {}) {
    const ext = `ext_${key}`;
    await db.query(`INSERT INTO external_product_seeds(id, external_product_id, attached_product_key, title, price_amount,
      price_currency, canonical_url, seed_data) VALUES ($1, $2, $3, $4, $5, 'USD', $6, $7)`,
    [`eps_${key}`, ext, attach === 'source_only' ? null : `cp_${key}`, title, price, `https://shop.example/products/${key}`,
      { derived: { recall: { vertical: 'beauty', category: 'serum', brand } },
        snapshot: { title, brand, category: 'serum', description: 'Hydrating facial serum supports the skin barrier with a lightweight gel texture.' } }]);
    if (catalog === null) return ext;
    await db.query(`INSERT INTO catalog_products(product_key, source_product_id, pivota_signature_id, content_key,
      sync_status, suppressed_at, suppression_reason, title) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [`cp_${key}`, attach === 'key_only' ? `other_${key}` : ext, `sig_${key}`, `ck_${key}`, catalog.sync_status || 'live',
      catalog.suppressed_at || null, catalog.suppression_reason || null, title]);
    if (ips !== undefined) await db.query('INSERT INTO index_pipeline_state VALUES ($1, $2)', [`ck_${key}`, ips]);
    return ext;
  }

  // One candidate per gate predicate and per resolution arm, plus the controls that must pass.
  async function seedCohort() {
    await seed('anchor', { brand: 'Aster', price: 60, ips: true });
    await seed('live', { brand: 'Birch', ips: true });
    await seed('no_ips_row', { brand: 'Cedar' });
    await seed('no_catalog', { brand: 'Dogwood', catalog: null });
    await seed('stale', { brand: 'Elm', catalog: { sync_status: 'stale' }, attach: 'key_only' });
    await seed('suppressed', { brand: 'Fir', catalog: { suppressed_at: '2026-10-01T00:00:00Z' }, attach: 'source_only' });
    await seed('tombstoned', { brand: 'Gum', catalog: { suppression_reason: 'withdrawn' } });
    await seed('ips_false', { brand: 'Hazel', ips: false });
    await seed('null_sync', { brand: 'Ilex', ips: true });
    await db.query(`UPDATE catalog_products SET sync_status = NULL WHERE product_key = 'cp_null_sync'`);
  }
  const PASSING = ['anchor', 'live', 'no_ips_row', 'no_catalog'];
  const FAILING = { stale: 'catalog_not_live', suppressed: 'catalog_suppressed', tombstoned: 'catalog_suppressed',
    ips_false: 'index_not_serving_eligible', null_sync: 'catalog_not_live' };

  test('generation: the seed lane admits only listings whose catalog row may serve, and names why the rest left', async () => {
    await seedCohort();
    await seed('clara', { title: 'Donate To The Clara Lionel Foundation', brand: 'Fenty Beauty', ips: true });
    const inputs = await loadProductRelationshipGraphSourceInputs({ queryFn, market: 'US', limit: 50 });
    expect(inputs.externalSeeds.map((p) => p.product_ref).sort()).toEqual(PASSING.map((k) => `product:ext_${k}`).sort());
    expect(inputs.products.map((p) => p.product_ref).sort()).toEqual(PASSING.map((k) => `product:ext_${k}`).sort());
    expect(inputs.source_counts.catalog_serving_gate_dropped_by_reason).toEqual({
      catalog_not_live: 2, catalog_suppressed: 2, index_not_serving_eligible: 1, non_product_listing: 1 });
  });

  async function writeGeneratedLabels() {
    // The lane loader WITHOUT the gate is what produced every label already in prod.
    const products = await loadExternalProductSeedCandidates({ queryFn, market: 'US', limit: 50 });
    const anchor = products.find((p) => p.product_ref === 'product:ext_anchor');
    const written = {};
    for (const candidate of products.filter((p) => p !== anchor)) {
      const { edge } = buildEdgeForCandidate({ anchor, candidate, market: 'US', nowIso: new Date().toISOString() });
      expect(edge).toBeTruthy();
      // eslint-disable-next-line no-await-in-loop
      await upsertRelationshipCandidateLabel({ ...edge, edge_id: edge.id, label_state: 'generated' }, { queryFn });
      written[candidate.product_ref.replace('product:ext_', '')] = edge;
    }
    return written;
  }
  const keyOf = (ref) => ref.replace(/^product:ext_/, '');
  const review = async () => (await fetchCandidates({ cutoff: '2026-01-01T00:00:00Z', minScore: 0, limit: 100, queryFn }))
    .map((row) => keyOf(row.candidate_product_ref)).sort();

  test('review: labels whose candidate fails the gate are skipped, both queue orders, and come back when it passes', async () => {
    await seedCohort();
    await writeGeneratedLabels();
    const passingCandidates = PASSING.filter((k) => k !== 'anchor').sort();
    expect(await review()).toEqual(passingCandidates);
    const uncovered = await fetchCandidates({ cutoff: '2026-01-01T00:00:00Z', minScore: 0, limit: 100, queryFn, uncoveredFirst: true });
    expect(uncovered.map((row) => keyOf(row.candidate_product_ref)).sort()).toEqual(passingCandidates);
    // Skipped, not moved: nothing was written to the skipped labels.
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM relationship_candidate_labels WHERE label_state = 'generated'`);
    expect(rows[0].n).toBe(Object.keys(FAILING).length + passingCandidates.length);
    // The stale row re-syncs: its label is reviewable again with no label write.
    await db.query(`UPDATE catalog_products SET sync_status = 'live' WHERE product_key = 'cp_stale'`);
    expect(await review()).toEqual([...passingCandidates, 'stale'].sort());
  });

  test('review: a failing ANCHOR skips its labels too', async () => {
    await seedCohort();
    await writeGeneratedLabels();
    await db.query(`UPDATE catalog_products SET suppressed_at = now() WHERE product_key = 'cp_anchor'`);
    expect(await review()).toEqual([]);
  });

  test('review: a canonical re-keyed ref resolves through the ids its snapshot keeps', async () => {
    await seedCohort();
    await writeGeneratedLabels();
    // applyCanonicalAnchorRefs re-keys product_ref onto product:pg_<id> and keeps the snapshot's ids.
    await db.query(`UPDATE relationship_candidate_labels SET candidate_product_ref = 'product:pg_family_' || id`);
    expect((await fetchCandidates({ cutoff: '2026-01-01T00:00:00Z', minScore: 0, limit: 100, queryFn })).length)
      .toBe(PASSING.length - 1);
  });

  test('every resolution arm: sig, source id, product_key, seed external id, seed id', async () => {
    // key_only: the catalog row's source_product_id is NOT the seed's external id, so each arm
    // below is the only route from its key to the stale row.
    await seed('stale', { catalog: { sync_status: 'stale' }, attach: 'key_only' });
    const arms = { sig: 'sig_stale', source: 'other_stale', product_key: 'cp_stale', seed_external: 'ext_stale', seed_id: 'eps_stale' };
    const failures = await loadCatalogServingGateFailures({ queryFn,
      subjects: [...Object.entries(arms).map(([arm, key]) => ({ subject_id: arm, keys: [key] })),
        { subject_id: 'unknown', keys: ['nothing_by_this_id'] }] });
    expect(Object.fromEntries(failures)).toEqual(Object.fromEntries(Object.keys(arms).map((arm) => [arm, 'catalog_not_live'])));
  });

  test('one live sibling is enough: a ref passes when any catalog row it names may serve', async () => {
    await seed('stale', { catalog: { sync_status: 'stale' }, attach: 'key_only' });
    await db.query(`INSERT INTO catalog_products(product_key, source_product_id, pivota_signature_id, content_key)
      VALUES ('cp_stale_sibling', 'ext_stale', 'sig_sibling', 'ck_sibling')`);
    expect((await loadCatalogServingGateFailures({ queryFn, subjects: [{ subject_id: 'x', keys: ['ext_stale'] }] })).size).toBe(0);
  });

  test('the review SQL derives the same keys from a written label as the JS gate does', async () => {
    await seedCohort();
    await writeGeneratedLabels();
    const { rows } = await db.query(`SELECT candidate_product_ref, candidate_snapshot,
      array_remove(${catalogGateKeysSql('candidate_product_ref', 'candidate_snapshot')}, NULL) AS sql_keys
      FROM relationship_candidate_labels`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect([...new Set(row.sql_keys)].sort()).toEqual(catalogGateKeys(row.candidate_snapshot, row.candidate_product_ref).sort());
    }
  });

  async function approveAll() {
    await db.query(`UPDATE relationship_candidate_labels SET label_state = 'ai_approved', last_verified_at = now(),
      expires_at = now() + interval '30 days'`);
  }
  const serve = () => readApprovedRelationshipEdgesForAnchorUncollapsed({ anchorRefs: ['product:ext_anchor'], market: 'US', queryFn, limit: 100 });

  test('serving: off reads every approved edge; shadow counts the failing ones; enforce drops them', async () => {
    await seedCohort();
    await writeGeneratedLabels();
    await approveAll();
    const all = (await serve());
    expect(all.edges).toHaveLength(Object.keys(FAILING).length + PASSING.length - 1);
    expect(all.diagnostics).not.toHaveProperty('catalog_gate_mode');

    process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE = 'shadow';
    const shadow = await serve();
    expect(shadow.edges).toHaveLength(all.edges.length);
    expect(shadow.diagnostics).toMatchObject({ catalog_gate_mode: 'shadow', catalog_gate_failed_count: Object.keys(FAILING).length,
      catalog_gate_dropped_count: 0 });

    process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE = 'enforce';
    const enforced = await serve();
    expect(enforced.edges.map((edge) => keyOf(edge.candidate_product_ref)).sort())
      .toEqual(PASSING.filter((k) => k !== 'anchor').sort());
    expect(enforced.diagnostics).toMatchObject({ catalog_gate_failed_count: 5, catalog_gate_dropped_count: 5 });
  });

  test('serving enforce: a label written before the title rule, naming a live donation, stops serving', async () => {
    await seedCohort();
    const written = await writeGeneratedLabels();
    await approveAll();
    // Pre-fix label rows carried the donation's own title; the builder now refuses to emit one.
    await db.query(`UPDATE relationship_candidate_labels SET candidate_snapshot = candidate_snapshot
      || '{"name": "Donate To The Clara Lionel Foundation"}'::jsonb WHERE edge_id = $1`, [written.live.id]);
    process.env.RELATIONSHIP_GRAPH_SERVING_CATALOG_GATE_MODE = 'enforce';
    const keys = (await serve()).edges.map((edge) => keyOf(edge.candidate_product_ref));
    expect(keys).not.toContain('live');
    expect(keys.sort()).toEqual(['no_catalog', 'no_ips_row']);
  });
});
