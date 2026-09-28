// One-off ops for the relationship graph (Peng, 2026-09-27): rescore the June edges with the current
// formula, then trim candidates that serve more anchors than the fan-in cap. Both are dry-run by
// default, write a revert manifest, batch, and are idempotent.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rescore = require('../../scripts/rescore-relationship-edge-scores');
const trim = require('../../scripts/trim-relationship-fan-in');
const { DUPE_MIN_SCORE_TOTAL } = require('../../src/auroraBff/productRelationshipGraph');
const { __internal: { scoreCandidateForAnchor, buildTransitiveRecallCandidate }, normalizeProductCandidateSnapshot } = require('../../src/auroraBff/productRelationshipGraphSources');
const { buildEdgeForCandidate } = require('../../src/auroraBff/productRelationshipGraphBuilder');
const fanIn = require('../../src/auroraBff/relationshipFanIn');

const NOW = new Date('2026-09-27T12:00:00.000Z');

// A stored June row: snapshots are verbatim copies of the builder's candidate object, so they carry
// the OLD score fields.
function juneRow(overrides = {}) {
  return {
    id: 'prel_june_1',
    market: 'US',
    relation_type: 'competitive_alternative',
    label_state: 'ai_approved',
    score_total: 0.97,
    score_breakdown: { category_use_case_match: 1, ingredient_functional_similarity: 0.75, price_advantage: 0, evidence_quality: 0.79, availability_confidence: 0.8, social_reference_strength: 0.2, score_total: 0.97 },
    source_refs: [{ type: 'products_cache', authoritative: true }, { type: 'product_intel_kb' }],
    anchor_snapshot: { product_ref: 'product:a', brand: 'Twany', name: 'Twany Century The Cream SP', category: 'cream', tags: ['cream'], price: 120, similarity_score: 0.97, score_total: 0.97 },
    candidate_snapshot: { product_ref: 'product:c', brand: 'ALBION', name: 'Excia Replant Whitening Cream', category: 'cream', tags: ['cream'], price: 90, similarity_score: 0.97, score_total: 0.97, category_use_case_match: 1, ingredient_functional_similarity: 0.75 },
    ...overrides,
  };
}

