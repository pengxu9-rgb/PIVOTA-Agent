'use strict';

// The AgenPas product image (src/agenpas/productImage.js and GET /agenpas/api/p/:id/image in router.js): the URL
// check, the byte sniff, the fetcher's cache and refusals, and the route, all against a stubbed fetch and a recording
// reader on a bare Express app listening on 127.0.0.1. No backend and no external host.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const supertest = require('supertest');

const { createAgenpasRouter, createAgenpasHostGuard } = require('../src/agenpas/router');
const { mintLinkToken } = require('../src/agenpas/linkToken');
const {
  IMAGE_CACHE_MAX_ENTRIES, IMAGE_MAX_BYTES, IMAGE_MAX_IN_FLIGHT, IMAGE_REFUSAL_CACHE_MS, IMAGE_TYPES,
  createProductImageFetcher, productImageUrlFor, sniffImageType,
} = require('../src/agenpas/productImage');

const servers = [];
test.after(() => { for (const srv of servers) srv.close(); });
function listening(a) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(a);
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { servers.push(srv); resolve(srv); });
  });
}
function get(a, path, headers = {}) {
  return listening(a).then((srv) => {
    let t = supertest(srv).get(path).set('Host', PUBLIC_HOST);
    for (const [k, v] of Object.entries(headers)) t = t.set(k, v);
    return t.buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  });
}

const SECRET = 'image-test-secret-for-agenpas-0123456789';
const PID = 'ap_0123456789abcdef01234567';
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const PUBLIC_HOST = 'agenpas.example';
const AUD = `https://${PUBLIC_HOST}`;
const CLAIMS = Object.freeze({ purchaseId: PID, agentId: 'agent_fixture_1', userRef: 'usr_fixtureFixtureFixture', aud: AUD });
const ENV_ON = Object.freeze({ AGENPAS_ENABLED: '1', AGENPAS_LINK_SECRET: SECRET, AGENPAS_HOSTED_HOSTS: 'pay.partner.example', AGENPAS_PUBLIC_BASE_URL: AUD });
const IMAGE_PATH = `/agenpas/api/p/${PID}/image`;
const IMAGE_URL = 'https://cdn.example.com/files/rose.jpg';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(60, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(60, 4)]);

function body(extra = {}) {
  return {
    purchase_id: 'pp_aaaaaaaaaaaaaaaaaaaaaaaa', rail: 'a2a', executor: 'rail_managed', rail_purchase_id: PID, state: 'needs_payment_method',
    totals: { currency: 'USD', our_price_minor: 1800, quoted_total_minor: 2349 },
    poll_after_seconds: 15,
    next_action: { type: 'open_url', kind: 'card_binding', url: 'https://pay.partner.example/bind?s=1', expires_at: '2026-11-25T12:30:00Z' },
    detail: { id: PID, merchant_domain: 'merchant.example', product_name: 'Sample Lip Gloss', quantity: 1 },
    ...extra,
  };
}
function reader(purchase = body({ product_image_url: IMAGE_URL })) {
  const calls = [];
  return { calls, async read(claims) { calls.push(claims); return { kind: 'accepted', purchase }; } };
}
function fetcher(answer = { ok: true, type: 'image/jpeg', body: JPEG }) {
  const calls = [];
  return { calls, async get(url) { calls.push(url); return typeof answer === 'function' ? answer(url) : answer; } };
}
function app({ env = ENV_ON, rd = reader(), img = fetcher(), limits, guard = false } = {}) {
  const a = express();
  const g = createAgenpasHostGuard({ env });
  if (guard) a.use(g.front);
  a.use(createAgenpasRouter({ reader: rd, imageFetcher: img, env, now: () => NOW, limits }));
  if (guard) a.use(g.back);
  a.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', path: req.path }));
  return a;
}
function token(over = {}) {
  return mintLinkToken({ ...CLAIMS, secret: SECRET, now: NOW, ...over });
}
const json = (res) => JSON.parse(res.body.toString('utf8'));

