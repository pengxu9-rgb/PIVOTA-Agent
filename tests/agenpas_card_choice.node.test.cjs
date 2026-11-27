'use strict';

// AgenPas card choice (AGENPAS_CARD_PICKER_ENABLED; docs/agenpas.md, "Card choice"): the view's choice screen
// (src/agenpas/view.js), the POST route (src/agenpas/router.js) on a bare Express app, the host guard, the backend
// writer (src/agenpas/purchaseReader.js) against a stubbed fetch, and the card_choice dev fixture. Placeholder data
// only. Loopback only.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const supertest = require('supertest');

const { projectPurchaseView } = require('../src/agenpas/view');
const { createAgenpasRouter, createAgenpasHostGuard } = require('../src/agenpas/router');
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

const SECRET = 'card-choice-test-secret-0123456789abcdef-01';
const AUD = `https://${PUBLIC_HOST}`;
const PID = 'ap_0123456789abcdef01234567';
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const CLAIMS = Object.freeze({ purchaseId: PID, agentId: 'agent_fixture_1', userRef: 'usr_fixtureFixtureFixture', aud: AUD });
const ENV_ON = Object.freeze({
  AGENPAS_ENABLED: '1', AGENPAS_LINK_SECRET: SECRET, AGENPAS_PUBLIC_BASE_URL: AUD, AGENPAS_CARD_PICKER_ENABLED: '1',
  AGENPAS_CONSENT_ENABLED: '1',
});
// The backend's consent block for the approval step (its gate is always on with the card choice).
const LEGAL = { terms_url: 'https://pivota.cc/terms', privacy_url: 'https://pivota.cc/privacy', terms_version: 't-1', privacy_version: 'p-1' };
const ACCEPTED = Object.freeze({ required: true, available: true, satisfied: true, step: 'approval', ...LEGAL });
const OFFERED = Object.freeze({
  required: true, available: true, satisfied: false, step: 'approval', ...LEGAL,
  offer: { id: 'fixtureoffer0000000000000001', issued_at: '2026-11-26T12:00:00Z' },
});
const ENV_OFF = Object.freeze({ ...ENV_ON, AGENPAS_CARD_PICKER_ENABLED: undefined });
const H1 = 'a'.repeat(24);
const H2 = 'b'.repeat(24);

function choice(over = {}) {
  return {
    confirmed: false,
    expires_at: '2026-11-26T12:30:00Z',
    cards: [
      { handle: H1, network: 'visa', last4: '4242', added_at: '2026-11-20T00:00:00Z', selected: true },
      { handle: H2, network: 'VISA', last4: '1881', added_at: '2026-10-02T00:00:00Z', selected: false },
    ],
    ...over,
  };
}

function body(state = 'locking', extra = {}) {
  return {
    purchase_id: 'pp_aaaaaaaaaaaaaaaaaaaaaaaa', rail: 'a2a', rail_purchase_id: PID, state,
    totals: { currency: 'USD', our_price_minor: 1800, quoted_total_minor: 2349 }, poll_after_seconds: 5,
    detail: { id: PID, merchant_domain: 'merchant.example', product_name: 'Sample Lip Gloss', quantity: 1 },
    card_choice: choice(),
    consent: ACCEPTED,
    ...extra,
  };
}

const view = (b, over = {}) => projectPurchaseView(b, {
  purchaseId: PID, now: NOW, cardPicker: true, consentEnabled: true, legalHosts: ['pivota.cc'], ...over,
});

function fakeBackend({ read = body(), submit } = {}) {
  const calls = [];
  return {
    calls,
    async read(claims) { calls.push({ op: 'read', claims }); return { kind: 'accepted', purchase: typeof read === 'function' ? read() : read }; },
    async submitCardChoice(claims, handle) {
      calls.push({ op: 'submit', claims, handle });
      if (submit) return submit(claims, handle);
      return { kind: 'accepted', purchase: body('locking', { card_choice: choice({ confirmed: true, expires_at: null }) }) };
    },
  };
}

