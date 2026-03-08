const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSkinVisionPromptBundle,
  buildSkinReportPromptBundle,
  buildSkinDeepeningPromptBundle,
  isSkinPromptV3,
  isSkinDeepeningV2,
} = require('../src/auroraBff/skinLlmPrompts');
const {
  SkinReportCanonicalSchema,
  SkinReportCanonicalLlmSchema,
  normalizeVisionCanonicalLayer,
  validateVisionCanonicalLayer,
  evaluateVisionCanonicalSemantic,
  renderVisionCanonicalLayer,
  normalizeReportCanonicalLayer,
  adjudicateReportCanonicalLayer,
  validateReportCanonicalLayer,
  evaluateReportCanonicalSemantic,
  renderReportCanonicalLayer,
  normalizeDeepeningCanonicalLayer,
  adjudicateDeepeningCanonicalLayer,
  validateDeepeningCanonicalLayer,
  evaluateDeepeningCanonicalSemantic,
  renderDeepeningCanonicalLayer,
  validateReportStrategy,
  validateVisionObservation,
} = require('../src/auroraBff/skinAnalysisContract');
const { __internal: routesInternal } = require('../src/auroraBff/routes');

test('skin prompt v3: canonical vision and report prompts ignore locale-specific reasoning', () => {
  assert.equal(isSkinPromptV3('skin_v3'), true);
  assert.equal(isSkinPromptV3('skin_v3_canonical'), true);
  assert.equal(isSkinPromptV3('skin_report_v3_canonical'), true);
  assert.equal(isSkinPromptV3('skin_vision_v3_canonical'), true);
  assert.equal(isSkinPromptV3('skin_report_v3_hardened'), false);
  assert.equal(isSkinPromptV3('skin_vision_v2_hardened'), false);

  const vision = buildSkinVisionPromptBundle({
    language: 'zh-CN',
    promptVersion: 'skin_v3',
    dto: { quality: { grade: 'pass' } },
  });
  assert.equal(vision.promptVersion, 'skin_vision_v3_canonical');
  assert.match(vision.systemInstruction, /Reason in English only/);
  assert.match(vision.userPrompt, /English-only canonical semantics/);

  const report = buildSkinReportPromptBundle({
    language: 'zh-CN',
    promptVersion: 'skin_v3',
    dto: { quality: { grade: 'pass' } },
  });
  assert.equal(report.promptVersion, 'skin_report_v3_canonical');
  assert.match(report.systemInstruction, /Reason in English only/);

  const deepening = buildSkinDeepeningPromptBundle({
    language: 'zh-CN',
    promptVersion: 'skin_deepening_v2_canonical',
    dto: { phase: 'photo_optin' },
  });
  assert.equal(deepening.promptVersion, 'skin_deepening_v2_canonical');
  assert.match(deepening.systemInstruction, /Reason in English only/);
});

test('skin prompt v3: explicit canonical ids still route to canonical builders while hardened ids stay mainline', () => {
  assert.equal(isSkinDeepeningV2('skin_deepening_v2_canonical'), true);
  assert.equal(isSkinDeepeningV2('skin_deepening_v2_hardened'), false);
  assert.equal(isSkinDeepeningV2('skin_v3'), false);

  const reportCanonical = buildSkinReportPromptBundle({
    language: 'en-US',
    promptVersion: 'skin_report_v3_canonical',
    dto: { quality: { grade: 'pass' } },
  });
  assert.equal(reportCanonical.promptVersion, 'skin_report_v3_canonical');
  assert.match(reportCanonical.systemInstruction, /Reason in English only/);

  const visionCanonical = buildSkinVisionPromptBundle({
    language: 'en-US',
    promptVersion: 'skin_vision_v3_canonical',
    dto: { quality: { grade: 'pass' } },
  });
  assert.equal(visionCanonical.promptVersion, 'skin_vision_v3_canonical');
  assert.match(visionCanonical.systemInstruction, /Reason in English only/);

  const deepeningMainline = buildSkinDeepeningPromptBundle({
    language: 'en-US',
    promptVersion: 'skin_deepening_v2_hardened',
    dto: { phase: 'photo_optin' },
  });
  assert.equal(deepeningMainline.promptVersion, 'skin_deepening_v2_hardened');
  assert.doesNotMatch(deepeningMainline.systemInstruction, /Reason in English only/);
});

