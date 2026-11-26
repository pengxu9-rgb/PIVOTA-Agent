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
    ...extra,
  };
}

const view = (b, over = {}) => projectPurchaseView(b, { purchaseId: PID, now: NOW, cardPicker: true, ...over });

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
const post = (a, payload = { handle: H2 }, t = token()) => request(a).post(`/agenpas/api/p/${PID}/card-choice`)
  .set('X-Agenpas-Link', t).set('Content-Type', 'application/json').send(JSON.stringify(payload));

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
  assert.equal(v.consent, undefined);
});

test('view: the flag off, another rail, a held purchase or another state shows no choice at all', () => {
  const off = projectPurchaseView(body(), { purchaseId: PID, now: NOW });
  assert.equal(off.screen, 'confirming_total');
  assert.equal(off.card_choice, undefined);
  const { card_choice: _ignored, ...plain } = body();
  assert.deepEqual(off, projectPurchaseView(plain, { purchaseId: PID, now: NOW }));
  assert.equal(view(body('locking', { rail: 'reap', rail_purchase_id: 'rp_0123456789abcdef01234567' }), { purchaseId: 'rp_0123456789abcdef01234567' }).card_choice, undefined);
  const held = body('locking', { detail: { ...body().detail, last_error_code: 'vic_order_outcome_unknown' } });
  assert.notEqual(view(held).screen, 'choose_card');
  assert.equal(view(body('routing')).card_choice, undefined);
  assert.equal(view(body('awaiting_buyer_authorization')).card_choice, undefined);
});

test('view: one bad card, two selected, none selected, too many or a passed deadline: no choice, never a repair', () => {
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
    assert.equal(v.screen, 'confirming_total', JSON.stringify(c));
    assert.equal(v.card_choice, undefined);
  }
});

test('view: an odd network is "Card", odd last four and dates drop to null, and a confirmed choice needs no deadline', () => {
  const v = view(body('locking', { card_choice: choice({
    confirmed: true, expires_at: null,
    cards: [{ handle: H1, network: '<b>bad</b>', last4: '12345', added_at: 'soon', selected: true }],
  }) }));
  assert.equal(v.screen, 'choose_card');
  assert.deepEqual(v.card_choice, { confirmed: true, cards: [{ handle: H1, label: 'Card', last4: null, added_on: null, selected: true }] });
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
    .set('Content-Type', 'text/plain').send(JSON.stringify({ handle: H1 }));
  assert.equal(plain.status, 415);
  const noLink = await request(app({ reader })).post(`/agenpas/api/p/${PID}/card-choice`)
    .set('Content-Type', 'application/json').send(JSON.stringify({ handle: H1 }));
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

test('POST: 5 a minute per link (429 with Retry-After)', async () => {
  const a = app({ reader: fakeBackend() });
  const t = token();
  for (let i = 0; i < 5; i += 1) assert.equal((await post(a, { handle: H2 }, t)).status, 200);
  const sixth = await post(a, { handle: H2 }, t);
  assert.equal(sixth.status, 429);
  assert.ok(Number(sixth.headers['retry-after']) > 0);
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
    .set('Content-Type', 'application/json').send(JSON.stringify({ handle }));
  const first = await get();
  assert.equal(first.body.screen, 'choose_card');
  const [newest, older] = first.body.card_choice.cards;
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
