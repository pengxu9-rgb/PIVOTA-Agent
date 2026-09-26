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

// ---- the batch: N DISTINCT products must not serialise N deadlines ---------------------------------------

/** A read whose product id and pdp url vary, so each cart line is a genuinely distinct product. */
function seedReadFor(pid) {
  return {
    product: {
      product_id: pid,
      title: `Product ${pid}`,
      destination_url: `https://www.murad.com/products/${pid}`,
      purchase_grain: 'variant',
      variants: [{ variant_id: pid }],
    },
  };
}

test('merchant lookups for DISTINCT products run concurrently, not one after another', async () => {
  // Before this, the loop asked the storefront per item, so 8 distinct products cost 8 lookups end to end.
  // Each lookup here takes 60ms; serial would be ~480ms, batched at concurrency 6 is ~120ms. Asserting the
  // OVERLAP rather than a wall-clock ceiling keeps the test honest on a loaded CI box.
  let inFlight = 0;
  let maxInFlight = 0;
  const pids = Array.from({ length: 8 }, (_, i) => `sig_p${i}`);
  const resolve = createDefaultVariantResolver({
    executor: { execute: async (_op, { payload }) => seedReadFor(payload.product.product_id) },
    sourceMerchantVariants: async (_raw, pid) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 60));
      inFlight -= 1;
      return [`gid://shopify/ProductVariant/${pid.slice(-1)}`];
    },
  });
  const items = pids.map((pid) => ({ product_id: pid, quantity: 1 }));
  await resolve(items, undefined, {});
  assert.ok(maxInFlight > 1, `merchant lookups must overlap (max in flight was ${maxInFlight})`);
  for (const it of items) assert.match(it.variant_id, /^gid:\/\/shopify\/ProductVariant\/\d$/);
});

test('a storefront that hangs cannot stall intake past the batch deadline', async () => {
  // The whole point of moving the lookups under `withDeadline`: a hanging merchant used to add its full
  // timeout PER PRODUCT, after the batch deadline for our own reads had already resolved.
  const pids = Array.from({ length: 6 }, (_, i) => `sig_h${i}`);
  const resolve = createDefaultVariantResolver({
    executor: { execute: async (_op, { payload }) => seedReadFor(payload.product.product_id) },
    timeoutMs: 120,
    sourceMerchantVariants: () => new Promise(() => {}), // never settles
  });
  const items = pids.map((pid) => ({ product_id: pid, quantity: 1 }));
  // WHY THE KEEP-ALIVE. `withDeadline`'s timer is unref'd BY DESIGN — its own note says "a refusal timer
  // must not be a reason to stay up" — so it does not hold the event loop open. A live server always has an
  // HTTP listener doing that; a bare test process does not, and this source never settles, so without an
  // explicit handle the loop drains before the deadline fires and node:test reports "Promise resolution is
  // still pending but the event loop has already resolved" (which is exactly what CI saw). Supplying the
  // liveness a server would have keeps this a test of the DEADLINE rather than of the runner's own handles.
  // Measured in a bare child process (not inferred): no keep-alive -> the process exits with NO result;
  // with one -> REFUSED at ~125ms against a 120ms deadline.
  //
  // WHAT THIS DOES AND DOES NOT GUARANTEE, since the distinction is the whole point: a source that never
  // settles AND never honours abort is a worse case than anything shipped — merchantVariantSource bounds
  // itself with its OWN ref'd timer (deliberately not unref'd, #2117), so it always settles and production
  // cannot hang here. This test pins the SECOND bound, the resolver-level deadline, which only holds while
  // something keeps the loop alive. If anyone ever unrefs the source's timer, that first guarantee goes and
  // this test would still pass — so the source's timer has its own child-process test next door.
  const keepAlive = setInterval(() => {}, 20);
  let reason;
  let elapsed;
  try {
    const startedAt = Date.now();
    reason = await refusalOf(resolve(items, undefined, {}));
    elapsed = Date.now() - startedAt;
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(reason, 'no_real_variant_identity', 'a hanging storefront still fails closed');
  assert.ok(elapsed < 1500, `intake must be bounded by ONE deadline, not one per product (took ${elapsed}ms)`);
});

test('the batch runs BEFORE the item loop — no storefront call happens inside it', async () => {
  // Ordering matters for the money path: a network call inside the loop is a per-item cost that no deadline
  // above it bounds.
  //
  // OBSERVE THE RIGHT THING. A first version recorded the lookup SEQUENCE, which is identical whether the
  // lookups are batched or made per item — a reviewer proved it vacuous by reverting the batch and watching
  // the assertion still pass. The discriminating observation is how many variant_ids have already been
  // WRITTEN when each lookup runs: batched -> [0, 0] (nothing decided yet), in-loop -> [0, 1] (item 1 was
  // resolved before item 2 was looked up).
  const items = [{ product_id: 'sig_a1', quantity: 1 }, { product_id: 'sig_b2', quantity: 1 }];
  const writtenAtLookup = [];
  const resolve = createDefaultVariantResolver({
    executor: { execute: async (_op, { payload }) => seedReadFor(payload.product.product_id) },
    sourceMerchantVariants: async (_raw, pid) => {
      writtenAtLookup.push(items.filter((it) => it.variant_id).length);
      return [`gid://shopify/ProductVariant/${pid.slice(-1)}`];
    },
  });
  await resolve(items, undefined, {});
  assert.deepEqual(writtenAtLookup, [0, 0],
    'every lookup must run before ANY variant is written — a non-zero entry means a lookup happened inside the loop');
});

test('the source is HANDED an abort signal (threading; today\'s source does not read it)', async () => {
  let sawSignal = false;
  const resolve = createDefaultVariantResolver({
    executor: { execute: async (_op, { payload }) => seedReadFor(payload.product.product_id) },
    sourceMerchantVariants: async (_raw, pid, ctx) => {
      sawSignal = Boolean(ctx && ctx.signal && typeof ctx.signal.aborted === 'boolean');
      return [`gid://shopify/ProductVariant/${pid.slice(-1)}`];
    },
  });
  await resolve([{ product_id: 'sig_z9', quantity: 1 }], undefined, {});
  // Stated as narrowly as it is true: the shipped merchantVariantSource takes (productRead, product_id) and
  // ignores ctx entirely. This pins the THREADING so a future source can stop early; it does not claim
  // today's source honours it.
  assert.equal(sawSignal, true, 'ctx.signal is threaded through to the source');
});
