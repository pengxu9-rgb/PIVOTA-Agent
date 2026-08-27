// The merchant-variant fallback in createDefaultVariantResolver.
//
// The seed cohort publishes only ids restated from the product id, so our own read can never resolve it and
// the resolver refuses `no_real_variant_identity`. A door may inject a source that asks the merchant's own
// storefront instead (src/services/merchantVariantSource.js). These tests pin the SAFETY properties of that
// hook, not its plumbing: a merchant answer earns exactly the same scrutiny our own catalog gets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultVariantResolver } from '../src/protocol/buyerIntake.js';

const PID = 'sig_seed_1';

// A read shaped like the seed lane's: pdpBuilder restates the product id as the variant id, and the row
// carries the merchant PDP url the fallback needs.
function seedRead({ variants = [{ variant_id: PID }], productGrain = false } = {}) {
  return {
    product: {
      product_id: PID,
      title: 'Deep Relief Acne Treatment',
      destination_url: 'https://www.murad.com/products/deep-relief-acne-treatment',
      purchase_grain: productGrain ? 'product' : 'variant',
      variants,
    },
  };
}

function executorReturning(read) {
  return { execute: async () => read };
}

async function refusalOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    // The resolver's own verdict lives in `variant_resolution`; `reason` is the door-level code shared by
    // every intake refusal, so asserting on it would not tell `ambiguous` from `no_real_variant_identity`.
    return err?.detail?.acp_detail?.variant_resolution || err?.detail?.reason || err?.message || 'unknown';
  }
}

test('a single real merchant variant resolves a row our own catalog could not', async () => {
  const seen = [];
  const resolve = createDefaultVariantResolver({
    executor: executorReturning(seedRead()),
    sourceMerchantVariants: async (raw, pid) => {
      seen.push({ pid, url: raw?.product?.destination_url });
      return ['gid://shopify/ProductVariant/51348961657135'];
    },
  });
  const items = [{ product_id: PID, quantity: 1 }];
  await resolve(items, undefined, {});
  assert.equal(items[0].variant_id, 'gid://shopify/ProductVariant/51348961657135');
  assert.deepEqual(seen, [{ pid: PID, url: 'https://www.murad.com/products/deep-relief-acne-treatment' }],
    'the raw read is handed to the source so it can reach the storefront without a second read');
});

test('a merchant answer is filtered exactly like our own — a restated product id is still refused', async () => {
  for (const forged of [PID, `${PID}-1`, `${PID}:default`]) {
    const resolve = createDefaultVariantResolver({
      executor: executorReturning(seedRead()),
      sourceMerchantVariants: async () => [forged],
    });
    const items = [{ product_id: PID, quantity: 1 }];
    assert.equal(await refusalOf(resolve(items, undefined, {})), 'no_real_variant_identity',
      `a storefront echoing ${forged} must not become a variant_id`);
    assert.equal(items[0].variant_id, undefined);
  }
});

test('two real merchant variants are AMBIGUOUS, never a guess', async () => {
  const resolve = createDefaultVariantResolver({
    executor: executorReturning(seedRead()),
    sourceMerchantVariants: async () => [
      'gid://shopify/ProductVariant/51348961657135',
      'gid://shopify/ProductVariant/51348961689903',
    ],
  });
  const items = [{ product_id: PID, quantity: 1 }];
  assert.equal(await refusalOf(resolve(items, undefined, {})), 'ambiguous');
  assert.equal(items[0].variant_id, undefined, 'a multi-variant product is never resolved to variants[0]');
});

test('FAIL CLOSED: a source that throws, times out, or answers empty leaves the original refusal', async () => {
  const answers = [
    () => { throw new Error('merchant down'); },
    async () => { throw new Error('async merchant down'); },
    async () => null,
    async () => [],
    async () => ['', '   '],
    async () => 'not-an-array',
  ];
  for (const sourceMerchantVariants of answers) {
    const resolve = createDefaultVariantResolver({
      executor: executorReturning(seedRead()),
      sourceMerchantVariants,
    });
    const items = [{ product_id: PID, quantity: 1 }];
    assert.equal(await refusalOf(resolve(items, undefined, {})), 'no_real_variant_identity');
    assert.equal(items[0].variant_id, undefined);
  }
});

test('the source is NEVER consulted when our own read already resolved a real variant', async () => {
  let calls = 0;
  const resolve = createDefaultVariantResolver({
    executor: executorReturning(seedRead({ variants: [{ variant_id: 'gid://shopify/ProductVariant/999' }] })),
    sourceMerchantVariants: async () => { calls += 1; return ['gid://shopify/ProductVariant/111']; },
  });
  const items = [{ product_id: PID, quantity: 1 }];
  await resolve(items, undefined, {});
  assert.equal(items[0].variant_id, 'gid://shopify/ProductVariant/999', 'our own real id wins');
  assert.equal(calls, 0, 'no network hop when the local read already answered');
});

test('the source is NEVER consulted for a product-grain row — that carve-out still resolves locally', async () => {
  let calls = 0;
  const resolve = createDefaultVariantResolver({
    executor: executorReturning(seedRead({ variants: [{ variant_id: PID }], productGrain: true })),
    sourceMerchantVariants: async () => { calls += 1; return ['gid://shopify/ProductVariant/111']; },
  });
  const items = [{ product_id: PID, quantity: 1 }];
  await resolve(items, undefined, {});
  assert.equal(items[0].variant_id, PID, 'product-grain rows keep resolving to the product id');
  assert.equal(calls, 0);
});

test('with NO source injected the behaviour is byte-identical to before', async () => {
  const resolve = createDefaultVariantResolver({ executor: executorReturning(seedRead()) });
  const items = [{ product_id: PID, quantity: 1 }];
  assert.equal(await refusalOf(resolve(items, undefined, {})), 'no_real_variant_identity');
});

test('ONE merchant lookup per distinct product, however many cart lines name it', async () => {
  // The delivery path resolves items in a SEQUENTIAL loop, so a source-side in-flight memo never hits here
  // (measured: 5 lines -> 5 calls). Deduplication has to live where the loop is — this pins the per-cart
  // bound the money path actually needs: a 50-line cart cannot buy 50 storefront round trips.
  const calls = [];
  const resolve = createDefaultVariantResolver({
    executor: executorReturning(seedRead()),
    sourceMerchantVariants: async (_raw, pid) => {
      calls.push(pid);
      return ['gid://shopify/ProductVariant/51348961657135'];
    },
  });
  const items = [
    { product_id: PID, quantity: 1 },
    { product_id: PID, quantity: 2 },
    { product_id: PID, quantity: 3 },
  ];
  await resolve(items, undefined, {});
  assert.deepEqual(calls, [PID], 'three lines naming one product cost ONE lookup');
  for (const it of items) assert.equal(it.variant_id, 'gid://shopify/ProductVariant/51348961657135');
});

test('a refusal is cached too — a storefront that could not answer is not re-asked per line', async () => {
  let calls = 0;
  const resolve = createDefaultVariantResolver({
    executor: executorReturning(seedRead()),
    sourceMerchantVariants: async () => { calls += 1; return null; },
  });
  const items = [{ product_id: PID, quantity: 1 }, { product_id: PID, quantity: 1 }];
  await refusalOf(resolve(items, undefined, {}));
  assert.equal(calls, 1, 're-asking a storefront that already declined multiplies the worst case');
});
