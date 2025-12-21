const axios = require('axios');
const pino = require('pino');
const { rerankCandidates, availabilityScore } = require('./rerank');
const { sanitizeProduct, SANITIZER_VERSION } = require('./sanitizer');
const { loadCopyPack } = require('./copyPacks');
const { pickQuestion } = require('./questionBank');
const { maybeGenerateCopy } = require('./modelRouter');
const { validateCopyOverrides } = require('./validators');
const { getState, saveState, mergeAnonToUser, applyEvents } = require('./session');
const { ERROR_CODES } = require('./errors');
const { detectAllowOOS } = require('./intent');

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'recommend' });

const API_BASE = (process.env.PIVOTA_API_BASE || 'http://localhost:8080').replace(/\/$/, '');
const API_KEY = process.env.PIVOTA_API_KEY || '';
const MAX_RESULTS = 8;
const AVAIL_TTL_MS = Number(process.env.RECOMMEND_AVAIL_TTL_MS || 5 * 60 * 1000);
const PRICE_TTL_MS = Number(process.env.RECOMMEND_PRICE_TTL_MS || 10 * 60 * 1000);
const MISSION_MAX_CHARS = Number(process.env.RECOMMEND_MISSION_MAX_CHARS || 500);
const REFINEMENT_MAX_CHARS = Number(process.env.RECOMMEND_REFINEMENT_MAX_CHARS || 60);

function isSuspiciousInput(text) {
  if (!text) return false;
  const lowered = text.toLowerCase();
  return lowered.includes('ignore instructions') || lowered.includes('system prompt') || lowered.includes('ignore previous');
}

function capText(text, maxChars) {
  if (!text) return '';
  if (!maxChars || maxChars <= 0) return String(text);
  const str = String(text);
  return str.length > maxChars ? str.slice(0, maxChars) : str;
}

function normalizeMessage(text) {
  return String(text || '').trim();
}

function isExplicitGoalSwitch(text) {
  const t = normalizeMessage(text).toLowerCase();
  if (!t) return false;
  // English
  if (t.includes('ignore that') || t.includes('ignore this') || t.includes('new request') || t.includes('change topic')) return true;
  if (t.startsWith('instead,') || t.startsWith('actually,') || t.startsWith('scratch that')) return true;
  // Chinese
  if (t.includes('不管了') || t.includes('忽略') || t.includes('换成') || t.includes('改成') || t.includes('另外')) return true;
  // Japanese
  if (t.includes('やっぱり') || t.includes('別の') || t.includes('別件')) return true;
  // Spanish / French
  if (t.includes('olvida') || t.includes('cambiemos') || t.includes('oublie') || t.includes('changeons')) return true;
  return false;
}

function isLowSignalAck(text) {
  const raw = normalizeMessage(text);
  if (!raw) return true;
  if (raw.length < 3) return true;
  const t = raw.toLowerCase();
  const acks = new Set([
    'ok', 'okay', 'kk', 'sure', 'thanks', 'thank you', 'thx', 'ty', 'got it', 'cool', 'nice', 'great',
    'merci', 'd’accord', "d'accord", 'ok merci',
    'gracias', 'vale',
    '谢谢', '好的', '行', '明白了',
    'ありがとう', '了解', 'はい',
  ]);
  return acks.has(t);
}

function deriveEffectiveQuery(message, state, { freezePersonalization }) {
  const msg = normalizeMessage(message);
  const prevMission = normalizeMessage(state?.mission_query || '');

  if (!prevMission) {
    return { effectiveQuery: msg, nextMission: capText(msg, MISSION_MAX_CHARS) || null };
  }

  if (freezePersonalization) {
    // If we suspect prompt injection, don't reuse prior mission text.
    return { effectiveQuery: msg, nextMission: prevMission || null };
  }

  if (isExplicitGoalSwitch(msg)) {
    return { effectiveQuery: msg, nextMission: capText(msg, MISSION_MAX_CHARS) || null };
  }

  if (isLowSignalAck(msg)) {
    return { effectiveQuery: prevMission, nextMission: prevMission || null };
  }

  // Heuristic: short follow-ups are usually refinements (budget/size/material/etc).
  if (msg.length <= REFINEMENT_MAX_CHARS) {
    const combined = capText(`${prevMission}; refinement: ${msg}`, MISSION_MAX_CHARS);
    return { effectiveQuery: combined, nextMission: combined || prevMission || null };
  }

  // Long messages are more likely new missions.
  return { effectiveQuery: msg, nextMission: capText(msg, MISSION_MAX_CHARS) || null };
}

