const Redis = require('ioredis');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'recommend-session' });

const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const CAPS = {
  seen: 50,
  hidden: 50,
  rejectedBrands: 30,
};

let client = null;
let inMemoryStore = new Map();

function initRedis() {
  if (client || process.env.REDIS_DISABLED === 'true') return;
  const url = process.env.REDIS_URL;
  const host = process.env.REDIS_HOST;
  if (url || host) {
    client = new Redis(url || { host });
    client.on('error', (err) => logger.warn({ err }, 'Redis error'));
  }
}

function keyFor(userId, anonId, creatorId, surface) {
  const base = `${userId || anonId || 'anon'}:${creatorId || 'global'}`;
  return surface ? `${base}:${surface}` : base;
}

function capList(arr, cap) {
  const deduped = Array.from(new Set(arr));
  return deduped.slice(-cap);
}

function defaultState() {
  return {
    seen_product_ids: [],
    hidden_product_ids: [],
    rejected_brand_ids: [],
    answered_slots: {},
    last_question_id: null,
    last_intent: null,
  };
}

async function getState(userId, anonId, creatorId, surface) {
  initRedis();
  const key = keyFor(userId, anonId, creatorId, surface);
  if (client) {
    const val = await client.get(key);
    if (val) {
      try {
        return JSON.parse(val);
      } catch (err) {
        logger.warn({ err }, 'Failed parsing session');
      }
    }
  } else if (inMemoryStore.has(key)) {
    return inMemoryStore.get(key);
  }
  return defaultState();
}

async function saveState(userId, anonId, creatorId, surface, state) {
  initRedis();
  const key = keyFor(userId, anonId, creatorId, surface);
  if (client) {
    await client.set(key, JSON.stringify(state), 'EX', TTL_SECONDS);
  } else {
    inMemoryStore.set(key, state);
  }
}

function mergeAnonToUser(anonState, userState) {
  return {
    seen_product_ids: capList([...(userState.seen_product_ids || []), ...(anonState.seen_product_ids || [])], CAPS.seen),
    hidden_product_ids: capList([...(userState.hidden_product_ids || []), ...(anonState.hidden_product_ids || [])], CAPS.hidden),
    rejected_brand_ids: capList(
      [...(userState.rejected_brand_ids || []), ...(anonState.rejected_brand_ids || [])],
      CAPS.rejectedBrands,
    ),
    answered_slots: { ...(userState.answered_slots || {}), ...(anonState.answered_slots || {}) },
    last_question_id: userState.last_question_id || anonState.last_question_id || null,
    last_intent: userState.last_intent || anonState.last_intent || null,
  };
}

function applyEvents(state, events = []) {
  const next = { ...state };
  next.seen_product_ids = capList(next.seen_product_ids || [], CAPS.seen);
  next.hidden_product_ids = capList(next.hidden_product_ids || [], CAPS.hidden);
  next.rejected_brand_ids = capList(next.rejected_brand_ids || [], CAPS.rejectedBrands);

  events.forEach((e) => {
    if (!e || !e.type) return;
    switch (e.type) {
      case 'CLICK':
        if (e.product_id) {
          next.seen_product_ids = capList([...(next.seen_product_ids || []), e.product_id], CAPS.seen);
        }
        break;
      case 'HIDE':
        if (e.product_id) {
          next.hidden_product_ids = capList([...(next.hidden_product_ids || []), e.product_id], CAPS.hidden);
        }
        break;
      case 'DISLIKE_BRAND':
        if (e.brand_id) {
          next.rejected_brand_ids = capList([...(next.rejected_brand_ids || []), e.brand_id], CAPS.rejectedBrands);
        }
        break;
      case 'ADD_TO_CART':
        if (e.product_id) {
          next.seen_product_ids = capList([...(next.seen_product_ids || []), e.product_id], CAPS.seen);
        }
        break;
      default:
        break;
    }
  });

  return next;
}

module.exports = {
  TTL_SECONDS,
  CAPS,
  getState,
  saveState,
  mergeAnonToUser,
  applyEvents,
};
