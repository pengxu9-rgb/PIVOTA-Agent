'use strict';

// The AgenPas consent POST (src/agenpas/router.js), its host guard admission, and the backend consent write client
// (src/agenpas/purchaseReader.js createBackendConsentWriter) against a stubbed fetch. Same bare-Express shape as
// tests/agenpas_routes.node.test.cjs (router, then the guard's `back`, then the app's own not-found). Loopback only.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const supertest = require('supertest');

const { createAgenpasRouter, createAgenpasHostGuard, CONSENT_BODY_LIMIT_BYTES } = require('../src/agenpas/router');
const { createBackendConsentWriter, INTERNAL_PURCHASES_PATH, CONSENT_SUBPATH } = require('../src/agenpas/purchaseReader');
const { mintLinkToken } = require('../src/agenpas/linkToken');
const config = require('../src/agenpas/config');

const servers = [];
test.after(() => { for (const srv of servers) srv.close(); });
function listening(a) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(a);
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { servers.push(srv); resolve(srv); });
  });
}
function request(a) {
  const verb = (method) => (path) => {
    const steps = [];
    const chain = {
      set(...x) { steps.push(['set', x]); return chain; },
      send(...x) { steps.push(['send', x]); return chain; },
      then(onOk, onErr) {
        return listening(a).then((srv) => {
          let t = supertest(srv)[method](path).set('Host', PUBLIC_HOST);
          for (const [name, x] of steps) t = t[name](...x);
          return t;
        }).then(onOk, onErr);
      },
    };
    return chain;
  };
  return { get: verb('get'), post: verb('post'), options: verb('options'), put: verb('put') };
}

const SECRET = 'consent-route-test-secret-0123456789abcd';
const PID = 'rp_0123456789abcdef01234567';
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const PUBLIC_HOST = 'agenpas.example';
const AUD = `https://${PUBLIC_HOST}`;
const CLAIMS = Object.freeze({ purchaseId: PID, agentId: 'agent_fixture_1', userRef: 'usr_fixtureFixtureFixture', aud: AUD });
const ENV_ON = Object.freeze({
  AGENPAS_ENABLED: '1', AGENPAS_LINK_SECRET: SECRET, AGENPAS_HOSTED_HOSTS: 'pay.partner.example', AGENPAS_PUBLIC_BASE_URL: AUD,
  AGENPAS_CONSENT_ENABLED: '1', AGENPAS_LEGAL_HOSTS: 'legal.example',
});
const ENV_CONSENT_OFF = Object.freeze({ ...ENV_ON, AGENPAS_CONSENT_ENABLED: undefined });
const OFFER = Object.freeze({ id: 'offer0123456789abcdef0123456789ab', issued_at: '2026-11-18T11:59:50Z' });
const CONSENT_PATH = `/agenpas/api/p/${PID}/consent`;

function purchase(over = {}) {
  return {
    purchase_id: 'pp_aaaaaaaaaaaaaaaaaaaaaaaa', rail: 'reap', executor: 'rail_managed', rail_purchase_id: PID, state: 'needs_payment_method',
    totals: { currency: 'USD', our_price_minor: 1800 }, poll_after_seconds: 15,
    next_action: { kind: 'card_binding', expires_at: '2026-11-18T12:20:00Z', consent_required: true },
    consent: {
      required: true, available: true, step: 'card_binding', satisfied: false,
      terms_url: 'https://legal.example/terms', privacy_url: 'https://legal.example/privacy',
      terms_version: 'terms-2026-11', privacy_version: 'privacy-2026-11', offer: { ...OFFER },
    },
    detail: { id: PID, merchant_domain: 'merchant.example', product_name: 'Sample Lip Gloss', quantity: 1 },
    ...over,
  };
}

function recordingReader(answer = () => ({ kind: 'accepted', purchase: purchase() })) {
  const calls = [];
  return { calls, async read(claims) { calls.push(claims); return typeof answer === 'function' ? answer(claims) : answer; } };
}
function recordingWriter(answer = { kind: 'recorded' }) {
  const calls = [];
  return { calls, async record(claims, consent) { calls.push({ claims, consent }); return typeof answer === 'function' ? answer() : answer; } };
}

