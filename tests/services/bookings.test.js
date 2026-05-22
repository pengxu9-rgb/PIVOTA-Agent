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

jest.mock('../../src/services/bookings/repository', () => ({
  findById: jest.fn(),
  findByUser: jest.fn(),
  findByProvider: jest.fn(),
  findByIdempotencyKey: jest.fn(),
  findActiveListingWithProvider: jest.fn(),
  lockIdempotencyKey: jest.fn(),
  insert: jest.fn(),
  updateStatus: jest.fn(),
  sweepExpired: jest.fn(),
  withTransaction: jest.fn(),
}));

const request = require('supertest');
const repository = require('../../src/services/bookings/repository');
const app = require('../../src/server');
const {
  STATUSES,
  TRANSITIONS,
  BookingTransitionError,
  isAllowedTransition,
  requireTransition,
} = require('../../src/services/bookings/state');

const NOW = Date.parse('2026-05-22T00:00:00.000Z');
const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const LISTING_ID = '22222222-2222-4222-8222-222222222222';
const PROVIDER_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_TOKEN = 'admin-secret';

function bookingRow(overrides = {}) {
  return {
    booking_id: BOOKING_ID,
    listing_id: LISTING_ID,
    provider_id: PROVIDER_ID,
    user_id: 'user-1',
    requested_slot: '2026-05-22T03:00:00.000Z',
    alternate_slots: [],
    status: 'requested',
    deposit_cents: 0,
    deposit_currency: 'KRW',
    deposit_payment_intent: null,
    contact_email: 'user@example.com',
    contact_phone: '+15555550100',
    notes: 'Window seat if possible',
    provider_notified_at: null,
    provider_confirmed_at: null,
    provider_rejected_at: null,
    cancelled_at: null,
    expires_at: '2026-05-23T00:00:00.000Z',
    metadata: { idempotency_key: 'idem-1' },
    created_at: '2026-05-22T00:00:01.000Z',
    updated_at: '2026-05-22T00:00:01.000Z',
    ...overrides,
  };
}

function createPayload(overrides = {}) {
  return {
    listing_id: LISTING_ID,
    user_id: 'user-1',
    requested_slot: new Date(NOW + 2 * 60 * 60 * 1000).toISOString(),
    alternate_slots: [new Date(NOW + 3 * 60 * 60 * 1000).toISOString()],
    contact_email: 'user@example.com',
    contact_phone: '+15555550100',
    notes: 'Window seat if possible',
    idempotency_key: 'idem-1',
    ...overrides,
  };
}

function activeListing(overrides = {}) {
  return {
    listing_id: LISTING_ID,
    provider_id: PROVIDER_ID,
    listing_status: 'active',
    provider_status: 'live',
    price_cents: 120000,
    currency: 'KRW',
    ...overrides,
  };
}

function installDefaultMocks() {
  repository.withTransaction.mockImplementation(async (fn) => fn(jest.fn()));
  repository.lockIdempotencyKey.mockResolvedValue(undefined);
}

