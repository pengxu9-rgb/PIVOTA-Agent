'use strict';

// Single-mode reject / uncertain / low_confidence verdicts used to leave no trace: the row stayed
// `generated`, the nightly build bumped updated_at, and the next review (or Cloud Run's retry of the
// same night) paid the LLM for the same pair again — on 2026-10-07 both attempts timed out in
// ai_review re-reviewing ~250 pairs. These tests drive the real selection, fingerprint and verdict
// persistence through runReview.

const { LlmError } = require('../../src/llm/provider');
const {
  DEFAULT_NEGATIVE_REVIEW_TTL_DAYS,
  REVIEW_VALIDATOR_VERSION,
  buildNegativeReviewMemo,
  consumerCopyForKind,
  fetchCandidates,
  negativeReviewTtlDays,
  reviewPairFingerprint,
  buildEvidence,
  runReview,
} = require('../../scripts/review-relationship-candidate-labels');

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-08T10:50:00.000Z');
const CUTOFF = '2026-10-01T00:00:00Z';

function pairRow(id, overrides = {}) {
  return {
    id,
    edge_id: id,
    anchor_type: 'product',
    anchor_ref: `product:sig_anchor_${id}`,
    anchor_snapshot: {
      product_id: `sig_anchor_${id}`,
      brand: 'Impress',
      title: 'Impress Falsies Long Lasting Pre-Glued False Eyelashes - Demi Edgy',
      category: 'False Lashes',
    },
    candidate_product_ref: `product:sig_candidate_${id}`,
    candidate_snapshot: {
      product_id: `sig_candidate_${id}`,
      brand: 'Impress',
      title: 'Impress Lash Glue Remover',
      category: 'Lash Adhesive',
    },
    relation_type: 'related_product',
    display_label: 'related_product',
    market: 'US',
    vertical: 'beauty',
    category_taxonomy: ['False Lashes'],
    use_case: 'False Lashes',
    label_state: 'generated',
    score_total: 0.8,
    score_breakdown: {},
    price_evidence: {},
    source_refs: [],
    evidence_grade: 'B',
    why_candidate: { summary: 'Same brand, lash routine.' },
    tradeoffs: [],
    watchouts: [],
    provenance: { generated_at: '2026-10-08T10:40:00.000Z' },
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-08T10:40:00.000Z',
    ...overrides,
  };
}

const REJECT = {
  verdict: 'reject',
  confidence: 0.82,
  rationale: 'Glue remover is not used alongside pre-glued clusters in this evidence.',
  relationship_kind: 'none',
  recommendation_reason: '',
  shared_evidence: [],
  tradeoffs: [],
  watchouts: [],
};
const UNCERTAIN = { ...REJECT, verdict: 'uncertain', confidence: 0.5 };
const APPROVE = {
  verdict: 'approve',
  confidence: 0.9,
  rationale: 'Same brand products used together in one lash routine.',
  relationship_kind: 'complement',
  ...consumerCopyForKind('complement'),
  shared_evidence: [{ anchor_fact: 'False Eyelashes', candidate_fact: 'Lash Glue Remover' }],
};

// A label table that evaluates the reviewer's own SQL the way Postgres would for the parts that
// matter here: label_state, LIMIT/OFFSET paging in the stated order, and the memory UPDATE.
function labelTable(initialRows) {
  const rows = initialRows.map((row) => JSON.parse(JSON.stringify(row)));
  const calls = [];
  const queryFn = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    if (/^\s*SELECT[\s\S]*FROM relationship_candidate_labels/i.test(sql)) {
      const limit = Number(params[2]);
      const offsetMatch = sql.match(/OFFSET \$(\d+)::int/);
      const offset = offsetMatch ? Number(params[Number(offsetMatch[1]) - 1]) : 0;
      const ordered = rows
        .filter((row) => row.label_state === 'generated')
        .sort((a, b) => b.score_total - a.score_total || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      return { rows: JSON.parse(JSON.stringify(ordered.slice(offset, offset + limit))) };
    }
    if (/UPDATE relationship_candidate_labels/i.test(sql) && /ai_review_last/.test(sql)) {
      const row = rows.find((r) => r.id === params[0] && r.label_state === 'generated');
      if (!row) return { rows: [] };
      row.provenance = { ...(row.provenance || {}), ai_review_last: JSON.parse(params[1]) };
      row.reviewed_at = params[2];
      return { rows: [{ id: row.id }] };
    }
    if (/UPDATE relationship_candidate_labels/i.test(sql) && /label_state = 'ai_approved'/.test(sql)) {
      const row = rows.find((r) => r.id === params[0] && r.label_state === 'generated');
      if (!row) return { rows: [] };
      row.label_state = 'ai_approved';
      return { rows: [{ id: row.id, old_label_state: 'generated', new_label_state: 'ai_approved' }] };
    }
    if (/UPDATE/i.test(sql)) throw new Error(`unexpected update: ${sql}`);
    return { rows: [] }; // supplement tables
  });
  return { rows, calls, queryFn };
}

