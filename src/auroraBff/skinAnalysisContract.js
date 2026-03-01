const CONFIDENCE_ENUM = Object.freeze(['pretty_sure', 'somewhat_sure', 'not_sure']);

const SkinAnalysisSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    features: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          observation: { type: 'string', maxLength: 120 },
          confidence: { type: 'string', enum: CONFIDENCE_ENUM.slice() },
        },
        required: ['observation', 'confidence'],
      },
    },
    strategy: { type: 'string', maxLength: 700 },
    needs_risk_check: { type: 'boolean' },
    primary_question: { type: 'string', maxLength: 60 },
    conditional_followups: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', maxLength: 60 },
    },
    routine_expert: { type: 'string', maxLength: 200 },
  },
  required: [
    'features',
    'strategy',
    'needs_risk_check',
    'primary_question',
    'conditional_followups',
    'routine_expert',
  ],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRouteLanguage(language) {
  const raw = String(language || '').trim().toLowerCase();
  if (raw === 'cn' || raw === 'zh' || raw === 'zh-cn' || raw === 'zh_hans') return 'zh-CN';
  return 'en-US';
}

function isPoorPhotoQuality(quality) {
  const token = String(quality || '').trim().toLowerCase();
  return token === 'poor' || token === 'degraded' || token === 'fail' || token === 'unknown';
}

function clampText(raw, maxLen) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return '';
  if (!Number.isFinite(maxLen) || maxLen <= 0) return '';
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen).trim();
}

function normalizeConfidence(raw) {
  const token = String(raw || '').trim();
  if (CONFIDENCE_ENUM.includes(token)) return token;
  return 'somewhat_sure';
}

function normalizeFeatureItem(raw) {
  const item = isPlainObject(raw) ? raw : null;
  if (!item) return null;
  const observation = clampText(item.observation, 120);
  if (!observation) return null;
  return {
    observation,
    confidence: normalizeConfidence(item.confidence),
  };
}

function normalizeStringArray(raw, maxItems, maxLen) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const text = clampText(item, maxLen);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function defaultFeatureTemplates(language, poorQuality) {
  const lang = normalizeRouteLanguage(language);
  if (lang === 'zh-CN') {
    if (poorQuality) {
      return [
        { observation: '照片清晰度或光照不足，当前仅能做保守判断。', confidence: 'not_sure' },
        { observation: '建议在自然光、无滤镜条件下重拍正脸照片再分析。', confidence: 'not_sure' },
      ];
    }
    return [
      { observation: '可见信号有限，建议先按低刺激基线护理。', confidence: 'somewhat_sure' },
      { observation: '先观察 7 天变化，再逐步调整活性频率。', confidence: 'somewhat_sure' },
    ];
  }
  if (poorQuality) {
    return [
      { observation: 'Photo clarity/lighting is limited, so findings are conservative.', confidence: 'not_sure' },
      { observation: 'Please retake in daylight with no beauty filter for better reliability.', confidence: 'not_sure' },
    ];
  }
  return [
    { observation: 'Visible signals are limited, so start from a low-irritation baseline.', confidence: 'somewhat_sure' },
    { observation: 'Track changes for 7 days before adding stronger actives.', confidence: 'somewhat_sure' },
  ];
}

function defaultStrategy(language, poorQuality) {
  const lang = normalizeRouteLanguage(language);
  if (lang === 'zh-CN') {
    if (poorQuality) {
      return 'AM: 温和洁面 + 保湿 + 防晒。PM: 温和洁面 + 保湿。Frequency: 暂停新增强活性 5-7 天。If irritation: 出现持续刺痛/泛红立即降到洁面+保湿+防晒，并重拍清晰自然光照片。';
    }
    return 'AM: 温和洁面 + 保湿 + 防晒。PM: 温和洁面 + 保湿。Frequency: 新活性从每周 1-2 次起。If irritation: 出现刺痛或泛红时降低频率并回到基础护理。';
  }
  if (poorQuality) {
    return 'AM: Gentle cleanse + moisturizer + SPF. PM: Gentle cleanse + moisturizer. Frequency: Pause new strong actives for 5-7 days. If irritation: persistent stinging/redness -> de-escalate to cleanse+moisturize+SPF and retake a clearer daylight photo.';
  }
  return 'AM: Gentle cleanse + moisturizer + SPF. PM: Gentle cleanse + moisturizer. Frequency: Start new actives 1-2 nights/week. If irritation: reduce frequency and return to baseline care.';
}

