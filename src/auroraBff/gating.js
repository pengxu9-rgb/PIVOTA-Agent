function profileCompleteness(profile) {
  const p = profile || {};
  const dims = {
    skinType: Boolean(p.skinType && String(p.skinType).trim()),
    barrierStatus: Boolean(p.barrierStatus && String(p.barrierStatus).trim()),
    sensitivity: Boolean(p.sensitivity && String(p.sensitivity).trim()),
    goals: Array.isArray(p.goals) ? p.goals.length > 0 : Boolean(p.goals),
  };
  const score = Object.values(dims).filter(Boolean).length;
  const missing = Object.entries(dims)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  return { score, missing };
}

function looksLikeRecommendationRequest(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;
  const scienceOnlyIntent =
    /\b(ingredient|ingredients|active|actives)\b.{0,24}\b(science|evidence|mechanism|clinical|study|paper)\b/.test(text) ||
    /\b(science|evidence|mechanism|clinical|study|paper)\b.{0,24}\b(ingredient|ingredients|active|actives)\b/.test(text) ||
    /(成分(机理|机制|科学|证据|原理)|证据链|循证|临床证据|论文证据)/.test(text);
  const stillAskingProducts =
    /\brecommend\b/.test(text) ||
    /\brecommendation\b/.test(text) ||
    /\bproducts?\b/.test(text) ||
    /\bwhat should i (buy|use)\b/.test(text) ||
    /\bbuy\b/.test(text) ||
    /推荐/.test(text) ||
    /(产品|清单|购买|下单|链接|护肤方案|早晚)/.test(text);
  if (scienceOnlyIntent && !stillAskingProducts) return false;
  return (
    /\brecommend\b/.test(text) ||
    /\brecommendation\b/.test(text) ||
    /\bsuggest\b/.test(text) ||
    /\bwhat should i (buy|use)\b/.test(text) ||
    /\broutine\b/.test(text) ||
    /\bproducts?\b/.test(text) ||
    /推荐/.test(text) ||
    /给我.*(产品|清单)/.test(text) ||
    /(护肤方案|早晚)/.test(text) ||
    // EN/CN concern-led shopping intent (no explicit "recommend" required).
    /\b(anti[-\s]?aging|anti[-\s]?age|wrinkles?|fine lines?|firming|dark spots?|hyperpigmentation|acne|pores?|redness)\b/.test(text) ||
    /(抗老|抗衰|抗皱|细纹|淡纹|紧致|提拉|痘痘|闭口|毛孔|泛红|暗沉|色沉|痘印|色斑)/.test(text) ||
    /\bam\b/.test(text) ||
    /\bpm\b/.test(text) ||
    /(怎么买|购买|下单|链接)/.test(text)
    // CN: "想要/要/求" + product-type (avoid matching weather like "要下雪")
    || /(想要|想买|要|求|求推荐|求推).*(精华|面霜|乳液|面膜|防晒|洁面|洗面奶|爽肤水|化妆水|护肤品|产品|平替|替代)/.test(text)
  );
}

function looksLikeSuitabilityRequest(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;
  return (
    /\bis (this|it) (good|okay|safe|suitable)\b/.test(text) ||
    /\bcan i use\b/.test(text) ||
    /\bwill it (irritate|break me out)\b/.test(text) ||
    /\bsuitable\b/.test(text) ||
    /(适合吗|适不适合|适合我吗|是否适合|适合不适合|合适吗|适配吗|能用吗|可以用吗|刺激吗|爆痘吗)/.test(text) ||
    // CN: common fit-check phrasing without explicitly saying "适合吗" (e.g. "请评估：<product>")
    /(评估|测评|评价)\s*[:：]\s*[^\\s]{3,}/.test(text)
  );
}

