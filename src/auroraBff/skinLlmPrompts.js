function clampText(raw, maxLen) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

function compactProfile(profileSummary) {
  const p = profileSummary && typeof profileSummary === 'object' ? profileSummary : {};
  const goals = Array.isArray(p.goals) ? p.goals.filter((v) => typeof v === 'string' && v.trim()).slice(0, 4) : [];
  const contraindications = Array.isArray(p.contraindications)
    ? p.contraindications.filter((v) => typeof v === 'string' && v.trim()).slice(0, 6)
    : [];
  return {
    skinType: p.skinType || null,
    barrierStatus: p.barrierStatus || null,
    sensitivity: p.sensitivity || null,
    goals,
    region: p.region || null,
    ...(contraindications.length ? { contraindications } : {}),
  };
}

function pickDetectorCandidates(diagnosisV1, { max = 2 } = {}) {
  const d = diagnosisV1 && typeof diagnosisV1 === 'object' && !Array.isArray(diagnosisV1) ? diagnosisV1 : null;
  const issues = d && Array.isArray(d.issues) ? d.issues : [];
  const cleaned = issues
    .map((it) => (it && typeof it === 'object' ? it : null))
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const sa = Number.isFinite(a.severity_level) ? a.severity_level : 0;
      const sb = Number.isFinite(b.severity_level) ? b.severity_level : 0;
      if (sb !== sa) return sb - sa;
      const ca = Number.isFinite(a.confidence) ? a.confidence : 0;
      const cb = Number.isFinite(b.confidence) ? b.confidence : 0;
      return cb - ca;
    });

  const out = [];
  for (const it of cleaned) {
    const issueType = typeof it.issue_type === 'string' ? it.issue_type : null;
    if (!issueType) continue;
    const severity = typeof it.severity === 'string' ? it.severity : null;
    const confidenceLabel = typeof it.confidence_label === 'string' ? it.confidence_label : null;
    const evidenceShortRaw = it.evidence && Array.isArray(it.evidence.evidence_short) ? it.evidence.evidence_short : [];
    const evidenceShort = evidenceShortRaw
      .filter((v) => typeof v === 'string' && v.trim())
      .slice(0, 2)
      .map((v) => clampText(v, 200));
    out.push({
      issue_type: issueType,
      ...(severity ? { severity } : {}),
      ...(confidenceLabel ? { confidence_label: confidenceLabel } : {}),
      ...(evidenceShort.length ? { evidence_short: evidenceShort } : {}),
    });
    if (out.length >= max) break;
  }
  return out;
}

function summarizeRoutineActives(routineCandidate) {
  let text = '';
  if (typeof routineCandidate === 'string') text = routineCandidate;
  else if (routineCandidate && typeof routineCandidate === 'object') {
    try {
      text = JSON.stringify(routineCandidate);
    } catch {
      text = '';
    }
  }
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return [];

  const found = new Set();
  const add = (k) => found.add(k);
  if (/\b(retinoid|retinol|tretinoin|adapalene)\b|维a|阿达帕林|维a酸|视黄醇/.test(t)) add('retinoid');
  if (/\b(aha|bha|pha|glycolic|lactic|salicylic)\b|果酸|水杨酸|乳酸|葡糖酸内酯/.test(t)) add('acids');
  if (/\b(vitamin c|ascorbic|l-ascorbic)\b|维c|抗坏血酸/.test(t)) add('vitamin_c');
  if (/\b(benzoyl peroxide)\b|过氧化苯甲酰/.test(t)) add('benzoyl_peroxide');
  if (/\b(azelaic)\b|壬二酸/.test(t)) add('azelaic_acid');
  if (/\b(niacinamide)\b|烟酰胺/.test(t)) add('niacinamide');
  if (/\b(hydroquinone)\b|氢醌/.test(t)) add('hydroquinone');
  return Array.from(found).slice(0, 8);
}

function normalizeLang(language) {
  const token = String(language || '').trim().toLowerCase();
  if (token === 'cn' || token === 'zh-cn' || token === 'zh') return 'zh-CN';
  return 'en-US';
}

