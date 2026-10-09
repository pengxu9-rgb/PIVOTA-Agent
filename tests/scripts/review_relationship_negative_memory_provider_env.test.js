'use strict';

// Production never injects a provider: runReview builds it with createProviderFromEnv, and the
// negative memory compares the model that gave a verdict with that provider's model. This drives
// that path (no `provider` argument) with the env factory stubbed.

jest.mock('../../src/llm/provider', () => {
  const actual = jest.requireActual('../../src/llm/provider');
  return { ...actual, createProviderFromEnv: jest.fn() };
});

const { createProviderFromEnv } = require('../../src/llm/provider');
const {
  buildEvidence,
  buildNegativeReviewMemo,
  reviewPairFingerprint,
  runReview,
} = require('../../scripts/review-relationship-candidate-labels');

const T0 = Date.parse('2026-10-09T10:50:00.000Z');
const MODEL = 'gemini-3-flash-preview';
const REJECT = {
  verdict: 'reject', confidence: 0.82, rationale: 'Glue remover is not used alongside pre-glued clusters in this evidence.',
  relationship_kind: 'none', recommendation_reason: '', shared_evidence: [], tradeoffs: [], watchouts: [],
};

function pairRow(id) {
  return {
    id, edge_id: id, anchor_type: 'product', anchor_ref: `product:sig_anchor_${id}`,
    anchor_snapshot: { product_id: `sig_anchor_${id}`, brand: 'Impress', title: 'Impress Falsies Pre-Glued False Eyelashes - Demi Edgy', category: 'False Lashes' },
    candidate_product_ref: `product:sig_candidate_${id}`,
    candidate_snapshot: { product_id: `sig_candidate_${id}`, brand: 'Impress', title: 'Impress Lash Glue Remover', category: 'Lash Adhesive' },
    relation_type: 'related_product', market: 'US', vertical: 'beauty', category_taxonomy: ['False Lashes'], use_case: 'False Lashes',
    label_state: 'generated', score_total: 0.8, score_breakdown: {}, price_evidence: {}, source_refs: [], evidence_grade: 'B',
    why_candidate: { summary: 'Same brand, lash routine.' }, tradeoffs: [], watchouts: [], provenance: {},
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-08T10:40:00.000Z',
  };
}

function remembered(id, model) {
  const row = pairRow(id);
  const memo = buildNegativeReviewMemo(REJECT, {
    fingerprint: reviewPairFingerprint(buildEvidence(row, new Map())),
    model,
    reviewedAt: new Date(T0 - 86400000).toISOString(),
  });
  return { ...row, provenance: { ai_review_last: memo } };
}

describe('negative memory on the production (env-built) provider path', () => {
  beforeEach(() => {
    createProviderFromEnv.mockReset();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => jest.restoreAllMocks());

  test('a pair remembered for the env provider\'s model is skipped without an LLM call', async () => {
    const envProvider = { __meta: { provider: 'gemini', model: MODEL }, analyzeTextToJson: jest.fn(async () => REJECT) };
    createProviderFromEnv.mockReturnValue(envProvider);
    const rows = [remembered('known', MODEL), remembered('othermodel', 'gemini-2.5-pro')];
    const queryFn = jest.fn(async (sql) => (/^\s*SELECT[\s\S]*FROM relationship_candidate_labels/i.test(sql) ? { rows } : { rows: [] }));

    const result = await runReview({ cutoff: '2026-10-01T00:00:00Z', minScore: 0, limit: 10, queryFn, clock: () => T0 });

    expect(createProviderFromEnv).toHaveBeenCalledWith('relationship_graph_ai_review');
    expect(result.summary.negative_memory_skipped_count).toBe(1);
    expect(result.decisions.map((d) => d.id)).toEqual(['othermodel']);
    expect(envProvider.analyzeTextToJson).toHaveBeenCalledTimes(1);
  });

  test('an env provider that cannot be built skips nothing and still fails the review as before', async () => {
    createProviderFromEnv.mockImplementation(() => { throw new Error('LLM config missing'); });
    const rows = [remembered('known', MODEL)];
    const queryFn = jest.fn(async (sql) => (/^\s*SELECT[\s\S]*FROM relationship_candidate_labels/i.test(sql) ? { rows } : { rows: [] }));
    await expect(runReview({ cutoff: '2026-10-01T00:00:00Z', minScore: 0, limit: 10, queryFn, clock: () => T0 }))
      .rejects.toThrow('LLM config missing');
  });
});
