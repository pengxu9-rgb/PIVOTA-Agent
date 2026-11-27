'use strict';

// AgenPas shipping-address collection (docs/agenpas.md, "Shipping address"): the adapter and validation
// (src/agenpas/shippingAddress.js), the view's address screen (src/agenpas/view.js), the POST route
// (src/agenpas/router.js) on a bare Express app, the backend writer (src/agenpas/purchaseReader.js) against a stubbed
// fetch, and the needs_address dev fixture. Placeholder people and places only. Loopback only.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const supertest = require('supertest');

const { readAddressRequest, validateAddress, sanitizeFieldErrors, ADDRESS_FIELDS, US_STATES } = require('../src/agenpas/shippingAddress');
const { projectPurchaseView } = require('../src/agenpas/view');
const { createAgenpasRouter } = require('../src/agenpas/router');
const { createBackendPurchaseReader, INTERNAL_PURCHASES_PATH } = require('../src/agenpas/purchaseReader');
const { mintLinkToken } = require('../src/agenpas/linkToken');
const { SCENARIOS } = require('../src/agenpas/devFixtures');

const servers = [];
test.after(() => { for (const srv of servers) srv.close(); });
function listening(a) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(a);
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { servers.push(srv); resolve(srv); });
  });
}
const PUBLIC_HOST = 'agenpas.example';
function request(a, host = PUBLIC_HOST) {
  const verb = (method) => (path) => {
    const steps = [];
    const chain = {
      set(...x) { steps.push(['set', x]); return chain; },
      send(...x) { steps.push(['send', x]); return chain; },
      type(...x) { steps.push(['type', x]); return chain; },
      then(onOk, onErr) {
        return listening(a).then((srv) => {
          let t = supertest(srv)[method](path).set('Host', host);
          for (const [name, x] of steps) t = t[name](...x);
          return t;
        }).then(onOk, onErr);
      },
    };
    return chain;
  };
  return { get: verb('get'), post: verb('post') };
}

const SECRET = 'address-test-secret-0123456789abcdef-0123';
const AUD = `https://${PUBLIC_HOST}`;
const PID = 'ap_0123456789abcdef01234567';
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const CLAIMS = Object.freeze({ purchaseId: PID, agentId: 'agent_fixture_1', userRef: 'usr_fixtureFixtureFixture', aud: AUD });
const ENV_ON = Object.freeze({
  AGENPAS_ENABLED: '1', AGENPAS_LINK_SECRET: SECRET, AGENPAS_PUBLIC_BASE_URL: AUD, AGENPAS_COLLECT_SHIPPING: '1',
});
const ENV_OFF = Object.freeze({ ...ENV_ON, AGENPAS_COLLECT_SHIPPING: undefined });

// Distinctive placeholder values: the needle test looks for each of them in every log line and refusal.
const ADDRESS = Object.freeze({
  email: 'needle.person@example.test', firstName: 'Needlefirst', lastName: 'Needlelast', phone: '(415) 555-0142',
  addressLine1: '742 Needle Lane', addressLine2: 'Unit 9Z', city: 'Needleton', region: 'ca', postalCode: '94107',
  country: 'US',
});
const NORMALISED = Object.freeze({ ...ADDRESS, phone: '+14155550142', region: 'CA' });
const NEEDLES = ['needle.person', 'Needlefirst', 'Needlelast', '555-0142', '5550142', '742 Needle', 'Unit 9Z', 'Needleton', '94107'];

function token(over = {}) {
  return mintLinkToken({ ...CLAIMS, secret: SECRET, now: NOW, ...over });
}

function addressAction(over = {}) {
  return { kind: 'shipping_address', fields_missing: [...ADDRESS_FIELDS], expires_at: '2026-11-18T12:30:00Z', ...over };
}

function body(state = 'routing', extra = {}) {
  return {
    purchase_id: 'pp_aaaaaaaaaaaaaaaaaaaaaaaa', rail: 'a2a', rail_purchase_id: PID, state,
    totals: { currency: 'USD', our_price_minor: 1800 }, poll_after_seconds: 5,
    next_action: addressAction(),
    detail: { id: PID, merchant_domain: 'merchant.example', product_name: 'Sample Lip Gloss', quantity: 1 },
    ...extra,
  };
}

