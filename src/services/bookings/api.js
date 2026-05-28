const { randomUUID } = require('crypto');
const logger = require('../../logger');
const { query } = require('../../db');
const repository = require('./repository');
const { STATUSES, BookingTransitionError, requireTransition } = require('./state');
const { runNotifyOnce } = require('./notifyWorker');
const { getProviderById } = require('../servicesSearch');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_SLA_HOURS = 24;
const DEFAULT_NOTIFY_LIMIT = 25;
const MAX_NOTIFY_LIMIT = 100;
const DEFAULT_NOTIFY_LIST_LIMIT = 50;
const MAX_NOTIFY_LIST_LIMIT = 200;
const NOTIFICATION_OUTBOX_COLUMNS = `
  outbox_id,
  booking_id,
  provider_id,
  channel,
  payload,
  status,
  attempt_count,
  last_attempted_at,
  last_error,
  sent_at,
  ops_acknowledged_at,
  ops_acknowledged_by,
  metadata,
  created_at,
  updated_at
`;
const NOTIFICATION_STATUSES = new Set([
  'pending',
  'retry',
  'manual_pending',
  'sent',
  'failed',
  'ops_acknowledged',
]);

class BookingValidationError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message || code);
    this.name = 'BookingValidationError';
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

function requireBookingFlagOn(_req, res, next) {
  if (process.env.SERVICES_BOOKING_ENABLED !== 'true') {
    return res.status(503).json({ error: 'BOOKING_FLOW_DISABLED' });
  }
  return next();
}

function hasAdminToken(req) {
  const expected = process.env.SERVICES_BOOKING_ADMIN_TOKEN;
  if (!expected) return false;
  return String(req.get('X-Pivota-Admin-Token') || '') === expected;
}

function requireAdminToken(req) {
  if (!hasAdminToken(req)) {
    throw new BookingValidationError('ADMIN_TOKEN_REQUIRED', 'Admin token is required', 403);
  }
}

function sendError(res, err) {
  const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  const code = err?.code || 'INTERNAL_ERROR';
  const body = { error: code };

  if (statusCode < 500 && err?.message) {
    body.message = err.message;
  }
  if (err?.current_status) {
    body.current_status = err.current_status;
  }
  if (err?.target_status) {
    body.target_status = err.target_status;
  }

  return res.status(statusCode).json(body);
}

function wrap(handler) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (err) {
      if (err?.statusCode && err?.code) {
        return sendError(res, err);
      }
      // Catch-all for unexpected errors. Omit err.message because PG errors
      // can echo conflicting field values (e.g. contact_email) — those would
      // leak into logs. Stack traces don't include variable values.
      logger.warn(
        { error_name: err?.name, error_code: err?.code, stack: err?.stack },
        'Services booking API failed',
      );
      return sendError(res, new BookingValidationError('INTERNAL_ERROR', 'Internal error', 500));
    }
  };
}

function bodyObject(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUuid(value, code, label, statusCode = 400) {
  const normalized = cleanString(value);
  if (!normalized || !UUID_RE.test(normalized)) {
    throw new BookingValidationError(code, `${label} must be a valid UUID`, statusCode);
  }
  return normalized;
}

function normalizeUserId(value) {
  const normalized = cleanString(value);
  if (!normalized || normalized.length > 120) {
    throw new BookingValidationError('BAD_USER_ID', 'user_id is required and must be 120 characters or fewer');
  }
  return normalized;
}

function normalizeIdempotencyKey(value) {
  const normalized = cleanString(value);
  if (!normalized || normalized.length > 80) {
    throw new BookingValidationError(
      'BAD_IDEMPOTENCY_KEY',
      'idempotency_key is required and must be 80 characters or fewer',
    );
  }
  return normalized;
}

function parseDate(value, code, message) {
  const raw = cleanString(value);
  const date = raw ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new BookingValidationError(code, message);
  }
  return date;
}

function normalizeRequestedSlot(value) {
  const date = parseDate(value, 'BAD_SLOT', 'requested_slot must be a parseable ISO-8601 timestamp');
  const min = Date.now() + 60 * 60 * 1000;
  if (date.getTime() < min) {
    throw new BookingValidationError('SLOT_TOO_SOON', 'requested_slot must be at least 60 minutes in the future');
  }
  return date.toISOString();
}