function qualityGradeInstruction(dto, lang) {
  const q = dto && typeof dto === 'object' ? dto.quality : null;
  if (!q || typeof q !== 'object') return '';
  const grade = String(q.grade || '').toLowerCase();
  if (grade === 'pass') {
    return lang === 'zh-CN'
      ? '\nquality_rule: 照片质量=pass。禁止提及"画质不佳"或"保守判断"。正常输出，不需降级置信度。'
      : '\nquality_rule: Photo quality=pass. Do NOT mention degraded quality or be conservative due to photo quality. Output normally.';
  }
  if (grade === 'degraded') {
    const issues = Array.isArray(q.issues) ? q.issues.join(', ') : '';
    return lang === 'zh-CN'
      ? `\nquality_rule: 照片质量=degraded(${issues})。用1句话说明具体问题。置信度上限=med。禁止重复免责声明。`
      : `\nquality_rule: Photo quality=degraded (${issues}). Acknowledge the specific issue in exactly 1 sentence. Cap confidence at med. No repeated disclaimers.`;
  }
  if (grade === 'fail') {
    return lang === 'zh-CN'
      ? '\nquality_rule: 照片质量=fail。不输出任何发现。仅提供重拍指引。'
      : '\nquality_rule: Photo quality=fail. Return NO findings. Provide retake instructions ONLY.';
  }
  return '';
}

function normalizePromptVersion(promptVersion, fallback) {
  return typeof promptVersion === 'string' && promptVersion.trim() ? promptVersion.trim() : fallback;
}

const SKIN_CANONICAL_PROMPT_ALIASES = new Set([
  'skin_v3',
  'skin_v3_canonical',
  'skin_report_v3_canonical',
  'skin_vision_v3_canonical',
]);

const SKIN_DEEPENING_CANONICAL_PROMPT_ALIASES = new Set([
  'skin_deepening_v2_canonical',
]);

function isSkinPromptV3(promptVersion) {
  const token = String(promptVersion || '').trim().toLowerCase();
  return SKIN_CANONICAL_PROMPT_ALIASES.has(token);
}

function isSkinDeepeningV2(promptVersion) {
  const token = String(promptVersion || '').trim().toLowerCase();
  return SKIN_DEEPENING_CANONICAL_PROMPT_ALIASES.has(token);
}

const SKIN_REPORT_MAINLINE_PROMPT_VERSION = 'skin_report_v3_hardened';
const SKIN_DEEPENING_MAINLINE_PROMPT_VERSION = 'skin_deepening_v2_hardened';
const SKIN_VISION_MAINLINE_PROMPT_VERSION = 'skin_vision_v2_hardened';

function buildVisionCanonicalPrompt({ dto } = {}) {
  const safeDto = dto && typeof dto === 'object' ? dto : {};
  const contextJson = JSON.stringify(safeDto || {});
  return {
    promptVersion: 'skin_vision_v3_canonical',
    systemInstruction:
      'You are a cosmetic skin cue extraction engine. Reason in English only. Output strict JSON matching the response schema. Never localize, diagnose disease, recommend products, or write routines.',
    userPrompt: [
      'objective:',
      '- Inspect only visible facial skin cues grounded in the image.',
      '- Decide whether the image supports sufficient, limited, or insufficient visual grounding.',
      'decision rubric:',
      '- sufficient: face skin is visible and at least 2 grounded cues can be extracted.',
      '- limited: the face is visible but evidence is weak/noisy; only keep grounded cues.',
      '- insufficient: blur, lighting, occlusion, framing, or absent cues prevent grounded extraction.',
      'hard constraints:',
      '- English-only canonical semantics.',
      '- Use canonical enums only.',
      '- No routines, products, diagnoses, treatment claims, or disease names.',
      '- Keep at most 4 distinct observations after merging overlapping weak cues.',
      '- Prefer the most grounded cues; drop edge-case guesses when evidence is weak.',
      '- If two observations overlap on the same cue+region, keep the stronger one only.',
      '- Order observations by strongest grounding first.',
      '- If visibility_status is insufficient, observations should usually be empty and insufficient_reason must be set.',
      '- If pass-quality context is provided and visibility_status is sufficient or limited, return at least 2 distinct grounded observations.',
      'compact context block:',
      contextJson,
      'few-shot mini examples:',
      'Example A -> visibility_status=sufficient; observations might include redness on cheeks and shine in t_zone.',
      'Example B -> visibility_status=insufficient; insufficient_reason=blur; observations=[].',
    ].join('\n'),
  };
}

