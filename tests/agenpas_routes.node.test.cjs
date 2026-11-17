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
          let t = supertest(srv)[method](path);
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
const CLAIMS = Object.freeze({ purchaseId: PID, agentId: 'agent_fixture_1', userRef: 'usr_fixtureFixtureFixture' });
const ENV_ON = Object.freeze({
  AGENPAS_ENABLED: '1',
  AGENPAS_LINK_SECRET: SECRET,
  AGENPAS_HOSTED_HOSTS: 'pay.partner.example',
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
function app({ env = ENV_ON, reader = recordingReader(), mount = true, now = () => NOW, fixtureReader } = {}) {
  const a = express();
  if (mount) a.use(createAgenpasRouter({ reader, env, now, fixtureReader }));
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
  const hosted = app({ env: { ...ENV_ON, AGENPAS_PUBLIC_BASE_URL: 'https://agenpas.example' } });
  const wrongHost = await request(hosted).get(`/agenpas/p/${PID}`).set('Host', 'other.example');
  assert.equal(wrongHost.body.error, 'NOT_FOUND');
  const rightHost = await request(hosted).get(`/agenpas/p/${PID}`).set('Host', 'agenpas.example');
  assert.equal(rightHost.status, 200);
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
  assert.equal(/createElement\(['"](input|form|textarea|select)['"]/.test(src), false);
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
  const local = { ...ENV_ON, AGENPAS_DEV_FIXTURES: '1' };
  const reader = recordingReader();
  const a = app({ env: local, reader });
  const start = await request(a).get('/agenpas/dev/start?scenario=happy');
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.location, 'http://localhost');
  assert.equal(loc.pathname, `/agenpas/p/${SCENARIOS.happy.id}`);
  assert.equal(loc.search, '');
  const api = await request(a).get(`/agenpas/api/p/${SCENARIOS.happy.id}`).set('X-Agenpas-Link', new URLSearchParams(loc.hash.slice(1)).get('t'));
  assert.equal(api.status, 200);
  assert.equal(api.body.product_name, 'Sample Lip Gloss');
  assert.equal(JSON.stringify(api.body).includes('fixture-owner-hash'), false);
  assert.equal(reader.calls.length, 0, 'the backend reader is not used in fixture mode');

  const deployed = app({ env: { ...local, K_SERVICE: 'gateway' }, reader });
  const refused = await request(deployed).get('/agenpas/dev/start?scenario=happy');
  assert.equal(refused.status, 404);
  assert.equal(refused.body.error, 'NOT_FOUND');
  // And a link for a fixture id goes to the REAL reader there.
  const t = mintLinkToken({ purchaseId: SCENARIOS.happy.id, agentId: 'a', userRef: 'u', secret: SECRET, now: NOW });
  await request(deployed).get(`/agenpas/api/p/${SCENARIOS.happy.id}`).set('X-Agenpas-Link', t);
  assert.equal(reader.calls.length, 1);
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
