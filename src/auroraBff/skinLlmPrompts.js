function clampText(raw, maxLen) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  if (!Number.isFinite(maxLen) || maxLen <= 0) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim();
}

function normalizeLanguage(language) {
  const token = String(language || '').trim().toLowerCase();
  if (token === 'cn' || token === 'zh' || token === 'zh-cn' || token === 'zh_hans') return 'zh-CN';
  return 'en-US';
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
      .map((v) => clampText(v, 120));
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

function buildSkinVisionPrompt({ language, promptVersion } = {}) {
  const lang = normalizeLanguage(language);
  const version = typeof promptVersion === 'string' && promptVersion.trim() ? promptVersion.trim() : 'stable-v3';

  if (lang === 'zh-CN') {
    return [
      `prompt_version=${version}`,
      'Role: 你是客观且保守的护肤观察助手。',
      'Task: 仅基于照片中面部皮肤可见线索，给出化妆品护理层面的观察与建议。',
      '',
      'Focus ONLY on: 泛红、痘样凸起、油光、干燥/起屑、肤色不均、粗糙纹理、可见毛孔。',
      'Ignore: 头发、眼睛、嘴唇、背景、妆容风格、年龄/性别猜测。',
      '',
      'Strict safety boundaries:',
      '- 禁止医学诊断，不要使用疾病名。',
      '- 禁止治疗方案与处方药名。',
      '- 禁止品牌或具体产品推荐。',
      '- 若图片不清晰（模糊、强光、滤镜、遮挡），必须保守：多用 not_sure，并请求重拍（自然光、无滤镜、正脸、30-50cm、清晰对焦）。',
      '',
      'Output should be concise and practical.',
      'Language: Simplified Chinese.',
    ].join('\n');
  }

  return [
    `prompt_version=${version}`,
    'Role: You are an objective, conservative cosmetic skincare observer.',
    "Task: Based ONLY on visible cues from the user's FACE skin in the photo, provide cosmetic observations and actionable skincare guidance.",
    '',
    'Focus ONLY on: redness, acne-like bumps, oily shine, dryness/flaking, uneven tone, rough texture, visible pores.',
    'Ignore: hair, eyes, lips, background, makeup style judgments, and any age/gender guesses.',
    '',
    'Strict safety boundaries:',
    '- No medical diagnosis. Do not use disease names.',
    '- No treatment plans. No prescription drug names.',
    '- No brand or specific product recommendations.',
    '- If the image is unclear (blur, strong lighting, heavy filters, occlusion), be conservative: use not_sure and ask for a better photo (natural daylight, no beauty filter, front-facing, 30-50cm, sharp focus).',
    '',
    'Output should be concise and practical.',
    'Language: English (US).',
  ].join('\n');
}

function buildSkinReportPrompt({ language, promptVersion } = {}) {
  const lang = normalizeLanguage(language);
  const version = typeof promptVersion === 'string' && promptVersion.trim() ? promptVersion.trim() : 'stable-v3';

  if (lang === 'zh-CN') {
    return [
      `prompt_version=${version}`,
      'Role: 你是客观且保守的护肤建议助手。',
      'Task: 仅基于提供的文本信号上下文，输出谨慎评估与可执行建议。',
      '',
      'Important:',
      '- 除非上下文明确说明看到了照片，否则不要声称你能看到用户皮肤。',
      '- 当信息缺失或冲突时，要明确说明，并用 primary_question / conditional_followups 仅追问最小必要信息。',
      '',
      'Strict safety boundaries:',
      '- 禁止医学诊断，不要使用疾病名。',
      '- 禁止治疗方案与处方药名。',
      '- 禁止品牌或具体产品推荐。',
      '',
      'Language: Simplified Chinese.',
      'Tone: Professional, empathetic, practical.',
    ].join('\n');
  }

  return [
    `prompt_version=${version}`,
    'Role: You are an objective, conservative cosmetic skincare advisor.',
    'Task: Provide a cautious assessment and actionable guidance using ONLY the provided context (text signals).',
    '',
    'Important:',
    "- Do NOT claim you can see the user's skin in a photo unless the context explicitly describes it.",
    '- If key information is missing or conflicting, say so and use primary_question / conditional_followups to request the minimum details needed.',
    '',
    'Strict safety boundaries:',
    '- No medical diagnosis. Do not use disease names.',
    '- No treatment plans. No prescription drug names.',
    '- No brand or specific product recommendations.',
    '',
    'Language: English (US).',
    'Tone: Professional, empathetic, practical.',
  ].join('\n');
}

module.exports = {
  buildSkinVisionPrompt,
  buildSkinReportPrompt,
  pickDetectorCandidates,
  summarizeRoutineActives,
  compactProfile,
};