function defaultPrimaryQuestion(language, poorQuality) {
  const lang = normalizeRouteLanguage(language);
  if (lang === 'zh-CN') {
    return poorQuality ? '可否补一张自然光无遮挡正脸照片？' : '最近是否有刺痛或泛红？';
  }
  return poorQuality
    ? 'Can you retake a clear daylight front-facing photo?'
    : 'Any recent stinging or redness?';
}

function toRoutineExpertText(raw) {
  if (typeof raw === 'string') return clampText(raw, 200);
  if (!isPlainObject(raw)) return '';
  const snapshot = isPlainObject(raw.snapshot) ? raw.snapshot : null;
  const summary = snapshot && typeof snapshot.summary === 'string' ? snapshot.summary : '';
  return clampText(summary, 200);
}

function normalizeSkinAnalysisContract(input, { language, photoQuality } = {}) {
  const obj = isPlainObject(input) ? input : {};
  const poorQuality = isPoorPhotoQuality(photoQuality);

  const featuresRaw = Array.isArray(obj.features) ? obj.features : [];
  const features = [];
  for (const raw of featuresRaw) {
    const normalized = normalizeFeatureItem(raw);
    if (!normalized) continue;
    features.push(normalized);
    if (features.length >= 4) break;
  }

  if (features.length < 2) {
    const defaults = defaultFeatureTemplates(language, poorQuality);
    for (const item of defaults) {
      if (features.length >= 2) break;
      features.push(item);
    }
  }

  let strategy = clampText(obj.strategy, 700);
  if (!strategy) strategy = defaultStrategy(language, poorQuality);

  const needsRiskCheckRaw = obj.needs_risk_check ?? obj.needsRiskCheck;
  const needs_risk_check = needsRiskCheckRaw === true;

  let primary_question = clampText(obj.primary_question ?? obj.primaryQuestion, 60);
  if (!primary_question && poorQuality) {
    primary_question = defaultPrimaryQuestion(language, true);
  }

  let conditional_followups = normalizeStringArray(
    obj.conditional_followups ?? obj.conditionalFollowups,
    3,
    60,
  ).filter((item) => item !== primary_question);

  if (poorQuality && !primary_question) {
    primary_question = defaultPrimaryQuestion(language, true);
  }
  if (poorQuality && conditional_followups.length === 0) {
    const fallback = normalizeRouteLanguage(language) === 'zh-CN'
      ? '请使用自然光、无滤镜、正脸平视，距离约 30-50cm。'
      : 'Use daylight, no beauty filter, front-facing view, about 30-50cm distance.';
    conditional_followups = [fallback];
  }

  const routine_expert = toRoutineExpertText(obj.routine_expert);

  return {
    features: features.slice(0, 4),
    strategy,
    needs_risk_check,
    primary_question,
    conditional_followups,
    routine_expert,
  };
}

