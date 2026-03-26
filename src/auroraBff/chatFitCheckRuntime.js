function defaultIsPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function createChatFitCheckRuntime(options = {}) {
  const {
    logger = null,
    isPlainObject = defaultIsPlainObject,
    coerceNumber = (value) => {
      const next = Number(value);
      return Number.isFinite(next) ? next : null;
    },
    looksLikeSuitabilityRequest = () => false,
    normalizeProductAnalysis,
    enrichProductAnalysisPayload,
    finalizeProductAnalysisRecoContract,
    reconcileProductAnalysisConsistency,
    stripInternalRefsDeep = (value) => value,
    extractProductInputFromFitCheckText = () => '',
    resolveProductIntelLlmRoute = () => ({ llm_provider: null, llm_model: null }),
    evaluateAnchorTrustForProductIntel = () => ({
      trusted_anchor: null,
      display_anchor: null,
      usable_for_anchor_id: false,
      trust_level: 'none',
      reason_codes: [],
      candidate_quality: 'none',
      url_consistency: null,
    }),
    AURORA_PRODUCT_STRICT_SKINCARE_FILTER = false,
    AURORA_RULE_RELAX_AGGRESSIVE = false,
    extractJsonObjectByKeys = () => null,
    mapAuroraProductParse = (value) => value,
    normalizeProductParse = () => ({ payload: {}, field_missing: [] }),
    canonicalizeIngredientCandidates = (items) => (Array.isArray(items) ? items : []),
    classifyProductType = () => ({ product_type: '', usage_overrides: null }),
    buildProductDeepScanPrompt = ({ productDescriptor = '' } = {}) => String(productDescriptor || '').trim(),
    auroraChat,
    AURORA_DECISION_BASE_URL = '',
    AURORA_CHAT_UPSTREAM_TIMEOUT_MS = 16000,
    mapAuroraProductAnalysis = (value) => value,
    getProductAnalysisInternalMissingCodes = () => [],
    applyProductAnalysisGapContract = (payload) => payload,
    shouldRetryForNarrativeQuality = () => false,
    normalizeProductAnalysisFromUpstream = () => ({ payload: {}, field_missing: [] }),
    collectNarrativeRetryCodes = () => [],
    hasValidNarrativeQuality = () => false,
    isProductIntelPayloadCandidateBetter = () => false,
    resolveProductIntelEscalationRoute = () => null,
    shouldTriggerProductIntelEscalation = () => false,
    appendProductIntelSourceChain = (payload) => payload,
    attachProductIntelLlmRouteProvenance = (payload) => payload,
    mergeFieldMissing = (left, right) => [
      ...(Array.isArray(left) ? left : []),
      ...(Array.isArray(right) ? right : []),
    ],
    uniqCaseInsensitiveStrings = (items, max = Infinity) => {
      const out = [];
      const seen = new Set();
      for (const raw of Array.isArray(items) ? items : []) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (out.length >= max) break;
      }
      return out;
    },
    PRODUCT_URL_INGREDIENT_ANALYSIS_ENABLED = false,
    buildProductAnalysisFromUrlIngredients,
    pickFirstTrimmed = (...values) => {
      for (const raw of values) {
        const value = String(raw || '').trim();
        if (value) return value;
      }
      return '';
    },
    buildContextPrefix = () => '',
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat fit-check runtime missing dependency: ${name}`);
  }

  function hasProductAnalysisCard(cards) {
    return (
      Array.isArray(cards) &&
      cards.some((card) => String(card && card.type ? card.type : '').trim().toLowerCase() === 'product_analysis')
    );
  }

  function mapAnchorContextToProductAnalysis(anchor, { lang, profileSummary } = {}) {
    const a = isPlainObject(anchor) ? anchor : {};
    const outLang = String(lang || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
    const profile = isPlainObject(profileSummary) ? profileSummary : null;

    const uniqStrings = (items, max = null) => {
      const out = [];
      const seen = new Set();
      for (const raw of Array.isArray(items) ? items : []) {
        const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (typeof max === 'number' && max > 0 && out.length >= max) break;
      }
      return out;
    };

    const brand = typeof a.brand === 'string' ? a.brand.trim() : '';
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    const productId =
      typeof a.id === 'string' ? a.id.trim() : typeof a.product_id === 'string' ? a.product_id.trim() : '';
    const displayName =
      [brand, name].filter(Boolean).join(' ').trim() ||
      (typeof a.display_name === 'string' ? a.display_name.trim() : '');

    const score = isPlainObject(a.score) ? a.score : {};
    const scoreTotal = coerceNumber(score.total);
    const scoreScience = coerceNumber(score.science);
    const scoreSocial = coerceNumber(score.social);
    const scoreEng = coerceNumber(score.engineering);

    const social = isPlainObject(a.social) ? a.social : {};
    const redScore = coerceNumber(social.red_score ?? social.redScore);
    const redditScore = coerceNumber(social.reddit_score ?? social.redditScore);
    const burnRate = coerceNumber(social.burn_rate ?? social.burnRate);
    const topKeywords = Array.isArray(social.top_keywords) ? social.top_keywords : Array.isArray(social.topKeywords) ? social.topKeywords : [];

    const kb = isPlainObject(a.kb_profile) ? a.kb_profile : isPlainObject(a.kbProfile) ? a.kbProfile : {};
    const keyActives = Array.isArray(kb.keyActives) ? kb.keyActives : [];
    const comparisonNotes = Array.isArray(kb.comparisonNotes) ? kb.comparisonNotes : [];
    const sensitivityFlags = Array.isArray(kb.sensitivityFlags) ? kb.sensitivityFlags : [];
    const pairingRules = Array.isArray(kb.pairingRules) ? kb.pairingRules : [];
    const textureFinish = Array.isArray(kb.textureFinish) ? kb.textureFinish : [];

    const expert = isPlainObject(a.expert_knowledge) ? a.expert_knowledge : isPlainObject(a.expertKnowledge) ? a.expertKnowledge : {};
    const chemistNotes = typeof expert.chemist_notes === 'string' ? expert.chemist_notes : typeof expert.chemistNotes === 'string' ? expert.chemistNotes : '';
    const sensitivityNotes =
      typeof expert.sensitivity_notes === 'string'
        ? expert.sensitivity_notes
        : typeof expert.sensitivityNotes === 'string'
          ? expert.sensitivityNotes
          : '';

    const riskFlags = uniqStrings(
      [
        ...(Array.isArray(a.risk_flags_canonical) ? a.risk_flags_canonical : []),
        ...(Array.isArray(a.risk_flags) ? a.risk_flags : []),
        ...(Array.isArray(sensitivityFlags) ? sensitivityFlags : []),
      ]
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    );

    const vetoed = Boolean(a.vetoed);
    const anchorInciStatus = isPlainObject(a.inci_status) ? a.inci_status : null;
    const inciVerificationRequired = Boolean(anchorInciStatus && anchorInciStatus.verification_required);
    const inciConsensusTier = String((anchorInciStatus && anchorInciStatus.consensus_tier) || '').toLowerCase();
    const verdict = (() => {
      if (vetoed) return outLang === 'CN' ? '不建议' : 'Avoid';
      if (riskFlags.some((flag) => /high_irritation/i.test(flag))) return outLang === 'CN' ? '谨慎' : 'Caution';
      if (scoreTotal != null && scoreTotal < 55) return outLang === 'CN' ? '谨慎' : 'Caution';
      if (inciConsensusTier === 'low') return outLang === 'CN' ? '待验证' : 'Needs Verification';
      if (inciVerificationRequired) return outLang === 'CN' ? '谨慎适合' : 'Cautiously Suitable';
      return outLang === 'CN' ? '适合' : 'Suitable';
    })();

    const take = (items, count) => (Array.isArray(items) ? items.filter(Boolean).slice(0, count) : []);
    const truncate = (value, max = 200) => {
      const next = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
      if (!next) return '';
      return next.length > max ? `${next.slice(0, max - 1)}…` : next;
    };
    const normalizeProfileEnum = (value) => {
      const next = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return next || null;
    };

    const profileSkinType = normalizeProfileEnum(profile && profile.skinType);
    const profileSensitivity = normalizeProfileEnum(profile && profile.sensitivity);
    const profileBarrier = normalizeProfileEnum(profile && profile.barrierStatus);
    const profileGoals = Array.isArray(profile && profile.goals)
      ? profile.goals.map((goal) => normalizeProfileEnum(goal)).filter(Boolean)
      : [];

    const profileTags = (() => {
      if (!profile) return [];
      const tags = [];
      const skinTypeLabel = (() => {
        if (!profileSkinType) return null;
        if (outLang === 'CN') {
          if (profileSkinType === 'oily') return '油皮';
          if (profileSkinType === 'dry') return '干皮';
          if (profileSkinType === 'combo' || profileSkinType === 'combination') return '混合皮';
          if (profileSkinType === 'normal') return '中性皮';
          if (profileSkinType === 'sensitive') return '敏感肌';
          return `肤质：${profileSkinType}`;
        }
        if (profileSkinType === 'combo' || profileSkinType === 'combination') return 'combination';
        return profileSkinType;
      })();
      const sensitivityLabel = (() => {
        if (!profileSensitivity) return null;
        if (outLang === 'CN') {
          if (profileSensitivity === 'low') return '低敏';
          if (profileSensitivity === 'medium') return '中敏';
          if (profileSensitivity === 'high') return '高敏';
          return `敏感：${profileSensitivity}`;
        }
        if (profileSensitivity === 'low') return 'low sensitivity';
        if (profileSensitivity === 'medium') return 'medium sensitivity';
        if (profileSensitivity === 'high') return 'high sensitivity';
        return `sensitivity=${profileSensitivity}`;
      })();
      const barrierLabel = (() => {
        if (!profileBarrier) return null;
        if (outLang === 'CN') {
          if (profileBarrier === 'healthy') return '屏障健康';
          if (profileBarrier === 'impaired') return '屏障受损';
          return `屏障：${profileBarrier}`;
        }
        if (profileBarrier === 'healthy') return 'healthy barrier';
        if (profileBarrier === 'impaired') return 'impaired barrier';
        return `barrier=${profileBarrier}`;
      })();
      if (skinTypeLabel) tags.push(skinTypeLabel);
      if (sensitivityLabel) tags.push(sensitivityLabel);
      if (barrierLabel) tags.push(barrierLabel);
      return tags;
    })();

    const lowerKeyActives = uniqStrings(take(keyActives, 12).map((item) => String(item || '').trim()).filter(Boolean))
      .join(' | ')
      .toLowerCase();
    const hasNiacinamide = /\bniacinamide\b|烟酰胺/.test(lowerKeyActives);
    const hasZincPca = /\bzinc\b.*\bpca\b|锌\s*pca/.test(lowerKeyActives);
    const isAcidLike =
      riskFlags.some((flag) => /\bacid\b/i.test(flag)) ||
      /\baha\b|\bbha\b|\bpha\b|\bglycolic\b|\blactic\b|\bsalicylic\b|果酸|水杨酸|杏仁酸|乳酸|葡糖酸内酯/.test(
        lowerKeyActives,
      );
    const isHighIrritation =
      riskFlags.some((flag) => /high_irritation/i.test(flag)) ||
      /\bhigh irritation\b|刺激性偏高|can sting|may sting/.test(String(sensitivityNotes || '').toLowerCase());
    const profileSuggestsCaution =
      profileBarrier === 'impaired' ||
      profileSensitivity === 'high' ||
      (profileSensitivity === 'medium' && (isAcidLike || isHighIrritation));

    const reasons = uniqStrings(
      [
        ...take(comparisonNotes, 1).map((item) => truncate(item, 200)),
        ...(profileTags.length
          ? [
              outLang === 'CN'
                ? `基于你的皮肤特性：${truncate(profileTags.join(' / '), 80)}。`
                : `Based on your profile: ${truncate(profileTags.join(' / '), 80)}.`,
            ]
          : []),
        ...(profileSkinType === 'oily' && (hasNiacinamide || hasZincPca)
          ? [
              outLang === 'CN'
                ? '更偏油皮友好：烟酰胺/锌类通常用于控油、痘印与毛孔观感。'
                : 'Oily-skin friendly: niacinamide/zinc are commonly used for oil control and the look of pores/marks.',
            ]
          : []),
        ...(profileGoals.includes('brightening') && hasNiacinamide
          ? [
              outLang === 'CN'
                ? '你的目标包含提亮：烟酰胺在“肤色不均/痘印”方向常见。'
                : 'Your goal includes brightening: niacinamide is commonly used for uneven tone/marks.',
            ]
          : []),
        ...(profileGoals.includes('acne') && (hasNiacinamide || hasZincPca)
          ? [
              outLang === 'CN'
                ? '你的目标包含痘痘：这类成分更常见于“控油/痘痘倾向”方向。'
                : 'Your goal includes acne-prone concerns: these actives are often used for oil/acne-prone routines.',
            ]
          : []),
        ...take(keyActives, 3).map((item) =>
          outLang === 'CN' ? `关键活性：${truncate(item, 180)}` : `Key active: ${truncate(item, 180)}`,
        ),
        ...(profileSuggestsCaution
          ? [
              outLang === 'CN'
                ? '使用建议：先从低频（每周 2–3 次或更少）开始；若刺痛/泛红，先停用并以修护保湿为主。'
                : 'How to use: start low (2–3×/week or less); if stinging/redness happens, pause and focus on barrier support.',
            ]
          : []),
        ...(isHighIrritation
          ? [
              outLang === 'CN'
                ? '风险提示：刺激性偏高（部分人会刺痛/搓泥），建议少量、等待吸收、减少叠加。'
                : 'Risk: higher irritation/pilling potential; use a small amount, let it absorb, and avoid heavy layering.',
            ]
          : []),
        ...(isAcidLike
          ? [
              outLang === 'CN'
                ? '叠加提醒：同一晚尽量不要叠加强酸/维A类（更容易刺痛/爆皮）。'
                : 'Layering note: avoid stacking strong acids/retinoids in the same night to reduce irritation.',
            ]
          : []),
      ],
      5,
    ).filter(Boolean);

    const assessment = {
      verdict,
      reasons,
      ...(productId || brand || name || displayName
        ? {
            anchor_product: {
              ...(productId ? { product_id: productId, sku_id: productId } : {}),
              ...(brand ? { brand } : {}),
              ...(name ? { name } : {}),
              ...(displayName ? { display_name: displayName } : {}),
              availability: Array.isArray(a.availability) ? a.availability : [],
            },
          }
        : {}),
    };

    const platformScores = {};
    if (redScore != null) platformScores.RED = redScore;
    if (redditScore != null) platformScores.Reddit = redditScore;
    if (burnRate != null) platformScores.burn_rate = burnRate;

    const evidence = {
      science: {
        key_ingredients: uniqStrings(take(keyActives, 8).map((item) => truncate(item, 120)), 8),
        mechanisms: [],
        fit_notes: uniqStrings([...take(textureFinish, 2), ...take(pairingRules, 1)].map((item) => truncate(item, 200)), 3),
        risk_notes: uniqStrings(
          [...riskFlags.map((item) => truncate(item, 120)), ...(sensitivityNotes ? [truncate(sensitivityNotes, 200)] : [])].filter(Boolean),
          4,
        ),
      },
      social_signals: {
        ...(Object.keys(platformScores).length ? { platform_scores: platformScores } : {}),
        typical_positive: uniqStrings(take(topKeywords, 6).map((item) => truncate(item, 60)), 6),
        typical_negative: [],
        risk_for_groups: [],
      },
      expert_notes: uniqStrings([chemistNotes, sensitivityNotes].map((item) => truncate(item, 200)).filter(Boolean), 2),
      confidence: scoreScience != null ? Math.max(0, Math.min(1, scoreScience / 100)) : null,
      missing_info: [],
    };

    const confidence = scoreTotal != null ? Math.max(0, Math.min(1, scoreTotal / 100)) : null;
    const missing_info = [];
    const scoreLineParts = [
      scoreTotal != null ? `Total ${Math.round(scoreTotal)}/100` : null,
      scoreScience != null ? `Science ${Math.round(scoreScience)}` : null,
      scoreSocial != null ? `Social ${Math.round(scoreSocial)}` : null,
      scoreEng != null ? `Eng ${Math.round(scoreEng)}` : null,
    ].filter(Boolean);
    if (scoreLineParts.length) {
      evidence.expert_notes = uniqStrings(
        [...(Array.isArray(evidence.expert_notes) ? evidence.expert_notes : []), truncate(scoreLineParts.join(', '), 200)],
        3,
      );
    }

    return { assessment, evidence, confidence, missing_info };
  }

  async function buildFitCheckCards({
    ctx,
    req,
    cards = [],
    derivedCards = [],
    anchorFromContext = null,
    responseIntentMessage = '',
    profileSummary = null,
    profile = null,
    recentLogs = [],
    anchorProductUrl = '',
    anchorProductId = '',
    llmProvider = '',
    llmModel = '',
    debugUpstream = false,
  } = {}) {
    const normalizeProductAnalysisFn = requireFunction('normalizeProductAnalysis', normalizeProductAnalysis);
    const enrichProductAnalysisPayloadFn = requireFunction('enrichProductAnalysisPayload', enrichProductAnalysisPayload);
    const finalizeProductAnalysisRecoContractFn = requireFunction(
      'finalizeProductAnalysisRecoContract',
      finalizeProductAnalysisRecoContract,
    );
    const reconcileProductAnalysisConsistencyFn = requireFunction(
      'reconcileProductAnalysisConsistency',
      reconcileProductAnalysisConsistency,
    );
    const auroraChatFn = requireFunction('auroraChat', auroraChat);
    const buildProductAnalysisFromUrlIngredientsFn = requireFunction(
      'buildProductAnalysisFromUrlIngredients',
      buildProductAnalysisFromUrlIngredients,
    );

    const nextCards = [];
    const wantsSuitabilityFallback = looksLikeSuitabilityRequest(responseIntentMessage);
    const combinedCards = [...(Array.isArray(derivedCards) ? derivedCards : []), ...(Array.isArray(cards) ? cards : [])];
    if (!wantsSuitabilityFallback) return nextCards;

    if (
      anchorFromContext &&
      !hasProductAnalysisCard(combinedCards) &&
      !hasProductAnalysisCard(nextCards)
    ) {
      const mapped = mapAnchorContextToProductAnalysis(anchorFromContext, {
        lang: ctx && ctx.lang,
        profileSummary,
      });
      const norm = normalizeProductAnalysisFn(mapped);
      const payload = reconcileProductAnalysisConsistencyFn(
        finalizeProductAnalysisRecoContractFn(
          enrichProductAnalysisPayloadFn(norm.payload, { lang: ctx && ctx.lang }),
          { logger, requestId: ctx && ctx.request_id, mode: 'main_path' },
        ),
        { lang: ctx && ctx.lang },
      );
      nextCards.push({
        card_id: `analyze_${ctx && ctx.request_id}`,
        type: 'product_analysis',
        payload: debugUpstream ? payload : stripInternalRefsDeep(payload),
        ...(norm.field_missing && norm.field_missing.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
      });
    }

    if (hasProductAnalysisCard([...combinedCards, ...nextCards])) {
      return nextCards;
    }

    const productInput = anchorProductUrl || extractProductInputFromFitCheckText(responseIntentMessage) || '';
    if (!productInput) return nextCards;

    const fitCheckLlmRoute = resolveProductIntelLlmRoute({
      req,
      requestedProvider: llmProvider,
      requestedModel: llmModel,
    });
    let fitCheckLlmRouteMeta = {
      stage: 'stage_1',
      provider: fitCheckLlmRoute.llm_provider || null,
      model: fitCheckLlmRoute.llm_model || null,
      trigger_reason: 'primary',
    };
    const commonMeta = {
      profile: profileSummary,
      recentLogs,
      lang: ctx && ctx.lang,
      state: (ctx && ctx.state) || 'idle',
      trigger_source: ctx && ctx.trigger_source,
    };
    const productParsePrefix = buildContextPrefix({
      ...commonMeta,
      intent: 'product_parse',
      action_id: 'chat.fit_check.parse',
    });
    const productAnalyzePrefix = buildContextPrefix({
      ...commonMeta,
      intent: 'product_analyze',
      action_id: 'chat.fit_check.deep_scan',
    });

    let parsedProduct = null;
    let anchorId = anchorProductUrl ? '' : anchorProductId || '';
    let fitCheckAnchorTrustContext = {
      level: 'none',
      usable_for_anchor_id: false,
      reasons: [],
      source: 'none',
      candidate_quality: 'none',
      url_consistency: null,
    };

    const applyFitCheckAnchorGuard = (candidate, source, { preferDisplay = false } = {}) => {
      const trust = evaluateAnchorTrustForProductIntel({
        candidate,
        inputText: String(productInput || '').trim(),
        inputUrl: String(anchorProductUrl || '').trim(),
        source,
        strictFilter: AURORA_PRODUCT_STRICT_SKINCARE_FILTER,
      });
      const trustCodes = Array.isArray(trust.reason_codes) ? trust.reason_codes : [];
      const nonSkincareSoftBlocked =
        !AURORA_RULE_RELAX_AGGRESSIVE && trustCodes.includes('anchor_soft_blocked_non_skincare');
      if (
        trust.display_anchor &&
        !nonSkincareSoftBlocked &&
        (!parsedProduct || preferDisplay || trust.usable_for_anchor_id)
      ) {
        parsedProduct = trust.display_anchor;
      }
      if (trust.usable_for_anchor_id && trust.trusted_anchor) {
        parsedProduct = trust.trusted_anchor;
        anchorId = pickFirstTrimmed(trust.trusted_anchor.sku_id, trust.trusted_anchor.product_id) || anchorId;
      }
      if (trust.trust_level === 'trusted' || (fitCheckAnchorTrustContext.level !== 'trusted' && trust.trust_level !== 'none')) {
        fitCheckAnchorTrustContext = {
          level: String(trust.trust_level || 'none'),
          usable_for_anchor_id: trust.usable_for_anchor_id === true,
          reasons: trustCodes.slice(0, 6),
          source: String(source || 'unknown'),
          candidate_quality: String(trust.candidate_quality || 'none'),
          url_consistency: Number.isFinite(Number(trust.url_consistency)) ? Number(trust.url_consistency) : null,
        };
      }
      return trust;
    };

    const applyFitCheckAnchorDiagnostics = (rawPayload) => {
      const basePayload =
        rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : rawPayload;
      if (!basePayload || typeof basePayload !== 'object' || Array.isArray(basePayload)) return rawPayload;
      const hasDisplayAnchor = Boolean(
        parsedProduct &&
          pickFirstTrimmed(
            parsedProduct.product_id,
            parsedProduct.sku_id,
            parsedProduct.display_name,
            parsedProduct.name,
            parsedProduct.url,
          ),
      );
      const withGap = applyProductAnalysisGapContract({
        ...basePayload,
        missing_info: uniqCaseInsensitiveStrings(
          [
            ...(Array.isArray(basePayload.missing_info) ? basePayload.missing_info : []),
            ...(Array.isArray(fitCheckAnchorTrustContext.reasons) ? fitCheckAnchorTrustContext.reasons : []),
            ...(hasDisplayAnchor && fitCheckAnchorTrustContext.usable_for_anchor_id !== true
              ? ['anchor_id_not_used_due_to_low_trust']
              : []),
          ],
          16,
        ),
      });
      return {
        ...withGap,
        provenance: {
          ...(isPlainObject(withGap.provenance) ? withGap.provenance : {}),
          anchor_trust: {
            level: String(fitCheckAnchorTrustContext.level || 'none'),
            usable_for_anchor_id: fitCheckAnchorTrustContext.usable_for_anchor_id === true,
            reasons: Array.isArray(fitCheckAnchorTrustContext.reasons)
              ? fitCheckAnchorTrustContext.reasons.slice(0, 6)
              : [],
            source: String(fitCheckAnchorTrustContext.source || 'unknown'),
            candidate_quality: String(fitCheckAnchorTrustContext.candidate_quality || 'none'),
            ...(Number.isFinite(Number(fitCheckAnchorTrustContext.url_consistency))
              ? { url_consistency: Number(fitCheckAnchorTrustContext.url_consistency) }
              : {}),
          },
        },
      };
    };

    if (!anchorId) {
      try {
        const parseQuery =
          `${productParsePrefix}Task: Parse the user's product input into a normalized product entity.\n` +
          'Return ONLY a JSON object with keys: product, confidence, missing_info (string[]).\n' +
          `Input: ${productInput}`;
        const parseUpstream = await auroraChatFn({
          baseUrl: AURORA_DECISION_BASE_URL,
          query: parseQuery,
          timeoutMs: 12000,
          ...(anchorProductUrl ? { anchor_product_url: anchorProductUrl } : {}),
          ...(fitCheckLlmRoute.llm_provider ? { llm_provider: fitCheckLlmRoute.llm_provider } : {}),
          ...(fitCheckLlmRoute.llm_model ? { llm_model: fitCheckLlmRoute.llm_model } : {}),
        });
        const parseStructured =
          parseUpstream &&
          parseUpstream.structured &&
          typeof parseUpstream.structured === 'object' &&
          !Array.isArray(parseUpstream.structured)
            ? parseUpstream.structured
            : parseUpstream && typeof parseUpstream.answer === 'string'
              ? extractJsonObjectByKeys(parseUpstream.answer, ['product', 'parse', 'anchor_product', 'anchorProduct'])
              : null;
        const parseMapped =
          parseStructured && typeof parseStructured === 'object' && !Array.isArray(parseStructured)
            ? mapAuroraProductParse(parseStructured)
            : parseStructured;
        const parseNorm = normalizeProductParse(parseMapped);
        const parseCandidate = parseNorm.payload && parseNorm.payload.product ? parseNorm.payload.product : null;
        applyFitCheckAnchorGuard(parseCandidate, 'chat_fit_check_parse');
      } catch (_error) {
      }
    }

    const fitCheckInciList = canonicalizeIngredientCandidates(
      [
        ...(Array.isArray(parsedProduct && parsedProduct.ingredients) ? parsedProduct.ingredients : []),
        ...(Array.isArray(parsedProduct && parsedProduct.inci_list) ? parsedProduct.inci_list : []),
        ...(Array.isArray(parsedProduct && parsedProduct.inciList) ? parsedProduct.inciList : []),
      ],
      { max: 120 },
    );
    const fitCheckProductClassification = classifyProductType({
      name: String((parsedProduct && (parsedProduct.name || parsedProduct.display_name)) || productInput || ''),
      url: String(anchorProductUrl || (/^https?:\/\//i.test(String(productInput || '').trim()) ? productInput : '')),
      inciList: fitCheckInciList,
    });
    const fitCheckPromptOptions = {
      productType: fitCheckProductClassification.product_type,
      usageOverrides: fitCheckProductClassification.usage_overrides,
    };
    const deepScanQuery = buildProductDeepScanPrompt({
      prefix: productAnalyzePrefix,
      productDescriptor: productInput,
      ...fitCheckPromptOptions,
    });

    const runDeepScan = async ({ queryText, timeoutMs, llmRouteOverride = null }) => {
      const effectiveRoute =
        llmRouteOverride && typeof llmRouteOverride === 'object' && !Array.isArray(llmRouteOverride)
          ? llmRouteOverride
          : fitCheckLlmRoute;
      try {
        return await auroraChatFn({
          baseUrl: AURORA_DECISION_BASE_URL,
          query: queryText,
          timeoutMs,
          ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
          ...(anchorProductUrl ? { anchor_product_url: anchorProductUrl } : {}),
          ...(effectiveRoute.llm_provider ? { llm_provider: effectiveRoute.llm_provider } : {}),
          ...(effectiveRoute.llm_model ? { llm_model: effectiveRoute.llm_model } : {}),
        });
      } catch {
        return null;
      }
    };

    let deepUpstream = await runDeepScan({ queryText: deepScanQuery, timeoutMs: 16000 });
    const deepStructured =
      deepUpstream && deepUpstream.structured && typeof deepUpstream.structured === 'object' && !Array.isArray(deepUpstream.structured)
        ? deepUpstream.structured
        : null;
    const deepAnswerObj =
      deepUpstream && typeof deepUpstream.answer === 'string'
        ? extractJsonObjectByKeys(deepUpstream.answer, [
            'assessment',
            'evidence',
            'confidence',
            'missing_info',
            'missingInfo',
            'analyze',
            'verdict',
            'reasons',
            'science_evidence',
            'social_signals',
            'expert_notes',
          ])
        : null;
    const deepAnswerLooksLikeAnalysis =
      deepAnswerObj &&
      typeof deepAnswerObj === 'object' &&
      !Array.isArray(deepAnswerObj) &&
      (deepAnswerObj.assessment != null ||
        deepAnswerObj.evidence != null ||
        deepAnswerObj.analyze != null ||
        deepAnswerObj.analysis != null ||
        deepAnswerObj.product_analysis != null ||
        deepAnswerObj.productAnalysis != null ||
        deepAnswerObj.confidence != null ||
        deepAnswerObj.missing_info != null ||
        deepAnswerObj.missingInfo != null ||
        deepAnswerObj.verdict != null ||
        deepAnswerObj.reasons != null ||
        deepAnswerObj.science_evidence != null ||
        deepAnswerObj.scienceEvidence != null ||
        deepAnswerObj.social_signals != null ||
        deepAnswerObj.socialSignals != null ||
        deepAnswerObj.expert_notes != null ||
        deepAnswerObj.expertNotes != null);
    const structuredOrJson =
      deepStructured && deepStructured.analyze && typeof deepStructured.analyze === 'object'
        ? deepStructured
        : deepAnswerLooksLikeAnalysis
          ? deepAnswerObj
          : deepStructured || deepAnswerObj;
    const mapped =
      structuredOrJson && typeof structuredOrJson === 'object' && !Array.isArray(structuredOrJson)
        ? mapAuroraProductAnalysis(structuredOrJson)
        : structuredOrJson;
    let norm = normalizeProductAnalysisFn(mapped);

    if (!norm.payload.assessment && productInput) {
      const minimalPrefix = buildContextPrefix({
        lang: ctx && ctx.lang,
        state: (ctx && ctx.state) || 'idle',
        trigger_source: ctx && ctx.trigger_source,
        intent: 'product_analyze_fallback',
        action_id: 'chat.fit_check.deep_scan_fallback',
      });
      const minimalQuery = buildProductDeepScanPrompt({
        prefix: minimalPrefix,
        productDescriptor: productInput,
        ...fitCheckPromptOptions,
      });
      const deepUpstream2 = await runDeepScan({ queryText: minimalQuery, timeoutMs: 14000 });
      const deepStructured2 =
        deepUpstream2 && deepUpstream2.structured && typeof deepUpstream2.structured === 'object' && !Array.isArray(deepUpstream2.structured)
          ? deepUpstream2.structured
          : null;
      const deepAnswer2 =
        deepUpstream2 && typeof deepUpstream2.answer === 'string'
          ? extractJsonObjectByKeys(deepUpstream2.answer, [
              'assessment',
              'evidence',
              'confidence',
              'missing_info',
              'missingInfo',
              'analyze',
              'verdict',
              'reasons',
              'science_evidence',
              'social_signals',
              'expert_notes',
            ])
          : null;
      const structuredOrJson2 =
        deepStructured2 && deepStructured2.analyze && typeof deepStructured2.analyze === 'object'
          ? deepStructured2
          : deepAnswer2 && typeof deepAnswer2 === 'object' && !Array.isArray(deepAnswer2)
            ? deepAnswer2
            : deepStructured2 || deepAnswer2;
      const mapped2 =
        structuredOrJson2 && typeof structuredOrJson2 === 'object' && !Array.isArray(structuredOrJson2)
          ? mapAuroraProductAnalysis(structuredOrJson2)
          : structuredOrJson2;
      const norm2 = normalizeProductAnalysisFn(mapped2);
      if (norm2 && norm2.payload && norm2.payload.assessment) {
        const internalCodes = getProductAnalysisInternalMissingCodes(norm2.payload);
        norm = {
          payload: applyProductAnalysisGapContract({
            ...norm2.payload,
            internal_debug_codes: Array.from(
              new Set([...internalCodes, 'profile_context_dropped_for_reliability']),
            ),
          }),
          field_missing: norm2.field_missing,
        };
      }
    }

    if (shouldRetryForNarrativeQuality(norm.payload)) {
      const formulaRetryQuery = buildProductDeepScanPrompt({
        prefix: productAnalyzePrefix,
        productDescriptor: productInput,
        strictNarrative: true,
        ...fitCheckPromptOptions,
      });
      const formulaRetryUpstream = await runDeepScan({
        queryText: formulaRetryQuery,
        timeoutMs: Math.max(9000, Math.min(17000, AURORA_CHAT_UPSTREAM_TIMEOUT_MS)),
      });
      const formulaRetryNorm = normalizeProductAnalysisFromUpstream(formulaRetryUpstream);
      const retryCodes = collectNarrativeRetryCodes(norm.payload, formulaRetryNorm.payload);
      if (
        hasValidNarrativeQuality(formulaRetryNorm.payload) &&
        (retryCodes.length || isProductIntelPayloadCandidateBetter(formulaRetryNorm.payload, norm.payload))
      ) {
        norm = {
          payload: applyProductAnalysisGapContract({
            ...formulaRetryNorm.payload,
            internal_debug_codes: uniqCaseInsensitiveStrings(
              [...getProductAnalysisInternalMissingCodes(formulaRetryNorm.payload), ...retryCodes],
              32,
            ),
          }),
          field_missing: mergeFieldMissing(formulaRetryNorm.field_missing, norm.field_missing),
        };
      }
    }

    const fitCheckEscalationRoute = resolveProductIntelEscalationRoute({ req });
    const fitCheckEscalationAvailable =
      fitCheckEscalationRoute &&
      fitCheckEscalationRoute.llm_provider &&
      fitCheckEscalationRoute.llm_model &&
      (String(fitCheckEscalationRoute.llm_provider || '').trim().toLowerCase() !==
        String(fitCheckLlmRoute.llm_provider || '').trim().toLowerCase() ||
        String(fitCheckEscalationRoute.llm_model || '').trim() !==
          String(fitCheckLlmRoute.llm_model || '').trim());
    if (fitCheckEscalationAvailable && shouldTriggerProductIntelEscalation(norm.payload)) {
      const escalatedUpstream = await runDeepScan({
        queryText: deepScanQuery,
        timeoutMs: Math.max(9000, Math.min(18000, AURORA_CHAT_UPSTREAM_TIMEOUT_MS)),
        llmRouteOverride: fitCheckEscalationRoute,
      });
      const escalatedNorm = normalizeProductAnalysisFromUpstream(escalatedUpstream);
      if (isProductIntelPayloadCandidateBetter(escalatedNorm.payload, norm.payload)) {
        const internalCodes = getProductAnalysisInternalMissingCodes(escalatedNorm.payload);
        norm = {
          payload: applyProductAnalysisGapContract({
            ...escalatedNorm.payload,
            internal_debug_codes: uniqCaseInsensitiveStrings(
              [...internalCodes, 'llm_escalation_stage2_used'],
              32,
            ),
          }),
          field_missing: mergeFieldMissing(escalatedNorm.field_missing, norm.field_missing),
        };
        fitCheckLlmRouteMeta = {
          stage: String(fitCheckEscalationRoute.stage || 'stage_2'),
          provider: fitCheckEscalationRoute.llm_provider || null,
          model: fitCheckEscalationRoute.llm_model || null,
          trigger_reason: String(fitCheckEscalationRoute.trigger_reason || 'unknown_low_evidence'),
        };
      }
    }

    const productUrlForFallback =
      anchorProductUrl || (/^https?:\/\//i.test(String(productInput || '').trim()) ? String(productInput || '').trim() : '');
    const needsUrlIngredientAnalysis = (() => {
      const assessment = norm && norm.payload && typeof norm.payload === 'object' ? norm.payload.assessment : null;
      if (!assessment || typeof assessment !== 'object') return true;
      const verdict = String(assessment.verdict || '').trim().toLowerCase();
      return !verdict || verdict === 'unknown' || verdict === '未知';
    })();
    if (PRODUCT_URL_INGREDIENT_ANALYSIS_ENABLED && needsUrlIngredientAnalysis && productUrlForFallback) {
      const urlNorm = await buildProductAnalysisFromUrlIngredientsFn({
        productUrl: productUrlForFallback,
        lang: ctx && ctx.lang,
        profileSummary,
        parsedProduct: fitCheckAnchorTrustContext.usable_for_anchor_id === true ? parsedProduct : null,
        logger,
      });
      if (urlNorm && urlNorm.payload && urlNorm.payload.assessment) {
        const mergedMissingInfo = Array.from(
          new Set([
            ...(Array.isArray(norm && norm.payload && norm.payload.missing_info) ? norm.payload.missing_info : []),
            ...(Array.isArray(urlNorm.payload.missing_info) ? urlNorm.payload.missing_info : []),
          ]),
        );
        const mergedInternalCodes = Array.from(
          new Set([
            ...getProductAnalysisInternalMissingCodes(norm && norm.payload),
            ...getProductAnalysisInternalMissingCodes(urlNorm.payload),
          ]),
        );
        norm = {
          payload: applyProductAnalysisGapContract({
            ...urlNorm.payload,
            missing_info: mergedMissingInfo,
            internal_debug_codes: mergedInternalCodes,
          }),
          field_missing: mergeFieldMissing(urlNorm.field_missing, norm.field_missing),
        };
      }
    }

    let payload = enrichProductAnalysisPayloadFn(norm.payload, { lang: ctx && ctx.lang, profileSummary });
    if (fitCheckAnchorTrustContext.usable_for_anchor_id === true && parsedProduct && payload && typeof payload === 'object') {
      const assessment = payload.assessment && typeof payload.assessment === 'object' ? payload.assessment : null;
      if (assessment && !assessment.anchor_product && !assessment.anchorProduct) {
        payload = { ...payload, assessment: { ...assessment, anchor_product: parsedProduct } };
      }
    }
    payload = applyFitCheckAnchorDiagnostics(payload);
    payload = reconcileProductAnalysisConsistencyFn(payload, { lang: ctx && ctx.lang });
    payload = finalizeProductAnalysisRecoContractFn(payload, {
      logger,
      requestId: ctx && ctx.request_id,
      mode: 'main_path',
    });
    payload = appendProductIntelSourceChain(payload, ['llm_extraction']);
    payload = attachProductIntelLlmRouteProvenance(payload, fitCheckLlmRouteMeta);
    payload = applyFitCheckAnchorDiagnostics(payload);
    payload = reconcileProductAnalysisConsistencyFn(payload, { lang: ctx && ctx.lang });

    if (payload) {
      nextCards.push({
        card_id: `analyze_${ctx && ctx.request_id}`,
        type: 'product_analysis',
        payload: debugUpstream ? payload : stripInternalRefsDeep(payload),
        ...(norm.field_missing && norm.field_missing.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
      });
    }

    return nextCards;
  }

  return {
    buildFitCheckCards,
  };
}

module.exports = {
  createChatFitCheckRuntime,
};
