'use strict';

const { coerceRelationshipEdge } = require('../../src/auroraBff/productRelationshipGraph');
const { combineReviews } = require('../../src/services/relationshipCrossAgentReview');
const reviewer = require('../../scripts/review-relationship-candidate-labels');
const audit = require('../../src/services/relationshipGraphQualityAudit');
const update = require('../../src/services/relationshipGraphReviewedUpdate');
const clone = value => JSON.parse(JSON.stringify(value));
const pins = { consensus_openai: 'gpt-4.1', consensus_gemini: 'gemini-3-flash-preview', audit_openai: 'gpt-5.4', audit_gemini: 'gemini-2.5-pro' };
function packet(key = 'one') {
  const description = 'Barrier face cream for daily facial moisture with ceramides and glycerin.';
  const inci = 'Water, Glycerin, Squalane, Ceramide NP, Peptide, Phenoxyethanol';
  const a = { product_id: 'a', title: 'Barrier Peptide Face Cream', brand: 'Luxury', category: 'face cream', description, ingredient_text: inci, price: 50, price_currency: 'USD' };
  const row = coerceRelationshipEdge({ id: key, edge_id: `edge-${key}`, anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: `product:${key}`,
    anchor_snapshot: a, candidate_snapshot: { ...a, product_id: key, brand: 'Value', price: 20 }, relation_type: 'competitive_alternative',
    market: 'US', vertical: 'beauty', category_taxonomy: ['face cream'], use_case: 'face cream', score_total: .9,
    score_breakdown: { category_use_case_match: .9 }, evidence_grade: 'B', label_state: 'generated',
    price_evidence: { anchor_price_amount: 50, candidate_price_amount: 20, anchor_price_currency: 'USD', candidate_price_currency: 'USD', price_ratio: .4, observed_at: new Date().toISOString() },
    source_refs: [{ type: 'catalog_products', authoritative: true }], provenance: { generated_at: new Date().toISOString() } });
  const decision = { verdict: 'approve', confidence: .95, relationship_kind: 'alternative', rationale: 'Both grounded descriptions establish the same facial moisture job.',
    shared_evidence: [{ anchor_fact: description, candidate_fact: description }], ...reviewer.consumerCopyForKind('alternative') };
  const consensus = combineReviews(row, ['openai', 'gemini'].map(provider => ({ provider, model: pins[`consensus_${provider}`], decision })));
  const blind = audit.blindedFacts(reviewer.buildEvidence(row, new Map()), row);
  const auditReviews = ['openai', 'gemini'].map(provider => ({ provider, model: pins[`audit_${provider}`], decision: { assessment: 'useful', expected_kind: 'alternative', confidence: .95,
    rationale: 'Both exact supplied descriptions establish the same facial moisture job.', shared_evidence: [{ product_a_fact: description, product_b_fact: description }] } }));
  return { key, sampled: true, arms: ['expanded'], row, consensus, auditComplete: true, audit: { assessment: 'useful', expected_kind: 'alternative' }, auditReviews,
    blind, audit_facts_fingerprint: audit.factsFingerprint(blind) };
}
function report(pairs) {
  const arm = name => {
    const members = pairs.filter(p => p.arms.includes(name)); const approved = members.filter(p => p.consensus.verdict === 'approve');
    const useful = approved.filter(p => p.audit?.assessment === 'useful'); const anchors = new Set(useful.map(p => p.row.anchor_ref)).size;
    return { anchors: 2, anchor_facts_fingerprint: 'same-frozen-anchors', sampled_proposals: members.length, consensus: { approved: approved.length },
      approval_model_audit: { total: approved.length, useful: useful.length, incorrect: approved.length - useful.length, uncertain: 0, unreviewed: 0, adjudicated: approved.length },
      bad_variants_in_approvals: 0, model_audited_useful_approved_yield_per_anchor: useful.length / 2,
      anchors_with_model_audited_useful_approval: anchors, useful_approval_anchor_coverage: anchors / 2 };
  };
  return { status: 'completed', writes: 0, product_facts_exported: false, metadata: { model_pins: pins },
    model_work: { sampled_packets: pairs.length }, arms: { baseline: arm('baseline'), expanded: arm('expanded') } };
}
function memory(pairs, options = {}) {
  let rows = []; let transaction;
  const client = { query: jest.fn(async (sql, params) => {
    if (sql === 'BEGIN') { transaction = clone(rows); return { rows: [] }; }
    if (sql === 'ROLLBACK') { rows = transaction || rows; return { rows: [] }; }
    if (sql === 'COMMIT' && options.commitFails) throw new Error('private error');
    if (/provenance->>'reviewed_update_run_id'/.test(sql)) {
      if (options.reconcileFails) throw new Error('private error');
      return { rows: rows.filter(r => r.provenance.reviewed_update_run_id === params[0]) };
    }
    if (/SELECT \*, updated_at/.test(sql)) {
      const result = rows.filter(r => r.candidate_product_ref === params[3]);
      if (options.protected) result.forEach(r => { r.label_state = 'human_approved'; });
      if (options.changed) result.forEach(r => { r.candidate_snapshot.price = 99; });
      if (options.unstamped) result.forEach(r => { delete r.provenance.reviewed_update_run_id; });
      return { rows: result };
    }
    if (/UPDATE relationship_candidate_labels/.test(sql)) {
      const row = rows.find(r => r.id === params[0]);
      if (options.casNoop) return { rows: [] };
      row.label_state = 'ai_approved'; row.provenance.ai_review = JSON.parse(params[1]);
      row.last_verified_at = new Date().toISOString(); row.expires_at = new Date(Date.now() + 86400000).toISOString();
      return { rows: [{ id: row.id, new_label_state: row.label_state }] };
    }
    if (/SELECT e\.\*/.test(sql)) return { rows: rows.filter(r => r.label_state === 'ai_approved').map(r => ({ ...r, review_status: 'approved' })) };
    return { rows: [] };
  }) };
  const persist = jest.fn(async ({ edges }) => {
    rows = edges.map(row => ({ ...clone(row), label_state: 'generated', review_row_version: '2026-10-03 00:00:00.000001+00' }));
    if (options.stagingThrows) throw new Error('private staging error');
    return { written: rows.length };
  });
  return { client, persist, getRows: () => rows };
}
test('failed, empty, uncertain and nonimproving quality gates do not connect or mutate', async () => {
  const p = packet(); const good = report([p]); expect(update.qualityGatePassed(good)).toBe(true);
  for (const modify of [r => { r.status = 'incomplete'; }, r => { r.arms.expanded.approval_model_audit.unreviewed = 1; }, r => { r.arms.expanded.bad_variants_in_approvals = 1; },
    r => { r.arms.baseline = clone(r.arms.expanded); }, r => { r.arms.expanded.approval_model_audit.total = 0; }]) {
    const r = clone(good); modify(r); const io = memory([p]);
    expect((await update.applyReviewedComparison({ report: r, pairs: [p], ...io, enabled: true })).approval_writes).toBe(0);
    expect(io.client.query).not.toHaveBeenCalled(); expect(io.persist).not.toHaveBeenCalled();
  }
});
test('independently audited consensus reaches the exact serving view, with differing label and edge IDs', async () => {
  const p = packet(); const io = memory([p]); const result = await update.applyReviewedComparison({ report: report([p]), pairs: [p], ...io, enabled: true });
  expect(result).toMatchObject({ status: 'applied_verified', staged_writes: 1, approval_writes: 1, visible_approved_edges: 1, approval_commit_confirmed: true, writes_unknown: false });
  expect(io.client.query.mock.calls.find(([sql]) => sql.includes('SELECT e.*'))[0]).toContain('l.id = e.id');
  expect(io.getRows()[0].provenance.ai_review.cross_agent_review).toEqual(p.consensus.cross_agent_review);
});
test.each(['protected', 'changed', 'unstamped', 'casNoop'])('%s source cannot be promoted after staging', async mode => {
  const p = packet(); const io = memory([p], { [mode]: true }); const result = await update.applyReviewedComparison({ report: report([p]), pairs: [p], ...io, enabled: true });
  expect(result.approval_writes).toBe(0); expect(result.protected_or_changed).toBe(1);
});
test.each(['same_provider', 'wrong_model', 'transplanted_facts', 'ungrounded_quote', 'unsampled', 'missing_pair', 'duplicate_pair'])('%s is rejected before any staging write', async mode => {
  const p = packet(); const r = report([p]); const io = memory([p]); let pairs = [p];
  if (mode === 'same_provider') p.auditReviews[1].provider = 'openai';
  if (mode === 'wrong_model') p.auditReviews[1].model = 'gemini-other';
  if (mode === 'transplanted_facts') p.blind = { ...p.blind, product_a: { ...p.blind.product_a, description: 'Another pair.' } };
  if (mode === 'ungrounded_quote') p.auditReviews[1].decision.shared_evidence[0].product_a_fact = 'Unstated clinical cure';
  if (mode === 'unsampled') p.sampled = false;
  if (mode === 'missing_pair') pairs = [];
  if (mode === 'duplicate_pair') { pairs = [p, p]; r.model_work.sampled_packets = 2; }
  await expect(update.applyReviewedComparison({ report: r, pairs, ...io, enabled: true })).rejects.toThrow();
  expect(io.persist).not.toHaveBeenCalled(); expect(io.client.query).not.toHaveBeenCalled();
});
test('partial committed staging is reconciled even when the writer then throws', async () => {
  const p = packet(); const io = memory([p], { stagingThrows: true }); const result = await update.applyReviewedComparison({ report: report([p]), pairs: [p], ...io, enabled: true });
  expect(result).toMatchObject({ status: 'failed_partial', staged_writes: 1, approval_writes: 0, reconciliation_complete: true });
});
test('unreadable staging and unconfirmed commit never claim known zero writes', async () => {
  for (const mode of ['reconcileFails', 'commitFails']) {
    const p = packet(); const io = memory([p], { [mode]: true }); const result = await update.applyReviewedComparison({ report: report([p]), pairs: [p], ...io, enabled: true });
    expect(result.status).toBe('failed_partial'); expect(result.writes_unknown).toBe(true);
  }
});
