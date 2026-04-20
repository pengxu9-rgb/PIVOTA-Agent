const { query: defaultQuery } = require('../db');
const { buildExternalSeedBrandSearchProduct } = require('../services/externalSeedProducts');
const { EXTERNAL_SEED_RECALL_SQL_FIELDS } = require('../services/externalSeedRecall');

const DEFAULT_LIMIT = 6;
const ROLE_ORDER = [
  'sun_protection',
  'lightweight_moisturizer',
  'hydration_serum',
  'recovery_mask',
  'body_lip_hand',
  'cleanser',
  'eye_care',
];

const ROLE_CONFIGS = {
  sun_protection: {
    label: 'Sun protection',
    categories: ['sunscreen'],
    terms: ['sunscreen', 'spf', 'spf50', 'spf 50', 'uv', 'sun fluid', 'sun cream', 'sun stick'],
  },
  lightweight_moisturizer: {
    label: 'Lightweight moisturizer',
    categories: ['moisturizer'],
    terms: ['gel cream', 'gel-cream', 'lightweight moisturizer', 'barrier cream', 'moisturizer', 'lotion'],
  },
  hydration_serum: {
    label: 'Hydrating serum or essence',
    categories: ['serum', 'essence'],
    terms: ['hydrating serum', 'hydration serum', 'hyaluronic', 'essence', 'ampoule'],
  },
  recovery_mask: {
    label: 'Hydrating or soothing mask',
    categories: ['hydrating mask', 'mask', 'treatment'],
    terms: ['hydrating mask', 'soothing mask', 'sheet mask', 'repair mask', 'post sun mask'],
  },
  body_lip_hand: {
    label: 'Body, lip, or hand support',
    categories: ['body sunscreen', 'body lotion', 'lip balm', 'hand cream'],
    terms: ['body sunscreen', 'body lotion', 'after sun body gel', 'lip balm', 'hand cream'],
  },
  cleanser: {
    label: 'Cleanser',
    categories: ['cleanser'],
    terms: ['gentle cleanser', 'cleansing oil', 'cleansing balm', 'face wash'],
  },
  eye_care: {
    label: 'Eye care',
    categories: ['eye cream', 'eye patch'],
    terms: ['eye cream', 'cooling eye patch', 'eye patches', 'caffeine eye'],
  },
};

const COLOR_COSMETIC_NOISE_RE =
  /\b(match\s*stix|correcting\s*skinstick|corrector|concealer|foundation|skin\s*tint|bronzer|contour|blush|highlighter|illuminator|mascara|eyeshadow|eye\s*shadow|brow\s*(?:pencil|gel|definer|styler)|lipstick|lip\s*gloss|lip\s*color|lip\s*colour|cheeks\s*out|killawatt)\b/i;
const BEAUTY_TOOL_NOISE_RE =
  /\b(reusable|silicone|applicator|beauty\s*sponge|makeup\s*sponge|sponge|puff|brush|tool)\b/i;
const REFILL_ONLY_NOISE_RE = /\brefills?\b/i;
const LIP_CARE_NOISE_RE = /\b(lip[-\s]?loving\s*scrub|scrubstick|lip\s*scrub|exfoliat(?:e|ing|or)|plumper)\b/i;
const MARKET_EXPECTED_CURRENCY = {
  CN: 'CNY',
  FR: 'EUR',
  GB: 'GBP',
  JP: 'JPY',
  KR: 'KRW',
  SG: 'SGD',
  TH: 'THB',
  US: 'USD',
};
const STRONG_ROLE_MATCHERS = {
  sun_protection: /\b(sunscreen|sun\s*screen|spf\s*\d{0,3}\+?|pa\s*\+{2,4}|broad\s*spectrum|sun\s*(?:fluid|cream|gel|milk|stick|serum)|uv\s*(?:protection|shield|defen[cs]e|aqua|essence)|日焼け止め|防晒|防曬|선크림|썬크림)\b/i,
  lightweight_moisturizer: /\b(moisturi[sz]er|gel[-\s]?cream|barrier\s*cream|face\s*cream|facial\s*cream|lotion|emulsion|milk|乳液|面霜|保湿|保濕|크림|로션)\b/i,
  hydration_serum: /\b(serum|essence|ampoule|hyaluronic|hydrating|hydration|精华|精華|安瓶|エッセンス|美容液|세럼|앰플|에센스)\b/i,
  recovery_mask: /\b((?:hydrating|soothing|repair|recovery|post[-\s]?sun|cica|sheet|sleeping|hydrogel).{0,40}mask|mask.{0,40}(?:hydrating|soothing|repair|recovery|post[-\s]?sun|cica|sheet|sleeping|hydrogel)|面膜|マスク|팩)\b/i,
  body_lip_hand: /\b(body\s*(?:sunscreen|lotion|cream|gel|milk)|hand\s*cream|lip\s*(?:balm|treatment|spf)|润唇|潤唇|护手|護手|ハンドクリーム|リップ(?:クリーム|バーム)|핸드\s*크림|립\s*(?:밤|케어))\b/i,
  cleanser: /\b(cleanser|cleansing|face\s*wash|facial\s*wash|cleansing\s*(?:oil|balm|gel|foam|milk)|卸妆|卸妝|洁面|潔面|洗顔|クレンジング|클렌저|클렌징)\b/i,
  eye_care: /\b(eye\s*(?:cream|serum|gel|patch|patches|mask|masks)|caffeine|depuff|眼霜|眼贴|眼貼|アイクリーム|アイパッチ|아이\s*(?:크림|패치))\b/i,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value, maxLen = 220) {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  return text.slice(0, maxLen);
}

