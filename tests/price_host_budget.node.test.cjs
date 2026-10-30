'use strict';

// THE MERCHANT POLITENESS BUDGET (src/services/priceHostBudget.js): 60 reads / min / host across the fleet as
// per-instance buckets of ceil(60 / PRICE_HOST_BUDGET_INSTANCES), a quarter kept for get_offers and the cart, and
// the fleet's shared backoff; PRICE_HOST_BUDGET off | shadow | on.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  budgetMode, perInstanceReadsPerMinute, createHostTokenBuckets, createHostReadGate, processHostReadGate, _resetForTest,
} = require('../src/services/priceHostBudget');

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
function clock() {
  let t = T0;
  return { now: () => t, add: (ms) => { t += ms; } };
}

test('PRICE_HOST_BUDGET: off unless shadow or on; per instance ceil(60 / instances), instances default 4', () => {
  assert.equal(budgetMode({}), 'off');
  assert.equal(budgetMode({ PRICE_HOST_BUDGET: ' ON ' }), 'on');
  assert.equal(budgetMode({ PRICE_HOST_BUDGET: 'shadow' }), 'shadow');
  assert.equal(budgetMode({ PRICE_HOST_BUDGET: 'enforce' }), 'off');
  assert.equal(perInstanceReadsPerMinute({}), 15);
  assert.equal(perInstanceReadsPerMinute({ PRICE_HOST_BUDGET_INSTANCES: '7' }), 9);
  assert.equal(perInstanceReadsPerMinute({ PRICE_HOST_BUDGET_INSTANCES: '1' }), 60);
  assert.equal(perInstanceReadsPerMinute({ PRICE_HOST_BUDGET_INSTANCES: '20' }), 3);
  for (const junk of ['0', '-3', 'x', '']) assert.equal(perInstanceReadsPerMinute({ PRICE_HOST_BUDGET_INSTANCES: junk }), 15, junk);
  assert.equal(perInstanceReadsPerMinute({ PRICE_HOST_BUDGET_INSTANCES: '100000' }), 1);
});

test('a bucket of 15: search, product and pdp reads stop at 11 (a quarter is kept); offers and cart may spend all 15', () => {
  const c = clock();
  const b = createHostTokenBuckets({ capacity: () => 15, now: c.now });
  let general = 0;
  while (b.take('shop.example.com', 'search')) general += 1;
  assert.equal(general, 11);
  assert.equal(b.take('shop.example.com', 'product'), false);
  assert.equal(b.take('shop.example.com', 'pdp'), false);
  let reserved = 0;
  while (b.take('shop.example.com', 'offers')) reserved += 1;
  assert.equal(reserved, 4, 'the reserved quarter is there for get_offers');
  assert.equal(b.take('shop.example.com', 'cart'), false, 'and then nothing is left');
  assert.equal(b.take('other.example.com', 'search'), true, 'per host');
});

test('the bucket refills continuously at its per-minute rate, never past its size', () => {
  const c = clock();
  const b = createHostTokenBuckets({ capacity: () => 15, now: c.now });
  while (b.take('shop.example.com', 'offers'));
  c.add(4000);
  assert.equal(b.take('shop.example.com', 'offers'), true, '4 s refills one token (15 a minute)');
  assert.equal(b.take('shop.example.com', 'offers'), false);
  c.add(60 * 60 * 1000);
  assert.ok(Math.abs(b.tokens('shop.example.com') - 15) < 1e-9);
  let n = 0;
  while (b.take('shop.example.com', 'offers')) n += 1;
  assert.equal(n, 15, 'an idle hour fills it once, not 60 times');
});

test('a refused take spends nothing', () => {
  const c = clock();
  const b = createHostTokenBuckets({ capacity: () => 15, now: c.now });
  for (let i = 0; i < 11; i += 1) b.take('shop.example.com', 'search');
  for (let i = 0; i < 50; i += 1) b.take('shop.example.com', 'search');
  let reserved = 0;
  while (b.take('shop.example.com', 'offers')) reserved += 1;
  assert.equal(reserved, 4);
});

