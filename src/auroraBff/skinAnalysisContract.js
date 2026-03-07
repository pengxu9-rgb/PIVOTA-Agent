const CONFIDENCE_VALUES = Object.freeze(['pretty_sure', 'somewhat_sure', 'not_sure']);
const DEEPENING_PHASE_VALUES = Object.freeze(['photo_optin', 'products', 'reactions', 'refined']);

const EvidenceRefItemSchema = {
  type: 'object',
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
  properties: {
    observation: { type: 'string', maxLength: 120 },
    confidence: { type: 'string', enum: CONFIDENCE_VALUES.slice() },
  },
  required: ['observation', 'confidence'],
};

const ObservationConfidenceValues = Object.freeze(['low', 'med', 'high']);
const ObservationSeverityValues = Object.freeze(['mild', 'moderate', 'high']);
const VisionVisibilityValues = Object.freeze(['sufficient', 'limited', 'insufficient']);
const VisionInsufficientReasonValues = Object.freeze([
  'blur',
  'lighting',
  'occlusion',
  'face_not_visible',
  'resolution_low',
  'no_clear_cue',
  'mixed',
]);
const CanonicalCueValues = Object.freeze(['redness', 'shine', 'bumps', 'flaking', 'uneven_tone', 'texture', 'pores']);
const CanonicalRegionValues = Object.freeze(['cheeks', 'forehead', 't_zone', 'chin', 'nose', 'jawline', 'full_face']);
const SummaryPriorityValues = Object.freeze(['barrier', 'redness', 'oiliness', 'texture', 'tone', 'bumps', 'pores', 'mixed']);
const RoutineTimeValues = Object.freeze(['am', 'pm', 'either']);
const RoutineStepTypeValues = Object.freeze(['cleanse', 'hydrate', 'moisturize', 'protect', 'treat', 'pause', 'monitor']);
const RoutineTargetValues = Object.freeze(['barrier', 'redness', 'oiliness', 'texture', 'tone', 'bumps', 'pores', 'mixed']);
const RoutineCadenceValues = Object.freeze(['daily', 'every_other_night', 'two_nights_weekly', 'hold', 'as_needed']);
const RoutineIntensityValues = Object.freeze(['gentle', 'barrier_safe', 'low_frequency', 'standard']);
const WatchoutValues = Object.freeze([
  'avoid_stacking_strong_actives',
  'pause_if_stinging',
  'protect_barrier',
  'protect_uv',
  'one_change_at_a_time',
  'retake_clear_photo',
]);
const TwoWeekFocusValues = Object.freeze([
  'stabilize_barrier',
  'track_redness',
  'track_oil',
  'track_bumps',
  'track_texture',
  'track_tone',
  'confirm_tolerance',
]);
const FollowUpIntentValues = Object.freeze([
  'priority_symptom',
  'routine_share',
  'reaction_check',
  'tolerance_check',
  'photo_upload',
  'confirm_plan',
]);
const RiskFlagValues = Object.freeze([
  'monitor_persistent_redness',
  'monitor_stinging',
  'monitor_new_breakouts',
  'retake_photo',
]);
const DeepeningAdviceValues = Object.freeze([...WatchoutValues, ...TwoWeekFocusValues]);

const ObservationItemSchema = {
  type: 'object',
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
  properties: {
    id: { type: 'string', maxLength: 80 },
    label: { type: 'string', maxLength: 80 },
  },
  required: ['id', 'label'],
};

const RoutineExpertSchema = {
  type: 'string',
  maxLength: 1200,
};

const SkinFinalContractSchema = {
  type: 'object',
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

const SkinVisionGatewaySchema = {
  type: 'object',
  properties: {
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

const CanonicalObservationItemSchema = {
  type: 'object',
  properties: {
    cue: { type: 'string', enum: CanonicalCueValues.slice(), description: 'Canonical cue enum grounded in visible skin signal.' },
    region: { type: 'string', enum: CanonicalRegionValues.slice(), description: 'Canonical facial region enum.' },
    severity: { type: 'string', enum: ObservationSeverityValues.slice(), description: 'Observed severity band for the visible cue.' },
    confidence: { type: 'string', enum: ObservationConfidenceValues.slice(), description: 'Model confidence for the visible cue.' },
    evidence: { type: 'string', maxLength: 220, description: 'Short English evidence phrase describing the visible cue.' },
  },
  required: ['cue', 'region', 'severity', 'confidence', 'evidence'],
};

const SkinVisionCanonicalSchema = {
  type: 'object',
  properties: {
    visibility_status: {
      type: 'string',
      enum: VisionVisibilityValues.slice(),
      description: 'Whether the image supports grounded cue extraction: sufficient, limited, or insufficient.',
    },
    insufficient_reason: {
      type: 'string',
      enum: VisionInsufficientReasonValues.slice(),
      description: 'Required when visibility_status is insufficient.',
    },
    needs_risk_check: {
      type: 'boolean',
      description: 'True only when the image suggests caution, not medical diagnosis.',
    },
    quality_note: {
      type: 'string',
      maxLength: 180,
      description: 'Optional English note describing the image quality constraint in one sentence.',
    },
    observations: {
      type: 'array',
      maxItems: 8,
      items: CanonicalObservationItemSchema,
      description: 'Distinct visible cosmetic cues grounded in the image.',
    },
    limits: {
      type: 'array',
      maxItems: 4,
      items: { type: 'string', maxLength: 120 },
      description: 'Optional short English limit notes.',
    },
  },
  required: ['visibility_status', 'needs_risk_check', 'observations'],
};

const CanonicalSummaryFocusSchema = {
  type: 'object',
  properties: {
    priority: { type: 'string', enum: SummaryPriorityValues.slice(), description: 'Primary skincare focus priority.' },
    primary_cues: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', enum: CanonicalCueValues.slice() },
      description: 'Cue enums driving the current plan.',
    },
  },
  required: ['priority', 'primary_cues'],
};

const CanonicalRoutineStepSchema = {
  type: 'object',
  properties: {
    time: { type: 'string', enum: RoutineTimeValues.slice(), description: 'Routine timing bucket.' },
    step_type: { type: 'string', enum: RoutineStepTypeValues.slice(), description: 'Canonical routine step category.' },
    target: { type: 'string', enum: RoutineTargetValues.slice(), description: 'Primary routine target for this step.' },
    cadence: { type: 'string', enum: RoutineCadenceValues.slice(), description: 'How often this step should be used.' },
    intensity: { type: 'string', enum: RoutineIntensityValues.slice(), description: 'How conservative the step should be.' },
    linked_cues: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', enum: CanonicalCueValues.slice() },
      description: 'Cue enums directly supporting this step.',
    },
  },
  required: ['time', 'step_type', 'target', 'cadence', 'intensity', 'linked_cues'],
};

const CanonicalFollowUpSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: FollowUpIntentValues.slice(), description: 'Next-question intent for deterministic rendering.' },
    conditional_followups: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', enum: FollowUpIntentValues.slice() },
      description: 'Optional additional follow-up intents.',
    },
  },
  required: ['intent'],
};

const CanonicalDeepeningSchema = {
  type: 'object',
  properties: {
    phase: { type: 'string', enum: DEEPENING_PHASE_VALUES.slice(), description: 'Conversation phase for deepening.' },
    summary_priority: { type: 'string', enum: SummaryPriorityValues.slice(), description: 'Top skin focus for the phase.' },
    advice_items: {
      type: 'array',
      maxItems: 4,
      items: { type: 'string', enum: DeepeningAdviceValues.slice() },
      description: 'Structured advice items that deterministic renderer turns into prose.',
    },
    question_intent: {
      type: 'string',
      enum: FollowUpIntentValues.slice(),
      description: 'Controls the deterministic deepening question and option set.',
    },
  },
  required: ['phase', 'summary_priority', 'advice_items', 'question_intent'],
};

const SkinReportCanonicalSchema = {
  type: 'object',
  properties: {
    needs_risk_check: { type: 'boolean', description: 'True when the plan should surface caution signals.' },
    summary_focus: CanonicalSummaryFocusSchema,
    insights: {
      type: 'array',
      maxItems: 6,
      items: CanonicalObservationItemSchema,
      description: 'Canonical visible insights that the plan must stay consistent with.',
    },
    routine_steps: {
      type: 'array',
      maxItems: 8,
      items: CanonicalRoutineStepSchema,
      description: 'Structured routine steps for deterministic locale rendering.',
    },
    watchouts: {
      type: 'array',
      maxItems: 4,
      items: { type: 'string', enum: WatchoutValues.slice() },
      description: 'Structured watchouts for deterministic rendering.',
    },
    follow_up: CanonicalFollowUpSchema,
    two_week_focus: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', enum: TwoWeekFocusValues.slice() },
      description: 'Structured two-week focus items.',
    },
    risk_flags: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', enum: RiskFlagValues.slice() },
      description: 'Structured caution flags.',
    },
    deepening: CanonicalDeepeningSchema,
  },
  required: ['needs_risk_check', 'summary_focus', 'insights', 'routine_steps', 'watchouts', 'follow_up', 'two_week_focus', 'risk_flags'],
};

const SkinReportCanonicalLlmSchema = {
  type: 'object',
  properties: {
    needs_risk_check: SkinReportCanonicalSchema.properties.needs_risk_check,
    summary_focus: SkinReportCanonicalSchema.properties.summary_focus,
    insights: SkinReportCanonicalSchema.properties.insights,
    routine_steps: SkinReportCanonicalSchema.properties.routine_steps,
    watchouts: SkinReportCanonicalSchema.properties.watchouts,
    follow_up: SkinReportCanonicalSchema.properties.follow_up,
    two_week_focus: SkinReportCanonicalSchema.properties.two_week_focus,
    risk_flags: SkinReportCanonicalSchema.properties.risk_flags,
  },
  required: SkinReportCanonicalSchema.required.slice(),
};

