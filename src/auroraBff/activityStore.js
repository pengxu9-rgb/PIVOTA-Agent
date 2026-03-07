const { randomUUID } = require('crypto');
const { query } = require('../db');

const EPHEMERAL_MAX_IDENTITIES = (() => {
  const n = Number(process.env.AURORA_ACTIVITY_EPHEMERAL_MAX_IDENTITIES || 200);
  const value = Number.isFinite(n) ? Math.trunc(n) : 200;
  return Math.max(20, Math.min(4000, value));
})();

const EPHEMERAL_MAX_EVENTS_PER_IDENTITY = (() => {
  const n = Number(process.env.AURORA_ACTIVITY_EPHEMERAL_MAX_EVENTS_PER_IDENTITY || 300);
  const value = Number.isFinite(n) ? Math.trunc(n) : 300;
  return Math.max(20, Math.min(5000, value));
})();

const ephemeral = {
  events: new Map(),
};

function nowIso() {
  return new Date().toISOString();
}

function parseRetentionDays() {
  const raw = String(process.env.AURORA_ACTIVITY_RETENTION_DAYS || process.env.AURORA_BFF_RETENTION_DAYS || '90').trim();
  const n = Number(raw);
  if (!Number.isFinite(n)) return 90;
  return Math.max(0, Math.min(365, Math.trunc(n)));
}

function persistenceDisabled() {
  return parseRetentionDays() === 0;
}

function normalizeIdentityValue(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  return value.slice(0, 128);
}

function identityKey({ auroraUid, userId }) {
  const guest = normalizeIdentityValue(auroraUid);
  const user = normalizeIdentityValue(userId);
  if (user) return `u:${user}`;
  if (guest) return `g:${guest}`;
  return null;
}

function touchMap(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > EPHEMERAL_MAX_IDENTITIES) {
    const oldest = map.keys().next().value;
    if (!oldest) break;
    map.delete(oldest);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function isStorageUnavailableError(err) {
  const code = String(err && err.code ? err.code : '').trim();
  if (!code) return false;
  return (
    code === 'NO_DATABASE' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === '42P01' ||
    code === '42P07' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND'
  );
}

function normalizeEventType(input) {
  const value = String(input || '').trim().toLowerCase();
  if (!value) return 'activity_event';
  return value.slice(0, 80);
}

function normalizePayload(input) {
  if (!isPlainObject(input)) return {};
  return input;
}

function normalizeDeeplink(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  return value.slice(0, 2000);
}

function normalizeSource(input) {
  const value = String(input || '').trim().toLowerCase();
  if (!value) return 'unknown';
  return value.slice(0, 80);
}

function normalizeOccurredAtMs(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return Date.now();
  return Math.max(0, Math.trunc(n));
}

function parseListLimit(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

function normalizeEventTypeList(input) {
  const rows = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const raw of rows) {
    const token = normalizeEventType(raw);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 12) break;
  }
  return out;
}

function compareEventsDesc(a, b) {
  const aTs = Number(a && a.occurred_at_ms || 0);
  const bTs = Number(b && b.occurred_at_ms || 0);
  if (aTs !== bTs) return bTs - aTs;
  const aId = String(a && a.activity_id || '');
  const bId = String(b && b.activity_id || '');
  return bId.localeCompare(aId);
}

function encodeCursor(cursor) {
  if (!cursor || !Number.isFinite(Number(cursor.occurred_at_ms))) return null;
  const payload = {
    occurred_at_ms: Math.max(0, Math.trunc(Number(cursor.occurred_at_ms))),
    activity_id: String(cursor.activity_id || ''),
  };
  try {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  } catch {
    return null;
  }
}

function decodeCursor(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  try {
    const json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!json || !Number.isFinite(Number(json.occurred_at_ms))) return null;
    return {
      occurred_at_ms: Math.max(0, Math.trunc(Number(json.occurred_at_ms))),
      activity_id: String(json.activity_id || ''),
    };
  } catch {
    return null;
  }
}

function eventAfterCursor(event, cursor) {
  if (!cursor) return true;
  const ts = Number(event && event.occurred_at_ms || 0);
  if (ts < cursor.occurred_at_ms) return true;
  if (ts > cursor.occurred_at_ms) return false;
  return String(event && event.activity_id || '').localeCompare(String(cursor.activity_id || '')) < 0;
}

function mapRow(row) {
  if (!row || typeof row !== 'object') return null;
  const occurredAtMs = row.occurred_at_ms != null
    ? Number(row.occurred_at_ms)
    : row.occurred_at
      ? Date.parse(String(row.occurred_at))
      : Date.now();
  const createdAt = row.created_at ? new Date(row.created_at).toISOString() : nowIso();
  return {
    activity_id: row.activity_id != null ? String(row.activity_id) : null,
    aurora_uid: normalizeIdentityValue(row.aurora_uid),
    user_id: normalizeIdentityValue(row.user_id),
    event_type: normalizeEventType(row.event_type),
    payload: safeJson(row.payload, safeJson(row.payload_json, {})),
    deeplink: normalizeDeeplink(row.deeplink),
    source: normalizeSource(row.source),
    occurred_at_ms: Number.isFinite(Number(occurredAtMs)) ? Math.max(0, Math.trunc(Number(occurredAtMs))) : Date.now(),
    created_at: createdAt,
  };
}

function toEphemeralRecord({
  activityId,
  auroraUid,
  userId,
  eventType,
  payload,
  deeplink,
  source,
  occurredAtMs,
}) {
  return {
    activity_id: String(activityId || '').trim() || `act_${randomUUID()}`,
    aurora_uid: normalizeIdentityValue(auroraUid),
    user_id: normalizeIdentityValue(userId),
    event_type: normalizeEventType(eventType),
    payload: normalizePayload(payload),
    deeplink: normalizeDeeplink(deeplink),
    source: normalizeSource(source),
    occurred_at_ms: normalizeOccurredAtMs(occurredAtMs),
    created_at: nowIso(),
  };
}

