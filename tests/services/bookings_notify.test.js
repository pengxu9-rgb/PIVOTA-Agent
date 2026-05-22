jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(),
}));

jest.mock('../../src/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/auroraBff/routes', () => ({
  mountAuroraBffRoutes: () => {},
  __internal: {},
}));

const request = require('supertest');
const db = require('../../src/db');
const app = require('../../src/server');
const { getNotifier, NotifierPermanentError, NotifierTransientError } = require('../../src/services/bookings/notifier');
const { runNotifyOnce } = require('../../src/services/bookings/notifyWorker');

const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const BOOKING_ID_2 = '22222222-2222-4222-8222-222222222222';
const LISTING_ID = '33333333-3333-4333-8333-333333333333';
const PROVIDER_ID = '44444444-4444-4444-8444-444444444444';
const OUTBOX_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_TOKEN = 'admin-secret';

function bookingRow(overrides = {}) {
  return {
    booking_id: BOOKING_ID,
    provider_id: PROVIDER_ID,
    listing_id: LISTING_ID,
    requested_slot: '2026-05-23T03:00:00.000Z',
    alternate_slots: ['2026-05-23T04:00:00.000Z'],
    contact_email: 'customer@example.com',
    contact_phone: '+821055501000',
    notes: 'Prefers afternoon',
    expires_at: '2026-05-23T12:00:00.000Z',
    created_at: '2026-05-22T00:00:00.000Z',
    provider_display_name: 'Seoul Glow Studio',
    provider_name: 'Seoul Glow LLC',
    provider_phone: '+821055509999',
    provider_email: 'provider@example.com',
    provider_metadata: { kakao_id: 'seoul-glow' },
    listing_title: 'Color consultation',
    listing_service_type: 'beauty_consult',
    listing_price_cents: 9900000,
    listing_currency: 'KRW',
    deposit_payment_intent: 'pi_secret_should_never_escape',
    ...overrides,
  };
}

function outboxRow(overrides = {}) {
  return {
    outbox_id: OUTBOX_ID,
    booking_id: BOOKING_ID,
    provider_id: PROVIDER_ID,
    channel: 'manual_ops',
    payload: { booking_id: BOOKING_ID },
    status: 'manual_pending',
    attempt_count: 1,
    last_attempted_at: '2026-05-22T00:00:00.000Z',
    last_error: null,
    sent_at: null,
    ops_acknowledged_at: null,
    ops_acknowledged_by: null,
    metadata: {},
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
    ...overrides,
  };
}