function fakeBackend({ view = body(), submit } = {}) {
  const calls = [];
  return {
    calls,
    async read(claims) { calls.push({ op: 'read', claims }); return { kind: 'accepted', purchase: typeof view === 'function' ? view() : view }; },
    async submitShippingAddress(claims, address) {
      calls.push({ op: 'submit', claims, address });
      if (submit) return submit(claims, address);
      return { kind: 'accepted', purchase: body('needs_payment_method', { next_action: { kind: 'card_binding', url: 'https://pay.partner.example/bind', expires_at: '2026-11-18T12:30:00Z' } }) };
    },
  };
}

function recordingLogger() {
  const lines = [];
  const sink = (o, msg) => lines.push({ ...o, msg });
  return { lines, info: sink, warn: sink, error: sink };
}

function app({ env = ENV_ON, reader = fakeBackend(), logger, limits, now = () => NOW } = {}) {
  const a = express();
  a.use(createAgenpasRouter({ reader, env, now, logger, limits: { ip: { capacity: 1000 }, ...(limits || {}) } }));
  a.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return a;
}

const post = (a, payload = ADDRESS, t = token()) => request(a).post(`/agenpas/api/p/${PID}/shipping-address`)
  .set('X-Agenpas-Link', t).set('Content-Type', 'application/json').send(JSON.stringify(payload));

// ---- the adapter -----------------------------------------------------------------------------------------------

test('adapter: a shipping_address next_action in a pre-placing state is an address request (fields in form order)', () => {
  for (const state of ['routing', 'locking', 'needs_payment_method', 'needs_shipping_address']) {
    const req = readAddressRequest(state, addressAction({ fields_missing: ['postal_code', 'email', 'state'] }), { now: NOW });
    assert.deepEqual(req.fields_missing, ['email', 'region', 'postalCode'], state);
    assert.equal(req.expires_at, '2026-11-18T12:30:00.000Z');
  }
  for (const state of ['placing', 'completed', 'failed', 'refused', 'expired']) {
    assert.equal(readAddressRequest(state, addressAction(), { now: NOW }), null, state);
  }
  // The state alone (no action) asks for every field.
  assert.deepEqual(readAddressRequest('needs_shipping_address', null, { now: NOW }).fields_missing, [...ADDRESS_FIELDS]);
  // Unknown field names only, past or unreadable deadline: no request.
  assert.equal(readAddressRequest('routing', addressAction({ fields_missing: ['shoe_size'] }), { now: NOW }), null);
  assert.equal(readAddressRequest('routing', addressAction({ expires_at: '2026-11-18T11:00:00Z' }), { now: NOW }), null);
  assert.equal(readAddressRequest('routing', addressAction({ expires_at: 'soon' }), { now: NOW }), null);
  assert.ok(readAddressRequest('routing', addressAction({ expires_at: undefined }), { now: NOW }));
  // Another kind is not an address request.
  assert.equal(readAddressRequest('routing', { kind: 'card_binding', url: 'https://x.example' }, { now: NOW }), null);
});

test('adapter: prefill is allowlisted and cleaned', () => {
  const req = readAddressRequest('routing', addressAction({ prefill: { country: 'US', first_name: 'Sam', card_number: '4111', city: 'a\u0000b' } }), { now: NOW });
  assert.deepEqual(req.prefill, { country: 'US', firstName: 'Sam' });
});

// ---- the view --------------------------------------------------------------------------------------------------

const view = (b, opts = {}) => projectPurchaseView(b, { purchaseId: PID, hostedHosts: ['pay.partner.example'], now: NOW, ...opts });

test('view: collection on -> the address screen with the request; off -> the "add it in the chat" screen, no request', () => {
  const on = view(body(), { collectShipping: true });
  assert.equal(on.screen, 'shipping_address');
  assert.deepEqual(on.address_request.fields_missing, [...ADDRESS_FIELDS]);
  assert.equal(on.action, null);
  assert.equal(on.terminal, false);
  const off = view(body(), { collectShipping: false });
  assert.equal(off.screen, 'shipping_address_elsewhere');
  assert.equal(Object.hasOwn(off, 'address_request'), false);
});

