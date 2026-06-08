const {
  AI_APPROVAL_FRESHNESS_INTERVAL,
  applyApproval,
  buildAiReview,
  fetchCandidates,
  parseArgs,
} = require('../../scripts/review-relationship-candidate-labels');

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
});
