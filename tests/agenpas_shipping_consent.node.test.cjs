'use strict';

// The A2A shipping-address step behind the terms / privacy consent (docs/agenpas.md, "Shipping address" and "Terms
// and privacy consent"; the owner's decision of 11-20): the view (src/agenpas/view.js), the consent POST and the
// address POST (src/agenpas/router.js) on a bare Express app behind the host guard, the backend writer's 409 envelope
// (src/agenpas/purchaseReader.js) against a stubbed fetch, and the address_consent dev fixture. Placeholder people,
// places and hosts only. Loopback only.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const supertest = require('supertest');

const { ADDRESS_FIELDS } = require('../src/agenpas/shippingAddress');
const { consentToRecord, projectPurchaseView, shippingConsentPending } = require('../src/agenpas/view');
const { createAgenpasRouter, createAgenpasHostGuard } = require('../src/agenpas/router');
const { createBackendPurchaseReader } = require('../src/agenpas/purchaseReader');
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

const SECRET = 'ship-consent-test-secret-0123456789abcdef';
const AUD = `https://${PUBLIC_HOST}`;
const PID = 'ap_0123456789abcdef01234567';
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const CLAIMS = Object.freeze({ purchaseId: PID, agentId: 'agent_fixture_1', userRef: 'usr_fixtureFixtureFixture', aud: AUD });
const ENV_ON = Object.freeze({
  AGENPAS_ENABLED: '1', AGENPAS_LINK_SECRET: SECRET, AGENPAS_PUBLIC_BASE_URL: AUD, AGENPAS_COLLECT_SHIPPING: '1',
  AGENPAS_CONSENT_ENABLED: '1', AGENPAS_LEGAL_HOSTS: 'legal.example',
});
const ENV_CONSENT_OFF = Object.freeze({ ...ENV_ON, AGENPAS_CONSENT_ENABLED: undefined });
const OFFER = Object.freeze({ id: 'offer0123456789abcdef0123456789ab', issued_at: '2026-11-20T11:59:50Z' });
const DEADLINE = '2026-11-20T12:30:00Z';
const VIEW_OPTS = Object.freeze({ purchaseId: PID, now: NOW, collectShipping: true, consentEnabled: true, legalHosts: ['legal.example'] });

const ADDRESS = Object.freeze({
  email: 'buyer@example.test', firstName: 'Sam', lastName: 'Placeholder', phone: '(415) 555-0100',
  addressLine1: '1 Example Way', city: 'Sample City', region: 'CA', postalCode: '94107', country: 'US',
});

function consentBlock(over = {}) {
  return {
    required: true, available: true, step: 'shipping_address', satisfied: false,
    terms_url: 'https://legal.example/terms', privacy_url: 'https://legal.example/privacy',
    terms_version: 'terms-2026-11', privacy_version: 'privacy-2026-11', offer: { ...OFFER },
    ...over,
  };
}

function base(extra = {}) {
  return {
    purchase_id: 'pp_aaaaaaaaaaaaaaaaaaaaaaaa', rail: 'a2a', rail_purchase_id: PID, state: 'routing',
    totals: { currency: 'USD', our_price_minor: 1800 }, poll_after_seconds: 5,
    detail: { id: PID, merchant_domain: 'merchant.example', product_name: 'Sample Lip Gloss', quantity: 1 },
    ...extra,
  };
}

/** Gate off (today): the form, `fields_missing`, no marker, no consent block. */
function formBody(extra = {}) {
  return base({ next_action: { kind: 'shipping_address', fields_missing: [...ADDRESS_FIELDS], expires_at: DEADLINE }, ...extra });
}

/** Gate on, no consent: the backend's marker (no fields_missing), buyer_step, and the offered block. */
function gatedBody(over = {}) {
  const body = base({
    next_action: { kind: 'shipping_address', consent_required: true, expires_at: DEADLINE },
    consent: consentBlock(),
    ...over,
  });
  body.detail = { ...body.detail, buyer_step: { kind: 'shipping_address', expires_at: DEADLINE, consent_required: true, available: true } };
  return body;
}