test('view: a hold beats the address step (no form, the checking screen)', () => {
  const held = view(body('routing', { detail: { id: PID, last_error_code: 'money_result_seen' } }), { collectShipping: true });
  assert.equal(held.screen, 'outcome_unknown');
  assert.equal(Object.hasOwn(held, 'address_request'), false);
});

test('flag-off identity: every view without an address step projects byte-identically with collection on or off', () => {
  const bodies = [
    body('routing', { next_action: undefined }),
    body('needs_payment_method', { next_action: { kind: 'card_binding', url: 'https://pay.partner.example/bind', expires_at: '2026-11-18T12:30:00Z' } }),
    body('awaiting_buyer_authorization', { next_action: { kind: 'approval', url: 'https://pay.partner.example/ok', expires_at: '2026-11-18T12:30:00Z' } }),
    body('placing', { next_action: addressAction() }), // an address action outside pre-placing states is ignored
    body('completed', { next_action: undefined, order_reference: '#1', totals: { currency: 'USD', final_total_minor: 1900 } }),
    body('failed', { next_action: undefined, detail: { last_error_code: 'checkout_relay_refused' } }),
  ];
  for (const b of bodies) {
    assert.equal(JSON.stringify(view(b, { collectShipping: true })), JSON.stringify(view(b, { collectShipping: false })), b.state);
    assert.equal(JSON.stringify(view(b, { collectShipping: true })), JSON.stringify(view(b)), b.state);
  }
});

// ---- validation (server side) ----------------------------------------------------------------------------------

test('validation: a complete US address is normalised (E.164 phone, upper-case state and country, ZIP)', () => {
  const out = validateAddress(ADDRESS, { required: ADDRESS_FIELDS });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, NORMALISED);
  assert.equal(validateAddress({ ...ADDRESS, postalCode: '94107-1234' }).value.postalCode, '94107-1234');
  assert.equal(validateAddress({ ...ADDRESS, postalCode: '941071234' }).value.postalCode, '94107-1234');
  assert.equal(validateAddress({ ...ADDRESS, phone: '+1 415 555 0142' }).value.phone, '+14155550142');
  assert.equal(validateAddress({ ...ADDRESS, phone: '1-415-555-0142' }).value.phone, '+14155550142');
});

test('validation: every rule answers a CODE per field, never the value', () => {
  const cases = [
    [{ email: 'not-an-email' }, 'email', 'invalid_email'],
    [{ email: `${'a'.repeat(201)}@x.co` }, 'email', 'too_long'],
    [{ phone: '555-01' }, 'phone', 'invalid_phone'],
    [{ phone: '415 555 0142 ext 2' }, 'phone', 'invalid_phone'],
    [{ postalCode: '9410' }, 'postalCode', 'invalid_postal_code'],
    [{ postalCode: 'ABCDE' }, 'postalCode', 'invalid_postal_code'],
    [{ region: 'ZZ' }, 'region', 'invalid_region'],
    [{ region: 'California' }, 'region', 'invalid_region'],
    [{ country: 'CA' }, 'country', 'unsupported_country'],
    [{ city: 'Needle\u0007ton' }, 'city', 'invalid_characters'],
    [{ addressLine1: 'x'.repeat(201) }, 'addressLine1', 'too_long'],
    [{ firstName: 42 }, 'firstName', 'invalid'],
    [{ cardNumber: '4111111111111111' }, 'cardNumber', 'unknown_field'],
  ];
  for (const [over, field, code] of cases) {
    const out = validateAddress({ ...ADDRESS, ...over }, { required: ADDRESS_FIELDS });
    assert.equal(out.ok, false, field);
    assert.equal(out.field_errors[field], code, `${field} ${JSON.stringify(over).slice(0, 40)}`);
    for (const needle of [...NEEDLES, '4111111111111111']) assert.equal(JSON.stringify(out).includes(needle), false);
  }
  // Required = the request's fields_missing (addressLine2, region and postalCode are never required).
  const partial = validateAddress({ email: ADDRESS.email },
    { required: ['email', 'phone', 'addressLine2', 'region', 'postalCode'] });
  assert.deepEqual(partial.field_errors, { phone: 'required' });
  assert.equal(validateAddress({}, { required: [] }).field_errors._body, 'empty');
  assert.equal(validateAddress('x').ok, false);
  assert.equal(US_STATES.length, 51);
});

