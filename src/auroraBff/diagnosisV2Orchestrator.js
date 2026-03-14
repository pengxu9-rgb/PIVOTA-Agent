'use strict';

const crypto = require('crypto');
const {
  buildStage1Prompt,
  buildStage2Prompt,
  buildStage3Prompt,
  PROMPT_VERSION,
} = require('./diagnosisV2Prompts');
const { validateResultPayload } = require('./diagnosisV2Schema');
const { extractJsonObject, extractJsonObjectByKeys, parseJsonOnlyObject } = require('./jsonExtract');
const {
  listRecentDiagnosisArtifacts,
  saveDiagnosisArtifact,
} = require('./diagnosisArtifactStore');
const { buildAnalysisContextSnapshotV1 } = require('./analysisContextSnapshot');

function generateDiagnosisId() {
  return crypto.randomUUID();
}

function getCtxAuroraUid(ctx = {}) {
  return cleanString(ctx.auroraUid || ctx.aurora_uid || (!ctx.accountUserId ? ctx.userId : '')) || null;
}

function getCtxAccountUserId(ctx = {}) {
  return cleanString(ctx.accountUserId || ctx.account_user_id || ctx.userId) || null;
}

function buildDiagnosisIdentity(ctx = {}) {
  return {
    auroraUid: getCtxAuroraUid(ctx),
    userId: getCtxAccountUserId(ctx),
  };
}

function detectColdStart(ctx) {
  const profile = ctx.profile || {};
  const hasCheckinLogs = Array.isArray(ctx.recentLogs) && ctx.recentLogs.length > 0;
  const hasRoutine = Boolean(ctx.currentRoutine && ctx.currentRoutine !== 'none');
  const hasProfile = Boolean(profile.skinType || profile.barrierStatus || profile.sensitivity);
  return !hasCheckinLogs && !hasRoutine && !hasProfile;
}

function detectMissingDataDimensions(ctx) {
  const missing = [];
  if (!ctx.hasPhoto) missing.push('photo');
  if (!ctx.currentRoutine || ctx.currentRoutine === 'none') missing.push('routine');
  if (!Array.isArray(ctx.recentLogs) || ctx.recentLogs.length === 0) missing.push('checkin');
  if (!Array.isArray(ctx.travelPlans) || ctx.travelPlans.length === 0) missing.push('travel');
  return missing;
}

function compactDiagnosisSummary(artifact) {
  if (!artifact || typeof artifact !== 'object') return null;
  const data = artifact.data || artifact;
  return {
    diagnosis_id: data.diagnosis_id || artifact.id,
    date: artifact.created_at || data.created_at,
    goals: data.goal_profile?.selected_goals || [],
    inferred_axes_summary: (data.inferred_state?.axes || []).map((axis) => ({
      axis: axis.axis,
      level: axis.level,
      confidence: axis.confidence,
    })),
    strategies_summary: (data.strategies || []).map((strategy) => strategy.title),
    data_quality: data.data_quality?.overall || 'low',
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanStringList(value, { limit } = {}) {
  const list = Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
  return typeof limit === 'number' ? list.slice(0, limit) : list;
}

function parseLlmJsonObject(text, requiredKeys = []) {
  const raw = cleanString(text);
  if (!raw) return null;
  return parseJsonOnlyObject(raw) || extractJsonObjectByKeys(raw, requiredKeys) || extractJsonObject(raw);
}

function normalizeConfidence(value, { fallback = 0.4, cap = 1 } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return Math.min(cap, fallback);
  if (num < 0) return 0;
  if (num > cap) return cap;
  return num;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  const token = cleanString(value).toLowerCase();
  if (token === 'true' || token === 'yes') return true;
  if (token === 'false' || token === 'no') return false;
  return null;
}

function normalizeNonNegativeInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const int = Math.trunc(num);
  return int >= 0 ? int : null;
}

function normalizePostProcedureMeta(value) {
  if (!isPlainObject(value)) return null;
  const daysSince = normalizeNonNegativeInt(value.days_since);
  const skinBroken = normalizeBoolean(value.skin_broken);
  if (daysSince == null || skinBroken == null) return null;
  const procedureType = cleanString(value.procedure_type);
  return {
    days_since: daysSince,
    skin_broken: skinBroken,
    ...(procedureType ? { procedure_type: procedureType } : {}),
  };
}

function dedupeBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Result action labels & improvement tips
// ---------------------------------------------------------------------------

function defaultResultActionLabel(type, language) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const labels = {
    take_photo: { CN: '补充照片', EN: 'Add photo' },
    setup_routine: { CN: '建立日常流程', EN: 'Set up routine' },
    start_checkin: { CN: '开始打卡', EN: 'Start check-in' },
    direct_reco: { CN: '查看推荐', EN: 'See recommendations' },
    intake_optimize: { CN: '补充更多信息', EN: 'Add more context' },
  };
  return labels[type]?.[lang] || type;
}

function defaultImprovementTip(type, language) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const tips = {
    take_photo: {
      CN: '补充自然光照片后，我可以给出更稳妥的状态判断。',
      EN: 'Add a natural-light photo so I can give a more reliable assessment.',
    },
    setup_routine: {
      CN: '补充你现在的 AM/PM 护理步骤后，我可以把建议收得更具体。',
      EN: 'Add your current AM/PM routine so I can make the plan more specific.',
    },
    start_checkin: {
      CN: '开始记录一段时间的状态变化后，我可以更好地判断趋势。',
      EN: 'Start logging changes over time so I can assess trends more accurately.',
    },
    intake_optimize: {
      CN: '补充更多日常和场景信息后，我可以进一步优化策略。',
      EN: 'Add more context about your routine and environment so I can refine the plan.',
    },
  };
  return tips[type]?.[lang] || (lang === 'CN' ? '补充更多信息以提升准确度。' : 'Add more context to improve accuracy.');
}

