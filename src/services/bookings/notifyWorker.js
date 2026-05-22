const { randomUUID } = require('crypto');
const { query, withClient } = require('../../db');
const logger = require('../../logger');
const {
  getNotifier,
  NotifierPermanentError,
  NotifierTransientError,
} = require('./notifier');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const BOOKING_NOTIFY_SELECT = `
  SELECT
    b.booking_id,
    b.provider_id,
    b.listing_id,
    b.requested_slot,
    b.alternate_slots,
    b.contact_email,
    b.contact_phone,
    b.notes,
    b.expires_at,
    b.created_at,
    sp.display_name AS provider_display_name,
    sp.name AS provider_name,
    sp.phone AS provider_phone,
    sp.email AS provider_email,
    sp.metadata AS provider_metadata,
    sl.title AS listing_title,
    sl.service_type AS listing_service_type,
    sl.price_cents AS listing_price_cents,
    sl.currency AS listing_currency
  FROM service_bookings b
  LEFT JOIN service_providers sp ON sp.provider_id = b.provider_id
  LEFT JOIN service_listings sl ON sl.listing_id = b.listing_id
`;

function normalizeLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isInteger(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

function normalizeJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_err) {
      return fallback;
    }
  }
  return value;
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return value || null;
}

function normalizeErrorCode(err) {
  return String(err?.code || err?.message || err?.name || 'UNKNOWN_ERROR').slice(0, 500);
}

function isTransientNotifierError(err) {
  return err instanceof NotifierTransientError || err?.name === 'NotifierTransientError';
}

function isPermanentNotifierError(err) {
  return err instanceof NotifierPermanentError || err?.name === 'NotifierPermanentError';
}

function buildBestEffortPayload(row) {
  const providerMetadata = normalizeJson(row.provider_metadata, {});
  return {
    booking_id: row.booking_id,
    provider: {
      provider_id: row.provider_id,
      display_name: row.provider_display_name || row.provider_name,
      phone: row.provider_phone || null,
      kakao_id: providerMetadata && typeof providerMetadata === 'object' ? providerMetadata.kakao_id || null : null,
      email: row.provider_email || null,
    },
    listing: {
      listing_id: row.listing_id,
      title: row.listing_title,
      service_type: row.listing_service_type || null,
      price_cents: Number.isInteger(Number(row.listing_price_cents)) ? Number(row.listing_price_cents) : null,
      currency: row.listing_currency || null,
    },
    requested_slot: normalizeTimestamp(row.requested_slot),
    alternate_slots: normalizeJson(row.alternate_slots, []),
    contact_email: row.contact_email || null,
    contact_phone: row.contact_phone || null,
    notes: row.notes || null,
    expires_at: normalizeTimestamp(row.expires_at),
  };
}

function buildPayload(row) {
  if (!row?.provider_id || (!row.provider_display_name && !row.provider_name)) {
    throw new NotifierPermanentError('INVALID_PROVIDER');
  }
  if (!row?.listing_id || !row.listing_title) {
    throw new NotifierPermanentError('INVALID_LISTING');
  }
  return buildBestEffortPayload(row);
}

