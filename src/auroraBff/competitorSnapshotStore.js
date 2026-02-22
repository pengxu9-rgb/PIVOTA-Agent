const crypto = require('crypto');

const MAX_ENTRIES = (() => {
  const n = Number(process.env.AURORA_COMP_SNAPSHOT_MAX_ENTRIES || 1200);
  const v = Number.isFinite(n) ? Math.trunc(n) : 1200;
  return Math.max(100, Math.min(10000, v));
})();

const SOFT_TTL_MS = (() => {
  const n = Number(process.env.AURORA_COMP_SNAPSHOT_SOFT_TTL_MS || 72 * 60 * 60 * 1000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 72 * 60 * 60 * 1000;
  return Math.max(60 * 1000, Math.min(30 * 24 * 60 * 60 * 1000, v));
})();

const HARD_TTL_MS = (() => {
  const n = Number(process.env.AURORA_COMP_SNAPSHOT_HARD_TTL_MS || 14 * 24 * 60 * 60 * 1000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 14 * 24 * 60 * 60 * 1000;
  return Math.max(SOFT_TTL_MS, Math.min(90 * 24 * 60 * 60 * 1000, v));
})();

const BACKFILL_COOLDOWN_MS = (() => {
  const n = Number(process.env.AURORA_COMP_BACKFILL_COOLDOWN_MS || 30 * 60 * 1000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 30 * 60 * 1000;
  return Math.max(10 * 1000, Math.min(24 * 60 * 60 * 1000, v));
})();

const state = {
  entries: new Map(),
  cooldownUntilMs: new Map(),
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToken(value, fallback = '') {
  const token = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return token || fallback;
}

function normalizePriceBand(value) {
  const token = normalizeToken(value, '');
  if (!token) return 'unknown';
  if (token === 'budget' || token === 'mid' || token === 'premium' || token === 'luxury') return token;
  return 'unknown';
}

function canonicalizeProductUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    parsed.hash = '';
    const trackingParams = ['fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid', 'ref', 'ref_src'];
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = String(key || '').toLowerCase();
      if (lower.startsWith('utm_') || trackingParams.includes(lower)) parsed.searchParams.delete(key);
    }
    if (typeof parsed.searchParams.sort === 'function') parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return text;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (!isPlainObject(value)) return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function normalizeCoverage(raw) {
  if (Number.isFinite(Number(raw))) {
    const n = Math.trunc(Number(raw));
    return Math.max(0, Math.min(500, n));
  }
  if (!isPlainObject(raw)) return 0;
  const competitors = Number(raw.competitors || 0);
  const related = Number(raw.related_products || raw.related || 0);
  const dupes = Number(raw.dupes || 0);
  if (Number.isFinite(competitors) || Number.isFinite(related) || Number.isFinite(dupes)) {
    return Math.max(
      0,
      Math.min(
        500,
        Math.trunc(
          Math.max(0, Number.isFinite(competitors) ? competitors : 0) +
            Math.max(0, Number.isFinite(related) ? related : 0) +
            Math.max(0, Number.isFinite(dupes) ? dupes : 0),
        ),
      ),
    );
  }
  return 0;
}

function normalizeConfidence(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'string') {
    const token = normalizeToken(raw, '');
    if (token === 'high') return 0.85;
    if (token === 'med' || token === 'medium') return 0.55;
    if (token === 'low') return 0.25;
  }
  if (isPlainObject(raw)) return normalizeConfidence(raw.score || raw.level);
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n > 1) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}

function touchLru(key, value) {
  state.entries.delete(key);
  state.entries.set(key, value);
  while (state.entries.size > MAX_ENTRIES) {
    const oldest = state.entries.keys().next().value;
    if (!oldest) break;
    state.entries.delete(oldest);
  }
}

function buildSnapshotKey(input = {}) {
  const src = isPlainObject(input) ? input : {};
  const anchorProduct = isPlainObject(src.anchor_product) ? src.anchor_product : {};
  const locale = normalizeToken(src.locale || src.lang || 'en', 'en');
  const surface = normalizeToken(src.surface || 'product_analysis', 'product_analysis');
  const objective = normalizeToken(src.objective || 'competitors', 'competitors');
  const category = normalizeToken(src.category || src.category_taxonomy || src.use_case || '', 'unknown');
  const priceBand = normalizePriceBand(src.price_band || src.priceBand || '');
  const skinFitBucket = normalizeToken(src.skin_fit_bucket || src.skinFitBucket || '', 'unknown');
  const anchorProductId = normalizeToken(
    src.anchor_product_id ||
      src.anchorProductId ||
      anchorProduct.product_id ||
      anchorProduct.productId ||
      anchorProduct.sku_id ||
      anchorProduct.skuId,
    '',
  );
  const normalizedQueryHash = normalizeToken(src.normalized_query_hash || src.query_hash || '', '');
  const normalizedQueryText = normalizeToken(src.normalized_query || src.query || '', '');
  const productUrl = canonicalizeProductUrl(src.product_url || src.productUrl || src.url || '');
  const baseRef = anchorProductId
    ? `anchor:${anchorProductId}`
    : normalizedQueryHash
      ? `query:${normalizedQueryHash}`
      : normalizedQueryText
        ? `query:${sha256(normalizedQueryText).slice(0, 16)}`
        : productUrl
          ? `url:${sha256(productUrl).slice(0, 16)}`
          : '';
  if (!baseRef) return null;
  return [
    'comp_snapshot',
    baseRef,
    `locale:${locale}`,
    `surface:${surface}`,
    `objective:${objective}`,
    `category:${category}`,
    `price:${priceBand}`,
    `skin:${skinFitBucket}`,
  ].join('|');
}

function computeSnapshotAge(meta = {}, nowMs = Date.now()) {
  const createdAtRaw = String(meta.created_at || meta.createdAt || '').trim();
  const createdAtMs = createdAtRaw ? Date.parse(createdAtRaw) : 0;
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
  return Math.max(0, nowMs - createdAtMs);
}

function shouldUseStaleSnapshot(meta = {}, nowMs = Date.now()) {
  const ageMs = computeSnapshotAge(meta, nowMs);
  if (ageMs == null) {
    return {
      usable: true,
      stale: false,
      very_stale: false,
      age_ms: null,
      age_sec: null,
      soft_ttl_ms: SOFT_TTL_MS,
      hard_ttl_ms: HARD_TTL_MS,
    };
  }
  const stale = ageMs > SOFT_TTL_MS;
  const veryStale = ageMs > HARD_TTL_MS;
  return {
    usable: true,
    stale,
    very_stale: veryStale,
    age_ms: ageMs,
    age_sec: Math.trunc(ageMs / 1000),
    soft_ttl_ms: SOFT_TTL_MS,
    hard_ttl_ms: HARD_TTL_MS,
  };
}

function sanitizeSnapshotPayload(payload) {
  if (!isPlainObject(payload)) return { competitors: [] };
  const competitors = Array.isArray(payload.competitors) ? payload.competitors : [];
  const related = Array.isArray(payload.related_products) ? payload.related_products : [];
  const dupes = Array.isArray(payload.dupes) ? payload.dupes : [];
  return {
    competitors: competitors.filter((row) => isPlainObject(row)).slice(0, 12),
    related_products: related.filter((row) => isPlainObject(row)).slice(0, 12),
    dupes: dupes.filter((row) => isPlainObject(row)).slice(0, 12),
    ...(Array.isArray(payload.competitor_queries)
      ? { competitor_queries: payload.competitor_queries.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8) }
      : {}),
  };
}

