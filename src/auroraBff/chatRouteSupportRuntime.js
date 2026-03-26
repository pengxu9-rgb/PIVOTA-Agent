function defaultIsPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const CHATBOX_UI_RENDERABLE_CARD_TYPES = new Set([
  'recommendations',
  'product_analysis',
  'env_stress',
  'routine_simulation',
  'conflict_heatmap',
  'analysis_summary',
  'analysis_story_v2',
  'routine_fit_summary',
  'ingredient_hub',
  'ingredient_goal_match',
  'aurora_ingredient_report',
  'confidence_notice',
  'diagnosis_gate',
]);

const CHATBOX_UI_HIDDEN_CARD_TYPES = new Set([
  'gate_notice',
  'session_bootstrap',
  'budget_gate',
  'aurora_context_raw',
]);

const FIT_CHECK_ANCHOR_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'it',
  'product',
  'specific',
  'for',
  'me',
  'evaluate',
  'evaluation',
  'assess',
  'assessment',
  'analyze',
  'analyse',
  'check',
  'review',
  'send',
  'link',
  'url',
  'name',
  'please',
  'do',
  'you',
  'have',
]);

function createChatRouteSupportRuntime(options = {}) {
  const {
    looksLikeSuitabilityRequest = () => false,
    looksLikeCompatibilityOrConflictQuestion = () => false,
    looksLikeWeatherOrEnvironmentQuestion = () => false,
    looksLikeRecommendationRequest = () => false,
    isPlainObject = defaultIsPlainObject,
  } = options;

  function getCardPayload(card) {
    if (!card || typeof card !== 'object') return null;
    if (isPlainObject(card.payload)) return card.payload;
    return isPlainObject(card) ? card : null;
  }

  function buildRecoEntryChips(language) {
    const lang = language === 'CN' ? 'CN' : 'EN';
    return [
      {
        chip_id: 'chip.intake.upload_photos',
        label: lang === 'CN' ? '上传 daylight + indoor_white' : 'Upload daylight + indoor_white',
        kind: 'quick_reply',
        data: {},
      },
      {
        chip_id: 'chip.intake.skip_analysis',
        label: lang === 'CN' ? '先用低置信度方案' : 'Use low-confidence baseline',
        kind: 'quick_reply',
        data: {},
      },
    ];
  }

  function isRenderableCardForChatboxUi(card, { debug } = {}) {
    if (!card || typeof card !== 'object') return false;
    const type = String(card.type || '').trim().toLowerCase();
    if (!type) return false;
    if (debug) return true;
    if (type === 'aurora_structured') return false;
    if (CHATBOX_UI_HIDDEN_CARD_TYPES.has(type)) return false;
    return CHATBOX_UI_RENDERABLE_CARD_TYPES.has(type);
  }

  function extractProductInputFromFitCheckText(message) {
    const raw = String(message || '').trim();
    if (!raw) return '';

    let text = raw
      .replace(/STRUCTURED_STUB_ONLY_TEST/gi, '')
      .replace(/SHORT_CARDS_BELOW_STUB_TEST/gi, '')
      .replace(/SHORT_CARDS_BELOW_STRIPPED_RECO_TEST/gi, '')
      .replace(/NON_GENERIC_STUB_TEST/gi, '')
      .trim();

    const suffixMatch = text.match(/[:：]\s*([^:：]{2,400})\s*$/);
    if (suffixMatch && suffixMatch[1]) text = String(suffixMatch[1]).trim();

    text = text.replace(
      /^(请|帮我|麻烦|想问|我要|我想|想|能否)?\s*(诊断|评估|分析|看看|判断|check|evaluate|analyze)\s*(一下|下|下这款|这款|这个)?\s*(产品|精华|serum|product)?\s*(是否|能不能|可不可以|适不适合我|适合吗|能用吗|可以用吗|suitable|safe|okay)?\s*/i,
      '',
    ).trim();

    const enSuitabilityQuestion =
      text.match(
        /^(?:is|are|was|were|can|could|should|will|would)\s+(?:this|that|the)?\s*([^?]{2,120}?)\s+(?:good|right|suitable|safe|okay|ok)\s+(?:for\s+me|to\s+use)\??$/i,
      ) ||
      text.match(/^(?:will|would)\s+(?:this|that|the)?\s*([^?]{2,120}?)\s+(?:suit|work\s+for)\s+me\??$/i);
    if (enSuitabilityQuestion && enSuitabilityQuestion[1]) {
      text = String(enSuitabilityQuestion[1]).trim();
    }

    const cnSuitabilityQuestion = text.match(
      /^(?:这款|这个|该|这支|这瓶)\s*([^，。！？?]{1,60}?)(?:适合我吗|适不适合我|能用吗|可以用吗|好用吗)[？?]?$/,
    );
    if (cnSuitabilityQuestion && cnSuitabilityQuestion[1]) {
      text = String(cnSuitabilityQuestion[1]).trim();
    }

    if (text.length > 160) text = text.slice(-160).trim();
    return text;
  }

  function looksLikeProductEvaluationIntentV2(message, actionId) {
    const raw = String(message || '').trim();
    const lower = raw.toLowerCase();
    const action = String(actionId || '').trim().toLowerCase();

    if (
      action === 'chip.action.analyze_product' ||
      action === 'chip_action_analyze_product' ||
      action.includes('evaluate') ||
      action.includes('fit_check') ||
      action.includes('fit-check') ||
      action.includes('product_analysis')
    ) {
      return true;
    }

    if (looksLikeSuitabilityRequest(raw)) return true;

    const recommendationOnlySignal =
      (/\b(recommend|suggest|recommendation)\b/.test(lower) || /(推荐|求推荐|给我.*产品)/.test(raw)) &&
      !/\b(evaluate|evaluation|assess|assessment|analy[sz]e|check|review)\b/.test(lower) &&
      !/(评估|测评|评价|分析|适合吗|能用吗|可以用吗)/.test(raw);
    if (recommendationOnlySignal) return false;

    const enEvaluate =
      /\b(evaluate|evaluation|assess|assessment|analy[sz]e)\b.{0,32}\b(product|this|it)\b/.test(lower) ||
      /\b(check|review)\b.{0,24}\b(this|the)\b.{0,16}\bproduct\b/.test(lower);
    const cnEvaluate =
      /(评估|测评|评价|分析|看看|判断).{0,20}(这款|这个|该|单品|产品)/.test(raw) ||
      /(这款|这个|该产品).{0,20}(适合吗|能用吗|可以用吗)/.test(raw);
    return enEvaluate || cnEvaluate;
  }

  function isMeaningfulFitCheckProductInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (/^https?:\/\//i.test(raw)) return true;

    const lower = raw.toLowerCase();
    if (
      /^(this|that|it|product|the product|a product|specific product|evaluate (?:a )?specific product(?: for me)?|evaluate (?:a )?product(?: for me)?|check (?:a )?product|analy[sz]e (?:a )?product|send (?:a )?(?:link|url|product name)|link|url|product name|name)$/i.test(
        lower,
      ) ||
      /^(这款|这个|该产品|这个产品|产品|单品|评估这款|评估产品|发链接|链接|产品名|商品名)$/.test(raw)
    ) {
      return false;
    }

    const normalized = lower
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return false;

    const hasCjk = /[\u4e00-\u9fff]/.test(normalized);
    if (hasCjk && normalized.length >= 2) return true;

    const tokens = normalized.split(' ').filter(Boolean);
    if (!tokens.length) return false;
    const informativeTokens = tokens.filter((token) => !FIT_CHECK_ANCHOR_STOPWORDS.has(token));
    if (informativeTokens.length >= 2) return true;
    if (informativeTokens.length >= 1 && /[0-9]/.test(informativeTokens[0])) return true;
    if (tokens.some((token) => /[0-9]/.test(token)) && informativeTokens.length >= 1) return true;
    return false;
  }

  function hasMeaningfulFitCheckAnchor({ message, anchorProductId, anchorProductUrl } = {}) {
    if (String(anchorProductId || '').trim()) return true;
    if (String(anchorProductUrl || '').trim()) return true;
    const parsed = extractProductInputFromFitCheckText(message);
    return isMeaningfulFitCheckProductInput(parsed);
  }

  function buildFitCheckAnchorPrompt(language) {
    const isCn = String(language || '').toUpperCase() === 'CN';
    return {
      prompt: isCn
        ? '我可以马上评估，但先给我一个锚点：请粘贴产品链接、完整产品名，或成分表（INCI）。'
        : 'I can evaluate it right away, but I need one anchor first: paste the product link, full product name, or ingredient list (INCI).',
      chips: [
        {
          chip_id: 'chip.fitcheck.send_product_name',
          label: isCn ? '发送产品名' : 'Send product name',
          kind: 'quick_reply',
          data: { reply_text: isCn ? '发送产品名' : 'Send product name' },
        },
        {
          chip_id: 'chip.fitcheck.send_link',
          label: isCn ? '发送链接' : 'Send a link',
          kind: 'quick_reply',
          data: { reply_text: isCn ? '发送链接' : 'Send a link' },
        },
        {
          chip_id: 'chip.fitcheck.send_ingredients',
          label: isCn ? '粘贴成分表' : 'Paste ingredients',
          kind: 'quick_reply',
          data: {
            reply_text: isCn
              ? '我来粘贴这款产品的成分表（INCI）'
              : "I'll paste the product ingredient list (INCI)",
          },
        },
      ],
    };
  }

  function buildFitCheckAnchorRequireInfoCardPayload(language) {
    const isCn = String(language || '').toUpperCase() === 'CN';
    return {
      severity: 'warn',
      message: isCn
        ? '继续评测前，需要你先提供产品锚点信息。'
        : 'Before product evaluation, I need a product anchor.',
      details: [
        isCn
          ? '请粘贴产品链接、完整产品名，或成分表（INCI）。'
          : 'Please paste a product link, full product name, or ingredient list (INCI).',
      ],
      actions: ['provide_product_anchor'],
    };
  }

  function inferRouteFromCards(cards) {
    const list = Array.isArray(cards) ? cards.filter((card) => card && typeof card === 'object') : [];
    const byType = new Map();
    for (const card of list) {
      const type = String(card.type || '').trim();
      if (!type) continue;
      if (!byType.has(type)) byType.set(type, card);
    }

    if (byType.has('routine_simulation') || byType.has('conflict_heatmap')) {
      const card = byType.get('routine_simulation') || byType.get('conflict_heatmap');
      return { route: 'conflict', payload: getCardPayload(card) };
    }
    if (byType.has('env_stress')) {
      return { route: 'env', payload: getCardPayload(byType.get('env_stress')) };
    }
    if (byType.has('product_analysis')) {
      return { route: 'fit-check', payload: getCardPayload(byType.get('product_analysis')) };
    }
    if (byType.has('recommendations')) {
      return { route: 'reco', payload: getCardPayload(byType.get('recommendations')) };
    }
    return null;
  }

  function inferRouteFromMessageIntent(message, { allowRecoCards } = {}) {
    if (looksLikeCompatibilityOrConflictQuestion(message)) return { route: 'conflict', payload: {} };
    if (looksLikeWeatherOrEnvironmentQuestion(message)) return { route: 'env', payload: {} };
    if (looksLikeSuitabilityRequest(message)) return { route: 'fit-check', payload: {} };
    if (allowRecoCards && looksLikeRecommendationRequest(message)) {
      return { route: 'reco', payload: {} };
    }
    return null;
  }

  function resolveRouteHint(fromCards, fromMessage) {
    const cardRoute = String(fromCards?.route || '').trim();
    const messageRoute = String(fromMessage?.route || '').trim();
    if (!cardRoute) return fromMessage || null;
    if (!messageRoute) return fromCards || null;

    const explicitMessageRoutes = new Set(['fit-check', 'conflict', 'env']);
    if (explicitMessageRoutes.has(messageRoute)) {
      if (cardRoute === 'reco') return fromMessage;
      if (cardRoute === messageRoute) return fromCards;
    }
    return fromCards;
  }

  return {
    buildRecoEntryChips,
    buildFitCheckAnchorPrompt,
    buildFitCheckAnchorRequireInfoCardPayload,
    extractProductInputFromFitCheckText,
    hasMeaningfulFitCheckAnchor,
    inferRouteFromCards,
    inferRouteFromMessageIntent,
    isMeaningfulFitCheckProductInput,
    isRenderableCardForChatboxUi,
    looksLikeProductEvaluationIntentV2,
    resolveRouteHint,
  };
}

module.exports = {
  createChatRouteSupportRuntime,
};