async function callFindProductsMulti(query, locale) {
  const payload = {
    operation: 'find_products_multi',
    payload: {
      search: {
        query: query || '',
        limit: MAX_RESULTS * 2,
        page: 1,
        in_stock_only: false,
      },
    },
    metadata: {
      locale,
    },
  };
  const headers = {
    'Content-Type': 'application/json',
  };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  const res = await axios.post(`${API_BASE}/agent/shop/v1/invoke`, payload, { headers, timeout: 5000 });
  if (res.status !== 200) {
    throw new Error(`Upstream status ${res.status}`);
  }
  return res.data;
}

function mapAvailability(avail) {
  const status = avail?.status || 'UNKNOWN';
  const quantity = avail?.quantity ?? null;
  const availability_text =
    status === 'IN_STOCK'
      ? 'In stock'
      : status === 'LOW_STOCK'
        ? 'Low stock'
        : status === 'OUT_OF_STOCK'
          ? 'Out of stock'
          : 'Check availability';
  return { status, quantity, availability_text, updated_at_ms: avail?.updated_at_ms || null };
}

function mapCandidate(item) {
  const sanitized = sanitizeProduct(item);
  return {
    product_id: item.product_id,
    brand: item.brand,
    category: item.category,
    price: item.price,
    availability: item.availability,
    urls: item.urls,
    images: item.images,
    attributes: item.attributes,
    metadata_proofs: item.metadata_proofs || {},
    signals: item.signals || {},
    recall: item.recall || {},
    sanitized,
    reason_codes: item.recall?.strategy ? [item.recall.strategy] : [],
  };
}

function buildCards(items, staleFlags) {
  return items.map((item) => {
    const availability = mapAvailability(item.availability);
    const availability_text =
      staleFlags.avail || (availability.updated_at_ms && Date.now() - availability.updated_at_ms > AVAIL_TTL_MS)
        ? 'Check availability'
        : availability.availability_text;
    const price_stale =
      staleFlags.price ||
      (item.price?.updated_at_ms && Date.now() - item.price.updated_at_ms > PRICE_TTL_MS);
    return {
      product_id: item.product_id,
      safe_display_name: item.sanitized.safe_display_name,
      safe_name_parts: item.sanitized.safe_name_parts,
      price_display: item.price?.display,
      price_stale: Boolean(price_stale),
      availability_text,
      image_url: item.images?.[0]?.url || null,
      buy_url: item.urls?.buy_url || item.urls?.product_url || null,
      primary_action: item.urls?.buy_url
        ? { type: 'BUY', url: item.urls.buy_url }
        : { type: 'VIEW', url: item.urls?.product_url || null },
      badges: [],
      tracking: { recall: item.recall?.strategy || 'unknown' },
    };
  });
}

function stripDebugPayload(payload, req) {
  const internalAllowed =
    process.env.INTERNAL_DEBUG_ENABLED === 'true' &&
    req.headers['x-internal-debug'] &&
    req.headers['x-internal-debug'] === process.env.INTERNAL_DEBUG_TOKEN;
  if (process.env.NODE_ENV === 'production' || !internalAllowed) {
    if (payload.debug_info) delete payload.debug_info;
    if (payload.meta && payload.meta.debug_info) delete payload.meta.debug_info;
  }
  return payload;
}

function buildDefaultCopy(cards, copyPack) {
  return {
    intro_text: copyPack.intro_text,
    items: cards.map((card) => ({
      product_id: card.product_id,
      headline_tmpl: copyPack.headline_tmpl.replace('{{NAME}}', '{{NAME}}'),
      copy_tmpl: copyPack.copy_tmpl,
      highlights: copyPack.highlight_tmpls.slice(0, 3),
    })),
    follow_up_question_id: null,
  };
}