async function fetchPendingBookings(limit) {
  const result = await query(
    `${BOOKING_NOTIFY_SELECT}
      WHERE b.provider_notified_at IS NULL
        AND b.status = 'requested'
      ORDER BY b.created_at ASC, b.booking_id ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows || [];
}

async function lockPendingBooking(client, bookingId) {
  const result = await client.query(
    `${BOOKING_NOTIFY_SELECT}
      WHERE b.booking_id = $1
        AND b.provider_notified_at IS NULL
        AND b.status = 'requested'
      LIMIT 1
      FOR UPDATE OF b`,
    [bookingId],
  );
  return result.rows?.[0] || null;
}

async function getNextAttemptCount(client, bookingId) {
  const result = await client.query(
    `SELECT COALESCE(MAX(attempt_count), 0)::int AS attempt_count
       FROM service_booking_notifications_outbox
      WHERE booking_id = $1`,
    [bookingId],
  );
  return Number(result.rows?.[0]?.attempt_count || 0) + 1;
}

async function insertOutboxRow(client, row, payload, { channel, status, attemptCount, errorCode, vendorMessageId }) {
  const metadata = {
    vendor_message_id: vendorMessageId || null,
  };
  const result = await client.query(
    `INSERT INTO service_booking_notifications_outbox (
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
        metadata
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb,
        $6,
        $7,
        now(),
        $8,
        CASE WHEN $6 = 'sent' THEN now() ELSE NULL END,
        $9::jsonb
      )
      RETURNING *`,
    [
      randomUUID(),
      row.booking_id,
      row.provider_id,
      channel,
      JSON.stringify(payload || {}),
      status,
      attemptCount,
      errorCode || null,
      JSON.stringify(metadata),
    ],
  );
  return result.rows?.[0] || null;
}

async function markProviderNotified(client, bookingId) {
  await client.query(
    `UPDATE service_bookings
        SET provider_notified_at = now()
      WHERE booking_id = $1`,
    [bookingId],
  );
}

async function processBooking(row, notifier) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const locked = await lockPendingBooking(client, row.booking_id);
      if (!locked) {
        await client.query('COMMIT');
        return { outcome: 'skipped' };
      }

      const attemptCount = await getNextAttemptCount(client, locked.booking_id);
      let payload = buildBestEffortPayload(locked);

      try {
        payload = buildPayload(locked);
        const sendResult = await notifier.send(payload);
        const channel = sendResult?.channel || notifier.channel;
        const status = channel === 'manual_ops' ? 'manual_pending' : 'sent';

        await markProviderNotified(client, locked.booking_id);
        await insertOutboxRow(client, locked, payload, {
          channel,
          status,
          attemptCount,
          vendorMessageId: sendResult?.vendor_message_id || null,
        });
        await client.query('COMMIT');
        return { outcome: status === 'manual_pending' ? 'manual_pending' : 'sent' };
      } catch (err) {
        if (isTransientNotifierError(err)) {
          await insertOutboxRow(client, locked, payload, {
            channel: notifier.channel || 'manual_ops',
            status: 'pending',
            attemptCount,
            errorCode: normalizeErrorCode(err),
          });
          await client.query('COMMIT');
          // Omit err.message: adapter errors may wrap PG / HTTP responses
          // that echo field values. error_name + error_code carry enough
          // signal for ops triage.
          logger.warn(
            { error_name: err?.name, error_code: err?.code || normalizeErrorCode(err), booking_id: locked.booking_id },
            'Transient service booking notification failure',
          );
          return { outcome: 'retried' };
        }

        const permanent = isPermanentNotifierError(err)
          ? err
          : new NotifierPermanentError('NOTIFIER_FAILED', err?.code || err?.name || 'UNKNOWN');
        await markProviderNotified(client, locked.booking_id);
        await insertOutboxRow(client, locked, payload, {
          channel: notifier.channel || 'manual_ops',
          status: 'failed',
          attemptCount,
          errorCode: normalizeErrorCode(permanent),
        });
        await client.query('COMMIT');
        logger.error(
          { error_name: permanent?.name, error_code: permanent?.code, booking_id: locked.booking_id },
          'Permanent service booking notification failure',
        );
        return { outcome: 'failed' };
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

async function runNotifyOnce({ limit = DEFAULT_LIMIT, notifier = null } = {}) {
  if (process.env.SERVICES_BOOKING_ENABLED !== 'true') {
    return { notified: 0, reason: 'BOOKING_FLOW_DISABLED' };
  }

  const rows = await fetchPendingBookings(normalizeLimit(limit));
  const counts = {
    notified: 0,
    failed: 0,
    retried: 0,
    fallback_queued: 0,
  };
  if (rows.length === 0) return counts;

  const activeNotifier = notifier || getNotifier();
  for (const row of rows) {
    try {
      const result = await processBooking(row, activeNotifier);
      if (result.outcome === 'sent') counts.notified += 1;
      else if (result.outcome === 'manual_pending') counts.fallback_queued += 1;
      else if (result.outcome === 'failed') counts.failed += 1;
      else if (result.outcome === 'retried') counts.retried += 1;
    } catch (err) {
      counts.failed += 1;
      logger.error(
        { error_name: err?.name, error_code: err?.code, booking_id: row?.booking_id || null },
        'Service booking notification row failed outside adapter handling',
      );
    }
  }

  return counts;
}

module.exports = {
  buildPayload,
  runNotifyOnce,
  _internals: {
    normalizeLimit,
  },
};
