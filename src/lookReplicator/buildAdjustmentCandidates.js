function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function truncate(s, maxLen) {
  const str = String(s || '').trim();
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return `${str.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function confidenceToScore(confidence) {
  if (confidence === 'high') return 0.9;
  if (confidence === 'medium') return 0.7;
  if (confidence === 'low') return 0.4;
  return 0.5;
}

function pickPrimaryTechniqueId(adjustment) {
  const refs = adjustment?.techniqueRefs;
  if (!Array.isArray(refs) || refs.length === 0) return null;
  const id = String(refs[0]?.id || '').trim();
  return id || null;
}

function newUuidish() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    // ignore
  }
  return crypto.randomBytes(16).toString('hex');
}

function shuffleInPlace(items, rng) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(clamp01(rng()) * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
}

function shouldEnableMoreCandidates() {
  const env = process.env.EXPERIMENT_MORE_CANDIDATES_ENABLED;
  if (env === undefined || env === '') return process.env.NODE_ENV !== 'production';
  return env === '1' || String(env).toLowerCase() === 'true';
}

function getExplorationRate() {
  const env = process.env.EXPERIMENT_MORE_CANDIDATES_EXPLORATION_RATE;
  if (env === undefined || env === '') return 0.1;
  return clamp01(env);
}

function buildDefaultCandidate({ adjustment, rank }) {
  const techniqueId = pickPrimaryTechniqueId(adjustment);
  const ruleId = String(adjustment?.ruleId || '').trim() || null;
  const impactArea = String(adjustment?.impactArea || '').trim();

  const id = techniqueId ? `technique:${techniqueId}` : ruleId ? `rule:${ruleId}` : `default:${impactArea}`;
  const score = confidenceToScore(adjustment?.confidence);
  const title = String(adjustment?.title || '').trim();
  const why = truncate(adjustment?.why || adjustment?.because || '', 120);

  const gating =
    adjustment?.confidence === 'low'
      ? { status: 'low_confidence' }
      : !techniqueId && ruleId
        ? { status: 'fallback_only' }
        : { status: 'ok' };

  return {
    id,
    area: impactArea,
    title,
    why,
    techniqueId,
    ruleId,
    score,
    rank,
    isDefault: true,
    gating,
  };
}

function buildPlaceholderCandidate({ area, rank }) {
  const titleByArea = {
    prep: 'Prep option',
    brow: 'Brow option',
    blush: 'Blush option',
    contour: 'Contour option',
  };
  const whyByArea = {
    prep: 'Optional prep tips may help the base sit better.',
    brow: 'Optional brow shaping can change the overall balance.',
    blush: 'Optional blush placement can shift the look’s mood.',
    contour: 'Optional contour can add structure if needed.',
  };

  return {
    id: `more:${area}`,
    area,
    title: titleByArea[area] || 'More option',
    why: truncate(whyByArea[area] || 'Optional extra suggestions.', 120),
    techniqueId: null,
    ruleId: null,
    score: 0.15,
    rank,
    isDefault: false,
    gating: { status: 'low_coverage', reason: 'No technique coverage yet for this area.' },
  };
}

/**
 * Build Phase 1.5 adjustment candidates list.
 *
 * Backward compatible: the primary `adjustments` field stays as-is (3 items).
 * This generates an optional `adjustmentCandidates` list with:
 * - top3 = current adjustments (isDefault=true)
 * - + up to 4 placeholders for other areas (isDefault=false)
 */
function buildAdjustmentCandidates({
  layer2Adjustments,
  rng = Math.random,
  idGen = newUuidish,
  enabled = shouldEnableMoreCandidates(),
  explorationRate = getExplorationRate(),
} = {}) {
  if (!enabled) return { adjustmentCandidates: undefined, experiments: undefined };

  const exposureId = String(idGen()).trim() || newUuidish();

  const base = [];
  const raw = Array.isArray(layer2Adjustments) ? layer2Adjustments : [];
  for (let i = 0; i < raw.length && base.length < 3; i += 1) {
    base.push(buildDefaultCandidate({ adjustment: raw[i], rank: base.length + 1 }));
  }

  const moreAreas = ['prep', 'brow', 'blush', 'contour'];
  const more = [];
  for (const area of moreAreas) {
    if (base.some((c) => c.area === area)) continue;
    more.push(buildPlaceholderCandidate({ area, rank: 0 }));
    if (more.length >= 4) break;
  }

  const explore = clamp01(rng()) < clamp01(explorationRate);
  if (explore && more.length > 1) {
    shuffleInPlace(more, rng);
  }

  const combined = [...base, ...more];
  for (let i = 0; i < combined.length; i += 1) {
    const impressionId = String(idGen()).trim() || newUuidish();
    combined[i] = { ...combined[i], impressionId, rank: i + 1 };
  }

  return {
    exposureId,
    adjustmentCandidates: combined,
    experiments: {
      variant: explore ? 'explore_more_v0' : 'control_more_v0',
      explorationRate: clamp01(explorationRate),
    },
  };
}

module.exports = {
  buildAdjustmentCandidates,
  // exported for unit tests
  truncate,
  confidenceToScore,
  pickPrimaryTechniqueId,
};
