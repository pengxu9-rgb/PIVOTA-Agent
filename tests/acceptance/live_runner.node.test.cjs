'use strict';

// Offline tests for scripts/acceptance/live_search_acceptance.cjs. No network: fetch is
// injected. The live runner is only worth running if its verdicts are right, and a runner
// that reports "found" for the wrong product -- or ignores the price -- would certify the
// exact failure Meitu reported.

const assert = require('node:assert/strict');
const test = require('node:test');

const live = require('../../scripts/acceptance/live_search_acceptance.cjs');
const cases = require('./cases.json');

const TARGET = cases.live_targets.acceptance_jsm_lip_pression_metal_serum_gloss;

function respond(body, status = 200) {
  return { status, text: async () => JSON.stringify(body) };
}

function fakeFetch({ restProducts, ucpProducts, merchantPrice = '28.80', resolve }) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    const u = String(url);
    if (u.startsWith('https://jsmbeauty.sg/')) {
      return respond({ product: { variants: [{ id: 50856826536257, price: merchantPrice, price_currency: 'SGD' }] } });
    }
    if (u.includes('/agent/v1/products/resolve')) return respond(resolve || { resolved: false, reason_code: 'NO_CANDIDATES', candidates: [] });
    if (u.includes('/agent/v1/beauty/products/search')) return respond({ products: restProducts, metadata: {} });
    return respond({ result: { content: [{ text: JSON.stringify({ products: ucpProducts }) }] } });
  };
  fn.calls = calls;
  return fn;
}

const JSM_REST = { title: 'LIP-PRESSION Metal Serum Gloss', price: 28.8, currency: 'SGD', destination_url: 'https://jsmbeauty.sg/products/lip-pression-metal-serum-gloss' };
const JSM_UCP = { title: 'LIP-PRESSION Metal Serum Gloss', url: 'https://agent.pivota.cc/products/sig_x', variants: [{ price: { amount: 2880, currency: 'SGD' } }] };
const VELY = { title: '[VELY VELY] Glass Skin Ampoule 40ml', url: 'https://agent.pivota.cc/products/sig_v', variants: [{ price: { amount: 2990, currency: 'SGD' } }] };

test('a product is matched by its title or merchant handle, never by a shared word', () => {
  assert.equal(live.matchesTarget(JSM_REST, TARGET), true);
  assert.equal(live.matchesTarget({ title: '[JUNGSAEMMOOL] LIP-PRESSION Metal Serum Gloss' }, TARGET), true);
  assert.equal(live.matchesTarget({ title: 'x', canonical_url: 'https://jsmbeauty.sg/products/lip-pression-metal-serum-gloss?variant=1' }, TARGET), true);
  assert.equal(live.matchesTarget({ title: 'Serum Gloss Face Oil' }, TARGET), false);
  assert.equal(live.matchesTarget(VELY, TARGET), false);
});

test('prices: UCP minor units, REST major units, currency mismatch and stale price all fail', () => {
  assert.deepEqual(live.servedPrice(JSM_UCP, 'ucp'), { amount: 28.8, currency: 'SGD' });
  assert.equal(live.servedPrice(JSM_REST, 'rest').amount, 28.8);
  const merchant = { amount: 28.8, currency: 'SGD' };
  assert.equal(live.comparePrice({ amount: 28.8, currency: 'SGD' }, merchant).ok, true);
  assert.equal(live.comparePrice({ amount: 28.2, currency: 'SGD' }, merchant).ok, false, 'the reported stale price');
  assert.equal(live.comparePrice({ amount: 28.8, currency: 'USD' }, merchant).ok, false);
  assert.equal(live.comparePrice(null, merchant).ok, false);
});

test('the reported state today: nothing found on either surface, and resolve empty -- known failures, no regressions', async () => {
  const fetchImpl = fakeFetch({ restProducts: [], ucpProducts: [VELY] });
  const report = await live.runLive({ fetchImpl, env: { PIVOTA_API_KEY: 'k' } });
  assert.ok(report.results.length > 0);
  assert.equal(report.results.every((r) => !r.pass), true);
  assert.deepEqual(report.regressions, []);
  assert.deepEqual(report.promotions, []);
});

