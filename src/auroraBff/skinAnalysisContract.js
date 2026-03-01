const CONFIDENCE_VALUES = Object.freeze(['pretty_sure', 'somewhat_sure', 'not_sure']);

const SkinFeatureItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    observation: { type: 'string', maxLength: 120 },
    confidence: { type: 'string', enum: CONFIDENCE_VALUES.slice() },
  },
  required: ['observation', 'confidence'],
};

const SkinFinalContractSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    features: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: SkinFeatureItemSchema,
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
};

const SkinVisionObservationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    features: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: SkinFeatureItemSchema,
    },
    needs_risk_check: { type: 'boolean' },
  },
  required: ['features', 'needs_risk_check'],
};

const SkinReportStrategySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
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
  required: ['strategy', 'needs_risk_check', 'primary_question', 'conditional_followups', 'routine_expert'],
};

function clampText(raw, maxLen) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function normalizeConfidence(raw) {
  const token = String(raw || '').trim();
  if (token === 'pretty_sure' || token === 'somewhat_sure' || token === 'not_sure') return token;
  return 'somewhat_sure';
}

function normalizeFeatures(rawFeatures, { minItems = 2, maxItems = 4, conservative = false } = {}) {
  const list = Array.isArray(rawFeatures) ? rawFeatures : [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const observation = clampText(raw.observation, 120);
    if (!observation) continue;
    const confidence = conservative ? 'not_sure' : normalizeConfidence(raw.confidence);
    out.push({ observation, confidence });
    if (out.length >= maxItems) break;
  }
  if (!out.length) {
    out.push({ observation: 'Limited visible cosmetic signal from current evidence.', confidence: conservative ? 'not_sure' : 'somewhat_sure' });
  }
  while (out.length < minItems) {
    const fallbackObs = conservative
      ? 'Image clarity is limited; this observation remains uncertain.'
      : 'Signal is moderate; track changes over the next 7 days.';
    out.push({ observation: fallbackObs, confidence: conservative ? 'not_sure' : 'somewhat_sure' });
  }
  return out.slice(0, maxItems);
}

function normalizeFollowups(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const text = clampText(item, 60);
    if (!text) continue;
    out.push(text);
    if (out.length >= 3) break;
  }
  return out;
}

function normalizeLang(lang) {
  const token = String(lang || '').trim().toLowerCase();
  if (token === 'cn' || token === 'zh-cn' || token === 'zh') return 'zh-CN';
  return 'en-US';
}

function mapQualityToMode(quality) {
  const grade = String((quality && quality.grade) || quality || '')
    .trim()
    .toLowerCase();
  if (grade === 'poor') return 'poor';
  if (grade === 'fail') return 'poor';
  if (grade === 'ok' || grade === 'degraded') return 'ok';
  if (grade === 'good' || grade === 'pass') return 'good';
  return 'ok';
}

function buildPoorPhotoTemplate({ lang } = {}) {
  const locale = normalizeLang(lang);
  if (locale === 'zh-CN') {
    return {
      features: normalizeFeatures(
        [
          { observation: '当前照片可见信息不足，无法稳定识别关键皮肤信号。', confidence: 'not_sure' },
          { observation: '受光线/清晰度/遮挡影响，结论需要保守处理。', confidence: 'not_sure' },
        ],
        { minItems: 2, maxItems: 4, conservative: true },
      ),
      strategy:
        'AM: 温和清洁 + 保湿 + 防晒。PM: 温和清洁 + 保湿。Frequency: 暂停新增刺激性活性，先稳定 7 天。If irritation: 一旦刺痛/泛红加重，立即简化为清洁+保湿并停止叠加。',
      needs_risk_check: true,
      primary_question: '请重拍一张自然光、无滤镜、正脸、30-50cm、清晰对焦的照片，可以吗？',
      conditional_followups: ['是否有明显刺痛或紧绷？', '最近一周是否突然爆痘？'],
      routine_expert: '',
    };
  }

  return {
    features: normalizeFeatures(
      [
        { observation: 'Current photo provides limited reliable cosmetic signal.', confidence: 'not_sure' },
        { observation: 'Lighting/clarity/occlusion may affect interpretation.', confidence: 'not_sure' },
      ],
      { minItems: 2, maxItems: 4, conservative: true },
    ),
    strategy:
      'AM: gentle cleanse + moisturizer + sunscreen. PM: gentle cleanse + moisturizer. Frequency: pause new irritating actives for 7 days. If irritation: stop added actives and simplify to cleanse + moisturizer only.',
    needs_risk_check: true,
    primary_question: 'Can you retake one clear front-facing photo in natural daylight, no beauty filter, 30-50cm distance?',
    conditional_followups: ['Any recent stinging or tightness?', 'Any sudden flare-up in the last week?'],
    routine_expert: '',
  };
}

