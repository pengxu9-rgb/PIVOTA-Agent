const { normalizeRouteLanguage } = require('./skinAnalysisContract');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePhotoQualityGrade(grade) {
  const token = String(grade || '').trim().toLowerCase();
  if (token === 'pass' || token === 'good') return 'good';
  if (token === 'degraded' || token === 'ok') return 'ok';
  if (token === 'fail' || token === 'poor' || token === 'unknown') return 'poor';
  return 'poor';
}

function mapIssueTypeToConcern(issueType) {
  const token = String(issueType || '').trim().toLowerCase();
  if (!token) return null;
  if (token === 'shine' || token === 'oiliness' || token === 'sebum') return 'oiliness';
  if (token === 'redness') return 'redness';
  if (token === 'acne' || token === 'breakout' || token === 'acne_like') return 'bumps';
  if (token === 'pores') return 'pores';
  if (token === 'texture') return 'texture';
  if (token === 'dark_spots' || token === 'tone' || token === 'uneven_tone') return 'uneven_tone';
  return token;
}

function severityToBand(score) {
  const value = Number(score);
  if (!Number.isFinite(value) || value <= 0) return 'unknown';
  if (value >= 2.6) return 'high';
  if (value >= 1.3) return 'mid';
  return 'low';
}

function buildSceneNotes(photoQuality) {
  const quality = isPlainObject(photoQuality) ? photoQuality : {};
  const reasons = Array.isArray(quality.reasons) ? quality.reasons : [];
  const out = [];

  const add = (value) => {
    if (!value) return;
    if (out.includes(value)) return;
    out.push(value);
  };

  for (const reasonRaw of reasons) {
    const reason = String(reasonRaw || '').trim().toLowerCase();
    if (!reason) continue;
    if (reason.includes('blur')) add('blur_suspected');
    if (reason.includes('light') || reason.includes('exposure') || reason.includes('white_balance')) add('strong_light');
    if (reason.includes('filter')) add('filter_suspected');
    if (reason.includes('occlusion') || reason.includes('coverage') || reason.includes('face_coverage')) add('partial_occlusion');
    if (reason.includes('frame')) add('frame_alignment_issue');
  }

  const qualityGrade = normalizePhotoQualityGrade(quality.grade);
  if (qualityGrade === 'poor') add('poor_photo_quality');
  return out.slice(0, 6);
}

function summarizeUserGoal({ profileSummary, routineCandidate } = {}) {
  const profile = isPlainObject(profileSummary) ? profileSummary : {};
  const goals = Array.isArray(profile.goals)
    ? profile.goals.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (goals.length) return goals.slice(0, 3).join(' / ');

  const routineText = typeof routineCandidate === 'string'
    ? routineCandidate
    : isPlainObject(routineCandidate)
      ? JSON.stringify(routineCandidate)
      : '';
  const lower = String(routineText || '').toLowerCase();
  if (!lower.trim()) return '';

  const inferred = [];
  if (/oil|sebum|shine|控油|出油/.test(lower)) inferred.push('oil control');
  if (/hydrate|moist|保湿|补水/.test(lower)) inferred.push('hydration');
  if (/acne|pimple|breakout|痘|闭口/.test(lower)) inferred.push('acne-like bumps');
  if (/tone|bright|spots|淡印|暗沉/.test(lower)) inferred.push('uneven tone');
  return inferred.slice(0, 3).join(' / ');
}

function buildVisionSignalsDto({ language, photoQuality, profileSummary, routineCandidate } = {}) {
  return {
    lang: normalizeRouteLanguage(language),
    photo_quality: normalizePhotoQualityGrade(photoQuality && photoQuality.grade),
    scene_notes: buildSceneNotes(photoQuality),
    user_goal: summarizeUserGoal({ profileSummary, routineCandidate }) || undefined,
  };
}