test('skin prompt v3: vision semantic guard rejects empty pass-quality output and renderer localizes zh output', () => {
  const emptyCanonical = normalizeVisionCanonicalLayer({
    visibility_status: 'limited',
    needs_risk_check: false,
    observations: [],
  });
  const validation = validateVisionCanonicalLayer(emptyCanonical);
  assert.equal(validation.ok, true);
  const semantic = evaluateVisionCanonicalSemantic(emptyCanonical, { quality: { grade: 'pass' } });
  assert.equal(semantic.ok, false);
  assert.equal(semantic.code, 'SEMANTIC_EMPTY');

  const strongCanonical = normalizeVisionCanonicalLayer({
    visibility_status: 'sufficient',
    needs_risk_check: false,
    observations: [
      { cue: 'redness', region: 'cheeks', severity: 'mild', confidence: 'med', evidence: 'diffuse pink tone' },
      { cue: 'shine', region: 't_zone', severity: 'moderate', confidence: 'high', evidence: 'specular highlight' },
    ],
  });
  const rendered = renderVisionCanonicalLayer(strongCanonical, { lang: 'zh-CN' });
  assert.equal(validateVisionObservation(rendered).ok, true);
  assert.equal(Array.isArray(rendered.observations), true);
  assert.match(rendered.observations[0].where, /面颊|T区|额头|全脸/);
  assert.match(rendered.observations[0].evidence, /可见/);
});

test('skin prompt v3: report renderer creates valid localized deterministic output', () => {
  const canonical = normalizeReportCanonicalLayer({
    needs_risk_check: false,
    summary_focus: { priority: 'barrier', primary_cues: ['redness', 'texture'] },
    insights: [
      { cue: 'redness', region: 'cheeks', severity: 'mild', confidence: 'med', evidence: 'diffuse pink tone' },
      { cue: 'texture', region: 'chin', severity: 'moderate', confidence: 'med', evidence: 'rough texture clusters' },
    ],
    routine_steps: [
      { time: 'am', step_type: 'cleanse', target: 'barrier', cadence: 'daily', intensity: 'gentle', linked_cues: ['redness'] },
      { time: 'am', step_type: 'protect', target: 'tone', cadence: 'daily', intensity: 'standard', linked_cues: ['redness'] },
      { time: 'pm', step_type: 'moisturize', target: 'barrier', cadence: 'daily', intensity: 'barrier_safe', linked_cues: ['redness', 'texture'] },
      { time: 'pm', step_type: 'treat', target: 'texture', cadence: 'two_nights_weekly', intensity: 'low_frequency', linked_cues: ['texture'] },
    ],
    watchouts: ['avoid_stacking_strong_actives', 'pause_if_stinging'],
    follow_up: { intent: 'routine_share', conditional_followups: ['tolerance_check'] },
    two_week_focus: ['stabilize_barrier', 'track_redness'],
    risk_flags: ['monitor_stinging'],
    deepening: {
      phase: 'products',
      summary_priority: 'barrier',
      advice_items: ['protect_barrier', 'confirm_tolerance'],
      question_intent: 'routine_share',
    },
  });
  assert.equal(validateReportCanonicalLayer(canonical).ok, true);
  assert.equal(evaluateReportCanonicalSemantic(canonical).ok, true);

  const rendered = renderReportCanonicalLayer(canonical, {
    lang: 'zh-CN',
    quality: { grade: 'pass', issues: [] },
  });
  assert.equal(validateReportStrategy(rendered).ok, true);
  assert.match(rendered.strategy, /当前重点|执行路径/);
  assert.equal(Array.isArray(rendered.guidance_brief), true);
  assert.equal(Array.isArray(rendered.next_step_options), true);
  assert.match(rendered.next_step_options[0].label, /获取产品推荐|优化现有产品|两者都要/);
  assert.equal(typeof rendered.routine_expert, 'object');
});

