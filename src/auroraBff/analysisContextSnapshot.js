const crypto = require('node:crypto');

const ANALYSIS_CONTEXT_SNAPSHOT_VERSION = 'analysis_context_snapshot_v1';
const ANALYSIS_CONTEXT_BUILDER_VERSION = 'analysis_context_snapshot_builder_v1';
const DEFAULT_TASK_ADAPTER_VERSION = 'analysis_context_adapter_v1';

const SOURCE_CLASS = Object.freeze({
  EXPLICIT: 'explicit',
  ARTIFACT: 'artifact',
  BEHAVIORAL: 'behavioral_signal',
  HEURISTIC: 'heuristic',
});

const FRESHNESS_BUCKET = Object.freeze({
  FRESH: 'fresh',
  AGING: 'aging',
  STALE: 'stale',
});

const CONTEXT_MODE = Object.freeze([
  'explicit_only',
  'snapshot_hard',
  'snapshot_mixed',
  'snapshot_soft_only',
  'snapshot_stale_fallback',
  'no_context',
]);
const CONTEXT_SOURCE_MODE = Object.freeze([
  'artifact',
  'artifact_compat_fallback',
  'explicit_only',
  'none',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return value == null ? '' : String(value).trim();
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const token = asString(value);
    if (token) return token;
  }
  return '';
}

function clampNumber(value, min = 0, max = 1, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function uniqStrings(values, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const text = asString(raw);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function stableHash(value, length = 16) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, length);
}