// ---------------------------------------------------------------------------
// Action type normalization
// ---------------------------------------------------------------------------

function normalizeResultActionType(value) {
  const token = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!token) return null;
  if (token === 'take_photo' || token === 'photo' || token === 'add_photo' || token === 'upload_photo') return 'take_photo';
  if (token === 'setup_routine' || token === 'routine' || token === 'build_routine' || token === 'routine_setup' || token === 'start_routine') return 'setup_routine';
  if (token === 'start_checkin' || token === 'checkin' || token === 'check_in' || token === 'begin_checkin') return 'start_checkin';
  if (token === 'direct_reco' || token === 'reco' || token === 'recommend' || token === 'recommend_products' || token === 'get_recommendations') return 'direct_reco';
  if (token === 'intake_optimize' || token === 'intake' || token === 'complete_intake' || token === 'travel' || token === 'add_travel') return 'intake_optimize';
  return null;
}

function normalizeImprovementActionType(value) {
  const token = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!token) return null;
  if (token === 'take_photo' || token === 'photo' || token === 'add_photo' || token === 'upload_photo') return 'take_photo';
  if (token === 'setup_routine' || token === 'routine' || token === 'build_routine' || token === 'routine_setup' || token === 'start_routine') return 'setup_routine';
  if (token === 'start_checkin' || token === 'checkin' || token === 'check_in' || token === 'begin_checkin') return 'start_checkin';
  if (token === 'intake_optimize' || token === 'intake' || token === 'complete_intake' || token === 'travel' || token === 'add_travel') return 'intake_optimize';
  return null;
}

// ---------------------------------------------------------------------------
// Stage 1 followup question normalization & fallback
// ---------------------------------------------------------------------------

function buildFallbackFollowupQuestions({ goals, ctx, isColdStart }) {
  const lang = ctx.language === 'CN' ? 'CN' : 'EN';
  const selectedGoals = cleanStringList(goals, { limit: 3 });
  const goalText = selectedGoals.join(', ');

  const coldStartQuestions = [
    {
      id: 'fq_skin_state',
      question: lang === 'CN' ? '你现在的皮肤状态更接近哪一种？' : 'Which best matches your skin right now?',
      options: [
        { id: 'stable', label: lang === 'CN' ? '整体稳定' : 'Mostly stable', value: 'stable' },
        { id: 'red_irritated', label: lang === 'CN' ? '容易泛红/刺激' : 'Easily red or irritated', value: 'red_irritated' },
        { id: 'tight_flaky', label: lang === 'CN' ? '紧绷/起皮' : 'Tight or flaky', value: 'tight_flaky' },
        { id: 'breakout_prone', label: lang === 'CN' ? '容易爆痘' : 'Breakout-prone', value: 'breakout_prone' },
      ],
    },
    {
      id: 'fq_actives_history',
      question: lang === 'CN' ? '你对酸类、A 醇或高活性成分的耐受度如何？' : 'How does your skin usually react to strong actives?',
      options: [
        { id: 'first_time', label: lang === 'CN' ? '几乎没用过' : 'I rarely use them', value: 'first_time' },
        { id: 'tolerates_ok', label: lang === 'CN' ? '一般能接受' : 'Usually tolerates them', value: 'tolerates_ok' },
        { id: 'irritates_easily', label: lang === 'CN' ? '容易刺激' : 'Irritates easily', value: 'irritates_easily' },
      ],
    },
    {
      id: 'fq_sunscreen',
      question: lang === 'CN' ? '你平时的防晒习惯如何？' : 'How often do you use sunscreen?',
      options: [
        { id: 'daily', label: lang === 'CN' ? '几乎每天' : 'Almost every day', value: 'daily' },
        { id: 'sometimes', label: lang === 'CN' ? '偶尔会用' : 'Only some days', value: 'sometimes' },
        { id: 'rarely', label: lang === 'CN' ? '很少使用' : 'Rarely', value: 'rarely' },
      ],
    },
  ];

  const defaultQuestions = [
    {
      id: 'fq_recent_change',
      question: lang === 'CN'
        ? `最近最想先处理的变化是什么${goalText ? `（${goalText}）` : ''}？`
        : `What changed most recently${goalText ? ` for ${goalText}` : ''}?`,
      options: [
        { id: 'worse_recently', label: lang === 'CN' ? '最近变差了' : 'It recently got worse', value: 'worse_recently' },
        { id: 'same_but_stubborn', label: lang === 'CN' ? '一直存在但顽固' : 'It is stubborn but stable', value: 'same_but_stubborn' },
        { id: 'preventive', label: lang === 'CN' ? '主要想提前预防' : 'I mainly want prevention', value: 'preventive' },
      ],
    },
    {
      id: 'fq_sensitivity_window',
      question: lang === 'CN' ? '最近 2 周皮肤更偏向哪种反应？' : 'Over the last 2 weeks, which pattern feels most true?',
      options: [
        { id: 'calm', label: lang === 'CN' ? '相对平稳' : 'Mostly calm', value: 'calm' },
        { id: 'dry_tight', label: lang === 'CN' ? '偏干紧绷' : 'Dry or tight', value: 'dry_tight' },
        { id: 'red_reactive', label: lang === 'CN' ? '容易泛红' : 'Reactive or red', value: 'red_reactive' },
        { id: 'breakouts', label: lang === 'CN' ? '反复冒痘' : 'Repeat breakouts', value: 'breakouts' },
      ],
    },
    {
      id: 'fq_preference',
      question: lang === 'CN' ? '这次更希望我优先哪种方案？' : 'What should I prioritize this time?',
      options: [
        { id: 'gentle', label: lang === 'CN' ? '更温和稳妥' : 'Gentle and steady', value: 'gentle' },
        { id: 'balanced', label: lang === 'CN' ? '平衡效果和刺激' : 'Balanced', value: 'balanced' },
        { id: 'faster', label: lang === 'CN' ? '更在意速度' : 'Faster visible progress', value: 'faster' },
      ],
    },
  ];

  const postProcedureQuestions = [
    {
      id: 'fq_days_since',
      question: lang === 'CN' ? '距离项目/医美操作过去多久了？' : 'How long has it been since the procedure?',
      options: [
        { id: 'days_0_3', label: lang === 'CN' ? '0-3 天' : '0-3 days', value: '0_3_days' },
        { id: 'days_4_7', label: lang === 'CN' ? '4-7 天' : '4-7 days', value: '4_7_days' },
        { id: 'days_8_14', label: lang === 'CN' ? '1-2 周' : '1-2 weeks', value: '8_14_days' },
        { id: 'days_15_plus', label: lang === 'CN' ? '超过 2 周' : 'More than 2 weeks', value: '15_plus_days' },
      ],
    },
    {
      id: 'fq_skin_open',
      question: lang === 'CN' ? '目前皮肤是否有破损、渗出或开放性伤口？' : 'Is the skin currently broken, open, or oozing?',
      options: [
        { id: 'yes', label: lang === 'CN' ? '有' : 'Yes', value: 'yes' },
        { id: 'no', label: lang === 'CN' ? '没有' : 'No', value: 'no' },
        { id: 'not_sure', label: lang === 'CN' ? '不确定' : 'Not sure', value: 'not_sure' },
      ],
    },
    {
      id: 'fq_current_feel',
      question: lang === 'CN' ? '当前最明显的不适是什么？' : 'What feels most noticeable right now?',
      options: [
        { id: 'heat_redness', label: lang === 'CN' ? '发热泛红' : 'Heat or redness', value: 'heat_redness' },
        { id: 'tight_dry', label: lang === 'CN' ? '紧绷干燥' : 'Tight or dry', value: 'tight_dry' },
        { id: 'itch_sting', label: lang === 'CN' ? '刺痛/发痒' : 'Itching or stinging', value: 'itch_sting' },
      ],
    },
  ];

  if (selectedGoals.some((goal) => goal.toLowerCase().includes('post_procedure'))) return postProcedureQuestions;
  return isColdStart ? coldStartQuestions : defaultQuestions;
}