function deriveAsk3Questions(primaryQuestion, conditionalFollowups) {
  const list = [];
  const p = clampText(primaryQuestion, 120);
  if (p) list.push(p);
  for (const item of Array.isArray(conditionalFollowups) ? conditionalFollowups : []) {
    const text = clampText(item, 120);
    if (!text) continue;
    list.push(text);
    if (list.length >= 3) break;
  }
  while (list.length < 3) {
    list.push('');
  }
  return list.slice(0, 3);
}

function validateFeatureArray(features, { min = 2, max = 4, path = '/features' } = {}) {
  const errors = [];
  if (!Array.isArray(features)) {
    errors.push(`${path} must be array`);
    return errors;
  }
  if (features.length < min) errors.push(`${path} must contain at least ${min} items`);
  if (features.length > max) errors.push(`${path} must contain at most ${max} items`);
  for (let i = 0; i < features.length; i += 1) {
    const item = features[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${path}/${i} must be object`);
      continue;
    }
    if (typeof item.observation !== 'string' || !item.observation.trim()) {
      errors.push(`${path}/${i}/observation must be non-empty string`);
    } else if (item.observation.trim().length > 120) {
      errors.push(`${path}/${i}/observation exceeds 120 chars`);
    }
    if (!CONFIDENCE_VALUES.includes(String(item.confidence || ''))) {
      errors.push(`${path}/${i}/confidence invalid`);
    }
  }
  return errors;
}

function validateVisionObservation(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const errors = [];
  if (!p) return { ok: false, errors: ['/ must be object'] };
  const keys = Object.keys(p);
  for (const key of keys) {
    if (key !== 'features' && key !== 'needs_risk_check') errors.push(`/${key} is not allowed`);
  }
  errors.push(...validateFeatureArray(p.features, { min: 2, max: 4, path: '/features' }));
  if (typeof p.needs_risk_check !== 'boolean') errors.push('/needs_risk_check must be boolean');
  return { ok: errors.length === 0, errors };
}

function validateReportStrategy(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const errors = [];
  if (!p) return { ok: false, errors: ['/ must be object'] };
  const allowed = new Set(['strategy', 'needs_risk_check', 'primary_question', 'conditional_followups', 'routine_expert']);
  for (const key of Object.keys(p)) {
    if (!allowed.has(key)) errors.push(`/${key} is not allowed`);
  }
  if (typeof p.strategy !== 'string' || !p.strategy.trim()) errors.push('/strategy must be non-empty string');
  if (typeof p.strategy === 'string' && p.strategy.length > 700) errors.push('/strategy exceeds 700 chars');
  if (typeof p.needs_risk_check !== 'boolean') errors.push('/needs_risk_check must be boolean');
  if (typeof p.primary_question !== 'string') errors.push('/primary_question must be string');
  if (typeof p.primary_question === 'string' && p.primary_question.length > 60) errors.push('/primary_question exceeds 60 chars');
  if (!Array.isArray(p.conditional_followups)) errors.push('/conditional_followups must be array');
  if (Array.isArray(p.conditional_followups)) {
    if (p.conditional_followups.length > 3) errors.push('/conditional_followups max 3 items');
    for (let i = 0; i < p.conditional_followups.length; i += 1) {
      const item = p.conditional_followups[i];
      if (typeof item !== 'string') errors.push(`/conditional_followups/${i} must be string`);
      if (typeof item === 'string' && item.length > 60) errors.push(`/conditional_followups/${i} exceeds 60 chars`);
    }
  }
  if (typeof p.routine_expert !== 'string') errors.push('/routine_expert must be string');
  if (typeof p.routine_expert === 'string' && p.routine_expert.length > 200) errors.push('/routine_expert exceeds 200 chars');
  return { ok: errors.length === 0, errors };
}

function validateFinalContract(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const errors = [];
  if (!p) return { ok: false, errors: ['/ must be object'] };
  const allowed = new Set(['features', 'strategy', 'needs_risk_check', 'primary_question', 'conditional_followups', 'routine_expert']);
  for (const key of Object.keys(p)) {
    if (!allowed.has(key)) errors.push(`/${key} is not allowed`);
  }
  errors.push(...validateFeatureArray(p.features, { min: 2, max: 4, path: '/features' }));
  if (typeof p.strategy !== 'string' || !p.strategy.trim()) errors.push('/strategy must be non-empty string');
  if (typeof p.strategy === 'string' && p.strategy.length > 700) errors.push('/strategy exceeds 700 chars');
  if (typeof p.needs_risk_check !== 'boolean') errors.push('/needs_risk_check must be boolean');
  if (typeof p.primary_question !== 'string') errors.push('/primary_question must be string');
  if (typeof p.primary_question === 'string' && p.primary_question.length > 60) errors.push('/primary_question exceeds 60 chars');
  if (!Array.isArray(p.conditional_followups)) errors.push('/conditional_followups must be array');
  if (Array.isArray(p.conditional_followups)) {
    if (p.conditional_followups.length > 3) errors.push('/conditional_followups max 3 items');
    for (let i = 0; i < p.conditional_followups.length; i += 1) {
      const item = p.conditional_followups[i];
      if (typeof item !== 'string') errors.push(`/conditional_followups/${i} must be string`);
      if (typeof item === 'string' && item.length > 60) errors.push(`/conditional_followups/${i} exceeds 60 chars`);
    }
  }
  if (typeof p.routine_expert !== 'string') errors.push('/routine_expert must be string');
  if (typeof p.routine_expert === 'string' && p.routine_expert.length > 200) errors.push('/routine_expert exceeds 200 chars');
  return { ok: errors.length === 0, errors };
}

function buildFactLayer({ deterministicAnalysis, visionLayer } = {}) {
  const deterministic = deterministicAnalysis && typeof deterministicAnalysis === 'object' ? deterministicAnalysis : {};
  const vision = visionLayer && typeof visionLayer === 'object' ? visionLayer : null;

  const deterministicFeatures = normalizeFeatures(deterministic.features, { minItems: 2, maxItems: 4 });
  const visionFeatures = vision ? normalizeFeatures(vision.features, { minItems: 2, maxItems: 4 }) : [];

  const merged = [];
  const seen = new Set();
  for (const row of [...deterministicFeatures, ...visionFeatures]) {
    const key = String(row.observation || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
    if (merged.length >= 4) break;
  }

  return {
    features: normalizeFeatures(merged, { minItems: 2, maxItems: 4 }),
    needs_risk_check: Boolean(deterministic.needs_risk_check || (vision && vision.needs_risk_check)),
  };
}

function finalizeSkinAnalysisContract({ factLayer, reportLayer, quality, lang, deterministicFallback } = {}) {
  const fallback = deterministicFallback && typeof deterministicFallback === 'object' ? deterministicFallback : {};
  const fact = factLayer && typeof factLayer === 'object' ? factLayer : {};
  const report = reportLayer && typeof reportLayer === 'object' ? reportLayer : {};

  const qualityMode = mapQualityToMode(quality);
  const isPoor = qualityMode === 'poor';

  const safeBase = {
    features: normalizeFeatures(fact.features || fallback.features, { minItems: 2, maxItems: 4, conservative: false }),
    strategy: clampText(report.strategy || fallback.strategy, 700),
    needs_risk_check: Boolean(fact.needs_risk_check || report.needs_risk_check || fallback.needs_risk_check),
    primary_question: clampText(report.primary_question || fallback.primary_question, 60),
    conditional_followups: normalizeFollowups(report.conditional_followups || fallback.conditional_followups),
    routine_expert: clampText(report.routine_expert || fallback.routine_expert, 200),
  };

  const resolved = isPoor ? buildPoorPhotoTemplate({ lang }) : safeBase;

  if (!resolved.strategy) {
    resolved.strategy = normalizeLang(lang) === 'zh-CN'
      ? 'AM: 温和清洁 + 保湿 + 防晒。PM: 温和清洁 + 保湿。Frequency: 一次只调整一个变量。If irritation: 出现持续刺激时立即回退到基础护理。'
      : 'AM: gentle cleanse + moisturizer + sunscreen. PM: gentle cleanse + moisturizer. Frequency: adjust one variable at a time. If irritation: revert to basic care immediately.';
  }

  if (!resolved.primary_question) resolved.primary_question = '';
  if (!Array.isArray(resolved.conditional_followups)) resolved.conditional_followups = [];
  if (!resolved.routine_expert) resolved.routine_expert = '';

  resolved.features = normalizeFeatures(resolved.features, { minItems: 2, maxItems: 4, conservative: isPoor });
  resolved.conditional_followups = normalizeFollowups(resolved.conditional_followups);
  resolved.strategy = clampText(resolved.strategy, 700);
  resolved.primary_question = clampText(resolved.primary_question, 60);
  resolved.routine_expert = clampText(resolved.routine_expert, 200);
  resolved.needs_risk_check = Boolean(resolved.needs_risk_check);

  const check = validateFinalContract(resolved);
  if (!check.ok) {
    const fallbackContract = {
      features: normalizeFeatures(fallback.features, { minItems: 2, maxItems: 4 }),
      strategy: clampText(fallback.strategy, 700) || (normalizeLang(lang) === 'zh-CN'
        ? '先执行温和清洁、保湿、防晒三步，避免一次叠加多个变化。'
        : 'Use a gentle cleanse, moisturizer, and sunscreen baseline before additional changes.'),
      needs_risk_check: Boolean(fallback.needs_risk_check),
      primary_question: clampText(fallback.primary_question, 60),
      conditional_followups: normalizeFollowups(fallback.conditional_followups),
      routine_expert: clampText(fallback.routine_expert, 200),
    };
    while (fallbackContract.features.length < 2) {
      fallbackContract.features.push({
        observation: normalizeLang(lang) === 'zh-CN' ? '当前建议基于有限信息，请先按保守方案执行。' : 'Current guidance is conservative due to limited evidence.',
        confidence: 'somewhat_sure',
      });
    }
    if (!fallbackContract.primary_question) fallbackContract.primary_question = '';
    if (!fallbackContract.routine_expert) fallbackContract.routine_expert = '';
    fallbackContract.conditional_followups = normalizeFollowups(fallbackContract.conditional_followups);
    return {
      ...fallbackContract,
      ask_3_questions: deriveAsk3Questions(fallbackContract.primary_question, fallbackContract.conditional_followups),
      __contract_fallback: true,
      __contract_errors: check.errors,
    };
  }

  return {
    ...resolved,
    ask_3_questions: deriveAsk3Questions(resolved.primary_question, resolved.conditional_followups),
    __contract_fallback: false,
    __contract_errors: [],
  };
}

function mergeFinalContractIntoAnalysis({ analysis, finalContract } = {}) {
  const base = analysis && typeof analysis === 'object' && !Array.isArray(analysis) ? { ...analysis } : {};
  const contract = finalContract && typeof finalContract === 'object' ? finalContract : {};
  return {
    ...base,
    features: Array.isArray(contract.features) ? contract.features : [],
    strategy: typeof contract.strategy === 'string' ? contract.strategy : '',
    needs_risk_check: Boolean(contract.needs_risk_check),
    primary_question: typeof contract.primary_question === 'string' ? contract.primary_question : '',
    conditional_followups: Array.isArray(contract.conditional_followups) ? contract.conditional_followups : [],
    routine_expert: typeof contract.routine_expert === 'string' ? contract.routine_expert : '',
    ask_3_questions: Array.isArray(contract.ask_3_questions) ? contract.ask_3_questions : deriveAsk3Questions('', []),
  };
}

module.exports = {
  CONFIDENCE_VALUES,
  SkinFinalContractSchema,
  SkinVisionObservationSchema,
  SkinReportStrategySchema,
  validateFinalContract,
  validateVisionObservation,
  validateReportStrategy,
  mapQualityToMode,
  buildPoorPhotoTemplate,
  buildFactLayer,
  deriveAsk3Questions,
  finalizeSkinAnalysisContract,
  mergeFinalContractIntoAnalysis,
};
