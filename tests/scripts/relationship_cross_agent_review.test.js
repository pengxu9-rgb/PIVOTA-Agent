'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runReview, reviewWithConsensus, consumerCopyForKind, buildEvidence, applyApproval,
  buildAiReview, parseArgs, createConsensusProviders } = require('../../scripts/review-relationship-candidate-labels');
const { coerceRelationshipEdge, getRelationshipEdgeServingSuppressionReasons } = require('../../src/auroraBff/productRelationshipGraph');
const { combineReviews, hasValidConsensusApproval, digest } = require('../../src/services/relationshipCrossAgentReview');

function row(relation = 'competitive_alternative') {
  const inci = 'Water, Glycerin, Squalane, Ceramide NP, Peptide, Phenoxyethanol';
  return { id: 'consensus_fixture', anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: 'product:b',
    anchor_snapshot: { product_id: 'a', title: 'Barrier Peptide Face Cream', brand: 'Luxury', category: 'face cream', price: 50, price_currency: 'USD', ingredient_text: inci },
    candidate_snapshot: { product_id: 'b', title: 'Barrier Peptide Face Cream', brand: 'Value', category: 'face cream', price: 20, price_currency: 'USD', ingredient_text: inci },
    relation_type: relation, market: 'US', vertical: 'beauty', category_taxonomy: ['face cream'], use_case: 'face cream',
    score_total: 0.9, score_breakdown: { category_use_case_match: 0.9 },
    price_evidence: { anchor_price_amount: 50, candidate_price_amount: 20, anchor_price_currency: 'USD', candidate_price_currency: 'USD', price_ratio: 0.4, observed_at: new Date().toISOString() },
    source_refs: [{ type: 'catalog_products', authoritative: true }], evidence_grade: 'B', label_state: 'generated', provenance: {},
    updated_at: '2026-10-01T00:00:00.000Z', review_row_version: '2026-10-01 00:00:00.000001+00' };
}
function verdict(kind = 'alternative', extra = {}) {
  return { verdict: 'approve', confidence: 0.94, relationship_kind: kind,
    rationale: 'Both supplied face creams have matching barrier product facts and different prices.',
    shared_evidence: [{ anchor_fact: 'Barrier Peptide Face Cream', candidate_fact: 'Barrier Peptide Face Cream' }],
    ...consumerCopyForKind(kind), ...extra };
}
function providers(first = verdict(), second = verdict()) {
  return [['openai', 'gpt-fixture', first], ['gemini', 'gemini-2.5-flash', second]].map(([provider, model, decision]) => ({
    __meta: { provider, model }, analyzeTextToJson: jest.fn(async () => {
      if (decision instanceof Error) throw decision;
      return decision;
    }),
  }));
}
function queryRows(rows, applied = true) {
  return jest.fn(async (sql, args) => {
    if (/UPDATE relationship_candidate_labels/.test(sql)) return { rows: applied ? [{ id: args[0], new_label_state: /SET\s+label_state = 'ai_approved'/.test(sql) ? 'ai_approved' : 'needs_evidence' }] : [] };
    return { rows: /FROM relationship_candidate_labels/.test(sql) ? rows : [] };
  });
}
async function review(candidate, ps, extra = {}) {
  return runReview({ cutoff: '2026-01-01', minScore: 0, limit: 10, reviewMode: 'consensus', consensusProviders: ps,
    queryFn: queryRows([candidate]), ...extra });
}

