// One-off ops for the relationship graph (Peng, 2026-09-27): rescore the June edges with the current
// formula, then trim candidates that serve more anchors than the fan-in cap. Both are dry-run by
// default, write a revert manifest, batch, and are idempotent.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rescore = require('../../scripts/rescore-relationship-edge-scores');
const trim = require('../../scripts/trim-relationship-fan-in');
const { DUPE_MIN_SCORE_TOTAL } = require('../../src/auroraBff/productRelationshipGraph');
const { __internal: { scoreCandidateForAnchor } } = require('../../src/auroraBff/productRelationshipGraphSources');
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

  test('curated dupe evidence still lifts the projection; rows without snapshots are skipped', () => {
    const curated = rescore.projectRescore(juneRow({ source_refs: [{ type: 'aurora_dupe_kb', authoritative: true }] }));
    const plain = rescore.projectRescore(juneRow({ source_refs: [{ type: 'catalog_products' }] }));
    expect(curated.new_score_total).toBeGreaterThan(plain.new_score_total);
    expect(rescore.projectRescore({ id: 'x', anchor_snapshot: null, candidate_snapshot: {} })).toBeNull();
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

describe('rescore: run() is dry by default, batches guarded UPDATEs of score fields only, and reverts from its manifest', () => {
  function fakeDb(rows) {
    const calls = [];
    const queryFn = async (text, params) => {
      calls.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
      if (/^SELECT id, market/.test(String(text).trim())) return { rows };
      if (/UPDATE relationship_candidate_labels/.test(text)) return { rows: JSON.parse(params[0]).map((p) => ({ id: p.id })) };
      return { rows: [] };
    };
    return { calls, queryFn };
  }

  test('dry run writes the manifest and performs no UPDATE; --apply needs the confirm token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-rescore-'));
    const out = path.join(dir, 'rescore.json');
    const db = fakeDb([juneRow(), juneRow({ id: 'prel_june_2', relation_type: 'dupe' })]);
    const report = await rescore.run(['--market', 'US', '--out', out], { queryFn: db.queryFn, now: NOW });
    expect(report.dry_run).toBe(true);
    expect(report.summary.rows).toBe(2);
    expect(report.summary.written).toBe(0);
    expect(db.calls.filter((c) => /UPDATE/.test(c.text))).toHaveLength(0);
    const select = db.calls[0];
    expect(select.params[0]).toEqual(rescore.DEFAULT_RELATION_TYPES);
    expect(select.params[1]).toEqual(rescore.DEFAULT_LABEL_STATES);
    expect(select.params[2]).toBe('us');
    const manifest = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(manifest.rows.map((r) => r.id)).toEqual(['prel_june_1', 'prel_june_2']);
    expect(manifest.rows[0]).toEqual(expect.objectContaining({ old_score_total: 0.97, new_score_total: report.rows[0].new_score_total }));
    await expect(rescore.run(['--market', 'US', '--apply'], { queryFn: db.queryFn, now: NOW })).rejects.toThrow(/--confirm APPLY_RELGRAPH_RESCORE/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('apply: SET touches only score_total and score_breakdown, guarded on the expected old score, in batches', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => juneRow({ id: `prel_${i}` }));
    const db = fakeDb(rows);
    const report = await rescore.run(['--market', 'US', '--batch-size', '2', '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, now: NOW });
    const updates = db.calls.filter((c) => /UPDATE relationship_candidate_labels/.test(c.text));
    expect(updates).toHaveLength(3);
    expect(report.summary.written).toBe(5);
    for (const call of updates) {
      expect(call.text).toMatch(/SET score_total = patch\.score_total, score_breakdown = patch\.score_breakdown FROM patch/);
      expect(call.text).not.toMatch(/label_state|expires_at|updated_at|reviewed_at/);
      expect(call.text).toMatch(/l\.score_total IS NOT DISTINCT FROM patch\.expected_score_total/);
      const payload = JSON.parse(call.params[0]);
      expect(payload.every((p) => p.expected_score_total === 0.97 && p.score_breakdown.rescore_formula === rescore.FORMULA_ID)).toBe(true);
    }
  });

  test('idempotent apply: a second run over rows already at the projection issues no UPDATE', async () => {
    const first = rescore.projectRescore(juneRow());
    const db = fakeDb([{ ...juneRow(), score_total: first.new_score_total, score_breakdown: { ...first.new_score_breakdown, rescored_at: 'x', rescore_formula: rescore.FORMULA_ID } }]);
    const report = await rescore.run(['--market', 'US', '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, now: NOW });
    expect(report.summary.unchanged).toBe(1);
    expect(report.summary.written).toBe(0);
    expect(db.calls.filter((c) => /UPDATE/.test(c.text))).toHaveLength(0);
  });

  test('revert restores old values from the manifest only where the new value is still stored', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-rescore-'));
    const out = path.join(dir, 'rescore.json');
    const db = fakeDb([juneRow()]);
    await rescore.run(['--market', 'US', '--out', out], { queryFn: db.queryFn, now: NOW });
    const dryRevert = await rescore.run(['--revert', out], { queryFn: db.queryFn, now: NOW });
    expect(dryRevert.dry_run).toBe(true);
    expect(dryRevert.reverted).toBe(0);
    const applied = await rescore.run(['--revert', out, '--apply', '--confirm', rescore.CONFIRM_TOKEN], { queryFn: db.queryFn, now: NOW });
    expect(applied.reverted).toBe(1);
    const update = db.calls.filter((c) => /UPDATE relationship_candidate_labels/.test(c.text)).pop();
    const payload = JSON.parse(update.params[0]);
    expect(payload[0].score_total).toBe(0.97);
    expect(payload[0].expected_score_total).toBeLessThan(0.97);
    expect(payload[0].score_breakdown.score_total).toBe(0.97);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('trim: plan keeps the top cap by state rank, score, anchor_ref; never touches human_approved', () => {
  const row = (id, label_state, score_total, anchor = `product:${id}`) => ({ id, anchor_ref: anchor, candidate_ref: 'product:hub', relation_type: 'competitive_alternative', label_state, score_total, reason_flags: ['x'] });

  test('ranking and trimming', () => {
    const rows = [row('g1', 'generated', 0.99), row('a1', 'ai_approved', 0.7), row('h1', 'human_approved', 0.5), row('a2', 'ai_approved', 0.9), row('a3', 'ai_approved', 0.9, 'product:zzz'), row('r1', 'review_ready', 0.95)];
    const plan = trim.planCandidateTrim(rows, { cap: 3 });
    expect(plan.kept).toBe(3);
    // queued rows rank below every ai_approved row; among them score decides (g1 0.99 before r1 0.95).
    expect(plan.trim.map((r) => r.id)).toEqual(['a1', 'g1', 'r1']);
    expect(plan.human_approved_conflict).toBe(false);
  });

  test('more human_approved rows than the cap: all kept, reported, every non-human row trimmed', () => {
    const rows = [row('h1', 'human_approved', 0.5), row('h2', 'human_approved', 0.4), row('h3', 'human_approved', 0.3), row('a1', 'ai_approved', 0.99)];
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

describe('trim: run() shares the live definition and cap with relationshipFanIn, writes per candidate under the lock, and reverts', () => {
  function fakeDb(rows) {
    const log = [];
    const record = async (text, params) => {
      log.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
      if (/^SELECT id, lower\(candidate_product_ref\)/.test(String(text).trim())) return { rows };
      if (/UPDATE relationship_candidate_labels/.test(text)) return { rows: JSON.parse(params[0]).map((p) => ({ id: p.id })) };
      return { rows: [] };
    };
    const client = { query: record };
    return { log, queryFn: record, runInClient: async (fn) => fn(client) };
  }
  const stored = (id, label_state, score_total) => ({ id, candidate_ref: 'product:hub', anchor_ref: `product:${id}`, relation_type: 'dupe', label_state, score_total, reason_flags: [] });

  test('dry run selects counted rows with the module\'s states, cap and freshness window; no writes', async () => {
    const db = fakeDb([stored('a1', 'ai_approved', 0.9), stored('a2', 'ai_approved', 0.8), stored('g1', 'generated', 0.99)]);
    const report = await trim.run(['--market', 'US', '--cap', '2'], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW });
    expect(report.dry_run).toBe(true);
    expect(report.summary).toEqual(expect.objectContaining({ candidates_over_cap: 1, rows_to_trim: 1, candidates_affected: 1, human_approved_conflicts: 0, trimmed: 0 }));
    expect(report.patches[0].id).toBe('g1');
    const select = db.log[0];
    expect(select.params[1].sort()).toEqual([...fanIn.FAN_IN_CAPPED_RELATION_TYPES].sort());
    expect(select.params[2]).toBe(fanIn.LIVE_LABEL_STATES);
    expect(select.params[3]).toBe(fanIn.PENDING_LABEL_STATES);
    expect(select.params[4]).toBe(fanIn.DEFAULT_QUEUED_FRESH_DAYS);
    expect(select.params[5]).toBe(2);
    expect(select.text).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);
    // The freshness window must bound BOTH the outer selection and the over-cap subquery.
    expect(select.text.match(/updated_at >= now\(\) - make_interval\(days => \$5::int\)/g)).toHaveLength(2);
    expect(db.log.filter((c) => /UPDATE/.test(c.text))).toHaveLength(0);
    expect(report.cap).toBe(fanIn.DEFAULT_MAX_ANCHORS_PER_CANDIDATE === 8 ? 2 : report.cap);
  });

  test('apply: one transaction per candidate under the fan-in lock; moves to needs_evidence + fan_in_trim, guarded on the previous state, never human_approved', async () => {
    const db = fakeDb([stored('a1', 'ai_approved', 0.9), stored('g1', 'generated', 0.99), stored('g2', 'generated', 0.98)]);
    const report = await trim.run(['--market', 'US', '--cap', '1', '--apply', '--confirm', trim.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW });
    expect(report.summary.trimmed).toBe(2);
    const kinds = db.log.slice(1).map((c) => (c.text === 'BEGIN' ? 'begin' : /pg_advisory_xact_lock/.test(c.text) ? 'lock' : /UPDATE/.test(c.text) ? 'update' : c.text));
    expect(kinds).toEqual(['begin', 'lock', 'update', 'COMMIT']);
    expect(db.log[2].params).toEqual([fanIn.fanInLockKey('product:hub')]);
    const update = db.log[3];
    expect(update.params[1]).toBe('needs_evidence');
    expect(update.params[2]).toBe('fan_in_trim');
    expect(update.text).toMatch(/l\.label_state = patch\.previous_label_state AND l\.label_state <> 'human_approved'/);
    expect(update.text).not.toMatch(/expires_at/);
    expect(JSON.parse(update.params[0]).map((p) => p.id)).toEqual(['g1', 'g2']);
  });

  test('revert restores the previous state only for rows still needs_evidence with the trim flag', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-trim-'));
    const out = path.join(dir, 'trim.json');
    const db = fakeDb([stored('a1', 'ai_approved', 0.9), stored('g1', 'generated', 0.99)]);
    await trim.run(['--market', 'US', '--cap', '1', '--out', out], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW });
    const applied = await trim.run(['--revert', out, '--apply', '--confirm', trim.CONFIRM_TOKEN], { queryFn: db.queryFn, runInClient: db.runInClient, now: NOW });
    expect(applied.reverted).toBe(1);
    const update = db.log.filter((c) => /UPDATE relationship_candidate_labels/.test(c.text)).pop();
    expect(update.text).toMatch(/SET label_state = patch\.previous_label_state/);
    expect(update.text).toMatch(/array_remove/);
    expect(update.text).toMatch(/l\.label_state = \$3 AND \$2::text = ANY/);
    expect(update.params[2]).toBe('needs_evidence');
    expect(JSON.parse(update.params[0])).toEqual([{ id: 'g1', previous_label_state: 'generated' }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
