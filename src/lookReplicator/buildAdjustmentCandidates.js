const crypto = require('crypto');

const EXPERIMENT_VARIANT_ID = 'lr_more_v1';

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

function seedToUint32(seed) {
  const s = String(seed || '');
  const hex = crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
  return parseInt(hex, 16) >>> 0;
}

function mulberry32(a) {
  let t = a >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function buildExperimentSeed({ exposureId }) {
  return crypto.createHash('sha256').update(`${EXPERIMENT_VARIANT_ID}:${exposureId}`).digest('hex').slice(0, 16);
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
  const experimentSeed = buildExperimentSeed({ exposureId });
  const seededShuffleRng = mulberry32(seedToUint32(experimentSeed));

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

  const explorationEnabled = Boolean(enabled);
  const explorationBucket = explorationEnabled && clamp01(rng()) < clamp01(explorationRate) ? 1 : 0;
  if (explorationBucket === 1 && more.length > 1) {
    // Deterministic shuffle (reproducible): seeded from exposureId-derived seed.
    shuffleInPlace(more, seededShuffleRng);
  }

  const combined = [...base, ...more];
  for (let i = 0; i < combined.length; i += 1) {
    const impressionId = String(idGen()).trim() || newUuidish();
    combined[i] = { ...combined[i], impressionId, rank: i + 1 };
  }

  const experiment = {
    variantId: EXPERIMENT_VARIANT_ID,
    explorationEnabled,
    explorationRate: clamp01(explorationRate),
    explorationBucket,
    ...(process.env.NODE_ENV !== 'production' ? { seed: experimentSeed } : {}),
  };

  return {
    exposureId,
    adjustmentCandidates: combined,
    experiment,
    experiments: {
      variant: explorationBucket === 1 ? 'explore_more_v1' : 'control_more_v1',
      explorationRate: experiment.explorationRate,
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
