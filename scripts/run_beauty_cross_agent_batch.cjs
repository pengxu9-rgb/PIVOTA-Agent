#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATASET = path.join(ROOT, 'datasets', 'beauty_cross_agent_multiturn_seed.json');
const DEFAULT_BASE_URL =
  process.env.BASE_URL ||
  process.env.STAGING_BASE_URL ||
  'https://pivota-agent-staging.up.railway.app';
const DEFAULT_OUT_ROOT = path.join(ROOT, 'reports', 'beauty-cross-agent');
const DEFAULT_AURORA_TIMEOUT_MS = Number(process.env.BEAUTY_CROSS_AGENT_AURORA_TIMEOUT_MS || 30000);
const DEFAULT_INVOKE_TIMEOUT_MS = Number(process.env.BEAUTY_CROSS_AGENT_INVOKE_TIMEOUT_MS || 30000);
const DEFAULT_DELAY_MS = Number(process.env.BEAUTY_CROSS_AGENT_DELAY_MS || 200);

function parseArgs(argv = process.argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function nowStamp() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return value;
  }
}

function deepMerge(base, patch) {
  if (!isPlainObject(base)) return cloneJson(patch);
  if (!isPlainObject(patch)) return cloneJson(base);
  const out = { ...cloneJson(base) };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(out[key]) && isPlainObject(value)) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = cloneJson(value);
    }
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(absPath, label = 'json') {
  const raw = fs.readFileSync(absPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${absPath} (${err.message})`);
  }
}

function relativeToRoot(absPath) {
  const rel = path.relative(ROOT, absPath);
  return rel && !rel.startsWith('..') ? rel : absPath;
}

function safeSegment(value) {
  return String(value || 'x')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'x';
}

function joinUrl(baseUrl, urlPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(urlPath || '').startsWith('/') ? String(urlPath || '') : `/${String(urlPath || '')}`;
  return `${base}${suffix}`;
}

function getPath(obj, dotted) {
  const parts = String(dotted || '').split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9\u4e00-\u9fff%+.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeFreePhrase(text, term) {
  const escaped = String(term || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return text;
  return text
    .replace(new RegExp(`${escaped}\\s*[- ]\\s*free`, 'gi'), ' ')
    .replace(new RegExp(`free\\s+of\\s+${escaped}`, 'gi'), ' ');
}

function isBlockedTermNegatedAt(normalizedSource, index) {
  const before = normalizedSource.slice(Math.max(0, index - 96), index).trimEnd();
  if (!before) return false;
  if (
    /\b(?:do\s+not|don'?t|dont|avoid|skip|never|not|no|without)\b(?:\s+[a-z0-9%+.-]+){0,8}$/.test(before) ||
    /(?:不要|别|別|避免|不建议|不建議|先别|先別|不要为了|不要為了)[\u4e00-\u9fff a-z0-9%+.-]{0,32}$/.test(before)
  ) {
    return true;
  }
  return false;
}

function containsUnnegatedBlockedTerm(text, term) {
  const source = normalizeText(text);
  const needle = normalizeText(term);
  if (!source || !needle) return false;
  let cursor = source.indexOf(needle);
  while (cursor >= 0) {
    if (!isBlockedTermNegatedAt(source, cursor)) return true;
    cursor = source.indexOf(needle, cursor + needle.length);
  }
  return false;
}

function containsTerm(text, term, { blocked = false } = {}) {
  const rawTerm = String(term || '').trim();
  if (!rawTerm) return false;
  let source = String(text || '');
  if (blocked) source = removeFreePhrase(source, rawTerm);
  if (blocked && normalizeText(rawTerm) === 'acid') {
    const normalized = normalizeText(source);
    return (
      /\b(aha|bha|pha|glycolic acid|lactic acid|mandelic acid|salicylic acid|azelaic acid|peeling solution|acid toner|acid serum|acid pads?|exfoliating acid)\b/i.test(normalized) ||
      /果酸|水杨酸|水楊酸|杏仁酸|刷酸|酸类焕肤|酸類煥膚/.test(source)
    );
  }
  if (blocked) return containsUnnegatedBlockedTerm(source, rawTerm);
  return normalizeText(source).includes(normalizeText(rawTerm));
}

function includesAny(text, terms = [], opts = {}) {
  return (Array.isArray(terms) ? terms : []).some((term) => containsTerm(text, term, opts));
}

function countCjkChars(text) {
  const matches = String(text || '').match(/[\u4e00-\u9fff]/g);
  return matches ? matches.length : 0;
}

function countLatinWords(text) {
  const matches = String(text || '').match(/\b[A-Za-z][A-Za-z'-]{1,}\b/g);
  return matches ? matches.length : 0;
}

function normalizeExpectedLanguage(value) {
  const token = String(value || '').trim().toUpperCase();
  return token === 'CN' ? 'CN' : token === 'EN' ? 'EN' : '';
}

function evaluateResponseLanguageMatch({ expectedLanguage, text }) {
  const expected = normalizeExpectedLanguage(expectedLanguage);
  const body = String(text || '').trim();
  if (!expected || !body) {
    return {
      pass: false,
      expected_language: expected || null,
      detected_language: 'unknown',
      cjk_chars: countCjkChars(body),
      latin_words: countLatinWords(body),
      reason: expected ? 'empty_text' : 'expected_language_missing',
    };
  }
  const cjkChars = countCjkChars(body);
  const latinWords = countLatinWords(body);
  const detected =
    cjkChars >= 12 && cjkChars >= Math.max(4, latinWords * 0.25)
      ? 'CN'
      : latinWords >= 8 && cjkChars < 8
        ? 'EN'
        : cjkChars > 0
          ? 'mixed'
          : 'unknown';
  const pass =
    expected === 'CN'
      ? cjkChars >= 12
      : cjkChars <= 6 && latinWords >= 8;
  return {
    pass,
    expected_language: expected,
    detected_language: detected,
    cjk_chars: cjkChars,
    latin_words: latinWords,
    reason: pass ? '' : `expected_${expected}_detected_${detected}`,
  };
}

function headerObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  headers.forEach((value, key) => {
    out[String(key || '').toLowerCase()] = String(value || '');
  });
  return out;
}

async function requestJson({ url, method = 'POST', headers = {}, payload, timeoutMs }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs || 30000)));
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: JSON.stringify(payload || {}) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = {};
    let parseError = '';
    try {
      body = text ? JSON.parse(text) : {};
    } catch (err) {
      parseError = err.message || String(err);
      body = { _raw: text };
    }
    return {
      status: response.status,
      headers: headerObject(response.headers),
      body,
      raw_text: text,
      parse_error: parseError,
      latency_ms: Math.max(0, Date.now() - startedAt),
      transport_error: '',
    };
  } catch (err) {
    return {
      status: 0,
      headers: {},
      body: { error: 'REQUEST_FAILED', message: err && err.message ? err.message : String(err) },
      raw_text: '',
      parse_error: '',
      latency_ms: Math.max(0, Date.now() - startedAt),
      transport_error: err && err.message ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function authHeaders({ agentApiKey, authToken } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = String(agentApiKey || '').trim();
  const bearer = String(authToken || '').trim() || apiKey;
  if (apiKey) headers['X-Agent-API-Key'] = apiKey;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return headers;
}

function auroraHeaders({ uid, traceId, briefId, language }) {
  return {
    'Content-Type': 'application/json',
    'X-Aurora-UID': uid,
    'X-Trace-ID': traceId,
    'X-Brief-ID': briefId,
    'X-Lang': language,
  };
}

function extractAssistantText(body) {
  const chunks = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text) chunks.push(text);
  };
  push(body && body.assistant_text);
  push(body && body.answer);
  push(body && body.message);
  if (isPlainObject(body && body.assistant_message)) push(body.assistant_message.content);
  if (Array.isArray(body && body.cards)) {
    for (const card of body.cards) {
      if (!isPlainObject(card)) continue;
      push(card.text);
      push(card.body);
      if (Array.isArray(card.sections)) {
        for (const section of card.sections) {
          if (!isPlainObject(section)) continue;
          push(section.text);
          push(section.text_en);
          push(section.text_zh);
          push(section.body);
        }
      }
      if (isPlainObject(card.payload)) {
        push(card.payload.title);
        push(card.payload.summary);
        push(card.payload.verdict);
        push(card.payload.explanation);
        push(card.payload.recommendation);
        push(card.payload.guidance);
      }
    }
  }
  return Array.from(new Set(chunks)).join('\n');
}

function extractPrimaryAssistantSurfaceText(body) {
  return firstNonEmpty(
    getPath(body, 'assistant_message.content'),
    body && body.assistant_text,
    body && body.answer,
    body && body.message,
  );
}

function extractCardTypes(body) {
  return Array.isArray(body && body.cards)
    ? body.cards.map((card) => String(card && (card.type || card.card_type) || '').trim()).filter(Boolean)
    : [];
}

function extractFollowUps(body) {
  const rows = [];
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) rows.push(value.trim());
    else if (isPlainObject(value)) {
      const text = firstNonEmpty(value.text, value.label, value.question, value.title);
      if (text) rows.push(text);
    }
  };
  for (const key of ['follow_up_questions', 'suggested_quick_replies', 'suggested_chips']) {
    const value = body && body[key];
    if (Array.isArray(value)) value.forEach(add);
  }
  return Array.from(new Set(rows)).slice(0, 12);
}

function looksLikeProduct(item) {
  if (!isPlainObject(item)) return false;
  return Boolean(
    item.title ||
      item.name ||
      item.product_id ||
      item.productId ||
      item.id ||
      item.sku_id ||
      item.category ||
      item.product_type,
  );
}

function normalizeProduct(item) {
  if (!isPlainObject(item)) return null;
  const product = isPlainObject(item.product) ? item.product : item;
  if (!looksLikeProduct(product)) return null;
  const title = firstNonEmpty(product.title, product.name, product.product_name, product.display_name);
  const productId = firstNonEmpty(product.product_id, product.productId, product.id, product.sku_id);
  const brand = firstNonEmpty(product.brand, product.vendor, product.merchant_name);
  const category = firstNonEmpty(product.category, product.product_type, product.category_name);
  const description = firstNonEmpty(product.description, product.subtitle, product.summary);
  return {
    title,
    product_id: productId,
    brand,
    category,
    description,
    raw: product,
  };
}

function extractProducts(body) {
  const out = [];
  const seen = new Set();
  function add(item) {
    const product = normalizeProduct(item);
    if (!product) return;
    const key = `${product.product_id || ''}::${product.title || ''}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(product);
  }
  function visit(value, depth = 0) {
    if (depth > 5 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (looksLikeProduct(item) || isPlainObject(item && item.product)) add(item);
        else visit(item, depth + 1);
      }
      return;
    }
    if (!isPlainObject(value)) return;
    for (const key of ['products', 'items', 'recommendations', 'candidates', 'results']) {
      if (Array.isArray(value[key])) visit(value[key], depth + 1);
    }
    if (isPlainObject(value.product)) add(value.product);
    if (Array.isArray(value.cards)) {
      for (const card of value.cards) {
        const cardType = String(card && (card.type || card.card_type) || '').trim().toLowerCase();
        if (cardType === 'product_analysis') continue;
        if (isPlainObject(card && card.payload)) visit(card.payload, depth + 1);
      }
    }
    if (Array.isArray(value.groups)) visit(value.groups, depth + 1);
  }
  visit(body, 0);
  return out.slice(0, 40);
}

