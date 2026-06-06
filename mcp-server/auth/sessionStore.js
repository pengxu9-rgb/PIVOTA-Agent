/**
 * Reference-only in-memory OAuth session store.
 *
 * This module is suitable for local adapter development and offline tests only.
 * Production deployments need encrypted, durable storage with explicit retention,
 * rotation, and revocation policies. Never write access tokens, refresh tokens,
 * or AP2 state to logs or thrown error messages.
 */

export function createSessionStore() {
  const sessions = new Map();

  function put(sessionId, session) {
    assertSessionId(sessionId);
    assertSessionRecord(session);

    const record = {
      user_ref: session.user_ref,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: normalizeExpiresAt(session.expiresAt)
    };

    sessions.set(sessionId, record);
    return cloneRecord(record);
  }

  function get(sessionId) {
    assertSessionId(sessionId);
    const record = sessions.get(sessionId);
    if (record && recordIsExpired(record, Date.now())) {
      sessions.delete(sessionId);
      return undefined;
    }
    return record ? cloneRecord(record) : undefined;
  }

  function deleteSession(sessionId) {
    assertSessionId(sessionId);
    return sessions.delete(sessionId);
  }

  function isExpired(sessionId, now = Date.now()) {
    assertSessionId(sessionId);
    const record = sessions.get(sessionId);
    if (!record) {
      return true;
    }

    return recordIsExpired(record, now);
  }

  return {
    put,
    get,
    delete: deleteSession,
    isExpired
  };
}

const defaultStore = createSessionStore();

export const put = (...args) => defaultStore.put(...args);
export const get = (...args) => defaultStore.get(...args);
const deleteDefaultSession = (...args) => defaultStore.delete(...args);
export { deleteDefaultSession as delete };
export const isExpired = (...args) => defaultStore.isExpired(...args);

function assertSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("sessionId is required.");
  }
}

function assertSessionRecord(session) {
  if (typeof session !== "object" || session === null || Array.isArray(session)) {
    throw new Error("session record is required.");
  }

  if (typeof session.user_ref !== "string" || session.user_ref.trim().length === 0) {
    throw new Error("session user_ref is required.");
  }

  if (
    session.accessToken !== undefined &&
    typeof session.accessToken !== "string"
  ) {
    throw new Error("session accessToken must be a string when provided.");
  }

  if (
    session.refreshToken !== undefined &&
    typeof session.refreshToken !== "string"
  ) {
    throw new Error("session refreshToken must be a string when provided.");
  }
}

function normalizeExpiresAt(expiresAt) {
  if (expiresAt === undefined || expiresAt === null) {
    return undefined;
  }

  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    return expiresAt;
  }

  if (expiresAt instanceof Date) {
    const timestamp = expiresAt.getTime();
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }

  if (typeof expiresAt === "string" && expiresAt.trim().length > 0) {
    const timestamp = Date.parse(expiresAt);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }

  throw new Error("session expiresAt must be a timestamp, Date, or ISO string.");
}

function normalizeNow(now) {
  const normalized = normalizeExpiresAt(now);
  if (normalized === undefined) {
    throw new Error("now is required.");
  }
  return normalized;
}

function recordIsExpired(record, now) {
  if (record.expiresAt === undefined || record.expiresAt === null) {
    return false;
  }

  return record.expiresAt <= normalizeNow(now);
}

function cloneRecord(record) {
  return { ...record };
}