const SkinDeepeningCanonicalSchema = {
  type: 'object',
  properties: CanonicalDeepeningSchema.properties,
  required: CanonicalDeepeningSchema.required,
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

function normalizeEnumValue(raw, values, fallback) {
  const token = String(raw || '').trim().toLowerCase();
  if (values.includes(token)) return token;
  return fallback;
}

function normalizeEnumValueStrict(raw, values) {
  const token = String(raw || '').trim().toLowerCase();
  if (values.includes(token)) return token;
  return '';
}

const CUE_PRIORITY_ORDER = Object.freeze({
  redness: 70,
  bumps: 66,
  texture: 62,
  shine: 58,
  flaking: 56,
  uneven_tone: 52,
  pores: 48,
});

const REGION_PRIORITY_ORDER = Object.freeze({
  cheeks: 10,
  t_zone: 9,
  forehead: 8,
  chin: 7,
  nose: 6,
  jawline: 5,
  full_face: 4,
});

const ROUTINE_TIME_ORDER = Object.freeze({
  am: 1,
  pm: 2,
  either: 3,
});

const ROUTINE_STEP_ORDER = Object.freeze({
  cleanse: 1,
  hydrate: 2,
  moisturize: 3,
  protect: 4,
  treat: 5,
  monitor: 6,
  pause: 7,
});

const DEEPENING_ADVICE_ORDER = Object.freeze({
  protect_barrier: 1,
  one_change_at_a_time: 2,
  pause_if_stinging: 3,
  protect_uv: 4,
  confirm_tolerance: 5,
  stabilize_barrier: 6,
  track_redness: 7,
  track_oil: 8,
  track_bumps: 9,
  track_texture: 10,
  track_tone: 11,
  retake_clear_photo: 12,
});

const REPORT_PRIORITY_ORDER = Object.freeze(['barrier', 'redness', 'oiliness', 'bumps', 'texture', 'tone', 'pores', 'mixed']);

function normalizeCanonicalCueToken(raw) {
  const token = String(raw || '').trim().toLowerCase().replace(/[^a-z_]+/g, '_').replace(/^_+|_+$/g, '');
  if (token === 'oiliness') return 'shine';
  if (token === 'rough_texture') return 'texture';
  if (token === 'uneven_tone' || token === 'tone') return 'uneven_tone';
  return normalizeEnumValueStrict(token, CanonicalCueValues);
}

function normalizeCanonicalCue(raw) {
  return normalizeCanonicalCueToken(raw) || 'texture';
}

function normalizeCanonicalCueStrict(raw) {
  return normalizeCanonicalCueToken(raw);
}

function normalizeCanonicalRegionToken(raw) {
  const token = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_')
    .replace(/[^a-z_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (token === 't_zone' || token === 't') return 't_zone';
  if (token === 'fullface' || token === 'whole_face' || token === 'all_face') return 'full_face';
  if (token === 'jaw' || token === 'jaw_line') return 'jawline';
  return normalizeEnumValueStrict(token, CanonicalRegionValues);
}

function normalizeCanonicalRegion(raw) {
  return normalizeCanonicalRegionToken(raw) || 'full_face';
}

function normalizeCanonicalRegionStrict(raw) {
  return normalizeCanonicalRegionToken(raw);
}

function normalizeVisionVisibility(raw) {
  return normalizeEnumValue(raw, VisionVisibilityValues, 'insufficient');
}

function inferInsufficientReasonFromText(text) {
  const token = String(text || '').trim().toLowerCase();
  if (!token) return null;
  if (token.includes('blur')) return 'blur';
  if (token.includes('light') || token.includes('shadow') || token.includes('exposure') || token.includes('wb')) return 'lighting';
  if (token.includes('occlusion') || token.includes('cover')) return 'occlusion';
  if (token.includes('face') && token.includes('visible')) return 'face_not_visible';
  if (token.includes('resolution')) return 'resolution_low';
  if (token.includes('no clear') || token.includes('no cue')) return 'no_clear_cue';
  return 'mixed';
}

function normalizeInsufficientReason(raw, { fallbackText } = {}) {
  const direct = normalizeEnumValue(raw, VisionInsufficientReasonValues, '');
  if (direct) return direct;
  return inferInsufficientReasonFromText(fallbackText) || 'mixed';
}

function normalizeSummaryPriority(raw) {
  return normalizeEnumValue(raw, SummaryPriorityValues, 'mixed');
}

function normalizeRoutineTime(raw) {
  return normalizeEnumValue(raw, RoutineTimeValues, 'either');
}

function normalizeRoutineStepType(raw) {
  return normalizeEnumValue(raw, RoutineStepTypeValues, 'monitor');
}

function normalizeRoutineTarget(raw) {
  return normalizeEnumValue(raw, RoutineTargetValues, 'mixed');
}

function normalizeRoutineCadence(raw) {
  return normalizeEnumValue(raw, RoutineCadenceValues, 'daily');
}

function normalizeRoutineIntensity(raw) {
  return normalizeEnumValue(raw, RoutineIntensityValues, 'gentle');
}

function normalizeWatchout(raw) {
  return normalizeEnumValue(raw, WatchoutValues, 'one_change_at_a_time');
}

function normalizeTwoWeekFocusItem(raw) {
  return normalizeEnumValue(raw, TwoWeekFocusValues, 'confirm_tolerance');
}

function normalizeFollowUpIntent(raw) {
  return normalizeEnumValue(raw, FollowUpIntentValues, 'priority_symptom');
}

function normalizeRiskFlag(raw) {
  return normalizeEnumValue(raw, RiskFlagValues, 'monitor_stinging');
}

function normalizeDeepeningAdvice(raw) {
  return normalizeEnumValue(raw, DeepeningAdviceValues, 'confirm_tolerance');
}

function normalizeDeepeningAdviceStrict(raw) {
  return normalizeEnumValueStrict(raw, DeepeningAdviceValues);
}

function compareCanonicalPriority(a, b) {
  return REPORT_PRIORITY_ORDER.indexOf(a) - REPORT_PRIORITY_ORDER.indexOf(b);
}

function observationConfidenceRank(confidence) {
  const token = normalizeObservationConfidence(confidence);
  if (token === 'high') return 3;
  if (token === 'med') return 2;
  return 1;
}

function observationSeverityRank(severity) {
  const token = normalizeObservationSeverity(severity);
  if (token === 'high') return 3;
  if (token === 'moderate') return 2;
  return 1;
}

function canonicalObservationScore(row) {
  const cueWeight = CUE_PRIORITY_ORDER[row && row.cue] || 0;
  const regionWeight = REGION_PRIORITY_ORDER[row && row.region] || 0;
  return observationConfidenceRank(row && row.confidence) * 100 + observationSeverityRank(row && row.severity) * 10 + cueWeight + regionWeight;
}

function normalizeCanonicalObservationArray(raw, { maxItems = 8, strict = false } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const bestByKey = new Map();
  for (const row of list) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const cue = strict ? normalizeCanonicalCueStrict(row.cue) : normalizeCanonicalCue(row.cue);
    const region = strict ? normalizeCanonicalRegionStrict(row.region != null ? row.region : row.where) : normalizeCanonicalRegion(row.region != null ? row.region : row.where);
    const severity = normalizeObservationSeverity(row.severity);
    const confidence = normalizeObservationConfidence(row.confidence);
    const evidence = clampText(row.evidence, 220);
    if (!cue || !region || !evidence) continue;
    const key = `${cue}:${region}`;
    const next = { cue, region, severity, confidence, evidence };
    const prev = bestByKey.get(key);
    if (!prev || canonicalObservationScore(next) > canonicalObservationScore(prev)) {
      bestByKey.set(key, next);
    }
  }
  return Array.from(bestByKey.values())
    .sort((a, b) => {
      const scoreDiff = canonicalObservationScore(b) - canonicalObservationScore(a);
      if (scoreDiff) return scoreDiff;
      const cueDiff = (CUE_PRIORITY_ORDER[b.cue] || 0) - (CUE_PRIORITY_ORDER[a.cue] || 0);
      if (cueDiff) return cueDiff;
      const regionDiff = (REGION_PRIORITY_ORDER[b.region] || 0) - (REGION_PRIORITY_ORDER[a.region] || 0);
      if (regionDiff) return regionDiff;
      return `${a.cue}:${a.region}`.localeCompare(`${b.cue}:${b.region}`);
    })
    .slice(0, maxItems);
}

function normalizeCanonicalSummaryFocus(raw, { strict = false } = {}) {
  const node = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const primaryCues = Array.isArray(node.primary_cues)
    ? node.primary_cues.map((item) => (strict ? normalizeCanonicalCueStrict(item) : normalizeCanonicalCue(item))).filter(Boolean).slice(0, 3)
    : [];
  const priority = strict ? normalizeEnumValueStrict(node.priority, SummaryPriorityValues) : normalizeSummaryPriority(node.priority);
  return {
    ...(priority ? { priority } : {}),
    ...(primaryCues.length ? { primary_cues: primaryCues } : strict ? {} : { primary_cues: ['texture'] }),
  };
}

function normalizeCanonicalRoutineSteps(raw, { strict = false } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const bestByKey = new Map();
  for (const row of list) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const linkedCues = Array.isArray(row.linked_cues)
      ? row.linked_cues.map((item) => (strict ? normalizeCanonicalCueStrict(item) : normalizeCanonicalCue(item))).filter(Boolean).slice(0, 3)
      : [];
    const normalized = {
      ...(strict
        ? (() => {
            const time = normalizeEnumValueStrict(row.time, RoutineTimeValues);
            const stepType = normalizeEnumValueStrict(row.step_type, RoutineStepTypeValues);
            const target = normalizeEnumValueStrict(row.target, RoutineTargetValues);
            const cadence = normalizeEnumValueStrict(row.cadence, RoutineCadenceValues);
            const intensity = normalizeEnumValueStrict(row.intensity, RoutineIntensityValues);
            return {
              ...(time ? { time } : {}),
              ...(stepType ? { step_type: stepType } : {}),
              ...(target ? { target } : {}),
              ...(cadence ? { cadence } : {}),
              ...(intensity ? { intensity } : {}),
            };
          })()
        : {
            time: normalizeRoutineTime(row.time),
            step_type: normalizeRoutineStepType(row.step_type),
            target: normalizeRoutineTarget(row.target),
            cadence: normalizeRoutineCadence(row.cadence),
            intensity: normalizeRoutineIntensity(row.intensity),
          }),
      ...(linkedCues.length ? { linked_cues: linkedCues } : strict ? {} : { linked_cues: ['texture'] }),
    };
    const key = `${normalized.time || 'missing'}:${normalized.step_type || 'missing'}:${normalized.target || 'missing'}`;
    const prev = bestByKey.get(key);
    if (!prev || (Array.isArray(normalized.linked_cues) ? normalized.linked_cues.length : 0) > (Array.isArray(prev.linked_cues) ? prev.linked_cues.length : 0)) {
      bestByKey.set(key, normalized);
    }
  }
  return Array.from(bestByKey.values())
    .sort((a, b) => {
      const timeDiff = (ROUTINE_TIME_ORDER[a.time] || 99) - (ROUTINE_TIME_ORDER[b.time] || 99);
      if (timeDiff) return timeDiff;
      const stepDiff = (ROUTINE_STEP_ORDER[a.step_type] || 99) - (ROUTINE_STEP_ORDER[b.step_type] || 99);
      if (stepDiff) return stepDiff;
      return `${a.target || ''}:${a.cadence || ''}:${a.intensity || ''}`.localeCompare(`${b.target || ''}:${b.cadence || ''}:${b.intensity || ''}`);
    })
    .slice(0, 8);
}

function normalizeCanonicalFollowUp(raw, { strict = false } = {}) {
  const node = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const conditionalFollowups = Array.isArray(node.conditional_followups)
    ? node.conditional_followups.map((item) => (strict ? normalizeEnumValueStrict(item, FollowUpIntentValues) : normalizeFollowUpIntent(item))).filter(Boolean).slice(0, 3)
    : [];
  const intent = strict ? normalizeEnumValueStrict(node.intent, FollowUpIntentValues) : normalizeFollowUpIntent(node.intent);
  return {
    ...(intent ? { intent } : {}),
    ...(conditionalFollowups.length ? { conditional_followups: conditionalFollowups } : {}),
  };
}

function normalizeCanonicalDeepening(raw, { strict = false, inheritedPriority } = {}) {
  const node = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!node) return null;
  const adviceItems = Array.isArray(node.advice_items)
    ? node.advice_items
        .map((item) => (strict ? normalizeDeepeningAdviceStrict(item) : normalizeDeepeningAdvice(item)))
        .filter(Boolean)
        .filter((item, index, arr) => arr.indexOf(item) === index)
        .sort((a, b) => (DEEPENING_ADVICE_ORDER[a] || 99) - (DEEPENING_ADVICE_ORDER[b] || 99))
        .slice(0, 4)
    : [];
  const phase = strict ? normalizeEnumValueStrict(node.phase, DEEPENING_PHASE_VALUES) : normalizeEnumValue(node.phase, DEEPENING_PHASE_VALUES, 'photo_optin');
  const summaryPriority =
    strict
      ? normalizeEnumValueStrict(node.summary_priority, SummaryPriorityValues) || normalizeEnumValueStrict(inheritedPriority, SummaryPriorityValues)
      : normalizeSummaryPriority(node.summary_priority || inheritedPriority);
  const questionIntent = strict ? normalizeEnumValueStrict(node.question_intent, FollowUpIntentValues) : normalizeFollowUpIntent(node.question_intent);
  return {
    ...(phase ? { phase } : {}),
    ...(summaryPriority ? { summary_priority: summaryPriority } : {}),
    ...(adviceItems.length ? { advice_items: adviceItems } : strict ? {} : { advice_items: ['confirm_tolerance'] }),
    ...(questionIntent ? { question_intent: questionIntent } : {}),
  };
}