test('validation: no state or ZIP is required, even when the request names every field; one given is still checked', () => {
  const { region, postalCode, ...bare } = ADDRESS; // eslint-disable-line no-unused-vars
  const out = validateAddress(bare, { required: ADDRESS_FIELDS });
  assert.equal(out.ok, true);
  assert.equal('region' in out.value || 'postalCode' in out.value, false);
  assert.deepEqual(validateAddress({ ...bare, region: 'ZZ' }, { required: ADDRESS_FIELDS }).field_errors, { region: 'invalid_region' });
  assert.deepEqual(validateAddress({ ...bare, postalCode: '941' }, { required: ADDRESS_FIELDS }).field_errors,
    { postalCode: 'invalid_postal_code' });
});

test('the backend\'s field errors are kept only as {known field: code}', () => {
  assert.deepEqual(sanitizeFieldErrors({ postal_code: 'invalid', email: 'Needle value!', other: 'x', city: 'too_long' }),
    { postalCode: 'invalid', city: 'too_long' });
});

// ---- the route -------------------------------------------------------------------------------------------------

test('POST: validates, forwards the NORMALISED address for the token\'s owner, answers the next view', async () => {
  const reader = fakeBackend();
  const res = await post(app({ reader }));
  assert.equal(res.status, 200);
  assert.equal(res.body.screen, 'add_card');
  const submit = reader.calls.find((c) => c.op === 'submit');
  assert.deepEqual(submit.address, NORMALISED);
  assert.equal(submit.claims.agentId, CLAIMS.agentId);
  assert.equal(submit.claims.purchaseId, PID);
});

test('POST: only application/json (415), at most 4 KB (413), malformed JSON (400)', async () => {
  const reader = fakeBackend();
  const a = app({ reader });
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx']) {
    const res = await request(a).post(`/agenpas/api/p/${PID}/shipping-address`).set('X-Agenpas-Link', token()).set('Content-Type', type).send('email=x');
    assert.equal(res.status, 415, type);
  }
  const big = await post(a, { ...ADDRESS, addressLine2: 'x'.repeat(5000) });
  assert.equal(big.status, 413);
  const bad = await request(a).post(`/agenpas/api/p/${PID}/shipping-address`).set('X-Agenpas-Link', token()).set('Content-Type', 'application/json').send('{"email":');
  assert.equal(bad.status, 400);
  assert.equal(reader.calls.filter((c) => c.op === 'submit').length, 0);
});

test('POST: the link token only in the header (never a cookie or the query); refused links never reach the backend', async () => {
  const reader = fakeBackend();
  const a = app({ reader });
  const noHeader = await request(a).post(`/agenpas/api/p/${PID}/shipping-address?t=${token()}`).set('Content-Type', 'application/json')
    .set('Cookie', `t=${token()}`).send(JSON.stringify(ADDRESS));
  assert.equal(noHeader.status, 404);
  assert.equal(noHeader.body.error, 'link_invalid');
  const expired = await post(a, ADDRESS, token({ now: NOW - 31 * 60_000 }));
  assert.equal(expired.status, 410);
  assert.equal(reader.calls.length, 0);
});

test('POST: 5 a minute per link (429 with Retry-After)', async () => {
  const reader = fakeBackend();
  const a = app({ reader });
  const t = token();
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await post(a, ADDRESS, t)).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  const limited = await post(a, ADDRESS, t);
  assert.ok(limited.headers['retry-after']);
});

