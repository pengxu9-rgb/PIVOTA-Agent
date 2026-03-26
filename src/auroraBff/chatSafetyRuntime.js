function createChatSafetyRuntime(options = {}) {
  const {
    chatAdvisoryRuntime,
    INTENT_ENUM = {
      UNKNOWN: 'unknown',
    },
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat safety runtime missing dependency: ${name}`);
  }

  function requireAdvisoryMethod(name) {
    const advisory = chatAdvisoryRuntime && typeof chatAdvisoryRuntime === 'object'
      ? chatAdvisoryRuntime
      : null;
    const value = advisory ? advisory[name] : null;
    return requireFunction(name, value);
  }

  function buildSafetyNoticeText({ safety, language } = {}) {
    const buildNotice = requireAdvisoryMethod('buildSafetyNoticeText');
    return buildNotice({ safety, language });
  }

  function buildSafetyBlockEnvelope({
    variant = 'generic',
    ctx,
    safety,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
    attachIngredientRouteMetaToSessionPatch,
    ingredientRouteMeta = null,
    intent = null,
    language = null,
  } = {}) {
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const lang = String(language || (ctx && ctx.lang) || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
    const safetyText = buildSafetyNoticeText({ safety, language: lang });
    const detailLines = [
      ...(Array.isArray(safety && safety.reasons) ? safety.reasons.slice(0, 3) : []),
      ...(Array.isArray(safety && safety.safe_alternatives) ? safety.safe_alternatives.slice(0, 3) : []),
    ];

    if (variant === 'ingredient') {
      const attachIngredientMeta = requireFunction(
        'attachIngredientRouteMetaToSessionPatch',
        attachIngredientRouteMetaToSessionPatch,
      );
      return buildEnvelopeFn(ctx, {
        assistant_message: makeAssistantMessageFn(
          safetyText ||
            (lang === 'CN'
              ? '这个方向当前存在安全风险，我先给你更安全替代。'
              : 'There is a safety risk for this path, so I’ll switch to safer alternatives first.'),
        ),
        suggested_chips: [
          {
            chip_id: 'chip.start.ingredients.safe_alternatives',
            label: lang === 'CN' ? '看更安全替代' : 'Show safer alternatives',
            kind: 'quick_reply',
            data: {
              reply_text:
                lang === 'CN'
                  ? '请给我更安全替代成分（机制+注意事项）'
                  : 'Show safer alternative ingredients (mechanism + watchouts)',
            },
          },
        ],
        cards: [
          {
            card_id: `safety_${ctx.request_id}`,
            type: 'confidence_notice',
            payload: {
              severity: 'block',
              message:
                lang === 'CN'
                  ? '该方向存在安全风险，已切换到更保守建议。'
                  : 'This path carries safety risk; switched to conservative guidance.',
              details: detailLines,
              actions: ['safe_alternatives'],
            },
          },
        ],
        session_patch: attachIngredientMeta({}, ingredientRouteMeta || {}),
        events: [
          makeEventFn(ctx, 'safety_gate_block', {
            intent: 'ingredient_science',
            block_level: safety && safety.block_level ? safety.block_level : null,
          }),
        ],
      });
    }

    if (variant === 'reco') {
      return buildEnvelopeFn(ctx, {
        assistant_message: makeAssistantMessageFn(
          safetyText ||
            (lang === 'CN'
              ? '当前存在安全风险，先不输出激进推荐。'
              : 'Current safety risk detected, so I will not output aggressive recommendations.'),
        ),
        suggested_chips: [
          {
            chip_id: 'chip.start.ingredients',
            label: lang === 'CN' ? '成分科学（更安全替代）' : 'Ingredient science (safe alternatives)',
            kind: 'quick_reply',
            data: {
              reply_text:
                lang === 'CN'
                  ? '我想看更安全替代方案（成分机制）'
                  : 'Show me safer alternatives with ingredient mechanism',
            },
          },
          {
            chip_id: 'chip.start.routine',
            label: lang === 'CN' ? '先做温和routine' : 'Build gentle routine first',
            kind: 'quick_reply',
            data: {
              reply_text:
                lang === 'CN'
                  ? '先给我一套温和修护routine'
                  : 'Build a gentle barrier-first routine for me',
            },
          },
        ],
        cards: [
          {
            card_id: `safety_${ctx.request_id}`,
            type: 'confidence_notice',
            payload: {
              severity: 'block',
              message:
                lang === 'CN'
                  ? '检测到安全风险，已切换保守路径。'
                  : 'Safety risk detected; switched to conservative path.',
              details: detailLines,
              actions: ['safe_alternatives', 'profile_update'],
            },
          },
        ],
        session_patch: {},
        events: [
          makeEventFn(ctx, 'safety_gate_block', {
            intent: intent || INTENT_ENUM.UNKNOWN,
            block_level: safety && safety.block_level ? safety.block_level : null,
          }),
        ],
      });
    }

    return buildEnvelopeFn(ctx, {
      assistant_message: makeAssistantMessageFn(
        safetyText ||
          (lang === 'CN'
            ? '这个方向当前存在安全风险，我先给你更安全替代。'
            : 'There is a safety risk for this path, so I’ll switch to safer alternatives first.'),
      ),
      suggested_chips: [
        {
          chip_id: 'chip.start.ingredients.safe_alternatives',
          label: lang === 'CN' ? '看更安全替代' : 'Show safer alternatives',
          kind: 'quick_reply',
          data: {
            reply_text:
              lang === 'CN'
                ? '请给我更安全替代成分（机制+注意事项）'
                : 'Show safer alternative ingredients (mechanism + watchouts)',
          },
        },
      ],
      cards: [
        {
          card_id: `safety_${ctx.request_id}`,
          type: 'confidence_notice',
          payload: {
            severity: 'block',
            message:
              lang === 'CN'
                ? '该方向存在安全风险，已切换到更保守建议。'
                : 'This path carries safety risk; switched to conservative guidance.',
            details: detailLines,
            actions: ['safe_alternatives'],
          },
        },
      ],
      session_patch: {},
      events: [
        makeEventFn(ctx, 'safety_gate_block', {
          intent: intent || INTENT_ENUM.UNKNOWN,
          block_level: safety && safety.block_level ? safety.block_level : null,
        }),
      ],
    });
  }

  async function resolveSafetyGate({
    safety,
    profile,
    identity,
    conflictIntent = false,
    pendingSafetyAdvisory = null,
    pushGateDecision,
    language,
    variant = 'generic',
    ctx,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
    attachIngredientRouteMetaToSessionPatch,
    ingredientRouteMeta = null,
    intent = null,
  } = {}) {
    const resolveGateAction = requireAdvisoryMethod('resolveSafetyGateAction');
    const mergePendingAdvisory = requireAdvisoryMethod('mergePendingSafetyAdvisory');
    const persistAskedOnce = requireAdvisoryMethod('persistSafetyPromptAskedOnce');
    const gateAction = resolveGateAction({
      safety,
      profileValue: profile,
      conflictIntent,
      language,
      pushGateDecision,
    });

    let nextPendingSafetyAdvisory = pendingSafetyAdvisory;
    let nextProfile = profile;
    if (gateAction.mode === 'inline' && gateAction.advisory) {
      nextPendingSafetyAdvisory = mergePendingAdvisory({
        pendingSafetyAdvisory,
        incoming: gateAction.advisory,
      });
      nextProfile = await persistAskedOnce({
        fields: gateAction.ask_once_fields,
        profile: nextProfile,
        identity,
      });
    }

    const blockedEnvelope =
      gateAction.mode === 'block'
        ? buildSafetyBlockEnvelope({
          variant,
          ctx,
          safety,
          buildEnvelope,
          makeChatAssistantMessage,
          makeEvent,
          attachIngredientRouteMetaToSessionPatch,
          ingredientRouteMeta,
          intent,
          language,
        })
        : null;

    return {
      gateAction,
      profile: nextProfile,
      pendingSafetyAdvisory: nextPendingSafetyAdvisory,
      blockedEnvelope,
    };
  }

  return {
    buildSafetyNoticeText,
    buildSafetyBlockEnvelope,
    resolveSafetyGate,
  };
}

module.exports = {
  createChatSafetyRuntime,
};
