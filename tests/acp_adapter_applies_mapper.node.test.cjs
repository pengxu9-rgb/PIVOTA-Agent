'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// THE #1850 TRIPWIRE, AND IT HAS TO BE BEHAVIOURAL.
//
// The pipeline-invariant test in acp_feed_item pins that stage 1 emits no
// `link` — the PRECONDITION. Review showed that is not enough: replacing
// `acpRestAdapter.js`'s map with `const items = products;` — literally the
// #1850 proposal I had already written and backed out — left the entire
// node:test allowlist green, 121/121. The precondition was pinned; the pipeline
// was not.
//
// The only suite that caught it, `safety-kernel/test/acpRestAdapter.test.js`,
// runs in NO automatic CI: jest's testMatch is `**/tests/**` so `safety-kernel/
// test/` is invisible, and the one workflow that runs it is workflow_dispatch-
// only. A guard nobody runs is not a guard.
//
// safety-kernel is ESM; a dynamic import reaches it from a .cjs test.
test('the ACP adapter APPLIES mapFeedItem — skipping it publishes a linkless feed', async () => {
  const { createAcpRestAdapter } = await import('../safety-kernel/src/protocol/acpRestAdapter.js');

  const raw = { id: 'sig_abc', title: 'Rice 72 Serum', price: 10, currency: 'USD' };
  let mapperCalls = 0;
  const adapter = createAcpRestAdapter({
    executor: { execute: async () => ({}) },
    sessionStore: { get: async () => null, set: async () => {}, putIfAbsent: async () => true },
    resolveUserRef: () => 'u',
    signingSecret: 'test_secret_not_used_on_public_feed',
    publicFeed: true,
    getProducts: async () => [raw],
    mapFeedItem: (p) => { mapperCalls += 1; return { ...p, link: `https://agent.pivota.cc/products/${p.id}` }; },
  });

  const res = await adapter.productFeed({ headers: {}, body: {}, params: {} });
  assert.equal(res.status, 200);
  assert.equal(mapperCalls, 1, 'the adapter must call mapFeedItem once per product');
  assert.equal(res.body.count, 1);
  // The field the index lane cannot produce on its own. If this is absent, the
  // feed is publishing rows a crawler cannot follow — worse than the brand
  // override #1850 was filed about.
  assert.equal(res.body.products[0].link, 'https://agent.pivota.cc/products/sig_abc');
});

test('#1851 reaches defaultFeedItem too — the no-mapFeedItem path', () => {
  // `src/server.js` always passes `mapFeedItem`, so this branch is dead there —
  // but `safety-kernel/src/productionWiring.js:311` constructs the adapter with
  // NO mapper and lands here, and safety-kernel advertises itself as reused
  // verbatim by every adapter. A change titled "never publish a merchant id as
  // a brand" that left the identical line live one file over would be the same
  // per-consumer divergence ADR-012 names.
  //
  // Asserted on the SOURCE because `defaultFeedItem` is module-private; the
  // behavioural half is covered by the mapper test above.
  const src = require('node:fs').readFileSync(
    require.resolve('../safety-kernel/src/protocol/acpRestAdapter.js'), 'utf8');
  const fn = src.slice(src.indexOf('function defaultFeedItem'));
  assert.ok(fn.length > 0, 'could not locate defaultFeedItem');
  assert.ok(
    !/brand:\s*\(?o\.brand\s*\?\?\s*o\.merchant_id/.test(fn),
    'defaultFeedItem must not fall back to the merchant id either (#1851)',
  );
  assert.ok(/brand:\s*o\.brand\b/.test(fn), 'and must still emit the real brand');
});