test('skin prompt v3: deepening canonical renderer stays phase-safe and deterministic', () => {
  const canonical = normalizeDeepeningCanonicalLayer({
    phase: 'reactions',
    summary_priority: 'barrier',
    advice_items: ['protect_barrier', 'confirm_tolerance'],
    question_intent: 'reaction_check',
  });
  assert.equal(validateDeepeningCanonicalLayer(canonical).ok, true);
  assert.equal(evaluateDeepeningCanonicalSemantic(canonical).ok, true);
  const rendered = renderDeepeningCanonicalLayer(canonical, { lang: 'en-US' });
  assert.equal(rendered.phase, 'reactions');
  assert.equal(Array.isArray(rendered.options), true);
  assert.equal(rendered.options.length >= 3, true);
  assert.match(rendered.question, /reaction|noticeable|redness|stinging/i);
});

test('skin prompt v3: report LLM transport schema excludes deepening while internal canonical keeps it', () => {
  assert.equal(Boolean(SkinReportCanonicalSchema.properties.deepening), true);
  assert.equal(Boolean(SkinReportCanonicalLlmSchema.properties.deepening), false);
});

test('skin prompt v3: strict canonical ingress does not invent mixed priority or texture-linked steps', () => {
  const strictCanonical = normalizeReportCanonicalLayer(
    {
      needs_risk_check: false,
      summary_focus: {},
      insights: [],
      routine_steps: [{ time: 'am', step_type: 'cleanse' }],
      watchouts: [],
      follow_up: {},
      two_week_focus: [],
      risk_flags: [],
    },
    { strict: true },
  );
  assert.deepEqual(strictCanonical.summary_focus, {});
  assert.deepEqual(strictCanonical.follow_up, {});
  assert.equal(Array.isArray(strictCanonical.routine_steps), true);
  assert.equal(strictCanonical.routine_steps[0].linked_cues, undefined);
});

test('skin prompt v3: report adjudication resolves deterministic priority from report context', () => {
  const strictCanonical = normalizeReportCanonicalLayer(
    {
      needs_risk_check: false,
      summary_focus: { priority: 'mixed', primary_cues: [] },
      insights: [
        { cue: 'redness', region: 'cheeks', severity: 'mild', confidence: 'high', evidence: 'diffuse cheek redness' },
      ],
      routine_steps: [
        { time: 'am', step_type: 'cleanse', target: 'barrier', cadence: 'daily', intensity: 'gentle', linked_cues: ['redness'] },
      ],
      watchouts: [],
      follow_up: {},
      two_week_focus: [],
      risk_flags: [],
    },
    { strict: true },
  );
  const adjudicated = adjudicateReportCanonicalLayer(strictCanonical, {
    reportContext: {
      concern_rank: ['redness', 'texture'],
      deterministic_signals: { redness: 'high', oiliness: 'low', acne_like: 'none', dryness: 'some', texture: 'ok' },
      routine_summary: { moisturizer: 'yes', sunscreen: 'yes' },
      locked_features_summary: ['visible redness around the cheeks'],
      quality: { grade: 'pass' },
    },
  });
  assert.equal(adjudicated.summary_focus.priority, 'redness');
  assert.deepEqual(adjudicated.summary_focus.primary_cues.slice(0, 1), ['redness']);
  assert.equal(adjudicated.follow_up.intent, 'tolerance_check');
  assert.deepEqual(adjudicated.follow_up.conditional_followups, ['routine_share']);
  assert.equal(adjudicated.insights.length, 1);
});