function validateSkinAnalysisSchema(contract, { strict = false } = {}) {
  const obj = isPlainObject(contract) ? contract : null;
  if (!obj) return { ok: false, reason: 'not_object' };

  for (const key of SkinAnalysisSchema.required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return { ok: false, reason: 'missing_key', key };
  }

  if (strict) {
    const allowed = new Set(SkinAnalysisSchema.required);
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) return { ok: false, reason: 'extra_key', key };
    }
  }

  if (!Array.isArray(obj.features) || obj.features.length < 2 || obj.features.length > 4) {
    return { ok: false, reason: 'features_size' };
  }

  for (const item of obj.features) {
    if (!isPlainObject(item)) return { ok: false, reason: 'feature_not_object' };
    const observation = String(item.observation || '');
    if (!observation.trim() || observation.length > 120) return { ok: false, reason: 'feature_observation_invalid' };
    if (!CONFIDENCE_ENUM.includes(String(item.confidence || ''))) return { ok: false, reason: 'feature_confidence_invalid' };
  }

  if (typeof obj.strategy !== 'string' || obj.strategy.length > 700 || !obj.strategy.trim()) {
    return { ok: false, reason: 'strategy_invalid' };
  }

  if (typeof obj.needs_risk_check !== 'boolean') return { ok: false, reason: 'needs_risk_check_invalid' };

  if (typeof obj.primary_question !== 'string' || obj.primary_question.length > 60) {
    return { ok: false, reason: 'primary_question_invalid' };
  }

  if (!Array.isArray(obj.conditional_followups) || obj.conditional_followups.length > 3) {
    return { ok: false, reason: 'conditional_followups_invalid' };
  }

  for (const item of obj.conditional_followups) {
    if (typeof item !== 'string' || item.length > 60) {
      return { ok: false, reason: 'conditional_followup_item_invalid' };
    }
  }

  if (typeof obj.routine_expert !== 'string' || obj.routine_expert.length > 200) {
    return { ok: false, reason: 'routine_expert_invalid' };
  }

  return { ok: true };
}