function upsertEphemeralEvent(identity, event) {
  const key = identityKey(identity);
  if (!key) return;
  const current = Array.isArray(ephemeral.events.get(key)) ? ephemeral.events.get(key).slice() : [];
  current.unshift(event);
  current.sort(compareEventsDesc);
  touchMap(ephemeral.events, key, current.slice(0, EPHEMERAL_MAX_EVENTS_PER_IDENTITY));
}

function filterAndPageEvents(events, { limit, cursor, eventTypes }) {
  const n = parseListLimit(limit);
  const typeSet = Array.isArray(eventTypes) && eventTypes.length ? new Set(eventTypes) : null;
  const rows = (Array.isArray(events) ? events : [])
    .filter((row) => row && typeof row === 'object')
    .filter((row) => !typeSet || typeSet.has(normalizeEventType(row.event_type)))
    .sort(compareEventsDesc)
    .filter((row) => eventAfterCursor(row, cursor));

  const page = rows.slice(0, n + 1);
  const hasMore = page.length > n;
  const items = hasMore ? page.slice(0, n) : page;
  const tail = items.length ? items[items.length - 1] : null;
  const nextCursor = hasMore && tail
    ? encodeCursor({ occurred_at_ms: tail.occurred_at_ms, activity_id: tail.activity_id })
    : null;
  return { items, next_cursor: nextCursor };
}

async function appendActivityForIdentity({
  auroraUid,
  userId,
  eventType,
  payload,
  deeplink,
  source,
  occurredAtMs,
} = {}) {
  const identity = {
    auroraUid: normalizeIdentityValue(auroraUid),
    userId: normalizeIdentityValue(userId),
  };
  if (!identity.auroraUid && !identity.userId) return null;

  const normalized = toEphemeralRecord({
    auroraUid: identity.auroraUid,
    userId: identity.userId,
    eventType,
    payload,
    deeplink,
    source,
    occurredAtMs,
  });
  upsertEphemeralEvent(identity, normalized);

  if (persistenceDisabled()) return normalized;

  try {
    const res = await query(
      `
        INSERT INTO aurora_activity_events (
          activity_id,
          aurora_uid,
          user_id,
          event_type,
          payload,
          deeplink,
          source,
          occurred_at_ms
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb,
          $6,
          $7,
          $8
        )
        RETURNING *
      `,
      [
        normalized.activity_id,
        identity.auroraUid,
        identity.userId,
        normalized.event_type,
        JSON.stringify(normalized.payload || {}),
        normalized.deeplink,
        normalized.source,
        normalized.occurred_at_ms,
      ],
    );
    return mapRow(res.rows && res.rows[0]) || normalized;
  } catch (err) {
    if (isStorageUnavailableError(err)) return normalized;
    throw err;
  }
}

async function listActivityForIdentity({
  auroraUid,
  userId,
  limit = 20,
  cursor,
  eventTypes,
} = {}) {
  const identity = {
    auroraUid: normalizeIdentityValue(auroraUid),
    userId: normalizeIdentityValue(userId),
  };
  if (!identity.auroraUid && !identity.userId) return { items: [], next_cursor: null };

  const n = parseListLimit(limit);
  const cursorObj = decodeCursor(cursor);
  const normalizedTypes = normalizeEventTypeList(eventTypes);
  const key = identityKey(identity);
  const localRows = key && Array.isArray(ephemeral.events.get(key)) ? ephemeral.events.get(key) : [];

  if (persistenceDisabled()) {
    return filterAndPageEvents(localRows, {
      limit: n,
      cursor: cursorObj,
      eventTypes: normalizedTypes,
    });
  }

  try {
    const params = [];
    const where = [];
    if (identity.userId) {
      params.push(identity.userId);
      where.push(`user_id = $${params.length}`);
    } else {
      params.push(identity.auroraUid);
      where.push(`aurora_uid = $${params.length}`);
    }
    if (normalizedTypes.length) {
      params.push(normalizedTypes);
      where.push(`event_type = ANY($${params.length}::text[])`);
    }
    params.push(Math.max(200, n * 6));
    const limitIdx = params.length;
    const res = await query(
      `
        SELECT activity_id, aurora_uid, user_id, event_type, payload, deeplink, source, occurred_at_ms, created_at
        FROM aurora_activity_events
        WHERE ${where.join(' AND ')}
        ORDER BY occurred_at_ms DESC, activity_id DESC
        LIMIT $${limitIdx}
      `,
      params,
    );

    const merged = [];
    const seen = new Set();
    for (const row of localRows) {
      const id = String(row && row.activity_id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(row);
    }
    for (const row of res.rows || []) {
      const mapped = mapRow(row);
      const id = String(mapped && mapped.activity_id || '').trim();
      if (!mapped || !id || seen.has(id)) continue;
      seen.add(id);
      merged.push(mapped);
    }

    return filterAndPageEvents(merged, {
      limit: n,
      cursor: cursorObj,
      eventTypes: normalizedTypes,
    });
  } catch (err) {
    if (isStorageUnavailableError(err)) {
      return filterAndPageEvents(localRows, {
        limit: n,
        cursor: cursorObj,
        eventTypes: normalizedTypes,
      });
    }
    throw err;
  }
}

module.exports = {
  appendActivityForIdentity,
  listActivityForIdentity,
  __internal: {
    decodeCursor,
    encodeCursor,
    ephemeral,
  },
};