function sanitizeSnapshotMeta(meta, payload) {
  const src = isPlainObject(meta) ? meta : {};
  const nowIso = new Date().toISOString();
  return {
    created_at: String(src.created_at || src.createdAt || nowIso),
    source: normalizeToken(src.source || 'unknown', 'unknown'),
    ranker_version: String(src.ranker_version || src.rankerVersion || 'reco_blocks_dag.v1').trim() || 'reco_blocks_dag.v1',
    coverage: normalizeCoverage(src.coverage != null ? src.coverage : {
      competitors: Array.isArray(payload?.competitors) ? payload.competitors.length : 0,
      related_products: Array.isArray(payload?.related_products) ? payload.related_products.length : 0,
      dupes: Array.isArray(payload?.dupes) ? payload.dupes.length : 0,
    }),
    confidence: normalizeConfidence(src.confidence),
    reason_flags: Array.from(new Set((Array.isArray(src.reason_flags) ? src.reason_flags : [])
      .map((x) => normalizeToken(x, ''))
      .filter(Boolean))).slice(0, 12),
  };
}

function scoreForReplace(meta = {}) {
  const coverage = normalizeCoverage(meta.coverage);
  const confidence = normalizeConfidence(meta.confidence);
  const ageMs = computeSnapshotAge(meta, Date.now());
  const freshnessBoost = ageMs == null ? 0.05 : Math.max(0, Math.min(0.1, (HARD_TTL_MS - Math.max(0, ageMs)) / HARD_TTL_MS));
  return coverage * 0.8 + confidence * 10 + freshnessBoost;
}