function looksLikeDiagnosisStart(message) {
  const raw = String(message || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();

  // EN-first: explicit allowlist only.
  const wantsDiagnosisEN =
    /\b(start|begin|run)\b.{0,40}\b(skin\s*)?(diagnos(?:e|is)?|analys(?:e|is)|analyz(?:e)?|assessment|scan|check)\b/.test(lower) ||
    /\b(diagnos(?:e|is)?|analys(?:e|is)|analyz(?:e)?|assessment|scan|check)\b.{0,40}\bmy\s*(skin|face)\b/.test(lower) ||
    /\b(skin|face)\b.{0,40}\b(diagnos(?:e|is)?|analys(?:e|is)|analyz(?:e)?|assessment|scan|check)\b/.test(lower) ||
    /\bskin\s*profile\b/.test(lower);
  if (wantsDiagnosisEN) return true;

  // CN-second: require both a skin subject + an explicit diagnosis/analysis verb.
  const hasSkinCN = /(皮肤|肤质|肤况|面部|脸部|脸)/.test(raw);
  const hasDiagnosisCN = /(诊断|分析|检测|评估|测一测|测试)/.test(raw);
  return hasSkinCN && hasDiagnosisCN;
}

function recommendationsAllowed(triggerSourceOrOpts, actionId, message) {
  const opts =
    triggerSourceOrOpts && typeof triggerSourceOrOpts === 'object'
      ? triggerSourceOrOpts
      : { triggerSource: triggerSourceOrOpts, actionId, message };

  const triggerSource = String(opts.triggerSource || '').trim();
  const id = String(opts.actionId || '').trim().toLowerCase();
  const text = String(opts.message || '').trim();
  const clarificationId = String(opts.clarificationId || opts.clarification_id || '').trim().toLowerCase();
  const state = String(opts.state || opts.sessionState || '').trim().toUpperCase();
  const agentState = String(opts.agentState || opts.agent_state || '').trim().toUpperCase();
  const inBudgetFlow = state === 'S6_BUDGET';
  const inRecoFlow = state === 'S7_PRODUCT_RECO' || agentState === 'RECO_GATE' || agentState === 'RECO_CONSTRAINTS' || agentState === 'RECO_RESULTS';

  // Chips/actions are "explicit" interactions, but NOT all chips should unlock recommendations/commerce.
  // Only unlock when the user explicitly asked for product outputs (recommendations/routine/dupes/analysis).
  if (triggerSource === 'chip' || triggerSource === 'action') {
    if (!id) return false;

    // Whitelist known explicit "product output" entry points.
    if (id === 'chip.start.reco_products') return true;
    // Canonical Aurora Chatbox chip id (specs/agent_state_machine.json).
    if (id === 'chip_get_recos') return true;
    if (id === 'chip.start.routine') return true;
    if (id === 'chip.start.dupes') return true;
    if (id === 'chip.action.reco_routine') return true;
    if (id === 'chip.action.analyze_product') return true;
    if (id === 'chip.action.dupe_compare') return true;

    if (id.startsWith('chip.clarify.')) {
      const clarifyKey = `${clarificationId}|${id}`.toLowerCase();
      const isProfileClarification =
        /skin|barrier|sensit|goal|concern|target|focus/.test(clarifyKey);
      if (isProfileClarification) {
        // In recommendation flow, clarification chips are explicit continuation turns.
        if (inRecoFlow || inBudgetFlow) return true;
        if (looksLikeRecommendationRequest(text) || looksLikeSuitabilityRequest(text)) return true;
        return false;
      }
    }

    if (id.startsWith('chip.clarify.budget') || id.startsWith('chip.budget.') || clarificationId === 'budget') {
      // Budget chips can be stale (copied from previous turn by some clients).
      // Only treat them as recommendation-unlocking when we are already in the budget flow,
      // or the current text clearly asks for a recommendation/fit-check/routine.
      if (inBudgetFlow) return true;
      if (
        looksLikeRecommendationRequest(text) ||
        looksLikeSuitabilityRequest(text) ||
        /\broutine\b/.test(text) ||
        /am\s*\/\s*pm/.test(text) ||
        /(早晚护肤|护肤方案)/.test(text)
      ) {
        return true;
      }
      return false;
    }

    // Fallback heuristic for future chips, but keep it narrow.
    if (id.startsWith('chip.action.') && /reco|recommend|offer|checkout|dupe|analy/.test(id)) return true;
    if (id.startsWith('chip.start.') && /reco|recommend|routine/.test(id)) return true;

    // Diagnosis/profile chips should never unlock recommendations.
    return false;
  }

  // For free text, only unlock when the user explicitly asks for products/fit-check (not diagnosis start).
  if (triggerSource === 'text_explicit') {
    return looksLikeRecommendationRequest(text) || looksLikeSuitabilityRequest(text);
  }

  return false;
}

function stateChangeAllowed(triggerSource) {
  return triggerSource === 'chip' || triggerSource === 'action' || triggerSource === 'text_explicit';
}

const CORE_PROFILE_FIELDS = ['skinType', 'sensitivity', 'barrierStatus', 'goals'];

function orderMissingFields(missing) {
  const list = Array.isArray(missing) ? missing.filter(Boolean) : [];
  const unique = [...new Set(list)];
  const known = CORE_PROFILE_FIELDS.filter((k) => unique.includes(k));
  const rest = unique.filter((k) => !CORE_PROFILE_FIELDS.includes(k));
  return [...known, ...rest];
}

function pickCurrentMissingField(missing) {
  const ordered = orderMissingFields(missing);
  return ordered[0] || null;
}

function buildDiagnosisQuestionMeta(language, field) {
  const lang = language === 'CN' ? 'CN' : 'EN';

  if (field === 'skinType') {
    return {
      field,
      question:
        lang === 'CN'
          ? '先确认一个问题：你的肤质更接近哪一类？'
          : 'One quick check first: which skin type fits you best?',
      options: [
        { value: 'oily', label: lang === 'CN' ? '油性' : 'Oily' },
        { value: 'dry', label: lang === 'CN' ? '干性' : 'Dry' },
        { value: 'combination', label: lang === 'CN' ? '混合' : 'Combination' },
        { value: 'normal', label: lang === 'CN' ? '中性' : 'Normal' },
        { value: 'sensitive', label: lang === 'CN' ? '敏感' : 'Sensitive' },
      ],
      unsure: { value: 'unknown', label: lang === 'CN' ? '不确定' : 'Not sure' },
      patchKey: 'skinType',
    };
  }

  if (field === 'sensitivity') {
    return {
      field,
      question:
        lang === 'CN'
          ? '再确认一个：你的敏感程度大概是？'
          : 'One more: how sensitive is your skin?',
      options: [
        { value: 'low', label: lang === 'CN' ? '低敏' : 'Low' },
        { value: 'medium', label: lang === 'CN' ? '中敏' : 'Medium' },
        { value: 'high', label: lang === 'CN' ? '高敏' : 'High' },
      ],
      unsure: { value: 'unknown', label: lang === 'CN' ? '不确定' : 'Not sure' },
      patchKey: 'sensitivity',
    };
  }

  if (field === 'barrierStatus') {
    return {
      field,
      question:
        lang === 'CN'
          ? '当前屏障状态更接近哪种？'
          : 'How would you describe your barrier status lately?',
      options: [
        { value: 'healthy', label: lang === 'CN' ? '稳定' : 'Healthy' },
        { value: 'impaired', label: lang === 'CN' ? '不稳定/易刺痛' : 'Irritated' },
      ],
      unsure: { value: 'unknown', label: lang === 'CN' ? '不确定' : 'Not sure' },
      patchKey: 'barrierStatus',
    };
  }

  if (field === 'goals') {
    return {
      field,
      question:
        lang === 'CN'
          ? '你现在最想优先改善哪个目标？'
          : 'What is your top skin goal right now?',
      options: [
        { value: 'acne', label: lang === 'CN' ? '控痘' : 'Acne' },
        { value: 'redness', label: lang === 'CN' ? '泛红/敏感' : 'Redness' },
        { value: 'dark_spots', label: lang === 'CN' ? '淡斑' : 'Dark spots' },
        { value: 'dehydration', label: lang === 'CN' ? '保湿补水' : 'Hydration' },
        { value: 'pores', label: lang === 'CN' ? '毛孔' : 'Pores' },
        { value: 'wrinkles', label: lang === 'CN' ? '抗老' : 'Anti-aging' },
      ],
      unsure: { value: 'unknown', label: lang === 'CN' ? '不确定' : 'Not sure' },
      patchKey: 'goals',
    };
  }

  return null;
}

function buildPendingClarificationForGate({ language, missing, message, wants }) {
  const ordered = orderMissingFields(missing);
  const current = pickCurrentMissingField(ordered);
  if (!current) return null;

  const queue = ordered
    .filter((field) => field !== current)
    .map((field) => {
      const meta = buildDiagnosisQuestionMeta(language, field);
      if (!meta) return null;
      const labels = meta.options.map((opt) => opt.label);
      if (meta.unsure && meta.unsure.label && !labels.includes(meta.unsure.label)) labels.push(meta.unsure.label);
      return {
        id: field,
        question: meta.question,
        options: labels,
      };
    })
    .filter(Boolean);

  return {
    v: 1,
    flow_id: `pc_gate_${Date.now().toString(36)}`,
    created_at_ms: Date.now(),
    resume_user_text: String(message || '').trim() || String(wants || 'recommendation'),
    step_index: 0,
    current: { id: current, norm_id: current },
    queue,
    history: [],
  };
}

function shouldDiagnosisGate({ message, triggerSource, profile }) {
  const wantsRecs = looksLikeRecommendationRequest(message);
  const wantsFit = looksLikeSuitabilityRequest(message);
  const wantsDiag = looksLikeDiagnosisStart(message);
  const intentTriggersGate = wantsRecs || wantsFit || wantsDiag;

  const { score, missing } = profileCompleteness(profile);
  const orderedMissing = orderMissingFields(missing);
  const recoMissing = CORE_PROFILE_FIELDS.filter((field) => orderedMissing.includes(field));

  // For explicit "start diagnosis", require the full 4 core dimensions.
  // For recos/fit-check, we only require at least 3 dimensions.
  const missingEnough = wantsRecs ? recoMissing.length > 0 : wantsDiag ? score < 4 : score < 3;

  if (!intentTriggersGate || !missingEnough) {
    return { gated: false, missing: orderedMissing };
  }

  const wants = wantsRecs ? 'recommendation' : wantsFit ? 'fit_check' : 'diagnosis';
  const effectiveMissing = wantsRecs ? recoMissing : orderedMissing;
  const current = pickCurrentMissingField(effectiveMissing);

  // Gate even if the user is explicit: we can proceed only after minimal profile.
  return {
    gated: true,
    reason: wantsDiag && !wantsRecs && !wantsFit ? 'diagnosis_start' : 'diagnosis_first',
    missing: effectiveMissing,
    current,
    wants,
    triggerSource,
    pending_clarification: wantsRecs
      ? buildPendingClarificationForGate({
          language: profile && profile.lang_pref === 'CN' ? 'CN' : 'EN',
          missing: effectiveMissing,
          message,
          wants,
        })
      : null,
  };
}

function buildDiagnosisPrompt(language, missing) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const current = pickCurrentMissingField(missing);
  const meta = buildDiagnosisQuestionMeta(lang, current);
  const prefix =
    lang === 'CN'
      ? '我可以帮你，但我需要先做一个极简肤况确认，避免瞎猜。'
      : "I can help — but first I need a quick skin profile so I don't guess.";
  if (!meta) {
    return prefix;
  }
  return `${prefix}\n${meta.question}`;
}