function normalizeDeepeningCanonicalLayer(payload, options) {
  return normalizeCanonicalDeepening(payload, options);
}

function normalizeVisionCanonicalLayer(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const observations = normalizeCanonicalObservationArray(p.observations, { maxItems: 4 });
  const limits = normalizeGuidanceBrief(p.limits).map((item) => clampText(item, 120)).slice(0, 4);
  const qualityNote = clampText(p.quality_note, 180);
  const visibilityStatus = normalizeVisionVisibility(
    p.visibility_status || (p.insufficient_visual_detail ? 'insufficient' : observations.length ? 'sufficient' : 'limited'),
  );
  const insufficientReason =
    visibilityStatus === 'insufficient'
      ? normalizeInsufficientReason(p.insufficient_reason, { fallbackText: `${qualityNote} ${limits.join(' ')}` })
      : undefined;
  return {
    visibility_status: visibilityStatus,
    ...(insufficientReason ? { insufficient_reason: insufficientReason } : {}),
    needs_risk_check: Boolean(p.needs_risk_check),
    ...(qualityNote ? { quality_note: qualityNote } : {}),
    observations,
    ...(limits.length ? { limits } : {}),
  };
}

function normalizeReportCanonicalLayer(payload, { strict = false } = {}) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const watchouts = Array.isArray(p.watchouts)
    ? p.watchouts.map((item) => normalizeWatchout(item)).filter(Boolean).slice(0, 4)
    : [];
  const twoWeekFocus = Array.isArray(p.two_week_focus)
    ? p.two_week_focus.map((item) => normalizeTwoWeekFocusItem(item)).filter(Boolean).slice(0, 3)
    : [];
  const riskFlags = Array.isArray(p.risk_flags)
    ? p.risk_flags.map((item) => normalizeRiskFlag(item)).filter(Boolean).slice(0, 3)
    : [];
  return {
    ...(typeof p.needs_risk_check === 'boolean' ? { needs_risk_check: p.needs_risk_check } : strict ? {} : { needs_risk_check: Boolean(p.needs_risk_check) }),
    summary_focus: normalizeCanonicalSummaryFocus(p.summary_focus, { strict }),
    insights: normalizeCanonicalObservationArray(p.insights, { maxItems: 6, strict }),
    routine_steps: normalizeCanonicalRoutineSteps(p.routine_steps, { strict }),
    ...(watchouts.length ? { watchouts } : strict ? {} : { watchouts: ['one_change_at_a_time'] }),
    follow_up: normalizeCanonicalFollowUp(p.follow_up, { strict }),
    ...(twoWeekFocus.length ? { two_week_focus: twoWeekFocus } : strict ? {} : { two_week_focus: ['confirm_tolerance'] }),
    risk_flags: riskFlags,
    ...(p.deepening ? { deepening: normalizeCanonicalDeepening(p.deepening, { strict }) } : {}),
  };
}

function validateVisionCanonicalLayer(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const errors = [];
  if (!p) return { ok: false, errors: ['/ must be object'] };
  if (!VisionVisibilityValues.includes(String(p.visibility_status || '').trim().toLowerCase())) {
    errors.push('/visibility_status invalid');
  }
  if (p.visibility_status === 'insufficient' && !VisionInsufficientReasonValues.includes(String(p.insufficient_reason || '').trim().toLowerCase())) {
    errors.push('/insufficient_reason required when visibility_status=insufficient');
  }
  if (typeof p.needs_risk_check !== 'boolean') errors.push('/needs_risk_check must be boolean');
  if (p.quality_note != null && (typeof p.quality_note !== 'string' || p.quality_note.length > 180)) errors.push('/quality_note invalid');
  errors.push(...validateObservationArray(
    Array.isArray(p.observations)
      ? p.observations.map((row) => ({ ...row, where: row.region }))
      : p.observations,
    { path: '/observations', max: 8 },
  ));
  if (p.limits != null) {
    errors.push(...validateStringArray(p.limits, { path: '/limits', maxItems: 4, maxLen: 120 }));
  }
  return { ok: errors.length === 0, errors };
}