function app({ env = ENV_ON, reader = recordingReader(), writer = recordingWriter(), mount = true, guard = true, now = () => NOW, limits } = {}) {
  const a = express();
  const g = createAgenpasHostGuard({ env });
  if (guard) a.use(g.front);
  if (mount) a.use(createAgenpasRouter({ reader, consentWriter: writer, env, now, limits }));
  if (guard) a.use(g.back);
  a.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', path: req.path }));
  return a;
}

function token(over = {}) {
  return mintLinkToken({ ...CLAIMS, secret: SECRET, now: NOW, ...over });
}

function goodPost(a, { body = { step: 'card_binding', offer_id: OFFER.id, issued_at: OFFER.issued_at }, headers = {} } = {}) {
  let r = request(a).post(CONSENT_PATH)
    .set('Origin', AUD).set('Sec-Fetch-Site', 'same-origin').set('X-Agenpas-Link', token());
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body);
}

// ---- flag off: byte-identical ----------------------------------------------------------------------------------

test('consent flag off: the POST is not a route (the guard refuses it on the host; off the host it falls through), exactly as before', async () => {
  for (const env of [ENV_CONSENT_OFF, { ...ENV_ON, AGENPAS_CONSENT_ENABLED: '0' }, { ...ENV_ON, AGENPAS_CONSENT_ENABLED: 'off' }]) {
    const reader = recordingReader();
    const writer = recordingWriter();
    const res = await goodPost(app({ env, reader, writer }));
    assert.equal(res.status, 404);
    assert.equal(res.headers['x-agenpas-guard'], 'front');
    assert.equal(res.text, 'Not found');
    // Router alone (no guard): falls through to the app's own not-found, byte for byte the same as no router at all.
    const bare = await goodPost(app({ env, reader, writer, guard: false }));
    const none = await goodPost(app({ env, reader, writer, guard: false, mount: false }));
    assert.equal(bare.status, 404);
    assert.equal(bare.text, none.text);
    assert.equal(bare.headers['content-type'], none.headers['content-type']);
    assert.equal(reader.calls.length + writer.calls.length, 0);
  }
});

test('consent flag off vs on: every GET route answers the same (the flag adds one POST and nothing else)', async () => {
  for (const p of [`/agenpas/p/${PID}`, '/agenpas/assets/app.js', '/agenpas/anything', CONSENT_PATH]) {
    const off = await request(app({ env: ENV_CONSENT_OFF })).get(p);
    const on = await request(app({ env: ENV_ON })).get(p);
    assert.equal(on.status, off.status, p);
    assert.equal(on.text, off.text, p);
    assert.equal(on.headers['x-agenpas-guard'], off.headers['x-agenpas-guard'], p);
  }
});

test('the host guard admits exactly the consent POST shape while on; every other non-GET stays refused', async () => {
  const a = app();
  for (const [method, p] of [
    ['post', `/agenpas/api/p/${PID}`], ['post', `/agenpas/api/p/${PID}/consent/`], ['post', `/agenpas/api/p/${PID}/Consent`],
    ['post', `/agenpas/api/p/${PID}/consent/x`], ['post', '/agenpas/api/p/rp_0123/consent'], ['post', `/agenpas/api/p/${PID}%2fconsent`],
    ['post', `/agenpas/p/${PID}/consent`], ['put', CONSENT_PATH], ['options', CONSENT_PATH], ['options', `/agenpas/api/p/${PID}`],
  ]) {
    const res = await request(a)[method](p).set('Origin', AUD).set('Sec-Fetch-Site', 'same-origin')
      .set('Access-Control-Request-Method', 'POST').set('X-Agenpas-Link', token());
    assert.equal(res.status, 404, `${method} ${p}`);
    assert.equal(res.headers['x-agenpas-guard'], 'front', `${method} ${p}`);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  // The admitted shape reaches the route; a GET of it is admitted by nothing either.
  assert.equal((await goodPost(a)).status, 200);
});

// ---- the cross-site checks -------------------------------------------------------------------------------------

test('refused without the exact Origin (missing, another origin, http, a port), before any read or write', async () => {
  for (const origin of [undefined, 'https://evil.example', 'http://agenpas.example', 'https://agenpas.example:444', 'null', `${AUD}/`]) {
    const reader = recordingReader();
    const writer = recordingWriter();
    let r = request(app({ reader, writer })).post(CONSENT_PATH).set('Sec-Fetch-Site', 'same-origin').set('X-Agenpas-Link', token());
    if (origin !== undefined) r = r.set('Origin', origin);
    const res = await r.send({ step: 'card_binding', offer_id: OFFER.id, issued_at: OFFER.issued_at });
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.body.error, 'forbidden');
    assert.equal(reader.calls.length + writer.calls.length, 0);
  }
});

