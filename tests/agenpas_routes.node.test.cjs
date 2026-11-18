'use strict';

// AgenPas routes (src/agenpas/router.js) on a bare Express app with the same fall-through shape as src/server.js,
// the backend reader (src/agenpas/purchaseReader.js) against a stubbed fetch, and the dev fixture guard.
// Loopback only (supertest); no backend, no external host.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const supertest = require('supertest');

const { createAgenpasRouter } = require('../src/agenpas/router');
const { createBackendPurchaseReader, INTERNAL_PURCHASES_PATH } = require('../src/agenpas/purchaseReader');
const { mintLinkToken } = require('../src/agenpas/linkToken');
const config = require('../src/agenpas/config');
const { SCENARIOS } = require('../src/agenpas/devFixtures');

// Each app listens on 127.0.0.1 itself, on a port the OS picks for IPv4. supertest's own `listen(0)` binds the IPv6
// wildcard and then connects to 127.0.0.1, which on a busy machine can reach ANOTHER process that holds the same port
// number on IPv4 (seen here as a stray 'not found'). Same chaining as supertest: request(app).get(p).set(...).
// Every request carries the public host by default (the routes answer only there); a test's own .set('Host') wins.
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
  return { get: verb('get'), post: verb('post') };
}

const SECRET = 'route-test-secret-for-agenpas-0123456789';
const PID = 'ap_0123456789abcdef01234567';
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const PUBLIC_HOST = 'agenpas.example';
const AUD = `https://${PUBLIC_HOST}`;
const CLAIMS = Object.freeze({ purchaseId: PID, agentId: 'agent_fixture_1', userRef: 'usr_fixtureFixtureFixture', aud: AUD });
const ENV_ON = Object.freeze({
  AGENPAS_ENABLED: '1',
  AGENPAS_LINK_SECRET: SECRET,
  AGENPAS_HOSTED_HOSTS: 'pay.partner.example',
  AGENPAS_PUBLIC_BASE_URL: AUD,
});

function body(state = 'needs_payment_method', extra = {}) {
  return {
    purchase_id: 'pp_aaaaaaaaaaaaaaaaaaaaaaaa', rail: 'a2a', executor: 'rail_managed', rail_purchase_id: PID, state,
    totals: { currency: 'USD', our_price_minor: 1800, quoted_total_minor: 2349 },
    poll_after_seconds: 15,
    next_action: { type: 'open_url', kind: 'card_binding', url: 'https://pay.partner.example/bind?s=1', expires_at: '2026-11-17T12:30:00Z' },
    detail: { id: PID, merchant_domain: 'merchant.example', product_name: 'Sample Lip Gloss', quantity: 1, agent_user_ref_hash: 'owner-hash-fixture' },
    ...extra,
  };
}

function recordingReader(answer = { kind: 'accepted', purchase: body() }) {
  const calls = [];
  return { calls, async read(claims) { calls.push(claims); return typeof answer === 'function' ? answer(claims) : answer; } };
}

// The same shape as src/server.js: the AgenPas router, then the app's own not-found.
function app({ env = ENV_ON, reader = recordingReader(), mount = true, now = () => NOW, fixtureReader, logger, limits } = {}) {
  const a = express();
  if (mount) a.use(createAgenpasRouter({ reader, env, now, fixtureReader, logger, limits }));
  a.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', path: req.path }));
  return a;
}

function token(over = {}) {
  return mintLinkToken({ ...CLAIMS, secret: SECRET, now: NOW, ...over });
}

const PATHS = [
  `/agenpas/p/${PID}`,
  `/agenpas/api/p/${PID}`,
  '/agenpas/assets/app.js',
  '/agenpas/assets/app.css',
  '/agenpas/dev/start',
  '/agenpas/anything',
];

// ---- the gate --------------------------------------------------------------------------------------------------

