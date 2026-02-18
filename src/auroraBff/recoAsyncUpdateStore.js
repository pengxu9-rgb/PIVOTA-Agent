const crypto = require('crypto');
const { buildCandidateKey } = require('./recoInterleave');

const tickets = new Map();
const trackingSnapshots = new Map();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nowMs() {
  return Date.now();
}

function safeInt(value, fallback, min, max) {
  const n = Number(value);
  const out = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, out));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function pruneExpired(currentMs = nowMs()) {
  for (const [key, state] of tickets.entries()) {
    if (!state || Number(state.expires_at_ms || 0) <= currentMs) tickets.delete(key);
  }
  for (const [key, state] of trackingSnapshots.entries()) {
    if (!state || Number(state.expires_at_ms || 0) <= currentMs) trackingSnapshots.delete(key);
  }
}

function blockCandidates(payload, block) {
  const blockObj = isPlainObject(payload?.[block]) ? payload[block] : {};
  return Array.isArray(blockObj.candidates) ? blockObj.candidates : [];
}

function reorderWithTopLock(existingRows, nextRows, lockTopN) {
  const existing = Array.isArray(existingRows) ? existingRows : [];
  const next = Array.isArray(nextRows) ? nextRows : [];
  const lockN = Math.max(0, Math.min(12, Number.isFinite(Number(lockTopN)) ? Math.trunc(Number(lockTopN)) : 0));

  if (!lockN) return next.slice();
  const nextByKey = new Map();
  for (let i = 0; i < next.length; i += 1) {
    const key = buildCandidateKey(next[i], i);
    if (!key || nextByKey.has(key)) continue;
    nextByKey.set(key, next[i]);
  }
  const locked = existing.slice(0, lockN).map((row, idx) => {
    const key = buildCandidateKey(row, idx);
    return nextByKey.get(key) || row;
  });
  const lockedKeys = new Set(locked.map((row, idx) => buildCandidateKey(row, idx)));

  const out = [...locked];
  for (let i = 0; i < next.length; i += 1) {
    const row = next[i];
    const key = buildCandidateKey(row, i);
    if (lockedKeys.has(key)) continue;
    out.push(row);
  }

  for (let i = lockN; i < existing.length; i += 1) {
    const row = existing[i];
    const key = buildCandidateKey(row, i);
    if (lockedKeys.has(key)) continue;
    if (out.some((x, idx) => buildCandidateKey(x, idx) === key)) continue;
    out.push(row);
  }

  return out;
}

function createAsyncTicket({ requestId, cardId, lockTopN, initialPayload, ttlMs } = {}) {
  pruneExpired();
  const payload = isPlainObject(initialPayload) ? clone(initialPayload) : {};
  const ticketId = crypto.randomUUID();
  const createdAt = nowMs();
  const ttl = safeInt(ttlMs, 600000, 5000, 3600000);
  const state = {
    ticket_id: ticketId,
    request_id: String(requestId || '').trim() || null,
    card_id: String(cardId || '').trim() || null,
    lock_top_n: safeInt(lockTopN, 3, 0, 12),
    payload,
    version: 1,
    created_at_ms: createdAt,
    updated_at_ms: createdAt,
    expires_at_ms: createdAt + ttl,
    updates: [],
  };
  tickets.set(ticketId, state);
  return { ticketId, version: state.version };
}

function applyAsyncBlockPatch({ ticketId, block, nextCandidates } = {}) {
  pruneExpired();
  const state = tickets.get(String(ticketId || '').trim());
  if (!state) return { applied: false, changedCount: 0, version: 0, reason: 'ticket_missing' };
  const blockName = String(block || '').trim();
  if (!blockName || !['competitors', 'related_products', 'dupes'].includes(blockName)) {
    return { applied: false, changedCount: 0, version: state.version, reason: 'invalid_block' };
  }

  const existing = blockCandidates(state.payload, blockName);
  const next = Array.isArray(nextCandidates) ? nextCandidates : [];
  const reordered = reorderWithTopLock(existing, next, state.lock_top_n);

  const existingKeys = existing.map((row, idx) => buildCandidateKey(row, idx));
  const nextKeys = reordered.map((row, idx) => buildCandidateKey(row, idx));
  const keyOrderChanged = existingKeys.join('|') !== nextKeys.join('|');
  const contentChanged = stableJson(existing) !== stableJson(reordered);
  const changed = keyOrderChanged || contentChanged;
  if (!changed) {
    state.updated_at_ms = nowMs();
    return { applied: false, changedCount: 0, version: state.version, reason: 'no_change' };
  }

  const changedCount = Math.max(existing.length, reordered.length);
  state.payload = {
    ...state.payload,
    [blockName]: {
      ...(isPlainObject(state.payload?.[blockName]) ? state.payload[blockName] : {}),
      candidates: clone(reordered),
    },
  };
  state.version += 1;
  state.updated_at_ms = nowMs();
  state.updates.push({
    version: state.version,
    block: blockName,
    changed_count: changedCount,
    updated_at_ms: state.updated_at_ms,
  });

  return { applied: true, changedCount, version: state.version };
}

