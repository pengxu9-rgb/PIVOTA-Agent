// The NATIVE /mcp door's storefront rows: a kernel failure for a seller Pivota is not connected to is renamed, by
// name and terminally, instead of reaching the agent as a retriable MERCHANT_UNAVAILABLE ("try again shortly").
//
// Pinned here:
//   - only AFTER the kernel failed with MERCHANT_UNAVAILABLE: a checkout that prices pays no extra read, and an
//     explicit variant_id still costs none;
//   - the row is read AS THE QUOTE'S MERCHANT SELLS IT (scoped), never the canonical PDP of another seller;
//   - only a storefront row is renamed; contracted rows, a failed read, and every other error keep the kernel's own
//     error unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PivotaCommerceError } from '../../safety-kernel/src/errors.js';
import { createCommerceToolSurface, ucpDialectSurface, toToolError } from '../src/commerceToolSurface.js';

const SESSION = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
const SEED = Object.freeze({
  product_id: 'sig_seed_a', title: 'Vitamin C Serum', price: 131, currency: 'USD', merchant_id: 'merch_obs_5a99644d0e8fbed5',
  external_redirect_url: 'https://comfortzone.us/products/vitamin-c-serum',
  variants: [{ variant_id: '44012345678901' }],
});
const CONTRACTED = Object.freeze({ product_id: 'p_shop_1', title: 'Shop Serum', price: 20, currency: 'USD', merchant_id: 'merchant_shop', variants: [{ variant_id: '48930014462260' }] });

/**
 * An executor whose kernel op throws `kernelError` (or succeeds), and whose product reads answer by
 * `${merchant_id}|${product_id}` (scoped) or `product_id` (unscoped) — so a test can make the two disagree.
 */
function executorWith({ rows, kernelError, readThrows = false }) {
  const seen = [];
  return {
    seen,
    async execute(op, params) {
      seen.push({ op, params: structuredClone(params) });
      if (op === 'get_product') {
        if (readThrows) throw new Error('upstream down');
        const p = params.payload.product;
        const row = rows[p.merchant_id ? `${p.merchant_id}|${p.product_id}` : p.product_id];
        return row ? { product: structuredClone(row) } : { product: null };
      }
      if (kernelError) throw kernelError;
      return { session_id: 'q_kernel' };
    },
  };
}
const unavailable = () => new PivotaCommerceError('MERCHANT_UNAVAILABLE', { operation: 'create_checkout_session', upstream_status: 422 });
const createArgs = (merchant_id, product_id, variant_id) => ({
  idempotency_key: 'idem-native-0001',
  quote: { merchant_id, items: [{ product_id, quantity: 1, ...(variant_id ? { variant_id } : {}) }], customer_email: 'shopper@example.test' },
});
const rejected = (p) => p.then(() => null, (e) => e);

test('a storefront row the kernel cannot price: renamed to the terminal storefront refusal, read AS THAT MERCHANT', async () => {
  const executor = executorWith({ rows: { [`${SEED.merchant_id}|${SEED.product_id}`]: SEED, [SEED.product_id]: SEED }, kernelError: unavailable() });
  const err = await rejected(createCommerceToolSurface(executor, { cache: false }).callTool('create_checkout_session', createArgs(SEED.merchant_id, SEED.product_id), SESSION));
  assert.equal(err.code, 'OPERATION_NOT_ALLOWED');
  assert.equal(err.retriable, false);
  assert.equal(err.detail.acp_detail.reason, 'ucp_storefront_checkout_unavailable');
  assert.deepEqual(err.detail.acp_detail.seller_hosts, ['comfortzone.us']);
  const wire = JSON.parse(toToolError(err).content[0].text).error;
  assert.equal(wire.retriable, false);
  assert.match(wire.message, /Retrying will not change this/);
  const reads = executor.seen.filter((c) => c.op === 'get_product').map((c) => c.params.payload.product);
  assert.ok(reads.length >= 1);
  assert.ok(reads.every((p) => p.merchant_id === SEED.merchant_id), 'every read is scoped to the quote merchant');
});

