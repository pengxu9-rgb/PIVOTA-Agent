const CONFIDENCE_VALUES = Object.freeze(['pretty_sure', 'somewhat_sure', 'not_sure']);
const DEEPENING_PHASE_VALUES = Object.freeze(['photo_optin', 'products', 'reactions', 'refined']);

const EvidenceRefItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', maxLength: 40 },
    title: { type: 'string', maxLength: 120 },
    url: { type: 'string', maxLength: 300 },
    why_relevant: { type: 'string', maxLength: 220 },
  },
  required: ['id', 'title', 'url'],
};

const DeepeningSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    phase: { type: 'string', enum: DEEPENING_PHASE_VALUES.slice() },
    next_phase: { type: 'string', enum: DEEPENING_PHASE_VALUES.slice() },
    question: { type: 'string', maxLength: 180 },
    options: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string', maxLength: 80 },
    },
  },
};

const SkinFeatureItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    observation: { type: 'string', maxLength: 120 },
    confidence: { type: 'string', enum: CONFIDENCE_VALUES.slice() },
  },
  required: ['observation', 'confidence'],
};

const ObservationConfidenceValues = Object.freeze(['low', 'med', 'high']);
const ObservationSeverityValues = Object.freeze(['mild', 'moderate', 'high']);

const ObservationItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cue: { type: 'string', maxLength: 60 },
    where: { type: 'string', maxLength: 60 },
    severity: { type: 'string', enum: ObservationSeverityValues.slice() },
    confidence: { type: 'string', enum: ObservationConfidenceValues.slice() },
    evidence: { type: 'string', maxLength: 220 },
  },
  required: ['cue', 'where', 'severity', 'confidence', 'evidence'],
};

const FindingItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cue: { type: 'string', maxLength: 60 },
    where: { type: 'string', maxLength: 60 },
    severity: { type: 'string', enum: ObservationSeverityValues.slice() },
    confidence: { type: 'string', enum: ObservationConfidenceValues.slice() },
    evidence: { type: 'string', maxLength: 220 },
  },
  required: ['cue', 'where', 'severity', 'confidence', 'evidence'],
};

const QualityInfoSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    grade: { type: 'string', enum: ['pass', 'degraded', 'fail'] },
    message: { type: 'string', maxLength: 220 },
    issues: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string', maxLength: 80 },
    },
    confidence_penalty: { type: 'number' },
    factors: {
      type: 'object',
      additionalProperties: true,
      properties: {
        blur: { type: 'number' },
        exposure: { type: 'number' },
        wb: { type: 'number' },
        coverage: { type: 'number' },
      },
    },
  },
};

const NextStepOptionSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string', maxLength: 80 },
    label: { type: 'string', maxLength: 80 },
  },
  required: ['id', 'label'],
};

const RoutineExpertSchema = {
  anyOf: [
    { type: 'string', maxLength: 1200 },
    { type: 'object', additionalProperties: true },
  ],
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
    routine_expert: RoutineExpertSchema,
    reasoning: {
      type: 'array',
      maxItems: 4,
      items: { type: 'string', maxLength: 220 },
    },
    deepening: DeepeningSchema,
    evidence_refs: {
      type: 'array',
      maxItems: 6,
      items: EvidenceRefItemSchema,
    },
    quality: QualityInfoSchema,
    findings: {
      type: 'array',
      maxItems: 8,
      items: FindingItemSchema,
    },
    guidance_brief: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', maxLength: 220 },
    },
    insufficient_visual_detail: { type: 'boolean' },
    next_step_options: {
      type: 'array',
      maxItems: 3,
      items: NextStepOptionSchema,
    },
    two_week_focus: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', maxLength: 220 },
    },
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
    quality_note: {
      anyOf: [{ type: 'string', maxLength: 180 }, { type: 'null' }],
    },
    observations: {
      type: 'array',
      maxItems: 10,
      items: ObservationItemSchema,
    },
    limits: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string', maxLength: 180 },
    },
  },
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
    routine_expert: RoutineExpertSchema,
    reasoning: {
      type: 'array',
      maxItems: 4,
      items: { type: 'string', maxLength: 220 },
    },
    deepening: DeepeningSchema,
    evidence_refs: {
      type: 'array',
      maxItems: 6,
      items: EvidenceRefItemSchema,
    },
    quality: QualityInfoSchema,
    findings: {
      type: 'array',
      maxItems: 8,
      items: FindingItemSchema,
    },
    guidance_brief: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', maxLength: 220 },
    },
    insufficient_visual_detail: { type: 'boolean' },
    next_step_options: {
      type: 'array',
      maxItems: 3,
      items: NextStepOptionSchema,
    },
    two_week_focus: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', maxLength: 220 },
    },
  },
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