function readSnapshot(key, { nowMs = Date.now() } = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    return {
      hit: false,
      key: null,
      payload: null,
      meta: null,
      stale: false,
      very_stale: false,
      usable: false,
      age_ms: null,
      age_sec: null,
    };
  }
  const entry = state.entries.get(normalizedKey);
  if (!entry || !isPlainObject(entry)) {
    return {
      hit: false,
      key: normalizedKey,
      payload: null,
      meta: null,
      stale: false,
      very_stale: false,
      usable: false,
      age_ms: null,
      age_sec: null,
    };
  }
  const freshness = shouldUseStaleSnapshot(entry.meta, nowMs);
  touchLru(normalizedKey, entry);
  return {
    hit: true,
    key: normalizedKey,
    payload: sanitizeSnapshotPayload(entry.payload),
    meta: { ...entry.meta, snapshot_age_sec: freshness.age_sec },
    stale: freshness.stale,
    very_stale: freshness.very_stale,
    usable: freshness.usable,
    age_ms: freshness.age_ms,
    age_sec: freshness.age_sec,
    soft_ttl_ms: freshness.soft_ttl_ms,
    hard_ttl_ms: freshness.hard_ttl_ms,
  };
}

function canEnqueueBackfill(key, { nowMs = Date.now() } = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return false;
  const until = Number(state.cooldownUntilMs.get(normalizedKey) || 0);
  return !Number.isFinite(until) || until <= nowMs;
}

function markBackfillCooldown(key, { nowMs = Date.now() } = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return 0;
  const until = nowMs + BACKFILL_COOLDOWN_MS;
  state.cooldownUntilMs.set(normalizedKey, until);
  return until;
}

function writeSnapshot(key, payload, meta = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return { ok: false, written: false, reason: 'key_missing' };
  const safePayload = sanitizeSnapshotPayload(payload);
  const safeMeta = sanitizeSnapshotMeta(meta, safePayload);
  const existing = state.entries.get(normalizedKey);
  if (existing && isPlainObject(existing)) {
    const nextScore = scoreForReplace(safeMeta);
    const prevScore = scoreForReplace(existing.meta);
    const nextCreatedMs = Date.parse(String(safeMeta.created_at || ''));
    const prevCreatedMs = Date.parse(String(existing?.meta?.created_at || ''));
    const coverageImproved = normalizeCoverage(safeMeta.coverage) > normalizeCoverage(existing?.meta?.coverage);
    const confidenceImproved = normalizeConfidence(safeMeta.confidence) > normalizeConfidence(existing?.meta?.confidence);
    const newer = Number.isFinite(nextCreatedMs) && Number.isFinite(prevCreatedMs) ? nextCreatedMs >= prevCreatedMs : true;
    if (!coverageImproved && !confidenceImproved && !newer && nextScore < prevScore) {
      return { ok: true, written: false, reason: 'cas_not_better' };
    }
  }
  touchLru(normalizedKey, { payload: safePayload, meta: safeMeta });
  return { ok: true, written: true, reason: 'written' };
}

function resetForTest() {
  state.entries.clear();
  state.cooldownUntilMs.clear();
}

function snapshotStats() {
  return {
    size: state.entries.size,
    cooldown_size: state.cooldownUntilMs.size,
    soft_ttl_ms: SOFT_TTL_MS,
    hard_ttl_ms: HARD_TTL_MS,
    backfill_cooldown_ms: BACKFILL_COOLDOWN_MS,
  };
}

module.exports = {
  buildSnapshotKey,
  readSnapshot,
  writeSnapshot,
  shouldUseStaleSnapshot,
  canEnqueueBackfill,
  markBackfillCooldown,
  __internal: {
    canonicalizeProductUrl,
    stableStringify,
    sha256,
    normalizeCoverage,
    normalizeConfidence,
    sanitizeSnapshotMeta,
    sanitizeSnapshotPayload,
    snapshotStats,
    resetForTest,
  },
};