test('POST: the per-IP bucket applies too', async () => {
  const a = app({ limits: { ip: { capacity: 1, refillPerSecond: 0.0001 } } });
  assert.equal((await post(a).set('X-Forwarded-For', '203.0.113.5, 198.51.100.1')).status, 200);
  assert.equal((await post(a).set('X-Forwarded-For', '203.0.113.5, 198.51.100.1')).status, 429);
});

test('POST: required fields follow the view\'s fields_missing; gateway 422 names fields with codes only', async () => {
  const reader = fakeBackend({ view: body('routing', { next_action: addressAction({ fields_missing: ['email', 'phone'] }) }) });
  const a = app({ reader });
  const missing = await post(a, { email: ADDRESS.email });
  assert.equal(missing.status, 422);
  assert.deepEqual(missing.body, { error: 'invalid_address', field_errors: { phone: 'required' } });
  const wrong = await post(a, { email: 'nope', phone: ADDRESS.phone });
  assert.deepEqual(wrong.body.field_errors, { email: 'invalid_email' });
  const ok = await post(a, { email: ADDRESS.email, phone: ADDRESS.phone });
  assert.equal(ok.status, 200);
});

test('POST: the backend\'s 422 / 409 / 404 / outage map to inline errors, "already have it", not found, retry later', async () => {
  const answer = (kind, extra = {}) => fakeBackend({ submit: () => ({ kind, ...extra }) });
  const invalid = await post(app({ reader: answer('invalid', { field_errors: { postalCode: 'not_deliverable' } }) }));
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body, { error: 'invalid_address', field_errors: { postalCode: 'not_deliverable' } });
  const conflict = await post(app({ reader: answer('conflict') }));
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, { error: 'address_already_set' });
  const gone = await post(app({ reader: answer('not_found') }));
  assert.equal(gone.status, 404);
  const down = await post(app({ reader: answer('unavailable', { code: 'timeout' }) }));
  assert.equal(down.status, 503);
  assert.ok(down.headers['retry-after']);
});

test('POST: no address request in the view (already given, or moved on): refused in the gateway, nothing sent', async () => {
  const reader = fakeBackend({ view: body('needs_payment_method', { next_action: undefined }) });
  const res = await post(app({ reader }));
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'address_not_requested' });
  assert.equal(reader.calls.filter((c) => c.op === 'submit').length, 0);
});

test('POST with AGENPAS_COLLECT_SHIPPING off (or AgenPas off): the route does not exist', async () => {
  for (const env of [ENV_OFF, { ...ENV_ON, AGENPAS_ENABLED: undefined }]) {
    const reader = fakeBackend();
    const res = await post(app({ env, reader }));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'NOT_FOUND');
    assert.equal(reader.calls.length, 0);
  }
});

test('no PII in logs or refusals (needle test): success, gateway 422, backend 422, 409, 413 and 415', async () => {
  const logger = recordingLogger();
  const responses = [];
  const run = async (reader, payload = ADDRESS) => responses.push(await post(app({ reader, logger }), payload));
  await run(fakeBackend());
  await run(fakeBackend(), { ...ADDRESS, email: 'needle.person@@example' });
  await run(fakeBackend({ submit: () => ({ kind: 'invalid', field_errors: { city: 'Needleton is not a city' } }) }));
  await run(fakeBackend({ submit: () => ({ kind: 'conflict' }) }));
  await run(fakeBackend(), { ...ADDRESS, addressLine2: `Unit 9Z ${'x'.repeat(5000)}` });
  const text = JSON.stringify(logger.lines) + responses.filter((r) => r.status !== 200).map((r) => r.text).join('');
  for (const needle of NEEDLES) assert.equal(text.includes(needle), false, needle);
  assert.ok(logger.lines.length > 0);
});

// ---- the backend writer ----------------------------------------------------------------------------------------

function stubFetch(answer) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
      return { status: answer.status, text: async () => text };
    },
  };
}