async function recommendHandler(req, res) {
  const trace_id = req.body.trace_id || req.headers['x-request-id'] || `trace_${Date.now()}`;
  const creator_id = req.body.creator_id;
  const user_id = req.body.user_id || null;
  const anon_id = req.body.anon_id || null;
  const locale = req.body.locale || 'en-US';
  const message = req.body.message || '';
  const events = req.body.events || [];
  const source = req.body.source || 'creator_chatbox';

  const suspicious = isSuspiciousInput(message);
  const allowOOS = detectAllowOOS(message, {});

  const baseMeta = {
    trace_id,
    creator_id,
    route_reason: null,
    llm_used: false,
    llm_skip_reason: null,
    sanitizer_version: SANITIZER_VERSION,
    stale_label_applied: false,
    stale_price_label_applied: false,
    dropped_oos_count: 0,
    filtered_hidden_count: 0,
    filtered_seen_count: 0,
    allow_oos: allowOOS,
    refresh_attempted: false,
    refresh_checked_count: 0,
    refresh_budget_exceeded: false,
  };
  baseMeta.allow_oos = allowOOS;

  try {
    // Session handling
    const userState = user_id ? await getState(user_id, null, creator_id, source) : null;
    const anonState = anon_id ? await getState(null, anon_id, creator_id, source) : null;
    const mergedState =
      user_id && anon_id
        ? mergeAnonToUser(anonState || {}, userState || {})
        : user_id
          ? userState || {}
          : anon_id
            ? anonState || {}
            : {};
    const freezePersonalization = suspicious;
    const stateAfterEvents = freezePersonalization ? mergedState : applyEvents(mergedState, events);

    const { effectiveQuery, nextMission } = deriveEffectiveQuery(message, stateAfterEvents, { freezePersonalization });

    // Recall
    const recallResp = await callFindProductsMulti(effectiveQuery, locale);
    const candidatesRaw = recallResp.items || [];
    const candidates = candidatesRaw.map(mapCandidate);
    if (!candidates.length) {
      logger.warn({ trace_id }, 'Recall empty');
      return res.status(200).json({
        trace_id,
        cards: [],
        copy_overrides: null,
        question: null,
        state_delta: {},
        meta: { ...baseMeta, route_reason: ERROR_CODES.RECALL_EMPTY },
        error: ERROR_CODES.RECALL_EMPTY,
      });
    }

    // Rerank
    const rerankResult = rerankCandidates(candidates, {
      seenProductIds: stateAfterEvents.seen_product_ids,
      hiddenProductIds: stateAfterEvents.hidden_product_ids,
      rejectedBrandIds: stateAfterEvents.rejected_brand_ids,
      limit: MAX_RESULTS,
      allowOutOfStock: allowOOS,
      trackDrops: true,
    });
    const reranked = rerankResult.results;

    if (!reranked.length) {
      return res.status(200).json({
        trace_id,
        cards: [],
        copy_overrides: null,
        question: null,
        state_delta: {},
        meta: { ...baseMeta, route_reason: ERROR_CODES.RERANK_EMPTY },
        error: ERROR_CODES.RERANK_EMPTY,
      });
    }

    // Staleness handling
    let staleLabelApplied = false;
    let stalePriceLabelApplied = false;
    const now = Date.now();
    const refreshed = reranked.map((item) => {
      const updatedAt = item.availability?.updated_at_ms || 0;
      if (updatedAt && now - updatedAt > AVAIL_TTL_MS) {
        staleLabelApplied = true;
      }
      const priceUpdated = item.price?.updated_at_ms || 0;
      if (priceUpdated && now - priceUpdated > PRICE_TTL_MS) {
        stalePriceLabelApplied = true;
      }
      return item;
    });

    // Cards (truth)
    const cards = buildCards(refreshed, { avail: staleLabelApplied, price: stalePriceLabelApplied });
    const expectedProductIds = cards.map((c) => c.product_id);

    // Default copy pack
    const copyPack = loadCopyPack(creator_id);
    let copy_overrides = buildDefaultCopy(cards, copyPack);

    // Question
    const question = pickQuestion(stateAfterEvents);
    if (question) {
      copy_overrides.follow_up_question_id = question.id;
    }

    // Optional LLM overlay
    const allowLlm = Boolean(process.env.RECOMMEND_LLM_ENABLED) && !suspicious;
    const llmResult = await maybeGenerateCopy({
      items: refreshed.map((r) => ({
        product_id: r.product_id,
        safe_display_name: r.sanitized.safe_display_name,
        safe_features: r.sanitized.safe_features,
        reason_codes: r.reason_codes,
      })),
      persona: {
        tone_tag: 'warm',
        emoji_level: 1,
        signature_phrases: [],
        allowed_emojis: [],
      },
      copyPack,
      allow: allowLlm,
      expectedProductIds,
      maxItems: expectedProductIds.length,
      requireExactCount: true,
    });

    if (llmResult.used && llmResult.copy) {
      const val = validateCopyOverrides(llmResult.copy, expectedProductIds, expectedProductIds.length, true);
      if (val.valid) {
        copy_overrides = llmResult.copy;
      }
    } else if (!allowLlm) {
      baseMeta.llm_skip_reason = llmResult.skipReason || 'DISABLED';
    } else if (suspicious) {
      baseMeta.llm_skip_reason = 'SUSPICIOUS_INPUT';
    } else {
      baseMeta.llm_skip_reason = llmResult.skipReason;
    }

    // State delta (seen products)
    const recommendedIds = cards.map((c) => c.product_id);
    const state_delta = {
      seen_product_ids_add: recommendedIds,
      answered_slots_update: {},
      last_question_id: question?.id || null,
      last_intent: null,
    };

    if (!freezePersonalization) {
      const finalState = {
        ...stateAfterEvents,
        seen_product_ids: Array.from(new Set([...(stateAfterEvents.seen_product_ids || []), ...recommendedIds])).slice(
          -50,
        ),
        last_question_id: question?.id || stateAfterEvents.last_question_id || null,
        mission_query: nextMission,
      };
      await saveState(user_id, anon_id, creator_id, source, finalState);
    }

    const response = {
      trace_id,
      cards,
      copy_overrides,
      question: question
        ? { question_id: question.id, chips: question.chips }
        : null,
      state_delta,
      meta: {
        ...baseMeta,
        llm_used: llmResult.used,
        llm_skip_reason: llmResult.skipReason || baseMeta.llm_skip_reason,
        route_reason: allowLlm ? 'DEFAULT' : 'LLM_DISABLED',
        sanitizer_version: SANITIZER_VERSION,
        stale_label_applied: staleLabelApplied,
        stale_price_label_applied: stalePriceLabelApplied,
        dropped_oos_count: rerankResult.droppedOos || 0,
        filtered_hidden_count: rerankResult.filteredHidden || 0,
        filtered_seen_count: rerankResult.filteredSeen || 0,
        allow_oos: allowOOS,
        refresh_attempted: true,
        refresh_checked_count: refreshed.length,
        refresh_budget_exceeded: false,
      },
      error: null,
    };

    logger.info({
      trace_id,
      creator_id,
      llm_used: response.meta.llm_used,
      llm_skip_reason: response.meta.llm_skip_reason,
      route_reason: response.meta.route_reason,
      sanitizer_version: SANITIZER_VERSION,
      selected_product_ids: recommendedIds,
    });

    return res.status(200).json(stripDebugPayload(response, req));
  } catch (err) {
    logger.error({ err: err.message, trace_id }, 'recommend failed');
    const errCode =
      err.code === 'ECONNABORTED'
        ? ERROR_CODES.LLM_TIMEOUT
        : ERROR_CODES.PROVIDER_DOWN;
    return res.status(500).json(stripDebugPayload({
      trace_id,
      cards: [],
      copy_overrides: null,
      question: null,
      state_delta: {},
      meta: { ...baseMeta, route_reason: errCode },
      error: errCode,
    }, req));
  }
}

module.exports = {
  recommendHandler,
  buildCards,
  mapCandidate,
};