/** Gate on, consent given: the form again, with the block satisfied. */
function consentedFormBody() {
  return formBody({ consent: consentBlock({ satisfied: true, offer: undefined }) });
}

// ---- the view --------------------------------------------------------------------------------------------------

test('gate off: the form directly, exactly as before (with the consent flag on or off)', () => {
  const off = projectPurchaseView(formBody(), { ...VIEW_OPTS, consentEnabled: false, legalHosts: [] });
  assert.equal(off.screen, 'shipping_address');
  assert.deepEqual(off.address_request.fields_missing, [...ADDRESS_FIELDS]);
  assert.equal(Object.hasOwn(off, 'consent'), false);
  const on = projectPurchaseView(formBody(), VIEW_OPTS);
  const { consent, ...rest } = on;
  assert.equal(consent, null);
  assert.deepEqual(rest, off);
  assert.equal(shippingConsentPending(formBody(), VIEW_OPTS), false);
  assert.equal(consentToRecord(formBody(), VIEW_OPTS), null);
});

test('gate on, no consent: the terms on the address screen, no form, the step recorded is shipping_address', () => {
  const view = projectPurchaseView(gatedBody(), VIEW_OPTS);
  assert.equal(view.screen, 'shipping_address');
  assert.equal(Object.hasOwn(view, 'address_request'), false, 'no form before the consent');
  assert.deepEqual(view.consent, {
    step: 'shipping_address', terms_url: 'https://legal.example/terms', privacy_url: 'https://legal.example/privacy',
    terms_version: 'terms-2026-11', privacy_version: 'privacy-2026-11', offer: { ...OFFER },
  });
  assert.equal(view.action, null);
  assert.deepEqual(consentToRecord(gatedBody(), VIEW_OPTS), { step: 'shipping_address', terms_version: 'terms-2026-11', privacy_version: 'privacy-2026-11' });
  assert.equal(shippingConsentPending(gatedBody(), VIEW_OPTS), true);
});

test('gate on with no deadline on the marker (the backend sends expires_at: null when the form had none): still the terms first', () => {
  const body = gatedBody({ next_action: { kind: 'shipping_address', consent_required: true, expires_at: null } });
  body.detail.buyer_step = { kind: 'shipping_address', expires_at: null, consent_required: true, available: true };
  const view = projectPurchaseView(body, VIEW_OPTS);
  assert.equal(view.screen, 'shipping_address');
  assert.equal(view.consent.step, 'shipping_address');
  assert.equal(Object.hasOwn(view, 'address_request'), false);
  assert.equal(shippingConsentPending(body, VIEW_OPTS), true);
  // buyer_step.available false with no offer on the block: not available right now.
  const closed = gatedBody({ consent: consentBlock({ available: false, offer: undefined }) });
  closed.detail.buyer_step.available = false;
  assert.equal(projectPurchaseView(closed, VIEW_OPTS).screen, 'unavailable');
});

test('gate on, consent given: the form (the backend\'s fields_missing), no consent member, nothing pending', () => {
  const view = projectPurchaseView(consentedFormBody(), VIEW_OPTS);
  assert.equal(view.screen, 'shipping_address');
  assert.deepEqual(view.address_request.fields_missing, [...ADDRESS_FIELDS]);
  assert.equal(view.consent, null);
  assert.equal(shippingConsentPending(consentedFormBody(), VIEW_OPTS), false);
  assert.equal(consentToRecord(consentedFormBody(), VIEW_OPTS), null);
});

test('gate on, the gateway consent flag off (or an incomplete offer): "not available right now", never the form', () => {
  const flagOff = projectPurchaseView(gatedBody(), { ...VIEW_OPTS, consentEnabled: false, legalHosts: [] });
  assert.equal(flagOff.screen, 'unavailable');
  assert.equal(Object.hasOwn(flagOff, 'address_request'), false);
  assert.equal(Object.hasOwn(flagOff, 'consent'), false);
  for (const block of [consentBlock({ offer: undefined }), consentBlock({ available: false }), consentBlock({ terms_url: 'https://elsewhere.example/terms' }), undefined]) {
    const body = gatedBody({ consent: block });
    const view = projectPurchaseView(body, VIEW_OPTS);
    assert.equal(view.screen, 'unavailable', JSON.stringify(block));
    assert.equal(view.consent, null);
    assert.equal(Object.hasOwn(view, 'address_request'), false);
    assert.equal(shippingConsentPending(body, VIEW_OPTS), true);
  }
});