function installWorkerDb(rows, { attemptCount = 0 } = {}) {
  const lockedRows = new Map(rows.map((row) => [row.booking_id, row]));
  const inserted = [];
  const providerNotifiedUpdates = [];
  const clients = [];

  db.query.mockResolvedValueOnce({ rows });
  db.withClient.mockImplementation(async (fn) => {
    const client = {
      query: jest.fn(async (sql, params = []) => {
        const text = String(sql);
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('FOR UPDATE OF b')) {
          return { rows: lockedRows.get(params[0]) ? [lockedRows.get(params[0])] : [] };
        }
        if (text.includes('MAX(attempt_count)')) {
          return { rows: [{ attempt_count: attemptCount }] };
        }
        if (text.includes('UPDATE service_bookings')) {
          providerNotifiedUpdates.push(params[0]);
          return { rows: [], rowCount: 1 };
        }
        if (text.includes('INSERT INTO service_booking_notifications_outbox')) {
          const row = {
            outbox_id: params[0],
            booking_id: params[1],
            provider_id: params[2],
            channel: params[3],
            payload: JSON.parse(params[4]),
            status: params[5],
            attempt_count: params[6],
            last_error: params[7],
            metadata: JSON.parse(params[8]),
          };
          inserted.push(row);
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    clients.push(client);
    return fn(client);
  });

  return { clients, inserted, providerNotifiedUpdates };
}

describe('services booking notifications', () => {
  beforeEach(() => {
    process.env.SERVICES_BOOKING_ENABLED = 'true';
    process.env.SERVICES_BOOKING_ADMIN_TOKEN = ADMIN_TOKEN;
    delete process.env.SERVICES_BOOKING_KAKAO_PROVIDER;
    delete process.env.SERVICES_BOOKING_KAKAO_API_KEY;
    delete process.env.SERVICES_BOOKING_ALIGO_API_KEY;
    delete process.env.SERVICES_BOOKING_SOLAPI_API_KEY;
    delete process.env.SERVICES_BOOKING_SENS_API_KEY;
    db.query.mockReset();
    db.withClient.mockReset();
  });

  afterEach(() => {
    delete process.env.SERVICES_BOOKING_ENABLED;
    delete process.env.SERVICES_BOOKING_ADMIN_TOKEN;
    delete process.env.SERVICES_BOOKING_KAKAO_PROVIDER;
    delete process.env.SERVICES_BOOKING_KAKAO_API_KEY;
    delete process.env.SERVICES_BOOKING_ALIGO_API_KEY;
    delete process.env.SERVICES_BOOKING_SOLAPI_API_KEY;
    delete process.env.SERVICES_BOOKING_SENS_API_KEY;
  });

  test('flag off returns BOOKING_FLOW_DISABLED without DB queries', async () => {
    process.env.SERVICES_BOOKING_ENABLED = 'false';

    await expect(runNotifyOnce()).resolves.toEqual({ notified: 0, reason: 'BOOKING_FLOW_DISABLED' });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.withClient).not.toHaveBeenCalled();
  });

  test('no pending bookings returns zero counts without error', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await expect(runNotifyOnce()).resolves.toEqual({
      notified: 0,
      failed: 0,
      retried: 0,
      fallback_queued: 0,
    });
    expect(db.withClient).not.toHaveBeenCalled();
  });

  test('manual-ops fallback queues manual_pending and marks provider notified without secret payloads', async () => {
    const harness = installWorkerDb([bookingRow()]);

    await expect(runNotifyOnce()).resolves.toEqual({
      notified: 0,
      failed: 0,
      retried: 0,
      fallback_queued: 1,
    });

    expect(harness.providerNotifiedUpdates).toEqual([BOOKING_ID]);
    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]).toMatchObject({
      booking_id: BOOKING_ID,
      channel: 'manual_ops',
      status: 'manual_pending',
    });
    expect(harness.inserted[0].payload.provider).toMatchObject({
      phone: '+821055509999',
      email: 'provider@example.com',
      kakao_id: 'seoul-glow',
    });
    expect(JSON.stringify(harness.inserted[0].payload)).not.toContain('admin-secret');
    expect(JSON.stringify(harness.inserted[0].payload)).not.toContain('pi_secret_should_never_escape');
  });

  test('two pending bookings isolate a permanent failure from a sent notification', async () => {
    const harness = installWorkerDb([bookingRow(), bookingRow({ booking_id: BOOKING_ID_2 })]);
    const notifier = {
      channel: 'kakao_alimtalk_aligo',
      send: jest
        .fn()
        .mockResolvedValueOnce({ ok: true, vendor_message_id: 'vendor-1' })
        .mockRejectedValueOnce(new NotifierPermanentError('UNCONFIGURED')),
    };

    await expect(runNotifyOnce({ notifier })).resolves.toEqual({
      notified: 1,
      failed: 1,
      retried: 0,
      fallback_queued: 0,
    });

    expect(harness.providerNotifiedUpdates).toEqual([BOOKING_ID, BOOKING_ID_2]);
    expect(harness.inserted.map((row) => row.status)).toEqual(['sent', 'failed']);
    expect(harness.inserted[1]).toMatchObject({
      booking_id: BOOKING_ID_2,
      channel: 'kakao_alimtalk_aligo',
      last_error: 'UNCONFIGURED',
    });
  });

  test('transient notifier error writes pending retry row without marking provider notified', async () => {
    const harness = installWorkerDb([bookingRow()]);
    const notifier = {
      channel: 'kakao_alimtalk_solapi',
      send: jest.fn().mockRejectedValue(new NotifierTransientError('RATE_LIMIT')),
    };

    await expect(runNotifyOnce({ notifier })).resolves.toEqual({
      notified: 0,
      failed: 0,
      retried: 1,
      fallback_queued: 0,
    });

    expect(harness.providerNotifiedUpdates).toEqual([]);
    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]).toMatchObject({
      booking_id: BOOKING_ID,
      channel: 'kakao_alimtalk_solapi',
      status: 'pending',
      attempt_count: 1,
      last_error: 'RATE_LIMIT',
    });
  });

  test('ack route marks manual notification acknowledged and re-ack is idempotent', async () => {
    const acknowledged = outboxRow({
      status: 'ops_acknowledged',
      ops_acknowledged_at: '2026-05-22T00:05:00.000Z',
      ops_acknowledged_by: 'ops-a',
    });
    db.query
      .mockResolvedValueOnce({ rows: [outboxRow()] })
      .mockResolvedValueOnce({ rows: [acknowledged] })
      .mockResolvedValueOnce({ rows: [acknowledged] });

    const first = await request(app)
      .post(`/api/services/bookings/notifications/${OUTBOX_ID}/ack`)
      .set('X-Pivota-Admin-Token', ADMIN_TOKEN)
      .send({ acknowledged_by: 'ops-a' });
    const second = await request(app)
      .post(`/api/services/bookings/notifications/${OUTBOX_ID}/ack`)
      .set('X-Pivota-Admin-Token', ADMIN_TOKEN)
      .send({ acknowledged_by: 'ops-a' });

    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ops_acknowledged');
    expect(first.body.ops_acknowledged_by).toBe('ops-a');
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject(first.body);
    expect(db.query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE service_booking_notifications_outbox'))).toHaveLength(1);
  });

  test('ack route without admin token returns 403', async () => {
    const res = await request(app)
      .post(`/api/services/bookings/notifications/${OUTBOX_ID}/ack`)
      .send({ acknowledged_by: 'ops-a' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ADMIN_TOKEN_REQUIRED');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('list notifications by status returns manual_pending rows', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        outboxRow({ outbox_id: OUTBOX_ID, status: 'manual_pending' }),
        outboxRow({ outbox_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'manual_pending' }),
      ],
    });

    const res = await request(app)
      .get('/api/services/bookings/notifications')
      .set('X-Pivota-Admin-Token', ADMIN_TOKEN)
      .query({ status: 'manual_pending' });

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(2);
    expect(res.body.notifications.every((row) => row.status === 'manual_pending')).toBe(true);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE ($1::text IS NULL OR status = $1)'), [
      'manual_pending',
      50,
      0,
    ]);
  });

  test('adapter selection defaults to manual and aligo stub fails permanently without crashing worker', async () => {
    expect(getNotifier().channel).toBe('manual_ops');

    process.env.SERVICES_BOOKING_KAKAO_PROVIDER = 'aligo';
    process.env.SERVICES_BOOKING_KAKAO_API_KEY = 'test-key';
    expect(getNotifier().channel).toBe('kakao_alimtalk_aligo');

    const harness = installWorkerDb([bookingRow()]);
    await expect(runNotifyOnce()).resolves.toEqual({
      notified: 0,
      failed: 1,
      retried: 0,
      fallback_queued: 0,
    });
    expect(harness.providerNotifiedUpdates).toEqual([BOOKING_ID]);
    expect(harness.inserted[0]).toMatchObject({
      channel: 'kakao_alimtalk_aligo',
      status: 'failed',
      last_error: 'UNCONFIGURED',
    });
  });
});
