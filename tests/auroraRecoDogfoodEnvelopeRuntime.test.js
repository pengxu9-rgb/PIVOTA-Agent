const { createRecoDogfoodEnvelopeRuntime } = require('../src/auroraBff/recoDogfoodEnvelopeRuntime');

describe('createRecoDogfoodEnvelopeRuntime', () => {
  function buildRuntime(overrides = {}) {
    return createRecoDogfoodEnvelopeRuntime({
      pickFirstTrimmed: (...values) => {
        for (const value of values) {
          const text = String(value == null ? '' : value).trim();
          if (text) return text;
        }
        return '';
      },
      isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
      RECO_DOGFOOD_CONFIG: {
        dogfood_mode: true,
        interleave: { enabled: true, rankerA: 'ranker_a', rankerB: 'ranker_b' },
        exploration: { enabled: true },
        ui: {
          allow_block_internal_rerank_on_async: true,
          show_employee_feedback_controls: true,
          lock_top_n_on_first_paint: 4,
        },
        async: { poll_ttl_ms: 9000 },
        prelabel: { enabled: true },
      },
      social_enrich_async: jest.fn(),
      applyAsyncBlockPatch: jest.fn(),
      recordRecoAsyncUpdate: jest.fn(),
      registerRecoTrackingSnapshot: jest.fn(),
      createAsyncTicket: jest.fn(() => ({ ticketId: 'ticket_1' })),
      recordRecoExplorationSlot: jest.fn(),
      loadSuggestionsForAnchor: jest.fn(async () => []),
      attachPrelabelSuggestionsToPayload: jest.fn((payload, suggestions) => ({
        ...payload,
        attached_suggestions: suggestions.length,
      })),
      setTimeoutImpl: jest.fn((fn) => fn()),
      ...overrides,
    });
  }

  test('resolves dogfood session id from explicit, headers, then request context', () => {
    const runtime = buildRuntime();
    const req = {
      get: jest.fn((name) => (name === 'X-Session-ID' ? ' header_session ' : '')),
      headers: {},
    };
    const ctx = { aurora_uid: 'uid_1', trace_id: 'trace_1', request_id: 'req_1' };

    expect(runtime.getRecoDogfoodSessionId(req, ctx, ' explicit_session ')).toBe('explicit_session');
    expect(runtime.getRecoDogfoodSessionId(req, ctx, '')).toBe('header_session');
    expect(runtime.getRecoDogfoodSessionId({ get: jest.fn(() => ''), headers: {} }, ctx, '')).toBe('uid_1');
  });

  test('normalizes dogfood features and auto-rolls back risky flags', () => {
    const runtime = buildRuntime();

    expect(runtime.normalizeDogfoodFeaturesEffective(null)).toEqual({
      interleave: true,
      exploration: true,
      async_rerank: true,
      show_employee_feedback_controls: true,
    });

    expect(
      runtime.normalizeDogfoodFeaturesEffective(
        {
          interleave: true,
          exploration: true,
          async_rerank: true,
          show_employee_feedback_controls: true,
        },
        { autoRollback: true },
      ),
    ).toEqual({
      interleave: false,
      exploration: false,
      async_rerank: false,
      show_employee_feedback_controls: false,
    });
  });

  test('augments product analysis payload, records tracking, and schedules async patching', () => {
    const social_enrich_async = jest.fn(({ apply_async_patch, on_async_update }) => {
      apply_async_patch({
        block: 'competitors',
        next_candidates: [{ product_id: 'comp_2' }],
      });
      on_async_update({
        block: 'competitors',
        result: 'updated',
        changed_count: 2,
      });
    });
    const applyAsyncBlockPatch = jest.fn();
    const recordRecoAsyncUpdate = jest.fn();
    const registerRecoTrackingSnapshot = jest.fn();
    const createAsyncTicket = jest.fn(() => ({ ticketId: 'ticket_runtime_1' }));
    const recordRecoExplorationSlot = jest.fn();
    const setTimeoutImpl = jest.fn((fn) => fn());
    const logger = { info: jest.fn() };

    const runtime = buildRuntime({
      social_enrich_async,
      applyAsyncBlockPatch,
      recordRecoAsyncUpdate,
      registerRecoTrackingSnapshot,
      createAsyncTicket,
      recordRecoExplorationSlot,
      setTimeoutImpl,
    });

    const out = runtime.augmentProductAnalysisPayloadForDogfood({
      payload: {
        provenance: {
          dogfood_features_effective: {
            async_rerank: true,
          },
        },
        assessment: {
          anchor_product: {
            product_id: 'anchor_1',
          },
        },
        competitors: {
          candidates: [{ product_id: 'comp_1' }],
        },
        related_products: { candidates: [] },
        dupes: { candidates: [] },
        candidate_tracking: {
          by_block: {
            competitors: {
              comp_1: { was_exploration_slot: true },
            },
          },
        },
      },
      req: { get: jest.fn(() => '') },
      ctx: { request_id: 'req_1', aurora_uid: 'uid_1', lang: 'EN' },
      mode: 'dogfood_test',
      cardId: 'card_1',
      sessionId: 'sess_1',
      logger,
    });

    expect(registerRecoTrackingSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req_1',
        sessionId: 'sess_1',
        anchorProductId: 'anchor_1',
      }),
    );
    expect(createAsyncTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req_1',
        cardId: 'card_1',
        lockTopN: 4,
      }),
    );
    expect(setTimeoutImpl).toHaveBeenCalled();
    expect(social_enrich_async).toHaveBeenCalled();
    expect(applyAsyncBlockPatch).toHaveBeenCalledWith({
      ticketId: 'ticket_runtime_1',
      block: 'competitors',
      nextCandidates: [{ product_id: 'comp_2' }],
    });
    expect(recordRecoAsyncUpdate).toHaveBeenCalledWith({
      block: 'competitors',
      result: 'updated',
      mode: 'dogfood_test',
      changedCount: 2,
    });
    expect(recordRecoExplorationSlot).toHaveBeenCalledWith({
      block: 'competitors',
      mode: 'dogfood_test',
      delta: 1,
    });
    expect(out.provenance.async_ticket_id).toBe('ticket_runtime_1');
    expect(out.candidate_tracking).toBeUndefined();
  });

  test('attaches prelabel suggestions onto product analysis cards only', async () => {
    const loadSuggestionsForAnchor = jest.fn(async () => [
      { id: 'sug_1', candidate_product_id: 'comp_1' },
    ]);
    const attachPrelabelSuggestionsToPayload = jest.fn((payload, suggestions) => ({
      ...payload,
      attached_suggestions: suggestions.length,
    }));
    const runtime = buildRuntime({
      loadSuggestionsForAnchor,
      attachPrelabelSuggestionsToPayload,
    });

    const out = await runtime.augmentEnvelopeProductAnalysisCardsWithPrelabelSuggestions({
      envelope: {
        cards: [
          {
            type: 'product_analysis',
            payload: {
              assessment: {
                anchor_product: {
                  product_id: 'anchor_1',
                },
              },
            },
          },
          { type: 'text', payload: { message: 'keep' } },
        ],
      },
      logger: { warn: jest.fn() },
    });

    expect(loadSuggestionsForAnchor).toHaveBeenCalledWith({
      anchor_product_id: 'anchor_1',
      limit: 220,
    });
    expect(attachPrelabelSuggestionsToPayload).toHaveBeenCalled();
    expect(out.cards[0].payload.attached_suggestions).toBe(1);
    expect(out.cards[1]).toEqual({ type: 'text', payload: { message: 'keep' } });
  });
});