test('Sec-Fetch-Site: refused when SENT and not same-origin; ABSENT is allowed (older Safari / iOS 15 send none)', async () => {
  for (const site of ['cross-site', 'same-site', 'none', 'SAME-ORIGIN']) {
    const writer = recordingWriter();
    const res = await request(app({ writer })).post(CONSENT_PATH).set('Origin', AUD).set('X-Agenpas-Link', token())
      .set('Sec-Fetch-Site', site).send({ step: 'card_binding', offer_id: OFFER.id, issued_at: OFFER.issued_at });
    assert.equal(res.status, 403, site);
    assert.equal(res.body.error, 'forbidden');
    assert.equal(writer.calls.length, 0);
  }
  const writer = recordingWriter();
  const absent = await request(app({ writer })).post(CONSENT_PATH).set('Origin', AUD).set('X-Agenpas-Link', token())
    .send({ step: 'card_binding', offer_id: OFFER.id, issued_at: OFFER.issued_at });
  assert.equal(absent.status, 200);
  assert.equal(writer.calls.length, 1);
  // Absent Sec-Fetch-Site never relaxes the rest: the exact Origin, JSON, and the link are still required.
  const noOrigin = await request(app()).post(CONSENT_PATH).set('X-Agenpas-Link', token()).send({ step: 'card_binding', offer_id: OFFER.id, issued_at: OFFER.issued_at });
  assert.equal(noOrigin.status, 403);
  const form = await request(app()).post(CONSENT_PATH).set('Origin', AUD).set('X-Agenpas-Link', token())
    .set('Content-Type', 'application/x-www-form-urlencoded').send('step=card_binding');
  assert.equal(form.status, 415);
  const noLink = await request(app()).post(CONSENT_PATH).set('Origin', AUD).send({ step: 'card_binding', offer_id: OFFER.id, issued_at: OFFER.issued_at });
  assert.equal(noLink.status, 404);
});