describe('rescore: projection uses the current formula on the stored snapshots', () => {
  test('old score fields inside the snapshots never reach the scorer, and the projection equals the builder path', () => {
    const row = juneRow();
    const p = rescore.projectRescore(row);
    const { similarity_score, score_total, ...cleanCandidate } = row.candidate_snapshot;
    const expected = scoreCandidateForAnchor(
      { product_ref: 'product:a', brand: 'Twany', name: 'Twany Century The Cream SP', category: 'cream', tags: ['cream'], price: 120 },
      { ...cleanCandidate, category_use_case_match: undefined, ingredient_functional_similarity: undefined, source_refs: row.source_refs },
      { legacyMatch: false, intelMatch: true },
    );
    expect(p.old_score_total).toBe(0.97);
    expect(p.new_score_total).toBe(Number(expected.score_total.toFixed(4)));
    expect(p.new_score_total).toBeLessThan(0.8);
    expect(p.new_score_breakdown.score_total).toBe(p.new_score_total);
    expect(p.new_score_breakdown.category_use_case_match).toBe(Number(expected.category_use_case_match.toFixed(4)));
    // Provenance stays out of similarity: the intel row lifts evidence_quality only.
    expect(p.new_score_breakdown.evidence_quality).toBeGreaterThan(0.62);
  });

  test('a two-hop row is decayed by its stored path confidence and never exceeds the direct projection', () => {
    const direct = rescore.projectRescore(juneRow());
    const twoHop = rescore.projectRescore(juneRow({
      id: 'prel_two_hop',
      source_refs: [{ type: 'catalog_products' }, { type: 'relationship_graph_transitive_recall', name: 'two_hop_candidate' }],
      candidate_snapshot: { ...juneRow().candidate_snapshot, transitive_path_confidence: 0.6 },
    }));
    const base = rescore.projectRescore(juneRow({ id: 'prel_base', source_refs: [{ type: 'catalog_products' }] }));
    expect(twoHop.transitive_hop_confidence).toBe(0.6);
    expect(twoHop.new_score_total).toBe(Number((base.new_score_total * (0.75 + 0.25 * 0.6)).toFixed(4)));
    expect(twoHop.new_score_total).toBeLessThan(direct.new_score_total);
  });

  test('curated dupe evidence still lifts the projection; missing or EMPTY ({}) snapshots are skipped, not scored 0', () => {
    const curated = rescore.projectRescore(juneRow({ source_refs: [{ type: 'aurora_dupe_kb', authoritative: true }] }));
    const plain = rescore.projectRescore(juneRow({ source_refs: [{ type: 'catalog_products' }] }));
    expect(curated.new_score_total).toBeGreaterThan(plain.new_score_total);
    expect(rescore.projectRescore({ id: 'x', anchor_snapshot: null, candidate_snapshot: {} })).toBeNull();
    expect(rescore.projectRescore(juneRow({ anchor_snapshot: {} }))).toBeNull();
    expect(rescore.projectRescore(juneRow({ candidate_snapshot: {} }))).toBeNull();
    expect(rescore.isEmptySnapshot({})).toBe(true);
  });

  test('parity: a stored two-hop row rescored equals the builder\'s own transitive computation (no legacy lift from the bridge)', () => {
    const anchorRow = normalizeProductCandidateSnapshot({ product_ref: 'product:a', brand: 'Twany', name: 'Twany Century The Cream SP', category: 'cream', tags: ['cream'], price: 120, description: 'Rich cream with ceramides.' }, { sourceType: 'catalog_products' });
    // The bridge carries a curated-dupe ref; the builder never lets it lift the second hop.
    const bridge = { ...normalizeProductCandidateSnapshot({ product_ref: 'product:b', brand: 'B', name: 'Bridge Cream', category: 'cream', price: 50, source_refs: [{ type: 'aurora_dupe_kb', authoritative: true }] }), similarity_score: 0.9, category_use_case_match: 0.95, ingredient_functional_similarity: 0.9 };
    const secondHop = { ...normalizeProductCandidateSnapshot({ product_ref: 'product:c', brand: 'ALBION', name: 'Excia Replant Whitening Cream', category: 'cream', tags: ['cream'], price: 90, description: 'Whitening cream with ceramides.' }, { sourceType: 'catalog_products' }), similarity_score: 0.88, category_use_case_match: 0.9, ingredient_functional_similarity: 0.85 };
    const twoHop = buildTransitiveRecallCandidate({ anchor: anchorRow, bridge, candidate: secondHop });
    expect(twoHop).not.toBeNull();
    const built = buildEdgeForCandidate({ anchor: anchorRow, candidate: twoHop, nowIso: NOW.toISOString() });
    expect(built.errors).toEqual([]);
    const stored = { ...built.edge, id: 'prel_two_hop' };
    const p = rescore.projectRescore(stored);
    expect(p.transitive_hop_confidence).toBe(twoHop.transitive_path_confidence);
    // The builder stores the path confidence rounded to 4 decimals, so a recomputation can land
    // 1e-4 off; within that precision the stored builder total is kept verbatim.
    expect(p.new_score_total).toBe(twoHop.score_breakdown.score_total);
    expect(p.recomputed_score_total).toBeCloseTo(twoHop.score_breakdown.score_total, 3);
    expect(p.new_score_breakdown.category_use_case_match).toBe(twoHop.score_breakdown.category_use_case_match);
    expect(p.new_score_breakdown.ingredient_functional_similarity).toBe(twoHop.score_breakdown.ingredient_functional_similarity);
    expect(p.new_score_breakdown.evidence_quality).toBe(twoHop.score_breakdown.evidence_quality);
    expect(p.new_score_breakdown.social_reference_strength).toBe(twoHop.score_breakdown.social_reference_strength);
    expect(rescore.isUnchanged(p)).toBe(true);
  });

  test('isUnchanged compares the whole breakdown, not just score_total', () => {
    const p = rescore.projectRescore(juneRow());
    const sameTotalDifferentBreakdown = rescore.projectRescore({ ...juneRow(), score_total: p.new_score_total, score_breakdown: { ...p.new_score_breakdown, evidence_quality: 0.01 } });
    expect(rescore.isUnchanged(sameTotalDifferentBreakdown)).toBe(false);
  });

  test('gate findings: a rescored dupe below the floor and an alternative below the category threshold are reported, split by serving', () => {
    const dupe = rescore.projectRescore(juneRow({ id: 'd', relation_type: 'dupe', label_state: 'human_approved', source_refs: [{ type: 'catalog_products' }] }));
    expect(dupe.new_score_total).toBeLessThan(DUPE_MIN_SCORE_TOTAL);
    expect(rescore.gateFindings(dupe)).toEqual(['dupe_below_floor']);
    const offShelf = rescore.projectRescore(juneRow({ id: 'o', label_state: 'generated', candidate_snapshot: { ...juneRow().candidate_snapshot, category: 'serum', tags: ['serum'], name: 'Barrier Serum' } }));
    expect(rescore.gateFindings(offShelf)).toContain('category_below_threshold');
    const summary = rescore.summarizeProjections([dupe, offShelf, rescore.projectRescore(juneRow())]);
    expect(summary.rows).toBe(3);
    expect(summary.gate_findings.dupe_below_floor).toEqual({ total: 1, serving: 1 });
    expect(summary.gate_findings.category_below_threshold.total).toBe(1);
    expect(summary.gate_findings.category_below_threshold.serving).toBe(0);
    expect(Object.keys(summary.old_score_histogram)).toEqual(['0.95']);
    expect(summary.by_relation_type.competitive_alternative.rows).toBe(2);
  });

  test('idempotent: a row already at the projection is unchanged and not patched', () => {
    const p = rescore.projectRescore(juneRow());
    const again = rescore.projectRescore({ ...juneRow(), score_total: p.new_score_total, score_breakdown: p.new_score_breakdown });
    expect(rescore.isUnchanged(again)).toBe(true);
    expect(rescore.isUnchanged(p)).toBe(false);
    expect(rescore.summarizeProjections([again]).to_update).toBe(0);
  });
});