function normalizeAlternateSlots(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 5) {
    throw new BookingValidationError(
      'BAD_ALTERNATE_SLOTS',
      'alternate_slots must be an array with at most 5 entries',
    );
  }
  return value.map((slot) =>
    parseDate(slot, 'BAD_ALTERNATE_SLOTS', 'alternate_slots entries must be parseable timestamps').toISOString(),
  );
}

function normalizeOptionalString(value, maxLength, code, label) {
  const normalized = cleanString(value);
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new BookingValidationError(code, `${label} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function normalizePagination(query = {}) {
  return {
    limit: normalizeInteger(query.limit, 'BAD_PAGINATION', 'limit', {
      defaultValue: DEFAULT_LIMIT,
      min: 1,
      max: MAX_LIMIT,
    }),
    offset: normalizeInteger(query.offset, 'BAD_PAGINATION', 'offset', {
      defaultValue: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
  };
}

function normalizeInteger(value, code, label, { defaultValue, min, max }) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (Array.isArray(value)) {
    throw new BookingValidationError(code, `${label} must be provided at most once`);
  }
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new BookingValidationError(code, `${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeStatus(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = cleanString(value);
  if (!STATUSES.includes(normalized)) {
    throw new BookingValidationError('BAD_STATUS', 'status is not supported');
  }
  return normalized;
}

function getSlaHours() {
  const parsed = Number(process.env.SERVICES_BOOKING_SLA_HOURS);
  if (!Number.isFinite(parsed)) return DEFAULT_SLA_HOURS;
  return Math.min(168, Math.max(1, Math.trunc(parsed)));
}

function getDepositPct() {
  const parsed = Number(process.env.SERVICES_BOOKING_DEPOSIT_PCT);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, parsed));
}

function sanitizePublicBooking(row) {
  if (!row) return row;
  const out = { ...row };
  delete out.contact_email;
  delete out.contact_phone;
  delete out.notes;
  delete out.metadata;
  delete out.user_id;
  return out;
}

function normalizeCreatePayload(body) {
  const listingId = normalizeUuid(body.listing_id, 'BAD_LISTING_ID', 'listing_id');
  const userId = normalizeUserId(body.user_id);
  const idempotencyKey = normalizeIdempotencyKey(body.idempotency_key);
  const requestedSlot = normalizeRequestedSlot(body.requested_slot);
  const alternateSlots = normalizeAlternateSlots(body.alternate_slots);
  const contactEmail = normalizeOptionalString(body.contact_email, 320, 'BAD_CONTACT', 'contact_email');
  const contactPhone = normalizeOptionalString(body.contact_phone, 80, 'BAD_CONTACT', 'contact_phone');
  const notes = normalizeOptionalString(body.notes, 500, 'BAD_NOTES', 'notes');

  if (!contactEmail && !contactPhone) {
    throw new BookingValidationError('MISSING_CONTACT', 'At least one of contact_email or contact_phone is required');
  }

  return {
    listingId,
    userId,
    idempotencyKey,
    requestedSlot,
    alternateSlots,
    contactEmail,
    contactPhone,
    notes,
  };
}

function validateListingAvailability(row) {
  if (!row || row.listing_status !== 'active') {
    throw new BookingValidationError('LISTING_UNAVAILABLE', 'Listing is unavailable', 404);
  }
  if (!['candidate', 'live'].includes(row.provider_status)) {
    throw new BookingValidationError('PROVIDER_UNAVAILABLE', 'Provider is unavailable', 404);
  }
}

const createBooking = wrap(async (req, res) => {
  const payload = normalizeCreatePayload(bodyObject(req));

  const result = await repository.withTransaction(async (txQuery) => {
    await repository.lockIdempotencyKey(payload.userId, payload.idempotencyKey, txQuery);
    const existing = await repository.findByIdempotencyKey(payload.userId, payload.idempotencyKey, txQuery);
    if (existing) {
      return { statusCode: 200, booking: existing };
    }

    const listing = await repository.findActiveListingWithProvider(payload.listingId, txQuery);
    validateListingAvailability(listing);

    const priceCents = Number.isInteger(Number(listing.price_cents)) ? Number(listing.price_cents) : 0;
    const depositPct = getDepositPct();
    const booking = await repository.insert(
      {
        booking_id: randomUUID(),
        listing_id: payload.listingId,
        provider_id: listing.provider_id,
        user_id: payload.userId,
        requested_slot: payload.requestedSlot,
        alternate_slots: payload.alternateSlots,
        status: 'requested',
        deposit_cents: depositPct > 0 ? Math.round((priceCents * depositPct) / 100) : 0,
        deposit_currency: listing.currency || 'USD',
        deposit_payment_intent: null,
        contact_email: payload.contactEmail,
        contact_phone: payload.contactPhone,
        notes: payload.notes,
        expires_at: new Date(Date.now() + getSlaHours() * 60 * 60 * 1000).toISOString(),
        metadata: {
          idempotency_key: payload.idempotencyKey,
        },
      },
      txQuery,
    );
    return { statusCode: 201, booking };
  });

  return res.status(result.statusCode).json(result.booking);
});

const getBooking = wrap(async (req, res) => {
  const bookingId = normalizeUuid(req.params.booking_id, 'BOOKING_NOT_FOUND', 'booking_id', 404);
  const booking = await repository.findById(bookingId);
  if (!booking) {
    throw new BookingValidationError('BOOKING_NOT_FOUND', 'Booking not found', 404);
  }

  const queryUserId = cleanString(req.query?.user_id);
  const canSeeFull = hasAdminToken(req) || (queryUserId && queryUserId === booking.user_id);
  const view = canSeeFull ? booking : sanitizePublicBooking(booking);

  // Enrich with the provider + booked listing so the confirmation UI renders
  // from a single fetch (no second round-trip from the client).
  try {
    const provider = await getProviderById(booking.provider_id);
    const listings = provider
      ? (provider.matching_listings || provider.service_listings || [])
      : [];
    const listing =
      listings.find((l) => (l.listing_id || l.id) === booking.listing_id) || listings[0] || null;
    return res.json({ ...view, provider: provider || null, listing });
  } catch (err) {
    logger.warn({ error_name: err?.name, booking_id: bookingId }, 'Failed to enrich booking with provider');
    return res.json(view);
  }
});

const listBookings = wrap(async (req, res) => {
  const pagination = normalizePagination(req.query || {});

  if (req.query?.user_id) {
    const userId = normalizeUserId(req.query.user_id);
    const bookings = await repository.findByUser(userId, pagination);
    return res.json({ bookings, pagination: { ...pagination, count: bookings.length } });
  }

  if (req.query?.provider_id) {
    requireAdminToken(req);
    const providerId = normalizeUuid(req.query.provider_id, 'BAD_PROVIDER_ID', 'provider_id');
    const status = normalizeStatus(req.query.status);
    const bookings = await repository.findByProvider(providerId, { ...pagination, status });
    return res.json({ bookings, pagination: { ...pagination, count: bookings.length } });
  }

  throw new BookingValidationError('BAD_USER_ID', 'user_id is required unless provider_id is supplied');
});

const cancelBooking = wrap(async (req, res) => {
  const bookingId = normalizeUuid(req.params.booking_id, 'BOOKING_NOT_FOUND', 'booking_id', 404);
  const userId = normalizeUserId(bodyObject(req).user_id);
  const booking = await repository.findById(bookingId);
  if (!booking) {
    throw new BookingValidationError('BOOKING_NOT_FOUND', 'Booking not found', 404);
  }
  if (booking.user_id !== userId) {
    throw new BookingValidationError('USER_ID_MISMATCH', 'user_id does not match booking owner', 403);
  }

  requireTransition(booking.status, 'cancelled');
  const updated = await repository.updateStatus(bookingId, 'cancelled');
  return res.json(updated);
});

const providerAction = wrap(async (req, res) => {
  requireAdminToken(req);
  const bookingId = normalizeUuid(req.params.booking_id, 'BOOKING_NOT_FOUND', 'booking_id', 404);
  const body = bodyObject(req);
  const action = cleanString(body.action);
  if (!['confirm', 'reject'].includes(action)) {
    throw new BookingValidationError('BAD_PROVIDER_ACTION', 'action must be confirm or reject');
  }
  const reason = normalizeOptionalString(body.reason, 500, 'BAD_REASON', 'reason');
  const nextStatus = action === 'confirm' ? 'confirmed' : 'rejected';

  const booking = await repository.findById(bookingId);
  if (!booking) {
    throw new BookingValidationError('BOOKING_NOT_FOUND', 'Booking not found', 404);
  }

  requireTransition(booking.status, nextStatus);
  const updated = await repository.updateStatus(bookingId, nextStatus, { reason });
  return res.json(updated);
});

const sweepExpired = wrap(async (req, res) => {
  requireAdminToken(req);
  requireTransition('requested', 'expired');
  const swept = await repository.sweepExpired();
  return res.json({ swept });
});

// --- notification outbox (Step 8b: Kakao Bizmessage worker + manual-ops fallback) ---

function normalizeNotificationStatus(value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    throw new BookingValidationError('BAD_STATUS', 'status must be provided at most once');
  }
  const normalized = cleanString(value);
  if (!NOTIFICATION_STATUSES.has(normalized)) {
    throw new BookingValidationError('BAD_STATUS', 'status is not supported');
  }
  return normalized;
}