function normalizeMarket(value) {
  const text = normalizeText(value, 8).toUpperCase();
  return /^[A-Z]{2}$/.test(text) ? text : '';
}

function uniqStrings(values, max = 24) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeText(value, 120);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function resolveTravelLocalMarket({ destination, destinationPlace } = {}) {
  const place = isPlainObject(destinationPlace) ? destinationPlace : {};
  const countryCode = normalizeMarket(place.country_code || place.countryCode);
  if (countryCode) return { market: countryCode, source: 'destination_place_country_code' };

  const countryText = [
    place.country,
    place.country_name,
    place.label,
    place.canonical_name,
    destination,
  ].map((value) => normalizeText(value, 160).toLowerCase()).filter(Boolean).join(' ');

  const matchers = [
    ['CN', /\b(china|prc|shanghai|beijing|guangzhou|shenzhen|chengdu|hangzhou)\b|中国|上海|北京|广州|深圳|成都|杭州/i],
    ['KR', /\b(korea|south korea|seoul|busan)\b|韩国|南韩|首尔|首爾|釜山/i],
    ['JP', /\b(japan|tokyo|osaka|kyoto)\b|日本|东京|東京|大阪|京都/i],
    ['SG', /\b(singapore)\b|新加坡/i],
    ['TH', /\b(thailand|bangkok)\b|泰国|泰國|曼谷/i],
    ['FR', /\b(france|paris)\b|法国|法國|巴黎/i],
    ['GB', /\b(united kingdom|uk|london|england)\b|英国|英國|伦敦|倫敦/i],
    ['US', /\b(united states|usa|u\.s\.|new york|los angeles|seattle|san francisco)\b|美国|美國|西雅图|西雅圖/i],
  ];
  for (const [market, pattern] of matchers) {
    if (pattern.test(countryText)) return { market, source: 'destination_text' };
  }
  return { market: '', source: 'unresolved' };
}

function inferRoleIdFromText(value) {
  const text = normalizeText(value, 240).toLowerCase();
  if (!text) return '';
  if (/\b(lip|hand|body|身体|身體|润唇|潤唇|护手|護手)\b/i.test(text)) return 'body_lip_hand';
  if (/\b(spf|sunscreen|sun\s*(?:screen|fluid|cream|stick)|uv|防晒)\b/i.test(text)) return 'sun_protection';
  if (/\b(gel[-\s]?cream|moisturi[sz]er|barrier cream|cream|lotion|面霜|乳液)\b/i.test(text)) return 'lightweight_moisturizer';
  if (/\b(mask|sheet mask|after[-\s]?sun|post[-\s]?sun|soothing|面膜|晒后|曬後)\b/i.test(text)) return 'recovery_mask';
  if (/\b(serum|essence|ampoule|hyaluronic|hydrating|补水|精华|精華|安瓶)\b/i.test(text)) return 'hydration_serum';
  if (/\b(cleanser|cleansing|face wash|卸妆|卸妝|洁面|潔面)\b/i.test(text)) return 'cleanser';
  if (/\b(eye|caffeine|depuff|眼霜|眼贴|眼貼)\b/i.test(text)) return 'eye_care';
  return '';
}

