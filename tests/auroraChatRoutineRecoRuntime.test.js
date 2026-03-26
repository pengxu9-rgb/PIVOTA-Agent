const { createChatRoutineRecoRuntime } = require('../src/auroraBff/chatRoutineRecoRuntime');

function buildHarness(overrides = {}) {
  const deps = {
    logger: {
      warn: jest.fn(),
      info: jest.fn(),
    },
    generateRoutineReco: jest.fn(),
    AURORA_BFF_CHAT_ROUTINE_V2_ENABLED: false,
    withTimeout: jest.fn((promise) => promise),
    AURORA_BFF_CHAT_ROUTINE_BUDGET_MS: 9000,
    buildBudgetOptimizationEntryChip: jest.fn((language) => ({
      chip_id: `budget_${language || 'unknown'}`,
      kind: 'quick_reply',
    })),
    stateChangeAllowed: jest.fn(() => true),
    stripInternalRefsDeep: jest.fn((payload) => ({ ...payload, stripped: true })),
    recordAuroraSkinFlowMetric: jest.fn(),
    chatRecoHandoffRuntime: {
      buildRoutineTimeoutDegradedEnvelope: jest.fn((args) => ({ mode: 'timeout', args })),
      buildRoutineRecoEnvelope: jest.fn((args) => ({ mode: 'success', args })),
    },
    ...overrides,
  };

  return {
    deps,
    runtime: createChatRoutineRecoRuntime(deps),
  };
}

describe('aurora chat routine reco runtime', () => {
  test('builds budget-flow routine recommendation envelope on success', async () => {
    const { runtime, deps } = buildHarness();
    deps.generateRoutineReco.mockResolvedValue({
      norm: {
        payload: { recommendations: [{ sku_id: 'sku_1' }] },
        field_missing: ['skinType'],
      },
      suggestedChips: [{ chip_id: 'keep_routine' }],
    });

    const envelope = await runtime.resolveRoutineRecoEnvelope({
      ctx: { request_id: 'req_1', lang: 'CN', trigger_source: 'text' },
      profile: { skinType: 'dry' },
      recentLogs: [{ id: 'log_1' }],
      message: '帮我做routine',
      includeAlternatives: true,
      variant: 'budget_flow',
      hasBudget: true,
      buildEnvelope: jest.fn(),
      makeChatAssistantMessage: jest.fn(),
      makeEvent: jest.fn(),
    });

    expect(envelope).toEqual({
      mode: 'success',
      args: expect.objectContaining({
        variant: 'budget_flow',
        hasBudget: true,
        suggestedChips: [{ chip_id: 'keep_routine' }],
        payload: { recommendations: [{ sku_id: 'sku_1' }], stripped: true },
        fieldMissing: ['skinType'],
        nextState: 'S7_PRODUCT_RECO',
      }),
    });
    expect(deps.stripInternalRefsDeep).toHaveBeenCalledWith({ recommendations: [{ sku_id: 'sku_1' }] });
    expect(deps.chatRecoHandoffRuntime.buildRoutineTimeoutDegradedEnvelope).not.toHaveBeenCalled();
  });

  test('appends budget optimization chip for non-budget routine request', async () => {
    const { runtime, deps } = buildHarness();
    deps.generateRoutineReco.mockResolvedValue({
      norm: {
        payload: { recommendations: [{ sku_id: 'sku_2' }] },
        field_missing: [],
      },
      suggestedChips: [{ chip_id: 'routine_retry' }],
    });

    await runtime.resolveRoutineRecoEnvelope({
      ctx: { request_id: 'req_2', lang: 'EN', trigger_source: 'text' },
      profile: {},
      recentLogs: [],
      message: 'build me a routine',
      variant: 'routine_request',
      hasBudget: false,
      appendBudgetOptimizationChip: true,
      buildEnvelope: jest.fn(),
      makeChatAssistantMessage: jest.fn(),
      makeEvent: jest.fn(),
    });

    expect(deps.buildBudgetOptimizationEntryChip).toHaveBeenCalledWith('EN');
    expect(deps.chatRecoHandoffRuntime.buildRoutineRecoEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'routine_request',
        hasBudget: false,
        suggestedChips: [
          { chip_id: 'routine_retry' },
          { chip_id: 'budget_EN', kind: 'quick_reply' },
        ],
      }),
    );
  });

  test('degrades on routine timeout budget gate', async () => {
    const timeoutError = new Error('timed out');
    timeoutError.code = 'AURORA_CHAT_ROUTINE_BUDGET_TIMEOUT';
    const { runtime, deps } = buildHarness({
      AURORA_BFF_CHAT_ROUTINE_V2_ENABLED: true,
      withTimeout: jest.fn().mockRejectedValue(timeoutError),
    });

    const envelope = await runtime.resolveRoutineRecoEnvelope({
      ctx: { request_id: 'req_3', trace_id: 'trace_3', lang: 'EN', trigger_source: 'text' },
      profile: { skinType: 'combination' },
      recentLogs: [{ id: 'log_2' }],
      message: 'routine please',
      variant: 'routine_request',
      timeoutDetail: 'Routine generation timed out; continue AM/PM intake or retry directly.',
      buildEnvelope: jest.fn(),
      makeChatAssistantMessage: jest.fn(),
      makeEvent: jest.fn(),
    });

    expect(envelope).toEqual({
      mode: 'timeout',
      args: expect.objectContaining({
        detail: 'Routine generation timed out; continue AM/PM intake or retry directly.',
      }),
    });
    expect(deps.recordAuroraSkinFlowMetric).toHaveBeenCalledWith({ stage: 'routine_timeout_degraded', hit: true });
    expect(deps.logger.warn).toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      { kind: 'metric', name: 'aurora.skin.routine.timeout_degraded_rate', value: 1 },
      'metric',
    );
  });

  test('rethrows non-timeout routine errors', async () => {
    const upstreamError = new Error('boom');
    const { runtime, deps } = buildHarness({
      generateRoutineReco: jest.fn().mockRejectedValue(upstreamError),
    });

    await expect(
      runtime.resolveRoutineRecoEnvelope({
        ctx: { request_id: 'req_4', lang: 'EN', trigger_source: 'text' },
        buildEnvelope: jest.fn(),
        makeChatAssistantMessage: jest.fn(),
        makeEvent: jest.fn(),
      }),
    ).rejects.toThrow('boom');
    expect(deps.chatRecoHandoffRuntime.buildRoutineTimeoutDegradedEnvelope).not.toHaveBeenCalled();
  });
});