function validateReportCanonicalLayer(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const errors = [];
  if (!p) return { ok: false, errors: ['/ must be object'] };
  if (typeof p.needs_risk_check !== 'boolean') errors.push('/needs_risk_check must be boolean');
  if (!p.summary_focus || typeof p.summary_focus !== 'object' || Array.isArray(p.summary_focus)) {
    errors.push('/summary_focus must be object');
  } else {
    if (!SummaryPriorityValues.includes(String(p.summary_focus.priority || '').trim().toLowerCase())) {
      errors.push('/summary_focus/priority invalid');
    }
    if (!Array.isArray(p.summary_focus.primary_cues)) errors.push('/summary_focus/primary_cues must be array');
  }
  errors.push(...validateObservationArray(
    Array.isArray(p.insights) ? p.insights.map((row) => ({ ...row, where: row.region })) : p.insights,
    { path: '/insights', max: 6 },
  ));
  if (!Array.isArray(p.routine_steps)) errors.push('/routine_steps must be array');
  else {
    if (p.routine_steps.length > 8) errors.push('/routine_steps max 8 items');
    for (let i = 0; i < p.routine_steps.length; i += 1) {
      const row = p.routine_steps[i];
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        errors.push(`/routine_steps/${i} must be object`);
        continue;
      }
      if (!RoutineTimeValues.includes(String(row.time || '').trim().toLowerCase())) errors.push(`/routine_steps/${i}/time invalid`);
      if (!RoutineStepTypeValues.includes(String(row.step_type || '').trim().toLowerCase())) errors.push(`/routine_steps/${i}/step_type invalid`);
      if (!RoutineTargetValues.includes(String(row.target || '').trim().toLowerCase())) errors.push(`/routine_steps/${i}/target invalid`);
      if (!RoutineCadenceValues.includes(String(row.cadence || '').trim().toLowerCase())) errors.push(`/routine_steps/${i}/cadence invalid`);
      if (!RoutineIntensityValues.includes(String(row.intensity || '').trim().toLowerCase())) errors.push(`/routine_steps/${i}/intensity invalid`);
      if (!Array.isArray(row.linked_cues)) errors.push(`/routine_steps/${i}/linked_cues must be array`);
    }
  }
  if (!Array.isArray(p.watchouts)) errors.push('/watchouts must be array');
  if (!Array.isArray(p.two_week_focus)) errors.push('/two_week_focus must be array');
  if (p.risk_flags != null && !Array.isArray(p.risk_flags)) errors.push('/risk_flags must be array');
  if (!p.follow_up || typeof p.follow_up !== 'object' || Array.isArray(p.follow_up)) {
    errors.push('/follow_up must be object');
  } else if (!FollowUpIntentValues.includes(String(p.follow_up.intent || '').trim().toLowerCase())) {
    errors.push('/follow_up/intent invalid');
  }
  if (p.deepening != null) {
    if (!p.deepening || typeof p.deepening !== 'object' || Array.isArray(p.deepening)) {
      errors.push('/deepening must be object');
    } else {
      if (!DEEPENING_PHASE_VALUES.includes(String(p.deepening.phase || '').trim().toLowerCase())) errors.push('/deepening/phase invalid');
      if (!SummaryPriorityValues.includes(String(p.deepening.summary_priority || '').trim().toLowerCase())) errors.push('/deepening/summary_priority invalid');
      if (!Array.isArray(p.deepening.advice_items)) errors.push('/deepening/advice_items must be array');
      if (!FollowUpIntentValues.includes(String(p.deepening.question_intent || '').trim().toLowerCase())) errors.push('/deepening/question_intent invalid');
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateDeepeningCanonicalLayer(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const errors = [];
  if (!p) return { ok: false, errors: ['/ must be object'] };
  if (!DEEPENING_PHASE_VALUES.includes(String(p.phase || '').trim().toLowerCase())) errors.push('/phase invalid');
  if (!SummaryPriorityValues.includes(String(p.summary_priority || '').trim().toLowerCase())) errors.push('/summary_priority invalid');
  if (!Array.isArray(p.advice_items)) errors.push('/advice_items must be array');
  if (!FollowUpIntentValues.includes(String(p.question_intent || '').trim().toLowerCase())) errors.push('/question_intent invalid');
  return { ok: errors.length === 0, errors };
}

function cueToSummaryPriority(cue) {
  const token = normalizeCanonicalCue(cue);
  if (token === 'shine') return 'oiliness';
  if (token === 'uneven_tone') return 'tone';
  if (token === 'flaking') return 'barrier';
  return SummaryPriorityValues.includes(token) ? token : 'mixed';
}

function priorityToCanonicalCue(priority) {
  const token = normalizeSummaryPriority(priority);
  if (token === 'oiliness') return 'shine';
  if (token === 'tone') return 'uneven_tone';
  if (token === 'barrier') return 'texture';
  return CanonicalCueValues.includes(token) ? token : 'texture';
}

function mapConcernTokenToPriority(token) {
  const value = String(token || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'barrier' || value === 'dryness') return 'barrier';
  if (value === 'redness') return 'redness';
  if (value === 'shine' || value === 'oiliness') return 'oiliness';
  if (value === 'acne' || value === 'acne_like' || value === 'comedone' || value === 'bumps') return 'bumps';
  if (value === 'rough_texture' || value === 'texture') return 'texture';
  if (value === 'tone' || value === 'uneven_tone' || value === 'pigmentation') return 'tone';
  if (value === 'pores') return 'pores';
  return '';
}

function extractCueVotesFromLockedFeatures(raw) {
  const texts = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out = [];
  for (const item of texts) {
    const token = String(item || '').trim().toLowerCase();
    if (!token) continue;
    if (token.includes('red')) out.push('redness');
    if (token.includes('shine') || token.includes('oil')) out.push('shine');
    if (token.includes('bump') || token.includes('breakout') || token.includes('comed')) out.push('bumps');
    if (token.includes('flake') || token.includes('dry') || token.includes('barrier')) out.push('flaking');
    if (token.includes('tone') || token.includes('pigment')) out.push('uneven_tone');
    if (token.includes('texture') || token.includes('rough')) out.push('texture');
    if (token.includes('pore')) out.push('pores');
  }
  return out;
}

function buildPrimaryCueList({ summaryFocus, insights, reportContext, resolvedPriority } = {}) {
  const candidates = [];
  if (summaryFocus && Array.isArray(summaryFocus.primary_cues)) candidates.push(...summaryFocus.primary_cues);
  if (Array.isArray(insights)) candidates.push(...insights.map((row) => row && row.cue).filter(Boolean));
  const locked = reportContext && reportContext.locked_features_summary;
  candidates.push(...extractCueVotesFromLockedFeatures(locked));
  const fallbackCue = priorityToCanonicalCue(resolvedPriority);
  if (fallbackCue) candidates.unshift(fallbackCue);
  const out = [];
  for (const cue of candidates) {
    const normalizedCue = normalizeCanonicalCueStrict(cue);
    if (!normalizedCue || out.includes(normalizedCue)) continue;
    out.push(normalizedCue);
    if (out.length >= 3) break;
  }
  return out.length ? out : [priorityToCanonicalCue(resolvedPriority || 'mixed')];
}

function normalizeReportInsightSeverity(cue, rawSeverity, { resolvedPriority, reportContext } = {}) {
  const signals = reportContext && reportContext.deterministic_signals && typeof reportContext.deterministic_signals === 'object'
    ? reportContext.deterministic_signals
    : {};
  const normalizedCue = normalizeCanonicalCue(cue);
  const normalizedSeverity = normalizeObservationSeverity(rawSeverity);
  if (normalizedCue === 'redness') {
    const redness = String(signals.redness || '').trim().toLowerCase();
    if (redness === 'high') return 'high';
    if (redness === 'mid') return 'moderate';
    if (redness === 'low') return 'mild';
  }
  if (normalizedCue === 'texture') {
    const texture = String(signals.texture || '').trim().toLowerCase();
    if (texture === 'rough') return 'moderate';
    if (texture === 'ok') return 'mild';
  }
  if (normalizedCue === 'bumps') {
    const acneLike = String(signals.acne_like || '').trim().toLowerCase();
    if (acneLike === 'some') return 'moderate';
    if (acneLike === 'few') return 'mild';
  }
  if (normalizedCue === 'shine') {
    const oiliness = String(signals.oiliness || '').trim().toLowerCase();
    if (oiliness === 'high') return 'moderate';
    if (oiliness === 'mid') return 'mild';
    if (oiliness === 'low') return 'mild';
  }
  if (normalizedCue === 'flaking') {
    const dryness = String(signals.dryness || '').trim().toLowerCase();
    if (dryness === 'some') return 'mild';
  }
  if (normalizedCue === priorityToCanonicalCue(resolvedPriority)) {
    return normalizedSeverity === 'high' ? 'high' : 'moderate';
  }
  return normalizedSeverity === 'high' ? 'moderate' : 'mild';
}

function selectDeterministicReportInsights(insights, { primaryCues, resolvedPriority, reportContext } = {}) {
  const list = Array.isArray(insights) ? insights.slice() : [];
  const prioritizedCues = Array.isArray(primaryCues) ? primaryCues.map((item) => normalizeCanonicalCue(item)).filter(Boolean) : [];
  const resolvedCue = priorityToCanonicalCue(resolvedPriority || 'mixed');
  const allowedCues = Array.from(new Set([resolvedCue, ...prioritizedCues])).filter(Boolean);
  const ranked = normalizeCanonicalObservationArray(list, { maxItems: 6 })
    .sort((a, b) => {
      const allowedDiff = Number(allowedCues.includes(b.cue)) - Number(allowedCues.includes(a.cue));
      if (allowedDiff) return allowedDiff;
      const scoreDiff = canonicalObservationScore(b) - canonicalObservationScore(a);
      if (scoreDiff) return scoreDiff;
      return `${a.cue}:${a.region}`.localeCompare(`${b.cue}:${b.region}`);
    });
  const kept = [];
  const seen = new Set();
  for (const row of ranked) {
    const key = `${row.cue}:${row.region}`;
    if (seen.has(key)) continue;
    if (kept.length >= 2) break;
    if (allowedCues.length && !allowedCues.includes(row.cue)) continue;
    seen.add(key);
    kept.push({
      ...row,
      severity: normalizeReportInsightSeverity(row.cue, row.severity, { resolvedPriority, reportContext }),
    });
  }
  if (kept.length >= 2) return kept;
  return ranked.slice(0, Math.min(2, ranked.length)).map((row) => ({
    ...row,
    severity: normalizeReportInsightSeverity(row.cue, row.severity, { resolvedPriority, reportContext }),
  }));
}

function resolveReportSummaryFocus(summaryFocus, insights, reportContext) {
  const scoreMap = new Map();
  const addScore = (priority, weight) => {
    const token = normalizeEnumValueStrict(priority, SummaryPriorityValues);
    if (!token || !Number.isFinite(Number(weight)) || Number(weight) <= 0) return;
    scoreMap.set(token, (scoreMap.get(token) || 0) + Number(weight));
  };

  const normalizedFocus = normalizeCanonicalSummaryFocus(summaryFocus, { strict: false });
  if (normalizedFocus.priority && normalizedFocus.priority !== 'mixed') addScore(normalizedFocus.priority, 2.5);
  for (const cue of Array.isArray(normalizedFocus.primary_cues) ? normalizedFocus.primary_cues : []) {
    addScore(cueToSummaryPriority(cue), 1.2);
  }
  for (const row of Array.isArray(insights) ? insights : []) {
    if (!row || typeof row !== 'object') continue;
    addScore(cueToSummaryPriority(row.cue), observationConfidenceRank(row.confidence) + observationSeverityRank(row.severity) / 2);
  }

  const concernRank = reportContext && Array.isArray(reportContext.concern_rank) ? reportContext.concern_rank : [];
  const concernWeights = [3.2, 2.4, 1.8, 1.2, 0.8];
  for (let i = 0; i < concernRank.length; i += 1) {
    addScore(mapConcernTokenToPriority(concernRank[i]), concernWeights[i] || 0.5);
  }

  const signals = reportContext && reportContext.deterministic_signals && typeof reportContext.deterministic_signals === 'object'
    ? reportContext.deterministic_signals
    : {};
  const redness = String(signals.redness || '').trim().toLowerCase();
  if (redness === 'high') addScore('redness', 3);
  else if (redness === 'mid') addScore('redness', 2);
  else if (redness === 'low') addScore('redness', 1);
  const oiliness = String(signals.oiliness || '').trim().toLowerCase();
  if (oiliness === 'high') addScore('oiliness', 3);
  else if (oiliness === 'mid') addScore('oiliness', 2);
  else if (oiliness === 'low') addScore('oiliness', 1);
  const acneLike = String(signals.acne_like || '').trim().toLowerCase();
  if (acneLike === 'some') addScore('bumps', 2.5);
  else if (acneLike === 'few') addScore('bumps', 1.3);
  const dryness = String(signals.dryness || '').trim().toLowerCase();
  if (dryness === 'some') addScore('barrier', 2.4);
  const texture = String(signals.texture || '').trim().toLowerCase();
  if (texture === 'rough') addScore('texture', 1.8);
  const routineSummary = reportContext && reportContext.routine_summary && typeof reportContext.routine_summary === 'object'
    ? reportContext.routine_summary
    : {};
  const constraints = reportContext && Array.isArray(reportContext.constraints) ? reportContext.constraints : [];
  const hasSensitiveConstraint = constraints.includes('sensitive-skin self-report');
  const actives = Array.isArray(routineSummary.actives) ? routineSummary.actives : [];
  const sunscreen = String(routineSummary.sunscreen || '').trim().toLowerCase();
  if (dryness === 'some' && hasSensitiveConstraint) addScore('barrier', 4);
  if (actives.length) addScore('barrier', 2.4);
  if (sunscreen && sunscreen !== 'yes') addScore('barrier', 1.4);

  for (const cue of extractCueVotesFromLockedFeatures(reportContext && reportContext.locked_features_summary)) {
    addScore(cueToSummaryPriority(cue), 0.8);
  }

  let resolvedPriority = '';
  let bestScore = -1;
  for (const priority of REPORT_PRIORITY_ORDER) {
    const nextScore = scoreMap.get(priority) || 0;
    if (nextScore > bestScore) {
      resolvedPriority = priority;
      bestScore = nextScore;
    }
  }
  if (!resolvedPriority) resolvedPriority = normalizedFocus.priority || 'mixed';
  if (
    dryness === 'some' &&
    (hasSensitiveConstraint || actives.length || sunscreen !== 'yes') &&
    ['redness', 'texture', 'mixed', 'tone', 'pores'].includes(resolvedPriority)
  ) {
    resolvedPriority = 'barrier';
  }

  return {
    priority: resolvedPriority || 'mixed',
    primary_cues: buildPrimaryCueList({
      summaryFocus: normalizedFocus,
      insights,
      reportContext,
      resolvedPriority: resolvedPriority || 'mixed',
    }),
  };
}

function defaultWatchoutsForPriority(priority, quality, reportContext) {
  const out = ['one_change_at_a_time'];
  const token = normalizeSummaryPriority(priority);
  const grade = String(quality && quality.grade || '').trim().toLowerCase();
  const routineSummary = reportContext && reportContext.routine_summary && typeof reportContext.routine_summary === 'object'
    ? reportContext.routine_summary
    : {};
  const actives = Array.isArray(routineSummary.actives) ? routineSummary.actives : [];
  const constraints = reportContext && Array.isArray(reportContext.constraints) ? reportContext.constraints : [];
  if (token === 'barrier' || token === 'redness') out.unshift('pause_if_stinging');
  if (token === 'tone' || token === 'redness' || routineSummary.sunscreen !== 'yes') out.push('protect_uv');
  if (token === 'barrier' || token === 'redness' || constraints.includes('sensitive-skin self-report')) out.push('protect_barrier');
  if (actives.length) out.push('avoid_stacking_strong_actives');
  if (grade === 'degraded' || grade === 'fail') out.push('retake_clear_photo');
  return out.filter((item, index, arr) => arr.indexOf(item) === index).slice(0, 4);
}

function defaultTwoWeekFocusForPriority(priority) {
  const token = normalizeSummaryPriority(priority);
  if (token === 'barrier') return ['stabilize_barrier', 'confirm_tolerance'];
  if (token === 'redness') return ['track_redness', 'confirm_tolerance'];
  if (token === 'oiliness') return ['track_oil', 'confirm_tolerance'];
  if (token === 'bumps') return ['track_bumps', 'confirm_tolerance'];
  if (token === 'texture') return ['track_texture', 'confirm_tolerance'];
  if (token === 'tone') return ['track_tone', 'confirm_tolerance'];
  return ['confirm_tolerance'];
}

function defaultFollowUpIntent({ priority, reportContext } = {}) {
  const token = normalizeSummaryPriority(priority);
  const routineSummary = reportContext && reportContext.routine_summary && typeof reportContext.routine_summary === 'object'
    ? reportContext.routine_summary
    : {};
  const actives = Array.isArray(routineSummary.actives) ? routineSummary.actives : [];
  if (actives.length) return 'reaction_check';
  if (routineSummary.moisturizer === 'unknown' || routineSummary.sunscreen === 'unknown') return 'routine_share';
  if (token === 'barrier' || token === 'redness') return 'tolerance_check';
  return 'priority_symptom';
}

function defaultConditionalFollowUps({ intent, priority, reportContext } = {}) {
  const resolvedIntent = normalizeFollowUpIntent(intent);
  const routineSummary = reportContext && reportContext.routine_summary && typeof reportContext.routine_summary === 'object'
    ? reportContext.routine_summary
    : {};
  const actives = Array.isArray(routineSummary.actives) ? routineSummary.actives : [];
  if (resolvedIntent === 'reaction_check') return ['routine_share'];
  if (resolvedIntent === 'routine_share') {
    return actives.length ? ['reaction_check'] : ['tolerance_check'];
  }
  if (resolvedIntent === 'tolerance_check') return ['routine_share'];
  if (normalizeSummaryPriority(priority) === 'barrier' || normalizeSummaryPriority(priority) === 'redness') return ['routine_share'];
  return ['routine_share'];
}

function resolveRiskFlags({ priority, reportContext } = {}) {
  const out = [];
  const token = normalizeSummaryPriority(priority);
  const grade = String(reportContext && reportContext.quality && reportContext.quality.grade || '').trim().toLowerCase();
  if (token === 'redness' || token === 'barrier') out.push('monitor_persistent_redness', 'monitor_stinging');
  if (token === 'bumps') out.push('monitor_new_breakouts');
  if (grade === 'degraded' || grade === 'fail') out.push('retake_photo');
  return out.filter((item, index, arr) => arr.indexOf(item) === index).slice(0, 3);
}

function buildDeterministicRoutineSteps({ summaryFocus, insights, reportContext } = {}) {
  const priority = normalizeSummaryPriority(summaryFocus && summaryFocus.priority);
  const primaryCues = Array.isArray(summaryFocus && summaryFocus.primary_cues) ? summaryFocus.primary_cues : [];
  const routineSummary = reportContext && reportContext.routine_summary && typeof reportContext.routine_summary === 'object'
    ? reportContext.routine_summary
    : {};
  const actives = Array.isArray(routineSummary.actives) ? routineSummary.actives : [];
  const constraints = reportContext && Array.isArray(reportContext.constraints) ? reportContext.constraints : [];
  const qualityGrade = String(reportContext && reportContext.quality && reportContext.quality.grade || '').trim().toLowerCase();
  const hasSensitiveConstraint = constraints.includes('sensitive-skin self-report');
  const targetCue = primaryCues.find((cue) => cue && cue !== 'redness' && cue !== 'flaking') || primaryCues[0] || priorityToCanonicalCue(priority);
  const targetPriority = cueToSummaryPriority(targetCue);
  const cuePool = Array.isArray(insights) ? insights.map((item) => item && item.cue).filter(Boolean) : [];
  const linkedPrimary = Array.from(new Set([priorityToCanonicalCue(priority), ...cuePool])).filter(Boolean).slice(0, 3);
  const linkedSecondary = Array.from(new Set([targetCue, ...cuePool])).filter(Boolean).slice(0, 3);

  const steps = [
    {
      time: 'am',
      step_type: 'cleanse',
      target: priority === 'mixed' ? 'barrier' : priority === 'redness' ? 'barrier' : priority,
      cadence: 'daily',
      intensity: 'gentle',
      linked_cues: linkedPrimary.length ? linkedPrimary.slice(0, 2) : ['texture'],
    },
    {
      time: 'am',
      step_type: 'protect',
      target: priority === 'mixed' ? 'barrier' : priority === 'redness' ? 'barrier' : priority,
      cadence: 'daily',
      intensity: routineSummary.sunscreen === 'yes' ? 'standard' : 'barrier_safe',
      linked_cues: linkedPrimary.length ? linkedPrimary.slice(0, 2) : ['texture'],
    },
    {
      time: 'either',
      step_type: 'moisturize',
      target: 'barrier',
      cadence: 'daily',
      intensity: 'barrier_safe',
      linked_cues: linkedPrimary.length ? linkedPrimary.slice(0, 3) : ['texture'],
    },
  ];

  const canTreat =
    qualityGrade === 'pass' &&
    !hasSensitiveConstraint &&
    !actives.length &&
    targetPriority &&
    targetPriority !== 'barrier' &&
    targetPriority !== 'redness' &&
    targetPriority !== 'mixed';
  steps.push(
    canTreat
      ? {
          time: 'pm',
          step_type: 'treat',
          target: targetPriority,
          cadence: 'two_nights_weekly',
          intensity: 'low_frequency',
          linked_cues: linkedSecondary.length ? linkedSecondary.slice(0, 2) : ['texture'],
        }
      : {
          time: 'pm',
          step_type: 'monitor',
          target: targetPriority && targetPriority !== 'mixed' ? targetPriority : priority === 'mixed' ? 'barrier' : priority,
          cadence: 'as_needed',
          intensity: 'low_frequency',
          linked_cues: linkedSecondary.length ? linkedSecondary.slice(0, 2) : ['texture'],
        },
  );

  return normalizeCanonicalRoutineSteps(steps, { strict: false });
}

function adjudicateReportCanonicalLayer(payload, { reportContext, deepening } = {}) {
  const base = normalizeReportCanonicalLayer(payload, { strict: false });
  const summaryFocus = resolveReportSummaryFocus(base.summary_focus, base.insights, reportContext);
  const resolvedInsights = selectDeterministicReportInsights(base.insights, {
    primaryCues: summaryFocus.primary_cues,
    resolvedPriority: summaryFocus.priority,
    reportContext,
  });
  const resolvedSummaryFocus = {
    ...summaryFocus,
    primary_cues: buildPrimaryCueList({
      summaryFocus,
      insights: resolvedInsights,
      reportContext,
      resolvedPriority: summaryFocus.priority,
    }).slice(0, 2),
  };
  const watchouts = defaultWatchoutsForPriority(summaryFocus.priority, reportContext && reportContext.quality, reportContext);
  const twoWeekFocus = defaultTwoWeekFocusForPriority(summaryFocus.priority);
  const resolvedIntent = defaultFollowUpIntent({ priority: summaryFocus.priority, reportContext });
  const resolvedFollowUp = {
    intent: resolvedIntent,
    conditional_followups: defaultConditionalFollowUps({
      intent: resolvedIntent,
      priority: summaryFocus.priority,
      reportContext,
    }),
  };
  return {
    needs_risk_check: Boolean(base.needs_risk_check),
    summary_focus: resolvedSummaryFocus,
    insights: resolvedInsights,
    routine_steps: buildDeterministicRoutineSteps({
      summaryFocus: resolvedSummaryFocus,
      insights: resolvedInsights,
      reportContext,
    }),
    watchouts,
    follow_up: resolvedFollowUp,
    two_week_focus: twoWeekFocus,
    risk_flags: resolveRiskFlags({ priority: summaryFocus.priority, reportContext }),
    ...(deepening ? { deepening: normalizeCanonicalDeepening(deepening, { strict: false, inheritedPriority: summaryFocus.priority }) } : {}),
  };
}

function defaultQuestionIntentForPhase(phase) {
  const token = normalizeEnumValue(phase, DEEPENING_PHASE_VALUES, 'photo_optin');
  if (token === 'photo_optin') return 'photo_upload';
  if (token === 'products') return 'routine_share';
  if (token === 'reactions') return 'reaction_check';
  return 'confirm_plan';
}

function adjudicateDeepeningCanonicalLayer(payload, { inheritedPriority, deepeningContext } = {}) {
  const base = normalizeCanonicalDeepening(payload, { strict: false, inheritedPriority });
  if (!base) return null;
  const phase = normalizeEnumValue(base.phase || (deepeningContext && deepeningContext.phase), DEEPENING_PHASE_VALUES, 'photo_optin');
  const summaryPriority = normalizeSummaryPriority(inheritedPriority || base.summary_priority);
  return {
    phase,
    summary_priority: summaryPriority,
    advice_items: Array.isArray(base.advice_items) && base.advice_items.length ? base.advice_items.slice(0, 4) : defaultTwoWeekFocusForPriority(summaryPriority),
    question_intent: normalizeFollowUpIntent(base.question_intent || (deepeningContext && deepeningContext.question_intent) || defaultQuestionIntentForPhase(phase)),
  };
}

function evaluateVisionCanonicalSemantic(payload, { quality, parseStatus } = {}) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const issues = [];
  if (parseStatus === 'parse_truncated') {
    issues.push('parse_truncated');
  }
  const visibilityStatus = normalizeVisionVisibility(p.visibility_status);
  const grade = String((quality && quality.grade) || '')
    .trim()
    .toLowerCase();
  if (visibilityStatus === 'insufficient' && !p.insufficient_reason) {
    issues.push('missing_insufficient_reason');
  }
  if ((visibilityStatus === 'sufficient' || visibilityStatus === 'limited') && grade === 'pass' && (!Array.isArray(p.observations) || p.observations.length < 2)) {
    issues.push('semantic_empty_on_pass_quality');
  }
  if (visibilityStatus === 'limited' && (!Array.isArray(p.observations) || !p.observations.length) && grade === 'pass') {
    issues.push('limited_without_grounded_cues');
  }
  return {
    ok: issues.length === 0,
    code: issues.includes('parse_truncated')
      ? 'PARSE_TRUNCATED_JSON'
      : issues.includes('semantic_empty_on_pass_quality')
        ? 'SEMANTIC_EMPTY'
        : issues.length
          ? 'SEMANTIC_INVALID'
          : null,
    issues,
    useful_output: visibilityStatus !== 'insufficient' && Array.isArray(p.observations) && p.observations.length >= 2,
  };
}

function evaluateReportCanonicalSemantic(payload, { reportContext, parseStatus } = {}) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const issues = [];
  if (parseStatus === 'parse_truncated') issues.push('parse_truncated');
  if (!Array.isArray(p.insights) || !p.insights.length) issues.push('missing_insights');
  if (!Array.isArray(p.routine_steps) || !p.routine_steps.length) issues.push('missing_routine_steps');
  if (Array.isArray(p.routine_steps) && !p.routine_steps.some((row) => Array.isArray(row && row.linked_cues) && row.linked_cues.length > 0)) {
    issues.push('routine_steps_not_grounded');
  }
  if (!p.follow_up || typeof p.follow_up !== 'object' || !p.follow_up.intent) issues.push('missing_follow_up');
  if (!p.summary_focus || !p.summary_focus.priority || !Array.isArray(p.summary_focus.primary_cues) || !p.summary_focus.primary_cues.length) {
    issues.push('missing_summary_focus');
  } else if (
    p.summary_focus.priority === 'mixed' &&
    reportContext &&
    Array.isArray(reportContext.concern_rank) &&
    reportContext.concern_rank.length > 0
  ) {
    issues.push('underconstrained_priority');
  }
  if (
    reportContext &&
    Array.isArray(reportContext.concern_rank) &&
    reportContext.concern_rank.length > 0 &&
    (!p.summary_focus || !p.summary_focus.priority)
  ) {
    issues.push('underconstrained_priority');
  }
  if (issues.includes('missing_insights') && issues.includes('missing_routine_steps')) {
    issues.push('schema_valid_but_empty');
  }
  return {
    ok: issues.length === 0,
    code: issues.includes('parse_truncated')
      ? 'PARSE_TRUNCATED_JSON'
      : issues.includes('underconstrained_priority')
        ? 'UNDERCONSTRAINED_PRIORITY'
        : issues.includes('schema_valid_but_empty') || issues.includes('missing_insights')
          ? 'SEMANTIC_EMPTY'
          : issues.length
            ? 'SEMANTIC_INVALID'
            : null,
    issues,
    useful_output: issues.length === 0,
  };
}