test('writer: one POST to the internal route with the internal key, the owner and the address as JSON', async () => {
  const stub = stubFetch({ status: 200, body: body('needs_payment_method', { next_action: undefined }) });
  const writer = createBackendPurchaseReader({ baseUrl: 'https://backend.internal.example', internalKey: () => 'k', fetchImpl: stub.fetchImpl });
  const out = await writer.submitShippingAddress(CLAIMS, NORMALISED);
  assert.equal(out.kind, 'accepted');
  const [{ url, init }] = stub.calls;
  assert.equal(url, `https://backend.internal.example${INTERNAL_PURCHASES_PATH}/${PID}/shipping-address`);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['X-Internal-Key'], 'k');
  assert.equal(init.headers['X-Agenpas-Agent-Id'], CLAIMS.agentId);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), NORMALISED);
});

test('writer: 422 (top level or under detail), 409, 404 and 5xx outcomes', async () => {
  const mk = (answer) => createBackendPurchaseReader({ baseUrl: 'https://b.example', internalKey: () => 'k', fetchImpl: stubFetch(answer).fetchImpl });
  assert.deepEqual(await mk({ status: 422, body: { field_errors: { postal_code: 'invalid' } } }).submitShippingAddress(CLAIMS, NORMALISED),
    { kind: 'invalid', field_errors: { postalCode: 'invalid' } });
  assert.deepEqual(await mk({ status: 422, body: { detail: { field_errors: { email: 'invalid' } } } }).submitShippingAddress(CLAIMS, NORMALISED),
    { kind: 'invalid', field_errors: { email: 'invalid' } });
  assert.deepEqual(await mk({ status: 409, body: { error: 'shipping_address_conflict' } }).submitShippingAddress(CLAIMS, NORMALISED), { kind: 'conflict' });
  assert.deepEqual(await mk({ status: 409, body: {} }).submitShippingAddress(CLAIMS, NORMALISED), { kind: 'not_taken', code: 'unnamed' });
  assert.deepEqual(await mk({ status: 404, body: {} }).submitShippingAddress(CLAIMS, NORMALISED), { kind: 'not_found' });
  assert.equal((await mk({ status: 503, body: 'x' }).submitShippingAddress(CLAIMS, NORMALISED)).kind, 'unavailable');
  assert.equal((await createBackendPurchaseReader({ baseUrl: 'https://b.example', internalKey: () => '' }).submitShippingAddress(CLAIMS, NORMALISED)).code, 'unconfigured');
});

// ---- the needs_address dev fixture -----------------------------------------------------------------------------

test('fixture needs_address: the form, then the card step; once given, any address is refused in the gateway (409, nothing sent)', async () => {
  const local = { ...ENV_ON, AGENPAS_DEV_FIXTURES: '1', AGENPAS_PUBLIC_BASE_URL: 'http://localhost:4000' };
  let clock = NOW;
  const a = express();
  a.use(createAgenpasRouter({ reader: fakeBackend(), env: local, now: () => clock, limits: { ip: { capacity: 1000 } } }));
  const start = await request(a, 'localhost:4000').get('/agenpas/dev/start?scenario=needs_address');
  const loc = new URL(start.headers.location, 'http://localhost');
  assert.equal(loc.pathname, `/agenpas/p/${SCENARIOS.needs_address.id}`);
  const t = new URLSearchParams(loc.hash.slice(1)).get('t');
  const id = SCENARIOS.needs_address.id;
  const get = () => request(a, 'localhost:4000').get(`/agenpas/api/p/${id}`).set('X-Agenpas-Link', t);
  const send = (payload) => request(a, 'localhost:4000').post(`/agenpas/api/p/${id}/shipping-address`).set('X-Agenpas-Link', t)
    .set('Content-Type', 'application/json').send(JSON.stringify(payload));
  const first = await get();
  assert.equal(first.body.screen, 'shipping_address');
  assert.equal(first.body.address_request.prefill.country, 'US');
  const saved = await send(ADDRESS);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.screen, 'add_card');
  clock += 3000;
  assert.equal((await get()).body.screen, 'add_card');
  for (const again of [ADDRESS, { ...ADDRESS, city: 'Othertown' }]) {
    const res = await send(again);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'address_not_requested' });
  }
});
