const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { readServingSnapshot, servingProgress, SERVING_PROGRESS_SQL } = require('../../src/services/relationshipGraphServingProgress');
const { persistEdgesWithGlobalFanInCap } = require('../../scripts/build-product-relationship-graph');
const { upsertRelationshipCandidateLabel } = require('../../src/auroraBff/productRelationshipGraph');

const DATABASE_URL = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const BIN = process.env.RELGRAPH_TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@15/bin';
const postgresDescribe = (DATABASE_URL || process.env.RELGRAPH_TEST_POSTGRES === '1') ? describe : describe.skip;
postgresDescribe('truthful writes and serving metrics on throwaway local Postgres', () => {
  let dir;
  let client;
  let started = false;
  const env = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  const run = (name, args) => execFileSync(path.join(BIN, name), args, { env, stdio: 'pipe' });
  beforeAll(async () => {
    if (DATABASE_URL) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(DATABASE_URL).hostname)) throw new Error('relgraph Postgres tests require a local database');
      client = new Client({ connectionString: DATABASE_URL });
    } else {
      const net = require('node:net');
      const port = await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
      });
      dir = fs.mkdtempSync('/tmp/relgraph-uncovered-');
      run('initdb', ['-D', dir, '-A', 'trust', '--no-locale', '--encoding=UTF8']);
      run('pg_ctl', ['-D', dir, '-l', path.join(dir, 'server.log'), '-o', `-k /tmp -c listen_addresses=127.0.0.1 -p ${port}`, '-w', 'start']);
      started = true;
      client = new Client({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' });
    }
    await client.connect();
    await client.query('CREATE SCHEMA relgraph_truth_test; SET search_path TO relgraph_truth_test');
    for (const number of ['046', '048', '050', '051', '054']) {
      const file = fs.readdirSync(path.join(__dirname, '../../src/db/migrations')).find((name) => name.startsWith(`${number}_`));
      await client.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
    }
  }, 30000);
  afterAll(async () => {
    try { if (client) { await client.query('DROP SCHEMA IF EXISTS relgraph_truth_test CASCADE'); await client.end(); } } finally {
      if (started) run('pg_ctl', ['-D', dir, '-m', 'immediate', '-w', 'stop']);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const queryFn = (sql, params) => client.query(sql, params);
  const runInClient = async (fn) => fn(client);
  beforeEach(async () => { await client.query('TRUNCATE relationship_candidate_labels'); });
  function edge(anchor, candidate = 'candidate', relation = 'related_product', state = 'generated') {
    return { id: `row_${anchor}_${candidate}_${relation}`, anchor_type: 'product', anchor_ref: `product:${anchor}`,
      candidate_product_ref: `product:${candidate}`, relation_type: relation, market: 'US', label_state: state,
      anchor_snapshot: { brand: 'Brand', title: 'Hydrating Face Cream' },
      candidate_snapshot: { brand: relation === 'related_product' ? 'Brand' : 'Other', title: 'Gentle Face Cleanser' },
      score_total: 0.8, score_breakdown: { category_use_case_match: 0.8 }, category_taxonomy: ['skincare'],
      source_refs: [{ type: 'catalog_products', authoritative: true }], evidence_grade: 'B', review_status: 'approved',
      last_verified_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() };
  }
  test.each(['human_approved', 'ai_approved', 'human_rejected', 'needs_evidence'])('upsert RETURNING reports zero rows for protected %s', async (state) => {
    const existing = edge('protected', 'candidate', 'related_product', state);
    expect(await upsertRelationshipCandidateLabel(existing, { queryFn })).toMatchObject({ written: true });
    const before = (await client.query('SELECT * FROM relationship_candidate_labels')).rows;
    expect(await upsertRelationshipCandidateLabel({ ...existing, label_state: 'generated', score_total: 0.2 }, { queryFn })).toMatchObject({ id: existing.id, label_state: 'generated', written: false });
    expect((await client.query('SELECT * FROM relationship_candidate_labels')).rows).toEqual(before);
  });
  test.each(['related_product', 'competitive_alternative'])('%s path counts only real writes and protected skips', async (relation) => {
    const protectedRow = edge('protected', 'candidate', relation, 'ai_approved');
    await upsertRelationshipCandidateLabel(protectedRow, { queryFn });
    const result = await persistEdgesWithGlobalFanInCap({ edges: [protectedRow, edge('new', 'candidate', relation)], cap: 8, queryFn, runInClient });
    expect(result).toMatchObject({ applied: 1, written: 1, skipped_protected: 1 });
    expect((await client.query('SELECT count(*)::int AS count FROM relationship_candidate_labels')).rows[0].count).toBe(2);
    expect((await client.query("SELECT label_state FROM relationship_candidate_labels WHERE anchor_ref='product:protected'")).rows[0].label_state).toBe('ai_approved');
  });
  test('prefilter path skips a protected row inside the candidate transaction', async () => {
    const protectedRow = edge('protected', 'candidate', 'competitive_alternative', 'ai_approved');
    await upsertRelationshipCandidateLabel(protectedRow, { queryFn });
    const result = await persistEdgesWithGlobalFanInCap({ edges: [protectedRow, edge('bad', 'candidate', 'competitive_alternative')], cap: 8, queryFn, runInClient,
      classify: () => ({ label_state: 'prefilter_rejected', prefilter_reasons: ['category_mismatch'] }) });
    expect(result).toMatchObject({ applied: 1, skipped_protected: 1 });
    expect((await client.query("SELECT count(*)::int AS count FROM relationship_candidate_labels WHERE label_state='prefilter_rejected'")).rows[0].count).toBe(1);
  });
  test('a generated update writes a row and keeps the legacy requested id return shape', async () => {
    const row = edge('old'); await upsertRelationshipCandidateLabel(row, { queryFn });
    expect(await upsertRelationshipCandidateLabel({ ...row, id: 'requested_new_id', score_total: 0.9 }, { queryFn })).toMatchObject({ id: 'requested_new_id', edge_id: 'requested_new_id', written: true });
    expect((await client.query('SELECT id,score_total FROM relationship_candidate_labels')).rows).toEqual([{ id: row.id, score_total: 0.9 }]);
  });
  test('seeded before/after measures newly covered anchors, filters hidden/expired/unverified/wrong market and retains humans', async () => {
    const old = edge('old', 'old_candidate', 'related_product', 'ai_approved');
    await upsertRelationshipCandidateLabel(old, { queryFn });
    for (const [anchor, changes] of [
      ['pending', { label_state: 'generated' }], ['expired', { expires_at: new Date(0).toISOString() }],
      ['unverified', { last_verified_at: null }], ['wrong_market', { market: 'JP' }],
      ['dupe', { relation_type: 'dupe' }], ['nested', { candidate_product_ref: 'product:product:broken' }],
      ['same', { candidate_snapshot: old.anchor_snapshot }],
    ]) await upsertRelationshipCandidateLabel({ ...old, id: anchor, anchor_ref: `product:${anchor}`, ...changes }, { queryFn });
    const before = await readServingSnapshot({ queryFn });
    await upsertRelationshipCandidateLabel(edge('old', 'another', 'related_product', 'ai_approved'), { queryFn });
    await upsertRelationshipCandidateLabel(edge('new', 'another', 'related_product', 'ai_approved'), { queryFn });
    const human = edge('human', 'human_candidate', 'related_product', 'human_approved'); human.candidate_snapshot = human.anchor_snapshot;
    await upsertRelationshipCandidateLabel(human, { queryFn });
    const after = await readServingSnapshot({ queryFn });
    const metrics = servingProgress(before, after);
    expect(metrics).toEqual({ served_edges_before: 1, served_edges_after: 4, distinct_anchors_served_before: 1, distinct_anchors_served_after: 3, anchors_newly_covered: 2 });
    const { recordRelationshipGraphRun } = require('../../src/services/relationshipGraphRunLedger');
    await recordRelationshipGraphRun({run_id:'fixture_progress',ok:true,options:{market:'US'},...metrics,approved_count:2,review_error_count:15,review_error_rate:0.06,guard_blocked_count:1},{queryFn});
    expect((await client.query("SELECT summary FROM relationship_graph_routine_runs WHERE run_id='fixture_progress'")).rows[0].summary).toMatchObject({...metrics,approved_count:2,review_error_count:15,review_error_rate:0.06,guard_blocked_count:1});
  });
  test('shared scan retries a transient first page while an advisory-lock client is checked out', async () => {
    const db = require('../../src/db');
    const { scanServingLabels } = require('../../src/services/relationshipGraphServingScan');
    const { withPostgresAdvisoryLock } = require('../../scripts/run-relationship-graph-routine-job');
    for (let i = 0; i < 3; i++) await upsertRelationshipCandidateLabel(edge(`retry_${i}`, `candidate_${i}`, 'related_product', 'ai_approved'), { queryFn });
    const saved = Object.fromEntries(['DATABASE_URL', 'DB_SSL', 'DB_QUERY_RETRIES'].map((key) => [key, process.env[key]]));
    const params = client.connectionParameters;
    const url = new URL(`postgres://${encodeURIComponent(params.user)}@${params.host}:${params.port}/${encodeURIComponent(params.database)}`);
    if (params.password) url.password = params.password;
    url.searchParams.set('options', '-c search_path=relgraph_truth_test');
    process.env.DATABASE_URL = url.toString(); process.env.DB_SSL = 'false'; process.env.DB_QUERY_RETRIES = '1';
    const pool = db.getPool();
    const actualQuery = pool.query.bind(pool);
    let injected = false;
    const querySpy = jest.spyOn(pool, 'query').mockImplementation((sql, values) => {
      if (sql.includes('FROM relationship_candidate_labels') && !injected) {
        injected = true;
        return Promise.reject(Object.assign(new Error('injected first-page connection reset'), { code: 'ECONNRESET' }));
      }
      return actualQuery(sql, values);
    });
    let scan;
    try {
      await withPostgresAdvisoryLock({ dbLock: true, dbLockKey: 'relgraph_scan_retry_test', dbLockHeartbeatMs: 0 }, {}, async (_lock, lockClient) => {
        expect(pool.totalCount - pool.idleCount).toBeGreaterThanOrEqual(1);
        let timer;
        try {
          scan = scanServingLabels({ batchSize: 2, collectAnchors: true, queryRetryBackoffMs: 0 });
          const result = await Promise.race([scan, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('shared scan did not finish within 1000ms while holding the lock client')), 1000);
          })]);
          expect(result.servedEdges).toBe(3);
          expect(result.anchors.size).toBe(3);
          expect(querySpy).toHaveBeenCalledTimes(3); // Failed first page, successful first and final pages.
          expect((await lockClient.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);
          expect(db.getPool()).toBe(pool);
        } finally { clearTimeout(timer); }
      });
      expect(injected).toBe(true);
    } finally {
      querySpy.mockRestore();
      // On a failing mutation, releasing the held client unblocks pool.end().
      // Drain that scan before cleanup so no retry opens a pool after teardown.
      if (scan) await scan.catch(() => {});
      await db.closePool();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }, 3000);
  test.each([false, true])('view reader filters before limit and family collapse (collapse=%s)', async (collapse) => {
    const { listApprovedRelationshipEdgesForAnchor } = require('../../src/auroraBff/productRelationshipGraph');
    const old = process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
    process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = collapse ? 'true' : 'false';
    const rows = [edge('reader', 'unsafe', 'related_product', 'ai_approved'),
      edge('reader', 'human', 'related_product', 'human_approved'),
      edge('reader', 'safe1', 'related_product', 'ai_approved'), edge('reader', 'safe2', 'related_product', 'ai_approved')];
    rows[0].candidate_snapshot = rows[0].anchor_snapshot;
    rows[1].candidate_snapshot = { ...rows[1].anchor_snapshot, title: 'Hydrating Face Cream Mini' };
    rows[3].candidate_snapshot.title = 'Refreshing Toner';
    for (let i = 0; i < rows.length; i++) await upsertRelationshipCandidateLabel({ ...rows[i], score_total: 0.99 - i * 0.1 }, { queryFn });
    expect((await client.query("SELECT count(*)::int AS n FROM product_relationship_edges")).rows[0].n).toBe(4);
    const queries = [];
    const readQuery = async (sql, params) => {
      if (!sql.includes('FROM product_relationship_edges')) return { rows: [] }; // No catalog resolver tables in this isolated fixture.
      queries.push([sql, params]); return queryFn(sql, params);
    };
    try {
      const result = await listApprovedRelationshipEdgesForAnchor({ anchorRefs: ['product:reader'], limit: 2, queryFn: readQuery });
      expect(result).toHaveLength(2);
      expect(result.map((row) => row.candidate_product_ref)).toEqual(['product:human', 'product:safe1']);
      expect(result[0].label_state).toBe('human_approved');
      expect(queries[0][0]).toContain('label_state');
      expect(queries[0][1][3]).toBe(collapse ? 1000 : 4);
    } finally { if (old === undefined) delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED; else process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = old; }
  });
  test('same-brand alternatives persist, review and resolve through the alternative relation filter', async () => {
    const { buildEdgeForCandidate } = require('../../src/auroraBff/productRelationshipGraphBuilder');
    const { applyApproval, consumerCopyForKind } = require('../../scripts/review-relationship-candidate-labels');
    const { listApprovedRelationshipEdgesForAnchor } = require('../../src/auroraBff/productRelationshipGraph');
    const { relationshipEdgesToSignals } = require('../../src/agentSignals/relationshipEdgeToSignal');
    const anchor = {product_id: 'utility_anchor', brand: 'House', name: 'Classic French No Glue Press On Nails - Blush', category: 'press-on-nails'};
    const candidate = {product_id: 'utility_candidate', brand: 'House', name: 'Premium Design No Glue Press On Nails - Jewel', category: 'press-on-nails',
      category_use_case_match: 0.9, similarity_score: 0.9, source_refs: [{type: 'catalog_products'}]};
    const built = buildEdgeForCandidate({anchor, candidate, nowIso: new Date().toISOString()});
    expect(built.errors).toEqual([]); expect(built.edge.relation_type).toBe('competitive_alternative');
    await upsertRelationshipCandidateLabel({...built.edge, label_state: 'generated'}, {queryFn});
    const decision = {verdict: 'approve', confidence: 0.95, relationship_kind: 'alternative',
      rationale: 'The quoted product facts identify distinct press-on nail lines for the same manicure job.',
      ...consumerCopyForKind('alternative'),
      shared_evidence: [{anchor_fact: anchor.name, candidate_fact: candidate.name}],
    };
    const promoted = await applyApproval(built.edge, decision, queryFn);
    expect(promoted.new_label_state).toBe('ai_approved');
    const readQuery = (sql, params) => sql.includes('FROM product_relationship_edges') ? queryFn(sql, params) : Promise.resolve({rows: []});
    const approved = await listApprovedRelationshipEdgesForAnchor({anchorRefs: ['product:utility_anchor'], relationTypes: ['competitive_alternative'], queryFn: readQuery});
    expect(approved).toHaveLength(1);
    expect(approved[0].why_candidate.summary).toBe(decision.recommendation_reason);
    expect(approved[0].tradeoffs).toEqual(decision.tradeoffs);
    const signals = relationshipEdgesToSignals(approved);
    expect(signals[0].signal_type).toBe('alternative');
    expect(signals[0].value.relationship_kind).toBe('alternative');
    expect(await listApprovedRelationshipEdgesForAnchor({anchorRefs: ['product:utility_anchor'], relationTypes: ['related_product'], queryFn: readQuery})).toEqual([]);
  });
  (process.env.RELGRAPH_TEST_EXPLAIN === '1' ? test : test.skip)('70k-label metric query plan and JS guard timing', async () => {
    await client.query(`INSERT INTO relationship_candidate_labels(id,anchor_type,anchor_ref,candidate_product_ref,relation_type,market,label_state,last_verified_at,expires_at,anchor_snapshot,candidate_snapshot)
      SELECT 'bench_'||i, 'product','product:'||i,'product:c_'||i,'related_product','US',
        CASE WHEN i%10=0 THEN 'ai_approved' ELSE 'generated' END, now(),now()+interval '45 days',
        '{"brand":"Brand","title":"Hydrating Face Cream"}', '{"brand":"Brand","title":"Gentle Face Cleanser"}' FROM generate_series(1,70000) i;
      ANALYZE relationship_candidate_labels;`);
    const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SERVING_PROGRESS_SQL}`, ['US', null, 500])).rows[0]['QUERY PLAN'][0];
    const begin = performance.now(); const snapshot = await readServingSnapshot({ queryFn });
    const timing = performance.now() - begin;
    expect(snapshot.servedEdges).toBe(7000);
    expect(JSON.stringify(plan)).toContain('idx_rcl_label_state_market');
    fs.mkdirSync(path.join(__dirname, '../../work'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '../../work/relgraph-metric-plan.json'), JSON.stringify({ plan, snapshot_ms: timing, approved_rows: snapshot.servedEdges }, null, 2));
  }, 30000);
});
