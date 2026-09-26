'use strict';

// ADR-009 task 4 — the PDP content-preservation gate follows the LANE, not the seller.
//
// `shouldPreserveExternalSeedPdpContent` (src/server.js) decides whether a
// seed-routed row's rich content survives the merge with the identity graph's
// synthetic product. It used to require `merchant_id === 'external_seed'`, and
// the A9-4 re-key made that permanently false: measured on prod 2026-08-17,
// 0 catalog rows carry the sentinel while 6,667 seed-routed rows (4,392 of them
// serving_eligible) sit under `merch_obs_*` sellers. So the gate was dead and
// rich seed content was being replaced wholesale.
//
// The fix routes it through pdpRenderability.isSeedRoutedLane — the SAME
// predicate that calls those rows renderable — so the two cannot drift again.
// That drift is what the long comment at the get_pdp_v2 entry predicted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isSeedRoutedLane } = require('../src/services/pdpRenderability');

const OBSERVED = 'merch_obs_7f3a2b1c9d4e5f60';

test('a re-keyed mirror row is the same lane as the sentinel row it used to be', () => {
  const shape = (merchantId) => ({
    merchantId,
    platform: 'external_seed',
    sourceSystem: 'external_product_seeds_mirror_v1',
    sourceProductId: 'ext_2fb1267c9f357b620bfccd1a',
  });
  assert.equal(isSeedRoutedLane(shape('external_seed')), true);
  assert.equal(isSeedRoutedLane(shape(OBSERVED)), true, 're-keyed row fell out of the lane');
});

test('the MINTED lane qualifies on source_system alone — no ext_ id, no sentinel', () => {
  // catalog_enrichment_agent_v1: 2,175 prod rows, 0 ext-prefixed, all on
  // merch_obs_ sellers. The old inline test named only the mirror source_system,
  // so this cohort was missed even before the re-key.
  assert.equal(
    isSeedRoutedLane({
      merchantId: OBSERVED,
      platform: 'shopify',
      sourceSystem: 'catalog_enrichment_agent_v1',
      sourceProductId: 'ilia-the-spf-and-go-makeup-edit',
    }),
    true,
  );
});

test('a genuinely unrelated merchant row is NOT dragged into the lane', () => {
  assert.equal(
    isSeedRoutedLane({
      merchantId: 'merch_live_acme',
      platform: 'shopify',
      sourceSystem: 'shopify_sync_v1',
      sourceProductId: '7828421673004',
    }),
    false,
  );
});

test('the content-preservation gate is wired to the lane, not the merchant literal', () => {
  // A source assertion, because the predicate is inline in the get_pdp_v2 route
  // and cannot be imported. Review (2026-08-17) showed the first version was
  // nearly vacuous: inverting the gate to `!isSeedRoutedLane`, deleting the
  // rich-content conjunct, and nulling `platform` ALL survived it, while a
  // harmless reformat broke it. So the patterns below are whitespace-tolerant
  // and assert the SHAPE, not the formatting.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const start = source.indexOf('const shouldPreserveExternalSeedPdpContent =');
  assert.ok(start > 0, 'the content-preservation gate has moved or been renamed');
  const block = source.slice(start, start + 900);

  assert.match(block, /isSeedRoutedLane\s*\(/, 'the gate no longer routes through the lane predicate');
  assert.doesNotMatch(block, /!\s*isSeedRoutedLane/, 'the lane test is INVERTED');
  assert.match(
    block, /hasExternalSeedRichPdpContent\s*\(/,
    'the rich-content conjunct is gone — the gate would preserve content for any seed row',
  );
  assert.doesNotMatch(
    block, /merchant_id === EXTERNAL_SEED_MERCHANT_ID/,
    'the gate is testing the retired sentinel merchant again — permanently false in prod',
  );

  // The lane inputs must come from canonicalProductRef, which carries the real
  // catalog_products platform/source_system. Reading them off canonicalProduct
  // (platform:'external', source:'external_seed') silently kills two of the
  // four arms — the defect review caught.
  const inputs = source.slice(source.indexOf('const seedLaneInput = {', start - 800), start + 900);
  assert.match(inputs, /platform:[\s\S]{0,120}canonicalProductRef\?\.platform/,
    'platform must be read from canonicalProductRef first');
  assert.match(inputs, /sourceSystem:[\s\S]{0,160}canonicalProductRef\?\.source_system/,
    'source_system must be read from canonicalProductRef first');
  // Both id candidates tested independently, not collapsed.
  assert.match(block, /sourceProductId:\s*canonicalProductRef\?\.product_id/);
  assert.match(block, /sourceProductId:\s*canonicalProductExternalId/);
});


test('the LANE test is the bound — the rich-content check is not', () => {
  // The PR comment originally credited `hasExternalSeedRichPdpContent` with
  // bounding the widening. It does not: its first arm is
  // `product.variants.length > 0`, which nearly every product satisfies. The
  // real bound is that a non-seed row matches NO arm of the lane test. Pinning
  // it here so a future edit cannot loosen the lane on the belief that the
  // content check will hold the line.
  const merchantSynced = {
    merchantId: 'merch_live_acme',
    platform: 'shopify',
    sourceSystem: 'shopify_sync_v1',
    sourceProductId: '7828421673004',
  };
  assert.equal(isSeedRoutedLane(merchantSynced), false);
  // ...and each seed signal ON ITS OWN is enough to admit the row, which is
  // what makes the lane test — not the content check — the thing that decides.
  assert.equal(isSeedRoutedLane({ ...merchantSynced, platform: 'external_seed' }), true);
  assert.equal(
    isSeedRoutedLane({ ...merchantSynced, sourceSystem: 'catalog_enrichment_agent_v1' }),
    true,
  );
  assert.equal(isSeedRoutedLane({ ...merchantSynced, sourceProductId: 'ext_abc123' }), true);
});