function app({ env = ENV_ON, reader = fakeBackend(), logger, limits } = {}) {
  const a = express();
  a.use(createAgenpasRouter({ reader, env, now: () => NOW, logger, limits: { ip: { capacity: 1000 }, ...(limits || {}) } }));
  a.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return a;
}

const token = () => mintLinkToken({ ...CLAIMS, secret: SECRET, now: NOW });
const post = (a, payload = { handle: H2 }, t = token(), origin = AUD) => {
  const r = request(a).post(`/agenpas/api/p/${PID}/card-choice`).set('X-Agenpas-Link', t).set('Content-Type', 'application/json');
  if (origin) r.set('Origin', origin);
  return r.send(JSON.stringify(payload));
};

// ---- the view --------------------------------------------------------------------------------------------------

test('view: a locked purchase with the backend\'s choice is the choice screen, cards checked and labelled', () => {
  const v = view(body());
  assert.equal(v.screen, 'choose_card');
  assert.deepEqual(v.card_choice, {
    confirmed: false,
    cards: [
      { handle: H1, label: 'Visa', last4: '4242', added_on: '2026-11-20', selected: true },
      { handle: H2, label: 'Visa', last4: '1881', added_on: '2026-10-02', selected: false },
    ],
  });
  assert.equal(v.consent, null);  // accepted: nothing to offer
});

test('view: the approval terms first; when they cannot be offered here the step is "not available", never Approve', () => {
  const pending = view(body('locking', { consent: OFFERED }));
  assert.equal(pending.screen, 'choose_card');
  assert.equal(pending.card_choice.consent_pending, true);
  assert.equal(pending.consent.step, 'approval');
  for (const consent of [undefined, { ...OFFERED, available: false }, { ...OFFERED, offer: undefined }]) {
    const v = view(body('locking', { consent }));
    assert.equal(v.screen, 'unavailable', JSON.stringify(consent));
    assert.equal(v.card_choice, undefined);
  }
  // The flag for the terms off: nothing can be accepted here, so nothing can be approved either.
  assert.equal(view(body('locking', { consent: OFFERED }), { consentEnabled: false }).screen, 'unavailable');
  // Accepted: Approve, no terms.
  const ok = view(body());
  assert.equal(ok.card_choice.consent_pending, undefined);
});

test('view: a card without four digits refuses the whole choice; a date that is no date drops to null', () => {
  assert.equal(view(body('locking', { card_choice: choice({ cards: [{ ...choice().cards[0], last4: null }, choice().cards[1]] }) })).screen, 'unavailable');
  for (const date of ['2026-13-05', '2026-02-31', '2026-04-31', '2026-00-10']) {
    const odd = view(body('locking', { card_choice: choice({ cards: [{ ...choice().cards[0], added_at: date }, choice().cards[1]] }) }));
    assert.equal(odd.card_choice.cards[0].added_on, null, date);
  }
  assert.equal(view(body('locking', { card_choice: choice({ cards: [{ ...choice().cards[0], added_at: '2028-02-29T00:00:00Z' }, choice().cards[1]] }) }))
    .card_choice.cards[0].added_on, '2028-02-29');
});

test('view: the flag off, another rail, a held purchase or another state shows no choice at all', () => {
  const off = projectPurchaseView(body(), { purchaseId: PID, now: NOW });
  assert.equal(off.screen, 'confirming_total');
  assert.equal(off.card_choice, undefined);
  const { card_choice: _ignored, ...plain } = body();
  assert.deepEqual(off, projectPurchaseView(plain, { purchaseId: PID, now: NOW }));
  assert.equal(view(body('locking', { rail: 'reap', rail_purchase_id: 'rp_0123456789abcdef01234567' }), { purchaseId: 'rp_0123456789abcdef01234567' }).card_choice, undefined);
  // A purchase whose rail cannot be told: no choice (only the A2A rail offers one).
  const { rail: _r, ...railless } = body();
  const door = 'pp_aaaaaaaaaaaaaaaaaaaaaaaa';
  const unknown = { ...railless, rail_purchase_id: undefined, detail: { ...railless.detail, id: undefined } };
  assert.equal(view(unknown, { purchaseId: door }).card_choice, undefined);
  const held = body('locking', { detail: { ...body().detail, last_error_code: 'vic_order_outcome_unknown' } });
  assert.notEqual(view(held).screen, 'choose_card');
  assert.equal(view(body('routing')).card_choice, undefined);
  assert.equal(view(body('awaiting_buyer_authorization')).card_choice, undefined);
});

