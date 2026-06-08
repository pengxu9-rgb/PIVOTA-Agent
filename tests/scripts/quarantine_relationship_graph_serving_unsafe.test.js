const {
  CONFIRM_TOKEN,
  applyQuarantinePatch,
  applyQuarantinePatches,
  buildCandidateRowsSql,
  buildQuarantinePatch,
  parseArgs,
  runQuarantine,
  selectUnsafeRows,
} = require('../../scripts/quarantine-relationship-graph-serving-unsafe');

const NOW = '2026-06-08T00:00:00.000Z';

function row(overrides = {}) {
  return {
    id: overrides.id || 'prel_test',
    anchor_type: 'product',
    anchor_ref: 'product:anchor_1',
    anchor_snapshot: {
      brand: 'Anchor Brand',
      title: 'Anchor Barrier Serum',
    },
    candidate_product_ref: 'product:candidate_1',
    candidate_snapshot: {
      brand: 'Candidate Brand',
      title: 'Candidate Barrier Serum',
    },
    relation_type: 'competitive_alternative',
    display_label: 'alternative',
    market: 'US',
    vertical: 'beauty',
    category_taxonomy: ['skincare'],
    use_case: 'barrier support',
    score_total: 0.9,
    score_breakdown: { score_total: 0.9 },
    price_evidence: {},
    source_refs: [{ type: 'products_cache', authoritative: true }],
    evidence_grade: 'A',
    review_status: 'approved',
    label_state: 'ai_approved',
    why_candidate: {},
    tradeoffs: [],
    watchouts: [],
    provenance: {},
    reason_flags: [],
    last_verified_at: NOW,
    expires_at: '2026-07-08T00:00:00.000Z',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe('quarantine-relationship-graph-serving-unsafe', () => {
  test('parseArgs is dry-run and ai-approved scoped by default', () => {
    const args = parseArgs([
      '--market',
      'us',
      '--reasons',
      'ai_approved_dupe_quarantined,candidate_ref_unresolvable_nested_product_prefix',
      '--mode',
      'expire',
      '--db-lock',
      '--db-lock-key',
      'relgraph:test',
    ]);

    expect(args.apply).toBe(false);
    expect(args.market).toBe('US');
    expect(args.includeHumanApproved).toBe(false);
    expect(args.mode).toBe('expire');
    expect(args.dbLock).toBe(true);
    expect(args.dbLockKey).toBe('relgraph:test');
    expect(args.reasons).toEqual([
      'ai_approved_dupe_quarantined',
      'candidate_ref_unresolvable_nested_product_prefix',
    ]);
  });

  test('parseArgs requires explicit confirmation for apply', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/apply requires --confirm/);

    const args = parseArgs(['--apply', '--confirm', CONFIRM_TOKEN, '--include-human-approved']);
    expect(args.apply).toBe(true);
    expect(args.includeHumanApproved).toBe(true);
  });

  test('buildCandidateRowsSql defaults to active ai-approved labels only', () => {
    const { sql, params } = buildCandidateRowsSql({ market: 'US', limit: 25 });

    expect(sql).toMatch(/FROM relationship_candidate_labels/);
    expect(sql).toMatch(/label_state = ANY\(\$1::text\[\]\)/);
    expect(sql).toMatch(/last_verified_at IS NOT NULL/);
    expect(sql).toMatch(/expires_at > now\(\)/);
    expect(params).toEqual([['ai_approved'], 'US', 25]);
  });

  test('buildCandidateRowsSql can include human-approved labels when explicit', () => {
    const { params } = buildCandidateRowsSql({
      market: '',
      limit: 0,
      includeHumanApproved: true,
    });

    expect(params).toEqual([['ai_approved', 'human_approved']]);
  });

  test('selectUnsafeRows uses the runtime serving guard and optional reason filter', () => {
    const rows = [
      row({ id: 'ai_dupe', relation_type: 'dupe' }),
      row({
        id: 'nested_ref',
        relation_type: 'competitive_alternative',
        candidate_product_ref: 'product:ulta:12345',
      }),
      row({
        id: 'safe_alt',
        relation_type: 'competitive_alternative',
      }),
    ];

    const allUnsafe = selectUnsafeRows(rows, { examplesPerReason: 1 });
    expect(allUnsafe.summary.unsafe_rows).toBe(2);
    expect(allUnsafe.summary.by_reason.ai_approved_dupe_quarantined).toBe(1);
    expect(allUnsafe.summary.by_reason.candidate_ref_unresolvable_nested_product_prefix).toBe(1);

    const nestedOnly = selectUnsafeRows(rows, {
      reasons: ['candidate_ref_unresolvable_nested_product_prefix'],
    });
    expect(nestedOnly.selected.map((item) => item.edge.id)).toEqual(['nested_ref']);
  });

  test('buildQuarantinePatch moves rows to needs_evidence by default and stamps provenance', () => {
    const patch = buildQuarantinePatch({
      row: row({ id: 'ai_dupe', relation_type: 'dupe' }),
      reasons: ['ai_approved_dupe_quarantined'],
      auditRunId: 'relgraph_routine_test',
      generatedAt: NOW,
    });

    expect(patch).toEqual(expect.objectContaining({
      id: 'ai_dupe',
      previous_label_state: 'ai_approved',
      next_label_state: 'needs_evidence',
      reason_flags: ['serving_guard:ai_approved_dupe_quarantined'],
    }));
    expect(patch.provenance_patch).toEqual(expect.objectContaining({
      action: 'relationship_graph_serving_guard_quarantine',
      audit_run_id: 'relgraph_routine_test',
      quarantined_at: NOW,
    }));
  });

  test('applyQuarantinePatch writes label state, expiry, reason flags, and provenance', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [{
        id: 'ai_dupe',
        label_state: 'needs_evidence',
        expires_at: NOW,
        reason_flags: ['serving_guard:ai_approved_dupe_quarantined'],
        provenance: {},
      }],
    }));
    const patch = buildQuarantinePatch({
      row: row({ id: 'ai_dupe', relation_type: 'dupe' }),
      reasons: ['ai_approved_dupe_quarantined'],
      generatedAt: NOW,
    });

    const updated = await applyQuarantinePatch({ queryFn, patch });

    expect(updated.id).toBe('ai_dupe');
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0]).toMatch(/UPDATE relationship_candidate_labels/);
    expect(queryFn.mock.calls[0][0]).toMatch(/jsonb_to_recordset/);
    expect(queryFn.mock.calls[0][0]).toMatch(/label_state = patch\.next_label_state/);
    expect(queryFn.mock.calls[0][0]).toMatch(/expires_at = now\(\)/);
    const payload = JSON.parse(queryFn.mock.calls[0][1][0]);
    expect(payload).toEqual([expect.objectContaining({
      id: 'ai_dupe',
      next_label_state: 'needs_evidence',
      reason_flags: ['serving_guard:ai_approved_dupe_quarantined'],
      provenance_patch: expect.objectContaining({ reasons: ['ai_approved_dupe_quarantined'] }),
    })]);
  });

  test('applyQuarantinePatches chunks batch updates', async () => {
    const queryFn = jest.fn(async (_sql, params) => {
      const payload = JSON.parse(params[0]);
      return {
        rows: payload.map((patch) => ({
          id: patch.id,
          label_state: patch.next_label_state,
          expires_at: NOW,
          reason_flags: patch.reason_flags,
        })),
      };
    });
    const patches = ['a', 'b', 'c'].map((id) => buildQuarantinePatch({
      row: row({ id, relation_type: 'dupe' }),
      reasons: ['ai_approved_dupe_quarantined'],
      generatedAt: NOW,
    }));

    const updated = await applyQuarantinePatches({ queryFn, patches, chunkSize: 2 });

    expect(updated.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(queryFn.mock.calls[0][1][0]).map((item) => item.id)).toEqual(['a', 'b']);
    expect(JSON.parse(queryFn.mock.calls[1][1][0]).map((item) => item.id)).toEqual(['c']);
  });

  test('runQuarantine dry-run reports patches but does not update rows', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [
        row({ id: 'ai_dupe', relation_type: 'dupe' }),
        row({ id: 'safe_alt', relation_type: 'competitive_alternative' }),
      ],
    }));

    const report = await runQuarantine({
      queryFn,
      market: 'US',
      dbLockInfo: {
        lock_key: 'relgraph:test',
        key_parts: [1, 2],
      },
      generatedAt: NOW,
    });

    expect(report.dry_run).toBe(true);
    expect(report.db_lock).toEqual({
      requested: true,
      acquired: true,
      lock_key: 'relgraph:test',
      key_parts: [1, 2],
    });
    expect(report.summary.unsafe_rows).toBe(1);
    expect(report.summary.patch_count).toBe(1);
    expect(report.summary.applied_count).toBe(0);
    expect(report.patches[0]).toEqual(expect.objectContaining({
      id: 'ai_dupe',
      next_label_state: 'needs_evidence',
    }));
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  test('runQuarantine apply updates selected unsafe rows only', async () => {
    const queryFn = jest.fn(async (sql, params) => {
      if (/SELECT[\s\S]+FROM relationship_candidate_labels/.test(sql)) {
        return {
          rows: [
            row({ id: 'ai_dupe', relation_type: 'dupe' }),
            row({ id: 'safe_alt', relation_type: 'competitive_alternative' }),
          ],
        };
      }
      if (/UPDATE relationship_candidate_labels/.test(sql)) {
        const payload = JSON.parse(params[0]);
        return {
          rows: payload.map((patch) => ({
            id: patch.id,
            label_state: patch.next_label_state,
            expires_at: NOW,
            reason_flags: patch.reason_flags,
          })),
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const report = await runQuarantine({
      queryFn,
      market: 'US',
      apply: true,
      generatedAt: NOW,
    });

    expect(report.dry_run).toBe(false);
    expect(report.summary.applied_count).toBe(1);
    expect(report.applied_rows).toEqual([
      expect.objectContaining({ id: 'ai_dupe', label_state: 'needs_evidence' }),
    ]);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