function normalizeObservationConfidence(raw) {
  const token = String(raw || '').trim().toLowerCase();
  if (token === 'low' || token === 'med' || token === 'high') return token;
  return 'med';
}

function normalizeObservationSeverity(raw) {
  const token = String(raw || '').trim().toLowerCase();
  if (token === 'mild' || token === 'moderate' || token === 'high') return token;
  return 'mild';
}

function normalizeObservations(raw, { maxItems = 8 } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const cue = clampText(row.cue, 60);
    const where = clampText(row.where, 60);
    const evidence = clampText(row.evidence, 220);
    if (!cue || !where || !evidence) continue;
    out.push({
      cue,
      where,
      severity: normalizeObservationSeverity(row.severity),
      confidence: normalizeObservationConfidence(row.confidence),
      evidence,
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

function mapObservationConfidenceToLegacy(raw) {
  const value = normalizeObservationConfidence(raw);
  if (value === 'high') return 'pretty_sure';
  if (value === 'low') return 'not_sure';
  return 'somewhat_sure';
}

function observationsToLegacyFeatures(observations, { maxItems = 4 } = {}) {
  const list = Array.isArray(observations) ? observations : [];
  const mapped = list
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const cue = clampText(row.cue, 40);
      const where = clampText(row.where, 40);
      const evidence = clampText(row.evidence, 120);
      if (!cue || !where || !evidence) return null;
      return {
        observation: clampText(`${cue} on ${where}: ${evidence}`, 120),
        confidence: mapObservationConfidenceToLegacy(row.confidence),
      };
    })
    .filter(Boolean)
    .slice(0, maxItems);
  return normalizeFeatures(mapped, { minItems: 2, maxItems });
}

function normalizeFindings(raw) {
  return normalizeObservations(raw, { maxItems: 8 });
}

function normalizeGuidanceBrief(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of list) {
    const line = clampText(row, 220);
    if (!line) continue;
    out.push(line);
    if (out.length >= 5) break;
  }
  return out;
}

function normalizeTwoWeekFocus(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of list) {
    const line = clampText(row, 220);
    if (!line) continue;
    out.push(line);
    if (out.length >= 3) break;
  }
  return out;
}

function normalizeNextStepOptions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = clampText(row.id, 80);
    const label = clampText(row.label, 80);
    if (!id || !label) continue;
    out.push({ id, label });
    if (out.length >= 3) break;
  }
  return out;
}

function normalizeQualityInfo(raw) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!p) return null;
  const gradeRaw = String(p.grade || '').trim().toLowerCase();
  const grade = gradeRaw === 'pass' || gradeRaw === 'degraded' || gradeRaw === 'fail' ? gradeRaw : '';
  if (!grade) return null;
  const issues = normalizeGuidanceBrief(p.issues).map((item) => clampText(item, 80)).slice(0, 6);
  const message = clampText(p.message, 220);
  const factorsNode = p.factors && typeof p.factors === 'object' && !Array.isArray(p.factors) ? p.factors : null;
  const factors = factorsNode
    ? {
        blur: Number.isFinite(Number(factorsNode.blur)) ? Number(factorsNode.blur) : null,
        exposure: Number.isFinite(Number(factorsNode.exposure)) ? Number(factorsNode.exposure) : null,
        wb: Number.isFinite(Number(factorsNode.wb)) ? Number(factorsNode.wb) : null,
        coverage: Number.isFinite(Number(factorsNode.coverage)) ? Number(factorsNode.coverage) : null,
      }
    : null;
  const confidencePenalty = Number.isFinite(Number(p.confidence_penalty)) ? Number(p.confidence_penalty) : undefined;
  return {
    grade,
    ...(message ? { message } : {}),
    ...(issues.length ? { issues } : {}),
    ...(typeof confidencePenalty === 'number' ? { confidence_penalty: confidencePenalty } : {}),
    ...(factors ? { factors } : {}),
  };
}

function normalizeRoutineExpert(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const text = clampText(raw, 1200);
  return text || '';
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

function normalizeReasoning(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const text = clampText(item, 220);
    if (!text) continue;
    out.push(text);
    if (out.length >= 4) break;
  }
  return out;
}