test('flag off (default): every /agenpas path answers byte-identically to an app without AgenPas', async () => {
  const reader = recordingReader();
  for (const env of [{}, { ...ENV_ON, AGENPAS_ENABLED: '' }, { ...ENV_ON, AGENPAS_ENABLED: 'off' }]) {
    for (const p of PATHS) {
      const withIt = await request(app({ env, reader })).get(p);
      const without = await request(app({ env, reader, mount: false })).get(p);
      assert.equal(withIt.status, 404, p);
      assert.equal(withIt.text, without.text, p);
      assert.equal(withIt.headers['content-type'], without.headers['content-type'], p);
      assert.equal(withIt.headers['content-security-policy'], undefined, p);
    }
  }
  assert.equal(reader.calls.length, 0);
});

test('on: paths that are not AgenPas routes, other methods, and another host still fall through', async () => {
  const a = app();
  for (const p of ['/agenpas/anything', '/agenpas/assets/other.js', '/AGENPAS/p/x', '/other']) {
    const res = await request(a).get(p);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'NOT_FOUND', p);
  }
  const post = await request(a).post(`/agenpas/api/p/${PID}`).send({});
  assert.equal(post.body.error, 'NOT_FOUND');
  const wrongHost = await request(a).get(`/agenpas/p/${PID}`).set('Host', 'other.example');
  assert.equal(wrongHost.body.error, 'NOT_FOUND');
  const rightHost = await request(a).get(`/agenpas/p/${PID}`).set('Host', PUBLIC_HOST);
  assert.equal(rightHost.status, 200);
});

test('on, but no AGENPAS_PUBLIC_BASE_URL (or an unusable one): no route is served on any host', async () => {
  for (const base of [undefined, '', 'http://agenpas.example', 'https://agenpas.example/sub', 'http://localhost:4000']) {
    const env = { ...ENV_ON, AGENPAS_PUBLIC_BASE_URL: base };
    for (const host of [PUBLIC_HOST, 'localhost:4000', 'anything.example']) {
      for (const p of [`/agenpas/p/${PID}`, `/agenpas/api/p/${PID}`, '/agenpas/assets/app.js']) {
        const res = await request(app({ env })).get(p).set('Host', host);
        assert.equal(res.body.error, 'NOT_FOUND', `${base} ${host} ${p}`);
      }
    }
  }
});

// ---- the page --------------------------------------------------------------------------------------------------

test('page: the shell is served for any well-formed id under a strict CSP; the server never sees the token', async () => {
  const res = await request(app()).get(`/agenpas/p/${PID}`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.equal(/unsafe-inline|unsafe-eval/.test(csp), false);
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.text.includes(PID), false);
  // No inline script, no card fields anywhere.
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(res.text), false);
  assert.equal(/<input|<form|cardnumber|cvv/i.test(res.text), false);
});