function normalizeFollowupQuestions(value, { goals, ctx, isColdStart }) {
  const fallback = buildFallbackFollowupQuestions({ goals, ctx, isColdStart });
  const normalized = Array.isArray(value)
    ? value
        .map((question, index) => {
          if (!isPlainObject(question)) return null;
          const fallbackQuestion = fallback[index] || fallback[fallback.length - 1];
          const prompt = cleanString(question.question) || fallbackQuestion?.question;
          const options = Array.isArray(question.options)
            ? question.options
                .map((option, optionIndex) => {
                  if (!isPlainObject(option)) return null;
                  const label = cleanString(option.label);
                  const fallbackOption =
                    fallbackQuestion && Array.isArray(fallbackQuestion.options)
                      ? fallbackQuestion.options[optionIndex] || fallbackQuestion.options[0]
                      : null;
                  const fallbackLabel = fallbackOption ? cleanString(fallbackOption.label) : '';
                  const resolvedLabel = label || fallbackLabel;
                  if (!resolvedLabel) return null;
                  return {
                    id: cleanString(option.id) || (fallbackOption ? cleanString(fallbackOption.id) : '') || `opt_${index}_${optionIndex}`,
                    label: resolvedLabel,
                    value: cleanString(option.value) || resolvedLabel,
                  };
                })
                .filter(Boolean)
                .slice(0, 5)
            : [];
          if (!prompt) return null;
          return {
            id: cleanString(question.id) || fallbackQuestion?.id || `fq_${index}`,
            question: prompt,
            options: options.length >= 2 ? options : fallbackQuestion?.options || [],
            required: false,
          };
        })
        .filter(Boolean)
        .slice(0, 3)
    : [];

  return normalized.length ? normalized : fallback;
}

// ---------------------------------------------------------------------------
// Stage 2 inference normalization & fallback
// ---------------------------------------------------------------------------

function buildFallbackEvidence({ goalProfile, followupAnswers, hasPhoto, ctx, axisLabel }) {
  const lang = ctx.language === 'CN' ? 'CN' : 'EN';
  const evidence = [];
  const selectedGoals = cleanStringList(goalProfile?.selected_goals, { limit: 2 });
  if (selectedGoals.length) {
    evidence.push(lang === 'CN' ? `目标偏好：${selectedGoals.join('、')}` : `Selected goals: ${selectedGoals.join(', ')}`);
  }
  const answerSnippet = Object.values(isPlainObject(followupAnswers) ? followupAnswers : {})
    .map((v) => {
      if (typeof v === 'string') return cleanString(v);
      if (isPlainObject(v)) return cleanString(v.value || v.label || v.id);
      return '';
    })
    .filter(Boolean)[0];
  if (answerSnippet) {
    evidence.push(lang === 'CN' ? `补充信息：${answerSnippet}` : `Intake answer: ${answerSnippet}`);
  }
  evidence.push(
    hasPhoto
      ? (lang === 'CN'
        ? `${axisLabel}结合了已提供的照片信息，但仍保持保守判断。`
        : `${axisLabel} includes the available photo signal, but remains conservative.`)
      : (lang === 'CN'
        ? `${axisLabel}当前没有照片信号，因此先采用保守估计。`
        : `${axisLabel} uses a conservative estimate because no photo signal is available yet.`),
  );
  return evidence.slice(0, 3);
}