function evaluateDeepeningCanonicalSemantic(payload, { parseStatus } = {}) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const issues = [];
  if (parseStatus === 'parse_truncated') issues.push('parse_truncated');
  if (!p.phase) issues.push('missing_phase');
  if (!p.question_intent) issues.push('missing_question_intent');
  if (!Array.isArray(p.advice_items) || !p.advice_items.length) issues.push('missing_advice_items');
  return {
    ok: issues.length === 0,
    code: issues.includes('parse_truncated')
      ? 'PARSE_TRUNCATED_JSON'
      : issues.includes('missing_advice_items')
        ? 'SEMANTIC_EMPTY'
        : issues.length
          ? 'SEMANTIC_INVALID'
          : null,
    issues,
    useful_output: issues.length === 0,
  };
}

function localizeCueLabel(cue, lang) {
  const locale = normalizeLang(lang);
  const map = {
    redness: locale === 'zh-CN' ? '泛红' : 'redness',
    shine: locale === 'zh-CN' ? '油光' : 'shine',
    bumps: locale === 'zh-CN' ? '颗粒/痘样凸起' : 'bumps',
    flaking: locale === 'zh-CN' ? '脱屑' : 'flaking',
    uneven_tone: locale === 'zh-CN' ? '肤色不均' : 'uneven tone',
    texture: locale === 'zh-CN' ? '纹理粗糙' : 'texture',
    pores: locale === 'zh-CN' ? '毛孔可见' : 'visible pores',
  };
  return map[normalizeCanonicalCue(cue)] || (locale === 'zh-CN' ? '可见皮肤信号' : 'visible skin signal');
}