test('page: a ?t= query is not read (same shell, whatever it holds); bad id -> friendly 404; no secret -> 503', async () => {
  const a = app();
  const plain = await request(a).get(`/agenpas/p/${PID}`);
  for (const q of [token(), token({ now: NOW - 31 * 60_000 }), 'v1.forged.sig']) {
    const withQuery = await request(a).get(`/agenpas/p/${PID}?t=${q}`);
    assert.equal(withQuery.status, 200);
    assert.equal(withQuery.text, plain.text);
    assert.equal(withQuery.text.includes(q), false);
  }
  const badId = await request(a).get('/agenpas/p/not_an_id');
  assert.equal(badId.status, 404);
  assert.match(badId.text, /isn&#39;t valid|isn't valid/);
  const noSecret = await request(app({ env: { ...ENV_ON, AGENPAS_LINK_SECRET: '' } })).get(`/agenpas/p/${PID}`);
  assert.equal(noSecret.status, 503);
});

test('assets: served same-origin with nosniff; the script builds DOM without innerHTML and has no card fields', async () => {
  const js = await request(app()).get('/agenpas/assets/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  assert.equal(js.headers['x-content-type-options'], 'nosniff');
  const src = js.text;
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), false);
  // The only inputs are the shipping-address fields: never a card field (no cc-* autofill, no card / CVV / expiry
  // field or label), and the form posts to nothing but this page's own address route.
  assert.equal(/cc-(?:number|exp|csc|name|type)|['"](?:cardNumber|card_number|cvv|cvv2|cvc|expiry|exp_month|exp_year|pan)['"]|security code/i.test(src), false);
  // The form's fields are exactly the address fields.
  const fieldBlock = /var ADDRESS_ORDER = \[([^\]]+)\]/.exec(src);
  assert.deepEqual(fieldBlock[1].split(',').map((x) => x.trim().replace(/'/g, '')),
    ['email', 'firstName', 'lastName', 'phone', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country']);
  assert.equal((src.match(/el\('input'/g) || []).length, 1);
  assert.equal(/textarea/.test(src), false);
  assert.equal(/https?:\/\/(?!\/)/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'no absolute URLs (no CDN, no third party)');
  // The token: read from the fragment, the fragment cleared, sent only as the header; the query is never read,
  // and an expired / invalid link is shown from the API's 410 / 404.
  assert.match(src, /location\.hash/);
  assert.match(src, /history\.replaceState/);
  assert.match(src, /'X-Agenpas-Link': token/);
  assert.equal(/location\.search\)\.get|searchParams\.get\('t'\)/.test(src), false);
  assert.equal(/'\/agenpas\/api\/p\/' \+ match\[1\] \+ '\?/.test(src), false);
  assert.match(src, /r\.status === 410/);
  assert.match(src, /r\.status === 404/);
  const css = await request(app()).get('/agenpas/assets/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.equal(/@import|url\(/.test(css.text), false);
});

// ---- the API ---------------------------------------------------------------------------------------------------

test('api: a valid link in the header reads for the token\'s owner and answers the safe projection', async () => {
  const reader = recordingReader();
  const a = app({ reader });
  const viaHeader = await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token());
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.headers['cache-control'], 'no-store');
  assert.equal(viaHeader.body.screen, 'add_card');
  assert.equal(viaHeader.body.action.url, 'https://pay.partner.example/bind?s=1');
  const text = JSON.stringify(viaHeader.body);
  for (const leaked of ['pp_aaaaaaaaaaaaaaaaaaaaaaaa', 'owner-hash-fixture', 'rail_managed', CLAIMS.agentId, CLAIMS.userRef]) {
    assert.equal(text.includes(leaked), false, leaked);
  }
  // A token in the query is never read: tokens travel only in the header, never in a logged URL.
  const viaQuery = await request(a).get(`/agenpas/api/p/${PID}?t=${token()}`);
  assert.equal(viaQuery.status, 404);
  assert.equal(viaQuery.body.error, 'link_invalid');
  assert.deepEqual(reader.calls.map((c) => [c.purchaseId, c.agentId, c.userRef]), [[PID, CLAIMS.agentId, CLAIMS.userRef]]);
});

test('api: refused links never reach the reader', async () => {
  const reader = recordingReader();
  const a = app({ reader });
  assert.equal((await request(a).get(`/agenpas/api/p/${PID}`)).status, 404);
  assert.equal((await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', 'v1.a.b')).body.error, 'link_invalid');
  const expired = await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token({ now: NOW - 31 * 60_000 }));
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error, 'link_expired');
  assert.equal(reader.calls.length, 0);
});

test('api: reader outcomes map to 404 not_found and 503 unavailable (with Retry-After); a throw is unavailable', async () => {
  const notFound = await request(app({ reader: recordingReader({ kind: 'not_found' }) })).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token());
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.body, { error: 'not_found' });
  const down = await request(app({ reader: recordingReader({ kind: 'unavailable', code: 'timeout' }) })).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token());
  assert.equal(down.status, 503);
  assert.equal(down.body.error, 'unavailable');
  assert.ok(down.headers['retry-after']);
  const threw = await request(app({ reader: { read: async () => { throw new Error('Traceback: boom at /srv/x.py'); } } }))
    .get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token());
  assert.equal(threw.status, 503);
  assert.equal(threw.text.includes('Traceback'), false);
});

test('api: hosted pages are refused unless the gateway allowlist names their host (default empty)', async () => {
  const res = await request(app({ env: { ...ENV_ON, AGENPAS_HOSTED_HOSTS: '' } })).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token());
  assert.equal(res.status, 200);
  assert.equal(res.body.screen, 'add_card');
  assert.equal(res.body.action, null);
});

