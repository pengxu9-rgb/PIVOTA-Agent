const { createChatLoopBreakerRuntime } = require('../src/auroraBff/chatLoopBreakerRuntime');

describe('aurora chat loop breaker runtime', () => {
  test('builds conservative default envelope when planner break applies', () => {
    const runtime = createChatLoopBreakerRuntime({
      INTENT_ENUM: { UNKNOWN: 'unknown' },
    });
    const buildEnvelope = jest.fn((ctx, payload) => ({ request_id: ctx.request_id, ...payload }));
    const makeChatAssistantMessage = jest.fn((content) => ({ role: 'assistant', content }));
    const makeEvent = jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData }));

    const result = runtime.maybeBuildLoopBreakerEnvelope({
      effectiveChatFlags: { loop_breaker_v2: true },
      plannerDecision: {
        next_step: 'ask',
        loop_count: 3,
        break_applied: 'conservative_defaults',
        required_fields: ['skinType', 'pregnancy', 'sensitivity', 'routine'],
      },
      ctx: { request_id: 'req_1', lang: 'EN' },
      canonicalIntent: { intent: 'reco_products' },
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });

    expect(result.handled).toBe(true);
    expect(result.envelope.suggested_chips.map((chip) => chip.chip_id)).toEqual([
      'chip.action.analyze_product',
      'chip.start.ingredients',
      'chip.start.reco_products',
    ]);
    expect(result.envelope.assistant_message.content).toContain('stop repeating the same clarifications');
    expect(result.envelope.events).toEqual([
      {
        event_name: 'loop_breaker_triggered',
        event_data: {
          loop_count: 3,
          break_applied: 'conservative_defaults',
          required_fields: ['skinType', 'pregnancy', 'sensitivity', 'routine'],
          intent: 'reco_products',
        },
      },
    ]);
  });

  test('builds cn envelope for stop_asking branch', () => {
    const runtime = createChatLoopBreakerRuntime({
      INTENT_ENUM: { UNKNOWN: 'unknown' },
    });

    const result = runtime.maybeBuildLoopBreakerEnvelope({
      effectiveChatFlags: { loop_breaker_v2: true },
      plannerDecision: {
        next_step: 'ask',
        loop_count: 1,
        break_applied: 'stop_asking',
        required_fields: ['肤质'],
      },
      ctx: { request_id: 'req_cn', lang: 'CN' },
      canonicalIntent: {},
      buildEnvelope: (_ctx, payload) => payload,
      makeChatAssistantMessage: (content) => ({ role: 'assistant', content }),
      makeEvent: (_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData }),
    });

    expect(result.handled).toBe(true);
    expect(result.envelope.assistant_message.content).toContain('我先按保守默认值继续');
    expect(result.envelope.suggested_chips[1].chip_id).toBe('chip.start.ingredients');
    expect(result.envelope.suggested_chips[2].data.reply_text).toBe('给我一些产品推荐');
    expect(result.envelope.events[0].event_data.intent).toBe('unknown');
  });

  test('returns not handled when planner break is inactive', () => {
    const runtime = createChatLoopBreakerRuntime();

    expect(
      runtime.maybeBuildLoopBreakerEnvelope({
        effectiveChatFlags: { loop_breaker_v2: true },
        conflictIntentRequested: true,
        plannerDecision: {
          next_step: 'ask',
          break_applied: 'conservative_defaults',
          required_fields: ['skinType'],
        },
        buildEnvelope: jest.fn(),
        makeChatAssistantMessage: jest.fn(),
        makeEvent: jest.fn(),
      }),
    ).toEqual({ handled: false, envelope: null });

    expect(
      runtime.maybeBuildLoopBreakerEnvelope({
        effectiveChatFlags: { loop_breaker_v2: true },
        conflictIntentRequested: false,
        plannerDecision: {
          next_step: 'ask',
          break_applied: 'chips_single_question',
          required_fields: ['skinType'],
        },
        buildEnvelope: jest.fn(),
        makeChatAssistantMessage: jest.fn(),
        makeEvent: jest.fn(),
      }),
    ).toEqual({ handled: false, envelope: null });
  });
});