function normalizeEvidenceRefs(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = clampText(item.id, 40);
    const title = clampText(item.title, 120);
    const url = clampText(item.url, 300);
    const whyRelevant = clampText(item.why_relevant, 220);
    if (!id || !title || !url) continue;
    out.push({
      id,
      title,
      url,
      ...(whyRelevant ? { why_relevant: whyRelevant } : {}),
    });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeDeepening(raw) {
  const node = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!node) return null;
  const phase = clampText(node.phase, 30).toLowerCase();
  const nextPhase = clampText(node.next_phase, 30).toLowerCase();
  const question = clampText(node.question, 180);
  const options = [];
  for (const item of Array.isArray(node.options) ? node.options : []) {
    const text = clampText(item, 80);
    if (!text) continue;
    options.push(text);
    if (options.length >= 8) break;
  }
  const normalized = {};
  if (DEEPENING_PHASE_VALUES.includes(phase)) normalized.phase = phase;
  if (DEEPENING_PHASE_VALUES.includes(nextPhase)) normalized.next_phase = nextPhase;
  if (question) normalized.question = question;
  if (options.length) normalized.options = options;
  return Object.keys(normalized).length ? normalized : null;
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

function validateStringArray(value, { path, maxItems, maxLen }) {
  const errors = [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be array`);
    return errors;
  }
  if (value.length > maxItems) errors.push(`${path} max ${maxItems} items`);
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== 'string') errors.push(`${path}/${i} must be string`);
    if (typeof item === 'string' && item.length > maxLen) errors.push(`${path}/${i} exceeds ${maxLen} chars`);
  }
  return errors;
}

function validateObservationArray(observations, { path = '/observations', max = 8 } = {}) {
  const errors = [];
  if (!Array.isArray(observations)) {
    errors.push(`${path} must be array`);
    return errors;
  }
  if (observations.length > max) errors.push(`${path} max ${max} items`);
  for (let i = 0; i < observations.length; i += 1) {
    const item = observations[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${path}/${i} must be object`);
      continue;
    }
    if (typeof item.cue !== 'string' || !item.cue.trim()) errors.push(`${path}/${i}/cue must be non-empty string`);
    if (typeof item.where !== 'string' || !item.where.trim()) errors.push(`${path}/${i}/where must be non-empty string`);
    if (typeof item.evidence !== 'string' || !item.evidence.trim()) errors.push(`${path}/${i}/evidence must be non-empty string`);
    if (!ObservationSeverityValues.includes(String(item.severity || '').trim().toLowerCase())) errors.push(`${path}/${i}/severity invalid`);
    if (!ObservationConfidenceValues.includes(String(item.confidence || '').trim().toLowerCase())) errors.push(`${path}/${i}/confidence invalid`);
    if (typeof item.cue === 'string' && item.cue.length > 60) errors.push(`${path}/${i}/cue exceeds 60 chars`);
    if (typeof item.where === 'string' && item.where.length > 60) errors.push(`${path}/${i}/where exceeds 60 chars`);
    if (typeof item.evidence === 'string' && item.evidence.length > 220) errors.push(`${path}/${i}/evidence exceeds 220 chars`);
  }
  return errors;
}

