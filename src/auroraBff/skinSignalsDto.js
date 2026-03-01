const crypto = require('crypto');
const { summarizeRoutineActives } = require('./skinLlmPrompts');

function normalizeLang(lang) {
  const token = String(lang || '').trim().toLowerCase();
  if (token === 'cn' || token === 'zh-cn' || token === 'zh') return 'zh-CN';
  return 'en-US';
}

function clampText(raw, maxLen) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function mapPhotoQuality(quality) {
  const grade = String((quality && quality.grade) || quality || '')
    .trim()
    .toLowerCase();
  if (grade === 'pass' || grade === 'good') return 'good';
  if (grade === 'degraded' || grade === 'ok') return 'ok';
  if (grade === 'fail' || grade === 'poor') return 'poor';
  return 'ok';
}

function stableSortValue(value) {
  if (Array.isArray(value)) return value.map((v) => stableSortValue(v));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  for (const key of keys) out[key] = stableSortValue(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stableSortValue(value));
}

function sha256Hex(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function buildImageHash(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return 'no_image';
  return sha256Hex(imageBuffer).slice(0, 32);
}

function buildInputHash({ payload, imageHash }) {
  const data = {
    image_hash: String(imageHash || 'no_image'),
    payload: payload && typeof payload === 'object' ? payload : {},
  };
  return sha256Hex(stableStringify(data));
}

function buildInputHashPrefix(inputHash, len = 8) {
  const hash = String(inputHash || '').trim().toLowerCase();
  if (!hash) return 'none';
  return hash.slice(0, Math.max(4, Math.min(16, Number(len) || 8)));
}

function normalizeUncertaintyLevel(diagnosisPolicy) {
  const p = diagnosisPolicy && typeof diagnosisPolicy === 'object' ? diagnosisPolicy : null;
  if (!p) return 'unknown';
  if (p.uncertainty === true) return 'high';
  const level = String(p.detector_confidence_level || '').trim().toLowerCase();
  if (level === 'high') return 'low';
  if (level === 'medium') return 'medium';
  if (level === 'low') return 'high';
  return 'unknown';
}

function buildSceneNotes(photoQuality) {
  const q = photoQuality && typeof photoQuality === 'object' ? photoQuality : {};
  const reasons = Array.isArray(q.reasons) ? q.reasons : [];
  const notes = new Set();
  for (const raw of reasons) {
    const token = String(raw || '').trim().toLowerCase();
    if (!token) continue;
    if (token.includes('blur')) notes.add('blur_suspected');
    if (token.includes('light') || token.includes('wb')) notes.add('strong_light');
    if (token.includes('cover') || token.includes('occlusion')) notes.add('partial_occlusion');
    if (token.includes('filter')) notes.add('filter_suspected');
    if (token.includes('pixel_')) notes.add('pixel_qc_adjusted');
  }
  if (!notes.size) {
    const qMapped = mapPhotoQuality(photoQuality);
    if (qMapped === 'poor') notes.add('quality_poor');
    if (qMapped === 'ok') notes.add('quality_ok');
  }
  return Array.from(notes).slice(0, 6);
}

function summarizeUserGoal(profileSummary) {
  const goals = profileSummary && Array.isArray(profileSummary.goals)
    ? profileSummary.goals.filter((item) => typeof item === 'string' && item.trim())
    : [];
  if (!goals.length) return '';
  return clampText(goals.slice(0, 3).join(' / '), 100);
}

function normalizeIssueType(issueType) {
  return String(issueType || '').trim().toLowerCase();
}

function issueSeverityBand(issue) {
  if (!issue || typeof issue !== 'object') return 'unknown';
  const severityLevel = Number.isFinite(Number(issue.severity_level)) ? Number(issue.severity_level) : null;
  const confidence = Number.isFinite(Number(issue.confidence)) ? Number(issue.confidence) : null;
  const score = severityLevel != null ? severityLevel : confidence != null ? confidence * 4 : 0;
  if (score >= 2.8) return 'high';
  if (score >= 1.6) return 'mid';
  if (score > 0) return 'low';
  return 'unknown';
}

function concernsFromDiagnosis(diagnosisV1) {
  const diagnosis = diagnosisV1 && typeof diagnosisV1 === 'object' ? diagnosisV1 : null;
  const issues = diagnosis && Array.isArray(diagnosis.issues) ? diagnosis.issues : [];
  const map = new Map();
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue;
    const type = normalizeIssueType(issue.issue_type);
    if (!type) continue;
    const prev = map.get(type);
    if (!prev) {
      map.set(type, issue);
      continue;
    }
    const prevScore = Number(prev.severity_level || 0);
    const nextScore = Number(issue.severity_level || 0);
    if (nextScore > prevScore) map.set(type, issue);
  }
  return map;
}

function mapDeterministicSignals(diagnosisV1) {
  const concerns = concernsFromDiagnosis(diagnosisV1);

  const oil = concerns.get('shine') || concerns.get('oiliness');
  const red = concerns.get('redness');
  const acne = concerns.get('acne') || concerns.get('acne_like') || concerns.get('comedone');
  const dry = concerns.get('dryness') || concerns.get('barrier');
  const texture = concerns.get('texture');

  const oiliness = issueSeverityBand(oil);
  const redness = issueSeverityBand(red);

  function acneLikeBand(row) {
    const band = issueSeverityBand(row);
    if (band === 'high' || band === 'mid') return 'some';
    if (band === 'low') return 'few';
    if (band === 'unknown') return 'unknown';
    return 'none';
  }

  function drynessBand(row) {
    const band = issueSeverityBand(row);
    if (band === 'high' || band === 'mid' || band === 'low') return 'some';
    if (band === 'unknown') return 'unknown';
    return 'none';
  }

  function textureBand(row) {
    const band = issueSeverityBand(row);
    if (band === 'high' || band === 'mid') return 'rough';
    if (band === 'low') return 'ok';
    return 'unknown';
  }

  return {
    oiliness,
    redness,
    acne_like: acneLikeBand(acne),
    dryness: drynessBand(dry),
    texture: textureBand(texture),
  };
}

