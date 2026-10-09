// The storefront product-page check: only SHOPIFY may say a product page is gone.
//
// Each rule here, flipped, either keeps serving a removed product as in stock (judydoll "Sheer Tinted Highlighter",
// 2026-10-09) or hides a live one because a CDN answered 404 to an unfamiliar client.
const test = require('node:test');
const assert = require('node:assert/strict');
const page = require('../src/services/storefrontProductPage');

const shopify404 = (status = 404, extra = {}) => new Response('{"errors":"Not Found"}', {
  status, headers: { 'powered-by': 'Shopify', server: 'cloudflare', ...extra },
});
const liveBody = { product: { variants: [{ id: 49869804110101, price: '12.99' }, { id: 49869804077333, price: '12.99' }] } };
const live200 = () => new Response(JSON.stringify(liveBody), { status: 200, headers: { 'powered-by': 'Shopify' } });

test.beforeEach(() => page.resetForTests());

test('a 404 or 410 is gone only when Shopify itself served it', () => {
  assert.equal(page.shopifySaysGone(shopify404()), true);
  assert.equal(page.shopifySaysGone(shopify404(410)), true);
  assert.equal(page.shopifySaysGone(new Response('', { status: 404, headers: { 'x-shopid': '64012845205' } })), true);
  // a CDN or WAF 404 that never reached the store
  assert.equal(page.shopifySaysGone(new Response('', { status: 404, headers: { server: 'AkamaiNetStorage' } })), false);
  // a Cloudflare challenge is never evidence, whatever else it carries
  assert.equal(page.shopifySaysGone(shopify404(404, { 'cf-mitigated': 'challenge' })), false);
  // the store refusing or failing is not the product being gone
  assert.equal(page.shopifySaysGone(shopify404(403)), false);
  assert.equal(page.shopifySaysGone(shopify404(429)), false);
  assert.equal(page.shopifySaysGone(shopify404(503)), false);
  assert.equal(page.shopifySaysGone(live200()), false);
  // a non-numeric x-shopid, or a header that merely mentions shopify inside a word, is not the stamp
  assert.equal(page.shopifySaysGone(new Response('', { status: 404, headers: { 'x-shopid': 'none' } })), false);
  assert.equal(page.shopifySaysGone(new Response('', { status: 404, headers: { 'powered-by': 'notshopifyish' } })), false);
  // a plain header object (a test double, or a non-fetch client) reads the same way
  assert.equal(page.shopifySaysGone({ status: 404, headers: { 'powered-by': 'Shopify' } }), true);
  assert.equal(page.shopifySaysGone(null), false);
});

test('only https://<host>/products/<handle> is a product page', () => {
  assert.deepEqual(page.productPageOf('https://judydoll.com/products/sheer-tinted-highlighter?variant=1&utm_source=pivota'), {
    host: 'judydoll.com', handle: 'sheer-tinted-highlighter',
    jsonUrl: 'https://judydoll.com/products/sheer-tinted-highlighter.json',
  });
  assert.equal(page.productPageOf('http://judydoll.com/products/x'), null);
  assert.equal(page.productPageOf('https://u:p@judydoll.com/products/x'), null);
  assert.equal(page.productPageOf('https://fentybeauty.com/en-nl/collections/skincare-lip'), null);
  assert.equal(page.productPageOf('https://fentybeauty.com/en-nl/products/x'), null);
  assert.equal(page.productPageOf('not a url'), null);
});

test('a gone page is read once, remembered, and served from memory to every caller', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(url, 'https://gone.example/products/removed.json');
    assert.equal(init.redirect, 'error');
    return shopify404();
  };
  const first = await page.readStorefrontProductPage('https://gone.example/products/removed?variant=7', { fetchImpl });
  assert.equal(first.state, 'gone');
  assert.equal(first.reason, 'http_404');
  assert.equal(first.host, 'gone.example');
  assert.equal(first.handle, 'removed');
  const second = await page.readStorefrontProductPage('https://gone.example/products/removed', { fetchImpl });
  assert.equal(second.state, 'gone');
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
  assert.deepEqual(page.knownGone('https://gone.example/products/removed.json'), { status: 404 });
});

test('the gone verdict expires after the TTL', async () => {
  let t = 1_000_000;
  const now = () => t;
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return calls === 1 ? shopify404() : live200(); };
  assert.equal((await page.readStorefrontProductPage('https://ttl.example/products/a', { fetchImpl, now })).state, 'gone');
  t += page.TTL_MS + 1;
  assert.equal((await page.readStorefrontProductPage('https://ttl.example/products/a', { fetchImpl, now })).state, 'live');
  assert.equal(calls, 2);
});

test('a live page carries its variant ids and is remembered', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return live200(); };
  const first = await page.readStorefrontProductPage('https://live.example/products/a', { fetchImpl });
  assert.equal(first.state, 'live');
  assert.deepEqual([...first.variantIds].sort(), ['49869804077333', '49869804110101']);
  const second = await page.readStorefrontProductPage('https://live.example/products/a', { fetchImpl });
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
});

test('every failure to look is unknown, never gone, and is not remembered', async () => {
  const cases = [
    [async () => new Response('', { status: 404, headers: { server: 'AkamaiNetStorage' } }), 'http_404'],
    [async () => shopify404(404, { 'cf-mitigated': 'challenge' }), 'http_404'],
    [async () => shopify404(503), 'http_503'],
    [async () => { throw new Error('ECONNRESET'); }, 'network_error'],
    [async () => new Response('<html>', { status: 200 }), 'invalid_json'],
    [async () => new Response('{"product":{}}', { status: 200 }), 'no_variants'],
  ];
  for (const [fetchImpl, reason] of cases) {
    const url = `https://unknown.example/products/${reason.replace(/_/g, '-')}`;
    const got = await page.readStorefrontProductPage(url, { fetchImpl });
    assert.equal(got.state, 'unknown', reason);
    assert.equal(got.reason, reason);
    assert.equal(page.knownGone(page.productPageOf(url).jsonUrl), null, `${reason} must not be remembered as gone`);
  }
});

test('a read that does not answer in time is unknown, and the fetch is aborted', async () => {
  let aborted = false;
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  });
  const got = await page.readStorefrontProductPage('https://slow.example/products/a', { fetchImpl, timeoutMs: 20 });
  assert.equal(got.state, 'unknown');
  assert.equal(got.reason, 'timeout');
  assert.equal(aborted, true);
});

test('a URL that is not a product page is unknown without any request', async () => {
  const got = await page.readStorefrontProductPage('https://fentybeauty.com/en-nl/collections/x', {
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.deepEqual(got, { state: 'unknown', reason: 'not_a_product_page' });
});
