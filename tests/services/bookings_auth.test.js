// Services bookings: who may read or change a booking, and what leaves the server.
//
// `user_id` in a query or body is caller-typed, so it is not an identity. Before this, GET
// /api/services/bookings?user_id=X returned every booking of X with contact email, phone, notes and
// metadata, and POST /:id/cancel needed only a matching user_id. Every rule below has a refusing
// example next to the case it allows.

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

jest.mock('../../src/auroraBff/authStore', () => ({
  ...jest.requireActual('../../src/auroraBff/authStore'),
  resolveSessionFromToken: jest.fn(),
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

jest.mock('../../src/services/servicesSearch', () => ({
  ...jest.requireActual('../../src/services/servicesSearch'),
  getProviderById: jest.fn(async () => null),
}));

const request = require('supertest');
const repository = require('../../src/services/bookings/repository');
const authStore = require('../../src/auroraBff/authStore');
const logger = require('../../src/logger');
const http = require('http');
const server = require('../../src/server');
const { __test: bookingsInternals } = require('../../src/services/bookings/api');

const NOW = Date.parse('2026-05-22T00:00:00.000Z');
const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const LISTING_ID = '22222222-2222-4222-8222-222222222222';
const PROVIDER_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_TOKEN = 'admin-secret';
const PII_FIELDS = ['contact_email', 'contact_phone', 'notes', 'metadata'];

const SESSIONS = {
  'tok-owner': { userId: 'usr_owner', email: 'owner@example.com', expiresAt: null },
  'tok-other': { userId: 'usr_other', email: 'other@example.com', expiresAt: null },
};

function bookingRow(overrides = {}) {
  return {
    booking_id: BOOKING_ID,
    listing_id: LISTING_ID,
    provider_id: PROVIDER_ID,
    user_id: 'usr_owner',
    requested_slot: '2026-05-22T03:00:00.000Z',
    alternate_slots: [],
    status: 'requested',
    deposit_cents: 0,
    deposit_currency: 'KRW',
    deposit_payment_intent: null,
    contact_email: 'owner@example.com',
    contact_phone: '+15555550100',
    notes: 'Door code 4321',
    metadata: { idempotency_key: 'idem-1' },
    expires_at: '2026-05-23T00:00:00.000Z',
    created_at: '2026-05-22T00:00:01.000Z',
    updated_at: '2026-05-22T00:00:01.000Z',
    ...overrides,
  };
}

function createPayload(overrides = {}) {
  return {
    listing_id: LISTING_ID,
    user_id: 'guest-abc',
    requested_slot: new Date(NOW + 2 * 60 * 60 * 1000).toISOString(),
    contact_email: 'guest@example.com',
    idempotency_key: 'idem-1',
    ...overrides,
  };
}

function expectNoPii(row) {
  for (const field of PII_FIELDS) expect(row[field]).toBeUndefined();
  expect(row.user_id).toBeUndefined();
}

// One server bound to 127.0.0.1 (supertest(app) would listen on '::' per request and dial 127.0.0.1,
// which another process holding the same IPv4 port can answer under parallel load).
let app;

beforeAll((done) => {
  app = http.createServer(server).listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  app.close(done);
});

describe('services bookings: identity and PII', () => {
  beforeEach(() => {
    process.env.SERVICES_BOOKING_ENABLED = 'true';
    process.env.SERVICES_BOOKING_ADMIN_TOKEN = ADMIN_TOKEN;
    delete process.env.SERVICES_BOOKING_REQUIRE_AUTH;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    Object.values(repository).forEach((mock) => mock.mockReset && mock.mockReset());
    repository.withTransaction.mockImplementation(async (fn) => fn(jest.fn()));
    repository.lockIdempotencyKey.mockResolvedValue(undefined);
    authStore.resolveSessionFromToken.mockReset();
    authStore.resolveSessionFromToken.mockImplementation(async (token) => SESSIONS[token] || null);
    logger.warn.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.SERVICES_BOOKING_ENABLED;
    delete process.env.SERVICES_BOOKING_ADMIN_TOKEN;
    delete process.env.SERVICES_BOOKING_REQUIRE_AUTH;
  });

  describe('GET /api/services/bookings (list by user)', () => {
    test('an asserted user_id alone is refused before any read', async () => {
      repository.findByUser.mockResolvedValue([bookingRow()]);
      const res = await request(app).get('/api/services/bookings').query({ user_id: 'usr_owner' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'AUTH_REQUIRED', message: expect.any(String) });
      expect(repository.findByUser).not.toHaveBeenCalled();
    });

    test('the signed-in owner gets their bookings, and never contact email, phone, notes or metadata', async () => {
      repository.findByUser.mockResolvedValue([bookingRow(), bookingRow({ booking_id: '55555555-5555-4555-8555-555555555555' })]);
      const res = await request(app)
        .get('/api/services/bookings')
        .set('Authorization', 'Bearer tok-owner')
        .query({ user_id: 'usr_owner' });
      expect(res.status).toBe(200);
      expect(repository.findByUser).toHaveBeenCalledWith('usr_owner', { limit: 20, offset: 0 });
      expect(res.body.bookings).toHaveLength(2);
      res.body.bookings.forEach(expectNoPii);
      expect(res.body.bookings[0].booking_id).toBe(BOOKING_ID);
      expect(res.body.bookings[0].status).toBe('requested');
    });

    test('a session with no user_id lists that session’s own bookings', async () => {
      repository.findByUser.mockResolvedValue([bookingRow()]);
      const res = await request(app).get('/api/services/bookings').set('Authorization', 'Bearer tok-owner');
      expect(res.status).toBe(200);
      expect(repository.findByUser).toHaveBeenCalledWith('usr_owner', expect.any(Object));
    });

    test('a session cannot list someone else by asserting their user_id', async () => {
      const res = await request(app)
        .get('/api/services/bookings')
        .set('Authorization', 'Bearer tok-other')
        .query({ user_id: 'usr_owner' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('USER_ID_MISMATCH');
      expect(repository.findByUser).not.toHaveBeenCalled();
    });

    test('an invalid or expired bearer is 401, not a fall-back to the asserted user_id', async () => {
      const res = await request(app)
        .get('/api/services/bookings')
        .set('Authorization', 'Bearer tok-dead')
        .query({ user_id: 'usr_owner' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('AUTH_INVALID');
      expect(repository.findByUser).not.toHaveBeenCalled();
    });

    test('a session lookup failure fails closed (503), not open', async () => {
      authStore.resolveSessionFromToken.mockRejectedValue(new Error('db down'));
      const res = await request(app)
        .get('/api/services/bookings')
        .set('Authorization', 'Bearer tok-owner')
        .query({ user_id: 'usr_owner' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('AUTH_UNAVAILABLE');
      expect(repository.findByUser).not.toHaveBeenCalled();
    });

    test('the admin token is not a user: it cannot list by user_id either', async () => {
      const res = await request(app)
        .get('/api/services/bookings')
        .set('X-Pivota-Admin-Token', ADMIN_TOKEN)
        .query({ user_id: 'usr_owner' });
      expect(res.status).toBe(401);
      expect(repository.findByUser).not.toHaveBeenCalled();
    });

    test('SERVICES_BOOKING_REQUIRE_AUTH=false restores the asserted user_id, still without contact fields', async () => {
      process.env.SERVICES_BOOKING_REQUIRE_AUTH = 'false';
      repository.findByUser.mockResolvedValue([bookingRow()]);
      const res = await request(app).get('/api/services/bookings').query({ user_id: 'usr_owner' });
      expect(res.status).toBe(200);
      expect(repository.findByUser).toHaveBeenCalledWith('usr_owner', expect.any(Object));
      res.body.bookings.forEach(expectNoPii);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ route: 'list', auth_enforced: false }),
        expect.any(String),
      );
    });

    test('only the exact value "false" turns enforcement off', () => {
      for (const value of [undefined, '', 'true', '0', 'no', 'off']) {
        if (value === undefined) delete process.env.SERVICES_BOOKING_REQUIRE_AUTH;
        else process.env.SERVICES_BOOKING_REQUIRE_AUTH = value;
        expect(bookingsInternals.isBookingAuthEnforced()).toBe(true);
      }
      for (const value of ['false', 'FALSE', ' false ']) {
        process.env.SERVICES_BOOKING_REQUIRE_AUTH = value;
        expect(bookingsInternals.isBookingAuthEnforced()).toBe(false);
      }
    });
  });

  describe('GET /api/services/bookings/:id', () => {
    test('a matching ?user_id= is not ownership: the public view, no contact fields', async () => {
      repository.findById.mockResolvedValue(bookingRow());
      const res = await request(app).get(`/api/services/bookings/${BOOKING_ID}`).query({ user_id: 'usr_owner' });
      expect(res.status).toBe(200);
      expect(res.body.booking_id).toBe(BOOKING_ID);
      expectNoPii(res.body);
    });

    test('the flag does not relax it either', async () => {
      process.env.SERVICES_BOOKING_REQUIRE_AUTH = 'false';
      repository.findById.mockResolvedValue(bookingRow());
      const res = await request(app).get(`/api/services/bookings/${BOOKING_ID}`).query({ user_id: 'usr_owner' });
      expectNoPii(res.body);
    });

    test('the signed-in owner sees the full booking; another signed-in user does not', async () => {
      repository.findById.mockResolvedValue(bookingRow());
      const owner = await request(app).get(`/api/services/bookings/${BOOKING_ID}`).set('Authorization', 'Bearer tok-owner');
      const other = await request(app).get(`/api/services/bookings/${BOOKING_ID}`).set('Authorization', 'Bearer tok-other');
      expect(owner.status).toBe(200);
      expect(owner.body.contact_email).toBe('owner@example.com');
      expect(owner.body.notes).toBe('Door code 4321');
      expect(other.status).toBe(200);
      expectNoPii(other.body);
    });

    test('the admin token still sees the full booking', async () => {
      repository.findById.mockResolvedValue(bookingRow());
      const res = await request(app).get(`/api/services/bookings/${BOOKING_ID}`).set('X-Pivota-Admin-Token', ADMIN_TOKEN);
      expect(res.body.contact_email).toBe('owner@example.com');
    });
  });

  describe('POST /api/services/bookings/:id/cancel', () => {
    test('an asserted user_id alone is refused before the booking is even looked up', async () => {
      repository.findById.mockResolvedValue(bookingRow());
      const res = await request(app).post(`/api/services/bookings/${BOOKING_ID}/cancel`).send({ user_id: 'usr_owner' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('AUTH_REQUIRED');
      expect(repository.findById).not.toHaveBeenCalled();
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    test('another signed-in user cannot cancel it', async () => {
      repository.findById.mockResolvedValue(bookingRow());
      const res = await request(app).post(`/api/services/bookings/${BOOKING_ID}/cancel`).set('Authorization', 'Bearer tok-other').send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('USER_ID_MISMATCH');
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    test('a session cannot borrow the owner’s user_id in the body', async () => {
      repository.findById.mockResolvedValue(bookingRow());
      const res = await request(app)
        .post(`/api/services/bookings/${BOOKING_ID}/cancel`)
        .set('Authorization', 'Bearer tok-other')
        .send({ user_id: 'usr_owner' });
      expect(res.status).toBe(403);
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    test('the signed-in owner cancels', async () => {
      repository.findById.mockResolvedValue(bookingRow());
      repository.updateStatus.mockResolvedValue(bookingRow({ status: 'cancelled' }));
      const res = await request(app).post(`/api/services/bookings/${BOOKING_ID}/cancel`).set('Authorization', 'Bearer tok-owner').send({});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
      expect(repository.updateStatus).toHaveBeenCalledWith(BOOKING_ID, 'cancelled');
    });

    test('with the flag off an asserted owner may cancel, and gets the public view back', async () => {
      process.env.SERVICES_BOOKING_REQUIRE_AUTH = 'false';
      repository.findById.mockResolvedValue(bookingRow());
      repository.updateStatus.mockResolvedValue(bookingRow({ status: 'cancelled' }));
      const ok = await request(app).post(`/api/services/bookings/${BOOKING_ID}/cancel`).send({ user_id: 'usr_owner' });
      expect(ok.status).toBe(200);
      expectNoPii(ok.body);
      const wrong = await request(app).post(`/api/services/bookings/${BOOKING_ID}/cancel`).send({ user_id: 'usr_other' });
      expect(wrong.status).toBe(403);
    });
  });

  describe('POST /api/services/bookings (create)', () => {
    test('a guest can still book (the live agent-ui sheet), and gets the public view back', async () => {
      repository.findByIdempotencyKey.mockResolvedValue(null);
      repository.findActiveListingWithProvider.mockResolvedValue({
        listing_id: LISTING_ID,
        provider_id: PROVIDER_ID,
        listing_status: 'active',
        provider_status: 'live',
        price_cents: 1000,
        currency: 'KRW',
      });
      repository.insert.mockImplementation(async (input) => bookingRow(input));
      const res = await request(app).post('/api/services/bookings').send(createPayload());
      expect(res.status).toBe(201);
      expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'guest-abc' }), expect.any(Function));
      expect(res.body.booking_id).toBeTruthy();
      expect(res.body.status).toBe('requested');
      expectNoPii(res.body);
    });

    test('an idempotent replay with someone’s user_id + key does not return their contact details', async () => {
      repository.findByIdempotencyKey.mockResolvedValue(bookingRow({ user_id: 'guest-abc' }));
      const res = await request(app).post('/api/services/bookings').send(createPayload());
      expect(res.status).toBe(200);
      expect(res.body.booking_id).toBe(BOOKING_ID);
      expectNoPii(res.body);
    });

    test('a signed-in request books as the session user, and may not book as someone else', async () => {
      repository.findByIdempotencyKey.mockResolvedValue(null);
      repository.findActiveListingWithProvider.mockResolvedValue({
        listing_id: LISTING_ID,
        provider_id: PROVIDER_ID,
        listing_status: 'active',
        provider_status: 'live',
        price_cents: 1000,
        currency: 'KRW',
      });
      repository.insert.mockImplementation(async (input) => bookingRow(input));

      const mine = await request(app)
        .post('/api/services/bookings')
        .set('Authorization', 'Bearer tok-owner')
        .send(createPayload({ user_id: undefined }));
      expect(mine.status).toBe(201);
      expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'usr_owner' }), expect.any(Function));
      expect(mine.body.contact_email).toBe('guest@example.com');

      repository.insert.mockClear();
      const theirs = await request(app)
        .post('/api/services/bookings')
        .set('Authorization', 'Bearer tok-owner')
        .send(createPayload({ user_id: 'usr_other' }));
      expect(theirs.status).toBe(403);
      expect(theirs.body.error).toBe('USER_ID_MISMATCH');
      expect(repository.insert).not.toHaveBeenCalled();
    });
  });
});
