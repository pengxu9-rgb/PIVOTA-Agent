const crypto = require('crypto');
const {
  buildStage1Prompt,
  buildStage2Prompt,
  buildStage3Prompt,
  PROMPT_VERSION,
} = require('./diagnosisV2Prompts');
const { validateResultPayload } = require('./diagnosisV2Schema');
const {
  listRecentDiagnosisArtifacts,
  saveDiagnosisArtifact,
} = require('./diagnosisArtifactStore');

function generateDiagnosisId() {
  return crypto.randomUUID();
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

function checkLoginGate(ctx) {
  const isLoggedIn = Boolean(ctx.userId && ctx.authToken);
  if (isLoggedIn || ctx.skipLogin === true) {
    return { needsLogin: false };
  }

  return {
    needsLogin: true,
    loginPromptPayload: {
      prompt_text:
        ctx.language === 'CN'
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
  if (ctx.hasExistingArtifact) {
    return { needsPhoto: false, hasExistingArtifact: true };
  }

  return {
    needsPhoto: true,
    photoPromptPayload: {
      prompt_text:
        ctx.language === 'CN'
          ? '拍一张自然光下的正面照，帮助提升分析准确度'
          : 'Take a photo in natural light to improve analysis accuracy',
      photo_action: {
        type: 'take_photo',
        label: ctx.language === 'CN' ? '拍照/上传' : 'Take photo',
        payload: {},
      },
      skip_action: {
        type: 'skip_photo',
        label: ctx.language === 'CN' ? '跳过，直接分析' : 'Skip, analyze now',
        payload: {},
      },
      has_existing_artifact: false,
    },
  };
}

function ensureLlmProvider(llmProvider) {
  if (!llmProvider || typeof llmProvider.generate !== 'function') {
    const err = new Error('Diagnosis v2 LLM provider unavailable');
    err.code = 'LLM_PROVIDER_UNAVAILABLE';
    throw err;
  }
}

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

  const llmResponse = await llmProvider.generate({
    system: prompt.system,
    user: prompt.user,
    responseFormat: 'json',
    temperature: 0.3,
    maxTokens: 1200,
  });

  const parsed = JSON.parse(llmResponse.text);
  const introPayload = {
    goal_profile: {
      selected_goals: goals,
      custom_input: customInput || undefined,
      constraints: parsed.goal_profile?.constraints || [],
      ...(parsed.goal_profile?.post_procedure_meta
        ? { post_procedure_meta: parsed.goal_profile.post_procedure_meta }
        : {}),
    },
    is_cold_start: isColdStart,
    question_strategy: isColdStart ? 'state_probe' : 'default',
    followup_questions: (parsed.followup_questions || []).slice(0, 3).map((question, index) => ({
      id: question.id || `fq_${index}`,
      question: question.question,
      options: (question.options || []).map((option, optionIndex) => ({
        id: option.id || `opt_${index}_${optionIndex}`,
        label: option.label,
        value: option.value || option.label,
      })),
      required: false,
    })),
    actions: [
      { type: 'diagnosis_v2_submit', label: ctx.language === 'CN' ? '开始分析' : 'Start analysis' },
      { type: 'diagnosis_v2_skip', label: ctx.language === 'CN' ? '跳过' : 'Skip' },
    ],
  };

  return { introPayload, isColdStart, prompt };
}

async function runStage2({ goalProfile, followupAnswers, photoFindings, ctx, llmProvider, onThinkingStep }) {
  ensureLlmProvider(llmProvider);
  const isColdStart = detectColdStart(ctx);
  const signals = {};
  if (ctx.recentLogs?.length) signals.recent_logs = ctx.recentLogs.slice(0, 5);
  if (ctx.currentRoutine && ctx.currentRoutine !== 'none') signals.current_routine = ctx.currentRoutine;
  if (ctx.travelPlans?.length) signals.travel_plans = ctx.travelPlans;

  let previousDiagnoses = [];
  if (ctx.userId) {
    previousDiagnoses = (await getDiagnosisHistory(ctx.userId, { limit: 3 }))
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

  const llmResponse = await llmProvider.generate({
    system: prompt.system,
    user: prompt.user,
    responseFormat: 'json',
    temperature: 0.2,
    maxTokens: 2000,
  });

  const parsed = JSON.parse(llmResponse.text);
  if (onThinkingStep && Array.isArray(parsed.thinking_steps)) {
    for (const step of parsed.thinking_steps) {
      onThinkingStep({
        stage: 'inference',
        step: step.id || 'inference_step',
        text: step.text,
        status: 'done',
      });
    }
  }

  return {
    inferredState: parsed.inferred_state,
    dataQuality: parsed.data_quality,
    previousDiagnoses,
    isColdStart,
  };
}

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

  const llmResponse = await llmProvider.generate({
    system: prompt.system,
    user: prompt.user,
    responseFormat: 'json',
    temperature: 0.3,
    maxTokens: 2500,
  });

  const parsed = JSON.parse(llmResponse.text);
  if (onThinkingStep && Array.isArray(parsed.thinking_steps)) {
    for (const step of parsed.thinking_steps) {
      onThinkingStep({
        stage: 'strategy',
        step: step.id || 'strategy_step',
        text: step.text,
        status: 'done',
      });
    }
  }

  return {
    strategies: parsed.strategies,
    routineBlueprint: parsed.routine_blueprint,
    improvementPath: parsed.improvement_path || [],
    nextActions: parsed.next_actions,
  };
}

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

  let diagnosisSeq = 1;
  if (ctx.userId) {
    const history = await getDiagnosisHistory(ctx.userId, { limit: 1 });
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
      stage: 'goal_understanding',
      step: 'done',
      text: ctx.language === 'CN' ? `已理解目标：${goals.join('、')}` : `Goals understood: ${goals.join(', ')}`,
      status: 'done',
    });
    onThinkingStep({
      stage: 'inference',
      step: 'start',
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
      stage: 'inference',
      step: 'done',
      text: ctx.language === 'CN' ? '皮肤状态分析完成' : 'Skin state analysis complete',
      status: 'done',
    });
    onThinkingStep({
      stage: 'strategy',
      step: 'start',
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
      stage: 'strategy',
      step: 'done',
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

  const validation = validateResultPayload(resultPayload);
  if (!validation.ok) {
    const err = new Error('Diagnosis v2 result validation failed');
    err.validationErrors = validation.errors;
    throw err;
  }

  if (ctx.userId) {
    try {
      await saveDiagnosisArtifact({
        userId: ctx.userId,
        artifact: {
          schema: 'aurora.skin_diagnosis.v2',
          data: validation.data,
        },
      });
    } catch (_) {
      // Persistence failure should not break the diagnosis flow.
    }
  }

  return {
    resultPayload: validation.data,
    warnings: validation.warnings,
    promptVersion: PROMPT_VERSION,
  };
}

async function getDiagnosisHistory(userId, { limit = 3 } = {}) {
  if (!userId) return [];
  try {
    return await listRecentDiagnosisArtifacts({
      userId,
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
  checkLoginGate,
  checkPhotoGate,
  runStage1,
  runStage2,
  runStage3,
  runDiagnosisV2,
  getDiagnosisHistory,
};