test('view: one bad card, two selected, none selected, too many or a passed deadline: "not available", never a repair', () => {
  const bad = [
    choice({ cards: [{ ...choice().cards[0], handle: 'pm_rail_card_id' }, choice().cards[1]] }),
    choice({ cards: choice().cards.map((c) => ({ ...c, selected: true })) }),
    choice({ cards: choice().cards.map((c) => ({ ...c, selected: false })) }),
    choice({ cards: [choice().cards[0], choice().cards[0]] }),
    choice({ cards: Array.from({ length: 11 }, (_, i) => ({ ...choice().cards[1], handle: String(i).padStart(24, 'c'), selected: i === 0 })) }),
    choice({ cards: [] }),
    choice({ expires_at: '2026-11-26T11:59:59Z' }),
    choice({ expires_at: undefined }),
    { cards: 'nope' },
    'nope',
  ];
  for (const c of bad) {
    const v = view(body('locking', { card_choice: c }));
    assert.equal(v.screen, 'unavailable', JSON.stringify(c));
    assert.equal(v.card_choice, undefined);
  }
});

test('view: an odd network is "Card", an odd date drops to null, and a confirmed choice needs no deadline', () => {
  const v = view(body('locking', { card_choice: choice({
    confirmed: true, expires_at: null,
    cards: [{ handle: H1, network: '<b>bad</b>', last4: '1234', added_at: 'soon', selected: true }],
  }) }));
  assert.equal(v.screen, 'choose_card');
  assert.deepEqual(v.card_choice, { confirmed: true, cards: [{ handle: H1, label: 'Card', last4: '1234', added_on: null, selected: true }] });
});

test('view: only the top-level card_choice counts, never one under detail', () => {
  const { card_choice: c, ...rest } = body();
  const v = view({ ...rest, detail: { ...rest.detail, card_choice: c } });
  assert.equal(v.screen, 'confirming_total');
});

// ---- the route -------------------------------------------------------------------------------------------------

test('POST: a card the gateway\'s own fresh read offers goes on for the token\'s owner; the next view comes back', async () => {
  const reader = fakeBackend();
  const res = await post(app({ reader }));
  assert.equal(res.status, 200);
  assert.equal(res.body.screen, 'choose_card');
  assert.equal(res.body.card_choice.confirmed, true);
  const submit = reader.calls.find((c) => c.op === 'submit');
  assert.equal(submit.handle, H2);
  assert.equal(submit.claims.agentId, CLAIMS.agentId);
  assert.equal(submit.claims.purchaseId, PID);
  assert.ok(reader.calls.findIndex((c) => c.op === 'read') < reader.calls.findIndex((c) => c.op === 'submit'));
});

test('POST: a handle the read does not offer, or another card once confirmed, is refused in the gateway (nothing sent)', async () => {
  for (const [read, handle] of [
    [body(), 'c'.repeat(24)],
    [body('locking', { card_choice: choice({ confirmed: true, expires_at: null }) }), H2],
    [body('awaiting_buyer_authorization'), H1],
    [body('locking', { card_choice: undefined }), H1],
  ]) {
    const reader = fakeBackend({ read });
    const res = await post(app({ reader }), { handle });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'card_choice_not_offered');
    assert.equal(reader.calls.filter((c) => c.op === 'submit').length, 0);
  }
});

