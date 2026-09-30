const {
  AI_APPROVAL_FRESHNESS_INTERVAL,
  applyApproval,
  buildAiReview,
  fetchCandidates,
  parseArgs,
  runReview,
  servingGuardReasonsIfApproved,
} = require('../../scripts/review-relationship-candidate-labels');
const { getRelationshipEdgeServingSuppressionReasons } = require('../../src/auroraBff/productRelationshipGraph');

// Titles are the pair the prod serving-guard audit printed on 2026-09-29 (two styles of one
// Impress lash line approved as related_product), i.e. what the builder actually emits.
function labelRow(id, overrides = {}) {
  return {
    id,
    edge_id: id,
    anchor_type: 'product',
    anchor_ref: `product:sig_anchor_${id}`,
    anchor_snapshot: {
      product_id: `sig_anchor_${id}`,
      brand: 'Impress',
      title: 'Impress Falsies Long Lasting Pre-Glued False Eyelashes - Demi Edgy | 48 Lash Clusters, Up To 5 Day Wear, 8mm-16mm',
      category: 'False Lashes',
    },
    candidate_product_ref: `product:sig_candidate_${id}`,
    candidate_snapshot: {
      product_id: `sig_candidate_${id}`,
      brand: 'Impress',
      title: 'Impress Falsies Long Lasting Pre-Glued False Eyelashes - Demi Bold | 48 Lash Clusters, Up To 5 Day Wear, 8mm-16mm',
      category: 'False Lashes',
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
    why_candidate: { summary: 'Same brand, same line.' },
    tradeoffs: [],
    watchouts: [],
    provenance: {},
    created_at: '2026-09-29T00:00:00.000Z',
    updated_at: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

function genuineRelatedRow(id) {
  return labelRow(id, {
    candidate_snapshot: {
      product_id: `sig_candidate_${id}`,
      brand: 'Impress',
      title: 'Impress Lash Glue Remover',
      category: 'Lash Adhesive',
    },
  });
}

const APPROVE = {
  verdict: 'approve',
  confidence: 0.9,
  rationale: 'Same brand products used together in one lash routine.',
};

describe('review-relationship-candidate-labels', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('applyApproval stamps freshness for future ai approvals', async () => {
    const row = { id: 'rcl_fixture' };
    const decision = {
      confidence: 0.91,
      rationale: 'Both products have matching serum category and facial barrier support use case.',
    };
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          id: row.id,
          old_label_state: 'generated',
          new_label_state: 'ai_approved',
        },
      ],
    }));

    const applied = await applyApproval(row, decision, queryFn);

    expect(applied).toEqual({
      id: row.id,
      old_label_state: 'generated',
      new_label_state: 'ai_approved',
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
    const [sql, params] = queryFn.mock.calls[0];
    expect(sql).toMatch(/label_state = 'ai_approved'/);
    expect(sql).toMatch(/last_verified_at = now\(\)/);
    expect(sql).toMatch(/expires_at = now\(\) \+ \$3::interval/);
    expect(sql).toMatch(/AND label_state = 'generated'/);
    expect(params).toEqual([
      row.id,
      JSON.stringify(buildAiReview(decision)),
      AI_APPROVAL_FRESHNESS_INTERVAL,
    ]);
  });

  test('parseArgs excludes dupe AI approvals by default unless explicitly allowed', () => {
    const args = parseArgs(['--cutoff', '2026-06-01T00:00:00Z']);

    expect(args.excludeRelationTypes).toEqual(['dupe']);
    expect(args.allowDupeAiApproval).toBe(false);

    const allowed = parseArgs([
      '--cutoff',
      '2026-06-01T00:00:00Z',
      '--allow-dupe-ai-approval',
      '--relation-types',
      'dupe,related_product',
    ]);

    expect(allowed.excludeRelationTypes).toEqual([]);
    expect(allowed.allowDupeAiApproval).toBe(true);
    expect(allowed.relationTypes).toEqual(['dupe', 'related_product']);
  });

  test('fetchCandidates applies relation type include/exclude filters', async () => {
    const queryFn = jest.fn(async () => ({ rows: [] }));

    await fetchCandidates({
      cutoff: '2026-06-01T00:00:00Z',
      minScore: 0.7,
      limit: 50,
      ids: ['rcl_fixture'],
      relationTypes: ['related_product', 'dupe'],
      excludeRelationTypes: ['dupe'],
      queryFn,
    });

    const [sql, params] = queryFn.mock.calls[0];
    expect(sql).toMatch(/COALESCE\(updated_at, created_at\) >= \$1::timestamptz/);
    expect(sql).toMatch(/id = ANY\(\$4::text\[\]\)/);
    expect(sql).toMatch(/relation_type = ANY\(\$5::text\[\]\)/);
    expect(sql).toMatch(/NOT \(relation_type = ANY\(\$6::text\[\]\)\)/);
    expect(params).toEqual([
      '2026-06-01T00:00:00Z',
      0.7,
      50,
      ['rcl_fixture'],
      ['related_product', 'dupe'],
      ['dupe'],
    ]);
  });

  test('applyApproval blocks dupe promotion unless explicitly allowed', async () => {
    const decision = {
      confidence: 0.91,
      rationale: 'Products are close substitutes with matching category and lower price.',
    };
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          id: 'dupe_fixture',
          old_label_state: 'generated',
          new_label_state: 'ai_approved',
        },
      ],
    }));

    await expect(
      applyApproval({ id: 'dupe_fixture', relation_type: 'dupe' }, decision, queryFn),
    ).rejects.toMatchObject({
      code: 'DUPE_AI_APPROVAL_BLOCKED',
    });
    expect(queryFn).not.toHaveBeenCalled();

    const applied = await applyApproval(
      { id: 'dupe_fixture', relation_type: 'dupe' },
      decision,
      queryFn,
      { allowDupeAiApproval: true },
    );

    expect(applied).toEqual({
      id: 'dupe_fixture',
      old_label_state: 'generated',
      new_label_state: 'ai_approved',
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  test('empty dry-run does not require an LLM provider env var', async () => {
    const savedEnv = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      PIVOTA_GEMINI_API_KEY: process.env.PIVOTA_GEMINI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      LLM_API_KEY: process.env.LLM_API_KEY,
    };
    delete process.env.GEMINI_API_KEY;
    delete process.env.PIVOTA_GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_API_KEY;

    try {
      const queryFn = jest.fn(async () => ({ rows: [] }));

      const result = await runReview({
        cutoff: '2026-06-01T00:00:00Z',
        minScore: 0,
        limit: 25,
        queryFn,
      });

      expect(result.summary).toEqual(expect.objectContaining({
        dry_run: true,
        reviewed_count: 0,
        approved_count: 0,
        rejected_count: 0,
        applied_count: 0,
      }));
      expect(result.decisions).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('retries retryable LLM review errors before recording a verdict', async () => {
    const schemaErr = new Error('Model JSON did not match expected schema');
    schemaErr.code = 'LLM_SCHEMA_INVALID';
    const provider = {
      analyzeTextToJson: jest.fn()
        .mockRejectedValueOnce(schemaErr)
        .mockResolvedValueOnce({
          verdict: 'approve',
          confidence: 0.84,
          rationale: 'Both products have concrete category and routine evidence supporting a complementary relationship.',
        }),
    };
    const queryFn = jest.fn(async (sql) => {
      if (/FROM relationship_candidate_labels/i.test(sql)) {
        return {
          rows: [
            {
              id: 'rcl_retry_fixture',
              edge_id: 'rcl_retry_fixture',
              anchor_type: 'product',
              anchor_ref: 'product:anchor_retry',
              anchor_snapshot: {
                product_id: 'anchor_retry',
                name: 'Anchor Serum',
                brand: 'Brand A',
                category: 'Serum',
              },
              candidate_product_ref: 'product:candidate_retry',
              candidate_snapshot: {
                product_id: 'candidate_retry',
                name: 'Candidate Serum',
                brand: 'Brand B',
                category: 'Serum',
              },
              relation_type: 'related_product',
              display_label: 'related_product',
              market: 'US',
              vertical: 'beauty',
              category_taxonomy: ['Serum'],
              use_case: 'Serum',
              label_state: 'generated',
              score_total: 0.9,
              score_breakdown: {},
              price_evidence: {},
              source_refs: [],
              evidence_grade: 'B',
              why_candidate: { summary: 'Category evidence is aligned.' },
              tradeoffs: [],
              watchouts: [],
              provenance: {},
              created_at: '2026-06-01T00:00:00.000Z',
              updated_at: '2026-06-01T00:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await runReview({
      cutoff: '2026-06-01T00:00:00Z',
      minScore: 0,
      limit: 1,
      llmAttempts: 2,
      queryFn,
      provider,
    });

    expect(provider.analyzeTextToJson).toHaveBeenCalledTimes(2);
    expect(result.summary).toEqual(expect.objectContaining({
      reviewed_count: 1,
      approved_count: 1,
      rejected_count: 0,
      applied_count: 0,
      llm_attempts: 2,
    }));
    expect(result.decisions[0]).toEqual(expect.objectContaining({
      id: 'rcl_retry_fixture',
      verdict: 'approve',
      confidence: 0.84,
      applied: false,
    }));
  });

  test('records exhausted LLM review errors fail-closed instead of aborting the batch', async () => {
    const schemaErr = new Error('Model JSON did not match expected schema');
    schemaErr.code = 'LLM_SCHEMA_INVALID';
    const provider = {
      analyzeTextToJson: jest.fn().mockRejectedValue(schemaErr),
    };
    const queryFn = jest.fn(async (sql) => {
      if (/FROM relationship_candidate_labels/i.test(sql)) {
        return {
          rows: [
            {
              id: 'rcl_error_fixture',
              edge_id: 'rcl_error_fixture',
              anchor_type: 'product',
              anchor_ref: 'product:anchor_error',
              anchor_snapshot: {
                product_id: 'anchor_error',
                name: 'Anchor Serum',
                brand: 'Brand A',
                category: 'Serum',
              },
              candidate_product_ref: 'product:candidate_error',
              candidate_snapshot: {
                product_id: 'candidate_error',
                name: 'Candidate Serum',
                brand: 'Brand B',
                category: 'Serum',
              },
              relation_type: 'competitive_alternative',
              display_label: 'competitive_alternative',
              market: 'US',
              vertical: 'beauty',
              category_taxonomy: ['Serum'],
              use_case: 'Serum',
              label_state: 'generated',
              score_total: 0.9,
              score_breakdown: {},
              price_evidence: {},
              source_refs: [],
              evidence_grade: 'B',
              why_candidate: { summary: 'Category evidence is aligned.' },
              tradeoffs: [],
              watchouts: [],
              provenance: {},
              created_at: '2026-06-01T00:00:00.000Z',
              updated_at: '2026-06-01T00:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await runReview({
      cutoff: '2026-06-01T00:00:00Z',
      minScore: 0,
      limit: 1,
      llmAttempts: 2,
      queryFn,
      provider,
    });

    expect(provider.analyzeTextToJson).toHaveBeenCalledTimes(2);
    expect(result.summary).toEqual(expect.objectContaining({
      reviewed_count: 1,
      approved_count: 0,
      rejected_count: 0,
      review_error_count: 1,
      applied_count: 0,
    }));
    expect(result.decisions[0]).toEqual(expect.objectContaining({
      id: 'rcl_error_fixture',
      verdict: 'error',
      confidence: 0,
      new_label_state: 'generated',
      applied: false,
      review_error: expect.objectContaining({ code: 'LLM_SCHEMA_INVALID' }),
    }));
  });

  describe('serving guard gate', () => {
    test('asks the guard as the row would be AFTER approval, using the guard function itself', () => {
      const row = labelRow('rcl_variant');
      expect(row.label_state).toBe('generated');
      // Read as stored (generated) the guard says nothing — the related_product rules only fire on ai_approved.
      expect(getRelationshipEdgeServingSuppressionReasons(row)).toEqual([]);
      expect(servingGuardReasonsIfApproved(row)).toEqual(['related_product_same_family_variant']);
      expect(servingGuardReasonsIfApproved(row)).toEqual(
        getRelationshipEdgeServingSuppressionReasons({ ...row, label_state: 'ai_approved' }),
      );
      expect(servingGuardReasonsIfApproved(genuineRelatedRow('rcl_ok'))).toEqual([]);
    });

    test('dry run: a variant sibling is never sent to the LLM and is reported guard_blocked', async () => {
      const provider = { analyzeTextToJson: jest.fn(async () => APPROVE) };
      const queryFn = jest.fn(async (sql) => (
        /FROM relationship_candidate_labels/i.test(sql)
          ? { rows: [labelRow('rcl_variant'), genuineRelatedRow('rcl_ok')] }
          : { rows: [] }
      ));

      const result = await runReview({ cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: 10, queryFn, provider });

      expect(provider.analyzeTextToJson).toHaveBeenCalledTimes(1);
      expect(queryFn.mock.calls.some(([sql]) => /UPDATE relationship_candidate_labels/i.test(sql))).toBe(false);
      const byId = Object.fromEntries(result.decisions.map((d) => [d.id, d]));
      expect(byId.rcl_variant).toEqual(expect.objectContaining({
        verdict: 'guard_blocked',
        new_label_state: 'needs_evidence',
        applied: false,
        serving_guard_reasons: ['related_product_same_family_variant'],
      }));
      expect(byId.rcl_ok).toEqual(expect.objectContaining({ verdict: 'approve', new_label_state: 'ai_approved' }));
      expect(result.summary).toEqual(expect.objectContaining({
        reviewed_count: 2,
        approved_count: 1,
        guard_blocked_count: 1,
        guard_blocked_by_reason: { related_product_same_family_variant: 1 },
        guard_blocked_applied_count: 0,
        applied_count: 0,
      }));
    });

    test('apply: the sibling moves generated -> needs_evidence with a serving_guard flag; the genuine row is approved', async () => {
      const saved = process.env.RELGRAPH_AI_REVIEW_APPLY;
      process.env.RELGRAPH_AI_REVIEW_APPLY = '1';
      try {
        const provider = { analyzeTextToJson: jest.fn(async () => APPROVE) };
        const queryFn = jest.fn(async (sql, params) => {
          if (/^\s*SELECT[\s\S]*FROM relationship_candidate_labels/i.test(sql)) {
            return { rows: [labelRow('rcl_variant'), genuineRelatedRow('rcl_ok')] };
          }
          if (/UPDATE relationship_candidate_labels/i.test(sql)) {
            const next = /label_state = 'needs_evidence'/.test(sql) ? 'needs_evidence' : 'ai_approved';
            return { rows: [{ id: params[0], old_label_state: 'generated', new_label_state: next }] };
          }
          return { rows: [] };
        });

        const result = await runReview({
          cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: 10, apply: true, queryFn, provider,
        });

        const updates = queryFn.mock.calls.filter(([sql]) => /UPDATE relationship_candidate_labels/i.test(sql));
        expect(updates).toHaveLength(2);
        const [blockSql, blockParams] = updates.find(([, params]) => params[0] === 'rcl_variant');
        expect(blockSql).toMatch(/label_state = 'needs_evidence'/);
        expect(blockSql).not.toMatch(/'ai_approved'/);
        expect(blockSql).toMatch(/AND label_state = 'generated'/);
        expect(blockParams[1]).toEqual(['serving_guard:related_product_same_family_variant']);
        expect(JSON.parse(blockParams[2])).toEqual(expect.objectContaining({
          action: 'relationship_graph_review_serving_guard_block',
          reasons: ['related_product_same_family_variant'],
        }));
        const [approveSql] = updates.find(([, params]) => params[0] === 'rcl_ok');
        expect(approveSql).toMatch(/label_state = 'ai_approved'/);
        expect(result.summary).toEqual(expect.objectContaining({
          approved_count: 1,
          applied_count: 1,
          guard_blocked_count: 1,
          guard_blocked_applied_count: 1,
        }));
      } finally {
        if (saved === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY;
        else process.env.RELGRAPH_AI_REVIEW_APPLY = saved;
      }
    });

    test('a replayed approve verdict cannot approve a variant sibling', async () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-review-'));
      const verdictsFile = path.join(dir, 'verdicts.json');
      fs.writeFileSync(verdictsFile, JSON.stringify({ decisions: [{ id: 'rcl_variant', ...APPROVE }] }));
      const queryFn = jest.fn(async (sql) => (
        /FROM relationship_candidate_labels/i.test(sql) ? { rows: [labelRow('rcl_variant')] } : { rows: [] }
      ));

      const result = await runReview({ cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: 10, verdictsFile, queryFn });

      expect(result.decisions[0]).toEqual(expect.objectContaining({ verdict: 'guard_blocked' }));
      expect(result.summary.approved_count).toBe(0);
    });

    test('the dupe quarantine reason defers to --allow-dupe-ai-approval; variant reasons do not', () => {
      const dupe = genuineRelatedRow('rcl_dupe');
      dupe.relation_type = 'dupe';
      expect(servingGuardReasonsIfApproved(dupe)).toEqual(['ai_approved_dupe_quarantined']);
      expect(servingGuardReasonsIfApproved(dupe, { allowDupeAiApproval: true })).toEqual([]);
      expect(servingGuardReasonsIfApproved(labelRow('rcl_variant'), { allowDupeAiApproval: true }))
        .toEqual(['related_product_same_family_variant']);
    });

    test('applyApproval itself refuses a row the serving guard would suppress', async () => {
      const queryFn = jest.fn(async () => ({ rows: [{ id: 'rcl_variant' }] }));
      await expect(applyApproval(labelRow('rcl_variant'), APPROVE, queryFn)).rejects.toMatchObject({
        code: 'SERVING_GUARD_AI_APPROVAL_BLOCKED',
        reasons: ['related_product_same_family_variant'],
      });
      expect(queryFn).not.toHaveBeenCalled();
    });
  });
});

