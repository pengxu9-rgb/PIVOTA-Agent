function createChatBoundaryRuntime(options = {}) {
  const {
    logger = null,
    collectConceptMatchesFromText = () => ({ concept_ids: [], matched_concepts_debug: [] }),
    matchIngredientOntology = () => [],
    evaluateSafety = () => null,
    buildFitCheckAnchorPrompt = () => ({ prompt: '', chips: [] }),
    buildConfidenceNoticeCardPayload = () => ({}),
    chatSafetyRuntime = null,
    INTENT_ENUM = {},
    BLOCK_LEVEL = {
      INFO: 'info',
      WARN: 'warn',
      REQUIRE_INFO: 'require_info',
      BLOCK: 'block',
    },
    GATE_MODE = {
      BYPASS: 'bypass',
      ADVISORY: 'advisory',
      BLOCK: 'block',
    },
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat boundary runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  function deriveAnchorCollectionSignal({ message = '', actionId = '' } = {}) {
    const text = String(message || '');
    const normalizedActionId = String(actionId || '').trim().toLowerCase();
    return (
      normalizedActionId === 'chip.fitcheck.send_link' ||
      normalizedActionId === 'chip.fitcheck.send_product_name' ||
      /^(send (a )?(link|url|product name)|link|url|product name|发送(链接|产品名)|产品名|链接)$/i.test(text.trim()) ||
      /(请粘贴|paste).{0,10}(link|url|链接)/i.test(text)
    );
  }

  function computeSafetyDecision(args = {}) {
    const {
      effectiveChatFlags = {},
      message = '',
      actionId = '',
      ctx = {},
      canonicalIntent = { intent: INTENT_ENUM.UNKNOWN },
      profile = null,
      hasPlannerAnchor = false,
      debugUpstream = false,
    } = args;

    const text = String(message || '');
    const anchorCollectionSignal = deriveAnchorCollectionSignal({ message: text, actionId });

    const safetyConceptMatch = collectConceptMatchesFromText({
      text,
      language: ctx.match_lang || ctx.lang,
      max: 96,
      includeSubstring: true,
      includeDebug: Boolean(debugUpstream),
    });
    const safetyConceptIds = Array.isArray(safetyConceptMatch && safetyConceptMatch.concept_ids)
      ? safetyConceptMatch.concept_ids
      : [];
    const safetyConceptsDebug = Array.isArray(safetyConceptMatch && safetyConceptMatch.matched_concepts_debug)
      ? safetyConceptMatch.matched_concepts_debug
      : [];
    const safetyOntologyHits = matchIngredientOntology({
      text,
      language: ctx.match_lang || ctx.lang,
      max: 32,
    });
    const safetyContraTags = [];
    const seenContraTags = new Set();
    for (const row of Array.isArray(safetyOntologyHits) ? safetyOntologyHits : []) {
      const tags = Array.isArray(row && row.contraindication_tags) ? row.contraindication_tags : [];
      for (const raw of tags) {
        const tag = String(raw || '').trim().toLowerCase();
        if (!tag || seenContraTags.has(tag)) continue;
        seenContraTags.add(tag);
        safetyContraTags.push(tag);
      }
    }

    const safetyDecision =
      effectiveChatFlags && effectiveChatFlags.safety_engine_v1
        ? evaluateSafety({
          intent: canonicalIntent.intent,
          message: text,
          profile,
          language: ctx.match_lang || ctx.lang,
          matched_concepts: safetyConceptIds,
          matched_concepts_debug: safetyConceptsDebug,
          ingredient_ontology_hits: safetyOntologyHits,
          contraindication_tags: safetyContraTags,
          has_product_anchor: Boolean(hasPlannerAnchor),
        })
        : null;

    return {
      anchorCollectionSignal,
      safetyDecision,
    };
  }

  function analyzeBoundaryState(args = {}) {
    const {
      message = '',
      actionId = '',
      canonicalIntent = { intent: INTENT_ENUM.UNKNOWN },
      evaluateIntent = false,
      ingredientScienceIntentEffective = false,
      conflictIntentRequested = false,
      safetyDecision: passedSafetyDecision,
      anchorCollectionSignal: passedAnchorCollectionSignal,
    } = args;

    const text = String(message || '');
    const anchorCollectionSignal =
      typeof passedAnchorCollectionSignal === 'boolean'
        ? passedAnchorCollectionSignal
        : deriveAnchorCollectionSignal({ message: text, actionId });
    const safetyDecision =
      passedSafetyDecision !== undefined
        ? passedSafetyDecision
        : computeSafetyDecision(args).safetyDecision;

    const hasSafetySensitiveActiveMention = /(retinoid|retinol|tretinoin|adapalene|hydroquinone|isotretinoin|维a|a醇|维甲酸|阿达帕林|氢醌|异维a酸)/i.test(
      text,
    );
    const shouldBypassAvailabilityShortCircuit =
      anchorCollectionSignal ||
      evaluateIntent ||
      ingredientScienceIntentEffective ||
      canonicalIntent.intent === INTENT_ENUM.TRAVEL_PLANNING ||
      canonicalIntent.intent === INTENT_ENUM.WEATHER_ENV ||
      Boolean(
        safetyDecision &&
          (
            safetyDecision.block_level === BLOCK_LEVEL.BLOCK ||
            safetyDecision.block_level === BLOCK_LEVEL.REQUIRE_INFO
          ),
      );
    const shouldRunSafetyPreGate = Boolean(
      safetyDecision &&
        (
          hasSafetySensitiveActiveMention ||
          ingredientScienceIntentEffective ||
          conflictIntentRequested ||
          canonicalIntent.intent === INTENT_ENUM.RECO_PRODUCTS ||
          canonicalIntent.intent === INTENT_ENUM.ROUTINE ||
          canonicalIntent.intent === INTENT_ENUM.TRAVEL_PLANNING ||
          canonicalIntent.intent === INTENT_ENUM.WEATHER_ENV
        ),
    );

    return {
      anchorCollectionSignal,
      safetyDecision,
      shouldBypassAvailabilityShortCircuit,
      shouldRunSafetyPreGate,
    };
  }

  function maybeBuildFitCheckAnchorEnvelope(args = {}) {
    const {
      evaluateIntent = false,
      hasFitCheckAnchor = false,
      anchorCollectionSignal = false,
      ctx,
      pushGateDecision,
      enqueueGateAdvisory,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    } = args;

    if (!evaluateIntent || hasFitCheckAnchor) return null;

    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction('makeChatAssistantMessage', makeChatAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const lang = ctx && ctx.lang === 'CN' ? 'CN' : 'EN';
    const prompt = buildFitCheckAnchorPrompt(lang);
    const reasonCodes = anchorCollectionSignal
      ? ['anchor_soft_blocked_ambiguous']
      : ['anchor_id_not_used_due_to_low_trust'];
    const firstQuestion = lang === 'CN'
      ? '请粘贴产品链接、完整产品名，或成分表（INCI）。'
      : 'Please paste the product link, full product name, or ingredient list (INCI).';
    const gate = typeof pushGateDecision === 'function'
      ? pushGateDecision('fit_check_anchor_gate', {
        reason_codes: reasonCodes,
      })
      : null;
    if (gate && gate.mode === GATE_MODE.ADVISORY && typeof enqueueGateAdvisory === 'function') {
      enqueueGateAdvisory({
        gate_id: 'fit_check_anchor_gate',
        message: prompt.prompt,
        reason_codes: reasonCodes,
        actions: ['provide_anchor_url_or_name'],
        chips: prompt.chips,
      });
      logger?.info(
        { request_id: ctx && ctx.request_id, trace_id: ctx && ctx.trace_id, question: firstQuestion },
        'aurora bff: fit-check anchor required; returning anchor collection prompt',
      );
    }

    const envelope = buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(prompt.prompt),
      suggested_chips: prompt.chips,
      cards: [
        {
          card_id: `conf_${ctx.request_id}`,
          type: 'confidence_notice',
          payload: buildConfidenceNoticeCardPayload({
            language: lang,
            reason: 'gate_advisory',
            confidence: {
              score: 0.55,
              level: 'medium',
              rationale: reasonCodes,
            },
            actions: ['provide_product_anchor'],
            details: [firstQuestion],
          }),
        },
      ],
      session_patch: {},
      events: [
        makeEventFn(ctx, 'fitcheck_anchor_requested', {
          reason_codes: reasonCodes,
        }),
      ],
    });

    return {
      envelope,
      gateType: gate && gate.mode === GATE_MODE.ADVISORY ? 'soft' : null,
    };
  }

  async function runSafetyPreGate(args = {}) {
    const {
      shouldRunSafetyPreGate = false,
      safetyDecision = null,
      profile = null,
      identity = {},
      conflictIntentRequested = false,
      pendingSafetyAdvisory = null,
      pushGateDecision,
      ctx,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      intent,
    } = args;

    if (!shouldRunSafetyPreGate) {
      return {
        profile,
        pendingSafetyAdvisory,
        blockedEnvelope: null,
      };
    }

    const resolveSafetyGate = requireMethod(chatSafetyRuntime, 'chatSafetyRuntime', 'resolveSafetyGate');
    return resolveSafetyGate({
      safety: safetyDecision,
      profile,
      identity,
      conflictIntent: conflictIntentRequested,
      pendingSafetyAdvisory,
      pushGateDecision,
      language: ctx.lang,
      variant: 'generic',
      ctx,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      intent: intent || INTENT_ENUM.UNKNOWN,
    });
  }

  return {
    computeSafetyDecision,
    analyzeBoundaryState,
    maybeBuildFitCheckAnchorEnvelope,
    runSafetyPreGate,
  };
}

module.exports = {
  createChatBoundaryRuntime,
};
