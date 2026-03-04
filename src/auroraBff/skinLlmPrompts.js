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

function buildSkinVisionPromptBundle({ language, dto, promptVersion } = {}) {
  const lang = normalizeLang(language);
  const version = typeof promptVersion === 'string' && promptVersion.trim() ? promptVersion.trim() : 'skin_v2';
  const qRule = qualityGradeInstruction(dto, lang);
  if (lang === 'zh-CN') {
    return {
      promptVersion: version,
      systemInstruction:
        'Role: 你是客观的护肤观察助手。仅输出基于照片可见信号的观察，禁止给出护肤建议、产品推荐、日常方案。禁止疾病诊断、治疗宣称、处方药名称。Language: 简体中文。',
      userPrompt:
        `task: 仅根据面部照片的可见信号，输出结构化观察JSON。禁止输出护肤建议或产品推荐。\n` +
        `output_contract: 严格输出JSON，schema如下：\n` +
        `{"quality_note": null | "1句关于光线/模糊的说明", "observations": [{"cue": "redness|shine|bumps|flaking|uneven_tone|texture|pores", "where": "cheeks|forehead|T-zone|chin|nose|全脸", "severity": "mild|moderate|high", "confidence": "low|med|high", "evidence": "所见描述"}], "limits": ["可能的观察限制"]}\n` +
        `grounding_rule: 尽量输出至少5条不同观察。每条必须包含where和evidence。禁止重复或换句话说同一观察。\n` +
        `focus: redness, acne-like bumps, oily shine, dryness/flaking, uneven tone, rough texture, visible pores.\n` +
        `skin_type_rule: 用户自选肤质仅作为先验参考，必须与照片观察比对。如不一致可备注一次。` +
        qRule + `\n` +
        `dto: ${JSON.stringify(dto || {})}`,
    };
  }
  return {
    promptVersion: version,
    systemInstruction:
      'Role: You are an objective cosmetic skincare observer. Output ONLY structured observations from the photo. Do NOT provide routines, product advice, or "lean on X" suggestions. Safety: no disease diagnosis, no treatment claims, no prescription drug names. Language: English (US).',
    userPrompt:
      `task: Based only on visible FACE skin cues from the image, output structured observation JSON. No routines or product advice.\n` +
      `output_contract: Return ONLY JSON with this exact schema:\n` +
      `{"quality_note": null | "1 sentence about lighting/blur issue", "observations": [{"cue": "redness|shine|bumps|flaking|uneven_tone|texture|pores", "where": "cheeks|forehead|T-zone|chin|nose|full_face", "severity": "mild|moderate|high", "confidence": "low|med|high", "evidence": "what was visually observed"}], "limits": ["possible observation limitations"]}\n` +
      `grounding_rule: Output at least 5 distinct observations when visible. Each MUST have where + evidence. No observation may be a rephrase of another.\n` +
      `focus: redness, acne-like bumps, oily shine, dryness/flaking, uneven tone, rough texture, visible pores.\n` +
      `skin_type_rule: User-selected skin type is a PRIOR only. Compare against observed cues. Mention mismatch once if relevant.` +
      qRule + `\n` +
      `dto: ${JSON.stringify(dto || {})}`,
  };
}