function toIso(value) {
  const text = asString(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function daysSince(isoText) {
  const iso = toIso(isoText);
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function bucketizeFreshness(days, fieldFamily = 'generic') {
  const d = Number.isFinite(Number(days)) ? Number(days) : null;
  if (d == null) return FRESHNESS_BUCKET.FRESH;
  const fastDecay = new Set(['photo_findings_summary', 'barrier_status_tendency']);
  const mediumDecay = new Set(['skin_type_tendency', 'sensitivity_tendency', 'risk_axes']);
  if (fastDecay.has(fieldFamily)) {
    if (d > 30) return FRESHNESS_BUCKET.STALE;
    if (d > 7) return FRESHNESS_BUCKET.AGING;
    return FRESHNESS_BUCKET.FRESH;
  }
  if (mediumDecay.has(fieldFamily)) {
    if (d > 90) return FRESHNESS_BUCKET.STALE;
    if (d > 30) return FRESHNESS_BUCKET.AGING;
    return FRESHNESS_BUCKET.FRESH;
  }
  if (fieldFamily === 'goals') {
    if (d > 180) return FRESHNESS_BUCKET.STALE;
    if (d > 90) return FRESHNESS_BUCKET.AGING;
    return FRESHNESS_BUCKET.FRESH;
  }
  if (d > 90) return FRESHNESS_BUCKET.STALE;
  if (d > 30) return FRESHNESS_BUCKET.AGING;
  return FRESHNESS_BUCKET.FRESH;
}

function normalizeProfileForSnapshot(profile) {
  const row = isPlainObject(profile) ? profile : {};
  return {
    skinType: pickFirstTrimmed(row.skinType, row.skin_type) || null,
    sensitivity: pickFirstTrimmed(row.sensitivity, row.sensitivity_level) || null,
    barrierStatus: pickFirstTrimmed(row.barrierStatus, row.barrier_status, row.barrier) || null,
    goals: uniqStrings(row.goals, 8),
    contraindications: uniqStrings(row.contraindications, 12),
    budgetTier: pickFirstTrimmed(row.budgetTier, row.budget_tier) || null,
    region: pickFirstTrimmed(row.region) || null,
  };
}

function buildSourceRef(sourceSubclass, valueKey) {
  return `${sourceSubclass}:${valueKey}`;
}

function makeCandidate({
  value,
  sourceClass,
  sourceSubclass,
  sourceRef,
  confidence,
  freshnessBucket,
  derivedFromArtifactId = null,
} = {}) {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return {
    value,
    source_class: sourceClass,
    source_subclass: sourceSubclass,
    source_ref: asString(sourceRef) || null,
    confidence: clampNumber(confidence, 0, 1, 0.5),
    freshness_bucket: [FRESHNESS_BUCKET.FRESH, FRESHNESS_BUCKET.AGING, FRESHNESS_BUCKET.STALE].includes(asString(freshnessBucket))
      ? asString(freshnessBucket)
      : FRESHNESS_BUCKET.FRESH,
    derived_from_artifact_id: asString(derivedFromArtifactId) || null,
  };
}

function explicitProfileCandidates(profile) {
  const normalized = normalizeProfileForSnapshot(profile);
  const out = {
    skin_type_tendency: [],
    sensitivity_tendency: [],
    barrier_status_tendency: [],
    goals: [],
    ingredient_avoid: [],
  };
  if (normalized.skinType) {
    out.skin_type_tendency.push(makeCandidate({
      value: normalized.skinType,
      sourceClass: SOURCE_CLASS.EXPLICIT,
      sourceSubclass: 'explicit_profile',
      sourceRef: buildSourceRef('explicit_profile', 'skinType'),
      confidence: 1,
      freshnessBucket: FRESHNESS_BUCKET.FRESH,
    }));
  }
  if (normalized.sensitivity) {
    out.sensitivity_tendency.push(makeCandidate({
      value: normalized.sensitivity,
      sourceClass: SOURCE_CLASS.EXPLICIT,
      sourceSubclass: 'explicit_profile',
      sourceRef: buildSourceRef('explicit_profile', 'sensitivity'),
      confidence: 1,
      freshnessBucket: FRESHNESS_BUCKET.FRESH,
    }));
  }
  if (normalized.barrierStatus) {
    out.barrier_status_tendency.push(makeCandidate({
      value: normalized.barrierStatus,
      sourceClass: SOURCE_CLASS.EXPLICIT,
      sourceSubclass: 'explicit_profile',
      sourceRef: buildSourceRef('explicit_profile', 'barrierStatus'),
      confidence: 1,
      freshnessBucket: FRESHNESS_BUCKET.FRESH,
    }));
  }
  normalized.goals.forEach((goal) => {
    out.goals.push(makeCandidate({
      value: goal,
      sourceClass: SOURCE_CLASS.EXPLICIT,
      sourceSubclass: 'explicit_profile',
      sourceRef: buildSourceRef('explicit_profile', 'goals'),
      confidence: 1,
      freshnessBucket: FRESHNESS_BUCKET.FRESH,
    }));
  });
  normalized.contraindications.forEach((item) => {
    out.ingredient_avoid.push(makeCandidate({
      value: item,
      sourceClass: SOURCE_CLASS.EXPLICIT,
      sourceSubclass: 'explicit_profile',
      sourceRef: buildSourceRef('explicit_profile', 'contraindications'),
      confidence: 1,
      freshnessBucket: FRESHNESS_BUCKET.FRESH,
    }));
  });
  return out;
}

function normalizeArtifactQuality(overall, fallback = 0.7) {
  const token = asString(overall).toLowerCase();
  if (token === 'high') return 0.86;
  if (token === 'medium') return 0.72;
  if (token === 'low') return 0.56;
  return fallback;
}

function buildDiagnosisV2ArtifactCandidates(artifact = {}) {
  const payload = artifact && artifact.schema === 'aurora.skin_diagnosis.v2' && isPlainObject(artifact.data)
    ? artifact.data
    : null;
  if (!payload) return null;
  const artifactId = pickFirstTrimmed(artifact.artifact_id, artifact.artifactId) || null;
  const freshnessDays = daysSince(artifact.created_at || payload.created_at);
  const qualityScore = normalizeArtifactQuality(payload.data_quality && payload.data_quality.overall, 0.7);
  const out = {
    skin_type_tendency: [],
    sensitivity_tendency: [],
    barrier_status_tendency: [],
    goals: [],
    risk_axes: [],
    ingredient_targets: [],
    ingredient_avoid: [],
    photo_findings_summary: [],
    data_quality: {
      overall: asString(payload.data_quality && payload.data_quality.overall) || null,
      source_class: SOURCE_CLASS.ARTIFACT,
      source_subclass: 'diagnosis_v2',
      confidence: qualityScore,
    },
  };
  const selectedGoals = asArray(payload.goal_profile && payload.goal_profile.selected_goals);
  selectedGoals.forEach((goal) => {
    out.goals.push(makeCandidate({
      value: goal,
      sourceClass: SOURCE_CLASS.ARTIFACT,
      sourceSubclass: 'diagnosis_v2',
      sourceRef: buildSourceRef('diagnosis_v2', 'selected_goals'),
      confidence: qualityScore,
      freshnessBucket: bucketizeFreshness(freshnessDays, 'goals'),
      derivedFromArtifactId: artifactId,
    }));
  });

  const axes = asArray(payload.inferred_state && payload.inferred_state.axes);
  axes.forEach((axis) => {
    if (!isPlainObject(axis)) return;
    const axisName = asString(axis.axis);
    const level = asString(axis.level);
    if (!axisName || !level) return;
    out.risk_axes.push(makeCandidate({
      value: { axis: axisName, level, trend: asString(axis.trend) || 'new' },
      sourceClass: SOURCE_CLASS.ARTIFACT,
      sourceSubclass: 'diagnosis_v2',
      sourceRef: buildSourceRef('diagnosis_v2', axisName),
      confidence: clampNumber(axis.confidence, 0, 1, qualityScore),
      freshnessBucket: bucketizeFreshness(freshnessDays, 'risk_axes'),
      derivedFromArtifactId: artifactId,
    }));
    if (axisName === 'sensitivity_level') {
      const mapped = level === 'high' || level === 'severe' ? 'high' : level === 'moderate' ? 'medium' : level;
      out.sensitivity_tendency.push(makeCandidate({
        value: mapped,
        sourceClass: SOURCE_CLASS.ARTIFACT,
        sourceSubclass: 'diagnosis_v2',
        sourceRef: buildSourceRef('diagnosis_v2', 'sensitivity_level'),
        confidence: clampNumber(axis.confidence, 0, 1, qualityScore * 0.95),
        freshnessBucket: bucketizeFreshness(freshnessDays, 'sensitivity_tendency'),
        derivedFromArtifactId: artifactId,
      }));
    }
    if (axisName === 'barrier_irritation_risk') {
      const mapped = level === 'high' || level === 'severe' ? 'impaired' : level === 'moderate' ? 'reactive' : 'healthy';
      out.barrier_status_tendency.push(makeCandidate({
        value: mapped,
        sourceClass: SOURCE_CLASS.ARTIFACT,
        sourceSubclass: 'diagnosis_v2',
        sourceRef: buildSourceRef('diagnosis_v2', 'barrier_irritation_risk'),
        confidence: clampNumber(axis.confidence, 0, 1, qualityScore * 0.9),
        freshnessBucket: bucketizeFreshness(freshnessDays, 'barrier_status_tendency'),
        derivedFromArtifactId: artifactId,
      }));
    }
    if (axisName === 'acne_breakout_risk' && (level === 'high' || level === 'moderate')) {
      out.goals.push(makeCandidate({
        value: 'acne',
        sourceClass: SOURCE_CLASS.ARTIFACT,
        sourceSubclass: 'diagnosis_v2',
        sourceRef: buildSourceRef('diagnosis_v2', 'acne_breakout_risk'),
        confidence: clampNumber(axis.confidence, 0, 1, qualityScore * 0.8),
        freshnessBucket: bucketizeFreshness(freshnessDays, 'goals'),
        derivedFromArtifactId: artifactId,
      }));
    }
  });

  return out;
}

function buildSkinArtifactCandidates(artifact = {}) {
  if (!isPlainObject(artifact) || asString(artifact.schema) === 'aurora.skin_diagnosis.v2') return null;
  const artifactId = pickFirstTrimmed(artifact.artifact_id, artifact.artifactId) || null;
  const freshnessDays = daysSince(artifact.created_at);
  const qualityScore = clampNumber(
    artifact && artifact.overall_confidence && artifact.overall_confidence.score,
    0,
    1,
    0.68,
  );
  const out = {
    skin_type_tendency: [],
    sensitivity_tendency: [],
    barrier_status_tendency: [],
    goals: [],
    risk_axes: [],
    ingredient_targets: [],
    ingredient_avoid: [],
    photo_findings_summary: [],
    data_quality: {
      overall: artifact && artifact.overall_confidence && artifact.overall_confidence.level ? asString(artifact.overall_confidence.level) : null,
      source_class: SOURCE_CLASS.ARTIFACT,
      source_subclass: artifact && artifact.use_photo ? 'photo_analysis' : 'skin_analysis',
      confidence: qualityScore,
    },
  };

  const skinTypeNode = isPlainObject(artifact.skinType) ? artifact.skinType : null;
  const sensitivityNode = isPlainObject(artifact.sensitivity) ? artifact.sensitivity : null;
  const barrierNode = isPlainObject(artifact.barrierStatus) ? artifact.barrierStatus : null;
  const goalsNode = isPlainObject(artifact.goals) ? artifact.goals : null;
  if (asString(skinTypeNode && skinTypeNode.value)) {
    out.skin_type_tendency.push(makeCandidate({
      value: skinTypeNode.value,
      sourceClass: SOURCE_CLASS.ARTIFACT,
      sourceSubclass: artifact && artifact.use_photo ? 'photo_analysis' : 'skin_analysis',
      sourceRef: buildSourceRef('skin_analysis', 'skinType'),
      confidence: clampNumber(skinTypeNode && skinTypeNode.confidence && skinTypeNode.confidence.score, 0, 1, qualityScore),
      freshnessBucket: bucketizeFreshness(freshnessDays, 'skin_type_tendency'),
      derivedFromArtifactId: artifactId,
    }));
  }
  if (asString(sensitivityNode && sensitivityNode.value)) {
    out.sensitivity_tendency.push(makeCandidate({
      value: sensitivityNode.value,
      sourceClass: SOURCE_CLASS.ARTIFACT,
      sourceSubclass: artifact && artifact.use_photo ? 'photo_analysis' : 'skin_analysis',
      sourceRef: buildSourceRef('skin_analysis', 'sensitivity'),
      confidence: clampNumber(sensitivityNode && sensitivityNode.confidence && sensitivityNode.confidence.score, 0, 1, qualityScore),
      freshnessBucket: bucketizeFreshness(freshnessDays, 'sensitivity_tendency'),
      derivedFromArtifactId: artifactId,
    }));
  }
  if (asString(barrierNode && barrierNode.value)) {
    out.barrier_status_tendency.push(makeCandidate({
      value: barrierNode.value,
      sourceClass: SOURCE_CLASS.ARTIFACT,
      sourceSubclass: artifact && artifact.use_photo ? 'photo_analysis' : 'skin_analysis',
      sourceRef: buildSourceRef('skin_analysis', 'barrierStatus'),
      confidence: clampNumber(barrierNode && barrierNode.confidence && barrierNode.confidence.score, 0, 1, qualityScore),
      freshnessBucket: bucketizeFreshness(freshnessDays, 'barrier_status_tendency'),
      derivedFromArtifactId: artifactId,
    }));
  }
  asArray(goalsNode && goalsNode.values).forEach((goal) => {
    out.goals.push(makeCandidate({
      value: goal,
      sourceClass: SOURCE_CLASS.ARTIFACT,
      sourceSubclass: artifact && artifact.use_photo ? 'photo_analysis' : 'skin_analysis',
      sourceRef: buildSourceRef('skin_analysis', 'goals'),
      confidence: clampNumber(goalsNode && goalsNode.confidence && goalsNode.confidence.score, 0, 1, qualityScore),
      freshnessBucket: bucketizeFreshness(freshnessDays, 'goals'),
      derivedFromArtifactId: artifactId,
    }));
  });
  asArray(artifact.concerns).forEach((item) => {
    if (!isPlainObject(item)) return;
    const issueType = asString(item.issue_type) || asString(item.type);
    const title = asString(item.title) || issueType;
    if (!title) return;
    out.photo_findings_summary.push(makeCandidate({
      value: {
        finding: title,
        region: asString(item.region) || null,
        severity: asString(item.severity) || null,
      },
      sourceClass: SOURCE_CLASS.ARTIFACT,
      sourceSubclass: artifact && artifact.use_photo ? 'photo_analysis' : 'skin_analysis',
      sourceRef: buildSourceRef('skin_analysis', issueType || title),
      confidence: clampNumber(item && item.confidence && item.confidence.score, 0, 1, qualityScore),
      freshnessBucket: bucketizeFreshness(freshnessDays, 'photo_findings_summary'),
      derivedFromArtifactId: artifactId,
    }));
  });
  return out;
}

function buildLastAnalysisFallbackCandidates(lastAnalysis = null) {
  const row = isPlainObject(lastAnalysis) ? lastAnalysis : null;
  if (!row) return null;
  const skinProfile = isPlainObject(row.skin_profile) ? row.skin_profile : isPlainObject(row.skinProfile) ? row.skinProfile : null;
  const ingredientPlan = isPlainObject(row.ingredient_plan) ? row.ingredient_plan : null;
  const out = {
    skin_type_tendency: [],
    sensitivity_tendency: [],
    barrier_status_tendency: [],
    goals: [],
    risk_axes: [],
    ingredient_targets: [],
    ingredient_avoid: [],
    photo_findings_summary: [],
    data_quality: {
      overall: asString(row && row.confidence_overall && row.confidence_overall.level) || null,
      source_class: SOURCE_CLASS.HEURISTIC,
      source_subclass: 'system_heuristic',
      confidence: clampNumber(row && row.confidence_overall && row.confidence_overall.score, 0, 1, 0.56),
    },
  };
  if (asString(skinProfile && skinProfile.skin_type_tendency)) {
    out.skin_type_tendency.push(makeCandidate({
      value: skinProfile.skin_type_tendency,
      sourceClass: SOURCE_CLASS.HEURISTIC,
      sourceSubclass: 'system_heuristic',
      sourceRef: buildSourceRef('system_heuristic', 'lastAnalysis.skin_type_tendency'),
      confidence: 0.58,
      freshnessBucket: FRESHNESS_BUCKET.AGING,
    }));
  }
  if (asString(skinProfile && skinProfile.sensitivity_tendency)) {
    out.sensitivity_tendency.push(makeCandidate({
      value: skinProfile.sensitivity_tendency,
      sourceClass: SOURCE_CLASS.HEURISTIC,
      sourceSubclass: 'system_heuristic',
      sourceRef: buildSourceRef('system_heuristic', 'lastAnalysis.sensitivity_tendency'),
      confidence: 0.58,
      freshnessBucket: FRESHNESS_BUCKET.AGING,
    }));
  }
  if (skinProfile && asString(skinProfile.barrier_status_tendency)) {
    out.barrier_status_tendency.push(makeCandidate({
      value: skinProfile.barrier_status_tendency,
      sourceClass: SOURCE_CLASS.HEURISTIC,
      sourceSubclass: 'system_heuristic',
      sourceRef: buildSourceRef('system_heuristic', 'lastAnalysis.barrier_status_tendency'),
      confidence: 0.54,
      freshnessBucket: FRESHNESS_BUCKET.AGING,
    }));
  }
  asArray(ingredientPlan && ingredientPlan.targets).forEach((item) => {
    const name = pickFirstTrimmed(item && item.ingredient_name, item && item.ingredient_id);
    if (!name) return;
    out.ingredient_targets.push(makeCandidate({
      value: name,
      sourceClass: SOURCE_CLASS.HEURISTIC,
      sourceSubclass: 'system_heuristic',
      sourceRef: buildSourceRef('system_heuristic', 'lastAnalysis.ingredient_targets'),
      confidence: 0.62,
      freshnessBucket: FRESHNESS_BUCKET.AGING,
    }));
  });
  asArray(ingredientPlan && ingredientPlan.avoid).forEach((item) => {
    const name = pickFirstTrimmed(item && item.ingredient_name, item && item.ingredient_id);
    if (!name) return;
    out.ingredient_avoid.push(makeCandidate({
      value: name,
      sourceClass: SOURCE_CLASS.HEURISTIC,
      sourceSubclass: 'system_heuristic',
      sourceRef: buildSourceRef('system_heuristic', 'lastAnalysis.ingredient_avoid'),
      confidence: 0.56,
      freshnessBucket: FRESHNESS_BUCKET.AGING,
    }));
  });
  asArray(row.priority_findings || row.findings).slice(0, 5).forEach((item) => {
    const title = pickFirstTrimmed(item && item.title, item && item.detail, item && item.observation);
    if (!title) return;
    out.photo_findings_summary.push(makeCandidate({
      value: {
        finding: title,
        region: asString(item && item.region) || null,
        severity: asString(item && item.severity) || null,
      },
      sourceClass: SOURCE_CLASS.HEURISTIC,
      sourceSubclass: 'system_heuristic',
      sourceRef: buildSourceRef('system_heuristic', 'lastAnalysis.findings'),
      confidence: 0.5,
      freshnessBucket: FRESHNESS_BUCKET.STALE,
    }));
  });
  return out;
}

function extractRecentLogSignals(recentLogs = []) {
  const signals = {
    sensitivity_tendency: [],
    barrier_status_tendency: [],
    risk_axes: [],
    evidence_summary: [],
  };
  const combined = asArray(recentLogs)
    .slice(0, 7)
    .map((row) => {
      if (!isPlainObject(row)) return '';
      return [
        row.note,
        row.notes,
        row.summary,
        row.skin_note,
        row.skin_state,
        row.mood,
      ].map((item) => asString(item)).filter(Boolean).join(' ');
    })
    .join(' ')
    .toLowerCase();
  if (!combined) return signals;
  if (/(sting|burn|reactive|irritat|redness|red|敏感|刺痛|发红)/i.test(combined)) {
    signals.sensitivity_tendency.push(makeCandidate({
      value: 'medium',
      sourceClass: SOURCE_CLASS.BEHAVIORAL,
      sourceSubclass: 'recent_logs_extracted',
      sourceRef: buildSourceRef('recent_logs_extracted', 'sensitivity'),
      confidence: 0.48,
      freshnessBucket: FRESHNESS_BUCKET.FRESH,
    }));
    signals.barrier_status_tendency.push(makeCandidate({
      value: 'reactive',
      sourceClass: SOURCE_CLASS.BEHAVIORAL,
      sourceSubclass: 'recent_logs_extracted',
      sourceRef: buildSourceRef('recent_logs_extracted', 'barrier'),
      confidence: 0.46,
      freshnessBucket: FRESHNESS_BUCKET.FRESH,
    }));
    signals.evidence_summary.push('Recent logs mention irritation or redness.');
  }
  if (/(tight|dry|dehydrat|flaky|dryness|紧绷|脱皮|干燥)/i.test(combined)) {
    signals.risk_axes.push(makeCandidate({
      value: { axis: 'dryness_tightness', level: 'moderate', trend: 'new' },
      sourceClass: SOURCE_CLASS.BEHAVIORAL,
      sourceSubclass: 'recent_logs_extracted',
      sourceRef: buildSourceRef('recent_logs_extracted', 'dryness_tightness'),
      confidence: 0.44,
      freshnessBucket: FRESHNESS_BUCKET.FRESH,
    }));
    signals.evidence_summary.push('Recent logs mention dryness or tightness.');
  }
  return signals;
}

function normalizeConflictState(values = []) {
  const normalized = values
    .map((item) => {
      if (!item) return '';
      if (typeof item.value === 'string') return item.value.trim().toLowerCase();
      try {
        return JSON.stringify(item.value);
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));
  if (unique.length <= 1) return 'resolved';
  return 'mixed';
}

function candidateScore(candidate) {
  if (!candidate) return 0;
  const sourceWeight = candidate.source_class === SOURCE_CLASS.EXPLICIT
    ? 1.2
    : candidate.source_class === SOURCE_CLASS.ARTIFACT
      ? 1.0
      : candidate.source_class === SOURCE_CLASS.BEHAVIORAL
        ? 0.7
        : 0.5;
  const freshnessWeight = candidate.freshness_bucket === FRESHNESS_BUCKET.FRESH
    ? 1
    : candidate.freshness_bucket === FRESHNESS_BUCKET.AGING
      ? 0.8
      : 0.55;
  return clampNumber(candidate.confidence, 0, 1, 0.5) * sourceWeight * freshnessWeight;
}

function buildScalarEnvelope(candidates = [], fieldKey = '') {
  const filtered = asArray(candidates).filter(Boolean).sort((a, b) => candidateScore(b) - candidateScore(a));
  if (!filtered.length) {
    return {
      winner: null,
      candidate_sources: [],
      conflict_state: 'resolved',
    };
  }
  const winner = filtered[0];
  const conflictState = normalizeConflictState(filtered.slice(0, 2));
  return {
    winner,
    candidate_sources: filtered.slice(0, 5),
    conflict_state: conflictState,
  };
}

function dedupeCollectionCandidates(candidates = []) {
  const map = new Map();
  for (const candidate of asArray(candidates)) {
    if (!candidate) continue;
    const key = typeof candidate.value === 'string'
      ? candidate.value.trim().toLowerCase()
      : JSON.stringify(candidate.value);
    const existing = map.get(key);
    if (!existing || candidateScore(candidate) > candidateScore(existing)) {
      map.set(key, candidate);
    }
  }
  return Array.from(map.values()).sort((a, b) => candidateScore(b) - candidateScore(a));
}

function buildCollectionEnvelope(candidates = [], { primaryLimit = 3, totalLimit = 8 } = {}) {
  const filtered = dedupeCollectionCandidates(candidates);
  return {
    items: filtered.slice(0, totalLimit),
    primary_items: filtered.slice(0, primaryLimit),
    candidate_sources: filtered.slice(0, Math.max(primaryLimit + 2, totalLimit)),
    conflict_state: normalizeConflictState(filtered.slice(0, 3)),
  };
}

function buildGoalsEnvelope(goalCandidates = []) {
  const deduped = dedupeCollectionCandidates(goalCandidates);
  const sorted = deduped.sort((a, b) => candidateScore(b) - candidateScore(a));
  const active = [];
  const background = [];
  for (const candidate of sorted) {
    if (!candidate) continue;
    const isExplicit = candidate.source_class === SOURCE_CLASS.EXPLICIT;
    const isStrongArtifact = candidate.source_class === SOURCE_CLASS.ARTIFACT && candidate.confidence >= 0.7 && candidate.freshness_bucket !== FRESHNESS_BUCKET.STALE;
    if ((isExplicit || isStrongArtifact) && active.length < 3) {
      active.push(candidate);
      continue;
    }
    if (background.length < 5) background.push(candidate);
  }
  if (!active.length && sorted.length) active.push(sorted[0]);
  return {
    active_goals: buildCollectionEnvelope(active, { primaryLimit: 3, totalLimit: 3 }),
    background_goals: buildCollectionEnvelope(background, { primaryLimit: 3, totalLimit: 5 }),
  };
}

function buildConflicts(snapshot) {
  const conflicts = [];
  const pushConflict = (field, envelope) => {
    if (!envelope || envelope.conflict_state === 'resolved') return;
    conflicts.push({
      field,
      values_with_sources: asArray(envelope.candidate_sources).slice(0, 3).map((candidate) => ({
        value: candidate.value,
        source_class: candidate.source_class,
        source_subclass: candidate.source_subclass,
        source_ref: candidate.source_ref,
      })),
      resolution: envelope.conflict_state,
      resolution_reason: envelope.conflict_state === 'mixed'
        ? 'multiple plausible sources remain and should stay soft'
        : 'insufficient evidence to resolve confidently',
    });
  };
  pushConflict('skin_type_tendency', snapshot.skin_type_tendency);
  pushConflict('sensitivity_tendency', snapshot.sensitivity_tendency);
  pushConflict('barrier_status_tendency', snapshot.barrier_status_tendency);
  pushConflict('risk_axes', snapshot.risk_axes);
  return conflicts;
}

function buildSourceMixSummary(snapshot) {
  const values = new Set();
  const scanCandidate = (candidate) => {
    if (!candidate) return;
    const token = asString(candidate.source_subclass) || asString(candidate.source_class);
    if (token) values.add(token);
  };
  const scanEnvelope = (envelope) => {
    if (!envelope) return;
    asArray(envelope.candidate_sources).forEach(scanCandidate);
    if (envelope.winner) scanCandidate(envelope.winner);
    asArray(envelope.items).forEach(scanCandidate);
    asArray(envelope.primary_items).forEach(scanCandidate);
  };
  scanEnvelope(snapshot.skin_type_tendency);
  scanEnvelope(snapshot.sensitivity_tendency);
  scanEnvelope(snapshot.barrier_status_tendency);
  scanEnvelope(snapshot.risk_axes);
  scanEnvelope(snapshot.ingredient_targets);
  scanEnvelope(snapshot.ingredient_avoid);
  if (snapshot.goals) {
    scanEnvelope(snapshot.goals.active_goals);
    scanEnvelope(snapshot.goals.background_goals);
  }
  asArray(snapshot.photo_findings_summary).forEach(scanCandidate);
  return Array.from(values).slice(0, 8);
}

function collectArtifactIds(latestArtifact) {
  const ids = [];
  const artifactId = pickFirstTrimmed(latestArtifact && latestArtifact.artifact_id, latestArtifact && latestArtifact.artifactId);
  if (artifactId) ids.push(artifactId);
  return ids;
}

function buildProfileHash(profile) {
  const normalized = normalizeProfileForSnapshot(profile);
  return stableHash({
    skinType: normalized.skinType,
    sensitivity: normalized.sensitivity,
    barrierStatus: normalized.barrierStatus,
    goals: normalized.goals,
    contraindications: normalized.contraindications,
    budgetTier: normalized.budgetTier,
  });
}

function buildRecentLogExtractionSignature(recentLogs = []) {
  const extracted = extractRecentLogSignals(recentLogs);
  return stableHash({
    evidence_summary: extracted.evidence_summary,
    sensitivity_tendency: extracted.sensitivity_tendency.map((item) => item && item.value),
    barrier_status_tendency: extracted.barrier_status_tendency.map((item) => item && item.value),
    risk_axes: extracted.risk_axes.map((item) => item && item.value),
  });
}

function buildAnalysisContextSnapshotV1({
  latestArtifact = null,
  lastAnalysis = null,
  profile = null,
  recentLogs = [],
} = {}) {
  const explicit = explicitProfileCandidates(profile);
  const diagnosisV2 = buildDiagnosisV2ArtifactCandidates(latestArtifact);
  const skinArtifact = buildSkinArtifactCandidates(latestArtifact);
  const lastAnalysisFallback = buildLastAnalysisFallbackCandidates(lastAnalysis);
  const recentLogSignals = extractRecentLogSignals(recentLogs);

  const all = {
    skin_type_tendency: [
      ...asArray(explicit.skin_type_tendency),
      ...asArray(diagnosisV2 && diagnosisV2.skin_type_tendency),
      ...asArray(skinArtifact && skinArtifact.skin_type_tendency),
      ...asArray(lastAnalysisFallback && lastAnalysisFallback.skin_type_tendency),
    ],
    sensitivity_tendency: [
      ...asArray(explicit.sensitivity_tendency),
      ...asArray(diagnosisV2 && diagnosisV2.sensitivity_tendency),
      ...asArray(skinArtifact && skinArtifact.sensitivity_tendency),
      ...asArray(lastAnalysisFallback && lastAnalysisFallback.sensitivity_tendency),
      ...asArray(recentLogSignals.sensitivity_tendency),
    ],
    barrier_status_tendency: [
      ...asArray(explicit.barrier_status_tendency),
      ...asArray(diagnosisV2 && diagnosisV2.barrier_status_tendency),
      ...asArray(skinArtifact && skinArtifact.barrier_status_tendency),
      ...asArray(lastAnalysisFallback && lastAnalysisFallback.barrier_status_tendency),
      ...asArray(recentLogSignals.barrier_status_tendency),
    ],
    goals: [
      ...asArray(explicit.goals),
      ...asArray(diagnosisV2 && diagnosisV2.goals),
      ...asArray(skinArtifact && skinArtifact.goals),
      ...asArray(lastAnalysisFallback && lastAnalysisFallback.goals),
    ],
    risk_axes: [
      ...asArray(diagnosisV2 && diagnosisV2.risk_axes),
      ...asArray(skinArtifact && skinArtifact.risk_axes),
      ...asArray(lastAnalysisFallback && lastAnalysisFallback.risk_axes),
      ...asArray(recentLogSignals.risk_axes),
    ],
    ingredient_targets: [
      ...asArray(diagnosisV2 && diagnosisV2.ingredient_targets),
      ...asArray(lastAnalysisFallback && lastAnalysisFallback.ingredient_targets),
    ],
    ingredient_avoid: [
      ...asArray(explicit.ingredient_avoid),
      ...asArray(diagnosisV2 && diagnosisV2.ingredient_avoid),
      ...asArray(lastAnalysisFallback && lastAnalysisFallback.ingredient_avoid),
    ],
    photo_findings_summary: [
      ...asArray(diagnosisV2 && diagnosisV2.photo_findings_summary),
      ...asArray(skinArtifact && skinArtifact.photo_findings_summary),
      ...asArray(lastAnalysisFallback && lastAnalysisFallback.photo_findings_summary),
    ],
  };

  const derivedFromArtifactIds = collectArtifactIds(latestArtifact);
  const snapshot = {
    schema_version: ANALYSIS_CONTEXT_SNAPSHOT_VERSION,
    snapshot_id: `acs_${stableHash({ artifactIds: derivedFromArtifactIds, profile: buildProfileHash(profile), lastAnalysis: Boolean(lastAnalysis), builder: ANALYSIS_CONTEXT_BUILDER_VERSION }, 18)}`,
    created_at: new Date().toISOString(),
    builder_version: ANALYSIS_CONTEXT_BUILDER_VERSION,
    derived_from_artifact_ids: derivedFromArtifactIds,
    derived_from_artifact_signature: stableHash(derivedFromArtifactIds.slice().sort()),
    profile_hash: buildProfileHash(profile),
    recent_log_extraction_signature: buildRecentLogExtractionSignature(recentLogs),
    skin_type_tendency: buildScalarEnvelope(all.skin_type_tendency, 'skin_type_tendency'),
    sensitivity_tendency: buildScalarEnvelope(all.sensitivity_tendency, 'sensitivity_tendency'),
    barrier_status_tendency: buildScalarEnvelope(all.barrier_status_tendency, 'barrier_status_tendency'),
    goals: buildGoalsEnvelope(all.goals),
    risk_axes: buildCollectionEnvelope(all.risk_axes, { primaryLimit: 4, totalLimit: 6 }),
    ingredient_targets: buildCollectionEnvelope(all.ingredient_targets, { primaryLimit: 4, totalLimit: 6 }),
    ingredient_avoid: buildCollectionEnvelope(all.ingredient_avoid, { primaryLimit: 4, totalLimit: 6 }),
    photo_findings_summary: dedupeCollectionCandidates(all.photo_findings_summary).slice(0, 6),
    evidence_summary: uniqStrings([
      ...asArray(recentLogSignals.evidence_summary),
      ...asArray(all.goals).slice(0, 2).map((item) => item && item.source_ref ? `Goal signal from ${item.source_ref}` : ''),
      ...asArray(all.photo_findings_summary).slice(0, 2).map((item) => item && item.value && item.value.finding ? `Photo finding: ${item.value.finding}` : ''),
    ], 5),
    source_mix_summary: [],
    conflicts: [],
  };
  snapshot.source_mix_summary = buildSourceMixSummary(snapshot);
  snapshot.conflicts = buildConflicts(snapshot);
  const hasMeaningfulContent = Boolean(
    snapshot.skin_type_tendency.winner ||
      snapshot.sensitivity_tendency.winner ||
      snapshot.barrier_status_tendency.winner ||
      asArray(snapshot.goals.active_goals && snapshot.goals.active_goals.items).length ||
      asArray(snapshot.goals.background_goals && snapshot.goals.background_goals.items).length ||
      asArray(snapshot.risk_axes.items).length ||
      asArray(snapshot.ingredient_targets.items).length ||
      asArray(snapshot.ingredient_avoid.items).length ||
      asArray(snapshot.photo_findings_summary).length ||
      asArray(snapshot.evidence_summary).length
  );
  if (!hasMeaningfulContent) return null;
  return snapshot;
}

function normalizeRequestOverride(requestOverride = null) {
  const row = isPlainObject(requestOverride) ? requestOverride : {};
  return {
    skinType: pickFirstTrimmed(row.skinType, row.skin_type) || null,
    sensitivity: pickFirstTrimmed(row.sensitivity) || null,
    barrierStatus: pickFirstTrimmed(row.barrierStatus, row.barrier_status) || null,
    goals: uniqStrings(row.goals, 6),
    contraindications: uniqStrings(row.contraindications, 12),
  };
}

function hasExplicitProfileSignals(profile = null) {
  const normalized = isPlainObject(profile) ? profile : {};
  return Boolean(
    normalized.skinType ||
      normalized.sensitivity ||
      normalized.barrierStatus ||
      asArray(normalized.goals).length ||
      asArray(normalized.contraindications).length,
  );
}

function hasArtifactSnapshot(snapshot = null) {
  return isPlainObject(snapshot) && asArray(snapshot.derived_from_artifact_ids).length > 0;
}

function hasCompatLastAnalysis(profile = null) {
  const row = isPlainObject(profile) ? profile : {};
  return isPlainObject(row.lastAnalysis) || isPlainObject(row.last_analysis);
}

function deriveContextSourceMode({
  snapshot = null,
  profile = null,
  requestOverride = null,
  recentLogs = [],
} = {}) {
  if (hasArtifactSnapshot(snapshot)) return 'artifact';
  if (hasCompatLastAnalysis(profile) && isPlainObject(snapshot)) return 'artifact_compat_fallback';
  if (
    isPlainObject(snapshot) ||
    hasExplicitProfileSignals(normalizeProfileForSnapshot(profile)) ||
    hasExplicitProfileSignals(normalizeRequestOverride(requestOverride)) ||
    asArray(recentLogs).length > 0
  ) {
    return 'explicit_only';
  }
  return 'none';
}

function buildResolvedContextMeta({
  snapshot = null,
  profile = null,
  requestOverride = null,
  recentLogs = [],
} = {}) {
  const contextSourceMode = deriveContextSourceMode({
    snapshot,
    profile,
    requestOverride,
    recentLogs,
  });
  return {
    context_source_mode: CONTEXT_SOURCE_MODE.includes(contextSourceMode) ? contextSourceMode : 'none',
    analysis_context_available: contextSourceMode !== 'none',
    snapshot_present: contextSourceMode === 'artifact' || contextSourceMode === 'artifact_compat_fallback',
  };
}

function resolveAnalysisContextForTask({
  task,
  snapshot = null,
  profile = null,
  requestOverride = null,
  recentLogs = [],
} = {}) {
  const normalizedSnapshot = isPlainObject(snapshot) ? snapshot : null;
  const explicitProfile = normalizeProfileForSnapshot(profile);
  const normalizedOverride = normalizeRequestOverride(requestOverride);
  const contextMeta = buildResolvedContextMeta({
    snapshot: normalizedSnapshot,
    profile,
    requestOverride,
    recentLogs,
  });
  return {
    task: asString(task) || 'unknown',
    snapshot_present: contextMeta.snapshot_present,
    context_source_mode: contextMeta.context_source_mode,
    analysis_context_available: contextMeta.analysis_context_available,
    snapshot: normalizedSnapshot,
    explicit_profile: explicitProfile,
    request_override: normalizedOverride,
    recent_log_extraction_signature: buildRecentLogExtractionSignature(recentLogs),
  };
}

function makeExclusion(field, reason, sourceClass) {
  return {
    field,
    reason,
    source_class: sourceClass || null,
  };
}

function isHardCandidate(candidate, { hardThreshold = 0.72 } = {}) {
  if (!candidate) return false;
  if (candidate.source_class !== SOURCE_CLASS.EXPLICIT && candidate.source_class !== SOURCE_CLASS.ARTIFACT) return false;
  if (candidate.freshness_bucket === FRESHNESS_BUCKET.STALE) return false;
  return Number(candidate.confidence) >= hardThreshold;
}

function applyExplicitScalarOverride({ field, explicitValue, overrideValue, hard, soft, exclusions }) {
  const overrideToken = asString(overrideValue);
  const explicitToken = asString(explicitValue);
  const value = overrideToken || explicitToken;
  if (!value) return false;
  hard[field] = value;
  delete soft[field];
  exclusions.push(makeExclusion(field, 'explicitly_overridden', SOURCE_CLASS.EXPLICIT));
  return Boolean(overrideToken);
}

function selectGoalContext({
  explicitGoals = [],
  overrideGoals = [],
  snapshotActiveGoals = [],
  snapshotBackgroundGoals = [],
} = {}) {
  const override = uniqStrings(overrideGoals, 3);
  if (override.length) {
    return {
      hard_goals: override,
      soft_goals: [],
      explicit_override_applied: true,
      goal_source: 'request_override',
    };
  }
  const explicit = uniqStrings(explicitGoals, 3);
  if (explicit.length) {
    return {
      hard_goals: explicit,
      soft_goals: [],
      explicit_override_applied: false,
      goal_source: 'explicit_profile',
    };
  }
  return {
    hard_goals: uniqStrings(snapshotActiveGoals, 3),
    soft_goals: uniqStrings(snapshotBackgroundGoals, 3),
    explicit_override_applied: false,
    goal_source: 'snapshot',
  };
}

function selectAvoidContext({
  explicitAvoids = [],
  overrideAvoids = [],
  snapshotEnvelope = null,
  max = 4,
} = {}) {
  const exclusions = [];
  const override = uniqStrings(overrideAvoids, max);
  if (override.length) {
    exclusions.push(makeExclusion('ingredient_avoid', 'explicitly_overridden', SOURCE_CLASS.EXPLICIT));
    return {
      hard_avoid: override,
      soft_avoid: [],
      exclusions,
      explicit_override_applied: true,
    };
  }
  const explicit = uniqStrings(explicitAvoids, max);
  if (explicit.length) {
    exclusions.push(makeExclusion('ingredient_avoid', 'explicitly_overridden', SOURCE_CLASS.EXPLICIT));
    return {
      hard_avoid: explicit,
      soft_avoid: [],
      exclusions,
      explicit_override_applied: false,
    };
  }
  if (!isPlainObject(snapshotEnvelope)) {
    return {
      hard_avoid: [],
      soft_avoid: [],
      exclusions,
      explicit_override_applied: false,
    };
  }
  const hard = [];
  const soft = [];
  const conflictState = asString(snapshotEnvelope.conflict_state);
  const blockedHard = conflictState === 'mixed' || conflictState === 'uncertain';
  asArray(snapshotEnvelope.primary_items).forEach((item) => {
    const value = asString(item && item.value);
    if (!value) return;
    if (!blockedHard && isHardCandidate(item)) {
      hard.push(value);
    } else {
      soft.push(value);
      exclusions.push(makeExclusion(`ingredient_avoid.${value}`, blockedHard ? 'conflicted' : 'low_confidence', item && item.source_class));
    }
  });
  return {
    hard_avoid: uniqStrings(hard, max),
    soft_avoid: uniqStrings(soft, max),
    exclusions,
    explicit_override_applied: false,
  };
}

function winnerValue(envelope) {
  return isPlainObject(envelope) && envelope.winner ? envelope.winner.value : null;
}

function resolveScalarForTask(envelope, field, { allowSoft = true, hardThreshold = 0.72 } = {}) {
  const winner = isPlainObject(envelope) ? envelope.winner : null;
  if (!winner) return { hard: null, soft: null, excluded: [] };
  if (envelope.conflict_state && envelope.conflict_state !== 'resolved') {
    return {
      hard: null,
      soft: allowSoft ? { [field]: winner.value } : null,
      excluded: [makeExclusion(field, 'conflicted', winner.source_class)],
    };
  }
  if (
    (winner.source_class === SOURCE_CLASS.EXPLICIT || winner.source_class === SOURCE_CLASS.ARTIFACT) &&
    Number(winner.confidence) >= hardThreshold &&
    winner.freshness_bucket !== FRESHNESS_BUCKET.STALE
  ) {
    return { hard: { [field]: winner.value }, soft: null, excluded: [] };
  }
  if (allowSoft) {
    const reason = winner.freshness_bucket === FRESHNESS_BUCKET.STALE ? 'stale_for_task' : 'low_confidence';
    return {
      hard: null,
      soft: { [field]: winner.value },
      excluded: [makeExclusion(field, reason, winner.source_class)],
    };
  }
  return {
    hard: null,
    soft: null,
    excluded: [makeExclusion(field, 'low_confidence', winner.source_class)],
  };
}

function collectionValues(envelope) {
  return asArray(envelope && envelope.items).map((item) => item && item.value).filter(Boolean);
}

function collectionPrimaryValues(envelope) {
  return asArray(envelope && envelope.primary_items).map((item) => item && item.value).filter(Boolean);
}

function buildContextMode({ snapshotPresent, hardContext, softContext }) {
  const hardKeys = Object.keys(isPlainObject(hardContext) ? hardContext : {});
  const softKeys = Object.keys(isPlainObject(softContext) ? softContext : {});
  if (!snapshotPresent) {
    if (hardKeys.length || softKeys.length) return 'explicit_only';
    return 'no_context';
  }
  if (hardKeys.length && softKeys.length) return 'snapshot_mixed';
  if (hardKeys.length) return 'snapshot_hard';
  if (softKeys.length) return 'snapshot_soft_only';
  return 'no_context';
}

function compactConflictSummary(conflicts = [], allowedFields = []) {
  const allowed = new Set(asArray(allowedFields));
  return asArray(conflicts)
    .filter((item) => !allowed.size || allowed.has(asString(item.field)))
    .slice(0, 4)
    .map((item) => ({
      field: asString(item.field),
      resolution: asString(item.resolution),
      resolution_reason: asString(item.resolution_reason),
    }));
}

function buildRoutineAnalysisContextFromSnapshot(resolved = {}) {
  const snapshot = resolved.snapshot;
  const explicit = resolved.explicit_profile;
  const override = resolved.request_override;
  const hard = {};
  const soft = {};
  const exclusions = [];
  const evidence = [];

  let explicitOverrideApplied = false;
  const goalContext = selectGoalContext({
    explicitGoals: explicit.goals,
    overrideGoals: override.goals,
    snapshotActiveGoals: collectionPrimaryValues(snapshot && snapshot.goals && snapshot.goals.active_goals),
    snapshotBackgroundGoals: collectionValues(snapshot && snapshot.goals && snapshot.goals.background_goals),
  });
  if (goalContext.hard_goals.length) hard.active_goals = goalContext.hard_goals;
  if (goalContext.soft_goals.length) soft.background_goals = goalContext.soft_goals.slice(0, 3);
  explicitOverrideApplied = explicitOverrideApplied || goalContext.explicit_override_applied;

  for (const item of [
    resolveScalarForTask(snapshot && snapshot.sensitivity_tendency, 'sensitivity'),
    resolveScalarForTask(snapshot && snapshot.barrier_status_tendency, 'barrier_status'),
  ]) {
    if (item.hard) Object.assign(hard, item.hard);
    if (item.soft) Object.assign(soft, item.soft);
    exclusions.push(...item.excluded);
  }
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'sensitivity',
    explicitValue: explicit.sensitivity,
    overrideValue: override.sensitivity,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'barrier_status',
    explicitValue: explicit.barrierStatus,
    overrideValue: override.barrierStatus,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;

  const riskAxes = collectionPrimaryValues(snapshot && snapshot.risk_axes)
    .map((item) => isPlainObject(item) ? `${item.axis}:${item.level}` : asString(item))
    .filter(Boolean)
    .slice(0, 4);
  if (riskAxes.length) hard.risk_axes = riskAxes;

  const photoFindings = asArray(snapshot && snapshot.photo_findings_summary)
    .filter((item) => item && item.freshness_bucket !== FRESHNESS_BUCKET.STALE)
    .slice(0, 2)
    .map((item) => isPlainObject(item.value) ? `${item.value.finding}${item.value.region ? ` (${item.value.region})` : ''}` : asString(item.value))
    .filter(Boolean);
  if (photoFindings.length) soft.photo_findings = photoFindings;
  asArray(snapshot && snapshot.photo_findings_summary)
    .filter((item) => item && item.freshness_bucket === FRESHNESS_BUCKET.STALE)
    .forEach(() => exclusions.push(makeExclusion('photo_findings_summary', 'stale_for_task', SOURCE_CLASS.ARTIFACT)));

  evidence.push(...uniqStrings(snapshot && snapshot.evidence_summary, 4));
  return {
    adapter_version: DEFAULT_TASK_ADAPTER_VERSION,
    snapshot_present: Boolean(resolved.snapshot_present),
    context_source_mode: asString(resolved.context_source_mode) || 'none',
    analysis_context_available: Boolean(resolved.analysis_context_available),
    task_hard_context: hard,
    task_soft_context: soft,
    task_exclusions: exclusions,
    evidence_summary: evidence.slice(0, 5),
    context_mode: buildContextMode({ snapshotPresent: Boolean(snapshot), hardContext: hard, softContext: soft }),
    explicit_override_applied: explicitOverrideApplied,
    snapshot_fields_used: ['goals', 'sensitivity_tendency', 'barrier_status_tendency', 'risk_axes', 'photo_findings_summary'],
    hard_context_fields_used: Object.keys(hard),
    soft_context_fields_used: Object.keys(soft),
    analysis_context_conflicts: compactConflictSummary(snapshot && snapshot.conflicts, ['sensitivity_tendency', 'barrier_status_tendency', 'risk_axes']),
  };
}

function buildProductAnalysisContextFromSnapshot(resolved = {}) {
  const snapshot = resolved.snapshot;
  const explicit = resolved.explicit_profile;
  const override = resolved.request_override;
  const hard = {};
  const soft = {};
  const exclusions = [];
  const evidence = [];
  let explicitOverrideApplied = false;

  const goalContext = selectGoalContext({
    explicitGoals: explicit.goals,
    overrideGoals: override.goals,
    snapshotActiveGoals: collectionPrimaryValues(snapshot && snapshot.goals && snapshot.goals.active_goals),
    snapshotBackgroundGoals: collectionValues(snapshot && snapshot.goals && snapshot.goals.background_goals),
  });
  if (goalContext.hard_goals.length) hard.active_goals = goalContext.hard_goals;
  if (goalContext.soft_goals.length) soft.background_goals = goalContext.soft_goals.slice(0, 2);
  explicitOverrideApplied = explicitOverrideApplied || goalContext.explicit_override_applied;

  for (const item of [
    resolveScalarForTask(snapshot && snapshot.skin_type_tendency, 'skin_type', { hardThreshold: 0.7 }),
    resolveScalarForTask(snapshot && snapshot.sensitivity_tendency, 'sensitivity'),
    resolveScalarForTask(snapshot && snapshot.barrier_status_tendency, 'barrier_status'),
  ]) {
    if (item.hard) Object.assign(hard, item.hard);
    if (item.soft) Object.assign(soft, item.soft);
    exclusions.push(...item.excluded);
  }
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'skin_type',
    explicitValue: explicit.skinType,
    overrideValue: override.skinType,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'sensitivity',
    explicitValue: explicit.sensitivity,
    overrideValue: override.sensitivity,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'barrier_status',
    explicitValue: explicit.barrierStatus,
    overrideValue: override.barrierStatus,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;

  const targets = collectionPrimaryValues(snapshot && snapshot.ingredient_targets).map((item) => asString(item)).filter(Boolean).slice(0, 4);
  if (targets.length) soft.ingredient_targets = targets;
  const avoidContext = selectAvoidContext({
    explicitAvoids: explicit.contraindications,
    overrideAvoids: override.contraindications,
    snapshotEnvelope: snapshot && snapshot.ingredient_avoid,
    max: 4,
  });
  if (avoidContext.hard_avoid.length) hard.ingredient_avoid = avoidContext.hard_avoid;
  if (avoidContext.soft_avoid.length) soft.ingredient_avoid = avoidContext.soft_avoid;
  exclusions.push(...avoidContext.exclusions);
  explicitOverrideApplied = explicitOverrideApplied || avoidContext.explicit_override_applied;

  const riskAxes = collectionPrimaryValues(snapshot && snapshot.risk_axes)
    .map((item) => isPlainObject(item) ? `${item.axis}:${item.level}` : asString(item))
    .filter(Boolean)
    .slice(0, 3);
  if (riskAxes.length) soft.risk_axes = riskAxes;

  evidence.push(...uniqStrings(snapshot && snapshot.evidence_summary, 4));
  return {
    adapter_version: DEFAULT_TASK_ADAPTER_VERSION,
    snapshot_present: Boolean(resolved.snapshot_present),
    context_source_mode: asString(resolved.context_source_mode) || 'none',
    analysis_context_available: Boolean(resolved.analysis_context_available),
    task_hard_context: hard,
    task_soft_context: soft,
    task_exclusions: exclusions,
    evidence_summary: evidence.slice(0, 5),
    context_mode: buildContextMode({ snapshotPresent: Boolean(snapshot), hardContext: hard, softContext: soft }),
    explicit_override_applied: explicitOverrideApplied,
    snapshot_fields_used: ['goals', 'skin_type_tendency', 'sensitivity_tendency', 'barrier_status_tendency', 'ingredient_targets', 'ingredient_avoid', 'risk_axes'],
    hard_context_fields_used: Object.keys(hard),
    soft_context_fields_used: Object.keys(soft),
    analysis_context_conflicts: compactConflictSummary(snapshot && snapshot.conflicts, ['skin_type_tendency', 'sensitivity_tendency', 'barrier_status_tendency']),
  };
}

function selectCollectionContext(envelope, field, { max = 4, hardThreshold = 0.72 } = {}) {
  const hard = [];
  const soft = [];
  const exclusions = [];
  const conflictState = asString(envelope && envelope.conflict_state);
  const blockedHard = conflictState === 'mixed' || conflictState === 'uncertain';
  const items = asArray(envelope && envelope.primary_items);
  for (const item of items) {
    const value = asString(item && item.value);
    if (!value) continue;
    if (!blockedHard && isHardCandidate(item, { hardThreshold })) {
      hard.push(value);
      continue;
    }
    soft.push(value);
    const reason =
      blockedHard
        ? 'conflicted'
        : item && item.freshness_bucket === FRESHNESS_BUCKET.STALE
          ? 'stale_for_task'
          : 'low_confidence';
    exclusions.push(makeExclusion(`${field}.${value}`, reason, item && item.source_class));
  }
  return {
    hard: uniqStrings(hard, max),
    soft: uniqStrings(soft, max),
    exclusions,
  };
}

function buildIngredientAnalysisContextFromSnapshot(resolved = {}) {
  const snapshot = resolved.snapshot;
  const explicit = resolved.explicit_profile;
  const override = resolved.request_override;
  const hard = {};
  const soft = {};
  const exclusions = [];
  const evidence = [];
  let explicitOverrideApplied = false;

  const goalContext = selectGoalContext({
    explicitGoals: explicit.goals,
    overrideGoals: override.goals,
    snapshotActiveGoals: collectionPrimaryValues(snapshot && snapshot.goals && snapshot.goals.active_goals),
    snapshotBackgroundGoals: collectionValues(snapshot && snapshot.goals && snapshot.goals.background_goals),
  });
  if (goalContext.hard_goals.length) hard.active_goals = goalContext.hard_goals.slice(0, 3);
  if (goalContext.soft_goals.length) soft.background_goals = goalContext.soft_goals.slice(0, 3);
  explicitOverrideApplied = explicitOverrideApplied || goalContext.explicit_override_applied;

  for (const item of [
    resolveScalarForTask(snapshot && snapshot.sensitivity_tendency, 'sensitivity'),
    resolveScalarForTask(snapshot && snapshot.barrier_status_tendency, 'barrier_status'),
  ]) {
    if (item.hard) Object.assign(hard, item.hard);
    if (item.soft) Object.assign(soft, item.soft);
    exclusions.push(...item.excluded);
  }
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'sensitivity',
    explicitValue: explicit.sensitivity,
    overrideValue: override.sensitivity,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'barrier_status',
    explicitValue: explicit.barrierStatus,
    overrideValue: override.barrierStatus,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;

  const targets = selectCollectionContext(snapshot && snapshot.ingredient_targets, 'ingredient_targets', {
    max: 4,
    hardThreshold: 0.76,
  });
  if (targets.hard.length) hard.ingredient_targets = targets.hard;
  if (targets.soft.length) soft.ingredient_targets = targets.soft;
  exclusions.push(...targets.exclusions);

  const avoidContext = selectAvoidContext({
    explicitAvoids: explicit.contraindications,
    overrideAvoids: override.contraindications,
    snapshotEnvelope: snapshot && snapshot.ingredient_avoid,
    max: 4,
  });
  if (avoidContext.hard_avoid.length) hard.ingredient_avoid = avoidContext.hard_avoid;
  if (avoidContext.soft_avoid.length) soft.ingredient_avoid = avoidContext.soft_avoid;
  exclusions.push(...avoidContext.exclusions);
  explicitOverrideApplied = explicitOverrideApplied || avoidContext.explicit_override_applied;

  const riskAxes = collectionPrimaryValues(snapshot && snapshot.risk_axes)
    .map((item) => isPlainObject(item) ? `${item.axis}:${item.level}` : asString(item))
    .filter(Boolean)
    .slice(0, 3);
  if (riskAxes.length) soft.risk_axes = riskAxes;

  if (asArray(snapshot && snapshot.photo_findings_summary).length) {
    exclusions.push(makeExclusion('photo_findings_summary', 'irrelevant_for_task', SOURCE_CLASS.ARTIFACT));
  }

  evidence.push(...uniqStrings(snapshot && snapshot.evidence_summary, 4));
  return {
    adapter_version: DEFAULT_TASK_ADAPTER_VERSION,
    snapshot_present: Boolean(resolved.snapshot_present),
    context_source_mode: asString(resolved.context_source_mode) || 'none',
    analysis_context_available: Boolean(resolved.analysis_context_available),
    task_hard_context: hard,
    task_soft_context: soft,
    task_exclusions: exclusions,
    evidence_summary: evidence.slice(0, 5),
    context_mode: buildContextMode({ snapshotPresent: Boolean(snapshot), hardContext: hard, softContext: soft }),
    explicit_override_applied: explicitOverrideApplied,
    snapshot_fields_used: ['goals', 'sensitivity_tendency', 'barrier_status_tendency', 'ingredient_targets', 'ingredient_avoid', 'risk_axes'],
    hard_context_fields_used: Object.keys(hard),
    soft_context_fields_used: Object.keys(soft),
    analysis_context_conflicts: compactConflictSummary(snapshot && snapshot.conflicts, [
      'sensitivity_tendency',
      'barrier_status_tendency',
      'ingredient_targets',
      'ingredient_avoid',
    ]),
  };
}

function buildRecommendationAnalysisContextFromSnapshot(resolved = {}) {
  const base = buildProductAnalysisContextFromSnapshot(resolved);
  const hard = { ...base.task_hard_context };
  const soft = { ...base.task_soft_context };
  const exclusions = [...base.task_exclusions];
  if (Array.isArray(soft.ingredient_avoid)) {
    delete soft.ingredient_avoid;
  }
  return {
    ...base,
    task_hard_context: hard,
    task_soft_context: soft,
    task_exclusions: exclusions,
  };
}

function buildChatAnalysisContextFromSnapshot(resolved = {}) {
  const snapshot = resolved.snapshot;
  const explicit = resolved.explicit_profile;
  const override = resolved.request_override;
  const hard = {};
  const soft = {};
  const exclusions = [];
  const evidence = [];
  let explicitOverrideApplied = false;

  const goalContext = selectGoalContext({
    explicitGoals: explicit.goals,
    overrideGoals: override.goals,
    snapshotActiveGoals: collectionPrimaryValues(snapshot && snapshot.goals && snapshot.goals.active_goals),
    snapshotBackgroundGoals: collectionValues(snapshot && snapshot.goals && snapshot.goals.background_goals),
  });
  if (goalContext.hard_goals.length) hard.active_goals = goalContext.hard_goals;
  if (goalContext.soft_goals.length) soft.background_goals = goalContext.soft_goals.slice(0, 2);
  explicitOverrideApplied = explicitOverrideApplied || goalContext.explicit_override_applied;
  for (const item of [
    resolveScalarForTask(snapshot && snapshot.skin_type_tendency, 'skin_type', { hardThreshold: 0.68 }),
    resolveScalarForTask(snapshot && snapshot.sensitivity_tendency, 'sensitivity', { hardThreshold: 0.68 }),
    resolveScalarForTask(snapshot && snapshot.barrier_status_tendency, 'barrier_status', { hardThreshold: 0.68 }),
  ]) {
    if (item.hard) Object.assign(hard, item.hard);
    if (item.soft) Object.assign(soft, item.soft);
    exclusions.push(...item.excluded);
  }
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'skin_type',
    explicitValue: explicit.skinType,
    overrideValue: override.skinType,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'sensitivity',
    explicitValue: explicit.sensitivity,
    overrideValue: override.sensitivity,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'barrier_status',
    explicitValue: explicit.barrierStatus,
    overrideValue: override.barrierStatus,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;
  const photoFindings = asArray(snapshot && snapshot.photo_findings_summary)
    .slice(0, 2)
    .map((item) => isPlainObject(item.value) ? `${item.value.finding}${item.value.region ? ` (${item.value.region})` : ''}` : asString(item.value))
    .filter(Boolean);
  if (photoFindings.length) soft.photo_findings = photoFindings;
  evidence.push(...uniqStrings(snapshot && snapshot.evidence_summary, 5));
  return {
    adapter_version: DEFAULT_TASK_ADAPTER_VERSION,
    snapshot_present: Boolean(resolved.snapshot_present),
    context_source_mode: asString(resolved.context_source_mode) || 'none',
    analysis_context_available: Boolean(resolved.analysis_context_available),
    task_hard_context: hard,
    task_soft_context: soft,
    task_exclusions: exclusions,
    evidence_summary: evidence.slice(0, 5),
    context_mode: buildContextMode({ snapshotPresent: Boolean(snapshot), hardContext: hard, softContext: soft }),
    explicit_override_applied: explicitOverrideApplied,
    snapshot_fields_used: ['goals', 'skin_type_tendency', 'sensitivity_tendency', 'barrier_status_tendency', 'photo_findings_summary'],
    hard_context_fields_used: Object.keys(hard),
    soft_context_fields_used: Object.keys(soft),
    analysis_context_conflicts: compactConflictSummary(snapshot && snapshot.conflicts, ['skin_type_tendency', 'sensitivity_tendency', 'barrier_status_tendency']),
  };
}

function buildTravelAnalysisContextFromSnapshot(resolved = {}) {
  const snapshot = resolved.snapshot;
  const explicit = resolved.explicit_profile;
  const override = resolved.request_override;
  const hard = {};
  const soft = {};
  const exclusions = [];
  const evidence = [];
  let explicitOverrideApplied = false;
  for (const item of [
    resolveScalarForTask(snapshot && snapshot.sensitivity_tendency, 'sensitivity'),
    resolveScalarForTask(snapshot && snapshot.barrier_status_tendency, 'barrier_status'),
  ]) {
    if (item.hard) Object.assign(hard, item.hard);
    if (item.soft) Object.assign(soft, item.soft);
    exclusions.push(...item.excluded);
  }
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'sensitivity',
    explicitValue: explicit.sensitivity,
    overrideValue: override.sensitivity,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;
  explicitOverrideApplied = applyExplicitScalarOverride({
    field: 'barrier_status',
    explicitValue: explicit.barrierStatus,
    overrideValue: override.barrierStatus,
    hard,
    soft,
    exclusions,
  }) || explicitOverrideApplied;
  const goalContext = selectGoalContext({
    explicitGoals: explicit.goals,
    overrideGoals: override.goals,
    snapshotActiveGoals: collectionPrimaryValues(snapshot && snapshot.goals && snapshot.goals.active_goals).map((item) => asString(item)).filter(Boolean),
    snapshotBackgroundGoals: collectionValues(snapshot && snapshot.goals && snapshot.goals.background_goals).map((item) => asString(item)).filter(Boolean),
  });
  if (goalContext.hard_goals.length) hard.active_goals = goalContext.hard_goals.slice(0, 3);
  if (goalContext.soft_goals.length) soft.background_goals = goalContext.soft_goals.slice(0, 2);
  explicitOverrideApplied = explicitOverrideApplied || goalContext.explicit_override_applied;
  const riskAxes = collectionPrimaryValues(snapshot && snapshot.risk_axes).map((item) => isPlainObject(item) ? `${item.axis}:${item.level}` : asString(item)).filter(Boolean);
  if (riskAxes.length) hard.risk_axes = riskAxes.slice(0, 3);
  const photoFindings = asArray(snapshot && snapshot.photo_findings_summary)
    .filter((item) => item && item.freshness_bucket !== FRESHNESS_BUCKET.STALE)
    .slice(0, 2)
    .map((item) => isPlainObject(item.value) ? `${item.value.finding}${item.value.region ? ` (${item.value.region})` : ''}` : asString(item.value))
    .filter(Boolean);
  if (photoFindings.length) soft.photo_findings = photoFindings;
  evidence.push(...uniqStrings(snapshot && snapshot.evidence_summary, 4));
  return {
    adapter_version: DEFAULT_TASK_ADAPTER_VERSION,
    snapshot_present: Boolean(resolved.snapshot_present),
    context_source_mode: asString(resolved.context_source_mode) || 'none',
    analysis_context_available: Boolean(resolved.analysis_context_available),
    task_hard_context: hard,
    task_soft_context: soft,
    task_exclusions: exclusions,
    evidence_summary: evidence.slice(0, 5),
    context_mode: buildContextMode({ snapshotPresent: Boolean(snapshot), hardContext: hard, softContext: soft }),
    explicit_override_applied: explicitOverrideApplied,
    snapshot_fields_used: ['goals', 'sensitivity_tendency', 'barrier_status_tendency', 'risk_axes', 'photo_findings_summary'],
    hard_context_fields_used: Object.keys(hard),
    soft_context_fields_used: Object.keys(soft),
    analysis_context_conflicts: compactConflictSummary(snapshot && snapshot.conflicts, ['sensitivity_tendency', 'barrier_status_tendency']),
  };
}

function buildAnalysisContextPromptBlock({ taskLabel = 'analysis', taskContext = null } = {}) {
  const context = isPlainObject(taskContext) ? taskContext : {};
  const hard = isPlainObject(context.task_hard_context) ? context.task_hard_context : {};
  const soft = isPlainObject(context.task_soft_context) ? context.task_soft_context : {};
  const evidence = asArray(context.evidence_summary).slice(0, 5);
  const conflicts = asArray(context.analysis_context_conflicts).slice(0, 4);
  const lines = [
    `[ANALYSIS CONTEXT FOR ${String(taskLabel || 'analysis').toUpperCase()}]`,
    `context_mode=${asString(context.context_mode) || 'no_context'}`,
    `analysis_context_hard_json=${JSON.stringify(hard)}`,
    `analysis_context_soft_json=${JSON.stringify(soft)}`,
    `analysis_context_evidence_json=${JSON.stringify(evidence)}`,
    `analysis_context_conflicts_json=${JSON.stringify(conflicts)}`,
    '[USAGE RULES]',
    '- hard context may be treated as strong user-relevant context.',
    '- soft context must be treated as supportive or uncertainty-bearing context, not as confirmed fact.',
    '- if explicit request/profile input conflicts with snapshot, explicit input wins.',
    '- stale or low-quality artifact signals should reduce certainty, not increase specificity.',
    '- do not restate snapshot as if the user explicitly said it.',
    '[/USAGE RULES]',
  ];
  return lines.join('\n');
}

module.exports = {
  ANALYSIS_CONTEXT_SNAPSHOT_VERSION,
  ANALYSIS_CONTEXT_BUILDER_VERSION,
  DEFAULT_TASK_ADAPTER_VERSION,
  buildAnalysisContextSnapshotV1,
  resolveAnalysisContextForTask,
  buildRoutineAnalysisContextFromSnapshot,
  buildProductAnalysisContextFromSnapshot,
  buildIngredientAnalysisContextFromSnapshot,
  buildRecommendationAnalysisContextFromSnapshot,
  buildChatAnalysisContextFromSnapshot,
  buildTravelAnalysisContextFromSnapshot,
  buildAnalysisContextPromptBlock,
  buildRecentLogExtractionSignature,
  __internal: {
    extractRecentLogSignals,
    buildDiagnosisV2ArtifactCandidates,
    buildSkinArtifactCandidates,
    buildLastAnalysisFallbackCandidates,
    buildScalarEnvelope,
    buildCollectionEnvelope,
    buildGoalsEnvelope,
    normalizeProfileForSnapshot,
  },
};
