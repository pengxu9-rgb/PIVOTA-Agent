const { createChatContextRuntime } = require('../src/auroraBff/chatContextRuntime');

describe('aurora chat context runtime', () => {
  const runtime = createChatContextRuntime({
    INTENT_ENUM: { UNKNOWN: 'unknown', ROUTINE: 'ROUTINE', RECO_PRODUCTS: 'RECO_PRODUCTS' },
  });

  test('collects legacy card types and infers gate type', () => {
    const envelope = {
      cards: [
        { type: 'Diagnosis_Gate' },
        { type: 'budget_gate' },
        { type: 'diagnosis_gate' },
        { type: '  ' },
        {},
      ],
    };

    expect(runtime.collectLegacyCardTypes(envelope)).toEqual(['diagnosis_gate', 'budget_gate']);
    expect(runtime.inferGateFromLegacyCardTypes(['diagnosis_gate'])).toBe('diagnosis_gate');
    expect(runtime.inferGateFromLegacyCardTypes(['budget_gate'])).toBe('budget_gate');
    expect(runtime.inferGateFromLegacyCardTypes(['gate_notice'])).toBe('gate_notice');
    expect(runtime.inferGateFromLegacyCardTypes(['other'])).toBe('none');
  });

  test('extracts next_state from valid session patch only', () => {
    expect(runtime.extractNextStateFromEnvelope({
      session_patch: { next_state: ' RECO_RESULTS ' },
    })).toBe('RECO_RESULTS');

    expect(runtime.extractNextStateFromEnvelope({
      session_patch: null,
    })).toBeNull();

    expect(runtime.extractNextStateFromEnvelope({})).toBeNull();
  });

  test('updates chat context with pushed topic, travel followup, and pending clarification override', () => {
    const result = runtime.updateChatContextFromEnvelope({
      chatContext: {
        travelFollowup: { city: 'Tokyo' },
        pending_clarification: { id: 'old' },
      },
      envelope: {
        assistant_message: { content: ' Use this routine tonight. ' },
        session_patch: {
          pending_clarification: { id: 'new' },
          meta: {
            travel_followup: { city: 'Osaka' },
          },
        },
      },
      policyIntent: 'ROUTINE',
      canonicalIntent: 'UNKNOWN',
      requestMessage: 'help me build a routine',
    });

    expect(result.threadOps).toHaveLength(1);
    expect(result.threadOps[0].op).toBe('thread_push');
    expect(result.chatContext.active_thread.topic_id).toBe('routine');
    expect(result.chatContext.active_thread_summary).toBe('Use this routine tonight.');
    expect(result.chatContext.travel_followup).toEqual({ city: 'Osaka' });
    expect(result.chatContext.travelFollowup).toEqual({ city: 'Osaka' });
    expect(result.chatContext.pending_clarification).toEqual({ id: 'new' });
  });

  test('restores previous topic on return message and keeps existing pending clarification when patch omits it', () => {
    const result = runtime.updateChatContextFromEnvelope({
      chatContext: {
        active_thread: {
          topic_id: 'reco_products',
          summary: 'Current reco thread',
          updated_at_ms: 1,
        },
        thread_stack: [
          { topic_id: 'routine', summary: 'Earlier routine', updated_at_ms: 2 },
        ],
        pending_clarification: { id: 'keep-me' },
      },
      envelope: {
        assistant_message: { content: 'Let us return to that earlier routine.' },
        session_patch: {},
      },
      policyIntent: 'RECO_PRODUCTS',
      canonicalIntent: 'UNKNOWN',
      requestMessage: 'back to previous topic',
    });

    expect(result.threadOps).toHaveLength(1);
    expect(result.threadOps[0].op).toBe('thread_pop');
    expect(result.chatContext.active_thread.topic_id).toBe('routine');
    expect(result.chatContext.thread_stack).toEqual([]);
    expect(result.chatContext.pending_clarification).toEqual({ id: 'keep-me' });
  });

  test('collects telemetry entities with flattening and caps output', () => {
    const entities = runtime.collectTelemetryEntities({
      entities: {
        goals: ['acne', 'barrier', 'glow', 'spots', 'extra'],
        product: 'serum',
        tags: ['a', 'b', 'c', 'd'],
        budget: 'mid',
        focus: 'night',
        region: 'US',
        concern: 'redness',
        format: 'gel',
        misc: 'trimmed',
      },
    });

    expect(entities.slice(0, 4)).toEqual([
      { key: 'goals', value: 'acne' },
      { key: 'goals', value: 'barrier' },
      { key: 'goals', value: 'glow' },
      { key: 'goals', value: 'spots' },
    ]);
    expect(entities).toHaveLength(15);
  });
});