test('skin prompt v3: report adjudication forces barrier-first plan for sensitive active routines', () => {
  const strictCanonical = normalizeReportCanonicalLayer(
    {
      needs_risk_check: true,
      summary_focus: { priority: 'redness', primary_cues: ['redness', 'texture'] },
      insights: [
        { cue: 'redness', region: 'cheeks', severity: 'moderate', confidence: 'high', evidence: 'cheek redness' },
        { cue: 'texture', region: 'chin', severity: 'mild', confidence: 'med', evidence: 'chin texture' },
        { cue: 'flaking', region: 'full_face', severity: 'mild', confidence: 'med', evidence: 'surface dryness' },
      ],
      routine_steps: [],
      watchouts: [],
      follow_up: { intent: 'reaction_check', conditional_followups: ['tolerance_check'] },
      two_week_focus: [],
      risk_flags: [],
    },
    { strict: true },
  );
  const adjudicated = adjudicateReportCanonicalLayer(strictCanonical, {
    reportContext: {
      concern_rank: ['redness', 'texture'],
      deterministic_signals: { redness: 'mid', oiliness: 'low', acne_like: 'few', dryness: 'some', texture: 'rough' },
      routine_summary: { moisturizer: 'yes', sunscreen: 'unknown', actives: ['retinoid'] },
      constraints: ['sensitive-skin self-report'],
      locked_features_summary: ['mild redness on cheeks', 'rough texture around chin'],
      quality: { grade: 'pass' },
    },
  });
  assert.equal(adjudicated.summary_focus.priority, 'barrier');
  assert.deepEqual([...adjudicated.summary_focus.primary_cues].sort(), ['redness', 'texture']);
  assert.deepEqual(adjudicated.follow_up, { intent: 'reaction_check', conditional_followups: ['routine_share'] });
  assert.deepEqual(
    adjudicated.insights.map((row) => `${row.cue}:${row.region}:${row.severity}`),
    ['redness:cheeks:moderate', 'texture:chin:moderate'],
  );
});

test('skin prompt v3: deepening adjudication preserves inherited priority and sorts advice items', () => {
  const canonical = adjudicateDeepeningCanonicalLayer(
    normalizeDeepeningCanonicalLayer(
      {
        phase: 'reactions',
        summary_priority: 'mixed',
        advice_items: ['track_redness', 'protect_barrier', 'confirm_tolerance'],
        question_intent: 'reaction_check',
      },
      { strict: true, inheritedPriority: 'barrier' },
    ),
    { inheritedPriority: 'barrier', deepeningContext: { phase: 'reactions' } },
  );
  assert.equal(canonical.summary_priority, 'barrier');
  assert.deepEqual(canonical.advice_items, ['protect_barrier', 'confirm_tolerance', 'track_redness']);
});

test('skin prompt v3: routes mainline deepening helper resolves products and reactions phases deterministically', () => {
  const products = routesInternal.buildMainlineDeepeningDto({
    language: 'en-US',
    promptVersion: 'skin_v3',
    userRequestedPhoto: true,
    photosProvided: true,
    hasRoutine: false,
    routineCandidate: null,
    profileSummary: { goals: ['calm redness'] },
    recentLogsSummary: [],
    qualityObject: { grade: 'pass' },
    reportCanonical: { summary_focus: { priority: 'redness' }, watchouts: [], two_week_focus: [] },
    visionCanonical: null,
  });
  assert.equal(products.phasePlan.phase, 'products');
  assert.equal(products.dto.question_intent, 'routine_share');

  const reactions = routesInternal.buildMainlineDeepeningDto({
    language: 'en-US',
    promptVersion: 'skin_v3',
    userRequestedPhoto: true,
    photosProvided: true,
    hasRoutine: true,
    routineCandidate: 'retinoid pm',
    profileSummary: { goals: ['calm redness'] },
    recentLogsSummary: [{ reaction: 'stinging after serum' }],
    qualityObject: { grade: 'pass' },
    reportCanonical: {
      summary_focus: { priority: 'barrier' },
      watchouts: ['pause_if_stinging'],
      two_week_focus: ['confirm_tolerance'],
      insights: [{ cue: 'redness', region: 'cheeks', severity: 'mild', confidence: 'low', evidence: 'pink tone' }],
    },
    visionCanonical: null,
  });
  assert.equal(reactions.phasePlan.phase, 'reactions');
  assert.equal(reactions.dto.question_intent, 'reaction_check');
});