function productText(product) {
  if (!isPlainObject(product)) return '';
  const raw = isPlainObject(product.raw) ? product.raw : {};
  return [
    product.title,
    product.brand,
    product.category,
    product.description,
    raw.category_path,
    raw.product_type,
    raw.tags,
    raw.categories,
  ]
    .flat()
    .filter(Boolean)
    .join(' ');
}

function inferDestinationMarketFromText(text) {
  const raw = String(text || '');
  if (/\b(seoul|south korea|korea|korean)\b|首尔|首爾|韩国|韓國/i.test(raw)) return 'KR';
  if (/\b(tokyo|osaka|kyoto|japan|japanese)\b|东京|東京|大阪|京都|日本/i.test(raw)) return 'JP';
  if (/\b(bangkok|thailand|thai)\b|曼谷|泰国|泰國/i.test(raw)) return 'TH';
  if (/\b(shanghai|beijing|china|chinese)\b|上海|北京|中国|中國/i.test(raw)) return 'CN';
  if (/\b(reykjavik|iceland)\b|雷克雅未克|冰岛|冰島/i.test(raw)) return 'IS';
  return '';
}

function productRawFieldText(product) {
  if (!isPlainObject(product)) return '';
  const raw = isPlainObject(product.raw) ? product.raw : {};
  return [
    raw.trip_context_reason,
    raw.travel_context_reason,
    raw.travel_purchase_bucket,
    raw.local_authority,
    raw.locality_facts_v1,
    raw.locality_facts,
    raw.fit_attributes,
    raw.brand_origin,
    raw.brand_origin_country,
    raw.brand_home_market,
    raw.market_availability,
    raw.available_markets,
    raw.local_purchase_markets,
    raw.local_retail_channels,
    raw.local_retail_channel,
    raw.creator_local_reason,
    raw.travel_size,
    raw.reasons,
  ]
    .flatMap((value) => {
      if (Array.isArray(value)) return value;
      if (isPlainObject(value)) return [JSON.stringify(value)];
      return [value];
    })
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

function productHasTripContextReason(product) {
  const raw = isPlainObject(product?.raw) ? product.raw : {};
  return Boolean(
    String(raw.trip_context_reason || raw.travel_context_reason || '').trim() ||
      includesAny(productRawFieldText(product), ['flight', 'cabin', 'local UV', 'fine dust', '机舱', '飞行', '当地', '本地', '步行', '城市污染']),
  );
}

function productHasLocalOrTravelAuthority(product, queryDef = {}) {
  const queryText = String(queryDef?.query || '');
  const targetMarket = inferDestinationMarketFromText(queryText);
  const raw = isPlainObject(product?.raw) ? product.raw : {};
  const localAuthority = isPlainObject(raw.local_authority) ? raw.local_authority : {};
  const facts = isPlainObject(raw.locality_facts_v1)
    ? raw.locality_facts_v1
    : isPlainObject(raw.locality_facts)
      ? raw.locality_facts
      : {};
  const fieldText = `${productRawFieldText(product)} ${productText(product)}`;
  const markets = [
    raw.market,
    raw.brand_home_market,
    raw.brand_origin_country,
    localAuthority.brand_home_market,
    localAuthority.brand_origin_country,
    ...(Array.isArray(localAuthority.local_purchase_markets) ? localAuthority.local_purchase_markets : []),
    ...(Array.isArray(localAuthority.available_markets) ? localAuthority.available_markets : []),
    facts.brand_home_market,
    facts.brand_origin_country,
    ...(Array.isArray(facts.local_purchase_markets) ? facts.local_purchase_markets : []),
    ...(Array.isArray(facts.available_markets) ? facts.available_markets : []),
  ].map((value) => String(value || '').trim().toUpperCase()).filter(Boolean);
  if (targetMarket && markets.includes(targetMarket)) return true;
  if (targetMarket === 'KR' && /\b(korea|korean|k[-\s]?beauty|seoul|kr|olive young)\b|韩国|韓國|首尔|首爾/i.test(fieldText)) {
    return true;
  }
  if (/\b(travel[-\s]?size|portable|mini|carry[-\s]?on|flight|cabin)\b|旅行装|旅行裝|便携|便攜|小样|小樣|机舱|機艙/.test(fieldText)) {
    return true;
  }
  return false;
}

function inferProductFamiliesFromText(text) {
  const raw = String(text || '');
  const out = new Set();
  if (/\b(sunscreen|spf|sunblock|uv|broad spectrum)\b|防晒|防曬/i.test(raw)) out.add('sunscreen');
  if (/\b(cleanser|cleansing|face wash|facial wash)\b|洁面|潔面|洗面/i.test(raw)) out.add('cleanser');
  if (/\b(moisturi[sz]er|cream|gel cream|barrier|repair|ceramide|panthenol|cica|lotion)\b|保湿|保濕|面霜|乳液|屏障|修护|修護/i.test(raw)) out.add('moisturizer');
  if (/\b(serum|essence|ampoule|vitamin c|niacinamide|azelaic|tranexamic|peptide|brighten)\b|精华|精華|提亮|淡斑/i.test(raw)) out.add('serum');
  return Array.from(out);
}

function productMatchesAnyFamily(product, families = []) {
  const wanted = Array.isArray(families) ? families : [];
  if (!wanted.length) return false;
  const actual = inferProductFamiliesFromText(productText(product));
  return wanted.some((family) => actual.includes(family));
}

function extractQuerySource(body) {
  return firstNonEmpty(
    getPath(body, 'metadata.query_source'),
    getPath(body, 'meta.query_source'),
    getPath(body, 'session_patch.meta.query_source'),
    getPath(body, 'metadata.source'),
  );
}

function extractDecisionAuthority(body) {
  return firstNonEmpty(
    getPath(body, 'metadata.search_decision.decision_authority'),
    getPath(body, 'metadata.search_decision.decisionAuthority'),
    getPath(body, 'metadata.decision_authority'),
    getPath(body, 'metadata.search_trace.decision_authority'),
    getPath(body, 'meta.decision_authority'),
  );
}

function extractRequestId(response, body) {
  return firstNonEmpty(
    response && response.headers && response.headers['x-request-id'],
    response && response.headers && response.headers['x-gateway-request-id'],
    response && response.headers && response.headers['x-trace-id'],
    body && body.request_id,
    getPath(body, 'telemetry.request_id'),
    getPath(body, 'meta.request_id'),
  );
}

function validateResponseSchema(agent, body, parseError) {
  if (parseError) return { valid: false, reason: `json_parse_error:${parseError}` };
  if (!isPlainObject(body)) return { valid: false, reason: 'body_not_object' };
  if (agent === 'aurora_chat') {
    if (!Array.isArray(body.cards)) return { valid: false, reason: 'aurora_cards_missing' };
    const pivotContractVersion = firstNonEmpty(
      getPath(body, 'session_patch.meta.pivot_contract_version'),
      getPath(body, 'meta.pivot_contract_version'),
      getPath(body, 'metadata.pivot_contract_version'),
    );
    const reply = firstNonEmpty(body.reply);
    const assistantSurface = extractPrimaryAssistantSurfaceText(body);
    if (
      pivotContractVersion === 'pivot.agent.v1' &&
      reply &&
      assistantSurface &&
      normalizeText(reply) !== normalizeText(assistantSurface)
    ) {
      return { valid: false, reason: 'aurora_reply_surface_mismatch' };
    }
  }
  if (agent === 'shopping' || agent === 'creator') {
    if (!Array.isArray(body.products) && !Array.isArray(body.items) && !Array.isArray(body.groups)) {
      return { valid: false, reason: 'invoke_products_missing' };
    }
  }
  return { valid: true, reason: '' };
}

function evaluateProductRelevance(queryDef, products) {
  const top = (Array.isArray(products) ? products : []).slice(0, 6);
  const targetTerms = Array.isArray(queryDef && queryDef.target_terms) ? queryDef.target_terms : [];
  const blockedTerms = Array.isArray(queryDef && queryDef.blocked_terms) ? queryDef.blocked_terms : [];
  const minRelevant = Number(queryDef && queryDef.min_relevant_top6) || 4;
  const expectedFamilies = inferProductFamiliesFromText([
    queryDef && queryDef.query,
    targetTerms.join(' '),
  ].filter(Boolean).join(' '));
  const relevant = top.filter((product) => {
    const text = productText(product);
    return includesAny(text, targetTerms) || productMatchesAnyFamily(product, expectedFamilies);
  }).length;
  const blockedHits = [];
  for (const product of top) {
    const text = productText(product);
    for (const term of blockedTerms) {
      if (containsTerm(text, term, { blocked: true })) {
        blockedHits.push({ title: product.title || product.product_id || 'untitled', term });
      }
    }
  }
  const travelLocalQuality = evaluateProductTravelLocalQuality(queryDef, top);
  const pass =
    top.length > 0 &&
    relevant >= minRelevant &&
    blockedHits.length === 0 &&
    (!travelLocalQuality || travelLocalQuality.pass);
  return {
    pass,
    relevant_top6: relevant,
    min_relevant_top6: minRelevant,
    top6_count: top.length,
    blocked_hits: blockedHits,
    expected_families: expectedFamilies,
    ...(travelLocalQuality ? { travel_local_quality: travelLocalQuality } : {}),
  };
}

function evaluateProductTravelLocalQuality(queryDef, topProducts) {
  const cfg = isPlainObject(queryDef?.travel_local_quality) ? queryDef.travel_local_quality : null;
  if (!cfg) return null;
  const top = (Array.isArray(topProducts) ? topProducts : []).slice(0, 6);
  const minAuthority = Number(cfg.min_local_or_travel_authority_top6 ?? cfg.min_authority_top6 ?? 4);
  const requireTripReason = cfg.require_trip_context_reason !== false;
  const authorityCount = top.filter((product) => productHasLocalOrTravelAuthority(product, queryDef)).length;
  const tripReasonCount = top.filter(productHasTripContextReason).length;
  const pass =
    top.length > 0 &&
    authorityCount >= minAuthority &&
    (!requireTripReason || tripReasonCount >= minAuthority);
  return {
    pass,
    local_or_travel_authority_top6: authorityCount,
    trip_context_reason_top6: tripReasonCount,
    min_local_or_travel_authority_top6: minAuthority,
    require_trip_context_reason: requireTripReason,
  };
}

function stringifyForDiagnostics(value, max = 12000) {
  try {
    return JSON.stringify(value || {}).slice(0, max);
  } catch (_err) {
    return '';
  }
}

function hasTimeoutOrAbortSignal(value, key = '', depth = 0) {
  if (depth > 8 || value == null) return false;
  const normalizedKey = String(key || '').toLowerCase();
  if (typeof value === 'boolean') {
    return value === true && /\b(timeout|timed_out|aborted|abort)\b/i.test(normalizedKey);
  }
  if (typeof value === 'number') return false;
  if (typeof value === 'string') {
    const text = value.toLowerCase();
    return /econnaborted|operation was aborted|stage_timeout|budget_exhausted|timed out|request timeout|upstream timeout/.test(text);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasTimeoutOrAbortSignal(item, key, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.entries(value).some(([childKey, childValue]) =>
      hasTimeoutOrAbortSignal(childValue, childKey, depth + 1),
    );
  }
  return false;
}

function classifyResponseDegradation(body, response) {
  const querySource = extractQuerySource(body);
  const products = extractProducts(body);
  const diagnostics = stringifyForDiagnostics(body);
  const reasons = [];
  const source = String(querySource || '').trim();
  const contractStatus = String(body && body.status || '').trim().toLowerCase();
  if (contractStatus === 'failed') reasons.push('contract_failed');
  if (contractStatus === 'degraded') reasons.push('contract_degraded');
  const lowerDiag = diagnostics.toLowerCase();
  if (source === 'agent_products_error_fallback') reasons.push('error_fallback');
  if (source.includes('fallback') && products.length === 0) reasons.push('empty_fallback');
  if (products.length === 0 && /degraded_empty|strict_empty|temporarily unavailable|search is temporarily unavailable/i.test(diagnostics)) {
    reasons.push('degraded_empty');
  }
  if (
    response.status === 0 ||
    hasTimeoutOrAbortSignal(response.transport_error, 'transport_error') ||
    hasTimeoutOrAbortSignal(body)
  ) {
    reasons.push('timeout_or_abort');
  }
  if (lowerDiag.includes('"degraded":true') || lowerDiag.includes('product_analyze_degraded')) {
    reasons.push('degraded_response');
  }
  return {
    degraded: reasons.length > 0,
    reasons: Array.from(new Set(reasons)),
  };
}

function evaluateRiskGuards(caseDef, rows) {
  const guards = isPlainObject(caseDef.risk_guards) ? caseDef.risk_guards : {};
  const assistantText = rows
    .filter((row) => String(row.agent || '').startsWith('aurora'))
    .map((row) => row.assistant_text || '')
    .join('\n');
  const productJoined = rows
    .flatMap((row) => Array.isArray(row.products) ? row.products : [])
    .map(productText)
    .join('\n');

  const checks = [];
  for (const group of Array.isArray(guards.assistant_must_include_any) ? guards.assistant_must_include_any : []) {
    const terms = Array.isArray(group) ? group : [group];
    checks.push({
      kind: 'assistant_must_include_any',
      terms,
      pass: includesAny(assistantText, terms),
    });
  }
  const assistantBlocked = [];
  for (const term of Array.isArray(guards.assistant_must_not_include_any) ? guards.assistant_must_not_include_any : []) {
    if (containsTerm(assistantText, term, { blocked: true })) assistantBlocked.push(term);
  }
  checks.push({
    kind: 'assistant_must_not_include_any',
    terms: assistantBlocked,
    pass: assistantBlocked.length === 0,
  });

  const productBlocked = [];
  for (const term of Array.isArray(guards.product_must_not_include_any) ? guards.product_must_not_include_any : []) {
    if (containsTerm(productJoined, term, { blocked: true })) productBlocked.push(term);
  }
  checks.push({
    kind: 'product_must_not_include_any',
    terms: productBlocked,
    pass: productBlocked.length === 0,
  });

  const pass = checks.every((check) => check.pass);
  return {
    severity: String(guards.severity || 'medium'),
    pass,
    checks,
  };
}

function evaluateTravelLocalQuality(caseDef, rows) {
  const cfg = isPlainObject(caseDef.travel_local_quality) ? caseDef.travel_local_quality : null;
  if (!cfg) return { enabled: false, pass: true, checks: [] };
  const assistantText = rows
    .filter((row) => String(row.agent || '').startsWith('aurora'))
    .map((row) => row.assistant_text || '')
    .join('\n');
  const checks = [];
  const addCheck = (kind, pass, details = {}) => {
    checks.push({ kind, pass: Boolean(pass), ...details });
  };
  const checkAny = (kind, terms) => {
    const values = Array.isArray(terms) ? terms : [];
    if (!values.length) return;
    addCheck(kind, includesAny(assistantText, values), { terms: values });
  };
  const checkAllGroups = (kind, groups) => {
    for (const [index, group] of (Array.isArray(groups) ? groups : []).entries()) {
      const terms = Array.isArray(group) ? group : [group];
      addCheck(`${kind}_${index + 1}`, includesAny(assistantText, terms), { terms });
    }
  };

  checkAny('origin_detected', cfg.origin_terms);
  checkAny('destination_detected', cfg.destination_terms);
  for (const term of Array.isArray(cfg.date_terms) ? cfg.date_terms : []) {
    addCheck('date_detected', containsTerm(assistantText, term), { terms: [term] });
  }
  checkAllGroups('flight_and_cabin_risk', cfg.flight_risk_groups);
  checkAllGroups('destination_environment_risk', cfg.destination_risk_groups);
  checkAllGroups('travel_section', cfg.section_groups);

  const productRows = rows.filter((row) => row.product_assessment?.travel_local_quality);
  if (cfg.require_product_authority !== false) {
    const failedProductRows = productRows.filter((row) => !row.product_assessment.travel_local_quality.pass);
    addCheck('product_local_or_travel_authority', productRows.length > 0 && failedProductRows.length === 0, {
      product_rows_checked: productRows.length,
      failed_rows: failedProductRows.map((row) => row.step_id),
    });
  }

  const pass = checks.every((check) => check.pass);
  return {
    enabled: true,
    pass,
    checks,
  };
}

function collectCategoryNodes(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectCategoryNodes(item, out));
    return out;
  }
  if (!isPlainObject(value)) return out;
  if (isPlainObject(value.category)) collectCategoryNodes(value.category, out);
  const name = firstNonEmpty(value.name, value.title, value.label, value.display_name);
  const slug = firstNonEmpty(value.slug, value.id, value.category_slug, value.category_id);
  if (name || slug) {
    out.push({
      name,
      slug,
      count: Number(value.count ?? value.product_count ?? value.productCount ?? value.products_count ?? value.total ?? 0) || 0,
      raw: value,
    });
  }
  for (const key of ['children', 'categories', 'items', 'nodes', 'roots']) {
    if (Array.isArray(value[key])) collectCategoryNodes(value[key], out);
  }
  return out;
}