test('a non-JSON body is 415 (a plain form, text, no content type)', async () => {
  for (const [type, body] of [['application/x-www-form-urlencoded', 'step=card_binding'], ['text/plain', '{"step":"card_binding"}'],
    ['multipart/form-data; boundary=x', '--x--'], ['application/json-patch+json', '{}']]) {
    const writer = recordingWriter();
    const res = await request(app({ writer })).post(CONSENT_PATH).set('Origin', AUD).set('Sec-Fetch-Site', 'same-origin')
      .set('X-Agenpas-Link', token()).set('Content-Type', type).send(body);
    assert.equal(res.status, 415, type);
    assert.equal(res.body.error, 'unsupported_media_type');
    assert.equal(writer.calls.length, 0);
  }
  const charset = await goodPost(app(), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(charset.status, 200);
});

// ---- the link and the body -------------------------------------------------------------------------------------

test('refused without a valid link token: none / another purchase / tampered 404, expired 410', async () => {
  const writer = recordingWriter();
  const a = app({ writer });
  const send = (t) => {
    let r = request(a).post(CONSENT_PATH).set('Origin', AUD).set('Sec-Fetch-Site', 'same-origin');
    if (t !== undefined) r = r.set('X-Agenpas-Link', t);
    return r.send({ step: 'card_binding', offer_id: OFFER.id, issued_at: OFFER.issued_at });
  };
  assert.equal((await send(undefined)).status, 404);
  assert.equal((await send(mintLinkToken({ ...CLAIMS, purchaseId: 'rp_ffffffffffffffffffffffff', secret: SECRET, now: NOW }))).status, 404);
  assert.equal((await send(`${token()}x`)).status, 404);
  const expired = await send(mintLinkToken({ ...CLAIMS, secret: SECRET, now: NOW - 31 * 60 * 1000, ttlSeconds: 1800 }));
  assert.equal(expired.status, 410);
  assert.equal(writer.calls.length, 0);
});

test('the body: exactly {step, offer_id, issued_at}, each well formed, at most 1 kB; else 400 / 413 and nothing written', async () => {
  const good = { step: 'card_binding', offer_id: OFFER.id, issued_at: OFFER.issued_at };
  for (const body of [
    {}, [], { ...good, terms_version: 'terms-browser' }, { ...good, extra: 1 }, { step: 'card_binding', offer_id: OFFER.id },
    { ...good, step: 'authenticate' }, { ...good, offer_id: 'short' }, { ...good, issued_at: 'now' }, { ...good, offer_id: 12 },
  ]) {
    const writer = recordingWriter();
    const res = await goodPost(app({ writer }), { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(writer.calls.length, 0);
  }
  const writer = recordingWriter();
  const big = await goodPost(app({ writer }), { body: { ...good, offer_id: 'a'.repeat(CONSENT_BODY_LIMIT_BYTES) } });
  assert.equal(big.status, 413);
  const junk = await request(app({ writer })).post(CONSENT_PATH).set('Origin', AUD).set('Sec-Fetch-Site', 'same-origin')
    .set('X-Agenpas-Link', token()).set('Content-Type', 'application/json').send('{"step":');
  assert.equal(junk.status, 400);
  const scalar = await request(app({ writer })).post(CONSENT_PATH).set('Origin', AUD).set('Sec-Fetch-Site', 'same-origin')
    .set('X-Agenpas-Link', token()).set('Content-Type', 'application/json').send('"card_binding"');
  assert.equal(scalar.status, 400, 'strict JSON: a bare string is refused');
  assert.equal(writer.calls.length, 0);
});

// ---- the gateway's own read decides ----------------------------------------------------------------------------

test('recorded: the backend gets the offer the page echoed and the versions from the gateway\'s OWN read; the read cache is dropped', async () => {
  const reader = recordingReader();
  const writer = recordingWriter();
  const a = app({ reader, writer });
  assert.equal((await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token())).status, 200);
  assert.equal(reader.calls.length, 1);
  const res = await goodPost(a);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { recorded: true });
  assert.equal(reader.calls.length, 1, 'the POST read the cached answer (the page\'s latest read)');
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].claims.agentId, CLAIMS.agentId);
  assert.equal(writer.calls[0].claims.purchaseId, PID);
  assert.deepEqual(writer.calls[0].consent, {
    step: 'card_binding', offer_id: OFFER.id, issued_at: OFFER.issued_at, terms_version: 'terms-2026-11', privacy_version: 'privacy-2026-11',
  });
  // The next poll inside the 2 s window reads the backend again (the hosted page may now be there).
  assert.equal((await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token())).status, 200);
  assert.equal(reader.calls.length, 2);
});

test('409 consent_stale when the read offers nothing for that step (another step, satisfied, held, paused, flag-off block, wrong state)', async () => {
  for (const [name, body] of [
    ['other step', purchase({ consent: { ...purchase().consent, step: 'approval' } })],
    ['satisfied', purchase({ consent: { ...purchase().consent, satisfied: true } })],
    ['held', purchase({ detail: { ...purchase().detail, last_error_code: 'checkout_dispatch_unresolved' } })],
    ['paused', purchase({ detail: { ...purchase().detail, contact_reentry_required: true } })],
    ['placing', purchase({ state: 'placing' })],
    ['no block', purchase({ consent: undefined })],
    ['unavailable', purchase({ consent: { ...purchase().consent, available: false } })],
  ]) {
    const writer = recordingWriter();
    const res = await goodPost(app({ reader: recordingReader(() => ({ kind: 'accepted', purchase: body })), writer }));
    assert.equal(res.status, 409, name);
    assert.equal(res.body.error, 'consent_stale', name);
    assert.equal(writer.calls.length, 0, name);
  }
});