test('POST: the exact public Origin, and Sec-Fetch-Site same-origin when sent (403, nothing sent)', async () => {
  for (const [origin, site] of [[null, undefined], ['https://elsewhere.example', undefined], [AUD, 'cross-site']]) {
    const reader = fakeBackend();
    let r = request(app({ reader })).post(`/agenpas/api/p/${PID}/card-choice`).set('X-Agenpas-Link', token())
      .set('Content-Type', 'application/json');
    if (origin) r = r.set('Origin', origin);
    if (site) r = r.set('Sec-Fetch-Site', site);
    const res = await r.send(JSON.stringify({ handle: H2 }));
    assert.equal(res.status, 403);
    assert.equal(reader.calls.length, 0);
  }
});

test('POST: before the approval terms nothing is sent on (409 consent_required); the backend\'s own 409 maps the same', async () => {
  const reader = fakeBackend({ read: body('locking', { consent: OFFERED }) });
  const res = await post(app({ reader }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'consent_required');
  assert.equal(reader.calls.filter((c) => c.op === 'submit').length, 0);
  const backendSays = await post(app({ reader: fakeBackend({ submit: () => ({ kind: 'consent_required' }) }) }));
  assert.equal(backendSays.status, 409);
  assert.equal(backendSays.body.error, 'consent_required');
});

test('POST: the confirmed card again is passed on (the backend answers the same)', async () => {
  const reader = fakeBackend({ read: body('locking', { card_choice: choice({ confirmed: true, expires_at: null }) }) });
  const res = await post(app({ reader }), { handle: H1 });
  assert.equal(res.status, 200);
});

test('POST: exactly {handle} of the right shape (400), JSON only (415), the link in the header only', async () => {
  for (const payload of [{}, { handle: 'pm_visa' }, { handle: H1, extra: 1 }, { handle: 7 }, [H1]]) {
    const reader = fakeBackend();
    const res = await post(app({ reader }), payload);
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.equal(res.body.error, 'invalid_card_choice');
    assert.equal(reader.calls.length, 0);
  }
  const reader = fakeBackend();
  const plain = await request(app({ reader })).post(`/agenpas/api/p/${PID}/card-choice`).set('X-Agenpas-Link', token())
    .set('Origin', AUD).set('Content-Type', 'text/plain').send(JSON.stringify({ handle: H1 }));
  assert.equal(plain.status, 415);
  const noLink = await request(app({ reader })).post(`/agenpas/api/p/${PID}/card-choice`)
    .set('Origin', AUD).set('Content-Type', 'application/json').send(JSON.stringify({ handle: H1 }));
  assert.equal(noLink.status, 404);
  assert.equal(reader.calls.length, 0);
});

test('POST: the backend\'s stale / closed / not found / outage answers', async () => {
  const cases = [
    [{ kind: 'stale' }, 409, 'card_choice_stale'],
    [{ kind: 'closed', code: 'card_choice_closed' }, 409, 'card_choice_closed'],
    [{ kind: 'not_found' }, 404, 'not_found'],
    [{ kind: 'unavailable', code: 'timeout' }, 503, 'unavailable'],
  ];
  for (const [answer, status, error] of cases) {
    const res = await post(app({ reader: fakeBackend({ submit: () => answer }) }));
    assert.equal(res.status, status);
    assert.equal(res.body.error, error);
  }
});

test('POST: 10 a minute per link (429 with Retry-After), per link: another link is unaffected', async () => {
  const a = app({ reader: fakeBackend() });
  const t = token();
  for (let i = 0; i < 10; i += 1) assert.equal((await post(a, { handle: H2 }, t)).status, 200);
  const eleventh = await post(a, { handle: H2 }, t);
  assert.equal(eleventh.status, 429);
  assert.ok(Number(eleventh.headers['retry-after']) > 0);
  const other = mintLinkToken({ ...CLAIMS, userRef: 'usr_otherOtherOtherOther', secret: SECRET, now: NOW });
  assert.equal((await post(a, { handle: H2 }, other)).status, 200);
});

test('POST: a lookalike host, another port, another scheme or another case of the Origin is refused (403)', async () => {
  for (const origin of ['https://agenpas.example.evil.example', 'https://evil-agenpas.example', 'https://agenpas.example:8443',
    'http://agenpas.example', 'https://AGENPAS.example', 'https://agenpas.examplex', 'null']) {
    const reader = fakeBackend();
    const res = await post(app({ reader }), { handle: H2 }, token(), origin);
    assert.equal(res.status, 403, origin);
    assert.equal(reader.calls.length, 0);
  }
});

test('POST: decided on a FRESH read, never the 2 s cache (a cached read that offered the card does not count)', async () => {
  let reads = 0;
  const reader = fakeBackend({ read: () => { reads += 1; return reads === 1 ? body() : body('locking', { card_choice: choice({ cards: [choice().cards[0]] }) }); } });
  const a = app({ reader });
  const t = token();
  const primed = await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', t);
  assert.equal(primed.body.card_choice.cards.length, 2);  // the cached read offers H2
  const res = await post(a, { handle: H2 }, t);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'card_choice_not_offered');
  assert.equal(reader.calls.filter((c) => c.op === 'submit').length, 0);
});