function summarizeRow({
  caseId,
  stepId,
  agent,
  route,
  query,
  response,
  rawFile,
  productAssessment,
  categoryCheck,
  expectedLanguage,
}) {
  const body = response.body || {};
  const products = extractProducts(body);
  const schema = validateResponseSchema(agent, body, response.parse_error);
  const degradation = classifyResponseDegradation(body, response);
  const assistantText = extractAssistantText(body);
  const languageAssessment = String(agent || '').startsWith('aurora')
    ? evaluateResponseLanguageMatch({ expectedLanguage, text: assistantText })
    : null;
  return {
    case_id: caseId,
    step_id: stepId,
    agent,
    route,
    query: query || '',
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    latency_ms: response.latency_ms,
    schema_valid: schema.valid,
    schema_error: schema.reason,
    transport_error: response.transport_error,
    assistant_text: assistantText,
    reply: firstNonEmpty(body.reply),
    card_types: extractCardTypes(body),
    follow_up_questions: extractFollowUps(body),
    products,
    product_titles: products.map((product) => product.title).filter(Boolean).slice(0, 8),
    product_ids: products.map((product) => product.product_id).filter(Boolean).slice(0, 8),
    query_source: extractQuerySource(body),
    decision_authority: extractDecisionAuthority(body),
    request_id: extractRequestId(response, body),
    raw_file: rawFile,
    product_assessment: productAssessment || null,
    category_check: categoryCheck || null,
    degradation,
    language_assessment: languageAssessment,
  };
}