test('collection off: the "add it in the chat" screen whatever the gate says (no form, no terms)', () => {
  for (const body of [gatedBody(), formBody()]) {
    const view = projectPurchaseView(body, { ...VIEW_OPTS, collectShipping: false });
    assert.equal(view.screen, 'shipping_address_elsewhere');
    assert.equal(Object.hasOwn(view, 'address_request'), false);
    assert.equal(view.consent, null);
  }
});

test('fail closed: a marked step that also lists fields shows no form until the block says satisfied', () => {
  const body = gatedBody({ next_action: { kind: 'shipping_address', consent_required: true, fields_missing: [...ADDRESS_FIELDS], expires_at: DEADLINE } });
  const view = projectPurchaseView(body, VIEW_OPTS);
  assert.equal(Object.hasOwn(view, 'address_request'), false);
  assert.equal(view.consent.step, 'shipping_address');
  // A block naming the step as required is a gate on its own (no marker).
  const blockOnly = formBody({ consent: consentBlock() });
  assert.equal(Object.hasOwn(projectPurchaseView(blockOnly, VIEW_OPTS), 'address_request'), false);
  assert.equal(shippingConsentPending(blockOnly, VIEW_OPTS), true);
  // A marker with no field list is never "every field", satisfied or not.
  const markerSatisfied = gatedBody({ consent: consentBlock({ satisfied: true, offer: undefined }) });
  assert.equal(Object.hasOwn(projectPurchaseView(markerSatisfied, VIEW_OPTS), 'address_request'), false);
});

test('a hold beats the gated address step: the checking screen, no terms, no form', () => {
  const body = gatedBody();
  body.detail.last_error_code = 'checkout_outcome_unknown';
  const view = projectPurchaseView(body, VIEW_OPTS);
  assert.equal(view.screen, 'outcome_unknown');
  assert.equal(view.consent, null);
  assert.equal(Object.hasOwn(view, 'address_request'), false);
  assert.equal(consentToRecord(body, VIEW_OPTS), null);
});

test('the card step after the address keeps its own consent step (card_binding), unchanged', () => {
  const body = base({
    state: 'needs_payment_method',
    next_action: { kind: 'card_binding', expires_at: DEADLINE, consent_required: true },
    consent: consentBlock({ step: 'card_binding' }),
  });
  const view = projectPurchaseView(body, VIEW_OPTS);
  assert.equal(view.screen, 'add_card');
  assert.equal(view.consent.step, 'card_binding');
  assert.equal(shippingConsentPending(body, VIEW_OPTS), false);
});

// ---- the routes ------------------------------------------------------------------------------------------------

function fakeBackend({ views, submit } = {}) {
  const calls = [];
  let i = 0;
  const seq = views || [gatedBody()];
  return {
    calls,
    async read(claims) {
      calls.push({ op: 'read', claims });
      const v = seq[Math.min(i, seq.length - 1)];
      return { kind: 'accepted', purchase: typeof v === 'function' ? v() : v };
    },
    advance() { i += 1; },
    async submitShippingAddress(claims, address) {
      calls.push({ op: 'submit', claims, address });
      if (submit) return submit(claims, address);
      return { kind: 'accepted', purchase: base({ state: 'needs_payment_method', next_action: { kind: 'card_binding', expires_at: DEADLINE } }) };
    },
  };
}
function recordingWriter(answer = { kind: 'recorded' }) {
  const calls = [];
  return { calls, async record(claims, consent) { calls.push({ claims, consent }); return answer; } };
}
function app({ env = ENV_ON, reader = fakeBackend(), writer = recordingWriter(), now = () => NOW } = {}) {
  const a = express();
  const g = createAgenpasHostGuard({ env });
  a.use(g.front);
  a.use(createAgenpasRouter({ reader, consentWriter: writer, env, now, limits: { ip: { capacity: 1000 } } }));
  a.use(g.back);
  a.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return a;
}
const token = () => mintLinkToken({ ...CLAIMS, secret: SECRET, now: NOW });
const getView = (a) => request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token());
const postConsent = (a, step = 'shipping_address') => request(a).post(`/agenpas/api/p/${PID}/consent`)
  .set('Origin', AUD).set('Sec-Fetch-Site', 'same-origin').set('X-Agenpas-Link', token()).set('Content-Type', 'application/json')
  .send(JSON.stringify({ step, offer_id: OFFER.id, issued_at: OFFER.issued_at }));