function localizeRegionLabel(region, lang) {
  const locale = normalizeLang(lang);
  const map = {
    cheeks: locale === 'zh-CN' ? '面颊' : 'cheeks',
    forehead: locale === 'zh-CN' ? '额头' : 'forehead',
    t_zone: locale === 'zh-CN' ? 'T区' : 'T-zone',
    chin: locale === 'zh-CN' ? '下巴' : 'chin',
    nose: locale === 'zh-CN' ? '鼻部' : 'nose',
    jawline: locale === 'zh-CN' ? '下颌线' : 'jawline',
    full_face: locale === 'zh-CN' ? '全脸' : 'full face',
  };
  return map[normalizeCanonicalRegion(region)] || map.full_face;
}

function localizeSeverityLabel(severity, lang) {
  const locale = normalizeLang(lang);
  const token = normalizeObservationSeverity(severity);
  if (locale === 'zh-CN') {
    if (token === 'high') return '较明显';
    if (token === 'moderate') return '中等';
    return '轻度';
  }
  if (token === 'high') return 'marked';
  if (token === 'moderate') return 'moderate';
  return 'mild';
}

function localizeVisibilityReason(reason, lang) {
  const locale = normalizeLang(lang);
  const token = normalizeInsufficientReason(reason);
  const zh = {
    blur: '画面模糊影响判断',
    lighting: '光线条件影响判断',
    occlusion: '遮挡影响判断',
    face_not_visible: '面部区域不够清晰',
    resolution_low: '分辨率不足',
    no_clear_cue: '可见信号不足',
    mixed: '可见条件不足',
  };
  const en = {
    blur: 'motion blur limits the read',
    lighting: 'lighting limits the read',
    occlusion: 'occlusion limits the read',
    face_not_visible: 'the face is not clearly visible',
    resolution_low: 'resolution is too low',
    no_clear_cue: 'clear cues are not visible',
    mixed: 'the visible conditions are too limited',
  };
  return (locale === 'zh-CN' ? zh : en)[token] || (locale === 'zh-CN' ? zh.mixed : en.mixed);
}

function localizePriorityLabel(priority, lang) {
  const locale = normalizeLang(lang);
  const map = {
    barrier: locale === 'zh-CN' ? '屏障稳定' : 'barrier stability',
    redness: locale === 'zh-CN' ? '泛红管理' : 'redness control',
    oiliness: locale === 'zh-CN' ? '出油平衡' : 'oil balance',
    texture: locale === 'zh-CN' ? '纹理平滑' : 'texture smoothing',
    tone: locale === 'zh-CN' ? '均匀肤色' : 'tone evenness',
    bumps: locale === 'zh-CN' ? '颗粒波动' : 'bump control',
    pores: locale === 'zh-CN' ? '毛孔可见度' : 'pore visibility',
    mixed: locale === 'zh-CN' ? '先稳后进' : 'stability-first mixed focus',
  };
  return map[normalizeSummaryPriority(priority)] || map.mixed;
}

function localizeWatchout(watchout, lang) {
  const locale = normalizeLang(lang);
  const map = {
    avoid_stacking_strong_actives:
      locale === 'zh-CN' ? '不要在同一晚叠加多个强活性。' : 'Do not stack multiple strong actives on the same night.',
    pause_if_stinging:
      locale === 'zh-CN' ? '若刺痛持续或加重，先暂停新增活性。' : 'If stinging persists or worsens, pause newly added actives.',
    protect_barrier:
      locale === 'zh-CN' ? '先守住清洁-保湿-防晒三步基线。' : 'Keep a cleanse-moisturize-sunscreen baseline first.',
    protect_uv:
      locale === 'zh-CN' ? '白天把防晒作为固定最后一步。' : 'Keep sunscreen as the fixed final AM step.',
    one_change_at_a_time:
      locale === 'zh-CN' ? '一次只调整一个变量，方便追踪反应。' : 'Change one variable at a time so reactions stay trackable.',
    retake_clear_photo:
      locale === 'zh-CN' ? '下次尽量在自然光下补拍清晰正脸照。' : 'Retake a clear front-facing photo in daylight next time.',
  };
  return map[normalizeWatchout(watchout)] || map.one_change_at_a_time;
}

function localizeTwoWeekFocus(item, lang) {
  const locale = normalizeLang(lang);
  const map = {
    stabilize_barrier: locale === 'zh-CN' ? '优先稳定屏障 2 周。' : 'Keep the barrier stable for the next 2 weeks.',
    track_redness: locale === 'zh-CN' ? '连续记录泛红波动。' : 'Track redness trend over the next 2 weeks.',
    track_oil: locale === 'zh-CN' ? '连续记录中午前后的出油变化。' : 'Track midday oil changes over the next 2 weeks.',
    track_bumps: locale === 'zh-CN' ? '连续记录新起颗粒数量。' : 'Track whether new bumps are increasing.',
    track_texture: locale === 'zh-CN' ? '连续记录纹理与粗糙感变化。' : 'Track texture and roughness changes.',
    track_tone: locale === 'zh-CN' ? '连续记录肤色均匀度变化。' : 'Track tone evenness changes.',
    confirm_tolerance: locale === 'zh-CN' ? '确认当前方案是否耐受。' : 'Confirm that the current plan is well tolerated.',
  };
  return map[normalizeTwoWeekFocusItem(item)] || map.confirm_tolerance;
}