function buildFallbackAxisSeeds(goalProfile, { hasPhoto, isColdStart }) {
  const goalText = cleanStringList(goalProfile?.selected_goals).join(' ').toLowerCase();
  const seeds = [];
  const addSeed = (axis) => {
    if (!seeds.some((entry) => entry.axis === axis)) seeds.push({ axis, level: 'moderate' });
  };

  if (/post_procedure|barrier|repair|sensitivity|red/.test(goalText)) addSeed('barrier_irritation_risk');
  if (/dry|dehydra|tight/.test(goalText)) addSeed('dryness_tightness');
  if (/bright|spot|pigment|tone/.test(goalText)) addSeed('pigmentation_risk');
  if (/aging|wrinkle|sun|uv|neck|eye/.test(goalText)) addSeed('photoaging_risk');
  if (/acne|breakout|blemish|pore|oil/.test(goalText)) addSeed('acne_breakout_risk');
  addSeed('sensitivity_level');
  if (!seeds.length) addSeed('dryness_tightness');

  const cap = isColdStart ? (hasPhoto ? 0.6 : 0.4) : 1;
  const fallbackConfidence = hasPhoto ? (isColdStart ? 0.55 : 0.72) : (isColdStart ? 0.35 : 0.48);
  return seeds.slice(0, 4).map((seed) => ({
    axis: seed.axis,
    level: seed.level,
    confidence: normalizeConfidence(fallbackConfidence, { fallback: fallbackConfidence, cap }),
    evidence: [],
    trend: 'new',
  }));
}

function normalizeAxisLevel(value) {
  const token = cleanString(value).toLowerCase();
  return ['low', 'moderate', 'high', 'severe'].includes(token) ? token : null;
}

function normalizeAxisTrend(value) {
  const token = cleanString(value).toLowerCase();
  return ['improved', 'stable', 'worsened', 'new'].includes(token) ? token : 'new';
}