function buildReportCanonicalPrompt({ dto } = {}) {
  const safeDto = dto && typeof dto === 'object' ? dto : {};
  const contextJson = JSON.stringify(safeDto || {});
  return {
    promptVersion: 'skin_report_v3_canonical',
    systemInstruction:
      'You are a cosmetic skincare planning engine. Reason in English only. Output strict JSON matching the response schema. Use only canonical enums. Do not localize, diagnose disease, name brands, or recommend specific products.',
    userPrompt: [
      'objective:',
      '- Convert the provided skin signals into a grounded, conservative, structured skincare plan skeleton.',
      '- Stay fully consistent with visible cues and deterministic signals.',
      'decision rubric:',
      '- summary_focus is a recommendation only; downstream deterministic adjudication may refine the final priority.',
      '- routine_steps must be grounded in linked_cues.',
      '- watchouts and two_week_focus must stay conservative and actionable.',
      'hard constraints:',
      '- English-only canonical semantics.',
      '- No user-facing prose paragraphs and no free-form product advice.',
      '- Do not generate deepening, follow-on conversation narrative, or localized copy.',
      '- Every routine step must include time, step_type, target, cadence, intensity, and linked_cues.',
      '- follow_up must use only intent enums for deterministic rendering.',
      '- If cues are too weak, do not invent confidence or claims.',
      '- Keep the output compact; prefer 2-4 grounded insights and 3-5 routine_steps.',
      '- When concern_rank or deterministic_signals point to a stronger priority, avoid falling back to mixed without evidence.',
      'compact context block:',
      contextJson,
      'few-shot mini examples:',
      'Example A -> barrier/redness priority with cleanse+moisturize+protect steps and watchouts about stinging.',
      'Example B -> oiliness/texture priority with monitor + low_frequency treat step, while still avoiding over-stacking actives.',
    ].join('\n'),
  };
}

function buildDeepeningCanonicalPrompt({ dto } = {}) {
  const safeDto = dto && typeof dto === 'object' ? dto : {};
  const contextJson = JSON.stringify(safeDto || {});
  return {
    promptVersion: 'skin_deepening_v2_canonical',
    systemInstruction:
      'You are a structured skincare deepening engine. Reason in English only. Output strict JSON matching the response schema. Do not localize and do not produce long prose.',
    userPrompt: [
      'objective:',
      '- Choose the correct deepening phase and next-question intent from the provided skincare context.',
      '- Keep the output fully renderable by a deterministic locale renderer.',
      'decision rubric:',
      '- phase must match the conversation stage.',
      '- advice_items must be structured watchouts or 2-week focus items only.',
      '- question_intent must choose the single best next question intent for the given phase.',
      'hard constraints:',
      '- English-only canonical semantics.',
      '- No free-form narrative.',
      '- Use only schema enums.',
      '- Preserve the inherited summary_priority from context unless it is missing.',
      '- Keep advice_items stable and phase-appropriate; avoid rotating equivalent sets across repeats.',
      '- photo_optin -> prefer photo_upload; products -> prefer routine_share; reactions -> prefer reaction_check; refined -> prefer confirm_plan.',
      'compact context block:',
      contextJson,
      'few-shot mini examples:',
      'Example A -> photo_optin + photo_upload when the user has not uploaded a photo yet.',
      'Example B -> reactions + reaction_check when a routine exists but tolerance is still unclear.',
    ].join('\n'),
  };
}