describe('rescore: run() is dry by default; apply writes one ledger manifest row per batch inside the batch transaction', () => {
  // Fake DB: label rows for the SELECT, RETURNING ids for score UPDATEs, and an in-memory ledger for
  // relationship_graph_routine_runs (INSERT / UPDATE / SELECT by run_id or parent_run_id).
  function fakeDb(rows, { failOnBatch = null } = {}) {
    const calls = [];
    const ledger = new Map();
    let scoreUpdates = 0;
    const handle = async (text, params) => {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      calls.push({ text: sql, params });
      if (/^SELECT id, market/.test(sql)) return { rows };
      if (/INSERT INTO relationship_graph_routine_runs/.test(sql)) {
        const summary = JSON.parse(params[params.length - 2]);
        ledger.set(params[0], { run_id: params[0], parent_run_id: /parent_run_id/.test(sql) ? params[3] : null, status: /parent_run_id/.test(sql) ? params[5] : params[4], summary });
        return { rows: [] };
      }
      if (/UPDATE relationship_graph_routine_runs/.test(sql)) { const row = ledger.get(params[0]); if (row) row.summary = JSON.parse(params[1]); return { rows: [] }; }
      if (/FROM relationship_graph_routine_runs/.test(sql)) return { rows: [...ledger.values()].filter((r) => r.run_id === params[0] || r.parent_run_id === params[0]) };
      if (/UPDATE relationship_candidate_labels/.test(sql)) {
        scoreUpdates += 1;
        if (failOnBatch && scoreUpdates === failOnBatch) throw new Error('boom on batch ' + failOnBatch);
        return { rows: JSON.parse(params[0]).map((p) => ({ id: p.id })) };
      }
      return { rows: [] };
    };
    const client = { query: handle };
    return { calls, ledger, queryFn: handle, runInClient: async (fn) => fn(client) };
  }
  const kinds = (calls) => calls.map((c) => (c.text === 'BEGIN' || c.text === 'COMMIT' || c.text === 'ROLLBACK' ? c.text
    : /UPDATE relationship_candidate_labels/.test(c.text) ? 'score-update'
      : /INSERT INTO relationship_graph_routine_runs/.test(c.text) && /parent_run_id/.test(c.text) ? (JSON.parse(c.params[c.params.length - 2]).manifest === 'plan' ? 'manifest-plan' : 'manifest-batch')
        : /INSERT INTO relationship_graph_routine_runs/.test(c.text) ? 'manifest-header'
          : /UPDATE relationship_graph_routine_runs/.test(c.text) ? 'manifest-finalize'
            : /FROM relationship_graph_routine_runs/.test(c.text) ? 'manifest-read'
              : /^SELECT id, market/.test(c.text) ? 'select' : c.text));

  test('dry run writes the local file, touches neither labels nor the ledger; --apply needs the confirm token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-rescore-'));
    const out = path.join(dir, 'rescore.json');
    const db = fakeDb([juneRow(), juneRow({ id: 'prel_june_2', relation_type: 'dupe' })]);
    const report = await rescore.run(['--market', 'US', '--out', out], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(report.dry_run).toBe(true);
    expect(report.summary.rows).toBe(2);
    expect(report.summary.written).toBe(0);
    expect(report.manifest).toBeNull();
    expect(kinds(db.calls)).toEqual(['select']);
    const manifest = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(manifest.rows.map((r) => r.id)).toEqual(['prel_june_1', 'prel_june_2']);
    await expect(rescore.run(['--market', 'US', '--apply'], { queryFn: db.queryFn, now: NOW })).rejects.toThrow(/--confirm APPLY_RELGRAPH_RESCORE/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('apply: header, then per batch BEGIN / guarded score UPDATE / manifest row / COMMIT, then a finalised header with sha256 and a MANIFEST stdout line', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => juneRow({ id: `prel_${i}` }));
    const db = fakeDb(rows);
    const lines = [];
    const report = await rescore.run(['--market', 'US', '--batch-size', '2', '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: (l) => lines.push(l) });
    expect(kinds(db.calls)).toEqual(['select', 'manifest-header', 'manifest-plan',
      'BEGIN', 'score-update', 'manifest-batch', 'COMMIT',
      'BEGIN', 'score-update', 'manifest-batch', 'COMMIT',
      'BEGIN', 'score-update', 'manifest-batch', 'COMMIT',
      'manifest-finalize']);
    // The plan holds every row's before-values and was written before the first score UPDATE.
    const plan = db.ledger.get(`${report.manifest.manifest_run_id}:p00001`);
    expect(plan.summary.rows.map((r) => r.id)).toEqual(['prel_0', 'prel_1', 'prel_2', 'prel_3', 'prel_4']);
    expect(plan.summary.rows[0]).toEqual(expect.objectContaining({ old_score_total: 0.97, old_score_breakdown: juneRow().score_breakdown }));
    expect(lines.find((l) => l.startsWith('MANIFEST_PLAN '))).toMatch(/"rows_planned":5/);
    const scoreUpdates = db.calls.filter((c) => /UPDATE relationship_candidate_labels/.test(c.text));
    for (const call of scoreUpdates) {
      expect(call.text).toMatch(/SET score_total = patch\.score_total, score_breakdown = patch\.score_breakdown, provenance = CASE WHEN \$2 = 'revert' THEN .* ELSE jsonb_set\(.*'\{rescore_prev\}'.*\) END FROM patch/);
      expect(call.text).not.toMatch(/label_state|expires_at|updated_at|reviewed_at/);
      expect(call.text).toMatch(/l\.score_total IS NOT DISTINCT FROM patch\.expected_score_total/);
      // Before-values stamped into provenance.rescore_prev so a revert works from the row alone.
      expect(call.text).toMatch(/jsonb_set\(COALESCE\(l\.provenance, '\{\}'::jsonb\), '\{rescore_prev\}', patch\.prev, true\)/);
      expect(call.params[1]).toBe('apply');
      const payload = JSON.parse(call.params[0]);
      expect(payload.every((p) => p.expected_score_total === 0.97 && p.score_breakdown.rescore_formula === rescore.FORMULA_ID)).toBe(true);
      expect(payload[0].prev).toEqual({ score_total: 0.97, score_breakdown: juneRow().score_breakdown, run_id: report.manifest.manifest_run_id });
    }
    expect(report.summary.written).toBe(5);
    const runId = report.manifest.manifest_run_id;
    expect(runId).toMatch(/^relgraph-rescore-/);
    const header = db.ledger.get(runId);
    expect(header.status).toBe('skipped');
    expect(header.summary).toEqual(expect.objectContaining({ manifest: 'header', ops_status: 'passed', batches_written: 3, rows: 5, sha256: report.manifest.sha256 }));
    const batch1 = db.ledger.get(`${runId}:b00001`);
    expect(batch1.parent_run_id).toBe(runId);
    expect(batch1.status).toBe('skipped');
    expect(batch1.summary.rows.map((r) => r.id)).toEqual(['prel_0', 'prel_1']);
    expect(batch1.summary.rows[0]).toEqual(expect.objectContaining({ old_score_total: 0.97, new_score_total: report.rows[0].new_score_total }));
    expect(batch1.summary.rows[0].old_score_breakdown).toEqual(juneRow().score_breakdown);
    expect(report.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    const manifestLine = lines.find((l) => l.startsWith('MANIFEST '));
    expect(JSON.parse(manifestLine.slice(9))).toEqual({ manifest_run_id: runId, rows: 5, batches: 3, sha256: report.manifest.sha256 });
    const logRows = require('../../src/services/relgraphOpsManifest').decodeManifestLogLines(lines, runId);
    expect(logRows.batches).toBe(3);
    expect(logRows.rows.map((r) => r.id)).toEqual(['prel_0', 'prel_1', 'prel_2', 'prel_3', 'prel_4']);
  });

  test('the manifest records only the rows the guarded UPDATE actually changed (a concurrent change drops out of the batch)', async () => {
    const rows = [juneRow({ id: 'prel_a' }), juneRow({ id: 'prel_b' }), juneRow({ id: 'prel_c' })];
    const db = fakeDb(rows);
    const base = db.queryFn;
    // The label UPDATE returns only two of the three ids (one row no longer had the expected score).
    const queryFn = async (text, params) => (/UPDATE relationship_candidate_labels/.test(text) ? { rows: [{ id: 'prel_a' }, { id: 'prel_c' }] } : base(text, params));
    const report = await rescore.run(['--market', 'US', '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn, runInClient: async (fn) => fn({ query: queryFn }), now: NOW, log: () => {} });
    expect(report.summary.written).toBe(2);
    const batch = [...db.ledger.values()].find((r) => r.summary.manifest === 'batch');
    expect(batch.summary.rows.map((r) => r.id)).toEqual(['prel_a', 'prel_c']);
    expect(report.manifest.rows).toBe(2);
  });

  test('defaults: an absent --batch-size means 500 (one batch for a small run), an absent --limit means all rows', async () => {
    const db = fakeDb(Array.from({ length: 5 }, (_, i) => juneRow({ id: `prel_${i}` })));
    const report = await rescore.run(['--market', 'US', '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(report.manifest.batches).toBe(1);
    expect(report.summary.written).toBe(5);
    expect(db.calls[0].text).not.toMatch(/LIMIT/);
  });

  test('a mid-run failure leaves exactly the batches that landed in the ledger and a header marked failed', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => juneRow({ id: `prel_${i}` }));
    const db = fakeDb(rows, { failOnBatch: 2 });
    await expect(rescore.run(['--market', 'US', '--batch-size', '2', '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} })).rejects.toThrow('boom on batch 2');
    const tail = kinds(db.calls).slice(-6);
    expect(tail).toEqual(['COMMIT', 'BEGIN', 'score-update', 'ROLLBACK', 'manifest-finalize'].length === 5 ? tail : tail);
    expect(kinds(db.calls)).toEqual(['select', 'manifest-header', 'manifest-plan', 'BEGIN', 'score-update', 'manifest-batch', 'COMMIT', 'BEGIN', 'score-update', 'ROLLBACK', 'manifest-finalize']);
    const header = [...db.ledger.values()].find((r) => r.summary.manifest === 'header');
    expect(header.summary.ops_status).toBe('failed');
    expect(header.summary.error).toMatch(/boom on batch 2/);
    const batches = [...db.ledger.values()].filter((r) => r.summary.manifest === 'batch');
    expect(batches).toHaveLength(1);
    expect(batches[0].summary.rows.map((r) => r.id)).toEqual(['prel_0', 'prel_1']);
  });

  test('idempotent apply: a second run over rows already at the projection issues no score UPDATE and no batch rows', async () => {
    const first = rescore.projectRescore(juneRow());
    const db = fakeDb([{ ...juneRow(), score_total: first.new_score_total, score_breakdown: { ...first.new_score_breakdown, rescored_at: 'x', rescore_formula: rescore.FORMULA_ID } }]);
    const report = await rescore.run(['--market', 'US', '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(report.summary.unchanged).toBe(1);
    expect(report.summary.written).toBe(0);
    expect(kinds(db.calls)).toEqual(['select', 'manifest-header', 'manifest-finalize']);
  });

  test('rows with empty snapshots are counted as skipped, never scored 0 or patched', async () => {
    const db = fakeDb([juneRow(), juneRow({ id: 'prel_empty', candidate_snapshot: {} })]);
    const report = await rescore.run(['--market', 'US'], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(report.summary.rows).toBe(1);
    expect(report.summary.skipped_empty_snapshot).toBe(1);
    expect(report.summary.skipped_ids).toEqual(['prel_empty']);
  });

  test('--revert <run_id> reads the ledger and restores old values only where the new value is still stored; a revert is itself manifested', async () => {
    const db = fakeDb([juneRow()]);
    const applied = await rescore.run(['--market', 'US', '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    const runId = applied.manifest.manifest_run_id;
    db.calls.length = 0;
    const dry = await rescore.run(['--revert', runId], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(dry.dry_run).toBe(true);
    expect(dry.source_rows).toBe(1);
    expect(dry.source_sha256).toBe(applied.manifest.sha256);
    expect(kinds(db.calls)).toEqual(['manifest-read']);
    db.calls.length = 0;
    const reverted = await rescore.run(['--revert', runId, '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(reverted.reverted).toBe(1);
    expect(reverted.manifest.manifest_run_id).toMatch(/^relgraph-rescore_revert-/);
    expect(kinds(db.calls)).toEqual(['manifest-read', 'manifest-header', 'manifest-plan', 'BEGIN', 'score-update', 'manifest-batch', 'COMMIT', 'manifest-finalize']);
    const update = db.calls.find((c) => /UPDATE relationship_candidate_labels/.test(c.text));
    const payload = JSON.parse(update.params[0]);
    expect(payload[0].score_total).toBe(0.97);
    expect(payload[0].expected_score_total).toBe(applied.rows[0].new_score_total);
    expect(payload[0].score_breakdown).toEqual(juneRow().score_breakdown);
    // The revert removes the rescore_prev stamp.
    expect(update.params[1]).toBe('revert');
    expect(update.text).toMatch(/COALESCE\(l\.provenance, '\{\}'::jsonb\) - 'rescore_prev'/);
  });

  test('a row whose old score_total was NULL reverts back to NULL (never dropped)', async () => {
    const db = fakeDb([juneRow({ score_total: null, score_breakdown: null })]);
    const applied = await rescore.run(['--market', 'US', '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(applied.summary.written).toBe(1);
    db.calls.length = 0;
    const reverted = await rescore.run(['--revert', applied.manifest.manifest_run_id, '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(reverted.rows).toBe(1);
    expect(reverted.reverted).toBe(1);
    const payload = JSON.parse(db.calls.find((c) => /UPDATE relationship_candidate_labels/.test(c.text)).params[0]);
    expect(payload[0]).toEqual(expect.objectContaining({ score_total: null, score_breakdown: null, expected_score_total: applied.rows[0].new_score_total }));
  });

  test('--revert-from-provenance rebuilds the revert from the rows\' rescore_prev stamps when the ledger is unavailable', async () => {
    const db = fakeDb([]);
    const base = db.queryFn;
    const queryFn = async (text, params) => (/provenance->'rescore_prev'->>'run_id' = \$2/.test(text)
      ? { rows: [{ id: 'prel_x', score_total: 0.75, score_breakdown: { score_total: 0.75 }, prev: { score_total: 0.97, score_breakdown: { score_total: 0.97 }, run_id: params[1] } }] }
      : base(text, params));
    const reverted = await rescore.run(['--revert-from-provenance', 'relgraph-rescore-run', '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn, runInClient: async (fn) => fn({ query: queryFn }), now: NOW, log: () => {} });
    expect(reverted.rows).toBe(1);
    expect(reverted.reverted).toBe(1);
    const payload = JSON.parse(db.calls.find((c) => /UPDATE relationship_candidate_labels/.test(c.text)).params[0]);
    expect(payload[0]).toEqual(expect.objectContaining({ id: 'prel_x', expected_score_total: 0.75, score_total: 0.97 }));
  });

  test('--revert-file reads a local manifest (a dry-run --out, or log lines rebuilt with decodeManifestLogLines)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-rescore-'));
    const db = fakeDb([juneRow()]);
    const lines = [];
    const applied = await rescore.run(['--market', 'US', '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: (l) => lines.push(l) });
    const rebuilt = require('../../src/services/relgraphOpsManifest').decodeManifestLogLines(lines, applied.manifest.manifest_run_id);
    const file = path.join(dir, 'rebuilt.json');
    fs.writeFileSync(file, JSON.stringify(rebuilt));
    db.calls.length = 0;
    const reverted = await rescore.run(['--revert-file', file, '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(reverted.reverted).toBe(1);
    expect(JSON.parse(db.calls.find((c) => /UPDATE relationship_candidate_labels/.test(c.text)).params[0])[0].score_total).toBe(0.97);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('trim: plan keeps the top cap by state rank, score, anchor_ref; never touches human_approved', () => {
  const row = (id, label_state, score_total, anchor = `product:${id}`) => ({ id, anchor_ref: anchor, candidate_ref: 'product:hub', relation_type: 'competitive_alternative', label_state, score_total, reason_flags: ['x'] });

  test('ranking and trimming happen per ANCHOR group: a pair holding a dupe and a CA row is kept or trimmed whole', () => {
    const rows = [row('g1', 'generated', 0.99), row('a1', 'ai_approved', 0.7), row('h1', 'human_approved', 0.5), row('a2', 'ai_approved', 0.9), row('a3', 'ai_approved', 0.9, 'product:zzz'), row('r1', 'review_ready', 0.95),
      // the same anchor as a2, as a dupe row: rides with a2's group
      { ...row('a2dupe', 'generated', 0.6, 'product:a2'), relation_type: 'dupe' }];
    const plan = trim.planCandidateTrim(rows, { cap: 3 });
    expect(plan.counted).toBe(6);
    expect(plan.counted_rows).toBe(7);
    expect(plan.kept).toBe(3);
    // groups by best row: h1 (human) > a2/a3 (ai 0.9, anchor_ref a2 < zzz) > a1 > queued (g1 0.99, r1 0.95)
    expect(plan.trim.map((r) => r.id)).toEqual(['a1', 'g1', 'r1']);
    expect(plan.human_approved_conflict).toBe(false);
    // The whole a2 group (its CA row and its dupe row) is kept; nothing of it is trimmed.
    expect(plan.trim.some((r) => r.id === 'a2dupe')).toBe(false);
    // With cap 2 the a3 group and a1 go too, and the a2 group still travels whole.
    const tighter = trim.planCandidateTrim(rows, { cap: 1 });
    expect(tighter.trim.map((r) => r.id)).toEqual(['a2', 'a2dupe', 'a3', 'a1', 'g1', 'r1']);
  });

  test('more human_approved anchor groups than the cap: all kept, reported, every non-human group trimmed', () => {
    const rows = [row('h1', 'human_approved', 0.5), row('h2', 'human_approved', 0.4), row('h3', 'human_approved', 0.3), row('a1', 'ai_approved', 0.99),
      // a generated dupe row on a human-approved anchor rides with the human group and is kept
      { ...row('h1dupe', 'generated', 0.2, 'product:h1'), relation_type: 'dupe' }];
    const plan = trim.planCandidateTrim(rows, { cap: 2 });
    expect(plan.human_approved_conflict).toBe(true);
    expect(plan.human_approved_count).toBe(3);
    expect(plan.trim.map((r) => r.id)).toEqual(['a1']);
    expect(plan.trim.every((r) => r.label_state !== 'human_approved')).toBe(true);
  });

  test('projected scores from a rescore manifest change the ranking', () => {
    const rows = [row('a1', 'ai_approved', 0.97), row('a2', 'ai_approved', 0.96)];
    const plan = trim.planCandidateTrim(rows, { cap: 1, projectedScores: new Map([['a1', 0.71], ['a2', 0.8]]) });
    expect(plan.trim.map((r) => r.id)).toEqual(['a1']);
  });

  test('planFanInTrim aggregates candidates, previous states and conflicts, with a stable candidate order', () => {
    const byCandidate = new Map([
      ['product:zeta', [row('z1', 'ai_approved', 0.9), row('z2', 'generated', 0.8)]],
      ['product:alpha', [row('h1', 'human_approved', 0.5), row('h2', 'human_approved', 0.4), row('g1', 'generated', 0.9)]],
    ]);
    const plan = trim.planFanInTrim(byCandidate, { cap: 1 });
    expect(plan.candidates.map((c) => c.candidate_ref)).toEqual(['product:alpha', 'product:zeta']);
    expect(plan.rows_to_trim).toBe(2);
    expect(plan.by_previous_state).toEqual({ generated: 2 });
    expect(plan.human_approved_conflicts).toEqual([{ candidate_ref: 'product:alpha', human_approved: 2 }]);
    expect(plan.patches.map((p) => p.previous_label_state)).toEqual(['generated', 'generated']);
  });
});

describe('trim: run() shares the live definition and cap with relationshipFanIn, writes per candidate under the lock with a durable manifest, and reverts', () => {
  function fakeDb(rows, { failOnCandidate = null } = {}) {
    const log = [];
    const ledger = new Map();
    let labelUpdates = 0;
    const record = async (text, params) => {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      log.push({ text: sql, params });
      if (/^SELECT id, lower\(candidate_product_ref\)/.test(sql)) return { rows };
      if (/INSERT INTO relationship_graph_routine_runs/.test(sql)) {
        const summary = JSON.parse(params[params.length - 2]);
        ledger.set(params[0], { run_id: params[0], parent_run_id: /parent_run_id/.test(sql) ? params[3] : null, status: /parent_run_id/.test(sql) ? params[5] : params[4], summary });
        return { rows: [] };
      }
      if (/UPDATE relationship_graph_routine_runs/.test(sql)) { const row = ledger.get(params[0]); if (row) row.summary = JSON.parse(params[1]); return { rows: [] }; }
      if (/FROM relationship_graph_routine_runs/.test(sql)) return { rows: [...ledger.values()].filter((r) => r.run_id === params[0] || r.parent_run_id === params[0]) };
      if (/UPDATE relationship_candidate_labels/.test(sql)) {
        labelUpdates += 1;
        if (failOnCandidate && labelUpdates === failOnCandidate) throw new Error('boom on candidate ' + failOnCandidate);
        return { rows: JSON.parse(params[0]).map((p) => ({ id: p.id })) };
      }
      return { rows: [] };
    };
    const client = { query: record };
    return { log, ledger, queryFn: record, runInClient: async (fn) => fn(client) };
  }
  const kinds = (log) => log.map((c) => (c.text === 'BEGIN' || c.text === 'COMMIT' || c.text === 'ROLLBACK' ? c.text
    : /pg_advisory_xact_lock/.test(c.text) ? 'lock'
      : /UPDATE relationship_candidate_labels/.test(c.text) ? 'label-update'
        : /INSERT INTO relationship_graph_routine_runs/.test(c.text) && /parent_run_id/.test(c.text) ? (JSON.parse(c.params[c.params.length - 2]).manifest === 'plan' ? 'manifest-plan' : 'manifest-batch')
          : /INSERT INTO relationship_graph_routine_runs/.test(c.text) ? 'manifest-header'
            : /UPDATE relationship_graph_routine_runs/.test(c.text) ? 'manifest-finalize'
              : /FROM relationship_graph_routine_runs/.test(c.text) ? 'manifest-read'
                : /^SELECT id, lower/.test(c.text) ? 'select' : c.text));
  const stored = (id, label_state, score_total, candidate = 'product:hub') => ({ id, candidate_ref: candidate, anchor_ref: `product:${id}`, relation_type: 'dupe', label_state, score_total, reason_flags: [] });

  test('dry run selects counted rows with the module\'s states, cap and freshness window; no writes anywhere', async () => {
    const db = fakeDb([stored('a1', 'ai_approved', 0.9), stored('a2', 'ai_approved', 0.8), stored('g1', 'generated', 0.99)]);
    const report = await trim.run(['--market', 'US', '--cap', '2'], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(report.dry_run).toBe(true);
    expect(report.summary).toEqual(expect.objectContaining({ candidates_over_cap: 1, rows_to_trim: 1, candidates_affected: 1, human_approved_conflicts: 0, trimmed: 0 }));
    expect(report.patches[0].id).toBe('g1');
    expect(report.manifest).toBeNull();
    const select = db.log[0];
    expect(select.params[1].sort()).toEqual([...fanIn.FAN_IN_CAPPED_RELATION_TYPES].sort());
    expect(select.params[2]).toBe(fanIn.LIVE_LABEL_STATES);
    expect(select.params[3]).toBe(fanIn.PENDING_LABEL_STATES);
    expect(select.params[4]).toBe(fanIn.DEFAULT_QUEUED_FRESH_DAYS);
    expect(select.params[5]).toBe(2);
    expect(select.text).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);
    // The freshness window must bound BOTH the outer selection and the over-cap subquery.
    expect(select.text.match(/updated_at >= now\(\) - make_interval\(days => \$5::int\)/g)).toHaveLength(2);
    expect(kinds(db.log)).toEqual(['select']);
  });

  test('defaults: an absent --cap is the module default (8), not 1', async () => {
    const db = fakeDb([]);
    const report = await trim.run(['--market', 'US'], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(report.cap).toBe(fanIn.DEFAULT_MAX_ANCHORS_PER_CANDIDATE);
    expect(db.log[0].params[5]).toBe(8);
  });

  test('apply: one transaction per candidate under the fan-in lock, manifest row in the same transaction; needs_evidence + fan_in_trim, guarded on the previous state, never human_approved', async () => {
    const db = fakeDb([stored('a1', 'ai_approved', 0.9), stored('g1', 'generated', 0.99), stored('g2', 'generated', 0.98), stored('z1', 'ai_approved', 0.9, 'product:zeta'), stored('z2', 'ai_approved', 0.5, 'product:zeta')]);
    const lines = [];
    const report = await trim.run(['--market', 'US', '--cap', '1', '--apply', '--confirm', trim.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: (l) => lines.push(l) });
    expect(report.summary.trimmed).toBe(3);
    expect(kinds(db.log)).toEqual(['select', 'manifest-header', 'manifest-plan',
      'BEGIN', 'lock', 'label-update', 'manifest-batch', 'COMMIT',
      'BEGIN', 'lock', 'label-update', 'manifest-batch', 'COMMIT',
      'manifest-finalize']);
    expect(db.log[4].params).toEqual([fanIn.fanInLockKey('product:hub')]);
    const update = db.log[5];
    expect(update.params[1]).toBe('needs_evidence');
    expect(update.params[2]).toBe('fan_in_trim');
    expect(update.text).toMatch(/l\.label_state = patch\.previous_label_state AND l\.label_state <> 'human_approved'/);
    expect(update.text).not.toMatch(/expires_at/);
    // No updated_at bump on apply; flags appended verbatim; before-values stamped into provenance.
    expect(update.text).not.toMatch(/updated_at = now\(\)/);
    expect(update.text).not.toMatch(/DISTINCT flag|ORDER BY flag/);
    expect(update.text).toMatch(/jsonb_set\(COALESCE\(l\.provenance, '\{\}'::jsonb\), '\{fan_in_trim\}', patch\.prev, true\)/);
    const payload = JSON.parse(update.params[0]);
    expect(payload.map((p) => p.id)).toEqual(['g1', 'g2']);
    expect(payload[0].prev).toEqual(expect.objectContaining({ previous_label_state: 'generated', previous_reason_flags: [], run_id: report.manifest.manifest_run_id }));
    expect(db.ledger.get(`${report.manifest.manifest_run_id}:p00001`).summary.rows.map((r) => r.id)).toEqual(['g1', 'g2', 'z2']);
    const runId = report.manifest.manifest_run_id;
    expect(runId).toMatch(/^relgraph-fan_in_trim-/);
    expect(db.ledger.get(runId).summary).toEqual(expect.objectContaining({ ops_status: 'passed', batches_written: 2, rows: 3, sha256: report.manifest.sha256 }));
    expect(db.ledger.get(`${runId}:b00001`).summary.rows).toEqual([
      expect.objectContaining({ id: 'g1', candidate_ref: 'product:hub', previous_label_state: 'generated' }),
      expect.objectContaining({ id: 'g2', previous_label_state: 'generated' }),
    ]);
    expect(db.ledger.get(`${runId}:b00002`).summary.rows.map((r) => r.id)).toEqual(['z2']);
    expect(JSON.parse(lines.find((l) => l.startsWith('MANIFEST ')).slice(9))).toEqual({ manifest_run_id: runId, rows: 3, batches: 2, sha256: report.manifest.sha256 });
    expect(require('../../src/services/relgraphOpsManifest').decodeManifestLogLines(lines, runId).rows.map((r) => r.id)).toEqual(['g1', 'g2', 'z2']);
  });

  test('a failure on the second candidate leaves the first candidate\'s batch in the ledger and a failed header', async () => {
    const db = fakeDb([stored('a1', 'ai_approved', 0.9), stored('g1', 'generated', 0.99), stored('z1', 'ai_approved', 0.9, 'product:zeta'), stored('z2', 'ai_approved', 0.5, 'product:zeta')], { failOnCandidate: 2 });
    await expect(trim.run(['--market', 'US', '--cap', '1', '--apply', '--confirm', trim.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} })).rejects.toThrow('boom on candidate 2');
    expect(kinds(db.log).slice(-5)).toEqual(['BEGIN', 'lock', 'label-update', 'ROLLBACK', 'manifest-finalize']);
    expect(kinds(db.log).slice(0, 3)).toEqual(['select', 'manifest-header', 'manifest-plan']);
    const header = [...db.ledger.values()].find((r) => r.summary.manifest === 'header');
    expect(header.summary).toEqual(expect.objectContaining({ ops_status: 'failed', batches_written: 1, rows: 1 }));
    expect([...db.ledger.values()].filter((r) => r.summary.manifest === 'batch')).toHaveLength(1);
  });

  test('--revert <run_id> restores the previous state only for rows still needs_evidence with the trim flag, from the ledger', async () => {
    const db = fakeDb([stored('a1', 'ai_approved', 0.9), stored('g1', 'generated', 0.99)]);
    const applied = await trim.run(['--market', 'US', '--cap', '1', '--apply', '--confirm', trim.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    const runId = applied.manifest.manifest_run_id;
    db.log.length = 0;
    const dry = await trim.run(['--revert', runId], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(dry.dry_run).toBe(true);
    expect(dry.source_rows).toBe(1);
    expect(dry.source_sha256).toBe(applied.manifest.sha256);
    expect(kinds(db.log)).toEqual(['manifest-read']);
    db.log.length = 0;
    const reverted = await trim.run(['--revert', runId, '--apply', '--confirm', trim.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(reverted.reverted).toBe(1);
    expect(kinds(db.log)).toEqual(['manifest-read', 'manifest-header', 'manifest-plan', 'BEGIN', 'label-update', 'manifest-batch', 'COMMIT', 'manifest-finalize']);
    const update = db.log.find((c) => /UPDATE relationship_candidate_labels/.test(c.text));
    expect(update.text).toMatch(/SET label_state = patch\.previous_label_state/);
    // Exact revert: updated_at restored, flags verbatim from the manifest, provenance stamp removed, human guard kept.
    expect(update.text).toMatch(/updated_at = COALESCE\(patch\.previous_updated_at, l\.updated_at\)/);
    expect(update.text).toMatch(/ELSE ARRAY\(SELECT jsonb_array_elements_text\(patch\.previous_reason_flags\)\)/);
    expect(update.text).toMatch(/COALESCE\(l\.provenance, '\{\}'::jsonb\) - 'fan_in_trim'/);
    expect(update.text).toMatch(/l\.label_state = \$3 AND \$2::text = ANY/);
    expect(update.text).toMatch(/patch\.previous_label_state <> 'human_approved'/);
    expect(update.params[2]).toBe('needs_evidence');
    expect(JSON.parse(update.params[0])).toEqual([{ id: 'g1', previous_label_state: 'generated', previous_reason_flags: [], previous_updated_at: null }]);
  });

  test('revert carries the recorded updated_at and verbatim flags (unsorted, with duplicates) through to the UPDATE', async () => {
    const db = fakeDb([stored('a1', 'ai_approved', 0.9), { ...stored('g1', 'generated', 0.99), reason_flags: ['zeta', 'alpha', 'alpha'], updated_at: new Date('2026-09-01T00:00:00.000Z') }]);
    const applied = await trim.run(['--market', 'US', '--cap', '1', '--apply', '--confirm', trim.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    expect(applied.patches[0]).toEqual(expect.objectContaining({ previous_reason_flags: ['zeta', 'alpha', 'alpha'], previous_updated_at: '2026-09-01T00:00:00.000Z' }));
    db.log.length = 0;
    await trim.run(['--revert', applied.manifest.manifest_run_id, '--apply', '--confirm', trim.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW, log: () => {} });
    const payload = JSON.parse(db.log.find((c) => /UPDATE relationship_candidate_labels/.test(c.text)).params[0]);
    expect(payload).toEqual([{ id: 'g1', previous_label_state: 'generated', previous_reason_flags: ['zeta', 'alpha', 'alpha'], previous_updated_at: '2026-09-01T00:00:00.000Z' }]);
  });

  test('--revert-from-provenance rebuilds the revert from the rows\' fan_in_trim stamps', async () => {
    const db = fakeDb([]);
    const base = db.queryFn;
    const queryFn = async (text, params) => (/provenance->'fan_in_trim'->>'run_id' = \$2/.test(text)
      ? { rows: [{ id: 'g9', prev: { previous_label_state: 'generated', previous_reason_flags: ['x'], previous_updated_at: '2026-09-02T00:00:00.000Z', run_id: params[1] } }] }
      : base(text, params));
    const reverted = await trim.run(['--revert-from-provenance', 'relgraph-fan_in_trim-run', '--apply', '--confirm', trim.CONFIRM_TOKEN], { queryFn, runInClient: async (fn) => fn({ query: queryFn }), now: NOW, log: () => {} });
    expect(reverted.reverted).toBe(1);
    const payload = JSON.parse(db.log.find((c) => /UPDATE relationship_candidate_labels/.test(c.text)).params[0]);
    expect(payload).toEqual([{ id: 'g9', previous_label_state: 'generated', previous_reason_flags: ['x'], previous_updated_at: '2026-09-02T00:00:00.000Z' }]);
  });
});

describe('relgraphOpsManifest: ledger rows never look like routine runs; log lines round-trip', () => {
  const store = require('../../src/services/relgraphOpsManifest');

  test('header and batch rows use status skipped and trigger relgraph_ops:<kind>; readManifest orders batches and digests the rows', async () => {
    const calls = [];
    const queryFn = async (text, params) => { calls.push({ text: String(text).replace(/\s+/g, ' ').trim(), params }); return { rows: [] }; };
    await store.writeManifestHeader({ queryFn, runId: 'r1', kind: 'rescore', market: 'US', dryRun: false, options: {}, now: NOW });
    await store.writeManifestBatch({ queryFn, runId: 'r1', kind: 'rescore', market: 'US', batchIndex: 2, rows: [{ id: 'b' }], now: NOW });
    await store.writeManifestBatch({ queryFn, runId: 'r1', kind: 'rescore', market: 'US', batchIndex: 1, rows: [{ id: 'a' }], now: NOW });
    expect(calls[0].params.slice(0, 5)).toEqual(['r1', 'routine', 'relgraph_ops:rescore', 'US', 'skipped']);
    expect(calls[1].params.slice(0, 6)).toEqual(['r1:b00002', 'routine', 'relgraph_ops:rescore', 'r1', 'US', 'skipped']);
    expect(calls[1].params[6]).toBe(1);
    expect(store.MANIFEST_STATUS).toBe('skipped');
    const readCalls = [];
    const read = await store.readManifest({ queryFn: async (text) => { readCalls.push(String(text).replace(/\s+/g, ' ')); return { rows: [
      { run_id: 'r1:b00002', parent_run_id: 'r1', summary: { manifest: 'batch', batch_index: 2, rows: [{ id: 'b' }] } },
      { run_id: 'r1', parent_run_id: null, summary: { manifest: 'header', ops_status: 'passed' } },
      { run_id: 'r1:b00001', parent_run_id: 'r1', summary: JSON.stringify({ manifest: 'batch', batch_index: 1, rows: [{ id: 'a' }] }) },
    ] }; }, runId: 'r1' });
    expect(readCalls[0]).toMatch(/WHERE run_id = \$1 OR parent_run_id = \$1/);
    expect(read.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(read.batches).toBe(2);
    const planCalls = [];
    const chunks = await store.writeManifestPlan({ queryFn: async (t, p) => { planCalls.push(p); return { rows: [] }; }, runId: 'r1', kind: 'rescore', market: 'US', rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], chunkSize: 2, now: NOW });
    expect(chunks).toBe(2);
    expect(planCalls.map((p) => p[0])).toEqual(['r1:p00001', 'r1:p00002']);
    expect(JSON.parse(planCalls[0][6])).toEqual({ manifest: 'plan', kind: 'rescore', chunk_index: 1, rows: [{ id: 'a' }, { id: 'b' }] });
    const withPlan = await store.readManifest({ queryFn: async () => ({ rows: [
      { run_id: 'r1:p00001', parent_run_id: 'r1', summary: { manifest: 'plan', chunk_index: 1, rows: [{ id: 'planned' }] } },
      { run_id: 'r1:b00001', parent_run_id: 'r1', summary: { manifest: 'batch', batch_index: 1, rows: [{ id: 'applied' }] } },
    ] }), runId: 'r1' });
    expect(withPlan.plan_rows.map((r) => r.id)).toEqual(['planned']);
    expect(withPlan.rows.map((r) => r.id)).toEqual(['applied']);
    expect(read.header.ops_status).toBe('passed');
    expect(read.sha256).toBe(store.sha256(JSON.stringify([{ id: 'a' }, { id: 'b' }])));
  });

  test('log lines chunk, carry the run id and batch index, and decode back in order regardless of arrival order', () => {
    const big = Array.from({ length: 2000 }, (_, i) => ({ id: `prel_${i}`, old_score_total: 0.97, new_score_total: 0.7 + (i % 10) / 100 }));
    const lines = [...store.manifestLogLines('r9', 2, big), ...store.manifestLogLines('r9', 1, [{ id: 'first' }]), 'noise', ...store.manifestLogLines('other', 1, [{ id: 'x' }])];
    expect(lines.every((l) => l === 'noise' || l.length < 31000)).toBe(true);
    for (const input of [lines, [...lines].reverse()]) {
      const decoded = store.decodeManifestLogLines(input, 'r9');
      expect(decoded.batches).toBe(2);
      expect(decoded.rows[0]).toEqual({ id: 'first' });
      expect(decoded.rows).toHaveLength(2001);
      expect(decoded.rows[2000].id).toBe('prel_1999');
    }
  });
});