test('live verdicts follow live.status, never the offline status', async () => {
  // Offline, #2213 made the brand cases pass the gate. That proves nothing about the deployed
  // gateway, so a live run that finds nothing must NOT report those cases as regressions.
  assert.ok(cases.cases.some((c) => c.live && c.status === 'pass' && c.live.status === 'known_fail'), 'premise');
  const report = await live.runLive({ fetchImpl: fakeFetch({ restProducts: [], ucpProducts: [] }), env: { PIVOTA_API_KEY: 'k' } });
  assert.deepEqual(report.regressions, []);
});

test('found on both surfaces at the merchant price: every case passes and is due for promotion', async () => {
  const fetchImpl = fakeFetch({ restProducts: [JSM_REST], ucpProducts: [JSM_UCP],
    resolve: { resolved: true, candidates: [{ title: 'LIP-PRESSION Metal Serum Gloss' }] } });
  const report = await live.runLive({ fetchImpl, env: { PIVOTA_API_KEY: 'k' } });
  assert.equal(report.results.every((r) => r.pass), true, JSON.stringify(report.results.filter((r) => !r.pass)));
  assert.equal(report.promotions.length, report.results.length);
});

test('found, but at the stale price: not a pass', async () => {
  const stale = Object.assign({}, JSM_REST, { price: 28.2 });
  const fetchImpl = fakeFetch({ restProducts: [stale], ucpProducts: [JSM_UCP] });
  const report = await live.runLive({ fetchImpl, env: { PIVOTA_API_KEY: 'k' } });
  const e2 = report.results.find((r) => r.id === 'meitu_e2_full_name');
  assert.equal(e2.surfaces.rest.found_in_top_n, true);
  assert.equal(e2.surfaces.rest.price_ok, false);
  assert.equal(e2.pass, false);
});

test('found only below top-N is not found', async () => {
  const filler = Array.from({ length: 6 }, (_, i) => ({ title: `Other ${i}`, price: 1, currency: 'SGD' }));
  const fetchImpl = fakeFetch({ restProducts: [...filler, JSM_REST], ucpProducts: [...filler, JSM_UCP] });
  const report = await live.runLive({ fetchImpl, env: { PIVOTA_API_KEY: 'k' } });
  const e2 = report.results.find((r) => r.id === 'meitu_e2_full_name');
  assert.equal(e2.top_n, 5);
  assert.equal(e2.surfaces.rest.rank, 7);
  assert.equal(e2.surfaces.rest.found_in_top_n, false);
});

test('resolve counts only when the gateway says resolved, not when a candidate merely mentions the product', async () => {
  const fetchImpl = fakeFetch({ restProducts: [], ucpProducts: [],
    resolve: { resolved: false, reason_code: 'AMBIGUOUS', candidates: [{ title: 'LIP-PRESSION Metal Serum Gloss' }] } });
  const report = await live.runLive({ fetchImpl, env: { PIVOTA_API_KEY: 'k' } });
  assert.equal(report.results.find((r) => r.id === 'meitu_e5_resolve_variant').pass, false);
});

test('the key is sent in headers and never in a URL', async () => {
  const fetchImpl = fakeFetch({ restProducts: [], ucpProducts: [] });
  await live.runLive({ fetchImpl, env: { PIVOTA_API_KEY: 'secret-key-value' } });
  assert.ok(fetchImpl.calls.length > 0);
  for (const call of fetchImpl.calls) assert.equal(call.url.includes('secret-key-value'), false, call.url);
  assert.equal(fetchImpl.calls.filter((c) => c.url.startsWith('https://jsmbeauty.sg/')).every((c) => !JSON.stringify(c.headers).includes('secret-key-value')), true,
    'the merchant never receives our key');
});