test('POST: a link for another purchase on this path is refused before any read', async () => {
  const reader = fakeBackend();
  const elsewhere = mintLinkToken({ ...CLAIMS, purchaseId: 'ap_fedcba9876543210fedcba98', secret: SECRET, now: NOW });
  const res = await post(app({ reader }), { handle: H2 }, elsewhere);
  assert.equal(res.status, 404);
  assert.equal(reader.calls.length, 0);
});

test('config: the card choice counts only with the consent flag on too', async () => {
  const reader = fakeBackend();
  const res = await post(app({ env: { ...ENV_ON, AGENPAS_CONSENT_ENABLED: undefined }, reader }));
  assert.equal(res.status, 404);
  assert.equal(reader.calls.length, 0);
});

test('POST with AGENPAS_CARD_PICKER_ENABLED off (or AgenPas off): the route does not exist', async () => {
  for (const env of [ENV_OFF, { ...ENV_ON, AGENPAS_ENABLED: undefined }]) {
    const reader = fakeBackend();
    const res = await post(app({ env, reader }));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'NOT_FOUND');
    assert.equal(reader.calls.length, 0);
  }
});

test('host guard: the card-choice POST is admitted only with the flag on, and its body is read capped', async () => {
  for (const [env, admitted] of [[ENV_ON, true], [ENV_OFF, false]]) {
    const guard = createAgenpasHostGuard({ env });
    const a = express();
    a.use(guard.front);
    a.use(createAgenpasRouter({ reader: fakeBackend(), env, now: () => NOW, limits: { ip: { capacity: 1000 } } }));
    a.use(guard.back);
    const res = await post(a);
    if (admitted) assert.equal(res.status, 200);
    else assert.equal(res.headers['x-agenpas-guard'], 'front');
  }
  const guard = createAgenpasHostGuard({ env: ENV_ON });
  const a = express();
  a.use(guard.front);
  a.use(createAgenpasRouter({ reader: fakeBackend(), env: ENV_ON, now: () => NOW, limits: { ip: { capacity: 1000 } } }));
  const big = await post(a, { handle: H2, pad: 'x'.repeat(5000) });
  assert.equal(big.status, 413);
});

test('logs never carry the handle or the link token', async () => {
  const lines = [];
  const sink = (o, msg) => lines.push(JSON.stringify({ ...o, msg }));
  const logger = { info: sink, warn: sink, error: sink };
  const t = token();
  await post(app({ logger }), { handle: H2 }, t);
  await post(app({ logger, reader: fakeBackend({ submit: () => ({ kind: 'stale' }) }) }), { handle: H2 }, t);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(!line.includes(H2) && !line.includes(t), line);
  }
});

