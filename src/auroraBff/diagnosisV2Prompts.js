const PROMPT_VERSION = 'diagnosis_v2_20260306';

const SAFETY_PREAMBLE = [
  'You are a professional skincare advisor. You do NOT provide medical diagnosis, prescribe medications, or recommend prescription drugs.',
  'If the user describes severe symptoms (open wounds, suspected infection, severe allergic reaction), recommend they consult a dermatologist.',
  'Never claim to diagnose diseases. Use phrases like "risk signal" or "area of concern" instead of "diagnosis".',
  'Output MUST be valid, strictly parsable JSON only. No markdown, no text outside JSON.',
].join('\n');

function buildStage1Prompt({ goals, customInput, availableContext, isColdStart }) {
  const contextSection = availableContext
    ? `\nAvailable user context:\n${JSON.stringify(availableContext, null, 2)}`
    : '\nNo previous user data available (new user).';

  const questionStrategy = isColdStart ? 'state_probe' : 'default';

  const questionGuidance = isColdStart
    ? [
        'This is a NEW USER with no history. All 3 question slots MUST be used for state detection:',
        '- Question 1: Current skin condition (stable / easily red-irritated / flaking-tight / breakout-prone)',
        '- Question 2: Experience with actives (retinoids/acids/vitamin C — used before? reaction?)',
        '- Question 3: Daily sun protection habits (every day / occasionally / almost never)',
        'Do NOT ask preference questions (gentle vs fast). Do NOT ask about skin type directly.',
      ].join('\n')
    : [
        'Generate up to 3 followup questions to refine the diagnosis.',
        'Prefer preference/clarification questions since we have historical data.',
        'Example: "Do you prefer a gentle approach or faster results?"',
      ].join('\n');

  const postProcedureRule = goals.includes('post_procedure_repair')
    ? '\nCRITICAL: User selected post-procedure repair. You MUST ask: (1) how many days since the procedure, (2) whether skin is broken/open. These are MANDATORY safety questions.'
    : '';

  return {
    version: PROMPT_VERSION,
    task_mode: 'goal_understanding',
    system: [
      SAFETY_PREAMBLE,
      '',
      "TASK: Understand the user's skincare goals and generate clarifying questions.",
      '',
      'RULES:',
      '- Do NOT ask about skin type (oily/dry/etc). The system will infer it.',
      '- Generate at most 3 followup_questions.',
      '- Each question must have 2-5 options as quick replies.',
      postProcedureRule,
      '',
      questionGuidance,
      '',
      'OUTPUT JSON SCHEMA:',
      '{',
      '  "goal_profile": {',
      '    "selected_goals": string[],',
      '    "custom_input": string | null,',
      '    "constraints": string[]',
      '  },',
      '  "followup_questions": [{ "id": string, "question": string, "options": [{ "id": string, "label": string, "value"?: string }] }],',
      `  "question_strategy": "${questionStrategy}"`,
      '}',
    ].join('\n'),
    user: [
      `User selected goals: ${JSON.stringify(goals)}`,
      customInput ? `Custom input: "${customInput}"` : '',
      contextSection,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function buildStage2Prompt({
  goalProfile,
  followupAnswers,
  photoFindings,
  signals,
  previousDiagnoses,
  isColdStart,
}) {
  const hasPhoto = photoFindings && Object.keys(photoFindings).length > 0;
  const photoRule = hasPhoto
    ? 'Photo findings are available. You MAY reference visual observations to support your inference.'
    : 'NO PHOTO available. You MUST NOT reference any visual observations. Do not say "I can see" or "the photo shows".';
  const confidenceCap = isColdStart ? (hasPhoto ? 0.6 : 0.4) : 1.0;

  const historySection =
    Array.isArray(previousDiagnoses) && previousDiagnoses.length > 0
      ? [
          '',
          'PREVIOUS DIAGNOSIS HISTORY (compare current state to detect trends):',
          JSON.stringify(previousDiagnoses),
          'For each axis, output a "trend" field: "improved" if getting better, "stable" if unchanged, "worsened" if getting worse, "new" if this axis was not measured before.',
          'Also output "previous_level" with the level from the most recent previous diagnosis, if available.',
        ].join('\n')
      : '\nNo previous diagnosis history. Mark all axes with trend: "new".';

  return {
    version: PROMPT_VERSION,
    task_mode: 'skin_inference',
    system: [
      SAFETY_PREAMBLE,
      '',
      "TASK: Infer the user's current skin state across multiple axes based on available signals.",
      '',
      'RULES:',
      `- ${photoRule}`,
      `- Confidence values MUST NOT exceed ${confidenceCap} (cap for current data richness).`,
      '- Every axis MUST have at least 1 evidence item explaining why you inferred that level.',
      '- Evidence must reference specific signals (e.g., "user reported easy redness" not "based on analysis").',
      isColdStart ? '- This is a COLD START (new user). Be conservative. Use "moderate" as default level when uncertain.' : '',
      '',
      'AXES TO EVALUATE (include all that are relevant to the goals):',
      '- barrier_irritation_risk: risk of barrier damage / irritation',
      '- dryness_tightness: dryness and tightness level',
      '- pigmentation_risk: dark spots / uneven tone risk',
      '- photoaging_risk: sun damage / photoaging risk',
      '- acne_breakout_risk: acne and breakout risk',
      '- sensitivity_level: overall skin sensitivity',
      '',
      historySection,
      '',
      'OUTPUT JSON SCHEMA:',
      '{',
      '  "inferred_state": {',
      '    "axes": [{ "axis": string, "level": "low"|"moderate"|"high"|"severe", "confidence": number, "evidence": string[], "trend": "improved"|"stable"|"worsened"|"new", "previous_level"?: string }]',
      '  },',
      '  "data_quality": { "overall": "high"|"medium"|"low", "limits_banner": string|null },',
      '  "thinking_steps": [{ "id"?: string, "text": string }]',
      '}',
    ]
      .filter(Boolean)
      .join('\n'),
    user: [
      `Goal profile: ${JSON.stringify(goalProfile)}`,
      `Followup answers: ${JSON.stringify(followupAnswers || {})}`,
      hasPhoto ? `Photo findings: ${JSON.stringify(photoFindings)}` : 'No photo provided.',
      signals ? `Available signals: ${JSON.stringify(signals)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function buildStage3Prompt({
  goalProfile,
  inferredState,
  dataQuality,
  constraints,
  travelPlans,
  isColdStart,
  previousDiagnoses,
  missingDataDimensions,
}) {
  const hasTravelActive =
    Array.isArray(travelPlans) &&
    travelPlans.some((plan) => {
      if (!plan || !plan.end_date) return false;
      return new Date(plan.end_date) >= new Date();
    });

  const travelRule = hasTravelActive
    ? [
        '',
        'TRAVEL IS ACTIVE. You MUST include travel adjustments in the blueprint:',
        '- Add sunscreen reapplication reminder',
        '- Increase hydration / moisturizer step',
        '- Reduce irritating actives (retinoids, acids)',
        '- Note climate-specific tips if destination info is available',
        `Travel plans: ${JSON.stringify(travelPlans)}`,
      ].join('\n')
    : '';

  const coldStartRule = isColdStart
    ? [
        '',
        'COLD START MODE: This is a new user with limited data.',
        '- Strategies MUST be conservative: no high-concentration retinoids, no strong acids.',
        '- Prefer gentle, low-risk ingredients.',
        '- improvement_path MUST be non-empty to guide the user toward building baseline data.',
      ].join('\n')
    : '';

  const historySection =
    Array.isArray(previousDiagnoses) && previousDiagnoses.length > 0
      ? [
          '',
          'PREVIOUS DIAGNOSES (use trends to adjust strategy intensity):',
          JSON.stringify(previousDiagnoses),
          '- For "improved" axes: consider maintaining or advancing to next intensity level.',
          '- For "worsened" axes: pull back to gentler approach or add repair steps.',
          '- You may reference history in strategy "why" field (e.g., "barrier risk decreased from high to moderate over 2 weeks").',
        ].join('\n')
      : '';

  const improvementSection =
    Array.isArray(missingDataDimensions) && missingDataDimensions.length > 0
      ? [
          '',
          `Missing data dimensions: ${JSON.stringify(missingDataDimensions)}`,
          'Generate improvement_path tips for each missing dimension. Map to action_types:',
          '- no photo -> take_photo',
          '- no routine -> setup_routine',
          '- no check-in logs -> start_checkin',
          '- no travel plan -> add_travel',
        ].join('\n')
      : '';

  return {
    version: PROMPT_VERSION,
    task_mode: 'plan_strategy',
    system: [
      SAFETY_PREAMBLE,
      '',
      'TASK: Generate skincare strategies, an AM/PM routine blueprint, and next actions.',
      '',
      'RULES:',
      '- Output 1-3 strategies. Each must have: title, why, timeline, do_list, avoid_list.',
      '- Routine blueprint: AM max 4 steps, PM max 4 steps. Use generic step names, not brands or SKU names.',
      '- next_actions MUST be non-empty. Include at least one actionable CTA.',
      '- conflict_rules: list any ingredient or step conflicts.',
      travelRule,
      coldStartRule,
      historySection,
      improvementSection,
      '',
      'OUTPUT JSON SCHEMA:',
      '{',
      '  "strategies": [{ "title": string, "why": string, "timeline": string, "do_list": string[], "avoid_list": string[] }],',
      '  "routine_blueprint": { "am_steps": string[], "pm_steps": string[], "conflict_rules": string[] },',
      '  "improvement_path": [{ "tip": string, "action_type": "take_photo"|"setup_routine"|"start_checkin"|"add_travel", "action_label": string }],',
      '  "next_actions": [{ "type": string, "label": string, "payload"?: object }],',
      '  "thinking_steps": [{ "id"?: string, "text": string }]',
      '}',
    ]
      .filter(Boolean)
      .join('\n'),
    user: [
      `Goal profile: ${JSON.stringify(goalProfile)}`,
      `Inferred state: ${JSON.stringify(inferredState)}`,
      `Data quality: ${JSON.stringify(dataQuality)}`,
      constraints ? `Constraints: ${JSON.stringify(constraints)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

module.exports = {
  PROMPT_VERSION,
  buildStage1Prompt,
  buildStage2Prompt,
  buildStage3Prompt,
};
