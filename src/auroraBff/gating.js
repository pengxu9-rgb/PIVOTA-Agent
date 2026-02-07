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
    /(适合吗|适不适合|适合我吗|能用吗|可以用吗|刺激吗|爆痘吗)/.test(text)
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

  // Chips/actions are "explicit" interactions, but NOT all chips should unlock recommendations/commerce.
  // Only unlock when the user explicitly asked for product outputs (recommendations/routine/dupes/analysis).
  if (triggerSource === 'chip' || triggerSource === 'action') {
    if (!id) return false;

    // Whitelist known explicit "product output" entry points.
    if (id === 'chip.start.reco_products') return true;
    // Canonical Aurora Chatbox chip id (specs/agent_state_machine.json).
    if (id === 'chip_get_recos') return true;
    if (id === 'chip.start.routine') return true;
    if (id === 'chip.action.reco_routine') return true;
    if (id === 'chip.action.analyze_product') return true;
    if (id === 'chip.action.dupe_compare') return true;

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

function shouldDiagnosisGate({ message, triggerSource, profile }) {
  const wantsRecs = looksLikeRecommendationRequest(message);
  const wantsFit = looksLikeSuitabilityRequest(message);
  const wantsDiag = looksLikeDiagnosisStart(message);
  const intentTriggersGate = wantsRecs || wantsFit || wantsDiag;

  const { score, missing } = profileCompleteness(profile);
  // For explicit "start diagnosis", require the full 4 core dimensions.
  // For recos/fit-check, we only require at least 3 dimensions.
  const missingEnough = wantsDiag ? score < 4 : score < 3;

  if (!intentTriggersGate || !missingEnough) {
    return { gated: false, missing };
  }

  // Gate even if the user is explicit: we can proceed only after minimal profile.
  return {
    gated: true,
    reason: wantsDiag && !wantsRecs && !wantsFit ? 'diagnosis_start' : 'diagnosis_first',
    missing,
    wants: wantsRecs ? 'recommendation' : wantsFit ? 'fit_check' : 'diagnosis',
    triggerSource,
  };
}

function buildDiagnosisPrompt(language, missing) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const missingSet = new Set(missing || []);

  const linesEN = [];
  const linesCN = [];

  linesEN.push("I can help — but first I need a quick skin profile so I don't guess.");
  linesCN.push('我可以帮你，但我需要先做一个极简肤况确认，避免瞎猜。');

  if (missingSet.has('skinType')) {
    linesEN.push('1) Your skin type?');
    linesCN.push('1）你的肤质是？');
  }
  if (missingSet.has('sensitivity')) {
    linesEN.push('2) How sensitive is your skin (low/medium/high)?');
    linesCN.push('2）你的敏感程度（低/中/高）？');
  }
  if (missingSet.has('barrierStatus')) {
    linesEN.push('3) Barrier status lately (healthy / irritated / not sure)?');
    linesCN.push('3）最近屏障状态（稳定/泛红刺痛/不确定）？');
  }
  if (missingSet.has('goals')) {
    linesEN.push('4) Top goal right now?');
    linesCN.push('4）你当前最想改善的目标是？');
  }

  return (lang === 'CN' ? linesCN : linesEN).join('\n');
}

function buildDiagnosisChips(language, missing) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const missingSet = new Set(missing || []);
  const chips = [];

  if (missingSet.has('skinType')) {
    const options = [
      ['oily', lang === 'CN' ? '油性' : 'Oily'],
      ['dry', lang === 'CN' ? '干性' : 'Dry'],
      ['combination', lang === 'CN' ? '混合' : 'Combination'],
      ['normal', lang === 'CN' ? '中性' : 'Normal'],
      ['sensitive', lang === 'CN' ? '敏感' : 'Sensitive'],
    ];
    for (const [value, label] of options) {
      chips.push({
        chip_id: `profile.skinType.${value}`,
        label,
        kind: 'quick_reply',
        data: { profile_patch: { skinType: value } },
      });
    }
  }

  if (missingSet.has('sensitivity')) {
    const options = [
      ['low', lang === 'CN' ? '敏感：低' : 'Sensitivity: low'],
      ['medium', lang === 'CN' ? '敏感：中' : 'Sensitivity: medium'],
      ['high', lang === 'CN' ? '敏感：高' : 'Sensitivity: high'],
    ];
    for (const [value, label] of options) {
      chips.push({
        chip_id: `profile.sensitivity.${value}`,
        label,
        kind: 'quick_reply',
        data: { profile_patch: { sensitivity: value } },
      });
    }
  }

  if (missingSet.has('barrierStatus')) {
    const options = [
      ['healthy', lang === 'CN' ? '屏障：稳定' : 'Barrier: healthy'],
      ['impaired', lang === 'CN' ? '屏障：不稳定/刺痛' : 'Barrier: irritated'],
      ['unknown', lang === 'CN' ? '屏障：不确定' : 'Barrier: not sure'],
    ];
    for (const [value, label] of options) {
      chips.push({
        chip_id: `profile.barrierStatus.${value}`,
        label,
        kind: 'quick_reply',
        data: { profile_patch: { barrierStatus: value } },
      });
    }
  }

  if (missingSet.has('goals')) {
    const options = [
      ['acne', lang === 'CN' ? '目标：控痘' : 'Goal: acne'],
      ['redness', lang === 'CN' ? '目标：泛红/敏感' : 'Goal: redness'],
      ['dark_spots', lang === 'CN' ? '目标：淡斑' : 'Goal: dark spots'],
      ['dehydration', lang === 'CN' ? '目标：保湿补水' : 'Goal: hydration'],
      ['pores', lang === 'CN' ? '目标：毛孔' : 'Goal: pores'],
      ['wrinkles', lang === 'CN' ? '目标：抗老' : 'Goal: anti-aging'],
    ];
    for (const [value, label] of options) {
      chips.push({
        chip_id: `profile.goals.${value}`,
        label,
        kind: 'quick_reply',
        data: { profile_patch: { goals: [value] } },
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
  stripRecommendationCards,
};