// ---- the writer ------------------------------------------------------------------------------------------------

function stubFetch(answer) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
      return { status: answer.status, text: async () => text };
    },
  };
}

test('writer: one POST to the internal route with the internal key, the owner and {handle}', async () => {
  const stub = stubFetch({ status: 200, body: body() });
  const writer = createBackendPurchaseReader({ baseUrl: 'https://backend.internal.example', internalKey: () => 'k', fetchImpl: stub.fetchImpl });
  const out = await writer.submitCardChoice(CLAIMS, H2);
  assert.equal(out.kind, 'accepted');
  const [{ url, init }] = stub.calls;
  assert.equal(url, `https://backend.internal.example${INTERNAL_PURCHASES_PATH}/${PID}/card-choice`);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['X-Internal-Key'], 'k');
  assert.equal(init.headers['X-Agenpas-Agent-Id'], CLAIMS.agentId);
  assert.deepEqual(JSON.parse(init.body), { handle: H2 });
});

test('writer: the backend\'s re-wrapped 409s, 404 and 5xx outcomes', async () => {
  const mk = (answer) => createBackendPurchaseReader({ baseUrl: 'https://b.example', internalKey: () => 'k', fetchImpl: stubFetch(answer).fetchImpl });
  assert.deepEqual(await mk({ status: 409, body: { detail: { error: 'card_choice_stale' } } }).submitCardChoice(CLAIMS, H1), { kind: 'stale' });
  assert.deepEqual(await mk({ status: 409, body: { detail: { error: 'consent_required' } } }).submitCardChoice(CLAIMS, H1), { kind: 'consent_required' });
  assert.deepEqual(await mk({ status: 409, body: { detail: { error: 'card_choice_closed' } } }).submitCardChoice(CLAIMS, H1),
    { kind: 'closed', code: 'card_choice_closed' });
  assert.deepEqual(await mk({ status: 409, body: { detail: { error: 'card_choice_unavailable' } } }).submitCardChoice(CLAIMS, H1),
    { kind: 'closed', code: 'card_choice_unavailable' });
  assert.deepEqual(await mk({ status: 409, body: {} }).submitCardChoice(CLAIMS, H1), { kind: 'closed', code: 'unnamed' });
  assert.deepEqual(await mk({ status: 404, body: {} }).submitCardChoice(CLAIMS, H1), { kind: 'not_found' });
  assert.equal((await mk({ status: 503, body: 'x' }).submitCardChoice(CLAIMS, H1)).kind, 'unavailable');
  assert.equal((await mk({ status: 200, body: { state: 'locking', purchase_id: 'pp_other' } }).submitCardChoice(CLAIMS, H1)).code, 'malformed');
  assert.equal((await createBackendPurchaseReader({ baseUrl: 'https://b.example', internalKey: () => '' }).submitCardChoice(CLAIMS, H1)).code, 'unconfigured');
});

// ---- the card_choice dev fixture -------------------------------------------------------------------------------