function writeRaw({ rawDir, caseId, stepId, payload }) {
  const caseDir = path.join(rawDir, safeSegment(caseId));
  ensureDir(caseDir);
  const filePath = path.join(caseDir, `${safeSegment(stepId)}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function buildAuroraRequestBody({ caseDef, turn, language, session }) {
  if (turn.route === 'aurora_chat') {
    return {
      message: String(turn.message || ''),
      language,
      session,
    };
  }
  const payload = isPlainObject(turn.payload) ? cloneJson(turn.payload) : {};
  return {
    ...payload,
    session: deepMerge(session, payload.session || {}),
    profile_context: caseDef.profile || {},
  };
}

function routePathForTurn(turn) {
  if (turn.route === 'aurora_skin_analysis') return '/v1/analysis/skin';
  if (turn.route === 'aurora_product_analyze') return '/v1/product/analyze';
  return '/v1/chat';
}

async function runAuroraTurn({ baseUrl, caseDef, turn, turnIndex, runId, rawDir, timeoutMs, session }) {
  const language = firstNonEmpty(caseDef?.persona?.language, caseDef?.language, 'CN');
  const uid = `beauty_batch_${runId}_${caseDef.case_id}`.slice(0, 120);
  const traceId = `beauty_trace_${runId}_${caseDef.case_id}_${turn.turn_id || turnIndex}`.slice(0, 120);
  const briefId = `beauty_brief_${runId}_${caseDef.case_id}`.slice(0, 120);
  const route = routePathForTurn(turn);
  const body = buildAuroraRequestBody({ caseDef, turn, language, session });
  const response = await requestJson({
    url: joinUrl(baseUrl, route),
    method: 'POST',
    headers: auroraHeaders({ uid, traceId, briefId, language }),
    payload: body,
    timeoutMs,
  });
  const stepId = `aurora_${String(turn.turn_id || turnIndex)}`;
  const rawFile = writeRaw({
    rawDir,
    caseId: caseDef.case_id,
    stepId,
    payload: {
      request: { url: joinUrl(baseUrl, route), headers: { uid, traceId, briefId, language }, body },
      response,
    },
  });
  const agent = turn.route === 'aurora_chat' ? 'aurora_chat' : turn.route;
  return {
    row: summarizeRow({
      caseId: caseDef.case_id,
      stepId,
      agent,
      route,
      query: turn.message || turn.payload?.name || '',
      response,
      rawFile: relativeToRoot(rawFile),
      expectedLanguage: language,
    }),
    session_patch: isPlainObject(response.body && response.body.session_patch) ? response.body.session_patch : {},
  };
}

function buildInvokeBody({ caseDef, queryDef, agent, market, creatorId }) {
  const source = agent === 'creator' ? 'creator_agent' : 'beauty_cross_agent_batch';
  const effectiveMarket = firstNonEmpty(queryDef && queryDef.market, market, 'US').toUpperCase();
  return {
    operation: 'find_products_multi',
    payload: {
      search: {
        query: String(queryDef.query || ''),
        limit: Number(queryDef.limit || queryDef.max_results || 6),
        in_stock_only: queryDef.in_stock_only !== false,
        market: effectiveMarket,
        ui_surface: 'beauty_cross_agent_batch',
        ...(agent === 'creator' ? { creator_id: creatorId } : {}),
      },
    },
    metadata: {
      source,
      case_id: caseDef.case_id,
      test_suite: 'beauty_cross_agent_multiturn',
      ui_surface: 'beauty_cross_agent_batch',
      market: effectiveMarket,
      ...(agent === 'creator' ? { creator_id: creatorId, creatorId } : {}),
    },
  };
}

async function runInvokeQuery({
  baseUrl,
  caseDef,
  queryDef,
  queryIndex,
  agent,
  rawDir,
  timeoutMs,
  agentApiKey,
  authToken,
  market,
  creatorId,
}) {
  const route = agent === 'creator' ? '/agent/creator/v1/invoke' : '/agent/shop/v1/invoke';
  const body = buildInvokeBody({ caseDef, queryDef, agent, market, creatorId });
  const response = await requestJson({
    url: joinUrl(baseUrl, route),
    method: 'POST',
    headers: authHeaders({ agentApiKey, authToken }),
    payload: body,
    timeoutMs,
  });
  const products = extractProducts(response.body || {});
  const productAssessment = evaluateProductRelevance(queryDef, products);
  const stepId = `${agent}_${queryIndex + 1}`;
  const rawFile = writeRaw({
    rawDir,
    caseId: caseDef.case_id,
    stepId,
    payload: {
      request: { url: joinUrl(baseUrl, route), body },
      response,
      product_assessment: productAssessment,
    },
  });
  return summarizeRow({
    caseId: caseDef.case_id,
    stepId,
    agent,
    route,
    query: queryDef.query,
    response,
    rawFile: relativeToRoot(rawFile),
    productAssessment,
  });
}

async function runCreatorCategoryCheck({ baseUrl, caseDef, rawDir, timeoutMs, creatorId, defaultView }) {
  const check = isPlainObject(caseDef.creator_category_check) ? caseDef.creator_category_check : {};
  const view = String(check.view || defaultView || 'GLOBAL_BEAUTY');
  const route = `/creator/${encodeURIComponent(creatorId)}/categories?view=${encodeURIComponent(view)}&includeCounts=true`;
  const response = await requestJson({
    url: joinUrl(baseUrl, route),
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs,
  });
  const terms = Array.isArray(check.must_have_category_terms) ? check.must_have_category_terms : ['skin', 'beauty'];
  const nodes = collectCategoryNodes(response.body || {});
  const matches = nodes.filter((node) => includesAny(`${node.name} ${node.slug}`, terms));
  let productProbe = null;
  let categoryPass = response.status >= 200 && response.status < 300 && matches.length > 0;
  if (check.require_products === true) {
    categoryPass = categoryPass && matches.some((node) => node.count > 0);
    if (!categoryPass) {
      for (const node of matches.slice(0, 4)) {
        if (!node.slug) continue;
        const productRoute =
          `/creator/${encodeURIComponent(creatorId)}/categories/${encodeURIComponent(node.slug)}/products` +
          `?view=${encodeURIComponent(view)}&limit=6`;
        const productResponse = await requestJson({
          url: joinUrl(baseUrl, productRoute),
          method: 'GET',
          headers: { Accept: 'application/json' },
          timeoutMs,
        });
        const products = extractProducts(productResponse.body || {});
        productProbe = { route: productRoute, response: productResponse, products };
        if (productResponse.status >= 200 && productResponse.status < 300 && products.length > 0) {
          categoryPass = true;
          break;
        }
      }
    }
  }
  const categoryCheck = {
    pass: Boolean(categoryPass),
    view,
    matched_categories: matches.map((node) => ({ name: node.name, slug: node.slug, count: node.count })).slice(0, 8),
    probed_product_route: productProbe ? productProbe.route : '',
    probed_product_count: productProbe ? productProbe.products.length : 0,
  };
  const stepId = 'creator_category_global_beauty';
  const rawFile = writeRaw({
    rawDir,
    caseId: caseDef.case_id,
    stepId,
    payload: {
      request: { url: joinUrl(baseUrl, route) },
      response,
      category_check: categoryCheck,
      product_probe: productProbe,
    },
  });
  return summarizeRow({
    caseId: caseDef.case_id,
    stepId,
    agent: 'creator_category',
    route,
    query: view,
    response,
    rawFile: relativeToRoot(rawFile),
    categoryCheck,
  });
}

function assessCase(caseDef, rows) {
  const risk = evaluateRiskGuards(caseDef, rows);
  const travelLocalQuality = evaluateTravelLocalQuality(caseDef, rows);
  const productRows = rows.filter((row) => row.product_assessment);
  const productPass = productRows.every((row) => row.product_assessment && row.product_assessment.pass);
  const categoryRows = rows.filter((row) => row.category_check);
  const categoryPass = categoryRows.every((row) => row.category_check && row.category_check.pass);
  const degradationRows = rows.filter((row) => row.degradation && row.degradation.degraded);
  const degradationPass = degradationRows.length === 0;
  const languageRows = rows.filter((row) => row.language_assessment);
  const languagePass = languageRows.every((row) => row.language_assessment && row.language_assessment.pass);
  const httpPass = rows.every((row) => row.ok);
  const schemaPass = rows.every((row) => row.schema_valid);
  const pass =
    httpPass &&
    schemaPass &&
    productPass &&
    categoryPass &&
    degradationPass &&
    languagePass &&
    risk.pass &&
    travelLocalQuality.pass;
  return {
    pass,
    http_pass: httpPass,
    schema_pass: schemaPass,
    product_pass: productPass,
    category_pass: categoryPass,
    language_pass: languagePass,
    travel_local_quality: travelLocalQuality,
    risk_guard: risk,
    failure_reasons: [
      ...(httpPass ? [] : ['http_failure']),
      ...(schemaPass ? [] : ['schema_violation']),
      ...(productPass ? [] : ['product_relevance_or_blocked_term']),
      ...(categoryPass ? [] : ['creator_category_check_failed']),
      ...(degradationPass ? [] : ['degraded_or_fallback_response']),
      ...(languagePass ? [] : ['response_language_mismatch']),
      ...(risk.pass ? [] : ['risk_guard_failed']),
      ...(travelLocalQuality.pass ? [] : ['travel_local_quality_failed']),
    ],
  };
}

async function runCase({ caseDef, context }) {
  const rows = [];
  let session = {
    case_id: caseDef.case_id,
    profile: cloneJson(caseDef.profile || {}),
  };
  const turns = Array.isArray(caseDef.turns) ? caseDef.turns : [];
  for (let i = 0; i < turns.length; i += 1) {
    const result = await runAuroraTurn({
      baseUrl: context.baseUrl,
      caseDef,
      turn: turns[i],
      turnIndex: i + 1,
      runId: context.runId,
      rawDir: context.rawDir,
      timeoutMs: context.auroraTimeoutMs,
      session,
    });
    rows.push(result.row);
    session = deepMerge(session, result.session_patch || {});
    if (context.delayMs > 0) await sleep(context.delayMs);
  }

  const shoppingQueries = Array.isArray(caseDef.shopping_queries) ? caseDef.shopping_queries : [];
  for (let i = 0; i < shoppingQueries.length; i += 1) {
    rows.push(await runInvokeQuery({
      baseUrl: context.baseUrl,
      caseDef,
      queryDef: shoppingQueries[i],
      queryIndex: i,
      agent: 'shopping',
      rawDir: context.rawDir,
      timeoutMs: context.invokeTimeoutMs,
      agentApiKey: context.agentApiKey,
      authToken: context.authToken,
      market: context.market,
      creatorId: context.creatorId,
    }));
    if (context.delayMs > 0) await sleep(context.delayMs);
  }

  const creatorQueries = Array.isArray(caseDef.creator_queries) ? caseDef.creator_queries : [];
  for (let i = 0; i < creatorQueries.length; i += 1) {
    rows.push(await runInvokeQuery({
      baseUrl: context.baseUrl,
      caseDef,
      queryDef: creatorQueries[i],
      queryIndex: i,
      agent: 'creator',
      rawDir: context.rawDir,
      timeoutMs: context.invokeTimeoutMs,
      agentApiKey: context.agentApiKey,
      authToken: context.authToken,
      market: context.market,
      creatorId: context.creatorId,
    }));
    if (context.delayMs > 0) await sleep(context.delayMs);
  }

  if (caseDef.creator_category_check || (caseDef.agent_routes && caseDef.agent_routes.creator_categories)) {
    rows.push(await runCreatorCategoryCheck({
      baseUrl: context.baseUrl,
      caseDef,
      rawDir: context.rawDir,
      timeoutMs: context.invokeTimeoutMs,
      creatorId: context.creatorId,
      defaultView: context.creatorView,
    }));
  }

  return {
    case_id: caseDef.case_id,
    persona: caseDef.persona || {},
    expected_assertions: Array.isArray(caseDef.expected_assertions) ? caseDef.expected_assertions : [],
    rows,
    assessment: assessCase(caseDef, rows),
  };
}

function computeSummary(dataset, results) {
  const rows = results.flatMap((result) => result.rows);
  const responseCount = rows.length;
  const okCount = rows.filter((row) => row.ok).length;
  const schemaViolationCount = rows.filter((row) => !row.schema_valid).length;
  const highRisk = results.filter((result) => result.assessment.risk_guard.severity === 'high');
  const highRiskPass = highRisk.filter((result) => result.assessment.risk_guard.pass).length;
  const productRows = rows.filter((row) => row.product_assessment);
  const productPass = productRows.filter((row) => row.product_assessment.pass).length;
  const languageRows = rows.filter((row) => row.language_assessment);
  const languagePass = languageRows.filter((row) => row.language_assessment.pass).length;
  const travelLocalCases = results.filter((result) => result.assessment.travel_local_quality?.enabled);
  const travelLocalPass = travelLocalCases.filter((result) => result.assessment.travel_local_quality?.pass).length;
  const degradedRows = rows.filter((row) => row.degradation && row.degradation.degraded);
  const errorFallbackEmptyRows = rows.filter((row) => {
    const reasons = row.degradation && Array.isArray(row.degradation.reasons) ? row.degradation.reasons : [];
    return reasons.includes('error_fallback') || reasons.includes('empty_fallback');
  });
  const timeoutFallbackRows = rows.filter((row) => {
    const reasons = row.degradation && Array.isArray(row.degradation.reasons) ? row.degradation.reasons : [];
    return reasons.includes('timeout_or_abort');
  });
  const thresholds = isPlainObject(dataset.thresholds) ? dataset.thresholds : {};
  const httpSuccessRate = responseCount > 0 ? okCount / responseCount : 0;
  const highRiskPassRate = highRisk.length > 0 ? highRiskPass / highRisk.length : 1;
  const productPassRate = productRows.length > 0 ? productPass / productRows.length : 1;
  const languagePassRate = languageRows.length > 0 ? languagePass / languageRows.length : 1;
  const travelLocalPassRate = travelLocalCases.length > 0 ? travelLocalPass / travelLocalCases.length : 1;
  const casePassCount = results.filter((result) => result.assessment.pass).length;
  const thresholdResults = {
    http_success_rate: {
      actual: httpSuccessRate,
      expected_min: Number(thresholds.http_success_rate_min ?? 0.95),
      pass: httpSuccessRate >= Number(thresholds.http_success_rate_min ?? 0.95),
    },
    schema_violation_count: {
      actual: schemaViolationCount,
      expected_max: Number(thresholds.schema_violation_max ?? 0),
      pass: schemaViolationCount <= Number(thresholds.schema_violation_max ?? 0),
    },
    high_risk_guard_pass_rate: {
      actual: highRiskPassRate,
      expected_min: Number(thresholds.high_risk_guard_pass_rate_min ?? 1),
      pass: highRiskPassRate >= Number(thresholds.high_risk_guard_pass_rate_min ?? 1),
    },
    product_relevance_pass_rate: {
      actual: productPassRate,
      expected_min: 1,
      pass: productRows.length === 0 || productPass === productRows.length,
    },
    response_language_match_rate: {
      actual: languagePassRate,
      expected_min: Number(thresholds.response_language_match_rate_min ?? 1),
      pass: languagePassRate >= Number(thresholds.response_language_match_rate_min ?? 1),
    },
    travel_local_quality_pass_rate: {
      actual: travelLocalPassRate,
      expected_min: Number(thresholds.travel_local_quality_pass_rate_min ?? 1),
      pass: travelLocalPassRate >= Number(thresholds.travel_local_quality_pass_rate_min ?? 1),
    },
    degraded_response_count: {
      actual: degradedRows.length,
      expected_max: Number(thresholds.degraded_response_max ?? 0),
      pass: degradedRows.length <= Number(thresholds.degraded_response_max ?? 0),
    },
  };
  return {
    total_cases: results.length,
    passed_cases: casePassCount,
    failed_cases: results.length - casePassCount,
    total_responses: responseCount,
    http_success_count: okCount,
    http_success_rate: httpSuccessRate,
    schema_violation_count: schemaViolationCount,
    high_risk_cases: highRisk.length,
    high_risk_pass_count: highRiskPass,
    high_risk_guard_pass_rate: highRiskPassRate,
    product_query_count: productRows.length,
    product_relevance_pass_count: productPass,
    product_relevance_pass_rate: productPassRate,
    language_checked_count: languageRows.length,
    language_match_count: languagePass,
    response_language_match_rate: languagePassRate,
    travel_local_quality_cases: travelLocalCases.length,
    travel_local_quality_pass_count: travelLocalPass,
    travel_local_quality_pass_rate: travelLocalPassRate,
    degraded_response_count: degradedRows.length,
    error_fallback_empty_count: errorFallbackEmptyRows.length,
    timeout_fallback_count: timeoutFallbackRows.length,
    thresholds: thresholdResults,
    ok: Object.values(thresholdResults).every((item) => item.pass),
  };
}

function csvEscape(value) {
  const text = Array.isArray(value)
    ? value.join(' | ')
    : isPlainObject(value)
      ? JSON.stringify(value)
      : String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function renderHumanReviewCsv(results) {
  const headers = [
    'case_id',
    'step_id',
    'agent',
    'route',
    'query',
    'status',
    'auto_pass',
    'product_titles',
    'card_types',
    'query_source',
    'decision_authority',
    'request_id',
    'raw_file',
    'language_match',
    'travel_local_quality',
    'content_quality_1_5',
    'personalization_1_5',
    'actionability_1_5',
    'safety_boundary_1_5',
    'product_relevance_1_5',
    'cross_agent_consistency_1_5',
    'reviewer_notes',
  ];
  const lines = [headers.map(csvEscape).join(',')];
  for (const result of results) {
    for (const row of result.rows) {
      const autoPass =
        row.ok &&
        row.schema_valid &&
        (!row.product_assessment || row.product_assessment.pass) &&
        (!row.category_check || row.category_check.pass) &&
        !(row.degradation && row.degradation.degraded);
      lines.push([
        result.case_id,
        row.step_id,
        row.agent,
        row.route,
        row.query,
        row.status,
        autoPass ? 'pass' : 'fail',
        row.product_titles,
        row.card_types,
        row.query_source,
        row.decision_authority,
        row.request_id,
        row.raw_file,
        row.language_assessment ? (row.language_assessment.pass ? 'pass' : `fail:${row.language_assessment.reason}`) : '',
        row.product_assessment?.travel_local_quality
          ? (row.product_assessment.travel_local_quality.pass ? 'pass' : JSON.stringify(row.product_assessment.travel_local_quality))
          : '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ].map(csvEscape).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown({ runId, baseUrl, datasetPath, summary, results }) {
  const lines = [];
  lines.push('# Beauty Cross-Agent Batch Report');
  lines.push('');
  lines.push(`- run_id: \`${runId}\``);
  lines.push(`- base_url: \`${baseUrl}\``);
  lines.push(`- dataset: \`${relativeToRoot(datasetPath)}\``);
  lines.push(`- generated_at: \`${new Date().toISOString()}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- cases: ${summary.passed_cases}/${summary.total_cases} passed`);
  lines.push(`- responses: ${summary.http_success_count}/${summary.total_responses} HTTP 2xx (${(summary.http_success_rate * 100).toFixed(1)}%)`);
  lines.push(`- schema violations: ${summary.schema_violation_count}`);
  lines.push(`- high-risk guards: ${summary.high_risk_pass_count}/${summary.high_risk_cases}`);
  lines.push(`- product relevance: ${summary.product_relevance_pass_count}/${summary.product_query_count}`);
  lines.push(`- response language match: ${summary.language_match_count}/${summary.language_checked_count}`);
  lines.push(`- travel-local quality: ${summary.travel_local_quality_pass_count}/${summary.travel_local_quality_cases}`);
  lines.push(`- degraded/fallback responses: ${summary.degraded_response_count} (error/empty fallback: ${summary.error_fallback_empty_count}, timeout/abort: ${summary.timeout_fallback_count})`);
  lines.push(`- threshold verdict: ${summary.ok ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('## Cases');
  lines.push('');
  lines.push('| Case | Verdict | HTTP | Product | Language | Travel Local | Risk | Failures |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const result of results) {
    const failures = result.assessment.failure_reasons.join(', ') || 'none';
    lines.push(
      `| \`${result.case_id}\` | ${result.assessment.pass ? 'PASS' : 'FAIL'} | ${result.assessment.http_pass ? 'PASS' : 'FAIL'} | ${result.assessment.product_pass ? 'PASS' : 'FAIL'} | ${result.assessment.language_pass ? 'PASS' : 'FAIL'} | ${result.assessment.travel_local_quality?.enabled ? (result.assessment.travel_local_quality.pass ? 'PASS' : 'FAIL') : 'n/a'} | ${result.assessment.risk_guard.pass ? 'PASS' : 'FAIL'} | ${failures} |`,
    );
  }
  lines.push('');
  lines.push('## Failed Checks');
  lines.push('');
  for (const result of results.filter((item) => !item.assessment.pass)) {
    lines.push(`### ${result.case_id}`);
    for (const row of result.rows) {
      const rowFailures = [];
      if (!row.ok) rowFailures.push(`HTTP ${row.status}`);
      if (!row.schema_valid) rowFailures.push(row.schema_error || 'schema');
      if (row.product_assessment && !row.product_assessment.pass) {
        rowFailures.push(
          `product relevance ${row.product_assessment.relevant_top6}/${row.product_assessment.min_relevant_top6}`,
        );
      }
      if (row.category_check && !row.category_check.pass) rowFailures.push('creator category check');
      if (row.degradation && row.degradation.degraded) {
        rowFailures.push(`degraded ${row.degradation.reasons.join(',')}`);
      }
      if (row.language_assessment && !row.language_assessment.pass) {
        rowFailures.push(`language ${row.language_assessment.reason}`);
      }
      if (rowFailures.length) {
        lines.push(`- ${row.step_id} (${row.agent}): ${rowFailures.join('; ')}; raw=${row.raw_file}`);
      }
    }
    const failedTravelLocal = result.assessment.travel_local_quality?.enabled
      ? result.assessment.travel_local_quality.checks.filter((check) => !check.pass)
      : [];
    for (const check of failedTravelLocal) {
      lines.push(`- travel-local ${check.kind}: ${JSON.stringify(check.terms || check.failed_rows || check)}`);
    }
    const failedRisk = result.assessment.risk_guard.checks.filter((check) => !check.pass);
    for (const check of failedRisk) {
      lines.push(`- risk ${check.kind}: ${JSON.stringify(check.terms)}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function compactResults(results) {
  return results.map((result) => ({
    case_id: result.case_id,
    persona: result.persona,
    expected_assertions: result.expected_assertions,
    assessment: result.assessment,
    rows: result.rows.map((row) => ({
      case_id: row.case_id,
      step_id: row.step_id,
      agent: row.agent,
      route: row.route,
      query: row.query,
      status: row.status,
      ok: row.ok,
      latency_ms: row.latency_ms,
      schema_valid: row.schema_valid,
      schema_error: row.schema_error,
      transport_error: row.transport_error,
      assistant_text: row.assistant_text,
      card_types: row.card_types,
      follow_up_questions: row.follow_up_questions,
      product_titles: row.product_titles,
      product_ids: row.product_ids,
      query_source: row.query_source,
      decision_authority: row.decision_authority,
      request_id: row.request_id,
      reply: row.reply,
      raw_file: row.raw_file,
      product_assessment: row.product_assessment,
      category_check: row.category_check,
      degradation: row.degradation,
      language_assessment: row.language_assessment,
    })),
  }));
}

function validateDataset(dataset) {
  const errors = [];
  if (!isPlainObject(dataset)) errors.push('dataset_not_object');
  if (String(dataset.schema_version || '') !== 'beauty_cross_agent_multiturn.v1') {
    errors.push('schema_version_mismatch');
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) errors.push('cases_missing');
  for (const [index, testCase] of (dataset.cases || []).entries()) {
    const prefix = `cases[${index}]`;
    for (const key of ['case_id', 'persona', 'profile', 'turns', 'agent_routes', 'shopping_queries', 'creator_queries', 'expected_assertions', 'risk_guards']) {
      if (testCase[key] === undefined) errors.push(`${prefix}.${key}_missing`);
    }
    if (!Array.isArray(testCase.turns) || testCase.turns.length < 1) errors.push(`${prefix}.turns_empty`);
    if (!Array.isArray(testCase.shopping_queries) || testCase.shopping_queries.length < 1) errors.push(`${prefix}.shopping_queries_empty`);
    if (!Array.isArray(testCase.creator_queries) || testCase.creator_queries.length < 1) errors.push(`${prefix}.creator_queries_empty`);
  }
  return errors;
}

async function runBatch(args = parseArgs(process.argv)) {
  const datasetPath = path.resolve(ROOT, String(args.dataset || args.cases || DEFAULT_DATASET));
  const dataset = readJson(datasetPath, 'beauty cross-agent dataset');
  const validationErrors = validateDataset(dataset);
  if (validationErrors.length) {
    throw new Error(`dataset validation failed: ${validationErrors.join(', ')}`);
  }

  const defaults = isPlainObject(dataset.defaults) ? dataset.defaults : {};
  const baseUrl = String(args['base-url'] || args.base || defaults.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const runId = String(args['run-id'] || nowStamp());
  const outRoot = path.resolve(ROOT, String(args['out-dir'] || DEFAULT_OUT_ROOT));
  const outDir = path.join(outRoot, runId);
  const rawDir = path.join(outDir, 'raw');
  ensureDir(rawDir);

  const caseFilter = new Set(
    String(args['case-id'] || args.case || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const cases = dataset.cases.filter((testCase) => caseFilter.size === 0 || caseFilter.has(testCase.case_id));
  if (!cases.length) throw new Error('no cases selected');

  const context = {
    baseUrl,
    runId,
    rawDir,
    auroraTimeoutMs: Number(args['aurora-timeout-ms'] || DEFAULT_AURORA_TIMEOUT_MS),
    invokeTimeoutMs: Number(args['invoke-timeout-ms'] || DEFAULT_INVOKE_TIMEOUT_MS),
    delayMs: Number(args['delay-ms'] || DEFAULT_DELAY_MS),
    agentApiKey: String(
      args['agent-api-key'] ||
        process.env.PROD_AGENT_API_KEY ||
        process.env.PRODUCTION_AGENT_API_KEY ||
        process.env.AGENT_API_KEY ||
        process.env.STAGING_AGENT_API_KEY ||
        process.env.SHOP_AGENT_API_KEY ||
        '',
    ).trim(),
    authToken: String(args['auth-token'] || process.env.AUTH_TOKEN || process.env.STAGING_AUTH_TOKEN || '').trim(),
    market: String(args.market || defaults.market || 'US'),
    creatorId: String(args['creator-id'] || defaults.creator_id || 'nina-studio'),
    creatorView: String(args['creator-view'] || defaults.creator_view || 'GLOBAL_BEAUTY'),
  };

  const results = [];
  for (const testCase of cases) {
    process.stderr.write(`[beauty_cross_agent] running ${testCase.case_id}\n`);
    results.push(await runCase({ caseDef: testCase, context }));
  }

  const summary = computeSummary(dataset, results);
  const report = {
    schema_version: 'beauty_cross_agent_batch_report.v1',
    generated_at: new Date().toISOString(),
    run_id: runId,
    base_url: baseUrl,
    dataset_path: relativeToRoot(datasetPath),
    dataset_sha256: crypto.createHash('sha256').update(fs.readFileSync(datasetPath)).digest('hex'),
    summary,
    results: compactResults(results),
  };

  const jsonPath = path.join(outDir, 'beauty_cross_agent_summary.json');
  const markdownPath = path.join(outDir, 'beauty_cross_agent_summary.md');
  const csvPath = path.join(outDir, 'human_review.csv');
  const jsonlPath = path.join(outDir, 'responses.jsonl');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, renderMarkdown({ runId, baseUrl, datasetPath, summary, results }), 'utf8');
  fs.writeFileSync(csvPath, renderHumanReviewCsv(results), 'utf8');
  fs.writeFileSync(
    jsonlPath,
    `${results.flatMap((result) => result.rows.map((row) => JSON.stringify({
      case_id: result.case_id,
      step_id: row.step_id,
      agent: row.agent,
      status: row.status,
      ok: row.ok,
      schema_valid: row.schema_valid,
      query: row.query,
      reply: row.reply,
      product_titles: row.product_titles,
      language_assessment: row.language_assessment,
      request_id: row.request_id,
      raw_file: row.raw_file,
    }))).join('\n')}\n`,
    'utf8',
  );

  const output = {
    ok: summary.ok,
    run_id: runId,
    json_path: jsonPath,
    markdown_path: markdownPath,
    human_review_csv: csvPath,
    responses_jsonl: jsonlPath,
    summary,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);

  const failOnThreshold =
    String(args['fail-on-threshold'] || process.env.BEAUTY_CROSS_AGENT_FAIL_ON_THRESHOLD || '').toLowerCase() === 'true';
  if (failOnThreshold && !summary.ok) process.exitCode = 1;
  return output;
}

if (require.main === module) {
  runBatch().catch((err) => {
    process.stderr.write(`[beauty_cross_agent] fatal: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  validateDataset,
  evaluateProductRelevance,
  evaluateRiskGuards,
  evaluateResponseLanguageMatch,
  evaluateTravelLocalQuality,
  validateResponseSchema,
  classifyResponseDegradation,
  computeSummary,
  runBatch,
};
