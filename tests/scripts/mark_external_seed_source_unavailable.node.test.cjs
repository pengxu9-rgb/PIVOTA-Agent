'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MARKER_VERSION,
  patchSeedData,
} = require('../../scripts/mark-external-seed-source-unavailable.cjs');

test('patchSeedData marks source unavailable and removes transactional price fields', () => {
  const marker = {
    contract_version: MARKER_VERSION,
    updated_at: '2026-05-17T00:00:00.000Z',
    status: 'source_unavailable',
    reason: 'official_404',
  };
  const patched = patchSeedData(
    {
      price: 18,
      price_amount: 18,
      price_currency: 'USD',
      availability: 'in_stock',
      in_stock: true,
      variants: [
        {
          id: 'v1',
          title: 'Default',
          price: 18,
          price_amount: 18,
          price_currency: 'USD',
          availability: 'in_stock',
          in_stock: true,
        },
      ],
      snapshot: {
        price: 18,
        price_amount: 18,
        price_currency: 'USD',
        availability: 'in_stock',
        in_stock: true,
        variants: [
          {
            id: 'sv1',
            title: 'Snapshot Default',
            current_price: 18,
            currency: 'USD',
            availability: 'in_stock',
            in_stock: true,
          },
        ],
      },
    },
    marker,
  );

  assert.equal(patched.availability, 'out_of_stock');
  assert.equal(patched.in_stock, false);
  assert.equal(patched.price, undefined);
  assert.equal(patched.price_amount, undefined);
  assert.equal(patched.price_currency, undefined);
  assert.equal(patched.snapshot.availability, 'out_of_stock');
  assert.equal(patched.snapshot.price_amount, undefined);
  assert.equal(patched.variants[0].price, undefined);
  assert.equal(patched.variants[0].price_amount, undefined);
  assert.equal(patched.variants[0].price_currency, undefined);
  assert.equal(patched.variants[0].availability, 'out_of_stock');
  assert.equal(patched.variants[0].in_stock, false);
  assert.equal(patched.snapshot.variants[0].current_price, undefined);
  assert.equal(patched.snapshot.variants[0].currency, undefined);
  assert.equal(patched.snapshot.variants[0].availability, 'out_of_stock');
  assert.equal(patched.snapshot.variants[0].in_stock, false);
  assert.deepEqual(patched.source_unavailable_v1, marker);
  assert.equal(patched.external_seed_snapshot_contract.authoritative, true);
  assert.equal(patched.external_seed_snapshot_contract.replace_strategy, 'replace_not_merge');
});