describe('GPT/Gemini independent relgraph consensus', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => { jest.spyOn(process.stdout, 'write').mockImplementation(() => true); process.env.RELGRAPH_AI_REVIEW_APPLY = '1'; });
  afterEach(() => { jest.restoreAllMocks(); process.env = { ...savedEnv }; });

  test('CLI admits dupes only through explicitly selected consensus mode', () => {
    const args = parseArgs(['--cutoff', '2026-01-01', '--review-mode', 'consensus']);
    expect(args).toMatchObject({ reviewMode: 'consensus', allowDupeAiApproval: true, excludeRelationTypes: [] });
    expect(parseArgs(['--cutoff', '2026-01-01', '--review-mode', 'consensus', '--exclude-relation-types', 'dupe']).excludeRelationTypes).toEqual(['dupe']);
    expect(() => parseArgs(['--cutoff', '2026-01-01', '--review-mode', 'typo'])).toThrow('review-mode');
  });
  test('both reviewers get identical facts without a peer answer and agreement stamps AI provenance', async () => {
    const candidate = row(); const ps = providers(); const queryFn = queryRows([candidate]);
    const result = await review(candidate, ps, { apply: true, queryFn });
    expect(result.summary).toMatchObject({ approved_count: 1, approved_applied_count: 1, human_review_required_count: 0, min_approval_confidence: 0.9 });
    expect(ps[0].analyzeTextToJson.mock.calls[0][0].prompt).toBe(ps[1].analyzeTextToJson.mock.calls[0][0].prompt);
    expect(ps[1].analyzeTextToJson.mock.calls[0][0].prompt).not.toContain('Both supplied face creams');
    const [, params] = queryFn.mock.calls.find(([sql]) => /UPDATE/.test(sql));
    expect(JSON.parse(params[1])).toMatchObject({ reviewer: 'gpt-gemini-consensus', review_basis: 'independent_cross_provider_agreement' });
    expect(result.decisions[0].new_label_state).toBe('ai_approved');
    const [sql] = queryFn.mock.calls.find(([sql]) => /UPDATE/.test(sql));
    expect(sql).toContain("label_state = 'generated'");
    expect(sql).toContain('updated_at::text = $7');
    expect(sql).toContain('source_refs IS NOT DISTINCT FROM');
    expect(sql).not.toContain('human_approved');
  });
  test.each([
    ['verdict disagreement', verdict(), verdict('alternative', { verdict: 'reject' }), 'verdict_disagreement'],
    ['kind disagreement', verdict(), verdict('substitute'), 'relationship_kind_disagreement'],
    ['uncertainty', verdict(), verdict('alternative', { verdict: 'uncertain' }), 'reviewer_uncertain'],
    ['low confidence approval', verdict(), verdict('alternative', { confidence: 0.89 }), 'reviewer_uncertain'],
    ['low confidence rejection', verdict('alternative', { verdict: 'reject', confidence: 0.8 }), verdict('alternative', { verdict: 'reject' }), 'reviewer_uncertain'],
    ['invented fact', verdict(), verdict('alternative', { shared_evidence: [{ anchor_fact: 'cures eczema', candidate_fact: 'cures eczema' }] }), 'review_evidence_invalid'],
    ['unsupported consumer claim', verdict(), verdict('alternative', { recommendation_reason: 'Clinically proven identical performance.' }), 'review_evidence_invalid'],
    ['schema error', verdict(), { verdict: 'approve' }, 'reviewer_failed'],
  ])('%s escalates without approval', async (_, first, second, reason) => {
    const result = await review(row(), providers(first, second), { apply: true });
    expect(result.summary).toMatchObject({ approved_count: 0, human_review_required_count: 1, consensus_disposition_applied_count: 1 });
    expect(result.decisions[0]).toMatchObject({ verdict: 'human_review', new_label_state: 'needs_evidence', cross_agent_review: { escalation_reason: reason } });
  });
  test('matching confident rejections are machine rejected and omitted from human queue', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-consensus-')); const out = path.join(dir, 'review.json');
    try {
      const result = await review(row(), providers(verdict('alternative', { verdict: 'reject' }), verdict('alternative', { verdict: 'reject' })), { apply: true, out });
      expect(result.summary).toMatchObject({ cross_agent_rejected_count: 1, human_review_required_count: 0, applied_count: 1, approved_applied_count: 0 });
      expect(JSON.parse(fs.readFileSync(out, 'utf8')).human_review_queue).toEqual([]);
      expect(result.decisions[0].verdict).toBe('consensus_reject');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('two confident rejections need no human even when rejected relationship kinds differ', async () => {
    const result = await review(row(), providers(verdict('alternative', { verdict: 'reject' }), verdict('substitute', { verdict: 'reject' })));
    expect(result.summary).toMatchObject({ cross_agent_rejected_count: 1, human_review_required_count: 0 });
    expect(result.decisions[0].relationship_kind).toBeNull();
  });
  test('one-provider outage queues human review and trips the existing outage breaker', async () => {
    const err = Object.assign(new Error('timeout'), { code: 'LLM_TIMEOUT' });
    const result = await review(row(), providers(verdict(), err), { apply: true, llmAttempts: 1, maxConsecutiveTransportErrors: 1 });
    expect(result.summary).toMatchObject({ review_circuit_open: true, review_error_count: 1, review_error_rate: 1, approved_count: 0, human_review_required_count: 1 });
    expect(result.decisions[0].cross_agent_review.reviews).toHaveLength(2);
  });
  test('same provider twice cannot satisfy consensus', async () => {
    const ps = providers(); ps[1].__meta.provider = 'openai'; ps[1].__meta.model = 'gpt-fixture';
    await expect(review(row(), ps)).rejects.toThrow('independent');
    expect(ps[0].analyzeTextToJson).not.toHaveBeenCalled();
  });
  test('variant siblings are blocked before either model is called', async () => {
    const candidate = row(); candidate.relation_type = 'related_product';
    candidate.anchor_snapshot = { brand: 'Missha', title: 'M Perfect Cover BB Cream #23', category: 'BB cream' };
    candidate.candidate_snapshot = { brand: 'Missha', title: 'M Perfect Cover BB Cream #27', category: 'BB cream' };
    const ps = providers(); const result = await review(candidate, ps);
    expect(result.decisions[0].verdict).toBe('guard_blocked');
    ps.forEach((provider) => expect(provider.analyzeTextToJson).not.toHaveBeenCalled());
  });
  test('grounded cross-brand dupe consensus can be served, legacy single-model dupes remain quarantined', async () => {
    const candidate = row('dupe');
    const result = await review(candidate, providers(verdict('dupe'), verdict('dupe')), { apply: true });
    expect(result.decisions[0].verdict).toBe('approve');
    const ai_review = buildAiReview(result.decisions[0]);
    const edge = { ...candidate, label_state: 'ai_approved', provenance: { ai_review } };
    expect(getRelationshipEdgeServingSuppressionReasons(edge)).not.toContain('ai_approved_dupe_quarantined');
    expect(getRelationshipEdgeServingSuppressionReasons({ ...edge, provenance: {} })).toContain('ai_approved_dupe_quarantined');
    for (const changed of [
      { ...edge, candidate_snapshot: { ...edge.candidate_snapshot, price: 19 } },
      { ...edge, price_evidence: { ...edge.price_evidence, price_ratio: 0.3 } },
      { ...edge, market: 'JP' },
      { ...edge, source_refs: [] },
    ]) expect(getRelationshipEdgeServingSuppressionReasons(changed)).toContain('ai_approved_dupe_quarantined');
    const now = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(now + 15 * 86400000);
    expect(getRelationshipEdgeServingSuppressionReasons(edge)).toContain('ai_approved_dupe_quarantined');
  });
  test.each(['missing_formula', 'stale_price', 'mixed_currency', 'equal_price', 'zero_price', 'future_price'])('matching dupe approvals fail %s evidence checks', async (issue) => {
    const candidate = row('dupe');
    if (issue === 'missing_formula') { delete candidate.anchor_snapshot.ingredient_text; delete candidate.candidate_snapshot.ingredient_text; }
    if (issue === 'stale_price') candidate.price_evidence.observed_at = '2020-01-01';
    if (issue === 'mixed_currency') candidate.price_evidence.candidate_price_currency = 'JPY';
    if (issue === 'equal_price') { candidate.candidate_snapshot.price = 50; candidate.price_evidence.candidate_price_amount = 50; candidate.price_evidence.price_ratio = 1; }
    if (issue === 'zero_price') { candidate.candidate_snapshot.price = 0; candidate.price_evidence.candidate_price_amount = 0; candidate.price_evidence.price_ratio = 0; }
    if (issue === 'future_price') candidate.price_evidence.observed_at = new Date(Date.now() + 86400000).toISOString();
    const result = await review(candidate, providers(verdict('dupe'), verdict('dupe')));
    expect(result.decisions[0]).toMatchObject({ verdict: 'human_review', cross_agent_review: { escalation_reason: 'review_evidence_invalid' } });
  });
  test('apply rechecks both decisions, rejects missing revision and refuses proof replay', async () => {
    const candidate = row(); const evidence = buildEvidence(candidate, new Map());
    const decision = await reviewWithConsensus(candidate, evidence, providers(), { attempts: 1, confidenceFloor: 0.9 });
    const queryFn = jest.fn();
    await expect(applyApproval({ ...candidate, review_row_version: null }, decision, queryFn, { requireConsensus: true, evidence })).rejects.toThrow('stale');
    await expect(applyApproval(candidate, decision, queryFn)).rejects.toThrow('consensus apply path');
    decision.cross_agent_review.reviews[1].decision.shared_evidence[0].anchor_fact = 'invented efficacy';
    const { review_fingerprint, ...payload } = decision.cross_agent_review;
    decision.cross_agent_review.review_fingerprint = digest(payload);
    await expect(applyApproval(candidate, decision, queryFn, { requireConsensus: true, evidence })).rejects.toThrow('apply-time evidence');
    expect(queryFn).not.toHaveBeenCalled();
    await expect(review(candidate, providers(), { verdictsFile: '/ignored' })).rejects.toThrow('replay');
  });
  test('concurrent human promotion produces guarded noop', async () => {
    const result = await review(row(), providers(), { apply: true, queryFn: queryRows([row()], false) });
    expect(result.summary.approved_applied_count).toBe(0);
    expect(result.decisions[0].applied).toBe(false);
  });
  test('malformed or tampered persisted proof does not lift dupe quarantine', () => {
    const edge = coerceRelationshipEdge(row('dupe'));
    expect(hasValidConsensusApproval(edge, { schema: 'relgraph.cross_agent_review.v1', verdict: 'approve' })).toBe(false);
    const proof = combineReviews(edge, providers().map((p) => ({ ...p.__meta, decision: verdict('dupe') }))).cross_agent_review;
    proof.reviews[1].decision.confidence = 1;
    expect(hasValidConsensusApproval(edge, proof)).toBe(false);
  });
  test('factory requires explicit model pins rather than inherited shopping model defaults', () => {
    delete process.env.RELGRAPH_REVIEW_OPENAI_MODEL; delete process.env.RELGRAPH_REVIEW_GEMINI_MODEL;
    expect(() => createConsensusProviders()).toThrow('explicit');
  });
});