test('embed flag: the API marks actions for framing and the page CSP allows exactly the allowlisted hosts', async () => {
  const env = { ...ENV_ON, AGENPAS_EMBED_HOSTED_PAGES: '1' };
  const page = await request(app({ env })).get(`/agenpas/p/${PID}`);
  assert.match(page.headers['content-security-policy'], /frame-src https:\/\/pay\.partner\.example(;|$)/);
  assert.match(page.headers['permissions-policy'], /publickey-credentials-get=\("https:\/\/pay\.partner\.example"\)/);
  const api = await request(app({ env })).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token());
  assert.equal(api.body.action.open_mode, 'embed');
});

// ---- dev fixtures ----------------------------------------------------------------------------------------------

test('dev fixtures: off a dev machine the fixture mode cannot arm, whatever its flag says', () => {
  const on = { AGENPAS_DEV_FIXTURES: '1' };
  assert.equal(config.devFixturesEnabled(on), true);
  for (const managed of [{ K_SERVICE: 'gateway' }, { K_REVISION: 'gateway-001' }, { RAILWAY_ENVIRONMENT: 'staging' },
    { NODE_ENV: 'production' }, { PIVOTA_ENV: 'production' }]) {
    assert.equal(config.devFixturesEnabled({ ...on, ...managed }), false, JSON.stringify(managed));
  }
});

test('dev fixtures: /agenpas/dev/start mints a fixture link locally and is a plain 404 on a managed platform', async () => {
  const local = { ...ENV_ON, AGENPAS_DEV_FIXTURES: '1', AGENPAS_PUBLIC_BASE_URL: 'http://localhost:4000' };
  const reader = recordingReader();
  const a = app({ env: local, reader });
  const lo = (req) => req.set('Host', 'localhost:4000');
  const start = await lo(request(a).get('/agenpas/dev/start?scenario=happy'));
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.location, 'http://localhost');
  assert.equal(loc.pathname, `/agenpas/p/${SCENARIOS.happy.id}`);
  assert.equal(loc.search, '');
  const api = await lo(request(a).get(`/agenpas/api/p/${SCENARIOS.happy.id}`)).set('X-Agenpas-Link', new URLSearchParams(loc.hash.slice(1)).get('t'));
  assert.equal(api.status, 200);
  assert.equal(api.body.product_name, 'Sample Lip Gloss');
  assert.equal(JSON.stringify(api.body).includes('fixture-owner-hash'), false);
  assert.equal(reader.calls.length, 0, 'the backend reader is not used in fixture mode');

  // A managed platform: the fixture flag is inert, and localhost is no base URL there, so a deploy names its host.
  const deployed = app({ env: { ...local, AGENPAS_PUBLIC_BASE_URL: AUD, K_SERVICE: 'gateway' }, reader });
  const refused = await request(deployed).get('/agenpas/dev/start?scenario=happy');
  assert.equal(refused.status, 404);
  assert.equal(refused.body.error, 'NOT_FOUND');
  // And a link for a fixture id goes to the REAL reader there.
  const t = mintLinkToken({ purchaseId: SCENARIOS.happy.id, agentId: 'a', userRef: 'u', aud: AUD, secret: SECRET, now: NOW });
  await request(deployed).get(`/agenpas/api/p/${SCENARIOS.happy.id}`).set('X-Agenpas-Link', t);
  assert.equal(reader.calls.length, 1);
});