function getAsyncUpdates({ ticketId, sinceVersion } = {}) {
  pruneExpired();
  const state = tickets.get(String(ticketId || '').trim());
  if (!state) return { ok: false, reason: 'ticket_missing', version: 0 };
  const since = safeInt(sinceVersion, 0, 0, 1000000);
  if (since >= state.version) {
    return {
      ok: true,
      version: state.version,
      has_update: false,
      expires_at_ms: state.expires_at_ms,
    };
  }
  return {
    ok: true,
    version: state.version,
    has_update: true,
    expires_at_ms: state.expires_at_ms,
    payload_patch: {
      competitors: state.payload.competitors,
      related_products: state.payload.related_products,
      dupes: state.payload.dupes,
      provenance: state.payload.provenance,
    },
  };
}

function trackingKey({ requestId, sessionId }) {
  return `${String(requestId || '').trim()}::${String(sessionId || '').trim()}`;
}

function registerRecoTrackingSnapshot({
  requestId,
  sessionId,
  anchorProductId,
  blocks,
  interleaveAttribution,
  explorationKeys,
  trackingByBlock,
  ttlMs,
} = {}) {
  pruneExpired();
  const key = trackingKey({ requestId, sessionId });
  const now = nowMs();
  const expiresAt = now + safeInt(ttlMs, 86400000, 60000, 7 * 86400000);
  const byBlock = {};
  const trackingSrc = isPlainObject(trackingByBlock) ? trackingByBlock : null;
  const attributionRaw = isPlainObject(interleaveAttribution) ? interleaveAttribution : {};
  const explorationRaw = isPlainObject(explorationKeys) ? explorationKeys : null;
  const globalExploreSet = new Set(
    Array.isArray(explorationKeys) ? explorationKeys.map((x) => String(x).toLowerCase()) : [],
  );

  for (const blockName of ['competitors', 'related_products', 'dupes']) {
    const rows = Array.isArray(blocks?.[blockName]) ? blocks[blockName] : [];
    const map = {};

    if (trackingSrc && isPlainObject(trackingSrc[blockName])) {
      for (const [candKeyRaw, metaRaw] of Object.entries(trackingSrc[blockName])) {
        const candKey = String(candKeyRaw || '').trim().toLowerCase();
        if (!candKey) continue;
        const meta = isPlainObject(metaRaw) ? metaRaw : {};
        map[candKey] = {
          rank_position: Number.isFinite(Number(meta.rank_position)) ? Math.max(1, Math.trunc(Number(meta.rank_position))) : 1,
          attribution: ['A', 'B', 'both', 'explore'].includes(String(meta.attribution || '')) ? meta.attribution : 'both',
          was_exploration_slot: meta.was_exploration_slot === true,
        };
      }
      byBlock[blockName] = map;
      continue;
    }

    const blockAttr = isPlainObject(attributionRaw[blockName]) ? attributionRaw[blockName] : attributionRaw;
    const blockExploreSet = explorationRaw && Array.isArray(explorationRaw[blockName])
      ? new Set(explorationRaw[blockName].map((x) => String(x).toLowerCase()))
      : globalExploreSet;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const candKey = buildCandidateKey(row, i);
      map[candKey] = {
        rank_position: i + 1,
        attribution: ['A', 'B', 'both', 'explore'].includes(String(blockAttr[candKey] || ''))
          ? blockAttr[candKey]
          : 'both',
        was_exploration_slot: blockExploreSet.has(candKey),
      };
    }
    byBlock[blockName] = map;
  }

  trackingSnapshots.set(key, {
    request_id: String(requestId || '').trim(),
    session_id: String(sessionId || '').trim(),
    anchor_product_id: String(anchorProductId || '').trim() || null,
    by_block: byBlock,
    created_at_ms: now,
    updated_at_ms: now,
    expires_at_ms: expiresAt,
  });
}

function getRecoTrackingMetadata({ requestId, sessionId, block, candidateProductId, candidateName } = {}) {
  pruneExpired();
  const key = trackingKey({ requestId, sessionId });
  const snapshot = trackingSnapshots.get(key);
  if (!snapshot) return null;
  const blockName = String(block || '').trim();
  const map = isPlainObject(snapshot.by_block?.[blockName]) ? snapshot.by_block[blockName] : {};
  const lookupKey = String(candidateProductId || candidateName || '').trim().toLowerCase();
  if (!lookupKey) return null;

  if (map[lookupKey]) return map[lookupKey];
  // fallback fuzzy by suffix on product id/name
  const entry = Object.entries(map).find(([candKey]) => candKey.includes(lookupKey));
  return entry ? entry[1] : null;
}

module.exports = {
  createAsyncTicket,
  applyAsyncBlockPatch,
  getAsyncUpdates,
  registerRecoTrackingSnapshot,
  getRecoTrackingMetadata,
  __internal: {
    tickets,
    trackingSnapshots,
    pruneExpired,
    reorderWithTopLock,
  },
};
