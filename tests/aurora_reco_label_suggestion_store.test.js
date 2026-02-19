describe('aurora reco label suggestion store resilience', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('listQueueCandidatesWithSuggestions falls back to memory when DB read fails', async () => {
    jest.doMock('../src/db', () => ({
      query: jest.fn(async () => {
        const err = new Error('db unavailable');
        err.code = 'NO_DATABASE';
        throw err;
      }),
    }));

    const store = require('../src/auroraBff/recoLabelSuggestionStore');
    const { upsertSuggestion, listQueueCandidatesWithSuggestions, __internal } = store;

    __internal.state.dbUnavailable = true;
    __internal.state.dbUnavailableUntilMs = Date.now() + 60000;
    await upsertSuggestion({
      id: 's_mem_only_1',
      anchor_product_id: 'anchor_mem_1',
      block: 'competitors',
      candidate_product_id: 'cand_mem_1',
      suggested_label: 'relevant',
      confidence: 0.73,
      rationale_user_visible: 'Memory fallback row.',
      flags: [],
      model_name: 'gemini-2.0-flash',
      prompt_version: 'prelabel_v1',
      input_hash: 'hash_mem_1',
    });

    __internal.state.dbUnavailable = false;
    __internal.state.dbUnavailableUntilMs = 0;

    const rows = await listQueueCandidatesWithSuggestions({
      block: 'competitors',
      limit: 10,
    });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('s_mem_only_1');
  });

  test('upsertSuggestion auto-initializes table on 42P01 and retries', async () => {
    let callCount = 0;
    const queryMock = jest.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        const err = new Error('relation does not exist');
        err.code = '42P01';
        throw err;
      }
      return { rows: [] };
    });

    jest.doMock('../src/db', () => ({
      query: queryMock,
    }));

    const store = require('../src/auroraBff/recoLabelSuggestionStore');
    const { upsertSuggestion, __internal } = store;

    const saved = await upsertSuggestion({
      id: 's_bootstrap_1',
      anchor_product_id: 'anchor_bootstrap',
      block: 'dupes',
      candidate_product_id: 'cand_bootstrap',
      suggested_label: 'not_relevant',
      confidence: 0.2,
      rationale_user_visible: 'Needs more evidence.',
      flags: ['needs_price_check'],
      model_name: 'gemini-2.0-flash',
      prompt_version: 'prelabel_v1',
      input_hash: 'hash_bootstrap',
    });

    expect(saved.id).toBe('s_bootstrap_1');
    expect(saved.block).toBe('dupes');
    expect(queryMock).toHaveBeenCalled();
    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(__internal.state.tableReady).toBe(true);
    expect(__internal.state.dbUnavailable).toBe(false);
  });
});