const postAddress = (a, payload = ADDRESS) => request(a).post(`/agenpas/api/p/${PID}/shipping-address`)
  .set('X-Agenpas-Link', token()).set('Content-Type', 'application/json').send(JSON.stringify(payload));

test('the consent POST accepts step shipping_address, records the read\'s versions, and the next read is the form', async () => {
  const reader = fakeBackend({ views: [gatedBody(), consentedFormBody()] });
  const writer = recordingWriter();
  const a = app({ reader, writer });
  const before = await getView(a);
  assert.equal(before.body.screen, 'shipping_address');
  assert.equal(before.body.consent.step, 'shipping_address');
  const res = await postConsent(a);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { recorded: true });
  assert.deepEqual(writer.calls[0].consent, {
    step: 'shipping_address', offer_id: OFFER.id, issued_at: OFFER.issued_at, terms_version: 'terms-2026-11', privacy_version: 'privacy-2026-11',
  });
  reader.advance();
  const readsBefore = reader.calls.filter((c) => c.op === 'read').length;
  const after = await getView(a);
  // Inside the 2 s cache window, yet a NEW backend read: the recorded consent dropped this instance's cache entry.
  assert.equal(reader.calls.filter((c) => c.op === 'read').length, readsBefore + 1);
  assert.equal(after.body.screen, 'shipping_address');
  assert.equal(after.body.consent, null);
  assert.deepEqual(after.body.address_request.fields_missing, [...ADDRESS_FIELDS]);
});

test('the consent POST for shipping_address is stale when the read does not offer it (form already open, card step, flag off)', async () => {
  for (const view of [formBody(), consentedFormBody(), base({ state: 'needs_payment_method', next_action: { kind: 'card_binding', expires_at: DEADLINE, consent_required: true }, consent: consentBlock({ step: 'card_binding' }) })]) {
    const writer = recordingWriter();
    const res = await postConsent(app({ reader: fakeBackend({ views: [view] }), writer }));
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'consent_stale' });
    assert.equal(writer.calls.length, 0);
  }
  // Consent flag off: the POST is not a route on the host (the guard's 404).
  const off = await postConsent(app({ env: ENV_CONSENT_OFF }));
  assert.equal(off.status, 404);
  assert.equal(off.headers['x-agenpas-guard'], 'front');
});

test('the address POST before the consent: 409 consent_required, and the address never leaves the gateway', async () => {
  for (const env of [ENV_ON, ENV_CONSENT_OFF]) {
    const reader = fakeBackend();
    const res = await postAddress(app({ env, reader }));
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'consent_required' });
    assert.equal(reader.calls.filter((c) => c.op === 'submit').length, 0);
  }
});

test('the backend\'s own 409 consent_required (a race with our read) is the same answer; its other 409 stays "already set"', async () => {
  const raced = fakeBackend({ views: [consentedFormBody()], submit: () => ({ kind: 'consent_required' }) });
  const res = await postAddress(app({ reader: raced }));
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'consent_required' });
  assert.equal(raced.calls.filter((c) => c.op === 'submit').length, 1);
  const conflict = await postAddress(app({ reader: fakeBackend({ views: [consentedFormBody()], submit: () => ({ kind: 'conflict' }) }) }));
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, { error: 'address_already_set' });
});