function localizeRiskFlag(flag, lang) {
  const locale = normalizeLang(lang);
  const map = {
    monitor_persistent_redness: locale === 'zh-CN' ? '若泛红持续不退，及时回退到基础护理。' : 'If redness persists, step back to basic care.',
    monitor_stinging: locale === 'zh-CN' ? '若刺痛明显，立即减法。' : 'If stinging becomes obvious, simplify immediately.',
    monitor_new_breakouts: locale === 'zh-CN' ? '若新爆痘增加，暂停新增变量。' : 'If new breakouts increase, pause new variables.',
    retake_photo: locale === 'zh-CN' ? '建议补拍更清晰照片后再复核。' : 'Retake a clearer photo before the next reassessment.',
  };
  return map[normalizeRiskFlag(flag)] || map.monitor_stinging;
}

function localizeStepLabel(step, lang) {
  const locale = normalizeLang(lang);
  const stepType = normalizeRoutineStepType(step && step.step_type);
  const intensity = normalizeRoutineIntensity(step && step.intensity);
  const mapEn = {
    cleanse: intensity === 'gentle' || intensity === 'barrier_safe' ? 'Gentle cleanse' : 'Cleanse',
    hydrate: 'Hydrating layer',
    moisturize: intensity === 'barrier_safe' ? 'Barrier moisturizer' : 'Moisturizer',
    protect: 'Broad-spectrum sunscreen',
    treat: intensity === 'low_frequency' ? 'Low-frequency active step' : 'Targeted treatment step',
    pause: 'Pause strong actives',
    monitor: 'Track response',
  };
  const mapZh = {
    cleanse: intensity === 'gentle' || intensity === 'barrier_safe' ? '温和清洁' : '清洁',
    hydrate: '补水层',
    moisturize: intensity === 'barrier_safe' ? '屏障保湿' : '保湿',
    protect: '广谱防晒',
    treat: intensity === 'low_frequency' ? '低频活性步骤' : '针对性处理步骤',
    pause: '暂停强活性',
    monitor: '观察反应',
  };
  return (locale === 'zh-CN' ? mapZh : mapEn)[stepType] || (locale === 'zh-CN' ? '护理步骤' : 'Care step');
}

function localizeLookFor(step, lang) {
  const locale = normalizeLang(lang);
  const stepType = normalizeRoutineStepType(step && step.step_type);
  const intensity = normalizeRoutineIntensity(step && step.intensity);
  const map = {
    cleanse: locale === 'zh-CN' ? ['温和', '低刺激'] : ['gentle', 'low-irritation'],
    hydrate: locale === 'zh-CN' ? ['补水', '舒缓'] : ['hydrating', 'soothing'],
    moisturize: locale === 'zh-CN' ? ['修护', '保湿'] : ['barrier-supportive', 'moisturizing'],
    protect: locale === 'zh-CN' ? ['广谱', '高 SPF'] : ['broad-spectrum', 'high SPF'],
    treat: intensity === 'low_frequency'
      ? (locale === 'zh-CN' ? ['低频', '单一主力'] : ['low-frequency', 'single-core-active'])
      : (locale === 'zh-CN' ? ['针对性', '温和耐受'] : ['targeted', 'tolerable']),
    pause: locale === 'zh-CN' ? ['回退基础护理'] : ['simplify', 'barrier-first'],
    monitor: locale === 'zh-CN' ? ['记录变化'] : ['track changes'],
  };
  return map[stepType] || (locale === 'zh-CN' ? ['温和'] : ['gentle']);
}

function localizeStepHow(step, lang) {
  const locale = normalizeLang(lang);
  const cadence = normalizeRoutineCadence(step && step.cadence);
  const mapEn = {
    daily: 'Use daily if the skin remains calm.',
    every_other_night: 'Use every other night while tracking tolerance.',
    two_nights_weekly: 'Start with 2 nights per week.',
    hold: 'Hold this step for now.',
    as_needed: 'Use only as needed based on comfort.',
  };
  const mapZh = {
    daily: '皮肤稳定时可每天使用。',
    every_other_night: '先隔晚用，并观察耐受。',
    two_nights_weekly: '先从每周 2 晚开始。',
    hold: '这一步先暂停。',
    as_needed: '按皮肤舒适度按需使用。',
  };
  return (locale === 'zh-CN' ? mapZh : mapEn)[cadence] || (locale === 'zh-CN' ? mapZh.daily : mapEn.daily);
}

function localizeStepCaution(step, lang) {
  const locale = normalizeLang(lang);
  const intensity = normalizeRoutineIntensity(step && step.intensity);
  if (intensity === 'low_frequency') {
    return locale === 'zh-CN'
      ? '若刺痛、泛红或脱屑增加，立即回到基础护理。'
      : 'If stinging, redness, or peeling increases, revert to the basic routine.';
  }
  if (normalizeRoutineStepType(step && step.step_type) === 'protect') {
    return locale === 'zh-CN'
      ? '作为早晨最后一步固定执行。'
      : 'Keep this as the fixed final step in the morning.';
  }
  return locale === 'zh-CN'
    ? '若不适加重，优先减法。'
    : 'If discomfort worsens, simplify first.';
}

function buildDeterministicEvidence(row, lang) {
  const locale = normalizeLang(lang);
  const canonicalEvidence = row && typeof row.evidence === 'string' ? row.evidence.trim() : '';
  if (locale !== 'zh-CN' && canonicalEvidence) {
    return clampText(canonicalEvidence, 220);
  }
  const cue = localizeCueLabel(row && row.cue, lang);
  const region = localizeRegionLabel(row && row.region, lang);
  const severity = localizeSeverityLabel(row && row.severity, lang);
  if (locale === 'zh-CN') {
    return canonicalEvidence
      ? clampText(`${region}可见${severity}的${cue}信号（${canonicalEvidence}）。`, 220)
      : `${region}可见${severity}的${cue}信号。`;
  }
  return `${severity} ${cue} signal is visible around the ${region}.`;
}

function renderVisionCanonicalLayer(payload, { lang } = {}) {
  const locale = normalizeLang(lang);
  const p = normalizeVisionCanonicalLayer(payload);
  if (p.visibility_status === 'insufficient') {
    const reasonText = localizeVisibilityReason(p.insufficient_reason, locale);
    const fallbackFeatures = locale === 'zh-CN'
      ? [
          { observation: `当前照片可见信息有限，${reasonText}。`, confidence: 'not_sure' },
          { observation: '建议补拍自然光、无遮挡、清晰对焦的正脸照。', confidence: 'not_sure' },
        ]
      : [
          { observation: `Current photo signal is limited because ${reasonText}.`, confidence: 'not_sure' },
          { observation: 'Retake a clear front-facing photo in daylight with no filter or obstruction.', confidence: 'not_sure' },
        ];
    return {
      features: normalizeFeatures(fallbackFeatures, { minItems: 2, maxItems: 4, conservative: true }),
      needs_risk_check: Boolean(p.needs_risk_check),
      quality_note: locale === 'zh-CN' ? `${reasonText}。` : `${reasonText}.`,
      ...(p.limits && p.limits.length ? { limits: p.limits } : {}),
      insufficient_visual_detail: true,
    };
  }

  const observations = p.observations.map((row) => ({
    cue: row.cue,
    where: localizeRegionLabel(row.region, locale),
    severity: row.severity,
    confidence: row.confidence,
    evidence: buildDeterministicEvidence(row, locale),
  }));
  const features = observationsToLegacyFeatures(
    observations.map((row) => ({ ...row, where: row.where })),
    { maxItems: 4 },
  );
  return {
    features: normalizeFeatures(features, { minItems: 2, maxItems: 4 }),
    needs_risk_check: Boolean(p.needs_risk_check),
    ...(p.quality_note ? { quality_note: locale === 'zh-CN' ? localizeQualityNote(p.quality_note) : p.quality_note } : {}),
    ...(observations.length ? { observations } : {}),
    ...(p.limits && p.limits.length ? { limits: p.limits } : {}),
  };
}

function localizeQualityNote(note) {
  if (!note || typeof note !== 'string') return note;
  const lower = note.toLowerCase();
  if (lower.includes('clear') && lower.includes('well-lit')) return '图像清晰、光线充足，可以正常分析。';
  if (lower.includes('clear')) return '图像较清晰，可以提取信号。';
  if (lower.includes('blur') || lower.includes('blurry')) return '图像有模糊，部分信号可能受限。';
  if (lower.includes('lighting') || lower.includes('dark')) return '光线条件有限，部分信号可能不准确。';
  if (lower.includes('high resolution') || lower.includes('good quality')) return '图像质量较好，可以进行分析。';
  return '图像条件允许提取部分信号。';
}

function buildRoutineQuestionFromIntent(intent, { lang } = {}) {
  const locale = normalizeLang(lang);
  const token = normalizeFollowUpIntent(intent);
  const zh = {
    priority_symptom: '你现在最困扰的是泛红、出油还是颗粒感？',
    routine_share: '你现在 AM 和 PM 分别在用哪些步骤？',
    reaction_check: '最近使用后最明显的反应是什么？',
    tolerance_check: '最近是否有刺痛、紧绷或泛红加重？',
    photo_upload: '愿意补一张清晰自拍做更细致的分析吗？',
    confirm_plan: '这个 7 天方案你能先稳定执行吗？',
  };
  const en = {
    priority_symptom: 'What feels most dominant right now: redness, oiliness, or bumps?',
    routine_share: 'What steps are you currently using in AM and PM?',
    reaction_check: 'What reaction has been most noticeable after recent use?',
    tolerance_check: 'Any stinging, tightness, or increased redness recently?',
    photo_upload: 'Would you upload one clearer selfie for a more detailed read?',
    confirm_plan: 'Can you follow this 7-day plan consistently first?',
  };
  return (locale === 'zh-CN' ? zh : en)[token] || (locale === 'zh-CN' ? zh.priority_symptom : en.priority_symptom);
}

function buildFollowUpOptions(intent, { lang } = {}) {
  const locale = normalizeLang(lang);
  const token = normalizeFollowUpIntent(intent);
  if (token === 'reaction_check') {
    return locale === 'zh-CN'
      ? ['干燥加重', '皮肤紧绷', '刺痛/灼热', '泛红加重', '新爆痘', '无明显不适']
      : ['More dryness', 'Tightness', 'Stinging/burning', 'More redness', 'New breakouts', 'No obvious discomfort'];
  }
  if (token === 'routine_share') {
    return locale === 'zh-CN' ? ['分享 AM routine', '分享 PM routine', '我不确定'] : ['Share AM routine', 'Share PM routine', 'Not sure'];
  }
  if (token === 'photo_upload') {
    return locale === 'zh-CN' ? ['上传照片', '先跳过'] : ['Upload photo', 'Skip for now'];
  }
  if (token === 'confirm_plan') {
    return locale === 'zh-CN' ? ['可以先执行 7 天', '想更简单一点', '还想优化产品'] : ['I can follow it for 7 days', 'I need a simpler version', 'I also want product optimization'];
  }
  return locale === 'zh-CN' ? ['泛红', '出油', '颗粒感'] : ['Redness', 'Oiliness', 'Bumps'];
}