function validateQualityNode(node, { path = '/quality' } = {}) {
  const errors = [];
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${path} must be object`);
    return errors;
  }
  const grade = String(node.grade || '').trim().toLowerCase();
  if (grade !== 'pass' && grade !== 'degraded' && grade !== 'fail') {
    errors.push(`${path}/grade invalid`);
  }
  if (node.message != null && (typeof node.message !== 'string' || node.message.length > 220)) {
    errors.push(`${path}/message invalid`);
  }
  if (node.issues != null && !Array.isArray(node.issues)) errors.push(`${path}/issues must be array`);
  if (Array.isArray(node.issues)) {
    if (node.issues.length > 6) errors.push(`${path}/issues max 6 items`);
    for (let i = 0; i < node.issues.length; i += 1) {
      const issue = node.issues[i];
      if (typeof issue !== 'string') errors.push(`${path}/issues/${i} must be string`);
      if (typeof issue === 'string' && issue.length > 80) errors.push(`${path}/issues/${i} exceeds 80 chars`);
    }
  }
  return errors;
}

function validateRoutineExpertValue(value, { path = '/routine_expert' } = {}) {
  if (typeof value === 'string') {
    if (value.length > 1200) return [`${path} exceeds 1200 chars`];
    return [];
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return [];
  return [`${path} must be string or object`];
}

function validateNextStepOptions(value, { path = '/next_step_options' } = {}) {
  const errors = [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be array`);
    return errors;
  }
  if (value.length > 3) errors.push(`${path} max 3 items`);
  for (let i = 0; i < value.length; i += 1) {
    const row = value[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${path}/${i} must be object`);
      continue;
    }
    if (typeof row.id !== 'string' || !row.id.trim()) errors.push(`${path}/${i}/id must be non-empty string`);
    if (typeof row.label !== 'string' || !row.label.trim()) errors.push(`${path}/${i}/label must be non-empty string`);
    if (typeof row.id === 'string' && row.id.length > 80) errors.push(`${path}/${i}/id exceeds 80 chars`);
    if (typeof row.label === 'string' && row.label.length > 80) errors.push(`${path}/${i}/label exceeds 80 chars`);
  }
  return errors;
}

function validateVisionObservation(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const errors = [];
  if (!p) return { ok: false, errors: ['/ must be object'] };
  const allowed = new Set(['features', 'needs_risk_check', 'quality_note', 'observations', 'limits']);
  for (const key of Object.keys(p)) {
    if (!allowed.has(key)) errors.push(`/${key} is not allowed`);
  }

  const hasLegacyShape = Array.isArray(p.features) || typeof p.needs_risk_check === 'boolean';
  const hasNewShape = Array.isArray(p.observations) || p.quality_note != null || p.limits != null;
  if (!hasLegacyShape && !hasNewShape) {
    errors.push('/ must include either legacy (features/needs_risk_check) or new (observations) fields');
  }

  if (Array.isArray(p.features) || p.features != null) {
    errors.push(...validateFeatureArray(p.features, { min: 1, max: 4, path: '/features' }));
  }
  if (p.needs_risk_check != null && typeof p.needs_risk_check !== 'boolean') {
    errors.push('/needs_risk_check must be boolean');
  }
  if (p.quality_note != null && p.quality_note !== null && (typeof p.quality_note !== 'string' || p.quality_note.length > 180)) {
    errors.push('/quality_note invalid');
  }
  if (p.observations != null) {
    errors.push(...validateObservationArray(p.observations, { path: '/observations', max: 10 }));
  }
  if (p.limits != null) {
    errors.push(...validateStringArray(p.limits, { path: '/limits', maxItems: 6, maxLen: 180 }));
  }

  return { ok: errors.length === 0, errors };
}

function validateReportStrategy(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const errors = [];
  if (!p) return { ok: false, errors: ['/ must be object'] };
  const allowed = new Set([
    'features',
    'strategy',
    'needs_risk_check',
    'primary_question',
    'conditional_followups',
    'routine_expert',
    'reasoning',
    'deepening',
    'evidence_refs',
    'quality',
    'findings',
    'guidance_brief',
    'insufficient_visual_detail',
    'next_step_options',
    'two_week_focus',
  ]);
  for (const key of Object.keys(p)) {
    if (!allowed.has(key)) errors.push(`/${key} is not allowed`);
  }

  const hasLegacyFields =
    Array.isArray(p.features) ||
    typeof p.strategy === 'string' ||
    typeof p.needs_risk_check === 'boolean' ||
    typeof p.primary_question === 'string' ||
    Array.isArray(p.conditional_followups) ||
    p.routine_expert != null;
  const hasNewFields =
    Array.isArray(p.findings) ||
    Array.isArray(p.guidance_brief) ||
    p.quality != null ||
    typeof p.insufficient_visual_detail === 'boolean' ||
    Array.isArray(p.next_step_options) ||
    Array.isArray(p.two_week_focus);
  if (!hasLegacyFields && !hasNewFields) {
    errors.push('/ must include either legacy strategy fields or new findings/quality fields');
  }

  if (p.features != null) {
    errors.push(...validateFeatureArray(p.features, { min: 1, max: 4, path: '/features' }));
  }
  if (p.strategy != null) {
    if (typeof p.strategy !== 'string' || !p.strategy.trim()) errors.push('/strategy must be non-empty string');
    if (typeof p.strategy === 'string' && p.strategy.length > 700) errors.push('/strategy exceeds 700 chars');
  }
  if (p.needs_risk_check != null && typeof p.needs_risk_check !== 'boolean') errors.push('/needs_risk_check must be boolean');
  if (p.primary_question != null && typeof p.primary_question !== 'string') errors.push('/primary_question must be string');
  if (typeof p.primary_question === 'string' && p.primary_question.length > 60) errors.push('/primary_question exceeds 60 chars');
  if (p.conditional_followups != null) {
    errors.push(...validateStringArray(p.conditional_followups, { path: '/conditional_followups', maxItems: 3, maxLen: 60 }));
  }
  if (p.routine_expert != null) {
    errors.push(...validateRoutineExpertValue(p.routine_expert, { path: '/routine_expert' }));
  }
  if (p.reasoning != null) {
    errors.push(...validateStringArray(p.reasoning, { path: '/reasoning', maxItems: 4, maxLen: 220 }));
  }
  if (p.deepening != null) {
    if (!p.deepening || typeof p.deepening !== 'object' || Array.isArray(p.deepening)) {
      errors.push('/deepening must be object');
    } else {
      if (p.deepening.phase != null) {
        const phase = String(p.deepening.phase || '').trim().toLowerCase();
        if (!DEEPENING_PHASE_VALUES.includes(phase)) errors.push('/deepening/phase invalid');
      }
      if (p.deepening.next_phase != null) {
        const nextPhase = String(p.deepening.next_phase || '').trim().toLowerCase();
        if (!DEEPENING_PHASE_VALUES.includes(nextPhase)) errors.push('/deepening/next_phase invalid');
      }
      if (p.deepening.question != null && (typeof p.deepening.question !== 'string' || p.deepening.question.length > 180)) {
        errors.push('/deepening/question invalid');
      }
      if (p.deepening.options != null) {
        errors.push(...validateStringArray(p.deepening.options, { path: '/deepening/options', maxItems: 8, maxLen: 80 }));
      }
    }
  }
  if (p.evidence_refs != null && !Array.isArray(p.evidence_refs)) errors.push('/evidence_refs must be array');
  if (Array.isArray(p.evidence_refs)) {
    if (p.evidence_refs.length > 6) errors.push('/evidence_refs max 6 items');
    for (let i = 0; i < p.evidence_refs.length; i += 1) {
      const item = p.evidence_refs[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`/evidence_refs/${i} must be object`);
        continue;
      }
      if (typeof item.id !== 'string' || !item.id.trim()) errors.push(`/evidence_refs/${i}/id must be non-empty string`);
      if (typeof item.title !== 'string' || !item.title.trim()) errors.push(`/evidence_refs/${i}/title must be non-empty string`);
      if (typeof item.url !== 'string' || !item.url.trim()) errors.push(`/evidence_refs/${i}/url must be non-empty string`);
      if (typeof item.id === 'string' && item.id.length > 40) errors.push(`/evidence_refs/${i}/id exceeds 40 chars`);
      if (typeof item.title === 'string' && item.title.length > 120) errors.push(`/evidence_refs/${i}/title exceeds 120 chars`);
      if (typeof item.url === 'string' && item.url.length > 300) errors.push(`/evidence_refs/${i}/url exceeds 300 chars`);
      if (item.why_relevant != null && (typeof item.why_relevant !== 'string' || item.why_relevant.length > 220)) {
        errors.push(`/evidence_refs/${i}/why_relevant invalid`);
      }
    }
  }
  if (p.quality != null) {
    errors.push(...validateQualityNode(p.quality, { path: '/quality' }));
  }
  if (p.findings != null) {
    errors.push(...validateObservationArray(p.findings, { path: '/findings', max: 8 }));
  }
  if (p.guidance_brief != null) {
    errors.push(...validateStringArray(p.guidance_brief, { path: '/guidance_brief', maxItems: 5, maxLen: 220 }));
  }
  if (p.insufficient_visual_detail != null && typeof p.insufficient_visual_detail !== 'boolean') {
    errors.push('/insufficient_visual_detail must be boolean');
  }
  if (p.next_step_options != null) {
    errors.push(...validateNextStepOptions(p.next_step_options, { path: '/next_step_options' }));
  }
  if (p.two_week_focus != null) {
    errors.push(...validateStringArray(p.two_week_focus, { path: '/two_week_focus', maxItems: 3, maxLen: 220 }));
  }
  return { ok: errors.length === 0, errors };
}

function validateFinalContract(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  if (!p) return { ok: false, errors: ['/ must be object'] };
  const result = validateReportStrategy(p);
  const errors = result.errors.slice();

  if (!Array.isArray(p.features)) {
    errors.push('/features must be array');
  } else {
    errors.push(...validateFeatureArray(p.features, { min: 2, max: 4, path: '/features' }));
  }
  if (typeof p.strategy !== 'string' || !p.strategy.trim()) errors.push('/strategy must be non-empty string');
  if (typeof p.needs_risk_check !== 'boolean') errors.push('/needs_risk_check must be boolean');
  if (typeof p.primary_question !== 'string') errors.push('/primary_question must be string');
  if (!Array.isArray(p.conditional_followups)) errors.push('/conditional_followups must be array');
  if (p.routine_expert == null) errors.push('/routine_expert is required');

  return { ok: errors.length === 0, errors };
}

function normalizeVisionObservationLayer(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const observations = normalizeObservations(p.observations, { maxItems: 8 });
  const features = Array.isArray(p.features) && p.features.length
    ? normalizeFeatures(p.features, { minItems: 2, maxItems: 4 })
    : observationsToLegacyFeatures(observations, { maxItems: 4 });
  const limits = normalizeGuidanceBrief(p.limits).slice(0, 6).map((item) => clampText(item, 180));
  const qualityNoteRaw = p.quality_note;
  const qualityNote =
    qualityNoteRaw === null
      ? null
      : typeof qualityNoteRaw === 'string' && qualityNoteRaw.trim()
        ? clampText(qualityNoteRaw, 180)
        : undefined;
  const needsRiskCheck =
    typeof p.needs_risk_check === 'boolean'
      ? p.needs_risk_check
      : observations.some((row) => row.confidence === 'low');
  return {
    features: normalizeFeatures(features, { minItems: 2, maxItems: 4 }),
    needs_risk_check: Boolean(needsRiskCheck),
    ...(qualityNote !== undefined ? { quality_note: qualityNote } : {}),
    ...(observations.length ? { observations } : {}),
    ...(limits.length ? { limits } : {}),
  };
}

function normalizeReportStrategyLayer(payload, { lang } = {}) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const locale = normalizeLang(lang);
  const defaultStrategy =
    locale === 'zh-CN'
      ? '先执行温和清洁、保湿、防晒三步，避免一次叠加多个变化。'
      : 'Use a gentle cleanse, moisturizer, and sunscreen baseline before additional changes.';
  const features = Array.isArray(p.features) ? normalizeFeatures(p.features, { minItems: 2, maxItems: 4 }) : undefined;
  const strategy = clampText(p.strategy, 700) || defaultStrategy;
  const needsRiskCheck = typeof p.needs_risk_check === 'boolean' ? p.needs_risk_check : false;
  const primaryQuestion = clampText(p.primary_question, 60);
  const conditionalFollowups = normalizeFollowups(p.conditional_followups);
  const routineExpert = normalizeRoutineExpert(p.routine_expert);
  const reasoning = normalizeReasoning(p.reasoning);
  const deepening = normalizeDeepening(p.deepening);
  const evidenceRefs = normalizeEvidenceRefs(p.evidence_refs);
  const quality = normalizeQualityInfo(p.quality);
  const findings = normalizeFindings(p.findings);
  const guidanceBrief = normalizeGuidanceBrief(p.guidance_brief);
  const nextStepOptions = normalizeNextStepOptions(p.next_step_options);
  const twoWeekFocus = normalizeTwoWeekFocus(p.two_week_focus);
  const insufficientVisualDetail = typeof p.insufficient_visual_detail === 'boolean' ? p.insufficient_visual_detail : undefined;

  return {
    ...(features ? { features } : {}),
    strategy,
    needs_risk_check: Boolean(needsRiskCheck),
    primary_question: primaryQuestion,
    conditional_followups: conditionalFollowups,
    routine_expert: routineExpert,
    ...(reasoning.length ? { reasoning } : {}),
    ...(deepening ? { deepening } : {}),
    ...(evidenceRefs.length ? { evidence_refs: evidenceRefs } : {}),
    ...(quality ? { quality } : {}),
    ...(findings.length ? { findings } : {}),
    ...(guidanceBrief.length ? { guidance_brief: guidanceBrief } : {}),
    ...(typeof insufficientVisualDetail === 'boolean' ? { insufficient_visual_detail: insufficientVisualDetail } : {}),
    ...(nextStepOptions.length ? { next_step_options: nextStepOptions } : {}),
    ...(twoWeekFocus.length ? { two_week_focus: twoWeekFocus } : {}),
  };
}

function buildFactLayer({ deterministicAnalysis, visionLayer } = {}) {
  const deterministic = deterministicAnalysis && typeof deterministicAnalysis === 'object' ? deterministicAnalysis : {};
  const vision = visionLayer && typeof visionLayer === 'object' ? visionLayer : null;

  const deterministicFeatures = normalizeFeatures(deterministic.features, { minItems: 2, maxItems: 4 });
  const visionFeatures = vision
    ? Array.isArray(vision.features) && vision.features.length
      ? normalizeFeatures(vision.features, { minItems: 2, maxItems: 4 })
      : observationsToLegacyFeatures(vision.observations, { maxItems: 4 })
    : [];

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
    routine_expert: normalizeRoutineExpert(report.routine_expert != null ? report.routine_expert : fallback.routine_expert),
    reasoning: normalizeReasoning(report.reasoning || fallback.reasoning),
    deepening: normalizeDeepening(report.deepening || fallback.deepening),
    evidence_refs: normalizeEvidenceRefs(report.evidence_refs || fallback.evidence_refs),
    quality: normalizeQualityInfo(report.quality || fallback.quality),
    findings: normalizeFindings(report.findings || fallback.findings),
    guidance_brief: normalizeGuidanceBrief(report.guidance_brief || fallback.guidance_brief),
    next_step_options: normalizeNextStepOptions(report.next_step_options || fallback.next_step_options),
    two_week_focus: normalizeTwoWeekFocus(report.two_week_focus || fallback.two_week_focus),
    insufficient_visual_detail:
      typeof (report.insufficient_visual_detail != null ? report.insufficient_visual_detail : fallback.insufficient_visual_detail) === 'boolean'
        ? Boolean(report.insufficient_visual_detail != null ? report.insufficient_visual_detail : fallback.insufficient_visual_detail)
        : undefined,
  };

  const resolved = isPoor ? buildPoorPhotoTemplate({ lang }) : safeBase;

  if (!resolved.strategy) {
    resolved.strategy = normalizeLang(lang) === 'zh-CN'
      ? 'AM: 温和清洁 + 保湿 + 防晒。PM: 温和清洁 + 保湿。Frequency: 一次只调整一个变量。If irritation: 出现持续刺激时立即回退到基础护理。'
      : 'AM: gentle cleanse + moisturizer + sunscreen. PM: gentle cleanse + moisturizer. Frequency: adjust one variable at a time. If irritation: revert to basic care immediately.';
  }

  if (!resolved.primary_question) resolved.primary_question = '';
  if (!Array.isArray(resolved.conditional_followups)) resolved.conditional_followups = [];
  if (resolved.routine_expert == null || (!resolved.routine_expert && typeof resolved.routine_expert === 'string')) {
    resolved.routine_expert = '';
  }
  if (!Array.isArray(resolved.reasoning)) resolved.reasoning = [];
  if (!Array.isArray(resolved.evidence_refs)) resolved.evidence_refs = [];

  resolved.features = normalizeFeatures(resolved.features, { minItems: 2, maxItems: 4, conservative: isPoor });
  resolved.conditional_followups = normalizeFollowups(resolved.conditional_followups);
  resolved.strategy = clampText(resolved.strategy, 700);
  resolved.primary_question = clampText(resolved.primary_question, 60);
  resolved.routine_expert = normalizeRoutineExpert(resolved.routine_expert);
  resolved.reasoning = normalizeReasoning(resolved.reasoning);
  resolved.deepening = normalizeDeepening(resolved.deepening);
  resolved.evidence_refs = normalizeEvidenceRefs(resolved.evidence_refs);
  resolved.quality = normalizeQualityInfo(resolved.quality);
  resolved.findings = normalizeFindings(resolved.findings);
  resolved.guidance_brief = normalizeGuidanceBrief(resolved.guidance_brief);
  resolved.next_step_options = normalizeNextStepOptions(resolved.next_step_options);
  resolved.two_week_focus = normalizeTwoWeekFocus(resolved.two_week_focus);
  if (resolved.insufficient_visual_detail != null) {
    resolved.insufficient_visual_detail = Boolean(resolved.insufficient_visual_detail);
  }
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
      routine_expert: normalizeRoutineExpert(fallback.routine_expert),
      reasoning: normalizeReasoning(fallback.reasoning),
      deepening: normalizeDeepening(fallback.deepening),
      evidence_refs: normalizeEvidenceRefs(fallback.evidence_refs),
      quality: normalizeQualityInfo(fallback.quality),
      findings: normalizeFindings(fallback.findings),
      guidance_brief: normalizeGuidanceBrief(fallback.guidance_brief),
      next_step_options: normalizeNextStepOptions(fallback.next_step_options),
      two_week_focus: normalizeTwoWeekFocus(fallback.two_week_focus),
      ...(typeof fallback.insufficient_visual_detail === 'boolean'
        ? { insufficient_visual_detail: Boolean(fallback.insufficient_visual_detail) }
        : {}),
    };
    while (fallbackContract.features.length < 2) {
      fallbackContract.features.push({
        observation: normalizeLang(lang) === 'zh-CN' ? '当前建议基于有限信息，请先按保守方案执行。' : 'Current guidance is conservative due to limited evidence.',
        confidence: 'somewhat_sure',
      });
    }
    if (!fallbackContract.primary_question) fallbackContract.primary_question = '';
    if (fallbackContract.routine_expert == null) fallbackContract.routine_expert = '';
    fallbackContract.conditional_followups = normalizeFollowups(fallbackContract.conditional_followups);
    fallbackContract.reasoning = normalizeReasoning(fallbackContract.reasoning);
    fallbackContract.deepening = normalizeDeepening(fallbackContract.deepening);
    fallbackContract.evidence_refs = normalizeEvidenceRefs(fallbackContract.evidence_refs);
    fallbackContract.quality = normalizeQualityInfo(fallbackContract.quality);
    fallbackContract.findings = normalizeFindings(fallbackContract.findings);
    fallbackContract.guidance_brief = normalizeGuidanceBrief(fallbackContract.guidance_brief);
    fallbackContract.next_step_options = normalizeNextStepOptions(fallbackContract.next_step_options);
    fallbackContract.two_week_focus = normalizeTwoWeekFocus(fallbackContract.two_week_focus);
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
  const routineExpert =
    typeof contract.routine_expert === 'string' ||
    (contract.routine_expert && typeof contract.routine_expert === 'object' && !Array.isArray(contract.routine_expert))
      ? contract.routine_expert
      : '';
  return {
    ...base,
    features: Array.isArray(contract.features) ? contract.features : [],
    strategy: typeof contract.strategy === 'string' ? contract.strategy : '',
    needs_risk_check: Boolean(contract.needs_risk_check),
    primary_question: typeof contract.primary_question === 'string' ? contract.primary_question : '',
    conditional_followups: Array.isArray(contract.conditional_followups) ? contract.conditional_followups : [],
    routine_expert: routineExpert,
    ask_3_questions: Array.isArray(contract.ask_3_questions) ? contract.ask_3_questions : deriveAsk3Questions('', []),
    reasoning: Array.isArray(contract.reasoning) ? contract.reasoning : [],
    deepening: contract.deepening && typeof contract.deepening === 'object' && !Array.isArray(contract.deepening) ? contract.deepening : null,
    evidence_refs: Array.isArray(contract.evidence_refs) ? contract.evidence_refs : [],
    quality: contract.quality && typeof contract.quality === 'object' && !Array.isArray(contract.quality) ? contract.quality : base.quality,
    findings: Array.isArray(contract.findings) ? contract.findings : Array.isArray(base.findings) ? base.findings : [],
    guidance_brief:
      Array.isArray(contract.guidance_brief) ? contract.guidance_brief : Array.isArray(base.guidance_brief) ? base.guidance_brief : [],
    insufficient_visual_detail:
      typeof contract.insufficient_visual_detail === 'boolean'
        ? contract.insufficient_visual_detail
        : typeof base.insufficient_visual_detail === 'boolean'
          ? base.insufficient_visual_detail
          : undefined,
    next_step_options:
      Array.isArray(contract.next_step_options)
        ? contract.next_step_options
        : Array.isArray(base.next_step_options)
          ? base.next_step_options
          : [],
    two_week_focus:
      Array.isArray(contract.two_week_focus)
        ? contract.two_week_focus
        : Array.isArray(base.two_week_focus)
          ? base.two_week_focus
          : [],
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
  normalizeVisionObservationLayer,
  normalizeReportStrategyLayer,
};