function buildDeterministicSignals(diagnosisV1) {
  const diagnosis = isPlainObject(diagnosisV1) ? diagnosisV1 : {};
  const issues = Array.isArray(diagnosis.issues) ? diagnosis.issues : [];

  const mapped = {
    oiliness: 'unknown',
    redness: 'unknown',
    acne_like: 'unknown',
    dryness: 'unknown',
    texture: 'unknown',
  };

  for (const raw of issues) {
    const issue = isPlainObject(raw) ? raw : null;
    if (!issue) continue;
    const issueType = String(issue.issue_type || '').trim().toLowerCase();
    const severityBand = severityToBand(issue.severity_level);

    if (issueType === 'shine' || issueType === 'oiliness') mapped.oiliness = severityBand;
    if (issueType === 'redness') mapped.redness = severityBand;
    if (issueType === 'acne') {
      if (severityBand === 'high') mapped.acne_like = 'some';
      else if (severityBand === 'mid') mapped.acne_like = 'few';
      else if (severityBand === 'low') mapped.acne_like = 'few';
      else if (mapped.acne_like === 'unknown') mapped.acne_like = 'none';
    }
    if (issueType === 'texture') mapped.texture = severityBand === 'high' || severityBand === 'mid' ? 'rough' : 'ok';
    if (issueType === 'quality') {
      // keep conservative for unknown quality
      if (mapped.dryness === 'unknown') mapped.dryness = 'unknown';
    }
  }

  if (mapped.acne_like === 'unknown') mapped.acne_like = 'none';
  if (mapped.texture === 'unknown') mapped.texture = 'unknown';
  if (mapped.dryness === 'unknown') mapped.dryness = 'unknown';

  return mapped;
}

function summarizeRoutine(routineCandidate) {
  const text = typeof routineCandidate === 'string'
    ? routineCandidate
    : isPlainObject(routineCandidate)
      ? JSON.stringify(routineCandidate)
      : '';
  const lower = String(text || '').toLowerCase();

  const hasCleanser = /cleanser|face wash|洁面/.test(lower);
  const hasMoisturizer = /moistur|cream|lotion|乳液|面霜|保湿/.test(lower);
  const hasSunscreen = /spf|sunscreen|防晒/.test(lower);

  const actives = [];
  const add = (value) => {
    if (!value) return;
    if (actives.includes(value)) return;
    actives.push(value);
  };

  if (/\b(retinol|retinoid|tretinoin|adapalene)\b|维a|视黄醇/.test(lower)) add('retinoid');
  if (/\b(aha|bha|salicylic|glycolic|lactic)\b|果酸|水杨酸|乳酸/.test(lower)) add('AHA/BHA');
  if (/\b(vitamin c|ascorbic)\b|维c|抗坏血酸/.test(lower)) add('vitamin_c');
  if (/\b(benzoyl peroxide|bpo)\b|过氧化苯甲酰/.test(lower)) add('benzoyl_peroxide');
  if (/\b(niacinamide)\b|烟酰胺/.test(lower)) add('niacinamide');

  return {
    cleanser_freq: hasCleanser ? '1-2/day' : 'unknown',
    moisturizer: hasMoisturizer ? 'yes' : 'unknown',
    sunscreen: hasSunscreen ? 'yes' : 'unknown',
    actives: actives.slice(0, 6),
  };
}

function buildConcernRank({ diagnosisPolicy, diagnosisV1 } = {}) {
  const policy = isPlainObject(diagnosisPolicy) ? diagnosisPolicy : {};
  const ranked = Array.isArray(policy.top_issue_types)
    ? policy.top_issue_types
        .map((item) => mapIssueTypeToConcern(item))
        .filter(Boolean)
    : [];

  if (ranked.length) return ranked.slice(0, 3);

  const diagnosis = isPlainObject(diagnosisV1) ? diagnosisV1 : {};
  const issues = Array.isArray(diagnosis.issues) ? diagnosis.issues : [];
  const fallback = issues
    .map((item) => mapIssueTypeToConcern(item && item.issue_type))
    .filter(Boolean);

  return Array.from(new Set(fallback)).slice(0, 3);
}