function providerFor(verdictsByAnchor, { model = 'gemini-3-flash-preview' } = {}) {
  return {
    __meta: { provider: 'gemini', model },
    analyzeTextToJson: jest.fn(async ({ prompt }) => {
      const hit = Object.entries(verdictsByAnchor).find(([anchor]) => prompt.includes(`"anchor_ref": "product:sig_anchor_${anchor}"`));
      if (!hit) throw new Error('unexpected prompt');
      const verdict = hit[1];
      if (verdict instanceof Error) throw verdict;
      return verdict;
    }),
  };
}

async function withApply(fn) {
  const saved = process.env.RELGRAPH_AI_REVIEW_APPLY;
  process.env.RELGRAPH_AI_REVIEW_APPLY = '1';
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    return await fn();
  } finally {
    stdout.mockRestore();
    if (saved === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY;
    else process.env.RELGRAPH_AI_REVIEW_APPLY = saved;
  }
}

function review(table, provider, overrides = {}) {
  return runReview({
    cutoff: CUTOFF, minScore: 0, limit: 10, apply: true, queryFn: table.queryFn, provider, clock: () => T0, ...overrides,
  });
}

const memoUpdates = (table) => table.calls.filter(({ sql }) => /UPDATE relationship_candidate_labels/i.test(sql) && /ai_review_last/.test(sql));