test('409 consent_stale when the browser names another step than the one the read offers', async () => {
  const writer = recordingWriter();
  const res = await goodPost(app({ writer }), { body: { step: 'approval', offer_id: OFFER.id, issued_at: OFFER.issued_at } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'consent_stale');
  assert.equal(writer.calls.length, 0);
});

test('the backend\'s answers: stale 409, refused 400, unavailable / throw / no writer 503; read not_found 404, read down 503', async () => {
  for (const [answer, status, error] of [
    [{ kind: 'stale' }, 409, 'consent_stale'], [{ kind: 'too_soon', code: 'consent_too_soon' }, 409, 'consent_too_soon'],
    [{ kind: 'refused', code: 'purchase_not_found' }, 400, 'consent_refused'],
    [{ kind: 'unavailable', code: 'http_503' }, 503, 'unavailable'], [() => { throw new Error('boom'); }, 503, 'unavailable'],
  ]) {
    const res = await goodPost(app({ writer: recordingWriter(answer) }));
    assert.equal(res.status, status, JSON.stringify(answer));
    assert.equal(res.body.error, error);
  }
  assert.equal((await goodPost(app({ writer: null }))).status, 503);
  assert.equal((await goodPost(app({ reader: recordingReader(() => ({ kind: 'not_found' })) }))).status, 404);
  const down = await goodPost(app({ reader: recordingReader(() => ({ kind: 'unavailable', code: 'timeout' })) }));
  assert.equal(down.status, 503);
  assert.equal(down.headers['retry-after'], '5');
});

test('the same rate-limit buckets as the read: 429 with Retry-After', async () => {
  const a = app({ limits: { token: { capacity: 1, refillPerSecond: 0.0001 } } });
  const t = token();
  assert.equal((await goodPost(a, { headers: { 'X-Agenpas-Link': t } })).status, 200);
  const res = await goodPost(a, { headers: { 'X-Agenpas-Link': t } });
  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], '2');
});

test('on another host the consent POST is not ours', async () => {
  const res = await goodPost(app({ guard: false }), { headers: { Host: 'other.example' } });
  assert.equal(res.body.error, 'NOT_FOUND');
});

// ---- the backend write client ----------------------------------------------------------------------------------

function stubFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { status, text: async () => (body === undefined ? '' : JSON.stringify(body)) }; };
  fn.calls = calls;
  return fn;
}
const RECORD = Object.freeze({ step: 'approval', offer_id: OFFER.id, issued_at: OFFER.issued_at, terms_version: 't1', privacy_version: 'p1' });
const KEY = 'k'.repeat(40);

test('consent writer: POSTs exactly the contract (path, own key, agent id, five members) and maps every answer', async () => {
  const fetchImpl = stubFetch(201, { recorded: true });
  const writer = createBackendConsentWriter({ baseUrl: 'https://backend.example/', internalKey: () => KEY, fetchImpl });
  assert.deepEqual(await writer.record(CLAIMS, { ...RECORD, smuggled: 'x' }), { kind: 'recorded' });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, `https://backend.example${INTERNAL_PURCHASES_PATH}/${PID}${CONSENT_SUBPATH}`);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(init.headers, { 'X-Internal-Key': KEY, 'X-Agenpas-Agent-Id': CLAIMS.agentId, 'Content-Type': 'application/json', Accept: 'application/json' });
  assert.deepEqual(JSON.parse(init.body), RECORD);
  assert.deepEqual(Object.keys(JSON.parse(init.body)), ['step', 'offer_id', 'issued_at', 'terms_version', 'privacy_version']);
  for (const [status, body, kind] of [
    [200, {}, 'recorded'], [409, { detail: { error: 'consent_stale' } }, 'stale'], [409, { detail: { error: 'consent_too_soon' } }, 'too_soon'],
    [409, {}, 'stale'], [400, { error: 'wrong_step' }, 'refused'],
    [404, { error: 'purchase_not_found' }, 'refused'], [503, {}, 'unavailable'], [500, undefined, 'unavailable'], [302, {}, 'unavailable'],
  ]) {
    const w = createBackendConsentWriter({ baseUrl: 'https://backend.example', internalKey: () => KEY, fetchImpl: stubFetch(status, body) });
    assert.equal((await w.record(CLAIMS, RECORD)).kind, kind, String(status));
  }
});