test('after the consent the address POST goes on as before (200, the next view)', async () => {
  const reader = fakeBackend({ views: [consentedFormBody()] });
  const res = await postAddress(app({ reader }));
  assert.equal(res.status, 200);
  assert.equal(res.body.screen, 'add_card');
  assert.equal(reader.calls.filter((c) => c.op === 'submit').length, 1);
});

test('the address POST forwards ONLY when the gateway\'s read shows the form: held, placing, the rp_ rail, an unsatisfied block are refused, nothing sent', async () => {
  const held = consentedFormBody();
  held.detail = { ...held.detail, last_error_code: 'checkout_unknown_timeout' };
  const placing = consentedFormBody();
  placing.state = 'placing';
  const reapForm = consentedFormBody();
  reapForm.rail = 'reap';
  const placingUnsatisfied = formBody({ state: 'placing', consent: consentBlock() });
  const cases = [
    ['held', held, 'address_not_requested'],
    ['placing', placing, 'address_not_requested'],
    ['reap', reapForm, 'address_not_requested'],
    ['placing + unsatisfied shipping block', placingUnsatisfied, 'address_not_requested'],
    ['routing + unsatisfied shipping block', formBody({ consent: consentBlock() }), 'consent_required'],
    ['moved on (card step)', base({ state: 'needs_payment_method', next_action: { kind: 'card_binding', expires_at: DEADLINE } }), 'address_not_requested'],
  ];
  for (const [name, view, error] of cases) {
    const reader = fakeBackend({ views: [view] });
    const res = await postAddress(app({ reader }));
    assert.equal(res.status, 409, name);
    assert.deepEqual(res.body, { error }, name);
    assert.equal(reader.calls.filter((c) => c.op === 'submit').length, 0, `${name}: no backend call`);
  }
});

test('the address POST reads FRESH: a pre-consent read cached by a GET a moment ago does not send the buyer back', async () => {
  const reader = fakeBackend({ views: [gatedBody(), consentedFormBody()] });
  const a = app({ reader });
  assert.equal((await getView(a)).body.consent.step, 'shipping_address');
  reader.advance(); // the consent was recorded (on another instance, say): the backend now serves the form
  const res = await postAddress(a);
  assert.equal(res.status, 200);
  assert.equal(reader.calls.filter((c) => c.op === 'submit').length, 1);
});

test('the backend\'s other 409s (any unknown reason) answer 409 address_not_taken', async () => {
  const reader = fakeBackend({ views: [consentedFormBody()], submit: () => ({ kind: 'not_taken', code: 'zz_some_new_reason' }) });
  const res = await postAddress(app({ reader }));
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'address_not_taken' });
});

test('the rp_ rail never projects an address form, even if a body carried one (marked or not)', () => {
  for (const body of [formBody(), consentedFormBody(), gatedBody()]) {
    const reap = { ...body, rail: 'reap', rail_purchase_id: 'rp_0123456789abcdef01234567' };
    const view = projectPurchaseView(reap, { ...VIEW_OPTS, purchaseId: 'rp_0123456789abcdef01234567' });
    assert.equal(view.screen, 'shipping_address_elsewhere');
    assert.equal(Object.hasOwn(view, 'address_request'), false);
    assert.equal(view.consent, null);
    assert.equal(shippingConsentPending(reap, VIEW_OPTS), false);
  }
});

// ---- the backend writer: the app's error envelope --------------------------------------------------------------

function stubFetch({ status, body }) {
  return async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
}
// The backend's ErrorHandlerMiddleware wraps a route's `{"error": code}` 409 in this envelope (pivota-backend
// middleware/error_handler.py): the code is in `detail.error`.
function envelope409(code) {
  return {
    status: 'error',
    error: { code: 'CONFLICT', message: code, details: { error: code }, request_id: 'req_fixture' },
    detail: { error: code },
  };
}