function normalizeInferredState(value, { goalProfile, followupAnswers, photoFindings, ctx, isColdStart }) {
  const hasPhoto = Boolean(photoFindings && Object.keys(photoFindings).length > 0);
  const fallbackAxes = buildFallbackAxisSeeds(goalProfile, { hasPhoto, isColdStart });
  const cap = isColdStart ? (hasPhoto ? 0.6 : 0.4) : 1;
  const rawAxes = Array.isArray(value?.axes) ? value.axes : [];
  const normalized = rawAxes
    .map((axis, index) => {
      if (!isPlainObject(axis)) return null;
      const fb = fallbackAxes[index] || fallbackAxes[0];
      const axisName = cleanString(axis.axis) || fb.axis;
      const level = normalizeAxisLevel(axis.level) || fb.level;
      const evidence = cleanStringList(axis.evidence, { limit: 3 });
      return {
        axis: axisName,
        level,
        confidence: normalizeConfidence(axis.confidence, { fallback: fb.confidence, cap }),
        evidence: evidence.length
          ? evidence
          : buildFallbackEvidence({ goalProfile, followupAnswers, hasPhoto, ctx, axisLabel: axisName }),
        trend: normalizeAxisTrend(axis.trend),
        ...(normalizeAxisLevel(axis.previous_level) ? { previous_level: normalizeAxisLevel(axis.previous_level) } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 6);

  if (normalized.length) return { axes: normalized };
  return {
    axes: fallbackAxes.map((axis) => ({
      ...axis,
      evidence: buildFallbackEvidence({ goalProfile, followupAnswers, hasPhoto, ctx, axisLabel: axis.axis }),
    })),
  };
}

function normalizeDataQuality(value, { ctx, isColdStart, photoFindings }) {
  const lang = ctx.language === 'CN' ? 'CN' : 'EN';
  const token = cleanString(value?.overall).toLowerCase();
  const hasPhoto = Boolean(photoFindings && Object.keys(photoFindings).length > 0);
  const overall = ['high', 'medium', 'low'].includes(token) ? token : isColdStart ? 'low' : 'medium';
  const limitsBanner = cleanString(value?.limits_banner)
    || (hasPhoto
      ? (lang === 'CN'
        ? '当前仍建议保守解读，并结合后续打卡或 routine 信息继续优化。'
        : 'This result should still be read conservatively and refined with future check-ins or routine context.')
      : (lang === 'CN'
        ? '目前缺少照片或完整历史信息，本次结果以保守判断为主。'
        : 'A photo or fuller history is still missing, so this result stays intentionally conservative.'));
  return { overall, limits_banner: limitsBanner };
}

// ---------------------------------------------------------------------------
// Stage 3 strategies / blueprint / improvement / next-actions normalization
// ---------------------------------------------------------------------------

function buildFallbackStrategies(ctx) {
  const lang = ctx.language === 'CN' ? 'CN' : 'EN';
  return [
    {
      title: lang === 'CN' ? '先做温和修护' : 'Start with gentle barrier support',
      why: lang === 'CN'
        ? '当前数据有限，先采用低刺激、可持续的修护方案更稳妥。'
        : 'The current data is limited, so a low-risk and sustainable repair plan is the safest starting point.',
      timeline: lang === 'CN' ? '先持续 2-4 周并观察变化' : 'Follow for 2-4 weeks and watch for changes',
      do_list: [lang === 'CN' ? '保持清洁和保湿步骤尽量简单' : 'Keep cleansing and moisturizing steps simple'],
      avoid_list: [lang === 'CN' ? '先避免高刺激活性叠加' : 'Avoid stacking strong actives for now'],
    },
  ];
}

function normalizeStrategies(value, ctx) {
  const strategies = Array.isArray(value)
    ? value
        .map((strategy, index) => {
          if (!isPlainObject(strategy)) return null;
          const title = cleanString(strategy.title) || (ctx.language === 'CN' ? `策略 ${index + 1}` : `Strategy ${index + 1}`);
          const why = cleanString(strategy.why) || (ctx.language === 'CN'
            ? '基于当前可用信息，建议先采取温和、低刺激的方案。'
            : 'Based on the current signals, start with a gentle and low-risk approach.');
          const timeline = cleanString(strategy.timeline) || (ctx.language === 'CN' ? '先持续 2-4 周并观察变化' : 'Follow for 2-4 weeks and monitor changes');
          const doList = cleanStringList(strategy.do_list);
          const avoidList = cleanStringList(strategy.avoid_list);
          return {
            title,
            why,
            timeline,
            do_list: doList.length ? doList : [ctx.language === 'CN' ? '维持温和、稳定的护理节奏' : 'Keep the routine gentle and consistent'],
            avoid_list: avoidList,
          };
        })
        .filter(Boolean)
        .slice(0, 3)
    : [];
  return strategies.length ? strategies : buildFallbackStrategies(ctx);
}

function normalizeRoutineBlueprint(value, ctx) {
  const blueprint = isPlainObject(value) ? value : {};
  const lang = ctx.language === 'CN' ? 'CN' : 'EN';
  const amSteps = cleanStringList(blueprint.am_steps, { limit: 4 });
  const pmSteps = cleanStringList(blueprint.pm_steps, { limit: 4 });
  const fallbackAm = lang === 'CN' ? ['温和洁面', '保湿修护', '防晒'] : ['Gentle cleanser', 'Barrier-support moisturizer', 'Sunscreen'];
  const fallbackPm = lang === 'CN' ? ['温和洁面', '修护精华', '保湿霜'] : ['Gentle cleanser', 'Barrier-support serum', 'Moisturizer'];
  return {
    am_steps: amSteps.length ? amSteps : fallbackAm,
    pm_steps: pmSteps.length ? pmSteps : fallbackPm,
    conflict_rules: cleanStringList(blueprint.conflict_rules, { limit: 6 }),
  };
}

function buildFallbackImprovementPath(ctx) {
  const missing = detectMissingDataDimensions(ctx);
  const candidates = [];
  if (missing.includes('photo')) candidates.push('take_photo');
  if (missing.includes('routine')) candidates.push('setup_routine');
  if (missing.includes('checkin')) candidates.push('start_checkin');
  return candidates.slice(0, 3).map((type) => ({
    tip: defaultImprovementTip(type, ctx.language),
    action_type: type,
    action_label: defaultResultActionLabel(type, ctx.language),
  }));
}

function normalizeImprovementPath(value, ctx) {
  const normalized = Array.isArray(value)
    ? value
        .map((tip) => {
          if (!isPlainObject(tip)) return null;
          const actionType = normalizeImprovementActionType(tip.action_type || tip.type || tip.action);
          if (!actionType) return null;
          return {
            tip: cleanString(tip.tip) || defaultImprovementTip(actionType, ctx.language),
            action_type: actionType,
            action_label: cleanString(tip.action_label || tip.label) || defaultResultActionLabel(actionType, ctx.language),
          };
        })
        .filter(Boolean)
    : [];
  const deduped = dedupeBy(normalized, (tip) => tip.action_type).slice(0, 3);
  return deduped.length ? deduped : buildFallbackImprovementPath(ctx);
}

function buildFallbackNextActions(ctx) {
  const missing = detectMissingDataDimensions(ctx);
  const candidates = [];
  if (missing.includes('routine')) candidates.push('setup_routine');
  if (missing.includes('photo')) candidates.push('take_photo');
  if (missing.includes('checkin')) candidates.push('start_checkin');
  if (missing.includes('travel')) candidates.push('intake_optimize');
  candidates.push('direct_reco');
  return dedupeBy(
    candidates.map((type) => ({ type, label: defaultResultActionLabel(type, ctx.language) })),
    (action) => action.type,
  ).slice(0, 4);
}

function normalizeNextActions(value, ctx) {
  const normalized = Array.isArray(value)
    ? value
        .map((action) => {
          if (!isPlainObject(action)) return null;
          const type = normalizeResultActionType(action.type || action.action_type || action.id);
          if (!type) return null;
          const payload = isPlainObject(action.payload) ? action.payload : undefined;
          const normalizedAction = {
            type,
            label: cleanString(action.label || action.action_label) || defaultResultActionLabel(type, ctx.language),
          };
          if (payload) normalizedAction.payload = payload;
          return normalizedAction;
        })
        .filter(Boolean)
    : [];
  const deduped = dedupeBy(normalized, (action) => action.type).slice(0, 4);
  return deduped.length ? deduped : buildFallbackNextActions(ctx);
}

// ---------------------------------------------------------------------------
// Full result normalization (now includes inferred_state + data_quality)
// ---------------------------------------------------------------------------

function normalizeDiagnosisV2ResultPayload(resultPayload, ctx) {
  const payload = isPlainObject(resultPayload) ? { ...resultPayload } : {};
  return {
    ...payload,
    inferred_state: normalizeInferredState(payload.inferred_state, {
      goalProfile: payload.goal_profile,
      followupAnswers: ctx._followupAnswers,
      photoFindings: ctx._photoFindings,
      ctx,
      isColdStart: payload.is_cold_start ?? detectColdStart(ctx),
    }),
    data_quality: normalizeDataQuality(payload.data_quality, {
      ctx,
      isColdStart: payload.is_cold_start ?? detectColdStart(ctx),
      photoFindings: ctx._photoFindings,
    }),
    strategies: normalizeStrategies(payload.strategies, ctx),
    routine_blueprint: normalizeRoutineBlueprint(payload.routine_blueprint, ctx),
    improvement_path: normalizeImprovementPath(payload.improvement_path, ctx),
    next_actions: normalizeNextActions(payload.next_actions, ctx),
  };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function checkLoginGate(ctx) {
  const isLoggedIn = Boolean(getCtxAccountUserId(ctx) && ctx.authToken);
  if (isLoggedIn || ctx.skipLogin === true) return { needsLogin: false };
  return {
    needsLogin: true,
    loginPromptPayload: {
      prompt_text: ctx.language === 'CN'
        ? '登录后我可以结合你的历史数据（护肤日志、产品记录等）给出更精准的诊断结果'
        : 'Log in so I can use your history (skincare logs, product records) for a more accurate diagnosis',
      login_action: {
        type: 'login_then_diagnose',
        label: ctx.language === 'CN' ? '去登录' : 'Log in',
        payload: { return_to: 'diagnosis_v2', pending_goals: ctx.goals || [] },
      },
      skip_action: {
        type: 'skip_login',
        label: ctx.language === 'CN' ? '先不登录，直接开始' : 'Skip, start now',
        payload: { skip_login: true, pending_goals: ctx.goals || [] },
      },
      pending_goals: ctx.goals || [],
    },
  };
}

function checkPhotoGate(ctx) {
  if (ctx.hasExistingArtifact) return { needsPhoto: false, hasExistingArtifact: true };
  return {
    needsPhoto: true,
    photoPromptPayload: {
      prompt_text: ctx.language === 'CN'
        ? '拍一张自然光下的正面照，帮助提升分析准确度'
        : 'Take a photo in natural light to improve analysis accuracy',
      photo_action: { type: 'take_photo', label: ctx.language === 'CN' ? '拍照/上传' : 'Take photo', payload: {} },
      skip_action: { type: 'skip_photo', label: ctx.language === 'CN' ? '跳过，直接分析' : 'Skip, analyze now', payload: {} },
      has_existing_artifact: false,
    },
  };
}

// ---------------------------------------------------------------------------
// LLM provider guard
// ---------------------------------------------------------------------------

function ensureLlmProvider(llmProvider) {
  if (!llmProvider || typeof llmProvider.generate !== 'function') {
    const err = new Error('Diagnosis v2 LLM provider unavailable');
    err.code = 'LLM_PROVIDER_UNAVAILABLE';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Stage 1: Goal understanding
// ---------------------------------------------------------------------------

async function runStage1({ goals, customInput, ctx, llmProvider }) {
  ensureLlmProvider(llmProvider);
  const isColdStart = detectColdStart(ctx);
  const availableContext = {};
  if (ctx.profile && Object.keys(ctx.profile).length > 0) availableContext.profile = ctx.profile;
  if (ctx.recentLogs?.length) availableContext.recent_logs_count = ctx.recentLogs.length;
  if (ctx.travelPlans?.length) availableContext.has_travel = true;
  if (ctx.currentRoutine && ctx.currentRoutine !== 'none') availableContext.has_routine = true;

  const prompt = buildStage1Prompt({
    goals,
    customInput,
    availableContext: Object.keys(availableContext).length > 0 ? availableContext : null,
    isColdStart,
  });

  let parsed = null;
  try {
    const llmResponse = await llmProvider.generate({
      system: prompt.system,
      user: prompt.user,
      responseFormat: 'json',
      temperature: 0.3,
      maxTokens: 1200,
    });
    parsed = parseLlmJsonObject(llmResponse?.text, ['goal_profile', 'followup_questions']);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[diagnosis-v2] stage1 LLM failed, using fallback questions:', err?.message);
    parsed = null;
  }

  const normalizedPostProcedureMeta = normalizePostProcedureMeta(parsed?.goal_profile?.post_procedure_meta);
  const llmQuestionStrategy = cleanString(parsed?.question_strategy).toLowerCase();
  const introPayload = {
    goal_profile: {
      selected_goals: goals,
      custom_input: customInput || undefined,
      constraints: cleanStringList(parsed?.goal_profile?.constraints, { limit: 6 }),
      ...(normalizedPostProcedureMeta ? { post_procedure_meta: normalizedPostProcedureMeta } : {}),
    },
    is_cold_start: isColdStart,
    question_strategy:
      llmQuestionStrategy === 'state_probe' || llmQuestionStrategy === 'default'
        ? llmQuestionStrategy
        : isColdStart ? 'state_probe' : 'default',
    followup_questions: normalizeFollowupQuestions(parsed?.followup_questions, { goals, ctx, isColdStart }),
    actions: [
      { type: 'diagnosis_v2_submit', label: ctx.language === 'CN' ? '开始分析' : 'Start analysis' },
      { type: 'diagnosis_v2_skip', label: ctx.language === 'CN' ? '跳过' : 'Skip' },
    ],
  };

  return { introPayload, isColdStart, prompt };
}

// ---------------------------------------------------------------------------
// Stage 2: Skin inference
// ---------------------------------------------------------------------------

async function runStage2({ goalProfile, followupAnswers, photoFindings, ctx, llmProvider, onThinkingStep }) {
  ensureLlmProvider(llmProvider);
  const isColdStart = detectColdStart(ctx);
  const signals = {};
  if (ctx.recentLogs?.length) signals.recent_logs = ctx.recentLogs.slice(0, 5);
  if (ctx.currentRoutine && ctx.currentRoutine !== 'none') signals.current_routine = ctx.currentRoutine;
  if (ctx.travelPlans?.length) signals.travel_plans = ctx.travelPlans;

  let previousDiagnoses = [];
  const identity = buildDiagnosisIdentity(ctx);
  if (identity.userId || identity.auroraUid) {
    previousDiagnoses = (await getDiagnosisHistory(identity, { limit: 3 }))
      .map(compactDiagnosisSummary)
      .filter(Boolean);
  }

  const prompt = buildStage2Prompt({
    goalProfile,
    followupAnswers,
    photoFindings: photoFindings || null,
    signals: Object.keys(signals).length > 0 ? signals : null,
    previousDiagnoses: previousDiagnoses.length > 0 ? previousDiagnoses : null,
    isColdStart,
  });

  let parsed = null;
  try {
    const llmResponse = await llmProvider.generate({
      system: prompt.system,
      user: prompt.user,
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 2000,
    });
    parsed = parseLlmJsonObject(llmResponse?.text, ['inferred_state', 'data_quality']);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[diagnosis-v2] stage2 LLM failed, using conservative inference:', err?.message);
    parsed = null;
  }

  if (onThinkingStep && Array.isArray(parsed?.thinking_steps)) {
    for (const step of parsed.thinking_steps) {
      onThinkingStep({ stage: 'inference', step: step.id || 'inference_step', text: step.text, status: 'done' });
    }
  }

  return {
    inferredState: normalizeInferredState(parsed?.inferred_state, {
      goalProfile, followupAnswers, photoFindings, ctx, isColdStart,
    }),
    dataQuality: normalizeDataQuality(parsed?.data_quality, { ctx, isColdStart, photoFindings }),
    previousDiagnoses,
    isColdStart,
  };
}

// ---------------------------------------------------------------------------
// Stage 3: Strategy & plan
// ---------------------------------------------------------------------------

async function runStage3({ goalProfile, inferredState, dataQuality, ctx, llmProvider, previousDiagnoses, onThinkingStep }) {
  ensureLlmProvider(llmProvider);
  const isColdStart = detectColdStart(ctx);
  const missingDataDimensions = detectMissingDataDimensions(ctx);

  const prompt = buildStage3Prompt({
    goalProfile,
    inferredState,
    dataQuality,
    constraints: goalProfile.constraints,
    travelPlans: ctx.travelPlans,
    isColdStart,
    previousDiagnoses,
    missingDataDimensions: missingDataDimensions.length > 0 ? missingDataDimensions : null,
  });

  let parsed = null;
  try {
    const llmResponse = await llmProvider.generate({
      system: prompt.system,
      user: prompt.user,
      responseFormat: 'json',
      temperature: 0.3,
      maxTokens: 2500,
    });
    parsed = parseLlmJsonObject(llmResponse?.text, ['strategies', 'routine_blueprint', 'next_actions']);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[diagnosis-v2] stage3 LLM failed, using conservative strategies:', err?.message);
    parsed = null;
  }

  if (onThinkingStep && Array.isArray(parsed?.thinking_steps)) {
    for (const step of parsed.thinking_steps) {
      onThinkingStep({ stage: 'strategy', step: step.id || 'strategy_step', text: step.text, status: 'done' });
    }
  }

  return {
    strategies: normalizeStrategies(parsed?.strategies, ctx),
    routineBlueprint: normalizeRoutineBlueprint(parsed?.routine_blueprint, ctx),
    improvementPath: normalizeImprovementPath(parsed?.improvement_path, ctx),
    nextActions: normalizeNextActions(parsed?.next_actions, ctx),
  };
}

// ---------------------------------------------------------------------------
// Full V2 diagnosis orchestration
// ---------------------------------------------------------------------------

async function runDiagnosisV2({
  goals,
  customInput,
  followupAnswers,
  photoFindings,
  ctx,
  llmProvider,
  onThinkingStep,
}) {
  ensureLlmProvider(llmProvider);
  const diagnosisId = generateDiagnosisId();
  const isColdStart = detectColdStart(ctx);
  const identity = buildDiagnosisIdentity(ctx);

  // Attach extra context for normalizeDiagnosisV2ResultPayload
  ctx._followupAnswers = followupAnswers;
  ctx._photoFindings = photoFindings;

  let diagnosisSeq = 1;
  if (identity.userId || identity.auroraUid) {
    const history = await getDiagnosisHistory(identity, { limit: 1 });
    diagnosisSeq = history.length + 1;
  }

  if (onThinkingStep) {
    onThinkingStep({
      stage: 'goal_understanding',
      step: 'start',
      text: ctx.language === 'CN' ? '正在理解你的护肤目标...' : 'Understanding your skincare goals...',
      status: 'in_progress',
    });
  }

  const stage1 = await runStage1({ goals, customInput, ctx, llmProvider });

  if (onThinkingStep) {
    onThinkingStep({
      stage: 'goal_understanding', step: 'done',
      text: ctx.language === 'CN' ? `已理解目标：${goals.join('、')}` : `Goals understood: ${goals.join(', ')}`,
      status: 'done',
    });
    onThinkingStep({
      stage: 'inference', step: 'start',
      text: ctx.language === 'CN' ? '正在分析你的皮肤状态...' : 'Analyzing your skin state...',
      status: 'in_progress',
    });
  }

  const stage2 = await runStage2({
    goalProfile: stage1.introPayload.goal_profile,
    followupAnswers,
    photoFindings,
    ctx,
    llmProvider,
    onThinkingStep,
  });

  if (onThinkingStep) {
    onThinkingStep({
      stage: 'inference', step: 'done',
      text: ctx.language === 'CN' ? '皮肤状态分析完成' : 'Skin state analysis complete',
      status: 'done',
    });
    onThinkingStep({
      stage: 'strategy', step: 'start',
      text: ctx.language === 'CN' ? '正在制定个性化策略...' : 'Creating your personalized strategy...',
      status: 'in_progress',
    });
  }

  const stage3 = await runStage3({
    goalProfile: stage1.introPayload.goal_profile,
    inferredState: stage2.inferredState,
    dataQuality: stage2.dataQuality,
    ctx,
    llmProvider,
    previousDiagnoses: stage2.previousDiagnoses,
    onThinkingStep,
  });

  if (onThinkingStep) {
    onThinkingStep({
      stage: 'strategy', step: 'done',
      text: ctx.language === 'CN' ? '策略制定完成' : 'Strategy complete',
      status: 'done',
    });
  }

  const resultPayload = {
    diagnosis_id: diagnosisId,
    diagnosis_seq: diagnosisSeq,
    goal_profile: stage1.introPayload.goal_profile,
    is_cold_start: isColdStart,
    data_quality: stage2.dataQuality,
    inferred_state: stage2.inferredState,
    strategies: stage3.strategies,
    routine_blueprint: stage3.routineBlueprint,
    improvement_path: stage3.improvementPath,
    next_actions: stage3.nextActions,
  };

  const validation = validateResultPayload(normalizeDiagnosisV2ResultPayload(resultPayload, ctx));
  if (!validation.ok) {
    // eslint-disable-next-line no-console
    console.warn('[diagnosis-v2] result validation failed:', JSON.stringify(validation.errors));
    const err = new Error('Diagnosis v2 result validation failed');
    err.validationErrors = validation.errors;
    throw err;
  }

  let analysisContextSnapshot = null;
  let latestArtifactId = null;
  let artifactPersistence = null;
  if (identity.userId || identity.auroraUid) {
    try {
      const savedArtifact = await saveDiagnosisArtifact({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
        artifact: { schema: 'aurora.skin_diagnosis.v2', data: validation.data },
      });
      latestArtifactId = savedArtifact && savedArtifact.artifact_id
        ? String(savedArtifact.artifact_id).trim()
        : null;
      artifactPersistence = savedArtifact
        ? {
            persisted: savedArtifact.persisted === true,
            storage_mode: savedArtifact.storage_mode || (savedArtifact.persisted === true ? 'db' : 'response_only'),
            persistence_error_code: savedArtifact.persistence_error_code || null,
            artifact_id: latestArtifactId || null,
          }
        : null;
      const latestArtifact =
        savedArtifact && savedArtifact.artifact_json && typeof savedArtifact.artifact_json === 'object'
          ? {
              ...savedArtifact.artifact_json,
              artifact_id: savedArtifact.artifact_id || null,
              created_at: savedArtifact.created_at || savedArtifact.artifact_json.created_at || null,
            }
          : { schema: 'aurora.skin_diagnosis.v2', data: validation.data };
      analysisContextSnapshot = buildAnalysisContextSnapshotV1({
        latestArtifact,
        profile: ctx.profile || null,
        recentLogs: Array.isArray(ctx.recentLogs) ? ctx.recentLogs : [],
      });
    } catch (_) {
      // Persistence failure should not break the diagnosis flow.
      artifactPersistence = {
        persisted: false,
        storage_mode: 'response_only',
        persistence_error_code: 'SAVE_FAILED',
        artifact_id: null,
      };
    }
  }

  return {
    resultPayload: validation.data,
    analysisContextSnapshot,
    latestArtifactId,
    artifactPersistence,
    warnings: validation.warnings,
    promptVersion: PROMPT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Diagnosis history
// ---------------------------------------------------------------------------

async function getDiagnosisHistory(identity, { limit = 3 } = {}) {
  const resolvedIdentity =
    identity && typeof identity === 'object'
      ? {
          auroraUid: cleanString(identity.auroraUid || identity.aurora_uid || ''),
          userId: cleanString(identity.userId || identity.accountUserId || identity.account_user_id || ''),
        }
      : {
          auroraUid: null,
          userId: cleanString(identity || ''),
        };
  if (!resolvedIdentity.userId && !resolvedIdentity.auroraUid) return [];
  try {
    return await listRecentDiagnosisArtifacts({
      auroraUid: resolvedIdentity.auroraUid || null,
      userId: resolvedIdentity.userId || null,
      limit,
      maxAgeDays: 180,
    });
  } catch (_) {
    return [];
  }
}

module.exports = {
  generateDiagnosisId,
  detectColdStart,
  detectMissingDataDimensions,
  compactDiagnosisSummary,
  normalizeDiagnosisV2ResultPayload,
  checkLoginGate,
  checkPhotoGate,
  runStage1,
  runStage2,
  runStage3,
  runDiagnosisV2,
  getDiagnosisHistory,
};