test('dev fixtures: on a dev machine but a non-loopback Host, /agenpas/dev/* is not served and the real reader answers', async () => {
  const reader = recordingReader();
  const a = app({ env: { ...ENV_ON, AGENPAS_DEV_FIXTURES: '1' }, reader });
  const refused = await request(a).get('/agenpas/dev/start?scenario=happy');
  assert.equal(refused.body.error, 'NOT_FOUND');
  const t = mintLinkToken({ purchaseId: SCENARIOS.happy.id, agentId: 'a', userRef: 'u', aud: AUD, secret: SECRET, now: NOW });
  await request(a).get(`/agenpas/api/p/${SCENARIOS.happy.id}`).set('X-Agenpas-Link', t);
  assert.equal(reader.calls.length, 1);
});

// ---- abuse valves ----------------------------------------------------------------------------------------------

test('api: one link token over its bucket gets 429 with Retry-After; another token is unaffected', async () => {
  const reader = recordingReader();
  const a = app({ reader, limits: { token: { capacity: 3, refillPerSecond: 0.0001 }, ip: { capacity: 1000 } } });
  const t1 = token();
  const codes = [];
  for (let i = 0; i < 5; i += 1) codes.push((await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', t1)).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const limited = await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', t1);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token())).status, 200);
});

test('api: one client IP over its bucket gets 429 before any token is checked', async () => {
  const reader = recordingReader();
  const a = app({ reader, limits: { ip: { capacity: 2, refillPerSecond: 0.0001 } } });
  const ip = (req) => req.set('X-Forwarded-For', '203.0.113.7, 198.51.100.1');
  assert.equal((await ip(request(a).get(`/agenpas/api/p/${PID}`)).set('X-Agenpas-Link', 'v1.junk.junk')).status, 404);
  assert.equal((await ip(request(a).get(`/agenpas/api/p/${PID}`)).set('X-Agenpas-Link', token())).status, 200);
  const third = await ip(request(a).get(`/agenpas/api/p/${PID}`)).set('X-Agenpas-Link', token());
  assert.equal(third.status, 429);
  assert.ok(third.headers['retry-after']);
  // Another client is unaffected.
  const other = await request(a).get(`/agenpas/api/p/${PID}`).set('X-Forwarded-For', '203.0.113.99, 198.51.100.1').set('X-Agenpas-Link', token());
  assert.equal(other.status, 200);
});

test('api: concurrent and repeated reads of one purchase share ONE backend read for ~2 s', async () => {
  let clock = NOW;
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const reader = { async read(claims) { calls.push(claims); await gate; return { kind: 'accepted', purchase: body() }; } };
  const a = app({ reader, now: () => clock });
  const pending = [1, 2, 3, 4].map(() => request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token()));
  await new Promise((r) => setTimeout(r, 50));
  release();
  const answers = await Promise.all(pending);
  assert.deepEqual(answers.map((r) => r.status), [200, 200, 200, 200]);
  assert.equal(calls.length, 1, 'single-flight');
  clock += 1500;
  await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token());
  assert.equal(calls.length, 1, 'cached within 2 s');
  clock += 1000;
  await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token());
  assert.equal(calls.length, 2, 'read again after 2 s');
  // Another agent's link for the same purchase is its own read.
  await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token({ agentId: 'agent_fixture_2' }));
  assert.equal(calls.length, 3);
});

