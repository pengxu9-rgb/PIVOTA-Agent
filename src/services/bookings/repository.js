const { query, withClient } = require('../../db');

const BOOKING_COLUMNS = `
  booking_id,
  listing_id,
  provider_id,
  user_id,
  requested_slot,
  alternate_slots,
  status,
  deposit_cents,
  deposit_currency,
  deposit_payment_intent,
  contact_email,
  contact_phone,
  notes,
  provider_notified_at,
  provider_confirmed_at,
  provider_rejected_at,
  cancelled_at,
  expires_at,
  metadata,
  created_at,
  updated_at
`;

function getQuery(dbQuery) {
  return typeof dbQuery === 'function' ? dbQuery : query;
}

async function withTransaction(fn) {
  if (typeof withClient === 'function') {
    return withClient(async (client) => {
      const txQuery = (text, params) => client.query(text, params);
      await txQuery('BEGIN');
      try {
        const result = await fn(txQuery);
        await txQuery('COMMIT');
        return result;
      } catch (err) {
        await txQuery('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  }

  await query('BEGIN');
  try {
    const result = await fn(query);
    await query('COMMIT');
    return result;
  } catch (err) {
    await query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function findById(bookingId, dbQuery) {
  const runQuery = getQuery(dbQuery);
  const result = await runQuery(
    `SELECT ${BOOKING_COLUMNS}
       FROM service_bookings
      WHERE booking_id = $1
      LIMIT 1`,
    [bookingId],
  );
  return result.rows[0] || null;
}

async function findByUser(userId, { limit = 20, offset = 0 } = {}, dbQuery) {
  const runQuery = getQuery(dbQuery);
  const result = await runQuery(
    `SELECT ${BOOKING_COLUMNS}
       FROM service_bookings
      WHERE user_id = $1
      ORDER BY created_at DESC, booking_id DESC
      LIMIT $2
      OFFSET $3`,
    [userId, limit, offset],
  );
  return result.rows;
}

async function findByProvider(providerId, { status = null, limit = 20, offset = 0 } = {}, dbQuery) {
  const runQuery = getQuery(dbQuery);
  const result = await runQuery(
    `SELECT ${BOOKING_COLUMNS}
       FROM service_bookings
      WHERE provider_id = $1
        AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC, booking_id DESC
      LIMIT $3
      OFFSET $4`,
    [providerId, status, limit, offset],
  );
  return result.rows;
}

async function findByIdempotencyKey(userId, idempotencyKey, dbQuery) {
  const runQuery = getQuery(dbQuery);
  const result = await runQuery(
    `SELECT ${BOOKING_COLUMNS}
       FROM service_bookings
      WHERE user_id = $1
        AND metadata->>'idempotency_key' = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, idempotencyKey],
  );
  return result.rows[0] || null;
}

async function findActiveListingWithProvider(listingId, dbQuery) {
  const runQuery = getQuery(dbQuery);
  const result = await runQuery(
    `SELECT
        sl.listing_id,
        sl.provider_id,
        sl.price_cents,
        sl.currency,
        sl.status AS listing_status,
        sp.status AS provider_status
       FROM service_listings sl
       JOIN service_providers sp ON sp.provider_id = sl.provider_id
      WHERE sl.listing_id = $1
      LIMIT 1`,
    [listingId],
  );
  return result.rows[0] || null;
}

async function lockIdempotencyKey(userId, idempotencyKey, dbQuery) {
  const runQuery = getQuery(dbQuery);
  await runQuery('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    userId,
    idempotencyKey,
  ]);
}

async function insert(booking, dbQuery) {
  const runQuery = getQuery(dbQuery);
  const result = await runQuery(
    `INSERT INTO service_bookings (
        booking_id,
        listing_id,
        provider_id,
        user_id,
        requested_slot,
        alternate_slots,
        status,
        deposit_cents,
        deposit_currency,
        deposit_payment_intent,
        contact_email,
        contact_phone,
        notes,
        expires_at,
        metadata
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15::jsonb
      )
      RETURNING ${BOOKING_COLUMNS}`,
    [
      booking.booking_id,
      booking.listing_id,
      booking.provider_id,
      booking.user_id,
      booking.requested_slot,
      JSON.stringify(booking.alternate_slots || []),
      booking.status || 'requested',
      booking.deposit_cents || 0,
      booking.deposit_currency || 'USD',
      booking.deposit_payment_intent || null,
      booking.contact_email || null,
      booking.contact_phone || null,
      booking.notes || null,
      booking.expires_at,
      JSON.stringify(booking.metadata || {}),
    ],
  );
  return result.rows[0] || null;
}

async function updateStatus(bookingId, status, options = {}, dbQuery) {
  const runQuery = getQuery(dbQuery);
  const result = await runQuery(
    `UPDATE service_bookings
        SET status = $2,
            provider_confirmed_at = CASE
              WHEN $2 = 'confirmed' THEN COALESCE($3::timestamptz, now())
              ELSE provider_confirmed_at
            END,
            provider_rejected_at = CASE
              WHEN $2 = 'rejected' THEN COALESCE($3::timestamptz, now())
              ELSE provider_rejected_at
            END,
            cancelled_at = CASE
              WHEN $2 = 'cancelled' THEN COALESCE($3::timestamptz, now())
              ELSE cancelled_at
            END,
            metadata = CASE
              WHEN $4::text IS NULL THEN metadata
              ELSE jsonb_set(COALESCE(metadata, '{}'::jsonb), '{provider_action_reason}', to_jsonb($4::text), true)
            END,
            updated_at = now()
      WHERE booking_id = $1
      RETURNING ${BOOKING_COLUMNS}`,
    [bookingId, status, options.at || null, options.reason || null],
  );
  return result.rows[0] || null;
}

async function sweepExpired(dbQuery) {
  const runQuery = getQuery(dbQuery);
  const result = await runQuery(
    `UPDATE service_bookings
        SET status = 'expired',
            updated_at = now()
      WHERE status = 'requested'
        AND expires_at < now()`,
    [],
  );
  return result.rowCount || 0;
}

module.exports = {
  findById,
  findByUser,
  findByProvider,
  findByIdempotencyKey,
  findActiveListingWithProvider,
  lockIdempotencyKey,
  insert,
  updateStatus,
  sweepExpired,
  withTransaction,
};
