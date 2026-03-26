function createChatIngredientEntryRuntime(options = {}) {
  const {
    logger = null,
    pickFirstTrimmed,
    mergeIngredientRecoContextValue,
    buildIngredientHubCardPayload,
    buildIngredientHubQuickReplyChips,
    buildIngredientGoalMatchPayload,
    enrichIngredientGoalMatchPayload,
    buildIngredientScienceKickoff,
    stateChangeAllowed,
    recordAuroraIngredientsFlowMetric = () => {},
    chatIngredientLookupRuntime = null,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat ingredient entry runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function resolveIngredientEntryEnvelope(args = {}) {
    const {
      ctx = {},
      req,
      identity = null,
      profile = null,
      ingredientRecoContext = null,
      ingredientGoalRequest = { goal: '', sensitivity: 'unknown' },
      nextStateOverride = null,
      message = '',
      ingredientEntryRequested = false,
      ingredientByGoalRequested = false,
      ingredientLookupRequested = false,
      ingredientResearchPollRequested = false,
      ingredientTextQueryFirstEligible = false,
      shouldKickoffIngredientScience = false,
      ingredientScienceIntentEffective = false,
      ingredientTextTrigger = false,
      ingredientRouteDecisionReasons = [],
      ingredientLookupQuery = '',
      ingredientLookupTargetFromText = '',
      ingredientEntityMatch = { entity_match_type: 'none' },
      ingredientActionData = null,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      buildSafetyNoticeText = () => '',
      safetyDecision = null,
    } = args;

    const pickFirstTrimmedFn = requireFunction('pickFirstTrimmed', pickFirstTrimmed);
    const mergeIngredientRecoContextValueFn = requireFunction(
      'mergeIngredientRecoContextValue',
      mergeIngredientRecoContextValue,
    );
    const buildIngredientHubCardPayloadFn = requireFunction(
      'buildIngredientHubCardPayload',
      buildIngredientHubCardPayload,
    );
    const buildIngredientHubQuickReplyChipsFn = requireFunction(
      'buildIngredientHubQuickReplyChips',
      buildIngredientHubQuickReplyChips,
    );
    const buildIngredientGoalMatchPayloadFn = requireFunction(
      'buildIngredientGoalMatchPayload',
      buildIngredientGoalMatchPayload,
    );
    const enrichIngredientGoalMatchPayloadFn = requireFunction(
      'enrichIngredientGoalMatchPayload',
      enrichIngredientGoalMatchPayload,
    );
    const buildIngredientScienceKickoffFn = requireFunction(
      'buildIngredientScienceKickoff',
      buildIngredientScienceKickoff,
    );
    const stateChangeAllowedFn = requireFunction('stateChangeAllowed', stateChangeAllowed);
    const buildIngredientLookupEnvelope = requireMethod(
      chatIngredientLookupRuntime,
      'chatIngredientLookupRuntime',
      'buildIngredientLookupEnvelope',
    );
    const attachIngredientRouteMetaToSessionPatch = requireMethod(
      chatIngredientLookupRuntime,
      'chatIngredientLookupRuntime',
      'attachIngredientRouteMetaToSessionPatch',
    );
    const attachIngredientContextMetaToSessionPatch = requireMethod(
      chatIngredientLookupRuntime,
      'chatIngredientLookupRuntime',
      'attachIngredientContextMetaToSessionPatch',
    );

    if (ingredientEntryRequested) {
      const hubPayload = buildIngredientHubCardPayloadFn({ language: ctx.lang });
      const assistantText =
        ctx.lang === 'CN'
          ? '成分入口已切到“查询优先”。你可以先查具体成分，或按功效找成分；诊断是可选项。'
          : 'Ingredients now starts in query-first mode. You can lookup a specific ingredient or find by goal first; diagnosis is optional.';
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeChatAssistantMessage(assistantText),
        suggested_chips: buildIngredientHubQuickReplyChipsFn({ language: ctx.lang }),
        cards: [
          {
            card_id: `ingredient_hub_${ctx.request_id}`,
            type: 'ingredient_hub',
            payload: hubPayload,
          },
        ],
        session_patch: attachIngredientContextMetaToSessionPatch(
          attachIngredientRouteMetaToSessionPatch(
            nextStateOverride && stateChangeAllowedFn(ctx.trigger_source) ? { next_state: nextStateOverride } : {},
            {
              routeSource: 'chip',
              routeDecisionReasons: ['hub_entry', ...ingredientRouteDecisionReasons],
              routeRuleVersion: args.INGREDIENT_ROUTE_RULE_VERSION,
            },
          ),
          ingredientRecoContext,
        ),
        events: [makeEvent(ctx, 'state_entered', { next_state: ctx.state || 'idle', reason: 'ingredient_hub_entry' })],
      });
      return {
        handled: true,
        envelope,
        ingredientRecoContext,
        requestMessage: 'ingredient_hub_entry',
      };
    }

    if (ingredientByGoalRequested) {
      const requestedGoal = ingredientGoalRequest.goal || 'barrier';
      let nextIngredientRecoContext = mergeIngredientRecoContextValueFn(ingredientRecoContext, {
        goal: requestedGoal,
        sensitivity: ingredientGoalRequest.sensitivity,
        source: ingredientTextTrigger ? 'text_goal' : 'chip_goal',
        updated_at_ms: Date.now(),
      });
      const goalPayloadBase = buildIngredientGoalMatchPayloadFn({
        language: ctx.lang,
        goal: requestedGoal,
        sensitivity: ingredientGoalRequest.sensitivity,
      });
      const goalPayload = await enrichIngredientGoalMatchPayloadFn({
        basePayload: goalPayloadBase,
        language: ctx.lang,
        goal: requestedGoal,
        sensitivity: ingredientGoalRequest.sensitivity,
        logger,
      });
      nextIngredientRecoContext = mergeIngredientRecoContextValueFn(nextIngredientRecoContext, {
        candidates: Array.isArray(goalPayload && goalPayload.candidate_ingredients)
          ? goalPayload.candidate_ingredients.map((item) =>
            pickFirstTrimmedFn(item && item.ingredient, item && item.name),
          ).filter(Boolean)
          : [],
        source: ingredientTextTrigger ? 'text_goal' : 'chip_goal',
        updated_at_ms: Date.now(),
      });
      const assistantText =
        ctx.lang === 'CN'
          ? `已按“${goalPayload.goal_label}”给你整理候选成分与避坑组合。`
          : `I mapped candidate ingredients and avoid-pairs for “${goalPayload.goal_label}”.`;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeChatAssistantMessage(assistantText),
        suggested_chips: buildIngredientHubQuickReplyChipsFn({ language: ctx.lang }),
        cards: [
          {
            card_id: `ingredient_goal_match_${ctx.request_id}`,
            type: 'ingredient_goal_match',
            payload: goalPayload,
          },
        ],
        session_patch: attachIngredientContextMetaToSessionPatch(
          attachIngredientRouteMetaToSessionPatch(
            nextStateOverride && stateChangeAllowedFn(ctx.trigger_source) ? { next_state: nextStateOverride } : {},
            {
              routeSource: 'chip',
              routeDecisionReasons: ['goal_match', ...ingredientRouteDecisionReasons],
              routeRuleVersion: args.INGREDIENT_ROUTE_RULE_VERSION,
            },
          ),
          nextIngredientRecoContext,
        ),
        events: [makeEvent(ctx, 'state_entered', { next_state: ctx.state || 'idle', reason: 'ingredient_goal_match' })],
      });
      return {
        handled: true,
        envelope,
        ingredientRecoContext: nextIngredientRecoContext,
        requestMessage: 'ingredient_goal_match',
      };
    }

    if (ingredientLookupRequested && !message && !ingredientLookupQuery) {
      const hubPayload = buildIngredientHubCardPayloadFn({ language: ctx.lang });
      const assistantText =
        ctx.lang === 'CN'
          ? '你想查哪个成分？输入 INCI 或常见别名即可。'
          : 'Which ingredient should I look up? Enter an INCI name or common alias.';
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeChatAssistantMessage(assistantText),
        suggested_chips: buildIngredientHubQuickReplyChipsFn({ language: ctx.lang }),
        cards: [
          {
            card_id: `ingredient_hub_${ctx.request_id}`,
            type: 'ingredient_hub',
            payload: hubPayload,
          },
        ],
        session_patch: attachIngredientContextMetaToSessionPatch(
          attachIngredientRouteMetaToSessionPatch(
            nextStateOverride && stateChangeAllowedFn(ctx.trigger_source) ? { next_state: nextStateOverride } : {},
            {
              routeSource: 'chip',
              routeDecisionReasons: ['lookup_missing_query', ...ingredientRouteDecisionReasons],
              routeRuleVersion: args.INGREDIENT_ROUTE_RULE_VERSION,
            },
          ),
          ingredientRecoContext,
        ),
        events: [makeEvent(ctx, 'state_entered', { next_state: ctx.state || 'idle', reason: 'ingredient_lookup_missing_query' })],
      });
      return {
        handled: true,
        envelope,
        ingredientRecoContext,
        requestMessage: 'ingredient_lookup_missing_query',
      };
    }

    const ingredientLookupTarget = ingredientLookupRequested
      ? pickFirstTrimmedFn(
        ingredientLookupQuery,
        typeof message === 'string' ? message.trim().slice(0, 120) : '',
      )
      : '';

    if (ingredientLookupRequested && ingredientLookupTarget) {
      const envelope = await buildIngredientLookupEnvelope({
        ctx,
        req,
        identity,
        profile,
        ingredientRecoContext,
        ingredientGoalRequest,
        nextStateOverride,
        lookupTarget: ingredientLookupTarget,
        routeSource: 'chip',
        queryFirstApplied: false,
        reasonTag: 'ingredient_lookup_report',
        explicitRouteReasons: ['lookup_action_hit', ...ingredientRouteDecisionReasons],
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
      });
      if (envelope) {
        return {
          handled: true,
          envelope,
          ingredientRecoContext,
          requestMessage: 'ingredient_lookup_report',
        };
      }
    }

    if (ingredientResearchPollRequested) {
      const pollQuery = pickFirstTrimmedFn(
        ingredientActionData && ingredientActionData.ingredient_query,
        ingredientActionData && ingredientActionData.query,
        ingredientActionData && ingredientActionData.normalized_query,
        ingredientRecoContext && ingredientRecoContext.query,
      );
      if (!pollQuery) {
        const assistantText =
          ctx.lang === 'CN'
            ? '我还不知道你要查哪个成分。请先输入成分名（INCI/别名）。'
            : 'I do not have an ingredient target yet. Please enter the ingredient name (INCI/alias).';
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeChatAssistantMessage(assistantText),
          suggested_chips: buildIngredientHubQuickReplyChipsFn({ language: ctx.lang }),
          cards: [
            {
              card_id: `ingredient_hub_${ctx.request_id}`,
              type: 'ingredient_hub',
              payload: buildIngredientHubCardPayloadFn({ language: ctx.lang }),
            },
          ],
          session_patch: attachIngredientRouteMetaToSessionPatch(
            {},
            {
              routeSource: ingredientTextTrigger ? 'text' : 'chip',
              routeDecisionReasons: ['poll_missing_query', ...ingredientRouteDecisionReasons],
              routeRuleVersion: args.INGREDIENT_ROUTE_RULE_VERSION,
            },
          ),
          events: [makeEvent(ctx, 'state_entered', { next_state: ctx.state || 'idle', reason: 'ingredient_poll_missing_query' })],
        });
        return {
          handled: true,
          envelope,
          ingredientRecoContext,
          requestMessage: '',
        };
      }
      const envelope = await buildIngredientLookupEnvelope({
        ctx,
        req,
        identity,
        profile,
        ingredientRecoContext,
        ingredientGoalRequest,
        nextStateOverride,
        lookupTarget: pollQuery,
        routeSource: ingredientTextTrigger ? 'text' : 'chip',
        queryFirstApplied: ingredientTextTrigger,
        reasonTag: 'ingredient_research_poll',
        explicitRouteReasons: ['research_poll', ...ingredientRouteDecisionReasons],
        skipRateLimit: true,
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
      });
      if (envelope) {
        return {
          handled: true,
          envelope,
          ingredientRecoContext,
          requestMessage: 'ingredient_research_poll',
        };
      }
    }

    if (ingredientTextQueryFirstEligible) {
      recordAuroraIngredientsFlowMetric({ stage: 'text_query_routed', hit: true });
      const baseSessionPatch =
        nextStateOverride && stateChangeAllowedFn(ctx.trigger_source) ? { next_state: nextStateOverride } : {};
      const sessionPatch = attachIngredientRouteMetaToSessionPatch(baseSessionPatch, {
        queryFirstApplied: true,
        routeSource: 'text',
        routeDecisionReasons: ['text_query_routed', ...ingredientRouteDecisionReasons],
        routeRuleVersion: args.INGREDIENT_ROUTE_RULE_VERSION,
      });
      if (ingredientLookupTargetFromText) {
        const envelope = await buildIngredientLookupEnvelope({
          ctx,
          req,
          identity,
          profile,
          ingredientRecoContext,
          ingredientGoalRequest,
          nextStateOverride,
          lookupTarget: ingredientLookupTargetFromText,
          routeSource: 'text',
          queryFirstApplied: true,
          reasonTag: 'ingredient_text_lookup_report',
          explicitRouteReasons: [
            'text_query_routed',
            ingredientEntityMatch.entity_match_type === 'none' ? 'entity_fallback_from_text' : '',
            ...ingredientRouteDecisionReasons,
          ].filter(Boolean),
          buildEnvelope,
          makeChatAssistantMessage,
          makeEvent,
        });
        if (envelope) {
          return {
            handled: true,
            envelope,
            ingredientRecoContext,
            requestMessage: 'ingredient_text_lookup_report',
          };
        }
      }

      const hubPayload = buildIngredientHubCardPayloadFn({ language: ctx.lang });
      const assistantText =
        ctx.lang === 'CN'
          ? '你可以先查具体成分，或按功效找成分；开始诊断是可选项。'
          : 'You can start with a specific ingredient lookup or find by goal first; diagnosis is optional.';
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeChatAssistantMessage(assistantText),
        suggested_chips: buildIngredientHubQuickReplyChipsFn({ language: ctx.lang }),
        cards: [
          {
            card_id: `ingredient_hub_${ctx.request_id}`,
            type: 'ingredient_hub',
            payload: hubPayload,
          },
        ],
        session_patch: attachIngredientContextMetaToSessionPatch(sessionPatch, ingredientRecoContext),
        events: [makeEvent(ctx, 'state_entered', { next_state: ctx.state || 'idle', reason: 'ingredient_text_query_hub' })],
      });
      return {
        handled: true,
        envelope,
        ingredientRecoContext,
        requestMessage: 'ingredient_text_query_hub',
      };
    }

    if (shouldKickoffIngredientScience) {
      const kickoff = buildIngredientScienceKickoffFn({ language: ctx.lang });
      const safetyPrefix =
        ingredientScienceIntentEffective &&
        safetyDecision &&
        safetyDecision.block_level === 'warn'
          ? buildSafetyNoticeText(safetyDecision)
          : '';
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeChatAssistantMessage([safetyPrefix, kickoff.prompt].filter(Boolean).join('\n\n')),
        suggested_chips: kickoff.chips,
        cards: [],
        session_patch:
          nextStateOverride && stateChangeAllowedFn(ctx.trigger_source) ? { next_state: nextStateOverride } : {},
        events: [makeEvent(ctx, 'state_entered', { next_state: ctx.state || 'idle', reason: 'ingredient_science_clarify' })],
      });
      return {
        handled: true,
        envelope,
        ingredientRecoContext,
        requestMessage: '',
      };
    }

    return {
      handled: false,
      envelope: null,
      ingredientRecoContext,
      requestMessage: '',
    };
  }

  return {
    resolveIngredientEntryEnvelope,
  };
}

module.exports = {
  createChatIngredientEntryRuntime,
};