test('writer: a 409 whose detail.error is consent_required is consent_required; shipping_address_conflict is conflict; any other 409 is not_taken', async () => {
  const mk = (answer) => createBackendPurchaseReader({ baseUrl: 'https://backend.internal.example', internalKey: () => 'k', fetchImpl: stubFetch(answer) });
  assert.deepEqual(await mk({ status: 409, body: envelope409('consent_required') }).submitShippingAddress(CLAIMS, ADDRESS), { kind: 'consent_required' });
  assert.deepEqual(await mk({ status: 409, body: { error: 'consent_required' } }).submitShippingAddress(CLAIMS, ADDRESS), { kind: 'consent_required' });
  assert.deepEqual(await mk({ status: 409, body: envelope409('shipping_address_conflict') }).submitShippingAddress(CLAIMS, ADDRESS), { kind: 'conflict' });
  assert.deepEqual(await mk({ status: 409, body: {} }).submitShippingAddress(CLAIMS, ADDRESS), { kind: 'not_taken', code: 'unnamed' });
  // The backend's "capture is off now" 409 (pivota-backend 838643e34, checked before consent and before the body).
  assert.deepEqual(await mk({ status: 409, body: envelope409('shipping_address_not_collected') }).submitShippingAddress(CLAIMS, ADDRESS), { kind: 'not_taken', code: 'shipping_address_not_collected' });
  // An arbitrary unknown reason: the same answer, whatever a future 409 is called.
  assert.deepEqual(await mk({ status: 409, body: envelope409('zz_some_new_reason') }).submitShippingAddress(CLAIMS, ADDRESS), { kind: 'not_taken', code: 'zz_some_new_reason' });
});

// ---- the address_consent dev fixture ---------------------------------------------------------------------------

test('fixture address_consent: the terms, then the form, then the card step; an address before the terms is a 409', async () => {
  const local = { ...ENV_ON, AGENPAS_DEV_FIXTURES: '1', AGENPAS_PUBLIC_BASE_URL: 'http://localhost:4000', AGENPAS_LEGAL_HOSTS: undefined };
  const a = express();
  const g = createAgenpasHostGuard({ env: local });
  a.use(g.front);
  a.use(createAgenpasRouter({ reader: fakeBackend(), env: local, now: () => Date.now(), limits: { ip: { capacity: 1000 } } }));
  a.use(g.back);
  const host = 'localhost:4000';
  const start = await request(a, host).get('/agenpas/dev/start?scenario=address_consent');
  const loc = new URL(start.headers.location, 'http://localhost');
  const id = SCENARIOS.address_consent.id;
  assert.equal(loc.pathname, `/agenpas/p/${id}`);
  const t = new URLSearchParams(loc.hash.slice(1)).get('t');
  const get = () => request(a, host).get(`/agenpas/api/p/${id}`).set('X-Agenpas-Link', t);
  const send = () => request(a, host).post(`/agenpas/api/p/${id}/shipping-address`).set('X-Agenpas-Link', t)
    .set('Content-Type', 'application/json').send(JSON.stringify(ADDRESS));
  const first = await get();
  assert.equal(first.body.screen, 'shipping_address');
  assert.equal(first.body.consent.step, 'shipping_address');
  assert.equal(Object.hasOwn(first.body, 'address_request'), false);
  const early = await send();
  assert.equal(early.status, 409);
  assert.deepEqual(early.body, { error: 'consent_required' });
  const agreed = await request(a, host).post(`/agenpas/api/p/${id}/consent`).set('Origin', 'http://localhost:4000').set('Sec-Fetch-Site', 'same-origin')
    .set('X-Agenpas-Link', t).set('Content-Type', 'application/json')
    .send(JSON.stringify({ step: 'shipping_address', offer_id: first.body.consent.offer.id, issued_at: first.body.consent.offer.issued_at }));
  assert.equal(agreed.status, 200);
  const form = await get();
  assert.equal(form.body.screen, 'shipping_address');
  assert.equal(form.body.consent, null);
  assert.equal(form.body.address_request.prefill.country, 'US');
  const saved = await send();
  assert.equal(saved.status, 200);
  assert.equal(saved.body.screen, 'add_card');
});