test('fixture card_choice: the choice, the other card confirmed, then the approval page and the order on that card', async () => {
  const local = { ...ENV_ON, AGENPAS_DEV_FIXTURES: '1', AGENPAS_PUBLIC_BASE_URL: 'http://localhost:4000', AGENPAS_HOSTED_HOSTS: 'hosted.example' };
  let clock = NOW;
  const a = express();
  a.use(createAgenpasRouter({ reader: fakeBackend(), env: local, now: () => clock, limits: { ip: { capacity: 1000 } } }));
  const start = await request(a, 'localhost:4000').get('/agenpas/dev/start?scenario=card_choice');
  const loc = new URL(start.headers.location, 'http://localhost');
  const id = SCENARIOS.card_choice.id;
  assert.equal(loc.pathname, `/agenpas/p/${id}`);
  const t = new URLSearchParams(loc.hash.slice(1)).get('t');
  const get = () => request(a, 'localhost:4000').get(`/agenpas/api/p/${id}`).set('X-Agenpas-Link', t);
  const send = (handle) => request(a, 'localhost:4000').post(`/agenpas/api/p/${id}/card-choice`).set('X-Agenpas-Link', t)
    .set('Origin', 'http://localhost:4000').set('Content-Type', 'application/json').send(JSON.stringify({ handle }));
  const first = await get();
  assert.equal(first.body.screen, 'choose_card');
  assert.equal(first.body.card_choice.consent_pending, true);
  assert.equal((await send(first.body.card_choice.cards[1].handle)).status, 409);  // the terms first
  const agreed = await request(a, 'localhost:4000').post(`/agenpas/api/p/${id}/consent`).set('X-Agenpas-Link', t)
    .set('Origin', 'http://localhost:4000').set('Content-Type', 'application/json')
    .send(JSON.stringify({ step: 'approval', offer_id: first.body.consent.offer.id, issued_at: first.body.consent.offer.issued_at }));
  assert.equal(agreed.status, 200, JSON.stringify(agreed.body));
  const ready = await get();
  assert.equal(ready.body.card_choice.consent_pending, undefined);
  const [newest, older] = ready.body.card_choice.cards;
  assert.deepEqual([newest.last4, newest.selected, older.last4, older.selected], ['4242', true, '1881', false]);
  const chosen = await send(older.handle);
  assert.equal(chosen.status, 200);
  assert.equal(chosen.body.card_choice.confirmed, true);
  assert.equal((await send(newest.handle)).status, 409);
  clock += 4000;
  const approving = await get();
  assert.equal(approving.body.screen, 'approve');
  assert.deepEqual(approving.body.payment_card, { label: 'Visa', last4: '1881' });
});

// ---- "Add a new card" (the backend's {new_card: true}) ----------------------------------------------------------

test('view: the backend\'s new_card is carried while the choice is open, dropped once confirmed', () => {
  assert.equal(view(body('locking', { card_choice: choice({ new_card: true }) })).card_choice.new_card, true);
  assert.equal(view(body()).card_choice.new_card, undefined);
  const confirmed = view(body('locking', { card_choice: choice({ confirmed: true, expires_at: null, new_card: true }) }));
  assert.equal(confirmed.card_choice.new_card, undefined);
  assert.equal(view(body('locking', { card_choice: choice({ new_card: 'true' }) })).card_choice.new_card, undefined);
});

test('POST {new_card: true}: forwarded while the choice is open; the next view comes back', async () => {
  const reader = fakeBackend({ submit: () => ({ kind: 'accepted', purchase: body('needs_payment_method', { card_choice: undefined }) }) });
  const res = await post(app({ reader }), { new_card: true });
  assert.equal(res.status, 200);
  const submit = reader.calls.find((c) => c.op === 'submit');
  assert.deepEqual(submit.handle, { newCard: true });
});

test('POST {new_card: true}: refused in the gateway once confirmed, before the terms, or off the choice screen', async () => {
  for (const [read, status, error] of [
    [body('locking', { card_choice: choice({ confirmed: true, expires_at: null }) }), 409, 'card_choice_not_offered'],
    [body('locking', { consent: OFFERED }), 409, 'consent_required'],
    [body('awaiting_buyer_authorization'), 409, 'card_choice_not_offered'],
  ]) {
    const reader = fakeBackend({ read });
    const res = await post(app({ reader }), { new_card: true });
    assert.equal(res.status, status);
    assert.equal(res.body.error, error);
    assert.equal(reader.calls.filter((c) => c.op === 'submit').length, 0);
  }
});

test('POST: a saved card after a new card was asked for is refused in the gateway (nothing sent)', async () => {
  const reader = fakeBackend({ read: body('locking', { card_choice: choice({ new_card: true }) }) });
  const res = await post(app({ reader }), { handle: H2 });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'card_choice_not_offered');
  assert.equal(reader.calls.filter((c) => c.op === 'submit').length, 0);
});