function buildSkinReportPromptBundle({ language, dto, promptVersion } = {}) {
  const lang = normalizeLang(language);
  const version = typeof promptVersion === 'string' && promptVersion.trim() ? promptVersion.trim() : 'skin_v2';
  const qRule = qualityGradeInstruction(dto, lang);
  if (lang === 'zh-CN') {
    return {
      promptVersion: version,
      systemInstruction:
        'Role: 你是客观、保守的护肤建议助手。仅基于输入信号给出策略。禁止疾病诊断、治疗宣称、处方药名称、品牌与具体产品推荐。不要输出空泛模板话术。Language: 简体中文。',
      userPrompt:
        `task: 基于提供的观察信号输出谨慎、可执行的护肤策略，不得声称看到了照片。\n` +
        `output_contract: 严格输出 JSON，必须包含 strategy/needs_risk_check/primary_question/conditional_followups/routine_expert/findings/guidance_brief。\n` +
        `structure_rule: strategy 必须按「原因 -> 注意事项 -> 修复路径 -> 下一问」组织，避免泛化建议。\n` +
        `separation_rule: 你接收的是视觉阶段的观察结果。不要逐字重复观察。通过cue名称引用观察。你的输出仅包含方案/计划JSON。\n` +
        `routine_step_schema: routine_expert中的am_plan/pm_plan每步必须包含：{"step":"类型","why":"关联已观察到的cue","look_for":["属性"],"how":"使用方法","caution":"注意事项"}\n` +
        `two_week_focus: 输出最多3条优先行动的two_week_focus数组。如有刺激信号，优先屏障修复。\n` +
        `skin_type_rule: 用户自选肤质是先验，非真相。与观察到的cue比对。不一致时提及一次。\n` +
        `deepening_rule: 可选输出 reasoning(1-4条)、deepening(phase/next_phase/question/options)、evidence_refs(最多6条，字段=id/title/url/why_relevant)。\n` +
        `safety_rule: 非医疗诊断；高风险词仅做轻提醒与保守建议，不要主动引导就医。\n` +
        `findings_rule: 输出findings数组，每项含cue/where/severity/confidence/evidence。quality相关信息禁止出现在findings中。\n` +
        `guidance_brief_rule: 输出2-3条简短指导建议，不重复。\n` +
        `next_step_rule: 诊断后输出next_step_options数组，固定3个选项：[{"id":"analysis_get_recommendations","label":"获取产品推荐"},{"id":"analysis_optimize_existing","label":"优化现有产品"},{"id":"analysis_both_reco_optimize","label":"两者都要"}]。` +
        qRule + `\n` +
        `dto: ${JSON.stringify(dto || {})}`,
    };
  }
  return {
    promptVersion: version,
    systemInstruction:
      'Role: You are an objective, conservative cosmetic skincare advisor. Safety: no disease diagnosis, no treatment claims, no prescription drug names, no brand or specific product recommendations. Avoid generic template talk. Language: English (US).',
    userPrompt:
      `task: Provide cautious and actionable skincare strategy using only provided observation signals. Do not claim photo visibility unless explicitly stated.\n` +
      `output_contract: Return strict JSON with strategy/needs_risk_check/primary_question/conditional_followups/routine_expert/findings/guidance_brief.\n` +
      `structure_rule: strategy must follow "Cause -> Watchouts -> Repair path -> Next question", and must not be generic.\n` +
      `separation_rule: You receive observations from the vision stage. Do NOT repeat them verbatim. Reference observations by cue name. Your output is routine/plan JSON only.\n` +
      `routine_step_schema: Each step in routine_expert am_plan/pm_plan MUST contain: {"step":"type","why":"tied to observed cue","look_for":["product attributes"],"how":"application method","caution":"warnings"}\n` +
      `two_week_focus: Output a two_week_focus array of max 3 priority actions. Prioritize barrier stabilization if irritation signals exist.\n` +
      `skin_type_rule: User-selected skin type is a PRIOR, not ground truth. Compare against observed cues. Mention mismatch once if relevant. Each routine step must reference at least 1 observed cue.\n` +
      `deepening_rule: You may include reasoning(1-4 strings), deepening(phase/next_phase/question/options), evidence_refs(max 6 items with id/title/url/why_relevant).\n` +
      `safety_rule: non-medical guidance only; for risk terms give light caution + conservative plan, no proactive care-seeking escalation.\n` +
      `findings_rule: Output a findings array where each item has cue/where/severity/confidence/evidence. Quality info must NEVER appear inside findings.\n` +
      `guidance_brief_rule: Output 2-3 concise guidance bullets. No duplicates.\n` +
      `next_step_rule: After diagnosis, output next_step_options array with exactly 3 options: [{"id":"analysis_get_recommendations","label":"Get recommendations"},{"id":"analysis_optimize_existing","label":"Optimize existing products"},{"id":"analysis_both_reco_optimize","label":"Both"}]. Localize labels if language is CN.` +
      qRule + `\n` +
      `dto: ${JSON.stringify(dto || {})}`,
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

function buildSkinDeepeningPromptBundle({ language, dto } = {}) {
  const lang = normalizeLang(language);
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
      promptVersion: 'skin_deepening_v1',
      systemInstruction:
        'Role: 你是亲切、专业的护肤顾问，擅长基于用户皮肤信息给出个性化、可执行的护肤建议。' +
        '安全规则：禁止疾病诊断（玫瑰痤疮/湿疹/牛皮癣等）、禁止处方药名称、禁止治疗宣称、禁止品牌或具体产品推荐。' +
        '风格：温暖、直接，避免泛化模板话术，必须针对用户实际档案说明原因。Language: 简体中文。',
      userPrompt:
        `task: 根据以下用户皮肤档案与深挖阶段，生成个性化护肤深挖回复。\n` +
        `${guide}\n` +
        `profile: ${profileStr}\n` +
        `photo_choice: ${photoChoice}\n` +
        `products_submitted: ${productsSubmitted}\n` +
        (routineActives ? `routine_actives: ${routineActives}\n` : '') +
        (reactionsStr ? `reactions_so_far: ${reactionsStr}\n` : '') +
        `\noutput_rules:\n` +
        `- narrative: 2-3 句个性化开场（必须提及用户档案中的具体信息如皮肤类型/目标），禁止泛化.\n` +
        `- reasoning: 3-4 条具体可执行建议，按「原因 → 注意细节 → 修复路径 → 阶段提示」顺序，每条 ≤ 100 字.\n` +
        `- deepening_question: 针对当前阶段的自然追问（≤ 60 字）.\n` +
        `- deepening_options: 2-6 个具体选项（每项 ≤ 40 字），与 deepening_question 匹配.\n` +
        `- 最多3个追问。每个追问必须对应一个具体的护肤方案调整。\n` +
        `  例如："产品使用时刺痛吗？"→屏障优先，减少活性成分。"凸起是否发痒？"→按刺激而非痘痘处理。`,
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
    promptVersion: 'skin_deepening_v1',
    systemInstruction:
      'Role: You are a warm, professional skincare advisor specializing in evidence-based cosmetic skincare. ' +
      'Safety rules: no disease diagnosis (rosacea/eczema/psoriasis), no prescription drug names, no treatment claims, no brand or specific product names. ' +
      'Style: warm, direct, specific — avoid generic template language, always ground advice in the user\'s actual profile. Language: English (US).',
    userPrompt:
      `task: Generate a personalized skin deepening narrative for the current conversation phase.\n` +
      `${guide}\n` +
      `profile: ${profileStr}\n` +
      `photo_choice: ${photoChoice}\n` +
      `products_submitted: ${productsSubmitted}\n` +
      (routineActives ? `routine_actives: ${routineActives}\n` : '') +
      (reactionsStr ? `reactions_so_far: ${reactionsStr}\n` : '') +
      `\noutput_rules:\n` +
      `- narrative: 2-3 personalized sentences (must reference specific profile info like skin type/goals), no generic language.\n` +
      `- reasoning: 3-4 specific actionable lines following Cause → Watchout → Repair path → Phase tip, each ≤ 100 chars.\n` +
      `- deepening_question: Natural next question for this phase (≤ 60 chars).\n` +
      `- deepening_options: 2-6 specific options (each ≤ 40 chars) matching the deepening_question.\n` +
      `- Max 3 follow-up questions total. Each must map to a specific routine change.\n` +
      `  e.g. "Do products sting?" → barrier-first, reduce actives. "Are bumps itchy?" → treat as irritation, not acne.`,
  };
}

module.exports = {
  buildSkinVisionPrompt,
  buildSkinReportPrompt,
  buildSkinVisionPromptBundle,
  buildSkinReportPromptBundle,
  buildSkinDeepeningPromptBundle,
  pickDetectorCandidates,
  summarizeRoutineActives,
};