function buildSkinVisionPromptBundle({ language, dto, promptVersion } = {}) {
  const lang = normalizeLang(language);
  const version = normalizePromptVersion(promptVersion, SKIN_VISION_MAINLINE_PROMPT_VERSION);
  if (isSkinPromptV3(version)) return buildVisionCanonicalPrompt({ dto });
  const qRule = qualityGradeInstruction(dto, lang);
  if (lang === 'zh-CN') {
    return {
      promptVersion: version,
      systemInstruction: [
        `Role: 你是客观的皮肤可见线索提取助手。Prompt version: ${version}.`,
        '输出必须是单个严格 JSON 对象，不要输出 JSON 之外的文本。',
        '仅输出基于照片可见信号的观察，禁止给出护肤建议、产品推荐、日常方案。',
        '禁止疾病诊断、治疗宣称、处方药名称。',
        'Language: 简体中文。',
      ].join('\n'),
      userPrompt: [
        `[SYSTEM_CONTRACT][version=${version}]`,
        'task: 仅根据面部照片的可见信号，输出结构化观察 JSON。禁止输出护肤建议或产品推荐。',
        'output_contract: 严格输出 JSON，schema如下：',
        '{"needs_risk_check":false,"quality_note":null,"observations":[{"cue":"redness|shine|bumps|flaking|uneven_tone|texture|pores","where":"cheeks|forehead|T-zone|chin|nose|全脸","severity":"mild|moderate|high","confidence":"low|med|high","evidence":"所见描述"}],"limits":["可能的观察限制"]}',
        'grounding_rule: observations尽量输出2-4条不同观察。每条 observation 必须包含 where 和 evidence，禁止重复。无足够面部皮肤信号时，observations 可为空数组。',
        'focus: redness, acne-like bumps, oily shine, dryness/flaking, uneven tone, rough texture, visible pores.',
        'skin_type_rule: 用户自选肤质仅作为先验参考，必须与照片观察比对。如不一致可备注一次。',
        'missing_data_policy: 如果画面不足以支持稳定观察，优先输出空或极少 observations，并在 limits / quality_note 中说明限制，不要猜测。',
        qRule,
        `dto: ${JSON.stringify(dto || {})}`,
        '[/SYSTEM_CONTRACT]',
      ].filter(Boolean).join('\n'),
    };
  }
  return {
    promptVersion: version,
    systemInstruction: [
      `Role: You are an objective cosmetic skin cue extractor. Prompt version: ${version}.`,
      'Output MUST be a single strict JSON object and nothing else.',
      'Output ONLY structured observations from the photo. Do NOT provide routines, product advice, or "lean on X" suggestions.',
      'Safety: no disease diagnosis, no treatment claims, no prescription drug names.',
      'Language: English (US).',
    ].join('\n'),
    userPrompt: [
      `[SYSTEM_CONTRACT][version=${version}]`,
      'task: Based only on visible FACE skin cues from the image, output structured observation JSON. No routines or product advice.',
      'output_contract: Return ONLY JSON with this exact schema:',
      '{"needs_risk_check":false,"quality_note":null,"observations":[{"cue":"redness|shine|bumps|flaking|uneven_tone|texture|pores","where":"cheeks|forehead|T-zone|chin|nose|full_face","severity":"mild|moderate|high","confidence":"low|med|high","evidence":"what was visually observed"}],"limits":["possible observation limitations"]}',
      'grounding_rule: Output 2 to 4 distinct observations when visible. Each observation MUST have where + evidence. No duplicates or rephrases. Use an empty observations array when no face skin is visible.',
      'focus: redness, acne-like bumps, oily shine, dryness/flaking, uneven tone, rough texture, visible pores.',
      'skin_type_rule: User-selected skin type is a PRIOR only. Compare against observed cues. Mention mismatch once if relevant.',
      'missing_data_policy: If the image does not support grounded extraction, keep observations empty or minimal and explain the limitation conservatively instead of guessing.',
      qRule,
      `dto: ${JSON.stringify(dto || {})}`,
      '[/SYSTEM_CONTRACT]',
    ].filter(Boolean).join('\n'),
  };
}