function normalizeAcknowledgedBy(value) {
  const normalized = cleanString(value);
  if (!normalized || normalized.length > 120) {
    throw new BookingValidationError(
      'BAD_ACKNOWLEDGED_BY',
      'acknowledged_by is required and must be 120 characters or fewer',
    );
  }
  return normalized;
}

async function findNotification(outboxId) {
  const result = await query(
    `SELECT ${NOTIFICATION_OUTBOX_COLUMNS}
       FROM service_booking_notifications_outbox
      WHERE outbox_id = $1
      LIMIT 1`,
    [outboxId],
  );
  return result.rows?.[0] || null;
}

const runNotifications = wrap(async (req, res) => {
  requireAdminToken(req);
  const limit = normalizeInteger(bodyObject(req).limit, 'BAD_LIMIT', 'limit', {
    defaultValue: DEFAULT_NOTIFY_LIMIT,
    min: 1,
    max: MAX_NOTIFY_LIMIT,
  });
  const result = await runNotifyOnce({ limit });
  return res.json(result);
});

const ackNotification = wrap(async (req, res) => {
  requireAdminToken(req);
  const outboxId = normalizeUuid(req.params.outbox_id, 'BAD_OUTBOX_ID', 'outbox_id');
  const acknowledgedBy = normalizeAcknowledgedBy(bodyObject(req).acknowledged_by);
  const existing = await findNotification(outboxId);
  if (!existing) {
    throw new BookingValidationError('NOTIFICATION_NOT_FOUND', 'Notification was not found', 404);
  }
  if (existing.ops_acknowledged_at || existing.status === 'ops_acknowledged') {
    return res.json(existing);
  }
  const result = await query(
    `UPDATE service_booking_notifications_outbox
        SET status = 'ops_acknowledged',
            ops_acknowledged_at = now(),
            ops_acknowledged_by = $2,
            updated_at = now()
      WHERE outbox_id = $1
      RETURNING ${NOTIFICATION_OUTBOX_COLUMNS}`,
    [outboxId, acknowledgedBy],
  );
  return res.json(result.rows?.[0] || existing);
});