// ---- the URL check -------------------------------------------------------------------------------------------

test('productImageUrlFor: only a clean public https URL, never repaired', () => {
  for (const ok of [IMAGE_URL, 'https://cdn.example.com/a.jpg?v=12&w=800', 'https://cdn.example.com:443/a.jpg', 'https://CDN.example.com/a.jpg']) {
    assert.equal(productImageUrlFor(ok), ok, ok);
  }
  for (const bad of [
    null, 42, '', ` ${IMAGE_URL}`, `${IMAGE_URL} `, 'http://cdn.example.com/a.jpg', '//cdn.example.com/a.jpg', '/a.jpg',
    'data:image/png;base64,AAAA', 'https://user:pw@cdn.example.com/a.jpg', 'https://cdn.example.com@evil.example/a.jpg',
    'https://cdn.example.com:8443/a.jpg', 'https://10.0.0.1/a.jpg', 'https://2130706433/a.jpg', 'https://0x7f.0.0.1/a.jpg',
    'https://[::1]/a.jpg', 'https://localhost/a.jpg', 'https://cdn.example.com/a b.jpg', 'https://cdn.example.com/a\tb.jpg',
    'https://cdn.example.com/café.jpg', 'https://cdn.example.com/a.jpg#x', `https://cdn.example.com/${'a'.repeat(2048)}`,
    'https://cdn%2eexample.com/a.jpg', 'javascript:alert(1)',
  ]) {
    assert.equal(productImageUrlFor(bad), null, String(bad));
  }
});

test('sniffImageType: the bytes decide, JPEG / PNG / WebP only', () => {
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(WEBP), 'image/webp');
  for (const bad of [SVG, GIF, Buffer.from('<html></html>'), Buffer.alloc(0), Buffer.from([0xff, 0xd8]), 'not a buffer']) {
    assert.equal(sniffImageType(bad), null);
  }
  assert.deepEqual([...IMAGE_TYPES], ['image/jpeg', 'image/png', 'image/webp']);
});

// ---- the fetcher ---------------------------------------------------------------------------------------------

function stubFetch(answers) {
  const calls = [];
  const queue = [...answers];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length ? queue.shift() : { status: 500, body: Buffer.alloc(0) };
    if (next.throw) throw next.throw;
    return new Response(next.body, { status: next.status, headers: next.headers || { 'content-type': 'image/svg+xml' } });
  };
  fn.calls = calls;
  return fn;
}

test('the fetcher asks once, with no redirects and a timeout, sniffs the bytes and caches the answer', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: PNG }]);
  let t = NOW;
  const f = createProductImageFetcher({ fetchImpl, now: () => t });
  const [a, b] = await Promise.all([f.get(IMAGE_URL), f.get(IMAGE_URL)]);
  assert.equal(fetchImpl.calls.length, 1, 'single flight');
  assert.deepEqual([a.ok, a.type], [true, 'image/png']);  // the store said svg; the bytes say png
  assert.ok(a.body.equals(PNG));
  assert.equal(b, a);
  const init = fetchImpl.calls[0].init;
  assert.equal(fetchImpl.calls[0].url, IMAGE_URL);
  // EVERYTHING the store is sent: the method, one Accept header, no redirects, a timeout. Nothing about the buyer
  // (no User-Agent, Referer, cookie, IP or link) and nothing else.
  assert.deepEqual(Object.keys(init).sort(), ['headers', 'method', 'redirect', 'signal']);
  assert.equal(init.redirect, 'error');
  assert.equal(init.method, 'GET');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, { Accept: 'image/jpeg, image/png, image/webp' });
  t += 4 * 60 * 1000;
  await f.get(IMAGE_URL);
  assert.equal(fetchImpl.calls.length, 1, 'still cached');
});