function buildSkinReportPromptBundle({ language, dto, promptVersion } = {}) {
  const lang = normalizeLang(language);
  const version = normalizePromptVersion(promptVersion, SKIN_REPORT_MAINLINE_PROMPT_VERSION);
  if (isSkinPromptV3(version)) return buildReportCanonicalPrompt({ dto });
  const qRule = qualityGradeInstruction(dto, lang);
  if (lang === 'zh-CN') {
    return {
      promptVersion: version,
      systemInstruction: [
        '[ROLE]',
        `你是客观、保守的护肤方案合成助手（Pivota）。Prompt version: ${version}.`,
        '输出必须是单个严格 JSON 对象，不要输出 JSON 之外的文本。',
        'Language: 简体中文。',
        '[/ROLE]',
      ].join('\n'),
      userPrompt: [
        '[TASK]',
        '基于提供的观察信号输出谨慎、可执行的护肤策略，不得声称看到了照片。',
        '每个步骤都必须能回扣到已提供 cue/信号，避免泛化建议。',
        '[/TASK]',
        '',
        '[OUTPUT_CONTRACT]',
        '严格输出 JSON，必须包含以下顶层字段：',
        '{ "strategy": string, "needs_risk_check": boolean, "primary_question": string, "conditional_followups": array,',
        '  "routine_expert": { "am_plan": array, "pm_plan": array }, "findings": array, "guidance_brief": array,',
        '  "two_week_focus": array, "next_step_options": array }',
        '可选输出（仅在有明确价值时）：reasoning(1-4条)、deepening(phase/next_phase/question/options)、evidence_refs(最多6条，字段=id/title/url/why_relevant)。',
        '不要添加额外顶层字段。未知字段使用 null、[] 或 {} 代替省略。',
        '[/OUTPUT_CONTRACT]',
        '',
        '[FIELD_SEMANTICS]',
        '- strategy 必须按「原因 -> 注意事项 -> 修复路径 -> 下一问」组织。',
        '- routine_expert 中 am_plan/pm_plan 每步必须包含：{"step":"类型","why":"关联已观察到的cue","look_for":["属性"],"how":"使用方法","caution":"注意事项"}',
        '- findings 数组每项含 cue/where/severity/confidence/evidence。quality 相关信息禁止出现在 findings 中。',
        '- two_week_focus: 最多3条优先行动。如有刺激信号，优先屏障修复。',
        '- guidance_brief: 2-3条简短指导建议，不重复。',
        '- next_step_options: 固定3个选项：[{"id":"analysis_get_recommendations","label":"获取产品推荐"},{"id":"analysis_optimize_existing","label":"优化现有产品"},{"id":"analysis_both_reco_optimize","label":"两者都要"}]。',
        '[/FIELD_SEMANTICS]',
        '',
        '[HARD_RULES]',
        '1. 分离规则：你接收的是视觉阶段的观察结果。不要逐字重复观察，通过 cue 名称引用。',
        '2. 肤质规则：用户自选肤质是先验，非真相。与观察到的 cue 比对，不一致时提及一次。',
        '3. Cue关联规则：每个 routine 步骤必须引用至少1个已观察到的 cue。',
        '4. 安全规则：非医疗诊断；高风险词仅做轻提醒与保守建议，不要主动引导就医。',
        '5. 质量规则：quality 相关信息禁止出现在 findings 中。',
        '[/HARD_RULES]',
        '',
        '[MISSING_DATA_POLICY]',
        '- 如果观察线索较弱或 routine 上下文不足，保持保守，明确标注局限性。',
        '- 不要编造既往 routine、产品、品牌或高置信度结论。',
        '- 如无需 deepening 或 evidence，省略这些可选块。',
        '[/MISSING_DATA_POLICY]',
        '',
        '[FORBIDDEN_BEHAVIOR]',
        '- 禁止疾病诊断、治疗宣称、处方药名称。',
        '- 禁止品牌与具体产品推荐。',
        '- 禁止空泛模板话术或重复免责声明。',
        '- 禁止无依据的置信度升级。',
        '[/FORBIDDEN_BEHAVIOR]',
        '',
        '[INPUT_CONTEXT]',
        qRule,
        `dto: ${JSON.stringify(dto || {})}`,
        '[/INPUT_CONTEXT]',
      ].filter(Boolean).join('\n'),
    };
  }
  return {
    promptVersion: version,
    systemInstruction: [
      '[ROLE]',
      `You are an objective, conservative cosmetic skincare report synthesizer for Pivota. Prompt version: ${version}.`,
      'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
      'Language: English (US).',
      '[/ROLE]',
    ].join('\n'),
    userPrompt: [
      '[TASK]',
      'Provide cautious and actionable skincare strategy using only provided observation signals.',
      'Do not claim photo visibility unless explicitly stated. Every recommendation step must be traceable to observed cues or deterministic inputs.',
      '[/TASK]',
      '',
      '[OUTPUT_CONTRACT]',
      'Return strict JSON with these required top-level keys:',
      '{ "strategy": string, "needs_risk_check": boolean, "primary_question": string, "conditional_followups": array,',
      '  "routine_expert": { "am_plan": array, "pm_plan": array }, "findings": array, "guidance_brief": array,',
      '  "two_week_focus": array, "next_step_options": array }',
      'Optional keys when they add clear value: reasoning (array of 1-4 strings), deepening (object with phase/next_phase/question/options), evidence_refs (max 6 items with id/title/url/why_relevant).',
      'Do not add extra top-level keys. If a field is unknown, use null, [] or {} instead of omitting it.',
      '[/OUTPUT_CONTRACT]',
      '',
      '[FIELD_SEMANTICS]',
      '- strategy must follow "Cause -> Watchouts -> Repair path -> Next question" and must not be generic.',
      '- routine_expert am_plan/pm_plan each step MUST contain: {"step":"type","why":"tied to observed cue","look_for":["product attributes"],"how":"application method","caution":"warnings"}',
      '- findings: each item has cue/where/severity/confidence/evidence. Quality info must NEVER appear inside findings.',
      '- two_week_focus: max 3 priority actions. Prioritize barrier stabilization if irritation signals exist.',
      '- guidance_brief: 2-3 concise guidance bullets. No duplicates.',
      '- next_step_options: exactly 3 options: [{"id":"analysis_get_recommendations","label":"Get recommendations"},{"id":"analysis_optimize_existing","label":"Optimize existing products"},{"id":"analysis_both_reco_optimize","label":"Both"}].',
      '[/FIELD_SEMANTICS]',
      '',
      '[HARD_RULES]',
      '1. Separation rule: you receive observations from the vision stage. Do NOT repeat them verbatim. Reference observations by cue name only.',
      '2. Skin-type rule: user-selected skin type is a PRIOR, not ground truth. Compare against observed cues. Mention mismatch once if relevant.',
      '3. Cue-linking rule: each routine step must reference at least 1 observed cue.',
      '4. Safety rule: non-medical guidance only; for risk terms give light caution + conservative plan, no proactive care-seeking escalation.',
      '5. Quality rule: quality-related information must NEVER appear inside findings.',
      '[/HARD_RULES]',
      '',
      '[MISSING_DATA_POLICY]',
      '- If cues are weak or routine context is missing, keep the plan conservative and explicitly limited.',
      '- Do not invent detailed routine history, products, brands, or high-confidence conclusions.',
      '- If no deepening or evidence is warranted, omit those optional blocks.',
      '[/MISSING_DATA_POLICY]',
      '',
      '[FORBIDDEN_BEHAVIOR]',
      '- No disease diagnoses, treatment claims, or prescription drug names.',
      '- No brand or specific product recommendations.',
      '- No generic template talk or repeated disclaimer phrasing.',
      '- No unsupported confidence escalation.',
      '[/FORBIDDEN_BEHAVIOR]',
      '',
      '[INPUT_CONTEXT]',
      qRule,
      `dto: ${JSON.stringify(dto || {})}`,
      '[/INPUT_CONTEXT]',
    ].filter(Boolean).join('\n'),
  };
}