function buildConstraints({ profileSummary } = {}) {
  const profile = isPlainObject(profileSummary) ? profileSummary : {};
  const out = [];
  const add = (value) => {
    if (!value) return;
    if (out.includes(value)) return;
    out.push(value);
  };

  if (String(profile.sensitivity || '').trim()) add('sensitive-skin self-report');
  if (Array.isArray(profile.contraindications) && profile.contraindications.length) {
    add('contraindications reported');
  }
  add('pregnancy unknown');
  return out.slice(0, 6);
}

function buildOpenQuestions({ routineCandidate, deterministicSignals } = {}) {
  const out = [];
  const add = (value) => {
    if (!value) return;
    if (out.includes(value)) return;
    out.push(value);
  };

  const routine = summarizeRoutine(routineCandidate);
  if (routine.cleanser_freq === 'unknown') add('How often do you cleanse each day?');
  if (routine.moisturizer === 'unknown') add('Do you currently use a moisturizer daily?');
  if (routine.sunscreen === 'unknown') add('Do you use sunscreen every morning?');

  if (deterministicSignals.redness === 'high' || deterministicSignals.redness === 'mid') {
    add('Any stinging or tightness recently?');
  }
  if (deterministicSignals.acne_like === 'some' || deterministicSignals.acne_like === 'few') {
    add('Any recent flare-ups or new breakouts?');
  }

  return out.slice(0, 3);
}

function buildReportSignalsDto({
  language,
  diagnosisPolicy,
  diagnosisV1,
  routineCandidate,
  profileSummary,
} = {}) {
  const deterministicSignals = buildDeterministicSignals(diagnosisV1);
  return {
    lang: normalizeRouteLanguage(language),
    concern_rank: buildConcernRank({ diagnosisPolicy, diagnosisV1 }),
    deterministic_signals: deterministicSignals,
    routine_summary: summarizeRoutine(routineCandidate),
    constraints: buildConstraints({ profileSummary }),
    open_questions: buildOpenQuestions({ routineCandidate, deterministicSignals }),
  };
}

function buildFactLayer({ deterministicAnalysis, visionAnalysis, photoQuality, diagnosisPolicy } = {}) {
  const deterministic = isPlainObject(deterministicAnalysis) ? deterministicAnalysis : {};
  const vision = isPlainObject(visionAnalysis) ? visionAnalysis : {};

  const features = [];
  const pushFeature = (item) => {
    if (!isPlainObject(item)) return;
    const observation = String(item.observation || '').trim();
    if (!observation) return;
    if (features.some((row) => row.observation.toLowerCase() === observation.toLowerCase())) return;
    const confidence = String(item.confidence || '').trim();
    features.push({
      observation: observation.slice(0, 120),
      confidence: confidence || 'somewhat_sure',
    });
  };

  for (const item of Array.isArray(deterministic.features) ? deterministic.features : []) pushFeature(item);
  for (const item of Array.isArray(vision.features) ? vision.features : []) pushFeature(item);

  const policy = isPlainObject(diagnosisPolicy) ? diagnosisPolicy : {};
  const uncertaintyReasons = Array.isArray(policy.uncertainty_reasons) ? policy.uncertainty_reasons.slice(0, 5) : [];

  return {
    features: features.slice(0, 4),
    needs_risk_check: Boolean(deterministic.needs_risk_check || vision.needs_risk_check),
    quality: normalizePhotoQualityGrade(photoQuality && photoQuality.grade),
    uncertainty_reasons: uncertaintyReasons,
  };
}

module.exports = {
  buildVisionSignalsDto,
  buildReportSignalsDto,
  buildFactLayer,
  normalizePhotoQualityGrade,
};