describe('negative review memory', () => {
  test('TTL defaults to 30 days and reads RELGRAPH_REVIEW_NEGATIVE_TTL_DAYS', () => {
    expect(DEFAULT_NEGATIVE_REVIEW_TTL_DAYS).toBe(30);
    expect(negativeReviewTtlDays({})).toBe(30);
    expect(negativeReviewTtlDays({ RELGRAPH_REVIEW_NEGATIVE_TTL_DAYS: '7' })).toBe(7);
    expect(negativeReviewTtlDays({ RELGRAPH_REVIEW_NEGATIVE_TTL_DAYS: '0' })).toBe(0);
    expect(negativeReviewTtlDays({ RELGRAPH_REVIEW_NEGATIVE_TTL_DAYS: 'nope' })).toBe(30);
  });

  describe('pair fingerprint = what the reviewer prompt consumes', () => {
    const fp = (row, supplements = new Map()) => reviewPairFingerprint(buildEvidence(row, supplements));

    test('stable across a rebuild that only bumps bookkeeping (updated_at, provenance.generated_at, key order)', () => {
      const a = pairRow('x');
      const rebuilt = pairRow('x', {
        updated_at: '2026-10-09T10:40:00.000Z',
        provenance: { generated_at: '2026-10-09T10:40:00.000Z' },
        candidate_snapshot: { category: 'Lash Adhesive', title: 'Impress Lash Glue Remover', brand: 'Impress', product_id: 'sig_candidate_x' },
      });
      expect(fp(rebuilt)).toBe(fp(a));
      expect(fp(a)).toMatch(/^[0-9a-f]{64}$/);
    });

    test('changes when the relation, either snapshot, the evidence/source refs or a supplement changes', () => {
      const base = fp(pairRow('x'));
      expect(fp(pairRow('x', { relation_type: 'competitive_alternative' }))).not.toBe(base);
      expect(fp(pairRow('x', { candidate_snapshot: { ...pairRow('x').candidate_snapshot, title: 'Impress Lash Glue Remover 2.0' } }))).not.toBe(base);
      expect(fp(pairRow('x', { anchor_snapshot: { ...pairRow('x').anchor_snapshot, description: 'Pre-glued clusters.' } }))).not.toBe(base);
      expect(fp(pairRow('x', { source_refs: [{ type: 'retailer_page', url: 'https://example.com/p' }] }))).not.toBe(base);
      expect(fp(pairRow('x', { provenance: { curated_pair_evidence: { source: 'editor' } } }))).not.toBe(base);
      const supplements = new Map([['sig_candidate_x', { catalog: { title: 'Impress Lash Glue Remover', tags: ['remover'] } }]]);
      expect(fp(pairRow('x'), supplements)).not.toBe(base);
    });

    test('a price observation date alone does not change a non-dupe fingerprint, but does change a dupe one', () => {
      const priced = (relationType, observedAt) => pairRow('x', {
        relation_type: relationType,
        price_evidence: { anchor_price_amount: 12, candidate_price_amount: 8, price_ratio: 0.67, observed_at: observedAt },
      });
      // The builder falls back to the build time when a candidate carries no observation date.
      expect(fp(priced('related_product', '2026-10-08T10:40:00.000Z'))).toBe(fp(priced('related_product', '2026-10-09T10:40:00.000Z')));
      expect(fp(priced('dupe', '2026-10-08T10:40:00.000Z'))).not.toBe(fp(priced('dupe', '2026-10-09T10:40:00.000Z')));
      expect(fp(pairRow('x', { price_evidence: { anchor_price_amount: 12, candidate_price_amount: 9, price_ratio: 0.75 } })))
        .not.toBe(fp(pairRow('x', { price_evidence: { anchor_price_amount: 12, candidate_price_amount: 8, price_ratio: 0.67 } })));
    });
  });

  test('apply records reject / uncertain / low_confidence verdicts, never error, and keeps label_state generated', async () => {
    const table = labelTable([pairRow('rej', { score_total: 0.9 }), pairRow('unc', { score_total: 0.8 }), pairRow('low', { score_total: 0.7 }), pairRow('err', { score_total: 0.6 })]);
    const provider = providerFor({
      rej: REJECT,
      unc: UNCERTAIN,
      low: { ...APPROVE, confidence: 0.6 },
      err: new LlmError('LLM_REQUEST_FAILED', 'Vertex 503'),
    });
    const result = await withApply(() => review(table, provider));

    const written = memoUpdates(table);
    expect(written.map(({ params }) => params[0])).toEqual(['rej', 'unc', 'low']);
    for (const { sql } of written) {
      expect(sql).toMatch(/AND label_state = 'generated'/);
      expect(sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'))).not.toMatch(/label_state/);
      expect(sql).not.toMatch(/updated_at/);
      expect(sql).toMatch(/reviewed_at = \$3::timestamptz/);
    }
    const byId = Object.fromEntries(table.rows.map((row) => [row.id, row]));
    expect(byId.rej.label_state).toBe('generated');
    expect(byId.rej.provenance.generated_at).toBe('2026-10-08T10:40:00.000Z');
    expect(byId.rej.provenance.ai_review_last).toEqual({
      verdict: 'reject',
      confidence: 0.82,
      rationale_code: 'model_reject_none',
      relationship_kind: 'none',
      model: 'gemini-3-flash-preview',
      reviewer: 'codex-gpt-5.5-xhigh',
      rubric: 'v4',
      validator_version: REVIEW_VALIDATOR_VERSION,
      reviewed_at: new Date(T0).toISOString(),
      pair_fingerprint: reviewPairFingerprint(buildEvidence(pairRow('rej', { score_total: 0.9 }), new Map())),
    });
    expect(byId.rej.reviewed_at).toBe(new Date(T0).toISOString());
    expect(byId.unc.provenance.ai_review_last).toEqual(expect.objectContaining({ verdict: 'uncertain', rationale_code: 'model_uncertain_none' }));
    expect(byId.low.provenance.ai_review_last).toEqual(expect.objectContaining({
      verdict: 'low_confidence', rationale_code: 'below_min_approval_confidence', min_approval_confidence: 0.7,
    }));
    expect(byId.err.provenance.ai_review_last).toBeUndefined();
    expect(result.summary).toEqual(expect.objectContaining({
      negative_memory_recorded_count: 3,
      negative_memory_skipped_count: 0,
      negative_memory_ttl_days: 30,
      review_error_count: 1,
    }));
  });

  test('a deterministic utility rejection is remembered under its own code', async () => {
    const table = labelTable([pairRow('sem')]);
    const provider = providerFor({ sem: { ...APPROVE, relationship_kind: 'alternative', ...consumerCopyForKind('alternative') } });
    await withApply(() => review(table, provider));
    expect(table.rows[0].provenance.ai_review_last).toEqual(expect.objectContaining({ verdict: 'reject', rationale_code: 'relation_semantics_mismatch' }));
  });

  test('the approve path is unchanged and writes no memory', async () => {
    const table = labelTable([pairRow('ok')]);
    const result = await withApply(() => review(table, providerFor({ ok: APPROVE })));
    expect(memoUpdates(table)).toHaveLength(0);
    expect(table.rows[0].label_state).toBe('ai_approved');
    expect(result.summary.approved_applied_count).toBe(1);
  });

  test('dry-run writes no memory', async () => {
    const table = labelTable([pairRow('rej')]);
    await withApply(() => review(table, providerFor({ rej: REJECT }), { apply: false }));
    expect(memoUpdates(table)).toHaveLength(0);
  });

  test('selection skips a fresh negative verdict on the same pair, and re-reviews when it should', async () => {
    const remembered = (id, memo, overrides = {}) => {
      const row = pairRow(id, overrides);
      const recorded = buildNegativeReviewMemo(REJECT, {
        fingerprint: reviewPairFingerprint(buildEvidence(row, new Map())),
        model: 'gemini-3-flash-preview',
        reviewedAt: new Date(T0 - 2 * DAY_MS).toISOString(),
      });
      return { ...row, provenance: { ...row.provenance, ai_review_last: { ...recorded, ...memo } } };
    };
    const changed = remembered('changed');
    changed.candidate_snapshot = { ...changed.candidate_snapshot, title: 'Impress Lash Glue Remover (new formula)' };
    const table = labelTable([
      remembered('same', {}, { score_total: 0.95 }),
      changed,
      remembered('stale', { reviewed_at: new Date(T0 - 31 * DAY_MS).toISOString() }),
      remembered('errored', { verdict: 'error' }),
      remembered('lowfloor', { verdict: 'low_confidence', min_approval_confidence: 0.8 }),
      remembered('lowsame', { verdict: 'low_confidence', min_approval_confidence: 0.7 }),
    ]);
    const provider = providerFor({ changed: REJECT, stale: REJECT, errored: REJECT, lowfloor: REJECT });
    const result = await withApply(() => review(table, provider));

    const reviewed = result.decisions.map((d) => d.id).sort();
    expect(reviewed).toEqual(['changed', 'errored', 'lowfloor', 'stale']);
    expect(result.summary.negative_memory_skipped_count).toBe(2);
    expect(provider.analyzeTextToJson).toHaveBeenCalledTimes(4);

    // TTL 0 turns the skip off.
    const off = labelTable([remembered('same')]);
    const offResult = await withApply(() => review(off, providerFor({ same: REJECT }), { negativeTtlDays: 0 }));
    expect(offResult.decisions.map((d) => d.id)).toEqual(['same']);
  });

  test('remembered rows do not consume the review limit: selection pages past them', async () => {
    const table = labelTable([
      pairRow('r1', { score_total: 0.99 }), pairRow('r2', { score_total: 0.98 }), pairRow('r3', { score_total: 0.97 }),
      pairRow('n1', { score_total: 0.5 }), pairRow('n2', { score_total: 0.4 }), pairRow('n3', { score_total: 0.3 }),
    ]);
    await withApply(() => review(table, providerFor({ r1: REJECT, r2: REJECT, r3: REJECT }), { limit: 3 }));
    const provider = providerFor({ n1: REJECT, n2: REJECT, n3: REJECT });
    const result = await withApply(() => review(table, provider, { limit: 2, clock: () => T0 + 60000 }));
    expect(result.decisions.map((d) => d.id)).toEqual(['n1', 'n2']);
    expect(result.summary.negative_memory_skipped_count).toBe(3);
  });

  test('fetchCandidates pages with OFFSET only when asked', async () => {
    const queryFn = jest.fn(async () => ({ rows: [] }));
    await fetchCandidates({ cutoff: CUTOFF, minScore: 0, limit: 5, queryFn });
    expect(queryFn.mock.calls[0][0]).not.toMatch(/OFFSET/);
    await fetchCandidates({ cutoff: CUTOFF, minScore: 0, limit: 5, offset: 10, queryFn });
    const [sql, params] = queryFn.mock.calls[1];
    expect(sql).toMatch(/LIMIT \$3::int\s+OFFSET \$4::int/);
    expect(params).toEqual([CUTOFF, 0, 5, 10]);
  });

  test('retry idempotence: attempt 1 selects none of the pairs attempt 0 rejected', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const table = labelTable(ids.map((id, i) => pairRow(id, { score_total: 0.9 - i * 0.01 })));
    const attempt0 = providerFor(Object.fromEntries(ids.map((id) => [id, REJECT])));
    const first = await withApply(() => review(table, attempt0));
    expect(first.summary.reviewed_count).toBe(5);
    expect(first.summary.negative_memory_recorded_count).toBe(5);

    // Cloud Run retries the whole task minutes later.
    const attempt1 = providerFor({});
    const second = await withApply(() => review(table, attempt1, { clock: () => T0 + 20 * 60000 }));
    expect(attempt1.analyzeTextToJson).not.toHaveBeenCalled();
    expect(second.summary.reviewed_count).toBe(0);
    expect(second.summary.negative_memory_skipped_count).toBe(5);
    expect(memoUpdates(table)).toHaveLength(5);
  });
});