test('the fetcher refuses what is not a JPEG, PNG or WebP of at most 2 MiB, and remembers a refusal briefly', async () => {
  const cases = [
    [{ status: 200, body: SVG }, 'not_an_image'],
    [{ status: 200, body: GIF }, 'not_an_image'],
    [{ status: 200, body: Buffer.from('<html>login</html>') }, 'not_an_image'],
    [{ status: 200, body: Buffer.alloc(0) }, 'size'],
    [{ status: 200, body: Buffer.concat([JPEG, Buffer.alloc(IMAGE_MAX_BYTES)]) }, 'size'],
    [{ status: 404, body: JPEG }, 'status'],
    [{ status: 301, body: JPEG, headers: { location: 'https://evil.example/' } }, 'status'],
    [{ throw: Object.assign(new Error(`refused ${IMAGE_URL}`), { code: 'PIVOTA_SSRF_REFUSED' }) }, 'PIVOTA_SSRF_REFUSED'],
    [{ throw: Object.assign(new Error('boom'), { code: 'not a code!' }) }, 'fetch_failed'],
  ];
  for (const [answer, reason] of cases) {
    const fetchImpl = stubFetch([answer, { status: 200, body: JPEG }]);
    let t = NOW;
    const f = createProductImageFetcher({ fetchImpl, now: () => t });
    assert.deepEqual(await f.get(IMAGE_URL), { ok: false, reason }, reason);
    await f.get(IMAGE_URL);
    assert.equal(fetchImpl.calls.length, 1, `${reason}: refusal cached`);
    t += IMAGE_REFUSAL_CACHE_MS + 1;
    assert.equal((await f.get(IMAGE_URL)).ok, true, `${reason}: asked again after the refusal cache`);
  }
});