function renderDeepeningCanonicalLayer(payload, { lang } = {}) {
  const locale = normalizeLang(lang);
  const node = adjudicateDeepeningCanonicalLayer(payload, {
    inheritedPriority: payload && payload.summary_priority,
    deepeningContext: payload,
  });
  if (!node) return null;
  const advice = node.advice_items.map((item) => {
    if (WatchoutValues.includes(item)) return localizeWatchout(item, locale);
    return localizeTwoWeekFocus(item, locale);
  });
  return {
    phase: node.phase,
    next_phase: node.phase,
    question: buildRoutineQuestionFromIntent(node.question_intent, { lang: locale }),
    options: buildFollowUpOptions(node.question_intent, { lang: locale }),
    summary_focus: localizePriorityLabel(node.summary_priority, locale),
    advice_items: advice,
  };
}

function buildRoutineExpertObject({ summaryFocus, routineSteps, watchouts, riskFlags, lang } = {}) {
  const locale = normalizeLang(lang);
  const bucketed = { am_plan: [], pm_plan: [], anytime_plan: [] };
  for (const step of Array.isArray(routineSteps) ? routineSteps : []) {
    const entry = {
      step: localizeStepLabel(step, locale),
      why: `${localizePriorityLabel(step.target, locale)} -> ${Array.isArray(step.linked_cues) && step.linked_cues.length ? step.linked_cues.map((cue) => localizeCueLabel(cue, locale)).join(locale === 'zh-CN' ? ' / ' : ' / ') : localizePriorityLabel(step.target, locale)}`,
      look_for: localizeLookFor(step, locale),
      how: localizeStepHow(step, locale),
      caution: localizeStepCaution(step, locale),
    };
    const key = step.time === 'am' ? 'am_plan' : step.time === 'pm' ? 'pm_plan' : 'anytime_plan';
    bucketed[key].push(entry);
  }
  return {
    contract: 'aurora.routine_expert.v2',
    summary_focus: localizePriorityLabel(summaryFocus && summaryFocus.priority, locale),
    am_plan: bucketed.am_plan.slice(0, 4),
    pm_plan: bucketed.pm_plan.slice(0, 4),
    anytime_plan: bucketed.anytime_plan.slice(0, 4),
    watchouts: (Array.isArray(watchouts) ? watchouts : []).map((item) => localizeWatchout(item, locale)).slice(0, 4),
    risk_flags: (Array.isArray(riskFlags) ? riskFlags : []).map((item) => localizeRiskFlag(item, locale)).slice(0, 3),
  };
}

function buildStrategyFromCanonicalReport({ summaryFocus, watchouts, followUp, lang } = {}) {
  const locale = normalizeLang(lang);
  const focus = localizePriorityLabel(summaryFocus && summaryFocus.priority, locale);
  const caution = Array.isArray(watchouts) && watchouts.length
    ? localizeWatchout(watchouts[0], locale)
    : localizeWatchout('one_change_at_a_time', locale);
  const nextQuestion = buildRoutineQuestionFromIntent(followUp && followUp.intent, { lang: locale });
  if (locale === 'zh-CN') {
    return `当前重点：${focus} -> 注意事项：${caution} -> 执行路径：先按温和、单变量方案推进 7 天 -> 下一问：${nextQuestion}`;
  }
  return `Current focus: ${focus} -> Watchout: ${caution} -> Path: keep a gentle one-variable-at-a-time plan for 7 days -> Next question: ${nextQuestion}`;
}

function renderReportCanonicalLayer(payload, { lang, quality, reportContext, deepening } = {}) {
  const locale = normalizeLang(lang);
  const p = adjudicateReportCanonicalLayer(payload, { reportContext, deepening });
  const findings = p.insights.map((row) => ({
    cue: row.cue,
    where: localizeRegionLabel(row.region, locale),
    severity: row.severity,
    confidence: row.confidence,
    evidence: buildDeterministicEvidence(row, locale),
  }));
  const guidanceBrief = Array.from(
    new Set([
      ...p.watchouts.map((item) => localizeWatchout(item, locale)),
      ...p.two_week_focus.map((item) => localizeTwoWeekFocus(item, locale)),
    ]),
  ).slice(0, 5);
  const followUp = normalizeCanonicalFollowUp(p.follow_up);
  const primaryQuestion = buildRoutineQuestionFromIntent(followUp.intent, { lang: locale });
  const conditionalFollowups = Array.isArray(followUp.conditional_followups)
    ? followUp.conditional_followups.map((item) => buildRoutineQuestionFromIntent(item, { lang: locale })).slice(0, 3)
    : [];
  const renderedDeepening = p.deepening ? renderDeepeningCanonicalLayer(p.deepening, { lang: locale }) : null;
  const routineExpert = buildRoutineExpertObject({
    summaryFocus: p.summary_focus,
    routineSteps: p.routine_steps,
    watchouts: p.watchouts,
    riskFlags: p.risk_flags,
    lang: locale,
  });
  return {
    strategy: buildStrategyFromCanonicalReport({ summaryFocus: p.summary_focus, watchouts: p.watchouts, followUp, lang: locale }),
    needs_risk_check: Boolean(p.needs_risk_check),
    primary_question: primaryQuestion,
    conditional_followups: conditionalFollowups,
    routine_expert: routineExpert,
    reasoning: guidanceBrief.slice(0, 4),
    ...(renderedDeepening ? { deepening: renderedDeepening } : {}),
    ...(quality ? { quality: normalizeQualityInfo(quality) } : {}),
    findings,
    guidance_brief: guidanceBrief,
    next_step_options: normalizeNextStepOptions(
      locale === 'zh-CN'
        ? [
            { id: 'analysis_get_recommendations', label: '获取产品推荐' },
            { id: 'analysis_optimize_existing', label: '优化现有产品' },
            { id: 'analysis_both_reco_optimize', label: '两者都要' },
          ]
        : [
            { id: 'analysis_get_recommendations', label: 'Get recommendations' },
            { id: 'analysis_optimize_existing', label: 'Optimize existing products' },
            { id: 'analysis_both_reco_optimize', label: 'Both' },
          ],
    ),
    two_week_focus: p.two_week_focus.map((item) => localizeTwoWeekFocus(item, locale)),
  };
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
  const allowed = new Set(['features', 'needs_risk_check', 'quality_note', 'observations', 'limits', 'insufficient_visual_detail']);
  for (const key of Object.keys(p)) {
    if (!allowed.has(key)) errors.push(`/${key} is not allowed`);
  }

  const hasLegacyShape = Array.isArray(p.features) || typeof p.needs_risk_check === 'boolean';
  const hasNewShape = Array.isArray(p.observations) || p.quality_note != null || p.limits != null || typeof p.insufficient_visual_detail === 'boolean';
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
  if (p.insufficient_visual_detail != null && typeof p.insufficient_visual_detail !== 'boolean') {
    errors.push('/insufficient_visual_detail must be boolean');
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
  if (p.visibility_status || p.insufficient_reason || p.region || (Array.isArray(p.observations) && p.observations.some((row) => row && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, 'region')))) {
    return renderVisionCanonicalLayer(p, { lang: 'en-US' });
  }
  const observations = normalizeObservations(p.observations, { maxItems: 8 });
  const insufficientVisualDetail = typeof p.insufficient_visual_detail === 'boolean' ? p.insufficient_visual_detail : observations.length === 0;
  const features = Array.isArray(p.features) && p.features.length
    ? normalizeFeatures(p.features, { minItems: 2, maxItems: 4, conservative: insufficientVisualDetail })
    : observations.length
      ? observationsToLegacyFeatures(observations, { maxItems: 4 })
      : insufficientVisualDetail
        ? normalizeFeatures([], { minItems: 2, maxItems: 4, conservative: true })
        : [];
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
    ...(Array.isArray(features) && features.length ? { features: normalizeFeatures(features, { minItems: 2, maxItems: 4, conservative: insufficientVisualDetail }) } : {}),
    needs_risk_check: Boolean(needsRiskCheck),
    ...(qualityNote !== undefined ? { quality_note: qualityNote } : {}),
    ...(observations.length ? { observations } : {}),
    ...(limits.length ? { limits } : {}),
    ...(insufficientVisualDetail ? { insufficient_visual_detail: true } : {}),
  };
}

function normalizeReportStrategyLayer(payload, { lang } = {}) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  if (p.summary_focus || p.routine_steps || p.watchouts || p.follow_up) {
    return renderReportCanonicalLayer(p, { lang, quality: p.quality });
  }
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
  const visionInsufficient = Boolean(vision && vision.insufficient_visual_detail);

  const deterministicFeatures = normalizeFeatures(deterministic.features, { minItems: 2, maxItems: 4 });
  const visionFeatures = vision
    ? visionInsufficient
      ? []
      : Array.isArray(vision.features) && vision.features.length
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
    ...(visionInsufficient ? { insufficient_visual_detail: true } : {}),
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
  SkinVisionGatewaySchema,
  SkinVisionCanonicalSchema,
  SkinReportStrategySchema,
  SkinReportCanonicalSchema,
  SkinReportCanonicalLlmSchema,
  SkinDeepeningCanonicalSchema,
  validateFinalContract,
  validateVisionObservation,
  validateVisionCanonicalLayer,
  validateReportStrategy,
  validateReportCanonicalLayer,
  validateDeepeningCanonicalLayer,
  mapQualityToMode,
  buildPoorPhotoTemplate,
  buildFactLayer,
  deriveAsk3Questions,
  finalizeSkinAnalysisContract,
  mergeFinalContractIntoAnalysis,
  normalizeVisionCanonicalLayer,
  normalizeReportCanonicalLayer,
  normalizeDeepeningCanonicalLayer,
  normalizeVisionObservationLayer,
  normalizeReportStrategyLayer,
  renderVisionCanonicalLayer,
  renderReportCanonicalLayer,
  renderDeepeningCanonicalLayer,
  adjudicateReportCanonicalLayer,
  adjudicateDeepeningCanonicalLayer,
  evaluateVisionCanonicalSemantic,
  evaluateReportCanonicalSemantic,
  evaluateDeepeningCanonicalSemantic,
};
