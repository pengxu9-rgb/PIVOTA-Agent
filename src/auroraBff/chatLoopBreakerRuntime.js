function createChatLoopBreakerRuntime(options = {}) {
  const { INTENT_ENUM = {} } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat loop breaker runtime missing dependency: ${name}`);
  }

  function maybeBuildLoopBreakerEnvelope(args = {}) {
    const {
      effectiveChatFlags = {},
      conflictIntentRequested = false,
      plannerDecision = null,
      ctx = {},
      canonicalIntent = {},
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    } = args;

    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);

    if (!effectiveChatFlags.loop_breaker_v2 || conflictIntentRequested) {
      return { handled: false, envelope: null };
    }

    if (
      !plannerDecision ||
      plannerDecision.next_step !== 'ask' ||
      !Array.isArray(plannerDecision.required_fields) ||
      plannerDecision.required_fields.length === 0
    ) {
      return { handled: false, envelope: null };
    }

    if (
      plannerDecision.break_applied !== 'conservative_defaults' &&
      plannerDecision.break_applied !== 'stop_asking'
    ) {
      return { handled: false, envelope: null };
    }

    const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
    const requiredSummary = plannerDecision.required_fields.slice(0, 3).join(', ');
    const assistantText =
      lang === 'CN'
        ? `我先按保守默认值继续，不再重复追问（缺失字段：${requiredSummary || 'unknown'}）。你可以稍后在 Profile 里补充，以获得更精准建议。`
        : `I’ll proceed with conservative defaults and stop repeating the same clarifications (missing: ${requiredSummary || 'unknown'}). You can update Profile later for more precise output.`;

    return {
      handled: true,
      envelope: buildEnvelopeFn(ctx, {
        assistant_message: makeChatAssistantMessageFn(assistantText),
        suggested_chips: [
          {
            chip_id: 'chip.action.analyze_product',
            label: lang === 'CN' ? '评估单品' : 'Evaluate one product',
            kind: 'quick_reply',
            data: {
              reply_text: lang === 'CN' ? '评估这款产品是否适合我' : 'Evaluate a specific product for me',
            },
          },
          {
            chip_id: 'chip.start.ingredients',
            label: lang === 'CN' ? '成分科学' : 'Ingredient science',
            kind: 'quick_reply',
            data: {
              reply_text:
                lang === 'CN'
                  ? '我想聊成分科学（证据/机制），先不做产品推荐。'
                  : 'I want ingredient science (evidence/mechanism), not product recommendations yet.',
            },
          },
          {
            chip_id: 'chip.start.reco_products',
            label: lang === 'CN' ? '推荐产品' : 'Recommend products',
            kind: 'quick_reply',
            data: {
              reply_text: lang === 'CN' ? '给我一些产品推荐' : 'Get product recommendations',
            },
          },
        ],
        cards: [],
        session_patch: {},
        events: [
          makeEventFn(ctx, 'loop_breaker_triggered', {
            loop_count: plannerDecision.loop_count,
            break_applied: plannerDecision.break_applied,
            required_fields: plannerDecision.required_fields.slice(0, 6),
            intent: canonicalIntent.intent || INTENT_ENUM.UNKNOWN,
          }),
        ],
      }),
    };
  }

  return {
    maybeBuildLoopBreakerEnvelope,
  };
}

module.exports = {
  createChatLoopBreakerRuntime,
};