test('refusal logs are sampled: the first 5 per reason per minute, then a count; never the token', async () => {
  let clock = NOW;
  const lines = [];
  const logger = { info: (o) => lines.push(o), warn: (o) => lines.push(o) };
  const a = app({ logger, now: () => clock, limits: { ip: { capacity: 1000 } } });
  for (let i = 0; i < 12; i += 1) await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', `v1.forged${i}.sig`);
  const refused = lines.filter((l) => l.outcome === 'refused' && l.reason === 'bad_signature');
  assert.equal(refused.length, 5);
  clock += 61_000;
  await request(a).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', 'v1.forged.sig');
  const summary = lines.find((l) => l.outcome === 'refused_suppressed');
  assert.equal(summary.suppressed, 7);
  assert.equal(JSON.stringify(lines).includes('forged'), false);
  assert.equal(JSON.stringify(lines).includes(PID), false);
});

test('api: an expired link answers 410 with the configured lifetime for the page\'s copy', async () => {
  const res = await request(app({ env: { ...ENV_ON, AGENPAS_LINK_TTL_SECONDS: '600' } })).get(`/agenpas/api/p/${PID}`)
    .set('X-Agenpas-Link', token({ now: NOW - 31 * 60_000 }));
  assert.equal(res.status, 410);
  assert.deepEqual(res.body, { error: 'link_expired', link_ttl_minutes: 10 });
});

test('api: a token minted for another public origin is refused', async () => {
  const res = await request(app()).get(`/agenpas/api/p/${PID}`).set('X-Agenpas-Link', token({ aud: 'https://elsewhere.example' }));
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'link_invalid');
});

// ---- the backend reader ----------------------------------------------------------------------------------------

function stubFetch(answer) {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return { status: answer.status, text: async () => text };
  }
  return { calls, fetchImpl };
}

test('reader: one GET to the internal route with the internal key and the token\'s owner; no redirects', async () => {
  const stub = stubFetch({ status: 200, body: body() });
  const reader = createBackendPurchaseReader({ baseUrl: 'https://backend.internal.example/', internalKey: () => 'internal-key-fixture', fetchImpl: stub.fetchImpl });
  const out = await reader.read({ ...CLAIMS, iat: 1, exp: 2 });
  assert.equal(out.kind, 'accepted');
  assert.equal(stub.calls.length, 1);
  const [{ url, init }] = stub.calls;
  assert.equal(url, `https://backend.internal.example${INTERNAL_PURCHASES_PATH}/${PID}`);
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['X-Internal-Key'], 'internal-key-fixture');
  assert.equal(init.headers['X-Agenpas-Agent-Id'], CLAIMS.agentId);
  assert.equal(init.headers['X-Agenpas-Agent-User-Ref'], CLAIMS.userRef);
  assert.equal(init.headers['X-API-Key'], undefined);
});

test('reader: outcomes (not found, mismatched body, 5xx, transport, unconfigured) never throw', async () => {
  const mk = (answer, key = 'k') => createBackendPurchaseReader({ baseUrl: 'https://backend.internal.example', internalKey: () => key, fetchImpl: stubFetch(answer).fetchImpl });
  assert.deepEqual(await mk({ status: 404, body: { detail: { error: 'purchase_not_found' } } }).read(CLAIMS), { kind: 'not_found' });
  assert.equal((await mk({ status: 200, body: { ...body(), purchase_id: 'pp_bbbbbbbbbbbbbbbbbbbbbbbb', rail_purchase_id: 'ap_ffffffffffffffffffffffff' } }).read(CLAIMS)).kind, 'unavailable');
  assert.deepEqual(await mk({ status: 404, body: { error: 'not_available' } }).read(CLAIMS), { kind: 'unavailable', code: 'not_available' });
  assert.equal((await mk({ status: 503, body: 'Traceback…' }).read(CLAIMS)).code, 'http_503');
  assert.equal((await mk(new TypeError('fetch failed')).read(CLAIMS)).code, 'transport');
  assert.equal((await mk({ status: 200, body: body() }, '').read(CLAIMS)).code, 'unconfigured');
  assert.deepEqual(await mk({ status: 200, body: body() }).read({ ...CLAIMS, purchaseId: 'bad' }), { kind: 'not_found' });
});