test('consent writer: no key, no base URL, transport error or timeout -> unavailable; never throws', async () => {
  const fetchImpl = stubFetch(201, {});
  assert.equal((await createBackendConsentWriter({ baseUrl: 'https://backend.example', internalKey: () => '', fetchImpl }).record(CLAIMS, RECORD)).kind, 'unavailable');
  assert.equal((await createBackendConsentWriter({ baseUrl: '', internalKey: () => KEY, fetchImpl }).record(CLAIMS, RECORD)).kind, 'unavailable');
  assert.equal(fetchImpl.calls.length, 0);
  const broken = createBackendConsentWriter({ baseUrl: 'https://backend.example', internalKey: () => KEY, fetchImpl: async () => { throw new Error('econnreset'); } });
  assert.deepEqual(await broken.record(CLAIMS, RECORD), { kind: 'unavailable', code: 'transport' });
  const slow = createBackendConsentWriter({
    baseUrl: 'https://backend.example', internalKey: () => KEY, timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }),
  });
  assert.deepEqual(await slow.record(CLAIMS, RECORD), { kind: 'unavailable', code: 'timeout' });
  assert.equal((await createBackendConsentWriter({ baseUrl: 'https://backend.example', internalKey: () => KEY, fetchImpl }).record({ purchaseId: 'bad' }, RECORD)).kind, 'refused');
});

test('config: the consent key needs 32+ characters; AGENPAS_LEGAL_HOSTS defaults to pivota.cc', () => {
  assert.equal(config.internalConsentKey({ AGENPAS_INTERNAL_CONSENT_KEY: 'short' }), '');
  assert.equal(config.internalConsentKey({ AGENPAS_INTERNAL_CONSENT_KEY: KEY }), KEY);
  assert.equal(config.internalConsentKey({}), '');
  assert.deepEqual(config.legalHosts({}), ['pivota.cc']);
  assert.deepEqual(config.legalHosts({ AGENPAS_LEGAL_HOSTS: 'Legal.Example., bad host, x' }), ['legal.example']);
  assert.equal(config.consentEnabled({}), false);
});

test('config: AGENPAS_RAILS defaults to a2a; reap is honoured ONLY with consent on; a list leaving no rail falls back to a2a, warned once', () => {
  const warned = [];
  const warn = (raw) => warned.push(raw);
  assert.deepEqual(config.rails({}, warn), ['a2a']);
  assert.deepEqual(config.rails({ AGENPAS_RAILS: '' }, warn), ['a2a']);
  assert.deepEqual(config.rails({ AGENPAS_RAILS: 'a2a,reap' }, warn), ['a2a']);
  assert.deepEqual(config.rails({ AGENPAS_RAILS: 'a2a,reap', AGENPAS_CONSENT_ENABLED: '0' }, warn), ['a2a']);
  assert.deepEqual(config.rails({ AGENPAS_RAILS: ' A2A , Reap ,other', AGENPAS_CONSENT_ENABLED: '1' }, warn), ['a2a', 'reap']);
  assert.deepEqual(warned, [], 'no fallback, no warning');
  // Nothing servable: a2a, never silently nothing.
  assert.deepEqual(config.rails({ AGENPAS_RAILS: 'reap' }, warn), ['a2a']);
  assert.deepEqual(config.rails({ AGENPAS_RAILS: 'a2aa' }, warn), ['a2a']);
  assert.deepEqual(warned, ['reap', 'a2aa']);
  // a2a is dropped only by a list that names another servable rail.
  assert.deepEqual(config.rails({ AGENPAS_RAILS: 'reap', AGENPAS_CONSENT_ENABLED: '1' }, warn), ['reap']);
  // The default warner logs once per value and never throws.
  assert.doesNotThrow(() => { config.rails({ AGENPAS_RAILS: 'typo-rail' }); config.rails({ AGENPAS_RAILS: 'typo-rail' }); });
});

test('the global JSON parser skip is the AgenPas host only (another host, or AgenPas off, parses as before)', () => {
  const guard = (env) => createAgenpasHostGuard({ env });
  const req = (host) => ({ headers: { host }, method: 'POST', path: CONSENT_PATH });
  assert.equal(guard(ENV_ON).skipsGlobalBodyParser(req(PUBLIC_HOST)), true);
  assert.equal(guard(ENV_ON).skipsGlobalBodyParser(req(`${PUBLIC_HOST}:443`)), true);
  assert.equal(guard(ENV_ON).skipsGlobalBodyParser(req('gateway.example')), false);
  assert.equal(guard(ENV_ON).skipsGlobalBodyParser(req('localhost:4000')), false);
  assert.equal(guard({ ...ENV_ON, AGENPAS_ENABLED: undefined }).skipsGlobalBodyParser(req(PUBLIC_HOST)), false);
});
