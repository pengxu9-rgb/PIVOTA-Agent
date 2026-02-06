const crypto = require('crypto');

function safeToken(value, { fallback = null, maxLen = 64 } = {}) {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const sanitized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, Math.max(1, maxLen));
  return sanitized || fallback;
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : value == null ? NaN : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function hashToBucket0to99(seed) {
  const digest = crypto.createHash('sha256').update(String(seed == null ? '' : seed)).digest();
  const n = digest.readUInt32BE(0);
  return n % 100;
}

function normalizeVariants(rawVariants) {
  const obj = rawVariants && typeof rawVariants === 'object' && !Array.isArray(rawVariants) ? rawVariants : null;
  if (!obj) return [];

  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const name = safeToken(k, { fallback: null, maxLen: 40 });
    if (!name) continue;
    const weight = clampInt(v, 0, 100, 0);
    if (weight <= 0) continue;
    out.push({ name, weight });
  }

  // Stable ordering independent of JSON key ordering.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function normalizeParams(rawParams, variants) {
  const obj = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams) ? rawParams : null;
  if (!obj) return {};

  const allowed = new Set(variants.map((v) => v.name));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const name = safeToken(k, { fallback: null, maxLen: 40 });
    if (!name || !allowed.has(name)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) out[name] = v;
  }
  return out;
}

function normalizeExperiment(entry) {
  const obj = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  if (!obj) return null;
  const id = safeToken(obj.id, { fallback: null, maxLen: 60 });
  const kind = safeToken(obj.kind, { fallback: null, maxLen: 40 });
  if (!id || !kind) return null;

  const variants = normalizeVariants(obj.variants);
  const params = normalizeParams(obj.params, variants);

  return { id, kind, variants, params };
}

function normalizeWeightsTo100(variants) {
  const items = Array.isArray(variants) ? variants.slice() : [];
  const total = items.reduce((acc, v) => acc + (v && Number.isFinite(v.weight) ? v.weight : 0), 0);
  if (!total) return { variants: items.map((v) => ({ ...v, weight: 0 })), total: 0 };
  if (total <= 100) return { variants: items, total };

  const scaled = items.map((v) => {
    const exact = (v.weight * 100) / total;
    const base = Math.floor(exact);
    return { name: v.name, base, frac: exact - base };
  });
  let sumBase = scaled.reduce((acc, v) => acc + v.base, 0);
  let remainder = 100 - sumBase;

  scaled.sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.name.localeCompare(b.name)));
  for (let i = 0; i < scaled.length && remainder > 0; i += 1) {
    scaled[i].base += 1;
    remainder -= 1;
  }

  const byName = new Map(scaled.map((v) => [v.name, v.base]));
  const normalized = items.map((v) => ({ name: v.name, weight: byName.get(v.name) || 0 }));
  const finalTotal = normalized.reduce((acc, v) => acc + v.weight, 0);
  return { variants: normalized, total: finalTotal };
}

function pickVariant({ requestId, experiment } = {}) {
  const exp = experiment && typeof experiment === 'object' ? experiment : null;
  if (!exp || !exp.id) return { variant: 'holdout', bucket: null, total: 0, reason: 'experiment_missing' };

  const seed = `${exp.id}:${String(requestId == null ? '' : requestId)}`;
  const bucket = hashToBucket0to99(seed);

  const baseVariants = Array.isArray(exp.variants) ? exp.variants : [];
  const sumRaw = baseVariants.reduce((acc, v) => acc + (v && Number.isFinite(v.weight) ? v.weight : 0), 0);
  const { variants, total } = normalizeWeightsTo100(baseVariants);

  if (!total) return { variant: 'holdout', bucket, total: 0, reason: 'no_variants' };

  // If the user configured <=100%, treat remaining buckets as holdout.
  const holdoutEnabled = sumRaw > 0 && sumRaw <= 100;
  if (holdoutEnabled && bucket >= total) return { variant: 'holdout', bucket, total, reason: 'holdout' };

  let cursor = 0;
  for (const v of variants) {
    cursor += v.weight;
    if (bucket < cursor) return { variant: v.name, bucket, total, reason: sumRaw > 100 ? 'normalized' : 'weighted' };
  }

  return { variant: 'holdout', bucket, total, reason: 'fallback' };
}

const CONFIG_CACHE = {
  raw: null,
  experiments: [],
  error: null,
};

function loadExperimentsConfig() {
  const raw = typeof process.env.AURORA_EXPERIMENTS_JSON === 'string' ? process.env.AURORA_EXPERIMENTS_JSON : '';
  if (raw === CONFIG_CACHE.raw) return CONFIG_CACHE;

  CONFIG_CACHE.raw = raw;
  CONFIG_CACHE.experiments = [];
  CONFIG_CACHE.error = null;

  const trimmed = raw.trim();
  if (!trimmed) return CONFIG_CACHE;

  if (trimmed.length > 20000) {
    CONFIG_CACHE.error = 'experiments_json_too_large';
    return CONFIG_CACHE;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    CONFIG_CACHE.error = err && err.message ? String(err.message) : 'experiments_json_parse_failed';
    return CONFIG_CACHE;
  }

  if (!Array.isArray(parsed)) {
    CONFIG_CACHE.error = 'experiments_json_not_array';
    return CONFIG_CACHE;
  }

  const out = [];
  for (const entry of parsed) {
    const exp = normalizeExperiment(entry);
    if (exp) out.push(exp);
  }
  CONFIG_CACHE.experiments = out;
  return CONFIG_CACHE;
}

function assignExperiments({ requestId } = {}) {
  const cfg = loadExperimentsConfig();
  const experiments = Array.isArray(cfg.experiments) ? cfg.experiments : [];
  if (!experiments.length) return { assignments: [], byKind: {}, ...(cfg.error ? { error: cfg.error } : {}) };

  const assignments = [];
  const byKind = {};
  for (const exp of experiments) {
    const pick = pickVariant({ requestId, experiment: exp });
    const params = pick.variant !== 'holdout' && exp.params && exp.params[pick.variant] ? exp.params[pick.variant] : null;
    const assignment = {
      experiment_id: exp.id,
      kind: exp.kind,
      variant: pick.variant,
      ...(Number.isFinite(pick.bucket) ? { bucket: pick.bucket } : {}),
      ...(Number.isFinite(pick.total) && pick.total ? { rollout_total: pick.total } : {}),
      ...(pick.reason ? { reason: pick.reason } : {}),
      ...(params ? { params } : {}),
    };
    assignments.push(assignment);
    byKind[exp.kind] = assignment;
  }

  return { assignments, byKind, ...(cfg.error ? { error: cfg.error } : {}) };
}

module.exports = {
  assignExperiments,
  loadExperimentsConfig,
  hashToBucket0to99,
};

