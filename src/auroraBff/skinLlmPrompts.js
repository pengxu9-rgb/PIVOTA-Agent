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

function buildSkinVisionPromptBundle({ language, dto, promptVersion } = {}) {
  const lang = normalizeLang(language);
  const version = typeof promptVersion === 'string' && promptVersion.trim() ? promptVersion.trim() : 'skin_hotfix_v1';
  if (lang === 'zh-CN') {
    return {
      promptVersion: version,
      systemInstruction:
        'Role: 你是客观、保守的护肤观察助手。仅基于可见美容信号给建议。禁止疾病诊断、治疗宣称、处方药名称、品牌与具体产品推荐。Language: 简体中文。',
      userPrompt:
        `task: 仅根据面部照片的可见信号，输出保守且可执行的美容护肤观察与建议。\n` +
        `focus: redness, acne-like bumps, oily shine, dryness/flaking, uneven tone, rough texture, visible pores.\n` +
        `dto: ${JSON.stringify(dto || {})}`,
    };
  }
  return {
    promptVersion: version,
    systemInstruction:
      'Role: You are an objective, conservative cosmetic skincare observer. Safety: no disease diagnosis, no treatment claims, no prescription drug names, no brand or specific product recommendations. Language: English (US).',
    userPrompt:
      `task: Based only on visible FACE skin cues from the image, provide conservative cosmetic observations and practical guidance.\n` +
      `focus: redness, acne-like bumps, oily shine, dryness/flaking, uneven tone, rough texture, visible pores.\n` +
      `dto: ${JSON.stringify(dto || {})}`,
  };
}

function buildSkinReportPromptBundle({ language, dto, promptVersion } = {}) {
  const lang = normalizeLang(language);
  const version = typeof promptVersion === 'string' && promptVersion.trim() ? promptVersion.trim() : 'skin_hotfix_v1';
  if (lang === 'zh-CN') {
    return {
      promptVersion: version,
      systemInstruction:
        'Role: 你是客观、保守的护肤建议助手。仅基于输入信号给出策略。禁止疾病诊断、治疗宣称、处方药名称、品牌与具体产品推荐。Language: 简体中文。',
      userPrompt:
        `task: 基于提供的文本信号输出谨慎、可执行的护肤策略，不得声称看到了照片。\n` +
        `dto: ${JSON.stringify(dto || {})}`,
    };
  }
  return {
    promptVersion: version,
    systemInstruction:
      'Role: You are an objective, conservative cosmetic skincare advisor. Safety: no disease diagnosis, no treatment claims, no prescription drug names, no brand or specific product recommendations. Language: English (US).',
    userPrompt:
      `task: Provide cautious and actionable skincare strategy using only provided text signals. Do not claim photo visibility unless explicitly stated.\n` +
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

module.exports = {
  buildSkinVisionPrompt,
  buildSkinReportPrompt,
  buildSkinVisionPromptBundle,
  buildSkinReportPromptBundle,
  pickDetectorCandidates,
  summarizeRoutineActives,
};