const MEDICAL_FORBIDDEN_RE = /\b(rosacea|eczema|psoriasis|dermatitis|infection|fungus|fungal|diagnose|diagnosis|cure|treat|medical)\b/i;
const PRESCRIPTION_FORBIDDEN_RE = /\b(tretinoin|adapalene|isotretinoin|accutane|clindamycin|doxycycline|metronidazole|hydrocortisone|prescription|antibiotic|steroid)\b/i;
const CN_MEDICAL_FORBIDDEN_RE = /(玫瑰痤疮|湿疹|银屑病|皮炎|感染|真菌|诊断|治疗|治愈|处方|抗生素|激素|维A酸|阿达帕林|异维A酸|甲硝唑|克林霉素|多西环素)/i;
const BRAND_FORBIDDEN_RE = /\b(cerave|cetaphil|la roche[- ]?posay|sk-ii|lancome|estee|clinique|kiehls|neutrogena|olay|the ordinary|paula'?s choice)\b/i;
const CN_BRAND_FORBIDDEN_RE = /(理肤泉|薇诺娜|修丽可|雅诗兰黛|兰蔻|倩碧|科颜氏|露得清|欧莱雅)/i;

function collectContractTexts(contract) {
  const obj = isPlainObject(contract) ? contract : {};
  const list = [];
  for (const item of Array.isArray(obj.features) ? obj.features : []) {
    if (item && typeof item.observation === 'string') list.push(item.observation);
  }
  if (typeof obj.strategy === 'string') list.push(obj.strategy);
  if (typeof obj.primary_question === 'string') list.push(obj.primary_question);
  for (const item of Array.isArray(obj.conditional_followups) ? obj.conditional_followups : []) {
    if (typeof item === 'string') list.push(item);
  }
  if (typeof obj.routine_expert === 'string') list.push(obj.routine_expert);
  return list;
}

function validateSkinAnalysisContent(contract, { language } = {}) {
  const texts = collectContractTexts(contract);
  for (const text of texts) {
    if (!text || !String(text).trim()) continue;
    if (MEDICAL_FORBIDDEN_RE.test(text) || PRESCRIPTION_FORBIDDEN_RE.test(text) || BRAND_FORBIDDEN_RE.test(text)) {
      return { ok: false, reason: 'forbidden_content' };
    }
    if (CN_MEDICAL_FORBIDDEN_RE.test(text) || CN_BRAND_FORBIDDEN_RE.test(text)) {
      return { ok: false, reason: 'forbidden_content' };
    }
  }
  return { ok: true };
}

function deriveAsk3Questions(contract, { language } = {}) {
  const normalized = normalizeSkinAnalysisContract(contract, { language });
  const ask = [];
  const push = (value) => {
    const text = clampText(value, 60);
    if (!text) return;
    if (ask.includes(text)) return;
    ask.push(text);
  };
  push(normalized.primary_question);
  for (const item of normalized.conditional_followups) push(item);
  if (ask.length === 0) {
    push(defaultPrimaryQuestion(language, false));
  }
  return ask.slice(0, 3);
}

function pickFeatureCandidates(layer) {
  if (!isPlainObject(layer) || !Array.isArray(layer.features)) return [];
  const out = [];
  for (const item of layer.features) {
    const normalized = normalizeFeatureItem(item);
    if (!normalized) continue;
    out.push(normalized);
    if (out.length >= 4) break;
  }
  return out;
}

function finalizeSkinAnalysisContract({
  factLayer,
  reportLayer,
  deterministicAnalysis,
  quality,
  language,
} = {}) {
  const qualityToken = String(quality || '').trim().toLowerCase();
  const poorQuality = isPoorPhotoQuality(qualityToken);

  const deterministicBase = normalizeSkinAnalysisContract(deterministicAnalysis, {
    language,
    photoQuality: qualityToken,
  });
  const reportBase = normalizeSkinAnalysisContract(reportLayer, {
    language,
    photoQuality: qualityToken,
  });

  const factFeatures = pickFeatureCandidates(factLayer);
  const features = factFeatures.length ? factFeatures : deterministicBase.features;

  let strategy = clampText(
    isPlainObject(reportLayer) ? reportLayer.strategy : '',
    700,
  );
  if (!strategy) strategy = deterministicBase.strategy;

  let primary_question = clampText(
    isPlainObject(reportLayer) ? reportLayer.primary_question : '',
    60,
  );
  if (!primary_question) primary_question = deterministicBase.primary_question;

  let conditional_followups = normalizeStringArray(
    isPlainObject(reportLayer) ? reportLayer.conditional_followups : [],
    3,
    60,
  ).filter((item) => item !== primary_question);
  if (!conditional_followups.length) conditional_followups = deterministicBase.conditional_followups;

  let routine_expert = toRoutineExpertText(isPlainObject(reportLayer) ? reportLayer.routine_expert : '');
  if (!routine_expert) routine_expert = deterministicBase.routine_expert;

  let needs_risk_check = false;
  if (isPlainObject(factLayer) && factLayer.needs_risk_check === true) needs_risk_check = true;
  if (isPlainObject(reportLayer) && reportLayer.needs_risk_check === true) needs_risk_check = true;
  if (deterministicBase.needs_risk_check === true) needs_risk_check = true;

  let output = normalizeSkinAnalysisContract(
    {
      features,
      strategy,
      needs_risk_check,
      primary_question,
      conditional_followups,
      routine_expert,
    },
    { language, photoQuality: qualityToken },
  );

  if (poorQuality) {
    const conservative = defaultFeatureTemplates(language, true)
      .map((item) => ({ ...item, confidence: 'not_sure' }))
      .slice(0, 2);
    output = {
      ...output,
      features: conservative,
      strategy: defaultStrategy(language, true),
      primary_question: defaultPrimaryQuestion(language, true),
      conditional_followups: normalizeRouteLanguage(language) === 'zh-CN'
        ? ['请在自然光下无滤镜重拍，正脸平视。']
        : ['Please retake in daylight with no beauty filter, front-facing.'],
    };
    output = normalizeSkinAnalysisContract(output, { language, photoQuality: 'poor' });
  }

  return output;
}

function buildContentRevisionInstruction() {
  return (
    'Revise your previous output to comply with safety rules:\n' +
    '- Remove any disease names, prescription drug names, or treatment claims.\n' +
    '- Remove any brand or specific product recommendations.\n' +
    'Keep the same meaning and keep it concise.'
  );
}

module.exports = {
  SkinAnalysisSchema,
  normalizeRouteLanguage,
  normalizeSkinAnalysisContract,
  validateSkinAnalysisSchema,
  validateSkinAnalysisContent,
  finalizeSkinAnalysisContract,
  deriveAsk3Questions,
  buildContentRevisionInstruction,
};