test('at most IMAGE_MAX_IN_FLIGHT store fetches at once: one more is refused, never queued, and not cached', async () => {
  assert.equal(IMAGE_MAX_IN_FLIGHT, 8);
  const releases = [];
  const calls = [];
  const fetchImpl = (url) => new Promise((resolve) => {
    calls.push(url);
    releases.push(() => resolve(new Response(JPEG, { status: 200 })));
  });
  const f = createProductImageFetcher({ fetchImpl });
  const urls = Array.from({ length: IMAGE_MAX_IN_FLIGHT + 1 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
  const answers = urls.map((u) => f.get(u));
  assert.deepEqual(await answers[IMAGE_MAX_IN_FLIGHT], { ok: false, reason: 'busy' });
  assert.equal(calls.length, IMAGE_MAX_IN_FLIGHT);
  for (const r of releases) r();
  for (const a of answers.slice(0, IMAGE_MAX_IN_FLIGHT)) assert.equal((await a).ok, true);
  // The refused one was not cached: asked again once there is room.
  assert.equal((await Promise.race([f.get(urls[IMAGE_MAX_IN_FLIGHT]), new Promise((r) => setImmediate(() => r('pending')))])), 'pending');
  releases[releases.length - 1]();
  assert.equal(calls.length, IMAGE_MAX_IN_FLIGHT + 1);
});

test('a pending fetch is never evicted, so one URL is never fetched twice at once', async () => {
  let release;
  const calls = [];
  const fetchImpl = (url) => {
    calls.push(url);
    if (url === IMAGE_URL) return new Promise((resolve) => { release = () => resolve(new Response(JPEG, { status: 200 })); });
    return Promise.resolve(new Response(JPEG, { status: 200 }));
  };
  const f = createProductImageFetcher({ fetchImpl });
  const first = f.get(IMAGE_URL);
  for (let i = 0; i < IMAGE_CACHE_MAX_ENTRIES + 5; i += 1) await f.get(`https://cdn.example.com/fill-${i}.jpg`);
  const again = f.get(IMAGE_URL);
  release();
  assert.equal((await first).ok, true);
  assert.equal(await again, await first);
  assert.equal(calls.filter((u) => u === IMAGE_URL).length, 1);
});

test('the cached images stay within the byte budget: the oldest goes first', async () => {
  const fetchImpl = stubFetch(Array.from({ length: 6 }, () => ({ status: 200, body: JPEG })));
  const f = createProductImageFetcher({ fetchImpl, maxCacheBytes: JPEG.length * 2 });
  for (const n of [1, 2, 3]) await f.get(`https://cdn.example.com/${n}.jpg`);
  assert.equal(fetchImpl.calls.length, 3);
  await f.get('https://cdn.example.com/3.jpg');
  await f.get('https://cdn.example.com/2.jpg');
  assert.equal(fetchImpl.calls.length, 3, 'the two newest are still cached');
  await f.get('https://cdn.example.com/1.jpg');
  assert.equal(fetchImpl.calls.length, 4, 'the oldest was evicted');
});

test('the fetcher without a fetch refuses; a timeout is its own reason', async () => {
  assert.deepEqual(await createProductImageFetcher({}).get(IMAGE_URL), { ok: false, reason: 'no_fetch' });
  const slow = async (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const f = createProductImageFetcher({ fetchImpl: slow, timeoutMs: 5 });
  assert.deepEqual(await f.get(IMAGE_URL), { ok: false, reason: 'timeout' });
});

// ---- the route -----------------------------------------------------------------------------------------------

test('the route answers the bytes of the image the backend named, as the sniffed type, with locked-down headers', async () => {
  const rd = reader();
  const img = fetcher({ ok: true, type: 'image/webp', body: WEBP });
  const res = await get(app({ rd, img }), IMAGE_PATH, { 'X-Agenpas-Link': token() });
  assert.equal(res.status, 200);
  assert.ok(res.body.equals(WEBP));
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.deepEqual(img.calls, [IMAGE_URL]);
  assert.equal(rd.calls.length, 1);
});

test('the route never takes a URL from the request', async () => {
  const img = fetcher();
  const res = await get(app({ img }), `${IMAGE_PATH}?url=https://evil.example/x.jpg&u=https://evil.example/y.jpg`, {
    'X-Agenpas-Link': token(), 'X-Image-Url': 'https://evil.example/z.jpg', Referer: 'https://evil.example/',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(img.calls, [IMAGE_URL]);
});

test('no image named, a URL that is not clean, a detail-only URL or a failed fetch: 404 no_image', async () => {
  const purchases = [
    body(),
    body({ product_image_url: 'http://cdn.example.com/a.jpg' }),
    body({ product_image_url: 'https://10.0.0.1/a.jpg' }),
    { ...body(), detail: { ...body().detail, product_image_url: IMAGE_URL } },
  ];
  for (const purchase of purchases) {
    const img = fetcher();
    const res = await get(app({ rd: reader(purchase), img }), IMAGE_PATH, { 'X-Agenpas-Link': token() });
    assert.equal(res.status, 404);
    assert.deepEqual(json(res), { error: 'no_image' });
    assert.equal(img.calls.length, 0);
  }
  for (const answer of [{ ok: false, reason: 'not_an_image' }, () => { throw new Error('boom'); }]) {
    const res = await get(app({ img: fetcher(answer) }), IMAGE_PATH, { 'X-Agenpas-Link': token() });
    assert.equal(res.status, 404);
    assert.deepEqual(json(res), { error: 'no_image' });
  }
  const noFetcher = express();
  noFetcher.use(createAgenpasRouter({ reader: reader(), env: ENV_ON, now: () => NOW }));
  assert.equal((await get(noFetcher, IMAGE_PATH, { 'X-Agenpas-Link': token() })).status, 404);
});

test('the link token: missing, for another purchase or forged is 404, expired is 410; nothing is read or fetched', async () => {
  const rd = reader();
  const img = fetcher();
  const a = app({ rd, img });
  assert.equal((await get(a, IMAGE_PATH)).status, 404);
  assert.equal((await get(a, IMAGE_PATH, { 'X-Agenpas-Link': token({ purchaseId: 'ap_ffffffffffffffffffffffff' }) })).status, 404);
  assert.equal((await get(a, IMAGE_PATH, { 'X-Agenpas-Link': `${token()}x` })).status, 404);
  assert.equal((await get(a, `${IMAGE_PATH}?t=${token()}`)).status, 404);
  const expired = await get(a, IMAGE_PATH, { 'X-Agenpas-Link': token({ now: NOW - 60 * 60 * 1000 }) });
  assert.equal(expired.status, 410);
  assert.equal((await get(a, '/agenpas/api/p/ap_xyz/image', { 'X-Agenpas-Link': token() })).status, 404);
  assert.deepEqual([rd.calls.length, img.calls.length], [0, 0]);
});

test('its own per-token bucket, and the IP bucket first', async () => {
  const link = token();  // ONE link: each mint carries its own nonce, so its own bucket
  const a = app({ limits: { image: { capacity: 1, refillPerSecond: 0.0001 } } });
  assert.equal((await get(a, IMAGE_PATH, { 'X-Agenpas-Link': link })).status, 200);
  const second = await get(a, IMAGE_PATH, { 'X-Agenpas-Link': link });
  assert.equal(second.status, 429);
  assert.equal(second.headers['retry-after'], '2');
  // The image bucket is not the read's: the page's polls go on.
  const b = app({ limits: { image: { capacity: 1, refillPerSecond: 0.0001 } } });
  await get(b, IMAGE_PATH, { 'X-Agenpas-Link': link });
  assert.equal((await get(b, `/agenpas/api/p/${PID}`, { 'X-Agenpas-Link': link })).status, 200);
  const img = fetcher();
  const c = app({ img, limits: { ip: { capacity: 1, refillPerSecond: 0.0001 } } });
  await get(c, IMAGE_PATH, { 'X-Agenpas-Link': token() });
  assert.equal((await get(c, IMAGE_PATH)).status, 429, 'IP bucket before the token check');
});

test('flag off: the image path is not ours', async () => {
  for (const env of [{}, { ...ENV_ON, AGENPAS_ENABLED: '' }]) {
    const img = fetcher();
    const res = await get(app({ env, img }), IMAGE_PATH, { 'X-Agenpas-Link': token() });
    assert.equal(res.status, 404);
    assert.equal(json(res).error, 'NOT_FOUND');
    assert.equal(img.calls.length, 0);
  }
});

test('the host guard admits the image path and nothing around it', async () => {
  const a = app({ guard: true });
  assert.equal((await get(a, IMAGE_PATH, { 'X-Agenpas-Link': token() })).status, 200);
  const ok = await get(a, IMAGE_PATH, { 'X-Agenpas-Link': token() });
  assert.equal(ok.headers['x-agenpas-guard'], undefined);
  for (const p of [`${IMAGE_PATH}/x`, `/agenpas/api/p/${PID}/image.jpg`, `/agenpas/api/p/${PID}/%69mage`,
    `/agenpas/api/p/${PID}//image`, `/x/agenpas/api/p/${PID}/image`, `/agenpas/api/p/${PID}/imagex`]) {
    const res = await get(a, p, { 'X-Agenpas-Link': token() });
    assert.equal(res.status, 404, p);
    assert.equal(res.headers['x-agenpas-guard'], 'front', p);  // refused by the host guard itself
  }
});

test('the page JSON says only that there is an image: never the store URL', async () => {
  const res = await get(app(), `/agenpas/api/p/${PID}`, { 'X-Agenpas-Link': token() });
  assert.equal(res.status, 200);
  const view = json(res);
  assert.equal(view.product_image, true);
  assert.ok(!res.body.toString('utf8').includes('cdn.example.com'));
  for (const purchase of [body(), body({ product_image_url: 'http://cdn.example.com/a.jpg' }),
    { ...body(), detail: { ...body().detail, product_image_url: IMAGE_URL } }]) {
    const r = await get(app({ rd: reader(purchase) }), `/agenpas/api/p/${PID}`, { 'X-Agenpas-Link': token() });
    assert.equal(json(r).product_image, undefined);
  }
});