test('update_checkout_session is renamed the same way', async () => {
  const executor = executorWith({ rows: { [`${SEED.merchant_id}|${SEED.product_id}`]: SEED }, kernelError: unavailable() });
  const err = await rejected(createCommerceToolSurface(executor, { cache: false }).callTool('update_checkout_session', { ...createArgs(SEED.merchant_id, SEED.product_id, '44012345678901'), session_id: 'q_kernel' }, SESSION));
  assert.equal(err.detail?.acp_detail?.reason, 'ucp_storefront_checkout_unavailable');
});

test("the SCOPED read decides: a product whose canonical PDP is a storefront but which THIS merchant sells keeps the kernel's error", async () => {
  const original = unavailable();
  const executor = executorWith({ rows: { [SEED.product_id]: SEED, [`merchant_shop|${SEED.product_id}`]: { ...CONTRACTED, product_id: SEED.product_id } }, kernelError: original });
  const err = await rejected(createCommerceToolSurface(executor, { cache: false }).callTool('create_checkout_session', createArgs('merchant_shop', SEED.product_id, '48930014462260'), SESSION));
  assert.equal(err, original, 'the very same error object, unchanged');
});

test("contracted rows, a failed read, and every other kernel error keep the kernel's own error", async () => {
  const cases = [
    ['contracted row', { rows: { [`merchant_shop|${CONTRACTED.product_id}`]: CONTRACTED }, kernelError: unavailable() }, ['merchant_shop', CONTRACTED.product_id, '48930014462260']],
    ['read fails', { rows: {}, kernelError: unavailable(), readThrows: true }, [SEED.merchant_id, SEED.product_id, '44012345678901']],
  ];
  for (const [label, setup, args] of cases) {
    const executor = executorWith(setup);
    const err = await rejected(createCommerceToolSurface(executor, { cache: false }).callTool('create_checkout_session', createArgs(...args), SESSION));
    assert.equal(err, setup.kernelError, label);
  }
  const stock = new PivotaCommerceError('OUT_OF_STOCK', {});
  const executor = executorWith({ rows: { [`${SEED.merchant_id}|${SEED.product_id}`]: SEED }, kernelError: stock });
  const err = await rejected(createCommerceToolSurface(executor, { cache: false }).callTool('create_checkout_session', createArgs(SEED.merchant_id, SEED.product_id, '44012345678901'), SESSION));
  assert.equal(err, stock);
  assert.equal(executor.seen.some((c) => c.op === 'get_product'), false, 'no read for an error that is not MERCHANT_UNAVAILABLE');
});

test('a checkout that prices pays NO extra read (an explicit variant_id still costs none)', async () => {
  const executor = executorWith({ rows: { [`${SEED.merchant_id}|${SEED.product_id}`]: SEED } });
  const out = await createCommerceToolSurface(executor, { cache: false }).callTool('create_checkout_session', createArgs(SEED.merchant_id, SEED.product_id, '44012345678901'), SESSION);
  assert.equal(out.session_id, 'q_kernel');
  assert.deepEqual(executor.seen.map((c) => c.op), ['create_checkout_session']);
});

test('the UCP door is untouched by this path (it refuses storefront rows BEFORE the kernel)', async () => {
  const contracted = executorWith({ rows: { [CONTRACTED.product_id]: CONTRACTED }, kernelError: unavailable() });
  const err = await rejected(ucpDialectSurface(createCommerceToolSurface(contracted, { cache: false })).callTool('create_checkout', {
    meta: { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' }, 'idempotency-key': 'idem-ucp-0001' },
    checkout: { line_items: [{ item: { id: CONTRACTED.product_id }, quantity: 1 }], buyer: { email: 'shopper@example.test' } },
  }, SESSION));
  assert.equal(err.code, 'MERCHANT_UNAVAILABLE', 'a contracted UCP row keeps the kernel error');
});
