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

function buildSkinVisionPrompt({ language, photoQuality, diagnosisPolicy, diagnosisV1, profileSummary, promptVersion } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const replyLanguage = lang === 'CN' ? 'Simplified Chinese' : 'English';
  const replyInstruction = lang === 'CN' ? '只用简体中文。' : 'Reply ONLY in English.';
  const version =
    typeof promptVersion === 'string' && promptVersion.trim() ? promptVersion.trim().toLowerCase() : 'v1';

  const quality = photoQuality && typeof photoQuality === 'object'
    ? { grade: photoQuality.grade || 'unknown', reasons: Array.isArray(photoQuality.reasons) ? photoQuality.reasons.slice(0, 6) : [] }
    : { grade: 'unknown', reasons: [] };
  const policy = diagnosisPolicy && typeof diagnosisPolicy === 'object' ? diagnosisPolicy : null;

  const context = {
    profile: compactProfile(profileSummary),
    photo_quality: quality,
    ...(policy ? { detector_policy: policy } : {}),
    ...(diagnosisV1 ? { detector_candidates: pickDetectorCandidates(diagnosisV1, { max: 2 }) } : {}),
  };

  if (version === 'v2') {
    return (
      `prompt_version=v2\n` +
      `context=${JSON.stringify(context)}\n` +
      `Task: Use the photo ONLY for visible cosmetic skin signals. Focus on face skin only; ignore hair/eyes/lips/background. If unclear (blur/lighting), be conservative and use "not_sure".\n` +
      `Hard rules: no medical diagnosis, no disease names, no treatment plans, no prescription drug names.\n` +
      `Output STRICT JSON only (no markdown/text) with keys: features[], strategy, needs_risk_check.\n` +
      `- features: 3–5 items; observation<=200 chars; confidence in {"pretty_sure","somewhat_sure","not_sure"}.\n` +
      `- strategy: <=700 chars, actionable, ends with ONE direct clarifying question.\n` +
      `- no brand/product recommendations.\n` +
      `Language: ${replyLanguage}. ${replyInstruction}\n`
    );
  }

  return (
    `prompt_version=v1\n` +
    `context=${JSON.stringify(context)}\n` +
    `Task: Use the photo ONLY for visible cosmetic skin signals (redness, acne-like bumps, shine, dryness/flaking, uneven tone, texture). Focus on face skin only; ignore hair/eyes/lips/background. If unclear (blur/lighting), be conservative and use "not_sure".\n` +
    `Hard rules: no medical diagnosis, no disease names, no treatment plans, no prescription drug names.\n` +
    `Output STRICT JSON only (no markdown/text) with keys: features[], strategy, needs_risk_check.\n` +
    `- features: 4–6 items; each {"observation": string<=200 chars, "confidence": "pretty_sure"|"somewhat_sure"|"not_sure"}; no numbers/percent.\n` +
    `- strategy: <=900 chars, actionable, ends with ONE direct clarifying question.\n` +
    `- no brand/product recommendations.\n` +
    `Language: ${replyLanguage}. ${replyInstruction}\n`
  );
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
  const lang = language === 'CN' ? 'CN' : 'EN';
  const replyLanguage = lang === 'CN' ? 'Simplified Chinese' : 'English';
  const replyInstruction = lang === 'CN' ? '只用简体中文。' : 'Reply ONLY in English.';
  const version =
    typeof promptVersion === 'string' && promptVersion.trim() ? promptVersion.trim().toLowerCase() : 'v1';

  const quality = photoQuality && typeof photoQuality === 'object'
    ? { grade: photoQuality.grade || 'unknown', reasons: Array.isArray(photoQuality.reasons) ? photoQuality.reasons.slice(0, 6) : [] }
    : { grade: 'unknown', reasons: [] };
  const policy = diagnosisPolicy && typeof diagnosisPolicy === 'object' ? diagnosisPolicy : null;
  const routineActives = summarizeRoutineActives(routineCandidate);
  const logsN = Array.isArray(recentLogsSummary) ? recentLogsSummary.length : 0;

  const context = {
    profile: compactProfile(profileSummary),
    recent_logs_n: logsN,
    routine_actives: routineActives,
    photo_quality: quality,
    ...(policy ? { detector_policy: policy } : {}),
    ...(diagnosisV1 ? { detector_candidates: pickDetectorCandidates(diagnosisV1, { max: 2 }) } : {}),
  };

  if (version === 'v2') {
    return (
      `prompt_version=v2\n` +
      `context=${JSON.stringify(context)}\n` +
      `Task: Provide a cautious skin assessment using ONLY the context. Do NOT claim you can see the user's skin in a photo.\n` +
      `If routine_actives suggests irritation risk, suggest minimal safe adjustments (no new brands).\n` +
      `Hard rules: no medical diagnosis, no disease names, no treatment plans, no prescription drug names.\n` +
      `Output STRICT JSON only (no markdown/text) with keys: features[], strategy, needs_risk_check.\n` +
      `- features: 3–5 items; observation<=200 chars; confidence in {"pretty_sure","somewhat_sure","not_sure"}.\n` +
      `- strategy: <=700 chars, actionable, ends with ONE direct clarifying question.\n` +
      `- no brand/product recommendations.\n` +
      `Language: ${replyLanguage}. ${replyInstruction}\n`
    );
  }

  return (
    `prompt_version=v1\n` +
    `context=${JSON.stringify(context)}\n` +
    `Task: Provide a cautious skin assessment using ONLY the context. Do NOT claim you can see the user's skin in a photo.\n` +
    `If routine_actives suggests irritation risk, suggest minimal safe adjustments (no new brands).\n` +
    `Hard rules: no medical diagnosis, no disease names, no treatment plans, no prescription drug names.\n` +
    `Output STRICT JSON only (no markdown/text) with keys: features[], strategy, needs_risk_check.\n` +
    `- features: 4–6 items; each observation<=200 chars; confidence in {"pretty_sure","somewhat_sure","not_sure"}; no numbers/percent.\n` +
    `- strategy: <=900 chars, actionable, ends with ONE direct clarifying question.\n` +
    `- no brand/product recommendations.\n` +
    `Language: ${replyLanguage}. ${replyInstruction}\n`
  );
}

module.exports = {
  buildSkinVisionPrompt,
  buildSkinReportPrompt,
  pickDetectorCandidates,
  summarizeRoutineActives,
};