function buildConcernRank(diagnosisV1) {
  const diagnosis = diagnosisV1 && typeof diagnosisV1 === 'object' ? diagnosisV1 : null;
  const issues = diagnosis && Array.isArray(diagnosis.issues) ? diagnosis.issues : [];
  return issues
    .filter((item) => item && typeof item === 'object' && item.issue_type)
    .slice()
    .sort((a, b) => {
      const sa = Number.isFinite(Number(a.severity_level)) ? Number(a.severity_level) : 0;
      const sb = Number.isFinite(Number(b.severity_level)) ? Number(b.severity_level) : 0;
      if (sb !== sa) return sb - sa;
      const ca = Number.isFinite(Number(a.confidence)) ? Number(a.confidence) : 0;
      const cb = Number.isFinite(Number(b.confidence)) ? Number(b.confidence) : 0;
      return cb - ca;
    })
    .map((item) => normalizeIssueType(item.issue_type))
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 5);
}

function summarizeRoutine(routineCandidate) {
  const raw = typeof routineCandidate === 'string'
    ? routineCandidate
    : routineCandidate && typeof routineCandidate === 'object'
      ? stableStringify(routineCandidate)
      : '';
  const text = String(raw || '').toLowerCase();

  const cleanser_freq = /2x|twice|2\/day|早晚|morning.*night|am.*pm/.test(text)
    ? '1-2/day'
    : /cleanser|cleanse|洗面|洁面/.test(text)
      ? '1/day'
      : 'unknown';

  const moisturizer = /moistur|cream|lotion|保湿|面霜/.test(text) ? 'yes' : text ? 'unknown' : 'unknown';
  const sunscreen = /spf|sunscreen|防晒/.test(text) ? 'yes' : text ? 'unknown' : 'unknown';
  const actives = summarizeRoutineActives(routineCandidate).slice(0, 4);

  return {
    cleanser_freq,
    moisturizer,
    sunscreen,
    actives,
  };
}

function buildConstraints(profileSummary) {
  const p = profileSummary && typeof profileSummary === 'object' ? profileSummary : {};
  const out = [];
  if (String(p.sensitivity || '').trim().toLowerCase() === 'high') {
    out.push('sensitive-skin self-report');
  }
  const contraindications = Array.isArray(p.contraindications) ? p.contraindications : [];
  const contraindicationText = contraindications.join(' ').toLowerCase();
  if (contraindicationText.includes('pregnan')) {
    out.push('pregnancy self-reported');
  } else {
    out.push('pregnancy unknown');
  }
  return out.slice(0, 4);
}

function buildOpenQuestions({ diagnosisPolicy, photoQuality }) {
  const out = [];
  const uncertaintyLevel = normalizeUncertaintyLevel(diagnosisPolicy);
  if (uncertaintyLevel === 'high') {
    out.push('recent flare-ups?');
    out.push('stinging/tightness?');
  }
  if (mapPhotoQuality(photoQuality) === 'poor') {
    out.push('can you retake a clearer photo?');
  }
  return out.slice(0, 3);
}

function summarizeLockedFeatures(factLayer) {
  const list = factLayer && Array.isArray(factLayer.features) ? factLayer.features : [];
  return list
    .map((item) => (item && typeof item === 'object' ? clampText(item.observation, 80) : ''))
    .filter(Boolean)
    .slice(0, 4);
}

function buildVisionSignalsDto({
  lang,
  photoQuality,
  profileSummary,
  diagnosisPolicy,
  factLayer,
  imageBuffer,
} = {}) {
  const dtoBase = {
    lang: normalizeLang(lang),
    photo_quality: mapPhotoQuality(photoQuality),
    uncertainty_level: normalizeUncertaintyLevel(diagnosisPolicy),
    scene_notes: buildSceneNotes(photoQuality),
    user_goal: summarizeUserGoal(profileSummary),
    locked_features_summary: summarizeLockedFeatures(factLayer),
  };
  const image_hash = buildImageHash(imageBuffer);
  const input_hash = buildInputHash({ payload: dtoBase, imageHash: image_hash });
  return {
    ...dtoBase,
    image_hash,
    input_hash,
  };
}

function buildReportSignalsDto({
  lang,
  diagnosisV1,
  diagnosisPolicy,
  profileSummary,
  routineCandidate,
  photoQuality,
  factLayer,
  imageBuffer,
} = {}) {
  const dtoBase = {
    lang: normalizeLang(lang),
    concern_rank: buildConcernRank(diagnosisV1),
    deterministic_signals: mapDeterministicSignals(diagnosisV1),
    routine_summary: summarizeRoutine(routineCandidate),
    constraints: buildConstraints(profileSummary),
    open_questions: buildOpenQuestions({ diagnosisPolicy, photoQuality }),
    photo_quality: mapPhotoQuality(photoQuality),
    uncertainty_level: normalizeUncertaintyLevel(diagnosisPolicy),
    locked_features_summary: summarizeLockedFeatures(factLayer),
  };
  const image_hash = buildImageHash(imageBuffer);
  const input_hash = buildInputHash({ payload: dtoBase, imageHash: image_hash });
  return {
    ...dtoBase,
    image_hash,
    input_hash,
  };
}

module.exports = {
  normalizeLang,
  mapPhotoQuality,
  buildImageHash,
  buildInputHash,
  buildInputHashPrefix,
  buildVisionSignalsDto,
  buildReportSignalsDto,
};