test('POST: only exactly {new_card: true} (400 for false, a string, or with a handle)', async () => {
  for (const payload of [{ new_card: false }, { new_card: 'true' }, { new_card: 1 }, {}, { new_card: true, handle: H1 }, { newCard: true }]) {
    const reader = fakeBackend();
    const res = await post(app({ reader }), payload);
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.equal(reader.calls.length, 0);
  }
});

test('writer: {newCard: true} is sent as exactly {new_card: true}', async () => {
  const stub = stubFetch({ status: 200, body: body() });
  const writer = createBackendPurchaseReader({ baseUrl: 'https://backend.internal.example', internalKey: () => 'k', fetchImpl: stub.fetchImpl });
  assert.equal((await writer.submitCardChoice(CLAIMS, { newCard: true })).kind, 'accepted');
  assert.deepEqual(JSON.parse(stub.calls[0].init.body), { new_card: true });
});

test('fixture card_choice: "Add a new card" goes through the card page (its terms first) to the approval on the new card', async () => {
  const local = { ...ENV_ON, AGENPAS_DEV_FIXTURES: '1', AGENPAS_PUBLIC_BASE_URL: 'http://localhost:4000', AGENPAS_HOSTED_HOSTS: 'hosted.example' };
  let clock = NOW + 60_000;  // a link of its own (the fixture keeps what each link chose)
  const a = express();
  a.use(createAgenpasRouter({ reader: fakeBackend(), env: local, now: () => clock, limits: { ip: { capacity: 1000 } } }));
  const start = await request(a, 'localhost:4000').get('/agenpas/dev/start?scenario=card_choice');
  const loc = new URL(start.headers.location, 'http://localhost');
  const id = SCENARIOS.card_choice.id;
  const t = new URLSearchParams(loc.hash.slice(1)).get('t');
  const get = () => request(a, 'localhost:4000').get(`/agenpas/api/p/${id}`).set('X-Agenpas-Link', t);
  const postJson = (path, payload) => request(a, 'localhost:4000').post(path).set('X-Agenpas-Link', t)
    .set('Origin', 'http://localhost:4000').set('Content-Type', 'application/json').send(JSON.stringify(payload));
  const agree = async (consent) => postJson(`/agenpas/api/p/${id}/consent`, { step: consent.step, offer_id: consent.offer.id, issued_at: consent.offer.issued_at });
  const first = await get();
  assert.equal((await agree(first.body.consent)).status, 200);
  const asked = await postJson(`/agenpas/api/p/${id}/card-choice`, { new_card: true });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.screen, 'add_card');
  assert.equal(asked.body.consent.step, 'card_binding');
  assert.equal((await agree(asked.body.consent)).status, 200);
  clock += 12000;
  const approving = await get();
  assert.equal(approving.body.screen, 'approve');
  assert.deepEqual(approving.body.payment_card, { label: 'Visa', last4: '7777' });
});

// Staging run-through 11-27: after "Add a new card" the page flashed "This step isn't available right now" before the
// card page. The write's answer (the backend's POST .../card-choice) carries no consent block, and the view asked a
// new-card choice for the approval terms again. The backend records a new-card request only after those terms, so a
// choice that says new_card needs no terms check here: the page waits for the card page instead.
test('view: the new-card write\'s answer (no consent block) is the waiting choice, never "not available right now"', () => {
  const answer = body('locking', { card_choice: choice({ new_card: true }), consent: undefined });
  const v = view(answer);
  assert.equal(v.screen, 'choose_card');
  assert.equal(v.card_choice.new_card, true);
  assert.equal(v.card_choice.consent_pending, undefined, 'no terms offered again');
  // A saved-card choice without the terms on record still offers them first, or is "not available" (unchanged).
  assert.equal(view(body('locking', { consent: undefined })).screen, 'unavailable');
  assert.equal(view(body('locking', { consent: OFFERED })).card_choice.consent_pending, true);
});
