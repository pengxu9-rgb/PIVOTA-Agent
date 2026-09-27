'use strict';

// get_intel asked the KB for the wrong key whenever the product came in as a ref. Measured live
// 2026-09-27 (gateway bf6ae5adf) for a sig with grounded intel:
//   product_id:  "sig_4c9ed7dd…"                              → decision signal, kb_key product:sig_4c9ed7dd…
//   product_ref: "product:sig_4c9ed7dd…"                      → not_found, kb_key_count 1 (asked product:product:sig_…)
//   product_ref: "https://agent.pivota.cc/products/sig_4c9e…" → not_found, kb_key_count 1 (asked product:https://…)
// and a product_ref was never hydrated (identity resolution read product_id only).
//
// The KB below answers by EXACT key, as aurora_product_intel_kb does (kb_key = ANY($1)), and resolveKbKeys is
// composed exactly as the server wires it: identity resolver(intelIdentityProductId(p)) → buildIntelKbKeys.
// Run: node --test tests/get_intel_product_ref_keys.node.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeGetIntel, buildIntelKbKeys, intelIdentityProductId } = require('../src/agentSignals/intelligenceReads');

const SIG = 'sig_4c9ed7dd5d414c47c7ca8c37832a09c8';

function entry(kbKey) {
  return {
    kb_key: kbKey,
    source: 'pivota_grounded_synthesis_v1',
    last_success_at: '2026-06-15T06:14:48.039Z',
    analysis: {
      product_intel_v1: {
        contract_version: 'pivota.product_intel.v1',
        product_intel_core: {
          why_it_stands_out: [{ headline: 'Hyaluronic acid', body: 'Plumper, softer skin within hours.' }],
          best_for: [{ label: 'dehydration / dull look', tag: 'dehydration_dull_look' }],
          evidence_profile: 'grounded_verified',
        },
        provenance: { review_decision: 'pass', review_tier: 'grounded_pass' },
      },
    },
  };
}

function kb(keys) {
  const rows = new Map(keys.map((k) => [k, entry(k)]));
  const asked = [];
  return {
    asked,
    getProductIntelKbEntries: async (kbKeys) => {
      asked.push(...kbKeys);
      return new Map(kbKeys.filter((k) => rows.has(k)).map((k) => [k, rows.get(k)]));
    },
    getProductIntelKbEntry: async (k) => {
      asked.push(k);
      return rows.get(k) || null;
    },
  };
}

// The server's wiring, with the identity resolver injected.
function intelOver(store, resolveIdentity = async () => null) {
  const identityCalls = [];
  const handler = makeGetIntel({
    ...store,
    isEnabled: () => true,
    isReviewed: () => true,
    resolveKbKeys: async (p) => {
      const args = { product_id: intelIdentityProductId(p), merchant_id: p.merchant_id };
      identityCalls.push(args);
      return buildIntelKbKeys(p, await resolveIdentity(args));
    },
  });
  return { handler, identityCalls };
}

test('every form an agent holds for the product reaches the same KB entry as product_id', async () => {
  const forms = [
    { product_id: SIG },
    { product_ref: SIG },
    { product_ref: `product:${SIG}` }, // a get_alternatives related.ref
    { product_ref: `PRODUCT:${SIG}` },
    { product_ref: `https://agent.pivota.cc/products/${SIG}` }, // search_catalog pivota_canonical_url
    { product_ref: `https://agent.pivota.cc/products/${SIG}?ref=x` },
    { product_id: `product:${SIG}` }, // the related.ref passed as product_id
    { pivota_signature_id: SIG },
  ];
  for (const payload of forms) {
    const store = kb([`product:${SIG}`]);
    const { handler } = intelOver(store);
    const res = await handler({ payload });
    assert.equal(res.signals.length, 1, `form ${JSON.stringify(payload)}: ${JSON.stringify(res.metadata)}`);
    assert.equal(res.metadata.kb_key, `product:${SIG}`);
    for (const k of store.asked) {
      assert.ok(!/^product:(product:|https?:)/i.test(k), `form ${JSON.stringify(payload)} asked for ${k}`);
    }
  }
});

test('a product_ref is hydrated like product_id, so intel keyed on a grouped sibling is found', async () => {
  const store = kb(['product:ext_sibling_listing']);
  const { handler, identityCalls } = intelOver(store, async ({ product_id }) =>
    product_id === SIG ? { pivota_signature_id: SIG, member_source_ids: ['ext_sibling_listing'] } : null,
  );
  const res = await handler({ payload: { product_ref: `product:${SIG}`, merchant_id: 'm1' } });
  assert.deepEqual(identityCalls, [{ product_id: SIG, merchant_id: 'm1' }]);
  assert.equal(res.metadata.kb_key, 'product:ext_sibling_listing');
});

test('a merchant URL product_ref is looked up as the KB url: key it is stored under', async () => {
  const merchantUrl = 'https://www.ulta.com/p/baby-moisturizing-cream-pimprod2048029?sku=2632440';
  const store = kb([`url:${merchantUrl}`]);
  const res = await intelOver(store).handler({ payload: { product_ref: merchantUrl } });
  assert.equal(res.metadata.kb_key, `url:${merchantUrl}`);
  assert.deepEqual(buildIntelKbKeys({ product_ref: `url:${merchantUrl}` }), [`url:${merchantUrl}`]);
});

test('without an injected resolveKbKeys, the handler falls back to the same key builder', async () => {
  const store = kb([`product:${SIG}`]);
  const handler = makeGetIntel({ ...store, isEnabled: () => true, isReviewed: () => true });
  const res = await handler({ payload: { product_ref: `product:${SIG}` } });
  assert.equal(res.metadata.kb_key, `product:${SIG}`);
  assert.deepEqual(store.asked, [`product:${SIG}`]);
});

test('key shapes: a source id keeps its colon; a text: ref names no key; identity keys come first', () => {
  assert.deepEqual(buildIntelKbKeys({ product_id: 'ulta:211265214baf1dcd', pivota_signature_id: 'sig_07dc' }), [
    'product:sig_07dc',
    'product:ulta:211265214baf1dcd',
  ]);
  assert.deepEqual(buildIntelKbKeys({ product_ref: 'text:cerave:baby cream' }), []);
  assert.deepEqual(
    buildIntelKbKeys(
      { product_ref: SIG },
      { canonical_entity_id: 'pg_1', pivota_signature_id: SIG, member_sig_ids: ['sig_b'], member_source_ids: ['ext_c'], canonical_url: 'https://agent.pivota.cc/products/pg_1' },
    ),
    ['product:pg_1', `product:${SIG}`, 'product:sig_b', 'product:ext_c', 'url:https://agent.pivota.cc/products/pg_1'],
  );
  assert.equal(intelIdentityProductId({ product_ref: `https://agent.pivota.cc/products/${SIG}` }), SIG);
  assert.equal(intelIdentityProductId({ product_id: 'p1', product_ref: `product:${SIG}` }), 'p1', 'product_id wins');
  assert.equal(intelIdentityProductId({ product_ref: 'text:x' }), null);
});

test('only a text: ref → no_kb_keys, not a fabricated product: key', async () => {
  const store = kb([]);
  const res = await intelOver(store).handler({ payload: { product_ref: 'text:cerave:baby cream' } });
  assert.equal(res.metadata.reason, 'no_kb_keys');
  assert.deepEqual(store.asked, []);
});