function buildTravelLocalProductQueryPlan({ travelReadiness, message, limit = DEFAULT_LIMIT } = {}) {
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {};
  const bundleRows = Array.isArray(readiness.reco_bundle) ? readiness.reco_bundle : [];
  const roleScores = new Map();
  const rawHints = [];

  const addRole = (roleId, score = 1) => {
    if (!ROLE_CONFIGS[roleId]) return;
    roleScores.set(roleId, (roleScores.get(roleId) || 0) + score);
  };

  for (const row of bundleRows) {
    if (!isPlainObject(row)) continue;
    const texts = [
      row.trigger,
      row.action,
      row.ingredient_logic,
      ...(Array.isArray(row.product_types) ? row.product_types : []),
    ];
    for (const text of texts) {
      const clean = normalizeText(text, 180);
      if (!clean) continue;
      rawHints.push(clean);
      addRole(inferRoleIdFromText(clean), 2);
    }
  }

  const messageText = normalizeText(message, 500);
  if (messageText) {
    rawHints.push(messageText);
    addRole(inferRoleIdFromText(messageText), 1);
  }

  addRole('sun_protection', 1);
  addRole('lightweight_moisturizer', 1);
  addRole('hydration_serum', 1);

  const roles = ROLE_ORDER
    .map((roleId) => ({ role_id: roleId, score: roleScores.get(roleId) || 0 }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || ROLE_ORDER.indexOf(a.role_id) - ROLE_ORDER.indexOf(b.role_id))
    .slice(0, Math.max(2, Math.min(6, Number(limit) || DEFAULT_LIMIT)))
    .map((row) => {
      const config = ROLE_CONFIGS[row.role_id];
      const textHints = rawHints.filter((hint) => inferRoleIdFromText(hint) === row.role_id).slice(0, 4);
      return {
        role_id: row.role_id,
        label: config.label,
        categories: uniqStrings(config.categories, 6),
        terms: uniqStrings([...textHints, ...config.terms], 12),
      };
    });

  return roles;
}

function likePatterns(values, max = 16) {
  return uniqStrings(values, max)
    .map((value) => value.toLowerCase().replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((value) => value.length >= 3)
    .map((value) => `%${value}%`);
}

function buildSeedSelectSql() {
  return [
    'id',
    'market',
    'tool',
    'status',
    'domain',
    'external_product_id',
    'canonical_url',
    'destination_url',
    'title',
    'image_url',
    'price_amount',
    'price_currency',
    'availability',
    'attached_product_key',
    'seed_data',
    'created_at',
    'updated_at',
  ].join(',\n');
}

function scoreProductForRole(product, roleId) {
  const config = ROLE_CONFIGS[roleId] || {};
  const haystack = [
    product?.title,
    product?.name,
    product?.brand,
    product?.category,
    product?.product_type,
    product?.description,
  ].map((value) => normalizeText(value, 220).toLowerCase()).join(' ');
  let score = 0;
  for (const category of config.categories || []) {
    if (haystack.includes(String(category).toLowerCase())) score += 8;
  }
  for (const term of config.terms || []) {
    const token = String(term || '').toLowerCase();
    if (token && haystack.includes(token)) score += 3;
  }
  if (product?.image_url) score += 1;
  if (Number(product?.price || 0) > 0) score += 1;
  return score;
}

function productAuthorityText(product) {
  const recall = isPlainObject(product?.external_seed_recall) ? product.external_seed_recall : {};
  const aliases = Array.isArray(recall.alias_tokens)
    ? recall.alias_tokens
    : Array.isArray(recall.aliases)
      ? recall.aliases
      : [];
  return [
    product?.title,
    product?.name,
    product?.brand,
    product?.category,
    product?.product_type,
    product?.description,
    recall.retrieval_title,
    recall.retrieval_summary,
    recall.category,
    recall.vertical,
    ...aliases,
  ].map((value) => normalizeText(value, 260).toLowerCase()).filter(Boolean).join(' ');
}

function hasStrongRoleMatch(product, roleId) {
  const matcher = STRONG_ROLE_MATCHERS[roleId];
  if (!matcher) return true;
  return matcher.test(productAuthorityText(product));
}

function isRoleCompatibleProduct(product, roleId) {
  const text = productAuthorityText(product);
  if (!text) return false;
  if (!hasStrongRoleMatch(product, roleId)) return false;
  if (REFILL_ONLY_NOISE_RE.test(text)) return false;
  if (BEAUTY_TOOL_NOISE_RE.test(text)) return false;

  if (roleId === 'body_lip_hand') {
    if (LIP_CARE_NOISE_RE.test(text)) return false;
    if (/\b(lipstick|lip\s*gloss|lip\s*color|lip\s*colour)\b/i.test(text)) return false;
    return true;
  }

  if (COLOR_COSMETIC_NOISE_RE.test(text)) return false;
  return true;
}

function isMarketCurrencyCompatibleProduct(product, market) {
  const expected = MARKET_EXPECTED_CURRENCY[normalizeMarket(market)];
  if (!expected) return true;
  const currency = normalizeText(product?.currency, 12).toUpperCase();
  if (!currency) return true;
  return currency === expected;
}

function normalizeAuthorityCandidate(product, role) {
  if (!product || !role) return null;
  const name = normalizeText(product.title || product.name, 140);
  if (!name) return null;
  const brand = normalizeText(product.brand || product.vendor, 80);
  const category = normalizeText(product.category || product.product_type || role.label, 80);
  return {
    product_id: normalizeText(product.product_id || product.id, 120) || null,
    display_name: name,
    name,
    brand: brand || null,
    category: category || role.label,
    step: role.label,
    price: Number.isFinite(Number(product.price)) && Number(product.price) > 0 ? Number(product.price) : null,
    currency: normalizeText(product.currency, 12) || null,
    image_url: normalizeText(product.image_url, 500) || null,
    canonical_url: normalizeText(product.canonical_url || product.url || product.destination_url, 500) || null,
    pdp_open: product.product_id
      ? {
          merchant_id: normalizeText(product.merchant_id, 80) || 'external_seed',
          product_id: normalizeText(product.product_id, 120),
          canonical_url: normalizeText(product.canonical_url || product.url || product.destination_url, 500) || null,
        }
      : null,
    reasons: uniqStrings([
      `Local catalog authority match for ${role.label.toLowerCase()}.`,
      category ? `Category: ${category}.` : null,
    ].filter(Boolean), 3),
    source: 'external_seed',
    product_source: 'catalog',
    authority_status: 'grounded',
    match_status: 'catalog_verified',
    role_id: role.role_id,
  };
}

async function queryRoleCandidates({
  queryFn,
  market,
  role,
  perRoleLimit,
  toolScopes,
} = {}) {
  const patterns = likePatterns(role.terms, 18);
  const categories = uniqStrings(role.categories, 8).map((value) => value.toLowerCase());
  const params = [market, toolScopes, patterns, categories, perRoleLimit];
  const sql = `
    SELECT
      ${buildSeedSelectSql()},
      CASE
        WHEN ${EXTERNAL_SEED_RECALL_SQL_FIELDS.category} = ANY($4::text[]) THEN 50
        WHEN ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalTitle} LIKE ANY($3::text[]) THEN 42
        WHEN ${EXTERNAL_SEED_RECALL_SQL_FIELDS.aliasTokens} LIKE ANY($3::text[]) THEN 36
        WHEN ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalSummary} LIKE ANY($3::text[]) THEN 24
        ELSE 8
      END AS match_score
    FROM external_product_seeds
    WHERE status = 'active'
      AND attached_product_key IS NULL
      AND market = $1
      AND tool = ANY($2::text[])
      AND coalesce(lower(seed_data#>>'{suppression_flags,exclude_from_recall}'), 'false') <> 'true'
      AND coalesce(lower(seed_data#>>'{derived,recall,suppression_flags,exclude_from_recall}'), 'false') <> 'true'
      AND (
        ${EXTERNAL_SEED_RECALL_SQL_FIELDS.category} = ANY($4::text[])
        OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalTitle} LIKE ANY($3::text[])
        OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalSummary} LIKE ANY($3::text[])
        OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.aliasTokens} LIKE ANY($3::text[])
      )
    ORDER BY match_score DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    LIMIT $5
  `;
  const res = await queryFn(sql, params);
  const rows = Array.isArray(res?.rows) ? res.rows : [];
  const candidates = rows
    .map((row) => ({
      row,
      product: buildExternalSeedBrandSearchProduct(row),
    }))
    .filter((entry) => entry.product)
    .filter((entry) => isRoleCompatibleProduct(entry.product, role.role_id))
    .filter((entry) => isMarketCurrencyCompatibleProduct(entry.product, market))
    .map(({ row, product }) => ({
      product,
      role,
      score: Number(row.match_score || 0) + scoreProductForRole(product, role),
    }));
  return {
    candidates,
    rawRows: rows.length,
    viableRows: candidates.length,
  };
}

function selectRoleBalancedCandidates(candidates, limit = DEFAULT_LIMIT) {
  const out = [];
  const seen = new Set();
  for (const roleId of ROLE_ORDER) {
    const best = candidates
      .filter((row) => row?.role?.role_id === roleId)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];
    if (!best) continue;
    const productId = normalizeText(best.product?.product_id || best.product?.id, 160).toLowerCase();
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    out.push(best);
    if (out.length >= limit) return out;
  }
  for (const row of candidates.sort((a, b) => Number(b.score || 0) - Number(a.score || 0))) {
    const productId = normalizeText(row?.product?.product_id || row?.product?.id, 160).toLowerCase();
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

async function loadTravelLocalProductAuthorityCandidates({
  destination,
  destinationPlace,
  travelReadiness,
  message,
  limit = DEFAULT_LIMIT,
  queryFn = defaultQuery,
} = {}) {
  const startedAt = Date.now();
  const marketConfig = resolveTravelLocalMarket({ destination, destinationPlace });
  const market = marketConfig.market;
  const queryPlan = buildTravelLocalProductQueryPlan({ travelReadiness, message, limit });
  const baseMeta = {
    market: market || null,
    market_source: marketConfig.source,
    query_plan: queryPlan,
    query_count: queryPlan.length,
    candidate_count: 0,
    selected_count: 0,
    coverage_status: 'coverage_miss',
    duration_ms: 0,
  };
  if (!market) {
    return {
      ok: false,
      reason: 'market_unresolved',
      candidates: [],
      meta: { ...baseMeta, coverage_status: 'market_unresolved', duration_ms: Date.now() - startedAt },
    };
  }
  if (!queryPlan.length) {
    return {
      ok: false,
      reason: 'empty_query_plan',
      candidates: [],
      meta: { ...baseMeta, coverage_status: 'empty_query_plan', duration_ms: Date.now() - startedAt },
    };
  }
  if (typeof queryFn !== 'function') {
    return {
      ok: false,
      reason: 'missing_query_fn',
      candidates: [],
      meta: { ...baseMeta, coverage_status: 'missing_query_fn', duration_ms: Date.now() - startedAt },
    };
  }
  if (queryFn === defaultQuery && !process.env.DATABASE_URL) {
    return {
      ok: false,
      reason: 'missing_database',
      candidates: [],
      meta: { ...baseMeta, coverage_status: 'missing_database', duration_ms: Date.now() - startedAt },
    };
  }

  const perRoleLimit = Math.max(3, Math.ceil((Number(limit) || DEFAULT_LIMIT) * 1.5));
  const toolScopes = ['creator_agents', '*'];
  const stageCounts = [];
  const collected = [];
  try {
    for (const role of queryPlan) {
      const roleResult = await queryRoleCandidates({ queryFn, market, role, perRoleLimit, toolScopes });
      const rows = Array.isArray(roleResult?.candidates) ? roleResult.candidates : [];
      stageCounts.push({
        role_id: role.role_id,
        query_terms: role.terms,
        categories: role.categories,
        raw_rows: Number(roleResult?.rawRows || 0),
        viable_rows: Number(roleResult?.viableRows || rows.length || 0),
      });
      collected.push(...rows);
    }
    const selected = selectRoleBalancedCandidates(collected, Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 8)));
    const candidates = selected.map((row) => normalizeAuthorityCandidate(row.product, row.role)).filter(Boolean);
    return {
      ok: candidates.length > 0,
      reason: candidates.length > 0 ? 'ok' : 'coverage_miss',
      candidates,
      meta: {
        ...baseMeta,
        stage_counts: stageCounts,
        candidate_count: collected.length,
        selected_count: candidates.length,
        coverage_status: candidates.length > 0 ? 'grounded' : 'coverage_miss',
        duration_ms: Date.now() - startedAt,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: normalizeText(err?.code || err?.message, 120) || 'query_error',
      candidates: [],
      meta: {
        ...baseMeta,
        stage_counts: stageCounts,
        coverage_status: 'query_error',
        duration_ms: Date.now() - startedAt,
      },
    };
  }
}

module.exports = {
  loadTravelLocalProductAuthorityCandidates,
  __internal: {
    resolveTravelLocalMarket,
    buildTravelLocalProductQueryPlan,
    inferRoleIdFromText,
    likePatterns,
    selectRoleBalancedCandidates,
    isRoleCompatibleProduct,
    isMarketCurrencyCompatibleProduct,
  },
};