function buildDiagnosisChips(language, missing) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const current = pickCurrentMissingField(missing);
  const meta = buildDiagnosisQuestionMeta(lang, current);
  const chips = [];

  if (meta) {
    for (const option of meta.options) {
      const patch =
        meta.patchKey === 'goals'
          ? { goals: [option.value] }
          : { [meta.patchKey]: option.value };
      chips.push({
        chip_id: `profile.${meta.patchKey}.${option.value}`,
        label: option.label,
        kind: 'quick_reply',
        data: { norm_id: meta.patchKey, value: option.value, profile_patch: patch },
      });
    }
    if (meta.unsure && meta.unsure.value) {
      const unsurePatch =
        meta.patchKey === 'goals'
          ? { goals: [meta.unsure.value] }
          : { [meta.patchKey]: meta.unsure.value };
      chips.push({
        chip_id: `profile.${meta.patchKey}.${meta.unsure.value}`,
        label: meta.unsure.label,
        kind: 'quick_reply',
        data: { norm_id: meta.patchKey, value: meta.unsure.value, profile_patch: unsurePatch },
      });
    }
  }

  if (chips.length === 0) {
    chips.push({
      chip_id: 'profile.skip',
      label: lang === 'CN' ? '跳过' : 'Skip',
      kind: 'quick_reply',
      data: {},
    });
  }

  return chips;
}

