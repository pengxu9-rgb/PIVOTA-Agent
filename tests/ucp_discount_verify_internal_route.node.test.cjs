/**
 * POST /internal/ucp/discount-code/verify — the handler (src/services/ucpDiscountVerifyInternalRoute.js).
 * Pinned: dark unless flag AND key; X-Internal-Key compared in constant time; strict body; the input check runs
 * before the verifier; the mapped arguments reach the verifier exactly; the code never reaches the log.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = test;
const { createUcpDiscountVerifyInternalHandler } = require('../src/services/ucpDiscountVerifyInternalRoute');

const KEY = 'k_internal_verify_fixture';
const ENV = { UCP_DISCOUNT_VERIFY_ROUTE_ENABLED: '1', UCP_DISCOUNT_VERIFY_INTERNAL_KEY: KEY };
const BODY = { seller_host: 'brand.example', variant_gid: '44012345678901', market: 'US', code: 'Save10' };

function build({ env = ENV, verify, problem } = {}) {
  const calls = [];
  const logs = [];
  const handler = createUcpDiscountVerifyInternalHandler({
    env,
    verify: verify || (async (args) => { calls.push(args); return { result: 'applied', reason: null }; }),
    ...(problem ? { problem } : {}),
    logger: { info: (o) => logs.push(o) },
  });
  return { handler, calls, logs };
}
const auth = (k = KEY) => ({ 'x-internal-key': k });

describe('dark unless switched on and keyed', () => {
  for (const [label, env] of [
    ['flag off', { UCP_DISCOUNT_VERIFY_INTERNAL_KEY: KEY }],
    ['flag 0', { ...ENV, UCP_DISCOUNT_VERIFY_ROUTE_ENABLED: '0' }],
    ['no key', { UCP_DISCOUNT_VERIFY_ROUTE_ENABLED: '1' }],
    ['blank key', { ...ENV, UCP_DISCOUNT_VERIFY_INTERNAL_KEY: '   ' }],
  ]) {
    test(`${label}: 404 and the verifier never runs`, async () => {
      const { handler, calls } = build({ env });
      assert.deepEqual(await handler({ headers: auth(), body: BODY }), { status: 404, body: { error: 'not_found' } });
      assert.equal(calls.length, 0);
    });
  }
});

describe('auth', () => {
  for (const k of [undefined, '', 'wrong', `${KEY}x`, KEY.slice(1)]) {
    test(`key ${JSON.stringify(k)}: 401`, async () => {
      const { handler, calls } = build();
      assert.deepEqual(await handler({ headers: k === undefined ? {} : auth(k), body: BODY }), { status: 401, body: { error: 'unauthorized' } });
      assert.equal(calls.length, 0);
    });
  }
  test('the header is read whatever the case the transport hands over (lowercased by node)', async () => {
    const { handler } = build();
    assert.equal((await handler({ headers: { 'x-internal-key': [KEY] }, body: BODY })).status, 200);
  });
});

describe('strict body, checked before the verifier', () => {
  for (const [label, body, reason] of [
    ['not an object', null, 'body_not_object'],
    ['an array', [], 'body_not_object'],
    ['an unknown field', { ...BODY, email: 'a@b.example' }, 'unknown_field'],
    ['a bad discovery host', { ...BODY, discovery_host: '10.0.0.1' }, 'discovery_host_invalid'],
    ['a bad seller host', { ...BODY, seller_host: 'localhost' }, 'seller_host_invalid'],
    ['a code with invisible characters', { ...BODY, code: 'SAVE​10' }, 'code_invalid'],
    ['a lowercase market', { ...BODY, market: 'us' }, 'market_invalid'],
  ]) {
    test(`${label}: 400`, async () => {
      const { handler, calls } = build();
      const out = await handler({ headers: auth(), body });
      assert.equal(out.status, 400);
      assert.equal(out.body.reason, reason);
      assert.equal(calls.length, 0);
    });
  }
});

test('a valid call maps the body to the verifier and answers its result with 200', async () => {
  const { handler, calls } = build();
  const out = await handler({ headers: auth(), body: { ...BODY, discovery_host: 'www.brand.example', expected_currency: 'USD' } });
  assert.deepEqual(out, { status: 200, body: { result: 'applied', reason: null } });
  assert.deepEqual(calls, [{ sellerHost: 'brand.example', discoveryHost: 'www.brand.example', variantGid: '44012345678901', market: 'US', code: 'Save10', expectedCurrency: 'USD' }]);
});

test('the log carries the outcome, never the code or the variant', async () => {
  const { handler, logs } = build({ verify: async () => ({ result: 'rejected', reason: 'discount_code_invalid' }) });
  await handler({ headers: auth(), body: BODY });
  assert.equal(logs.length, 1);
  for (const [k, v] of Object.entries({ event: 'ucp_discount_verify', seller_host: 'brand.example', result: 'rejected', reason: 'discount_code_invalid' })) assert.equal(logs[0][k], v);
  const text = JSON.stringify(logs).toLowerCase();
  assert.equal(text.includes('save10'), false);
  assert.equal(text.includes('44012345678901'), false);
});