const listNotifications = wrap(async (req, res) => {
  requireAdminToken(req);
  const status = normalizeNotificationStatus(req.query?.status);
  const limit = normalizeInteger(req.query?.limit, 'BAD_PAGINATION', 'limit', {
    defaultValue: DEFAULT_NOTIFY_LIST_LIMIT,
    min: 1,
    max: MAX_NOTIFY_LIST_LIMIT,
  });
  const offset = normalizeInteger(req.query?.offset, 'BAD_PAGINATION', 'offset', {
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  const result = await query(
    `SELECT ${NOTIFICATION_OUTBOX_COLUMNS}
       FROM service_booking_notifications_outbox
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC, outbox_id DESC
      LIMIT $2
      OFFSET $3`,
    [status, limit, offset],
  );
  return res.json({
    notifications: result.rows || [],
    pagination: {
      limit,
      offset,
      has_more: (result.rows || []).length === limit,
    },
  });
});

module.exports = {
  BookingValidationError,
  BookingTransitionError,
  requireBookingFlagOn,
  createBooking,
  getBooking,
  listBookings,
  cancelBooking,
  providerAction,
  sweepExpired,
  runNotifications,
  ackNotification,
  listNotifications,
  __test: {
    hasAdminToken,
    sanitizePublicBooking,
    normalizeCreatePayload,
    normalizePagination,
  },
};