// Legacy wrappers retained for compatibility with existing non-mainline call sites.
function buildSkinVisionPrompt({ language, photoQuality, diagnosisPolicy, diagnosisV1, profileSummary, promptVersion } = {}) {
  const bundle = buildSkinVisionPromptBundle({
    language,
    promptVersion,
    dto: {
      profile: compactProfile(profileSummary),
      photo_quality: photoQuality && typeof photoQuality === 'object'
        ? { grade: photoQuality.grade || 'unknown', reasons: Array.isArray(photoQuality.reasons) ? photoQuality.reasons.slice(0, 6) : [] }
        : { grade: 'unknown', reasons: [] },
      ...(diagnosisPolicy && typeof diagnosisPolicy === 'object' ? { detector_policy: diagnosisPolicy } : {}),
      ...(diagnosisV1 ? { detector_candidates: pickDetectorCandidates(diagnosisV1, { max: 2 }) } : {}),
    },
  });
  return `${bundle.systemInstruction}\n${bundle.userPrompt}`;
}

function buildSkinReportPrompt({
  language,
  photoQuality,
  diagnosisPolicy,
  diagnosisV1,
  profileSummary,
  routineCandidate,
  recentLogsSummary,
  promptVersion,
} = {}) {
  const bundle = buildSkinReportPromptBundle({
    language,
    promptVersion,
    dto: {
      profile: compactProfile(profileSummary),
      recent_logs_n: Array.isArray(recentLogsSummary) ? recentLogsSummary.length : 0,
      routine_actives: summarizeRoutineActives(routineCandidate),
      photo_quality: photoQuality && typeof photoQuality === 'object'
        ? { grade: photoQuality.grade || 'unknown', reasons: Array.isArray(photoQuality.reasons) ? photoQuality.reasons.slice(0, 6) : [] }
        : { grade: 'unknown', reasons: [] },
      ...(diagnosisPolicy && typeof diagnosisPolicy === 'object' ? { detector_policy: diagnosisPolicy } : {}),
      ...(diagnosisV1 ? { detector_candidates: pickDetectorCandidates(diagnosisV1, { max: 2 }) } : {}),
    },
  });
  return `${bundle.systemInstruction}\n${bundle.userPrompt}`;
}

