const {
  AI_APPROVAL_FRESHNESS_INTERVAL,
  applyApproval,
  buildAiReview,
  recommendationFields,
  consumerCopyForKind,
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

const UTILITY = {
  relationship_kind: 'complement',
  ...consumerCopyForKind('complement'),
  shared_evidence: [{ anchor_fact: 'False Eyelashes', candidate_fact: 'Lash Glue Remover' }],

};
const APPROVE = {
  ...UTILITY,
  verdict: 'approve',
  confidence: 0.9,
  rationale: 'Same brand products used together in one lash routine.',
};

describe('review-relationship-candidate-labels', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('applyApproval stamps freshness for future ai approvals', async () => {
    const row = genuineRelatedRow('rcl_fixture');
    const decision = {
      ...APPROVE,
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
      JSON.stringify(recommendationFields(decision)), JSON.stringify(decision.tradeoffs || []), JSON.stringify(decision.watchouts || []),
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
      ...UTILITY, ...consumerCopyForKind('dupe'), relationship_kind: 'dupe',
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

    const inci = 'Water, Glycerin, Squalane, Ceramide NP, Peptide, Phenoxyethanol';
    const dupe = { id: 'dupe_fixture', relation_type: 'dupe', score_total: 0.9, score_breakdown: {category_use_case_match: 0.9},
      anchor_snapshot: {product_id: 'a', name: 'Barrier Peptide Face Cream', brand: 'Luxury', category: 'face cream', price: 50, price_currency: 'USD', ingredient_text: inci},
      candidate_snapshot: {product_id: 'b', name: 'Barrier Peptide Face Cream', brand: 'Value', category: 'face cream', price: 20, price_currency: 'USD', ingredient_text: inci} };
    const applied = await applyApproval(
      dupe,
      {...decision, shared_evidence: [{anchor_fact: 'Barrier Peptide Face Cream', candidate_fact: 'Barrier Peptide Face Cream'}]},
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
          ...UTILITY, ...consumerCopyForKind('alternative'), shared_evidence: [{anchor_fact: 'Anchor Serum', candidate_fact: 'Candidate Serum'}], relationship_kind: 'alternative',
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
              relation_type: 'competitive_alternative',
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
          applied_count: 2,
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

    test('the reviewer\'s own --out file (with a guard_blocked row) replays cleanly', async () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-review-out-'));
      const out = path.join(dir, 'review.json');
      const provider = { analyzeTextToJson: jest.fn(async () => APPROVE) };
      const queryFn = jest.fn(async (sql) => (
        /FROM relationship_candidate_labels/i.test(sql)
          ? { rows: [labelRow('rcl_variant'), genuineRelatedRow('rcl_ok')] }
          : { rows: [] }
      ));
      await runReview({ cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: 10, out, queryFn, provider });

      const replayed = await runReview({
        cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: 10, verdictsFile: out, queryFn,
      });

      const byId = Object.fromEntries(replayed.decisions.map((d) => [d.id, d.verdict]));
      expect(byId).toEqual({ rcl_variant: 'guard_blocked', rcl_ok: 'approve' });
      expect(replayed.summary.verdicts_file_count).toBe(1);
    });

    test('a nested product: ref is blocked whatever the relation type (the routine fails on it)', async () => {
      const row = genuineRelatedRow('rcl_nested');
      row.relation_type = 'competitive_alternative';
      row.candidate_product_ref = 'product:japanesetaste-com:0123456789abcdef';
      row.candidate_snapshot = { ...row.candidate_snapshot, brand: 'Other Brand' };
      expect(servingGuardReasonsIfApproved(row)).toEqual(['candidate_ref_unresolvable_nested_product_prefix']);
      const provider = { analyzeTextToJson: jest.fn(async () => APPROVE) };
      const queryFn = jest.fn(async (sql) => (
        /FROM relationship_candidate_labels/i.test(sql) ? { rows: [row] } : { rows: [] }
      ));

      const result = await runReview({ cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: 10, queryFn, provider });

      expect(provider.analyzeTextToJson).not.toHaveBeenCalled();
      expect(result.decisions[0]).toEqual(expect.objectContaining({
        verdict: 'guard_blocked',
        serving_guard_reasons: ['candidate_ref_unresolvable_nested_product_prefix'],
      }));
    });

    test('apply: a guard block that loses a race (row no longer generated) is a guarded no-op', async () => {
      const saved = process.env.RELGRAPH_AI_REVIEW_APPLY;
      process.env.RELGRAPH_AI_REVIEW_APPLY = '1';
      const lines = [];
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
      try {
        const queryFn = jest.fn(async (sql) => (
          /^\s*SELECT[\s\S]*FROM relationship_candidate_labels/i.test(sql) ? { rows: [labelRow('rcl_variant')] } : { rows: [] }
        ));

        const result = await runReview({
          cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: 10, apply: true, queryFn, provider: { analyzeTextToJson: jest.fn() },
        });

        expect(result.decisions[0]).toEqual(expect.objectContaining({ verdict: 'guard_blocked', applied: false }));
        expect(result.summary.guard_blocked_applied_count).toBe(0);
        expect(lines.join('')).toMatch(/rcl_variant generated->generated verdict=guard_blocked .* guarded_noop/);
      } finally {
        if (saved === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY;
        else process.env.RELGRAPH_AI_REVIEW_APPLY = saved;
      }
    });

    test('the guard-block UPDATE records the row\'s previous reason_flags from the stored row', async () => {
      const queryFn = jest.fn(async () => ({ rows: [] }));
      const { applyGuardBlock } = require('../../scripts/review-relationship-candidate-labels');
      await applyGuardBlock(labelRow('rcl_variant'), ['related_product_same_family_variant'], queryFn);
      const [sql] = queryFn.mock.calls[0];
      expect(sql).toMatch(/jsonb_build_object\('previous_reason_flags', to_jsonb\(COALESCE\(reason_flags, '\{\}'::text\[\]\)\)\)/);
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



describe('bounded review concurrency', () => {
  afterEach(() => jest.restoreAllMocks());

  test('clamps concurrency and defaults to one', () => {
    const args = ['--cutoff', '2026-06-01T00:00:00Z'];
    expect(parseArgs(args).concurrency).toBe(1);
    expect(parseArgs([...args, '--concurrency', '99']).concurrency).toBe(16);
    expect(parseArgs([...args, '--concurrency', '0']).concurrency).toBe(1);
  });

  test('out-of-order completions preserve decisions, stdout and file order within the bound', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-concurrency-'));
    const rows = [genuineRelatedRow('slow'), genuineRelatedRow('fast'), labelRow('blocked'),
      genuineRelatedRow('third'), genuineRelatedRow('fourth')];
    const queryFn = jest.fn(async (sql) => /FROM relationship_candidate_labels/i.test(sql)
      ? { rows } : { rows: [] });
    const lines = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((line) => { lines.push(line); return true; });
    async function run(concurrency) {
      let active = 0;
      let maximum = 0;
      const completed = [];
      const provider = { analyzeTextToJson: jest.fn(async ({ prompt }) => {
        const id = rows.find((row) => prompt.includes(row.anchor_ref)).id;
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, id === 'slow' ? 40 : 1));
        active -= 1;
        completed.push(id);
        return { ...APPROVE, confidence: id === 'fast' ? 0.8 : 0.9 };
      }) };
      lines.length = 0;
      const out = path.join(dir, `${concurrency}.json`);
      const result = await runReview({ cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: 10,
        concurrency, provider, queryFn, out });
      return { result, maximum, completed, lines: [...lines], provider,
        saved: JSON.parse(fs.readFileSync(out, 'utf8')) };
    }
    try {
      const serial = await run(1);
      const parallel = await run(2);
      expect(serial.maximum).toBe(1);
      expect(parallel.maximum).toBe(2);
      expect(parallel.completed[0]).toBe('fast');
      // Identical except the recorded setting itself.
      expect(parallel.result.summary.concurrency).toBe(2);
      expect(serial.result.summary.concurrency).toBe(1);
      expect({ ...parallel.result.summary, concurrency: 0 }).toEqual({ ...serial.result.summary, concurrency: 0 });
      expect(parallel.result.decisions).toEqual(serial.result.decisions);
      // Per-row lines are identical; the trailing summary differs only in the recorded concurrency.
      const normalizeConcurrency = (ls) => ls.map((l) => String(l).replace(/"concurrency": \d+/, '"concurrency": N'));
      expect(normalizeConcurrency(parallel.lines)).toEqual(normalizeConcurrency(serial.lines));
      expect(parallel.saved.decisions).toEqual(serial.saved.decisions);
      expect(parallel.result.decisions.map((row) => row.id)).toEqual(rows.map((row) => row.id));
      expect(parallel.provider.analyzeTextToJson).toHaveBeenCalledTimes(4);
      expect(parallel.result.decisions[2].verdict).toBe('guard_blocked');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('retryable quota failures leave the row generated and do not abort other workers', async () => {
    const { LlmError } = require('../../src/llm/provider');
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const rows = [genuineRelatedRow('quota'), genuineRelatedRow('ok')];
    const provider = { analyzeTextToJson: jest.fn(async ({ prompt }) => {
      if (prompt.includes('product:sig_anchor_quota')) throw new LlmError('LLM_REQUEST_FAILED', 'Vertex 429');
      return APPROVE;
    }) };
    const queryFn = jest.fn(async (sql) => /FROM relationship_candidate_labels/i.test(sql) ? { rows } : { rows: [] });
    const result = await runReview({ cutoff: '2026-06-01T00:00:00Z', limit: 10, concurrency: 2, queryFn, provider });
    expect(result.decisions.map((row) => row.verdict)).toEqual(['error', 'approve']);
    expect(result.decisions[0].new_label_state).toBe('generated');
    expect(provider.analyzeTextToJson).toHaveBeenCalledTimes(3);
  });

  describe('review follow-ups: breaker, thrown rows, apply under concurrency', () => {
    const { LlmError } = require('../../src/llm/provider');
    const manyRows = (n) => Array.from({ length: n }, (_, i) => genuineRelatedRow(`r${i}`));
    const rowsQuery = (rows, onUpdate = null) => jest.fn(async (sql, params) => {
      if (/^\s*SELECT[\s\S]*FROM relationship_candidate_labels/i.test(sql)) return { rows };
      if (/UPDATE relationship_candidate_labels/i.test(sql)) {
        if (onUpdate) return onUpdate(sql, params);
        const next = /label_state = 'needs_evidence'/.test(sql) ? 'needs_evidence' : 'ai_approved';
        return { rows: [{ id: params[0], old_label_state: 'generated', new_label_state: next }] };
      }
      return { rows: [] };
    });
    const withApply = async (fn) => {
      const saved = process.env.RELGRAPH_AI_REVIEW_APPLY;
      process.env.RELGRAPH_AI_REVIEW_APPLY = '1';
      try { return await fn(); } finally {
        if (saved === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY;
        else process.env.RELGRAPH_AI_REVIEW_APPLY = saved;
      }
    };

    test('parseArgs defaults the breaker to 8 consecutive transport errors', () => {
      const args = ['--cutoff', '2026-06-01T00:00:00Z'];
      expect(parseArgs(args).maxConsecutiveTransportErrors).toBe(8);
      expect(parseArgs([...args, '--max-consecutive-transport-errors', '3']).maxConsecutiveTransportErrors).toBe(3);
    });

    test('sustained quota failure opens the breaker: claims stop, the rest stay unreviewed', async () => {
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const rows = manyRows(40);
      const provider = { analyzeTextToJson: jest.fn(async () => { throw new LlmError('LLM_REQUEST_FAILED', 'Vertex 429'); }) };
      const result = await runReview({
        cutoff: '2026-06-01T00:00:00Z', limit: 100, concurrency: 3, llmAttempts: 1,
        maxConsecutiveTransportErrors: 4, queryFn: rowsQuery(rows), provider,
      });
      expect(result.summary.review_circuit_open).toBe(true);
      // 4 to trip, plus at most the other in-flight workers finishing.
      expect(result.summary.reviewed_count).toBeGreaterThanOrEqual(4);
      expect(result.summary.reviewed_count).toBeLessThanOrEqual(4 + 2);
      expect(result.summary.unclaimed_count).toBe(40 - result.summary.reviewed_count);
      expect(provider.analyzeTextToJson.mock.calls.length).toBe(result.summary.reviewed_count);
      expect(result.decisions.every((d) => d.verdict === 'error' && d.new_label_state === 'generated')).toBe(true);
    });

    test('a success resets the count, and schema errors (a bad answer, not an outage) never trip it', async () => {
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const rows = manyRows(12);
      let call = 0;
      const provider = { analyzeTextToJson: jest.fn(async () => {
        call += 1;
        if (call % 3 === 0) return APPROVE;
        throw new LlmError(call % 2 ? 'LLM_REQUEST_FAILED' : 'LLM_SCHEMA_INVALID', 'x');
      }) };
      const result = await runReview({
        cutoff: '2026-06-01T00:00:00Z', limit: 100, concurrency: 1, llmAttempts: 1,
        maxConsecutiveTransportErrors: 2, queryFn: rowsQuery(rows), provider,
      });
      expect(result.summary.review_circuit_open).toBe(false);
      expect(result.summary.reviewed_count).toBe(12);
    });

    test('a row that throws stops new claims, lets in-flight rows finish, keeps their lines, then rethrows', async () => {
      const lines = [];
      jest.spyOn(process.stdout, 'write').mockImplementation((line) => { lines.push(String(line)); return true; });
      const rows = manyRows(20);
      const provider = { analyzeTextToJson: jest.fn(async ({ prompt }) => {
        await new Promise((resolve) => setTimeout(resolve, prompt.includes('sig_anchor_r1"') || prompt.includes('sig_anchor_r1 ') ? 30 : 2));
        return APPROVE;
      }) };
      const updated = [];
      const queryFn = rowsQuery(rows, (sql, params) => {
        if (params[0] === 'r3') throw new Error('connection terminated unexpectedly');
        updated.push(params[0]);
        return { rows: [{ id: params[0], old_label_state: 'generated', new_label_state: 'ai_approved' }] };
      });
      await withApply(async () => {
        await expect(runReview({
          cutoff: '2026-06-01T00:00:00Z', limit: 100, concurrency: 3, apply: true, queryFn, provider,
        })).rejects.toThrow('connection terminated unexpectedly');
      });
      // Far fewer than 20 rows were claimed, and every row that completed was printed.
      expect(provider.analyzeTextToJson.mock.calls.length).toBeLessThan(20);
      const printedIds = lines.filter((l) => l.startsWith('[apply]')).map((l) => l.split(' ')[1]);
      expect(printedIds.sort()).toEqual([...updated].sort());
      expect(printedIds).not.toContain('r3');
    });

    test('finished rows are printed while later rows are still in flight (a killed step keeps them)', async () => {
      const lines = [];
      jest.spyOn(process.stdout, 'write').mockImplementation((line) => { lines.push(String(line)); return true; });
      // Concurrency 2: r0 and r1 answer at once; r2 is claimed next and is slow. While r2 is still
      // in flight, r0 and r1 must already be on stdout, not buffered until the batch ends.
      let printedWhileR2InFlight = null;
      const provider = { analyzeTextToJson: jest.fn(async ({ prompt }) => {
        if (prompt.includes('sig_anchor_r2')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          printedWhileR2InFlight = lines.filter((l) => l.startsWith('[dry-run]')).map((l) => l.split(' ')[1]);
        }
        return APPROVE;
      }) };
      await runReview({ cutoff: '2026-06-01T00:00:00Z', limit: 10, concurrency: 2, queryFn: rowsQuery(manyRows(3)), provider });
      expect(printedWhileR2InFlight).toEqual(['r0', 'r1']);
    });

    test('apply under concurrency counts every applied approval and guard block exactly once', async () => {
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const rows = [...manyRows(9), labelRow('blocked_a'), labelRow('blocked_b')];
      const provider = { analyzeTextToJson: jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
        return APPROVE;
      }) };
      // The UPDATE takes real time, so applies from different workers overlap: a counter updated
      // read-before-await / write-after would lose increments here.
      const slowUpdates = rowsQuery(rows, async (sql, params) => {
        await new Promise((resolve) => setTimeout(resolve, 3));
        const next = /label_state = 'needs_evidence'/.test(sql) ? 'needs_evidence' : 'ai_approved';
        return { rows: [{ id: params[0], old_label_state: 'generated', new_label_state: next }] };
      });
      const result = await withApply(() => runReview({
        cutoff: '2026-06-01T00:00:00Z', limit: 100, concurrency: 3, apply: true, queryFn: slowUpdates, provider,
      }));
      expect(result.summary).toEqual(expect.objectContaining({
        concurrency: 3,
        reviewed_count: 11,
        approved_count: 9,
        applied_count: 11,
        guard_blocked_count: 2,
        guard_blocked_applied_count: 2,
        unclaimed_count: 0,
        review_circuit_open: false,
      }));
    });
  });
});


describe('--ids pins label ids inline (no file needed in a job container)', () => {
  const { parseArgs, parseInlineIds, runReview } = require('../../scripts/review-relationship-candidate-labels');
  test('parses, trims and de-duplicates comma-separated ids', () => {
    expect(parseArgs(['--cutoff', '2026-01-01T00:00:00Z', '--ids', 'prel_a, prel_b,prel_a']).ids).toEqual(['prel_a', 'prel_b']);
    expect(parseArgs(['--cutoff', '2026-01-01T00:00:00Z']).ids).toEqual([]);
  });
  test('refuses anything that is not a label id', () => {
    expect(() => parseInlineIds("prel_a,x'; DROP TABLE")).toThrow(/invalid label id/);
    expect(() => parseInlineIds('prel_a,a b')).toThrow(/invalid label id/);
    expect(() => parseInlineIds(Array.from({ length: 5001 }, (_, i) => `prel_${i}`).join(','))).toThrow(/exceeds 5000/);
  });
  test('an id scope that resolves to nothing reviews nothing (never the global backlog)', async () => {
    for (const argv of [['--ids', ''], ['--ids', ',, ,'], ['--ids'], ['--ids', '--apply']]) {
      const args = parseArgs(['--cutoff', '2026-01-01T00:00:00Z', ...argv]);
      expect([argv, args.idsScopeRequested, args.ids]).toEqual([argv, true, []]);
      const queryFn = jest.fn(async () => ({ rows: [] }));
      const { summary } = await runReview({ ...args, apply: false, queryFn });
      expect(queryFn.mock.calls.some(([sql]) => /label_state = 'generated'/.test(sql))).toBe(false);
      expect(summary.reviewed_count).toBe(0);
    }
    expect(() => parseArgs(['--cutoff', '2026-01-01T00:00:00Z', '--ids=prel_a,prel_b'])).toThrow(/separate value/);
  });
  test('pinned ids are never truncated by the default limit', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `prel_${i}`);
    const queryFn = jest.fn(async () => ({ rows: [] }));
    const { summary } = await runReview({ cutoff: '2026-01-01T00:00:00Z', minScore: 0, limit: 250, ids, queryFn });
    const select = queryFn.mock.calls.find(([sql]) => /label_state = 'generated'/.test(sql));
    expect(select[1]).toContain(1000);
    expect(summary).toMatchObject({ limit: 1000, ids_filter_count: 1000, ids_scope_requested: true, ids_not_selected_count: 1000 });
  });
  test('--ids and --ids-file are merged', async () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ids-')), 'ids.txt');
    fs.writeFileSync(file, 'prel_file\n');
    const queryFn = jest.fn(async () => ({ rows: [] }));
    await runReview({ cutoff: '2026-01-01T00:00:00Z', minScore: 0, limit: 25, idsFile: file, ids: ['prel_inline'], queryFn });
    const select = queryFn.mock.calls.find(([sql]) => /label_state = 'generated'/.test(sql));
    expect(select[1]).toContainEqual(['prel_file', 'prel_inline']);
  });
  test('an id longer than 128 characters is refused', () => {
    expect(() => parseInlineIds(`prel_${'a'.repeat(124)}`)).toThrow(/invalid label id/);
    expect(parseInlineIds(`prel_${'a'.repeat(123)}`)).toHaveLength(1);
  });
  test('the ids scope the selection exactly like --ids-file', async () => {
    const queryFn = jest.fn(async () => ({ rows: [] }));
    await runReview({ cutoff: '2026-01-01T00:00:00Z', minScore: 0, limit: 25, ids: ['prel_a', 'prel_b'], queryFn });
    const select = queryFn.mock.calls.find(([sql]) => /FROM relationship_candidate_labels/.test(sql) && /label_state = 'generated'/.test(sql));
    expect(select[0]).toMatch(/AND id = ANY\(\$\d+::text\[\]\)/);
    expect(select[1]).toContainEqual(['prel_a', 'prel_b']);
  });
});
