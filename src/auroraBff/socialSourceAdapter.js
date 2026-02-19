const axios = require('axios');
const crypto = require('crypto');
const {
  extractWhitelistedSocialChannels,
  normalizeSocialChannel,
  SOCIAL_CHANNEL_WHITELIST,
} = require('./socialSummaryUserVisible');

const DEFAULT_CHANNELS = Array.isArray(SOCIAL_CHANNEL_WHITELIST) && SOCIAL_CHANNEL_WHITELIST.length
  ? SOCIAL_CHANNEL_WHITELIST.slice(0, 5)
  : ['reddit', 'xiaohongshu', 'tiktok', 'youtube', 'instagram'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseBool(value, fallback = false) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on';
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  const out = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, out));
}

function normalizeLang(raw) {
  return String(raw || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function normalizeBaseUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

function normalizePath(rawPath) {
  const text = String(rawPath || '').trim();
  if (!text) return '/v1/social/signals';
  if (text.startsWith('/')) return text;
  return `/${text}`;
}

function normalizeChannels(raw) {
  const rows = Array.isArray(raw)
    ? raw
    : String(raw || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const item of rows) {
    const normalized = normalizeSocialChannel(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 5) break;
  }
  if (out.length) return out;
  return DEFAULT_CHANNELS.slice(0, 5);
}

function buildSocialSourceConfig(env = process.env) {
  return {
    enabled: parseBool(env.AURORA_BFF_SOCIAL_SOURCE_ENABLED, true),
    base_url: normalizeBaseUrl(env.AURORA_BFF_SOCIAL_SOURCE_BASE_URL),
    api_key: String(env.AURORA_BFF_SOCIAL_SOURCE_API_KEY || '').trim(),
    path: normalizePath(env.AURORA_BFF_SOCIAL_SOURCE_PATH),
    timeout_ms: clampInt(env.AURORA_BFF_SOCIAL_SOURCE_TIMEOUT_MS, 1800, 180, 12000),
    ttl_ms: clampInt(env.AURORA_BFF_SOCIAL_SOURCE_TTL_MS, 72 * 60 * 60 * 1000, 5 * 60 * 1000, 14 * 24 * 60 * 60 * 1000),
    concurrency: clampInt(env.AURORA_BFF_SOCIAL_SOURCE_CONCURRENCY, 8, 1, 64),
    rate_per_min: clampInt(env.AURORA_BFF_SOCIAL_SOURCE_RATE_PER_MIN, 120, 1, 5000),
    channels: normalizeChannels(env.AURORA_BFF_SOCIAL_SOURCE_CHANNELS || DEFAULT_CHANNELS),
    source_version: String(env.AURORA_BFF_SOCIAL_SOURCE_VERSION || 'social_source_adapter.v1').trim() || 'social_source_adapter.v1',
  };
}

function createSemaphore(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let inUse = 0;
  const queue = [];
  async function acquire() {
    if (inUse < max) {
      inUse += 1;
      return () => {
        inUse = Math.max(0, inUse - 1);
        const next = queue.shift();
        if (next) next();
      };
    }
    return new Promise((resolve) => {
      queue.push(() => {
        inUse += 1;
        resolve(() => {
          inUse = Math.max(0, inUse - 1);
          const next = queue.shift();
          if (next) next();
        });
      });
    });
  }
  return { acquire };
}

function createTokenBucket(ratePerMin) {
  const rate = Math.max(1, Number(ratePerMin) || 120);
  let tokens = rate;
  let lastTs = Date.now();
  function take() {
    const now = Date.now();
    const elapsed = Math.max(0, now - lastTs);
    const refill = (elapsed * rate) / 60000;
    tokens = Math.min(rate, tokens + refill);
    lastTs = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }
  return { take };
}

function sanitizeText(value, max = 180) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.slice(0, Math.max(16, max));
}

function stableStringify(value) {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((x) => stableStringify(x)).join(',')}]`;
  }
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function buildSocialInputHash(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function normalizeScore(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n <= 1) return Number(n.toFixed(3));
  if (n <= 100) return Number((n / 100).toFixed(3));
  return 1;
}

function normalizeTimeWindow(raw) {
  const obj = isPlainObject(raw) ? raw : null;
  if (!obj) return undefined;
  const from = sanitizeText(obj.from || obj.start || obj.start_at, 64);
  const to = sanitizeText(obj.to || obj.end || obj.end_at, 64);
  if (!from || !to) return undefined;
  return { from, to };
}

function collectKeywords(raw) {
  const obj = isPlainObject(raw) ? raw : {};
  const merged = [
    ...(Array.isArray(obj.topic_keywords) ? obj.topic_keywords : []),
    ...(Array.isArray(obj.top_keywords) ? obj.top_keywords : []),
    ...(Array.isArray(obj.keywords) ? obj.keywords : []),
    ...(Array.isArray(obj.top_topics) ? obj.top_topics.map((x) => (isPlainObject(x) ? x.topic || x.name : x)) : []),
  ];
  const out = [];
  const seen = new Set();
  for (const value of merged) {
    const token = sanitizeText(value, 42);
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= 10) break;
  }
  return out;
}

function buildSocialCandidateKey(candidate, index = 0) {
  const row = isPlainObject(candidate) ? candidate : {};
  const ref = sanitizeText(
    row.candidate_key ||
      row.candidateKey ||
      row.product_id ||
      row.productId ||
      row.sku_id ||
      row.skuId ||
      row.url ||
      row.name ||
      row.display_name ||
      `idx:${index}`,
    220,
  );
  return ref.toLowerCase();
}

function buildCandidateLookup(candidates) {
  const lookup = new Map();
  for (let i = 0; i < (Array.isArray(candidates) ? candidates : []).length; i += 1) {
    const row = candidates[i];
    const key = buildSocialCandidateKey(row, i);
    if (!key) continue;
    if (!lookup.has(key)) lookup.set(key, key);

    const productId = sanitizeText(row?.product_id || row?.productId, 220).toLowerCase();
    const skuId = sanitizeText(row?.sku_id || row?.skuId, 220).toLowerCase();
    const url = sanitizeText(row?.url || row?.source?.url, 240).toLowerCase();
    const name = sanitizeText(row?.name || row?.display_name, 220).toLowerCase();
    for (const alias of [productId, skuId, url, name]) {
      if (!alias) continue;
      if (!lookup.has(alias)) lookup.set(alias, key);
    }
  }
  return lookup;
}

function normalizeSignalItem(raw, lookup) {
  const obj = isPlainObject(raw) ? raw : null;
  if (!obj) return null;
  const lookupKey = [
    obj.candidate_key,
    obj.candidateKey,
    obj.key,
    obj.product_id,
    obj.productId,
    obj.sku_id,
    obj.skuId,
    obj.url,
    obj.name,
    obj.display_name,
    obj.displayName,
  ]
    .map((x) => sanitizeText(x, 240).toLowerCase())
    .find(Boolean);
  const canonicalKey = lookupKey && lookup.has(lookupKey) ? lookup.get(lookupKey) : null;
  if (!canonicalKey) return null;

  const channels = extractWhitelistedSocialChannels(obj);
  const topicKeywords = collectKeywords(obj);
  const coMention = normalizeScore(obj.co_mention_strength ?? obj.coMentionStrength ?? obj.strength ?? obj.score);
  const sentiment = normalizeScore(obj.sentiment_proxy ?? obj.sentiment ?? obj.sentimentScore);
  const contextMatch = normalizeScore(obj.context_match ?? obj.contextMatch);
  const timeWindow = normalizeTimeWindow(obj.time_window || obj.timeWindow);

  if (
    channels.length === 0 &&
    topicKeywords.length === 0 &&
    coMention == null &&
    sentiment == null &&
    contextMatch == null
  ) {
    return null;
  }

  return {
    key: canonicalKey,
    value: {
      ...(coMention != null ? { co_mention_strength: coMention } : {}),
      ...(topicKeywords.length ? { topic_keywords: topicKeywords } : {}),
      ...(sentiment != null ? { sentiment_proxy: sentiment } : {}),
      ...(contextMatch != null ? { context_match: contextMatch } : {}),
      ...(channels.length ? { channels } : {}),
      ...(timeWindow ? { time_window: timeWindow } : {}),
    },
  };
}

function normalizeSocialResponse(data, candidates) {
  const body = isPlainObject(data) ? data : {};
  const lookup = buildCandidateLookup(candidates);
  const signalsByKey = {};

  const signalItems = [];
  if (Array.isArray(body.signals)) signalItems.push(...body.signals);
  if (Array.isArray(body.results)) signalItems.push(...body.results);
  if (Array.isArray(body.candidates)) signalItems.push(...body.candidates);
  if (Array.isArray(body.items)) signalItems.push(...body.items);
  const mapSignals = isPlainObject(body.signals_by_candidate) ? body.signals_by_candidate : null;
  if (mapSignals) {
    for (const [key, value] of Object.entries(mapSignals)) {
      signalItems.push({
        candidate_key: key,
        ...(isPlainObject(value) ? value : {}),
      });
    }
  }

  for (const item of signalItems) {
    const normalized = normalizeSignalItem(item, lookup);
    if (!normalized) continue;
    const prev = isPlainObject(signalsByKey[normalized.key]) ? signalsByKey[normalized.key] : {};
    signalsByKey[normalized.key] = {
      ...prev,
      ...normalized.value,
      channels: extractWhitelistedSocialChannels({
        channels: [
          ...(Array.isArray(prev.channels) ? prev.channels : []),
          ...(Array.isArray(normalized.value.channels) ? normalized.value.channels : []),
        ],
      }),
      topic_keywords: Array.from(
        new Set(
          [
            ...(Array.isArray(prev.topic_keywords) ? prev.topic_keywords : []),
            ...(Array.isArray(normalized.value.topic_keywords) ? normalized.value.topic_keywords : []),
          ]
            .map((x) => sanitizeText(x, 42))
            .filter(Boolean),
        ),
      ).slice(0, 10),
    };
  }

  const channelsUsed = extractWhitelistedSocialChannels({
    channels: [
      ...(Array.isArray(body.social_channels_used) ? body.social_channels_used : []),
      ...Object.values(signalsByKey).flatMap((x) => (Array.isArray(x?.channels) ? x.channels : [])),
    ],
  });

  return {
    signals_by_key: signalsByKey,
    channels_used: channelsUsed,
    source_version: sanitizeText(body.source_version || body.version || body.sourceVersion, 80) || null,
  };
}

function sanitizeEvidenceRefs(candidate) {
  const refs = Array.isArray(candidate?.evidence_refs) ? candidate.evidence_refs : [];
  const out = [];
  for (const item of refs) {
    if (!isPlainObject(item)) continue;
    const display = sanitizeText(item.display_text || item.excerpt || item.id, 180);
    if (!display) continue;
    out.push(display);
    if (out.length >= 4) break;
  }
  return out;
}

function sanitizeCandidateForRequest(candidate, index) {
  const row = isPlainObject(candidate) ? candidate : {};
  const reasons = Array.isArray(row?.why_candidate?.reasons_user_visible)
    ? row.why_candidate.reasons_user_visible
    : Array.isArray(row.why_candidate)
      ? row.why_candidate
      : [];
  const social = isPlainObject(row.social_summary_user_visible) ? row.social_summary_user_visible : {};
  return {
    candidate_key: buildSocialCandidateKey(row, index),
    product_id: sanitizeText(row.product_id || row.productId, 120) || null,
    sku_id: sanitizeText(row.sku_id || row.skuId, 120) || null,
    brand: sanitizeText(row.brand, 120) || null,
    name: sanitizeText(row.name || row.display_name || row.displayName, 180) || null,
    category: sanitizeText(row.category || row.category_taxonomy || row.categoryTaxonomy, 120) || null,
    price_band: sanitizeText(row.price_band || row.priceBand, 32) || null,
    source_type: sanitizeText(row?.source?.type || row.source_type || row.sourceType, 64) || null,
    why_summary: sanitizeText(row?.why_candidate?.summary, 180) || null,
    reasons_user_visible: reasons.map((x) => sanitizeText(x, 160)).filter(Boolean).slice(0, 3),
    social_summary_user_visible: {
      themes: Array.isArray(social.themes) ? social.themes.map((x) => sanitizeText(x, 64)).filter(Boolean).slice(0, 3) : [],
      top_keywords: Array.isArray(social.top_keywords)
        ? social.top_keywords.map((x) => sanitizeText(x, 42)).filter(Boolean).slice(0, 6)
        : [],
      sentiment_hint: sanitizeText(social.sentiment_hint, 180) || null,
      volume_bucket: sanitizeText(social.volume_bucket, 24) || null,
    },
    evidence_display: sanitizeEvidenceRefs(row),
  };
}

function sanitizeAnchorForRequest(anchor) {
  const row = isPlainObject(anchor) ? anchor : {};
  return {
    product_id: sanitizeText(row.product_id || row.productId || row.sku_id || row.skuId, 120) || null,
    brand: sanitizeText(row.brand || row.brand_name || row.brandName || row.brand_id || row.brandId, 120) || null,
    name: sanitizeText(row.name || row.display_name || row.displayName, 180) || null,
    category: sanitizeText(row.category || row.category_taxonomy || row.categoryTaxonomy, 120) || null,
    price_band: sanitizeText(row.price_band || row.priceBand, 32) || null,
    use_case: sanitizeText(row.use_case || row.useCase, 120) || null,
    ingredients: Array.isArray(row.ingredient_tokens)
      ? row.ingredient_tokens.map((x) => sanitizeText(x, 64)).filter(Boolean).slice(0, 20)
      : [],
    skin_fit: Array.isArray(row.profile_skin_tags)
      ? row.profile_skin_tags.map((x) => sanitizeText(x, 64)).filter(Boolean).slice(0, 12)
      : [],
  };
}

const runtime = {
  semaphore: createSemaphore(buildSocialSourceConfig(process.env).concurrency),
  bucket: createTokenBucket(buildSocialSourceConfig(process.env).rate_per_min),
};

async function fetchCrossPlatformSocialSignals({
  anchor,
  candidates,
  lang = 'EN',
  channels,
  timeoutMs,
  logger,
} = {}) {
  const config = buildSocialSourceConfig(process.env);
  if (!config.enabled) {
    return { ok: false, reason: 'disabled', signals_by_key: {}, channels_used: [], source_version: config.source_version };
  }
  if (!config.base_url) {
    return { ok: false, reason: 'not_configured', signals_by_key: {}, channels_used: [], source_version: config.source_version };
  }
  const rows = Array.isArray(candidates) ? candidates : [];
  if (!rows.length) {
    return { ok: false, reason: 'empty_candidates', signals_by_key: {}, channels_used: [], source_version: config.source_version };
  }

  const requestPayload = {
    anchor: sanitizeAnchorForRequest(anchor),
    candidates: rows.map((row, idx) => sanitizeCandidateForRequest(row, idx)),
    lang: normalizeLang(lang),
    channels: normalizeChannels(channels || config.channels),
    request_meta: {
      source: 'aurora_bff',
      source_version: config.source_version,
    },
  };
  const inputHash = buildSocialInputHash(requestPayload);

  if (!runtime.bucket.take()) {
    return {
      ok: false,
      reason: 'rate_limited',
      input_hash: inputHash,
      signals_by_key: {},
      channels_used: [],
      source_version: config.source_version,
    };
  }

  const release = await runtime.semaphore.acquire();
  const startedAt = Date.now();
  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (config.api_key) {
      headers['X-API-Key'] = config.api_key;
      headers.Authorization = `Bearer ${config.api_key}`;
    }
    const url = `${config.base_url}${config.path}`;
    const resp = await axios.post(url, requestPayload, {
      timeout: clampInt(timeoutMs, config.timeout_ms, 120, 12000),
      headers,
      validateStatus: (status) => status >= 200 && status < 500,
    });
    if (Number(resp?.status) >= 400) {
      return {
        ok: false,
        reason: `upstream_${Math.trunc(Number(resp.status) || 0)}`,
        input_hash: inputHash,
        signals_by_key: {},
        channels_used: [],
        source_version: config.source_version,
        latency_ms: Date.now() - startedAt,
      };
    }
    const normalized = normalizeSocialResponse(resp?.data, rows);
    return {
      ok: true,
      reason: null,
      input_hash: inputHash,
      signals_by_key: normalized.signals_by_key,
      channels_used: normalized.channels_used,
      source_version: normalized.source_version || config.source_version,
      latency_ms: Date.now() - startedAt,
    };
  } catch (err) {
    const code = String(err?.code || '').toUpperCase();
    const timeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT';
    logger?.warn?.(
      {
        err: err?.message || String(err),
        timeout,
      },
      'aurora bff: social source adapter fetch failed',
    );
    return {
      ok: false,
      reason: timeout ? 'timeout' : 'upstream_error',
      input_hash: inputHash,
      signals_by_key: {},
      channels_used: [],
      source_version: config.source_version,
      latency_ms: Date.now() - startedAt,
    };
  } finally {
    release();
  }
}

module.exports = {
  DEFAULT_SOCIAL_SOURCE_CHANNELS: DEFAULT_CHANNELS,
  buildSocialSourceConfig,
  buildSocialInputHash,
  buildSocialCandidateKey,
  fetchCrossPlatformSocialSignals,
  __internal: {
    normalizeSocialResponse,
    sanitizeCandidateForRequest,
    sanitizeAnchorForRequest,
    normalizeChannels,
  },
};