function buildSkinDeepeningPromptBundle({ language, dto, promptVersion } = {}) {
  const lang = normalizeLang(language);
  const version = normalizePromptVersion(promptVersion, SKIN_DEEPENING_MAINLINE_PROMPT_VERSION);
  if (isSkinDeepeningV2(version)) return buildDeepeningCanonicalPrompt({ dto });
  const d = dto && typeof dto === 'object' ? dto : {};
  const profileStr = JSON.stringify(d.profile || {});
  const phaseStr = String(d.phase || 'photo_optin');
  const photoChoice = String(d.photo_choice || 'unknown');
  const productsSubmitted = Boolean(d.products_submitted);
  const reactionsStr = Array.isArray(d.reactions) && d.reactions.length ? d.reactions.join(', ') : '';
  const routineActives = Array.isArray(d.routine_actives) && d.routine_actives.length ? d.routine_actives.join(', ') : '';

  if (lang === 'zh-CN') {
    const phaseGuideCn = {
      photo_optin:
        '当前阶段 = photo_optin。在 narrative 中总结用户皮肤类型与目标，给出初步专业评估，并自然引导是否愿意上传照片做深度分析。deepening_question 必须问是否愿意上传自拍。',
      products:
        '当前阶段 = products。在 narrative 中展示你对其皮肤状态的判断，并引导用户分享 AM/PM 护肤产品清单。deepening_question 询问当前在用哪些步骤/产品。',
      reactions:
        '当前阶段 = reactions。基于其已有信息给出具体护肤建议，再追问最近使用后的皮肤反应。deepening_options 必须包含 6 个具体可选反应（干燥加重/皮肤紧绷/刺痛或灼热/泛红加重/新爆痘/无明显不适）。',
      refined:
      '当前阶段 = refined。基于反应反馈给出针对性微调方案，确认 7 天执行计划，并提供第 3 天 / 第 7 天回检提示。',
    };
    const guide = phaseGuideCn[phaseStr] || phaseGuideCn.photo_optin;

    return {
      promptVersion: version,
      systemInstruction: [
        '[ROLE]',
        `你是亲切、专业的护肤深挖顾问（Pivota）。Prompt version: ${version}.`,
        '输出必须是单个严格 JSON 对象，不要输出 JSON 之外的文本。',
        'Language: 简体中文。',
        '[/ROLE]',
      ].join('\n'),
      userPrompt: [
        '[TASK]',
        '根据以下用户皮肤档案与深挖阶段，生成个性化护肤深挖回复。',
        '风格：温暖、直接，避免泛化模板话术，必须针对用户实际档案说明原因。',
        '[/TASK]',
        '',
        '[OUTPUT_CONTRACT]',
        '严格输出 JSON，必须包含以下顶层字段：',
        '{ "narrative": string, "reasoning": string[], "deepening_question": string, "deepening_options": string[] }',
        '不要添加额外顶层字段。',
        '[/OUTPUT_CONTRACT]',
        '',
        '[FIELD_SEMANTICS]',
        '- narrative: 2-3 句个性化开场（必须提及用户档案中的具体信息如皮肤类型/目标），禁止泛化。',
        '- reasoning: 3-4 条具体可执行建议，按「原因 -> 注意细节 -> 修复路径 -> 阶段提示」顺序，每条 <= 100 字。',
        '- deepening_question: 针对当前阶段的自然追问（<= 60 字）。',
        '- deepening_options: 2-6 个具体选项（每项 <= 40 字），与 deepening_question 匹配。',
        '- 最多3个追问。每个追问必须对应一个具体的护肤方案调整。',
        '[/FIELD_SEMANTICS]',
        '',
        '[HARD_RULES]',
        '1. 阶段忠实度规则：reasoning 和 deepening_question 必须与当前阶段匹配。',
        '2. 匹配规则：deepening_question 与 deepening_options 必须逻辑一致。',
        '3. 安全规则：禁止疾病诊断（玫瑰痤疮/湿疹/牛皮癣等）、禁止处方药名称、禁止治疗宣称。',
        '4. 落地规则：narrative 每句必须引用用户档案中的具体属性，不要写泛化内容。',
        '5. 可执行规则：例如"产品使用时刺痛吗？"->屏障优先，减少活性成分。"凸起是否发痒？"->按刺激而非痘痘处理。',
        '[/HARD_RULES]',
        '',
        '[MISSING_DATA_POLICY]',
        '- 如果当前阶段信息不足，保持保守，不要假装知道用户完整 routine、反应史或照片细节。',
        '- 信息不足时，提出下一个最有价值的问题，而非编造答案。',
        '[/MISSING_DATA_POLICY]',
        '',
        '[FORBIDDEN_BEHAVIOR]',
        '- 禁止品牌或具体产品推荐。',
        '- 禁止疾病判断或处方药引用。',
        '- 禁止长篇泛化安慰话术或模板填充。',
        '[/FORBIDDEN_BEHAVIOR]',
        '',
        '[INPUT_CONTEXT]',
        guide,
        `profile: ${profileStr}`,
        `photo_choice: ${photoChoice}`,
        `products_submitted: ${productsSubmitted}`,
        routineActives ? `routine_actives: ${routineActives}` : '',
        reactionsStr ? `reactions_so_far: ${reactionsStr}` : '',
        '[/INPUT_CONTEXT]',
      ].filter(Boolean).join('\n'),
    };
  }

  const phaseGuideEn = {
    photo_optin:
      'Current phase = photo_optin. In narrative: summarize user skin type + goals, give initial professional read, naturally invite a selfie for deeper analysis. deepening_question must ask about uploading a photo.',
    products:
      'Current phase = products. In narrative: show your read on their skin state, then invite them to share AM/PM product list. deepening_question asks about current routine steps/products.',
    reactions:
      'Current phase = reactions. Give concrete advice based on available info, then ask about recent post-use skin reactions. deepening_options must include 6 specific reactions (dryness/tightness/stinging-burning/increased redness/new breakouts/no noticeable discomfort).',
    refined:
      'Current phase = refined. Based on reaction feedback, give targeted adjustments, confirm 7-day plan, and include day-3/day-7 check-in reminders.',
  };
  const guide = phaseGuideEn[phaseStr] || phaseGuideEn.photo_optin;

  return {
    promptVersion: version,
    systemInstruction: [
      '[ROLE]',
      `You are a warm, professional skincare deepening advisor for Pivota. Prompt version: ${version}.`,
      'Return one single valid JSON object only. No markdown, no code fences, no prose outside JSON.',
      'Language: English (US).',
      '[/ROLE]',
    ].join('\n'),
    userPrompt: [
      '[TASK]',
      'Generate a personalized skin deepening narrative for the current conversation phase.',
      'Ground advice in the user\'s actual profile. Avoid generic template language.',
      '[/TASK]',
      '',
      '[OUTPUT_CONTRACT]',
      'Return strict JSON with these required top-level keys:',
      '{ "narrative": string, "reasoning": string[], "deepening_question": string, "deepening_options": string[] }',
      'Do not add extra top-level keys.',
      '[/OUTPUT_CONTRACT]',
      '',
      '[FIELD_SEMANTICS]',
      '- narrative: 2-3 personalized sentences referencing specific profile info like skin type/goals.',
      '- reasoning: 3-4 specific actionable lines following Cause -> Watchout -> Repair path -> Phase tip, each <= 100 chars.',
      '- deepening_question: natural next question for this phase (<= 60 chars).',
      '- deepening_options: 2-6 specific options (each <= 40 chars) matching the deepening_question.',
      '- Max 3 follow-up questions total. Each must map to a specific routine change.',
      '[/FIELD_SEMANTICS]',
      '',
      '[HARD_RULES]',
      '1. Phase-fidelity rule: reasoning and deepening_question must stay appropriate for the current phase.',
      '2. Matching rule: deepening_question and deepening_options must be logically consistent with each other.',
      '3. Safety rule: no disease diagnosis (rosacea/eczema/psoriasis), no prescription drug names, no treatment claims.',
      '4. Grounding rule: every narrative sentence must reference a specific profile attribute, not generic filler.',
      '5. Actionability rule: e.g. "Do products sting?" -> barrier-first, reduce actives. "Are bumps itchy?" -> treat as irritation, not acne.',
      '[/HARD_RULES]',
      '',
      '[MISSING_DATA_POLICY]',
      '- If the current phase lacks enough context, stay conservative and ask the next best question.',
      '- Do not pretend to know routine history, reaction history, or photo details.',
      '[/MISSING_DATA_POLICY]',
      '',
      '[FORBIDDEN_BEHAVIOR]',
      '- No brand or specific product recommendations.',
      '- No disease framing or prescription references.',
      '- No long generic pep-talks or template filler.',
      '[/FORBIDDEN_BEHAVIOR]',
      '',
      '[INPUT_CONTEXT]',
      guide,
      `profile: ${profileStr}`,
      `photo_choice: ${photoChoice}`,
      `products_submitted: ${productsSubmitted}`,
      routineActives ? `routine_actives: ${routineActives}` : '',
      reactionsStr ? `reactions_so_far: ${reactionsStr}` : '',
      '[/INPUT_CONTEXT]',
    ].filter(Boolean).join('\n'),
  };
}

module.exports = {
  buildSkinVisionPrompt,
  buildSkinReportPrompt,
  buildSkinVisionPromptBundle,
  buildSkinReportPromptBundle,
  buildSkinDeepeningPromptBundle,
  buildVisionCanonicalPrompt,
  buildReportCanonicalPrompt,
  buildDeepeningCanonicalPrompt,
  SKIN_REPORT_MAINLINE_PROMPT_VERSION,
  SKIN_DEEPENING_MAINLINE_PROMPT_VERSION,
  SKIN_VISION_MAINLINE_PROMPT_VERSION,
  isSkinPromptV3,
  isSkinDeepeningV2,
  pickDetectorCandidates,
  summarizeRoutineActives,
};