function gate(env, { shared = () => false } = {}) {
  const c = clock();
  const lines = [];
  const g = createHostReadGate({ env: () => env, now: c.now, sharedBackedOff: shared, log: (e, f) => lines.push({ e, ...f }) });
  return { g, c, lines };
}

test('gate off: everything admitted, nothing counted (the shared backoff is not even asked)', () => {
  let asked = 0;
  const { g } = gate({}, { shared: () => { asked += 1; return true; } });
  for (let i = 0; i < 100; i += 1) assert.equal(g.admit('shop.example.com', 'search'), null);
  assert.equal(asked, 0);
  assert.ok(Math.abs(g.buckets.tokens('shop.example.com') - 15) < 1e-9, 'no token spent');
});

test('gate on: over the bucket -> host_budget; a backed-off host -> host_backoff, spending no token', () => {
  let backed = false;
  const { g } = gate({ PRICE_HOST_BUDGET: 'on' }, { shared: () => backed });
  const answers = Array.from({ length: 12 }, () => g.admit('shop.example.com', 'search'));
  assert.deepEqual(answers.slice(0, 11), Array(11).fill(null));
  assert.equal(answers[11], 'host_budget');
  assert.equal(g.admit('shop.example.com', 'offers'), null, 'offers still get the reserve');
  backed = true;
  const before = g.buckets.tokens('fresh.example.com');
  assert.equal(g.admit('fresh.example.com', 'offers'), 'host_backoff');
  assert.equal(g.buckets.tokens('fresh.example.com'), before);
  assert.equal(g.admit('', 'search'), null, 'no host: not the gate\'s to refuse');
});

test('gate shadow: admits everything, and once a minute logs what `on` would have refused, per host', () => {
  let backed = false;
  const { g, c, lines } = gate({ PRICE_HOST_BUDGET: 'shadow' }, { shared: (h) => backed && h === 'slow.example.com' });
  for (let i = 0; i < 14; i += 1) assert.equal(g.admit('shop.example.com', 'search'), null);
  backed = true;
  assert.equal(g.admit('slow.example.com', 'search'), null);
  assert.deepEqual(lines, [], 'not before a minute');
  c.add(60 * 1000);
  g.admit('quiet.example.com', 'search');
  assert.deepEqual(lines, [{ e: 'price_host_budget_shadow', would_refuse_budget: 3, would_refuse_backoff: 1, window_s: 60, hosts: { 'shop.example.com': 3, 'slow.example.com': 1 } }]);
  c.add(61 * 1000);
  g.admit('quiet.example.com', 'search');
  assert.equal(lines.length, 1, 'a quiet minute writes no line');
});

test('the gate never throws: a broken backoff check admits', () => {
  const { g } = gate({ PRICE_HOST_BUDGET: 'on' }, { shared: () => { throw new Error('boom'); } });
  assert.equal(g.admit('shop.example.com', 'search'), null);
});

test('the process gate: hosts are one key per store (www. folded), and it reads the env per call', () => {
  _resetForTest();
  const saved = process.env.PRICE_HOST_BUDGET;
  try {
    delete process.env.PRICE_HOST_BUDGET;
    const g = processHostReadGate();
    for (let i = 0; i < 20; i += 1) assert.equal(g.admit('www.shop.example.com', 'search'), null);
    process.env.PRICE_HOST_BUDGET = 'on';
    const seen = [];
    for (let i = 0; i < 6; i += 1) seen.push(g.admit('www.shop.example.com', 'search'), g.admit('SHOP.example.com.', 'search'));
    assert.deepEqual(seen.filter(Boolean), ['host_budget'], 'www. and the apex share one bucket of 11');
  } finally {
    if (saved === undefined) delete process.env.PRICE_HOST_BUDGET;
    else process.env.PRICE_HOST_BUDGET = saved;
    _resetForTest();
  }
});
