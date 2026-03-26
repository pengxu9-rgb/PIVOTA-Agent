function createChatFollowupRuntime(options = {}) {
  const {
    logger = null,
    ANALYSIS_FOLLOWUP_ACTION_IDS,
    buildAnalysisFollowupContent,
    recordAuroraSkinFlowMetric = () => {},
    pickFirstTrimmed,
    buildConfidenceNoticeCardPayload,
    PRODUCT_URL_INGREDIENT_ANALYSIS_ENABLED = false,
    buildProductAnalysisFromUrlIngredients,
    applyProductAnalysisGapContract,
    initCandidateFilterStats,
    buildRealtimeCompetitorCandidates,
    PRODUCT_URL_REALTIME_COMPETITOR_TIMEOUT_MS = 2400,
    PRODUCT_URL_REALTIME_COMPETITOR_MAX_QUERIES = 4,
    PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES = 6,
    sanitizeCompetitorCandidates,
    routeCompetitorCandidatePools,
    uniqCaseInsensitiveStrings,
    asStringArray,
    joinBrandAndName,
    normalizeProductAnalysis,
    reconcileProductAnalysisConsistency,
    finalizeProductAnalysisRecoContract,
    enrichProductAnalysisPayload,
    stripInternalRefsDeep,
    isPlainObject,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat followup runtime missing dependency: ${name}`);
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function buildAnalysisFollowupActionMetric(actionId) {
    return `analysis_followup_${String(actionId || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(-48)}`;
  }

  function maybeBuildAnalysisFollowupEnvelope({
    ctx,
    actionId = '',
    profile = null,
    actionReplyText = '',
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
  } = {}) {
    const followupActionIds = ANALYSIS_FOLLOWUP_ACTION_IDS instanceof Set ? ANALYSIS_FOLLOWUP_ACTION_IDS : new Set();
    const normalizedActionId = String(actionId || '').trim();
    if (!followupActionIds.has(normalizedActionId)) return null;

    const buildAnalysisFollowupContentFn = requireFunction(
      'buildAnalysisFollowupContent',
      buildAnalysisFollowupContent,
    );
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction(
      'makeChatAssistantMessage',
      makeChatAssistantMessage,
    );
    const makeEventFn = requireFunction('makeEvent', makeEvent);

    const followup = buildAnalysisFollowupContentFn({
      actionId: normalizedActionId,
      lastAnalysis: profile && profile.lastAnalysis,
      language: ctx && ctx.lang,
      requestId: ctx && ctx.request_id,
      replyText: actionReplyText,
    });

    recordAuroraSkinFlowMetric({ stage: 'analysis_followup_action', hit: true });
    recordAuroraSkinFlowMetric({
      stage: buildAnalysisFollowupActionMetric(normalizedActionId),
      hit: true,
    });

    if (logger && typeof logger.info === 'function') {
      logger.info(
        { kind: 'metric', name: 'aurora.skin.analysis_followup.routed_rate', value: 1 },
        'metric',
      );
    }

    return buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(followup.assistant_text),
      suggested_chips: Array.isArray(followup.suggested_chips) ? followup.suggested_chips : [],
      cards: Array.isArray(followup.cards) ? followup.cards : [],
      session_patch: {},
      events: [
        makeEventFn(ctx, 'analysis_followup_action_routed', {
          action_id: normalizedActionId,
          used_last_analysis: Boolean(followup.used_last_analysis),
          missing_context: Boolean(followup.missing_context),
          fell_back_to_generic: false,
        }),
      ],
    });
  }

  function extractCandidateText(candidate) {
    const c = asObject(candidate);
    const why = requireFunction('uniqCaseInsensitiveStrings', uniqCaseInsensitiveStrings)(
      [
        ...requireFunction('asStringArray', asStringArray)(c.why_candidate),
        ...requireFunction('asStringArray', asStringArray)(c.compare_highlights),
        ...requireFunction('asStringArray', asStringArray)(c.tradeoff_notes),
        ...requireFunction('asStringArray', asStringArray)(c.expected_outcome),
        ...requireFunction('asStringArray', asStringArray)(c.best_use),
      ],
      12,
    );
    const title = requireFunction('pickFirstTrimmed', pickFirstTrimmed)(
      c.brand,
      c.name,
      c.display_name,
      c.displayName,
    );
    return `${title} ${why.join(' | ')}`.toLowerCase();
  }

  function scoreCandidateForGoal(goalToken, candidate) {
    if (!goalToken) return 1;
    const text = extractCandidateText(candidate);
    let score = 0;
    if (goalToken === 'acne_focus') {
      if (/\b(acne|blemish|comedone|pores?|oil|sebum|salicylic|benzoyl|niacinamide|azelaic|retino|adapalene|tretinoin|zinc)\b|痘|控油|毛孔|闭口|水杨酸/.test(text)) {
        score += 3;
      }
      if (/\b(dry|drying|tight|stinging|irritat|peel|flake)\b|干燥|刺激|刺痛|起皮/.test(text)) {
        score -= 1;
      }
      return score;
    }
    if (goalToken === 'less_drying') {
      if (/\b(hydrat|moistur|barrier|ceramide|panthenol|glycerin|hyaluron|soothing|repair)\b|保湿|修护|屏障|神经酰胺|泛醇|舒缓/.test(text)) {
        score += 3;
      }
      if (/\b(dry|drying|tight|stinging|irritat|peel|flake|acid|retino|fragrance)\b|干燥|刺激|刺痛|起皮|酸|香精/.test(text)) {
        score -= 2;
      }
      return score;
    }
    if (goalToken === 'pros_cons') return 1;
    return 0;
  }

  function rankCandidatesByGoal(goalToken, rows) {
    const list = Array.isArray(rows) ? rows : [];
    const scored = list.map((candidate) => ({
      candidate,
      score: scoreCandidateForGoal(goalToken, candidate),
      similarity: Number(candidate && candidate.similarity_score) || 0,
    }));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.similarity - a.similarity;
    });
    if (goalToken === 'acne_focus' || goalToken === 'less_drying') {
      const positive = scored.filter((row) => row.score > 0).map((row) => row.candidate);
      return positive.length ? positive : scored.map((row) => row.candidate);
    }
    return scored.map((row) => row.candidate);
  }

  async function maybeBuildFollowupAlternativesEnvelope({
    ctx,
    actionId = '',
    normalizedActionPayload = null,
    message = '',
    anchorProductId = '',
    anchorProductUrl = '',
    debugUpstream = false,
    profile = null,
    summarizeChatProfileForContext,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
  } = {}) {
    const normalizedActionId = String(actionId || '').trim().toLowerCase();
    if (normalizedActionId !== 'chat.followup.alternatives') return null;

    const pickFirstTrimmedFn = requireFunction('pickFirstTrimmed', pickFirstTrimmed);
    const buildConfidenceNoticeCardPayloadFn = requireFunction(
      'buildConfidenceNoticeCardPayload',
      buildConfidenceNoticeCardPayload,
    );
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction(
      'makeChatAssistantMessage',
      makeChatAssistantMessage,
    );
    const makeEventFn = requireFunction('makeEvent', makeEvent);
    const summarizeChatProfileForContextFn = requireFunction(
      'summarizeChatProfileForContext',
      summarizeChatProfileForContext,
    );
    const isPlainObjectFn = requireFunction('isPlainObject', isPlainObject);
    const applyProductAnalysisGapContractFn = requireFunction(
      'applyProductAnalysisGapContract',
      applyProductAnalysisGapContract,
    );
    const initCandidateFilterStatsFn = requireFunction(
      'initCandidateFilterStats',
      initCandidateFilterStats,
    );
    const buildRealtimeCompetitorCandidatesFn = requireFunction(
      'buildRealtimeCompetitorCandidates',
      buildRealtimeCompetitorCandidates,
    );
    const sanitizeCompetitorCandidatesFn = requireFunction(
      'sanitizeCompetitorCandidates',
      sanitizeCompetitorCandidates,
    );
    const routeCompetitorCandidatePoolsFn = requireFunction(
      'routeCompetitorCandidatePools',
      routeCompetitorCandidatePools,
    );
    const uniqCaseInsensitiveStringsFn = requireFunction(
      'uniqCaseInsensitiveStrings',
      uniqCaseInsensitiveStrings,
    );
    const asStringArrayFn = requireFunction('asStringArray', asStringArray);
    const joinBrandAndNameFn = requireFunction('joinBrandAndName', joinBrandAndName);
    const normalizeProductAnalysisFn = requireFunction(
      'normalizeProductAnalysis',
      normalizeProductAnalysis,
    );
    const reconcileProductAnalysisConsistencyFn = requireFunction(
      'reconcileProductAnalysisConsistency',
      reconcileProductAnalysisConsistency,
    );
    const finalizeProductAnalysisRecoContractFn = requireFunction(
      'finalizeProductAnalysisRecoContract',
      finalizeProductAnalysisRecoContract,
    );
    const enrichProductAnalysisPayloadFn = requireFunction(
      'enrichProductAnalysisPayload',
      enrichProductAnalysisPayload,
    );
    const stripInternalRefsDeepFn = requireFunction('stripInternalRefsDeep', stripInternalRefsDeep);

    const followupData =
      normalizedActionPayload &&
      typeof normalizedActionPayload === 'object' &&
      normalizedActionPayload.data &&
      typeof normalizedActionPayload.data === 'object' &&
      !Array.isArray(normalizedActionPayload.data)
        ? normalizedActionPayload.data
        : {};
    const followupGoal = pickFirstTrimmedFn(
      followupData.goal,
      followupData.followup_goal,
      followupData.intent,
    ) || '';
    const followupAnchor =
      followupData.anchor && typeof followupData.anchor === 'object' && !Array.isArray(followupData.anchor)
        ? followupData.anchor
        : {};
    const anchorProductUrlUsed = pickFirstTrimmedFn(
      followupAnchor.url,
      followupAnchor.anchor_product_url,
      anchorProductUrl,
    );
    const anchorProductIdUsed = pickFirstTrimmedFn(
      followupAnchor.product_id,
      followupAnchor.sku_id,
      followupAnchor.anchor_product_id,
      anchorProductId,
    );
    const anchorBrand = pickFirstTrimmedFn(followupAnchor.brand, followupAnchor.anchor_brand);
    const anchorName = pickFirstTrimmedFn(followupAnchor.name, followupAnchor.anchor_name);
    const anchorDisplayName = pickFirstTrimmedFn(
      followupAnchor.display_name,
      followupAnchor.anchor_display_name,
    );
    const hasAnchor = Boolean(
      pickFirstTrimmedFn(anchorProductUrlUsed, anchorProductIdUsed, anchorBrand, anchorName, anchorDisplayName),
    );
    const lang = ctx && ctx.lang === 'CN' ? 'CN' : 'EN';

    if (!hasAnchor) {
      const noticeDetail =
        lang === 'CN'
          ? '需要一个锚点产品（URL/产品名/产品图）才能继续做 follow-up alternatives。'
          : 'An anchor product (URL/name/photo) is required to continue follow-up alternatives.';
      return buildEnvelopeFn(ctx, {
        assistant_message: makeChatAssistantMessageFn(
          lang === 'CN'
            ? '我先保持当前分析，不会乱给替代品。请补一个锚点产品（URL/名称/图片），我再给你 acne-focused 的明确推荐。'
            : 'I will avoid off-target alternatives for now. Share an anchor product (URL/name/photo), then I can give you a clear acne-focused pick.',
        ),
        suggested_chips: [
          {
            chip_id: 'chip.action.analyze_product',
            label: lang === 'CN' ? '补产品 URL' : 'Add product URL',
            kind: 'quick_reply',
            data: {
              reply_text: lang === 'CN' ? '我补一个产品链接' : 'I will add a product URL',
            },
          },
          {
            chip_id: 'chip.action.parse_product',
            label: lang === 'CN' ? '补产品名称' : 'Add product name',
            kind: 'quick_reply',
            data: {
              reply_text: lang === 'CN' ? '我补一个产品名称' : 'I will add a product name',
            },
          },
        ],
        cards: [
          {
            card_id: `conf_${ctx.request_id}`,
            type: 'confidence_notice',
            payload: buildConfidenceNoticeCardPayloadFn({
              language: ctx && ctx.lang,
              reason: 'default',
              confidence: { score: 0.38, level: 'low', rationale: ['followup_anchor_missing'] },
              actions: ['upload_product_photo', 'paste_product_url', 'paste_product_name'],
              details: [noticeDetail],
            }),
          },
        ],
        session_patch: {
          meta: {
            followup_goal: followupGoal || null,
          },
        },
        events: [
          makeEventFn(ctx, 'value_moment', {
            kind: 'product_analyze_followup',
            followup_goal: followupGoal || null,
            anchored: false,
          }),
        ],
      });
    }

    const anchorForPayload = {
      ...(anchorProductIdUsed ? { product_id: anchorProductIdUsed, sku_id: anchorProductIdUsed } : {}),
      ...(anchorBrand ? { brand: anchorBrand } : {}),
      ...(anchorName ? { name: anchorName } : {}),
      ...(anchorDisplayName ? { display_name: anchorDisplayName } : {}),
      ...(anchorProductUrlUsed ? { url: anchorProductUrlUsed } : {}),
    };
    const followupReasons =
      lang === 'CN'
        ? [
            '已锚定当前产品并进入 follow-up alternatives 分析。',
            '将优先给出与当前目标最相关的替代方向，并明确取舍点。',
          ]
        : [
            'Anchored to the current product for follow-up alternatives analysis.',
            'I will prioritize alternatives that match your current goal and explain key tradeoffs.',
          ];
    const profileSummaryForFollowup = summarizeChatProfileForContextFn(profile);

    function hasAnyAlternatives(rawPayload) {
      const payloadObj = isPlainObjectFn(rawPayload) ? rawPayload : null;
      if (!payloadObj) return false;
      const comp = Array.isArray(payloadObj?.competitors?.candidates) ? payloadObj.competitors.candidates : [];
      const rel = Array.isArray(payloadObj?.related_products?.candidates)
        ? payloadObj.related_products.candidates
        : Array.isArray(payloadObj?.relatedProducts?.candidates)
          ? payloadObj.relatedProducts.candidates
          : [];
      const dupes = Array.isArray(payloadObj?.dupes?.candidates) ? payloadObj.dupes.candidates : [];
      return comp.length + rel.length + dupes.length > 0;
    }

    let followupPayloadSeed = null;
    if (anchorProductUrlUsed && PRODUCT_URL_INGREDIENT_ANALYSIS_ENABLED) {
      try {
        const buildProductAnalysisFromUrlIngredientsFn = requireFunction(
          'buildProductAnalysisFromUrlIngredients',
          buildProductAnalysisFromUrlIngredients,
        );
        const urlNorm = await buildProductAnalysisFromUrlIngredientsFn({
          productUrl: anchorProductUrlUsed,
          lang: ctx && ctx.lang,
          profileSummary: profileSummaryForFollowup,
          parsedProduct: anchorForPayload,
          logger,
        });
        if (urlNorm && isPlainObjectFn(urlNorm.payload)) {
          followupPayloadSeed = applyProductAnalysisGapContractFn({
            ...urlNorm.payload,
            assessment: {
              ...(isPlainObjectFn(urlNorm.payload.assessment) ? urlNorm.payload.assessment : {}),
              ...(anchorForPayload ? { anchor_product: anchorForPayload } : {}),
            },
          });
        }
      } catch (err) {
        logger?.warn?.(
          { err: err && err.message ? err.message : String(err), request_id: ctx && ctx.request_id },
          'aurora bff: follow-up url analysis failed',
        );
      }
    }

    if (!hasAnyAlternatives(followupPayloadSeed)) {
      const fallbackFilterStats = initCandidateFilterStatsFn();
      const fallbackRecall = await buildRealtimeCompetitorCandidatesFn({
        productUrl: anchorProductUrlUsed || '',
        parsedProduct: anchorForPayload,
        anchorProduct: anchorForPayload,
        keyIngredients: [],
        profileSummary: profileSummaryForFollowup,
        lang: ctx && ctx.lang,
        mode: 'main_path',
        timeoutMs: Math.max(2400, Math.min(6800, PRODUCT_URL_REALTIME_COMPETITOR_TIMEOUT_MS)),
        maxQueries: Math.min(4, PRODUCT_URL_REALTIME_COMPETITOR_MAX_QUERIES),
        maxCandidates: PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
        logger,
      });
      const fallbackCandidates = sanitizeCompetitorCandidatesFn(
        fallbackRecall && fallbackRecall.candidates,
        PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
        { enforceSkincare: true, pool: 'competitors', stats: fallbackFilterStats },
      );
      const routed = routeCompetitorCandidatePoolsFn({
        anchorProduct: anchorForPayload,
        candidates: fallbackCandidates,
        maxCandidates: PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
      });

      followupPayloadSeed = applyProductAnalysisGapContractFn({
        assessment: {
          verdict: 'Unknown',
          reasons: followupReasons,
          anchor_product: anchorForPayload,
        },
        evidence: {
          science: {
            key_ingredients: [],
            mechanisms: [],
            fit_notes: [],
            risk_notes: [],
          },
          social_signals: {
            typical_positive: [],
            typical_negative: [],
            risk_for_groups: [],
          },
          expert_notes: [],
          confidence: null,
          missing_info: [],
        },
        confidence: null,
        missing_info: uniqCaseInsensitiveStringsFn(
          [
            ...(followupGoal ? [] : ['followup_goal_not_resolved']),
            ...(fallbackRecall && fallbackRecall.reason
              ? [`followup_recall_${String(fallbackRecall.reason).toLowerCase()}`]
              : []),
          ],
          16,
        ),
        competitors: { candidates: routed.compPool || [] },
        related_products: { candidates: routed.relPool || [] },
        dupes: { candidates: routed.dupePool || [] },
      });
    }

    const goalToken = String(followupGoal || '').trim().toLowerCase();
    const seedComp = Array.isArray(followupPayloadSeed?.competitors?.candidates)
      ? followupPayloadSeed.competitors.candidates
      : [];
    const seedRel = Array.isArray(followupPayloadSeed?.related_products?.candidates)
      ? followupPayloadSeed.related_products.candidates
      : [];
    const seedDupes = Array.isArray(followupPayloadSeed?.dupes?.candidates)
      ? followupPayloadSeed.dupes.candidates
      : [];
    const filteredComp = rankCandidatesByGoal(goalToken, seedComp).slice(
      0,
      PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
    );
    const filteredRel = rankCandidatesByGoal(goalToken, seedRel).slice(
      0,
      PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
    );
    const filteredDupes = rankCandidatesByGoal(goalToken, seedDupes).slice(
      0,
      PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES,
    );
    const firstPick = [...filteredComp, ...filteredDupes, ...filteredRel]
      .map((candidate) => ({
        candidate,
        score: scoreCandidateForGoal(goalToken, candidate),
        similarity: Number(candidate && candidate.similarity_score) || 0,
      }))
      .sort((a, b) => (b.score - a.score) || (b.similarity - a.similarity))[0];
    const firstPickName = firstPick
      ? joinBrandAndNameFn(
          pickFirstTrimmedFn(firstPick.candidate && firstPick.candidate.brand),
          pickFirstTrimmedFn(
            firstPick.candidate && firstPick.candidate.name,
            firstPick.candidate && firstPick.candidate.display_name,
            firstPick.candidate && firstPick.candidate.displayName,
          ),
        )
      : '';
    const goalReason = (() => {
      if (!firstPickName) return '';
      if (goalToken === 'acne_focus') {
        return lang === 'CN'
          ? `清晰推荐：优先看 ${firstPickName}（更偏控痘/油脂管理路线）。`
          : `Clear pick: start with ${firstPickName} (more acne/oil-control aligned).`;
      }
      if (goalToken === 'less_drying') {
        return lang === 'CN'
          ? `清晰推荐：优先看 ${firstPickName}（更偏保湿修护、降低拔干风险）。`
          : `Clear pick: start with ${firstPickName} (more hydration-barrier focused with lower drying risk).`;
      }
      if (goalToken === 'pros_cons') {
        return lang === 'CN'
          ? `优先比较：${firstPickName}（先看 tradeoff 再决定是否替换）。`
          : `Start comparing with ${firstPickName} first (review tradeoffs before replacing).`;
      }
      return '';
    })();

    const seedAssessment = isPlainObjectFn(followupPayloadSeed && followupPayloadSeed.assessment)
      ? followupPayloadSeed.assessment
      : {};
    const seedMissingInfo = asStringArrayFn(followupPayloadSeed && followupPayloadSeed.missing_info);
    const followupBasePayload = applyProductAnalysisGapContractFn({
      ...followupPayloadSeed,
      assessment: {
        ...seedAssessment,
        ...(anchorForPayload ? { anchor_product: anchorForPayload } : {}),
        reasons: uniqCaseInsensitiveStringsFn(
          [
            ...asStringArrayFn(seedAssessment && seedAssessment.reasons),
            ...followupReasons,
            ...(goalReason ? [goalReason] : []),
          ],
          6,
        ),
      },
      missing_info: uniqCaseInsensitiveStringsFn(
        [
          ...seedMissingInfo,
          ...(followupGoal ? [] : ['followup_goal_not_resolved']),
        ],
        16,
      ),
      competitors: { candidates: filteredComp },
      related_products: { candidates: filteredRel },
      dupes: { candidates: filteredDupes },
      provenance: {
        ...(isPlainObjectFn(followupPayloadSeed && followupPayloadSeed.provenance)
          ? followupPayloadSeed.provenance
          : {}),
        followup_goal: followupGoal || null,
        anchor_used: {
          ...(anchorProductIdUsed ? { anchor_product_id: anchorProductIdUsed } : {}),
          ...(anchorProductUrlUsed ? { anchor_product_url: anchorProductUrlUsed } : {}),
          ...(anchorBrand ? { anchor_brand: anchorBrand } : {}),
          ...(anchorName ? { anchor_name: anchorName } : {}),
          ...(anchorDisplayName ? { anchor_display_name: anchorDisplayName } : {}),
        },
      },
    });
    const followupNorm = normalizeProductAnalysisFn(followupBasePayload);
    const followupPayload = reconcileProductAnalysisConsistencyFn(
      finalizeProductAnalysisRecoContractFn(
        enrichProductAnalysisPayloadFn(followupNorm.payload, {
          lang: ctx && ctx.lang,
          profileSummary: profileSummaryForFollowup,
        }),
        { logger, requestId: ctx && ctx.request_id, mode: 'main_path' },
      ),
      { lang: ctx && ctx.lang },
    );
    const followupPayloadPatched = {
      ...followupPayload,
      provenance: {
        ...(isPlainObjectFn(followupPayload && followupPayload.provenance)
          ? followupPayload.provenance
          : {}),
        followup_goal: followupGoal || null,
        anchor_used: {
          ...(anchorProductIdUsed ? { anchor_product_id: anchorProductIdUsed } : {}),
          ...(anchorProductUrlUsed ? { anchor_product_url: anchorProductUrlUsed } : {}),
          ...(anchorBrand ? { anchor_brand: anchorBrand } : {}),
          ...(anchorName ? { anchor_name: anchorName } : {}),
          ...(anchorDisplayName ? { anchor_display_name: anchorDisplayName } : {}),
        },
      },
    };

    return buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(
        lang === 'CN'
          ? '我已锁定当前产品并准备了 follow-up 替代分析。你可以继续点 acne-focused / less-drying / pros-cons 方向细化。'
          : 'I anchored the current product and prepared a follow-up alternatives analysis. You can refine with acne-focused / less-drying / pros-cons next.',
      ),
      suggested_chips: [],
      cards: [
        {
          card_id: `analyze_${ctx.request_id}`,
          type: 'product_analysis',
          payload: debugUpstream ? followupPayloadPatched : stripInternalRefsDeepFn(followupPayloadPatched),
          ...(Array.isArray(followupNorm.field_missing) && followupNorm.field_missing.length
            ? { field_missing: followupNorm.field_missing.slice(0, 8) }
            : {}),
        },
      ],
      session_patch: {
        meta: {
          followup_goal: followupGoal || null,
        },
      },
      events: [
        makeEventFn(ctx, 'value_moment', {
          kind: 'product_analyze_followup',
          followup_goal: followupGoal || null,
          anchored: true,
        }),
      ],
    });
  }

  return {
    maybeBuildAnalysisFollowupEnvelope,
    maybeBuildFollowupAlternativesEnvelope,
  };
}

module.exports = {
  createChatFollowupRuntime,
};