function stripRecommendationCards(cards) {
  const arr = Array.isArray(cards) ? cards : [];
  return arr.filter((c) => {
    if (!c || typeof c !== 'object') return false;
    const type = String(c.type || '').toLowerCase();
    if (!type) return true;
    if (type.includes('reco')) return false;
    if (type.includes('offer')) return false;
    if (type.includes('checkout')) return false;
    return true;
  });
}

function hasUsableArtifactForRecommendations(artifact, opts = {}) {
  const requiredCore = Array.isArray(opts.requiredCore) && opts.requiredCore.length
    ? opts.requiredCore
    : ['skinType', 'sensitivity', 'barrierStatus', 'goals'];

  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, reason: 'artifact_missing', confidence_level: 'low' };
  }

  const missingCore = [];
  for (const field of requiredCore) {
    const node = artifact[field];
    if (field === 'goals') {
      const values =
        node && typeof node === 'object' && !Array.isArray(node) && Array.isArray(node.values)
          ? node.values
          : [];
      if (!values.length) missingCore.push(field);
      continue;
    }
    const value =
      node && typeof node === 'object' && !Array.isArray(node)
        ? String(node.value || '').trim()
        : String(node || '').trim();
    if (!value) missingCore.push(field);
  }

  const confidenceNode =
    artifact.overall_confidence && typeof artifact.overall_confidence === 'object' ? artifact.overall_confidence : null;
  const confidenceScore = Number(confidenceNode && confidenceNode.score);
  const confidenceLevelRaw = String(confidenceNode && confidenceNode.level || '').trim().toLowerCase();
  const confidenceLevel =
    confidenceLevelRaw === 'low' || confidenceLevelRaw === 'medium' || confidenceLevelRaw === 'high'
      ? confidenceLevelRaw
      : Number.isFinite(confidenceScore)
        ? confidenceScore < 0.55
          ? 'low'
          : confidenceScore <= 0.75
            ? 'medium'
            : 'high'
        : 'low';

  if (missingCore.length > 0) {
    return { ok: false, reason: 'artifact_missing_core', missing_core: missingCore, confidence_level: confidenceLevel };
  }

  return {
    ok: true,
    reason: 'ok',
    missing_core: [],
    confidence_level: confidenceLevel,
  };
}

module.exports = {
  profileCompleteness,
  looksLikeRecommendationRequest,
  looksLikeSuitabilityRequest,
  looksLikeDiagnosisStart,
  recommendationsAllowed,
  stateChangeAllowed,
  shouldDiagnosisGate,
  buildDiagnosisPrompt,
  buildDiagnosisChips,
  buildPendingClarificationForGate,
  stripRecommendationCards,
  hasUsableArtifactForRecommendations,
};