describe('services bookings', () => {
  beforeEach(() => {
    process.env.SERVICES_BOOKING_ENABLED = 'true';
    process.env.SERVICES_BOOKING_ADMIN_TOKEN = ADMIN_TOKEN;
    delete process.env.SERVICES_BOOKING_SLA_HOURS;
    delete process.env.SERVICES_BOOKING_DEPOSIT_PCT;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    Object.values(repository).forEach((mock) => mock.mockReset && mock.mockReset());
    installDefaultMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.SERVICES_BOOKING_ENABLED;
    delete process.env.SERVICES_BOOKING_ADMIN_TOKEN;
    delete process.env.SERVICES_BOOKING_SLA_HOURS;
    delete process.env.SERVICES_BOOKING_DEPOSIT_PCT;
  });

  test('state machine allows every valid transition and rejects every disallowed transition', () => {
    const valid = new Set(
      Object.entries(TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}:${to}`)),
    );

    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const key = `${from}:${to}`;
        if (valid.has(key)) {
          expect(isAllowedTransition(from, to)).toBe(true);
          expect(() => requireTransition(from, to)).not.toThrow();
        } else {
          expect(isAllowedTransition(from, to)).toBe(false);
          expect(() => requireTransition(from, to)).toThrow(BookingTransitionError);
        }
      }
    }
  });

  test('create happy path returns 201, inserts a row, and computes expires_at from SLA hours', async () => {
    process.env.SERVICES_BOOKING_SLA_HOURS = '6';
    repository.findByIdempotencyKey.mockResolvedValue(null);
    repository.findActiveListingWithProvider.mockResolvedValue(activeListing());
    repository.insert.mockImplementation(async (input) => bookingRow(input));

    const res = await request(app).post('/api/services/bookings').send(createPayload());

    expect(res.status).toBe(201);
    expect(repository.lockIdempotencyKey).toHaveBeenCalledWith('user-1', 'idem-1', expect.any(Function));
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        listing_id: LISTING_ID,
        provider_id: PROVIDER_ID,
        user_id: 'user-1',
        requested_slot: '2026-05-22T02:00:00.000Z',
        alternate_slots: ['2026-05-22T03:00:00.000Z'],
        status: 'requested',
        deposit_cents: 0,
        deposit_currency: 'KRW',
        deposit_payment_intent: null,
        contact_email: 'user@example.com',
        contact_phone: '+15555550100',
        notes: 'Window seat if possible',
        expires_at: '2026-05-22T06:00:00.000Z',
        metadata: { idempotency_key: 'idem-1' },
      }),
      expect.any(Function),
    );
    expect(res.body).toMatchObject({
      listing_id: LISTING_ID,
      provider_id: PROVIDER_ID,
      user_id: 'user-1',
      status: 'requested',
      expires_at: '2026-05-22T06:00:00.000Z',
    });
  });

  test('create idempotency returns 200 with the existing booking on retry', async () => {
    const inserted = bookingRow();
    const existing = bookingRow({ booking_id: '44444444-4444-4444-8444-444444444444' });
    repository.findByIdempotencyKey.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    repository.findActiveListingWithProvider.mockResolvedValue(activeListing());
    repository.insert.mockResolvedValue(inserted);

    const first = await request(app).post('/api/services/bookings').send(createPayload());
    const second = await request(app).post('/api/services/bookings').send(createPayload());

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.booking_id).toBe(existing.booking_id);
    expect(repository.insert).toHaveBeenCalledTimes(1);
    expect(repository.findActiveListingWithProvider).toHaveBeenCalledTimes(1);
  });

  test('create with a slot in the past returns 400 SLOT_TOO_SOON', async () => {
    const res = await request(app)
      .post('/api/services/bookings')
      .send(createPayload({ requested_slot: new Date(NOW - 60 * 1000).toISOString() }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SLOT_TOO_SOON');
    expect(repository.withTransaction).not.toHaveBeenCalled();
  });

  test('create with a non-existent listing returns 404 LISTING_UNAVAILABLE', async () => {
    repository.findByIdempotencyKey.mockResolvedValue(null);
    repository.findActiveListingWithProvider.mockResolvedValue(null);

    const res = await request(app).post('/api/services/bookings').send(createPayload());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('LISTING_UNAVAILABLE');
    expect(repository.insert).not.toHaveBeenCalled();
  });

  test('get public view hides PII while admin token reveals full booking', async () => {
    repository.findById.mockResolvedValue(bookingRow());

    const publicRes = await request(app).get(`/api/services/bookings/${BOOKING_ID}`);
    const adminRes = await request(app)
      .get(`/api/services/bookings/${BOOKING_ID}`)
      .set('X-Pivota-Admin-Token', ADMIN_TOKEN);

    expect(publicRes.status).toBe(200);
    expect(publicRes.body.booking_id).toBe(BOOKING_ID);
    expect(publicRes.body.contact_email).toBeUndefined();
    expect(publicRes.body.contact_phone).toBeUndefined();
    expect(publicRes.body.notes).toBeUndefined();
    expect(publicRes.body.metadata).toBeUndefined();
    expect(publicRes.body.user_id).toBeUndefined();
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.contact_email).toBe('user@example.com');
    expect(adminRes.body.user_id).toBe('user-1');
  });

  test('list by user_id returns that user booking list', async () => {
    repository.findByUser.mockResolvedValue([bookingRow(), bookingRow({ booking_id: '55555555-5555-4555-8555-555555555555' })]);

    const res = await request(app).get('/api/services/bookings').query({ user_id: 'user-1', limit: '2' });

    expect(res.status).toBe(200);
    expect(repository.findByUser).toHaveBeenCalledWith('user-1', { limit: 2, offset: 0 });
    expect(res.body.bookings).toHaveLength(2);
    expect(res.body.bookings.every((row) => row.user_id === 'user-1')).toBe(true);
  });

  test('list by provider_id requires admin token and returns provider bookings with token', async () => {
    repository.findByProvider.mockResolvedValue([bookingRow({ status: 'confirmed' })]);

    const forbidden = await request(app).get('/api/services/bookings').query({ provider_id: PROVIDER_ID });
    const allowed = await request(app)
      .get('/api/services/bookings')
      .set('X-Pivota-Admin-Token', ADMIN_TOKEN)
      .query({ provider_id: PROVIDER_ID, status: 'confirmed', limit: '5', offset: '1' });

    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('ADMIN_TOKEN_REQUIRED');
    expect(allowed.status).toBe(200);
    expect(repository.findByProvider).toHaveBeenCalledTimes(1);
    expect(repository.findByProvider).toHaveBeenCalledWith(PROVIDER_ID, {
      status: 'confirmed',
      limit: 5,
      offset: 1,
    });
    expect(allowed.body.bookings).toHaveLength(1);
  });

  test('cancel succeeds from requested and rejects mismatched user_id', async () => {
    repository.findById.mockResolvedValueOnce(bookingRow()).mockResolvedValueOnce(bookingRow({ user_id: 'other-user' }));
    repository.updateStatus.mockResolvedValue(bookingRow({ status: 'cancelled', cancelled_at: '2026-05-22T00:05:00.000Z' }));

    const ok = await request(app)
      .post(`/api/services/bookings/${BOOKING_ID}/cancel`)
      .send({ user_id: 'user-1' });
    const forbidden = await request(app)
      .post(`/api/services/bookings/${BOOKING_ID}/cancel`)
      .send({ user_id: 'user-1' });

    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('cancelled');
    expect(repository.updateStatus).toHaveBeenCalledWith(BOOKING_ID, 'cancelled');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('USER_ID_MISMATCH');
  });

  test('provider-action confirm and reject set the corresponding status and timestamp fields', async () => {
    repository.findById.mockResolvedValueOnce(bookingRow()).mockResolvedValueOnce(bookingRow());
    repository.updateStatus
      .mockResolvedValueOnce(bookingRow({ status: 'confirmed', provider_confirmed_at: '2026-05-22T00:10:00.000Z' }))
      .mockResolvedValueOnce(bookingRow({ status: 'rejected', provider_rejected_at: '2026-05-22T00:11:00.000Z' }));

    const confirmed = await request(app)
      .post(`/api/services/bookings/${BOOKING_ID}/provider-action`)
      .set('X-Pivota-Admin-Token', ADMIN_TOKEN)
      .send({ action: 'confirm', reason: 'Available' });
    const rejected = await request(app)
      .post(`/api/services/bookings/${BOOKING_ID}/provider-action`)
      .set('X-Pivota-Admin-Token', ADMIN_TOKEN)
      .send({ action: 'reject', reason: 'Fully booked' });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');
    expect(confirmed.body.provider_confirmed_at).toBe('2026-05-22T00:10:00.000Z');
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.provider_rejected_at).toBe('2026-05-22T00:11:00.000Z');
    expect(repository.updateStatus).toHaveBeenNthCalledWith(1, BOOKING_ID, 'confirmed', { reason: 'Available' });
    expect(repository.updateStatus).toHaveBeenNthCalledWith(2, BOOKING_ID, 'rejected', { reason: 'Fully booked' });
  });

  test('provider-action without admin token returns 403', async () => {
    const res = await request(app)
      .post(`/api/services/bookings/${BOOKING_ID}/provider-action`)
      .send({ action: 'confirm' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ADMIN_TOKEN_REQUIRED');
    expect(repository.findById).not.toHaveBeenCalled();
  });

  test('provider-action on an already-confirmed booking returns 409 INVALID_TRANSITION', async () => {
    repository.findById.mockResolvedValue(bookingRow({ status: 'confirmed' }));

    const res = await request(app)
      .post(`/api/services/bookings/${BOOKING_ID}/provider-action`)
      .set('X-Pivota-Admin-Token', ADMIN_TOKEN)
      .send({ action: 'confirm' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INVALID_TRANSITION');
    expect(res.body.current_status).toBe('confirmed');
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  test('sweep-expired returns the number of requested expired rows flipped', async () => {
    repository.sweepExpired.mockResolvedValue(3);

    const res = await request(app)
      .post('/api/services/bookings/sweep-expired')
      .set('X-Pivota-Admin-Token', ADMIN_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ swept: 3 });
    expect(repository.sweepExpired).toHaveBeenCalledTimes(1);
  });

  test('flag off returns 503 BOOKING_FLOW_DISABLED across all booking routes', async () => {
    delete process.env.SERVICES_BOOKING_ENABLED;
    const routes = [
      request(app).post('/api/services/bookings').send(createPayload()),
      request(app).get(`/api/services/bookings/${BOOKING_ID}`),
      request(app).get('/api/services/bookings').query({ user_id: 'user-1' }),
      request(app).post(`/api/services/bookings/${BOOKING_ID}/cancel`).send({ user_id: 'user-1' }),
      request(app).post(`/api/services/bookings/${BOOKING_ID}/provider-action`).send({ action: 'confirm' }),
      request(app).post('/api/services/bookings/sweep-expired'),
    ];

    const responses = await Promise.all(routes);

    expect(responses).toHaveLength(6);
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'BOOKING_FLOW_DISABLED' });
    }
    expect(repository.findById).not.toHaveBeenCalled();
    expect(repository.withTransaction).not.toHaveBeenCalled();
    expect(repository.sweepExpired).not.toHaveBeenCalled();
  });
});
