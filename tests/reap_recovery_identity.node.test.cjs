'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createReapRecoveryIdentityReader, IDENTITY_SQL } = require('../src/services/reapRecoveryIdentity');

test('recovery identity reads stored catalog only, including a paused/inactive row, and returns no new price/proof', async () => {
  const calls = [];
  const reader = createReapRecoveryIdentityReader({ query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ product_key: 'prod::external_seed::external_seed::ext_1',
      platform: 'external_seed', source_domain: 'judydoll.com',
      canonical_url: 'https://agent.pivota.cc/products/sig_1',
      snapshot_destination_url: 'https://judydoll.com/products/lip-ink',
      sync_status: 'disabled', price: 999, cart_link_proof: { expired: true } }] };
  } });
  const row = await reader('sig_1');
  assert.equal(row.product_id, 'sig_1');
  assert.equal(row.product_key, 'prod::external_seed::external_seed::ext_1');
  assert.equal(row.destination_url, 'https://judydoll.com/products/lip-ink');
  assert.equal(row.price, undefined);
  assert.equal(row.cart_link_proof, undefined);
  assert.deepEqual(calls, [{ sql: IDENTITY_SQL, values: ['sig_1'] }]);
  assert.match(IDENTITY_SQL, /FROM catalog_products cp/);
  assert.doesNotMatch(IDENTITY_SQL, /INSERT|UPDATE|DELETE|serving_eligible|cart_link_eligible|sync_status/i);
});

test('recovery identity refuses missing/ambiguous/aborted/invalid references without selecting a replacement', async () => {
  for (const rows of [[], [{ product_key: 'a' }, { product_key: 'b' }], [{}]]) {
    assert.equal(await createReapRecoveryIdentityReader({ query: async () => ({ rows }) })('sig_1'), null);
  }
  let calls = 0;
  const reader = createReapRecoveryIdentityReader({ query: async () => { calls++; return { rows: [] }; } });
  for (const id of ['', null, 'bad\nreference', 'x'.repeat(513)]) assert.equal(await reader(id), null);
  assert.equal(await reader('sig_1', { signal: { aborted: true } }), null);
  assert.equal(calls, 0);
  const hostile = "sig_1' OR 1=1 --";
  await createReapRecoveryIdentityReader({ query: async (sql, values) => {
    assert.equal(sql, IDENTITY_SQL);
    assert.deepEqual(values, [hostile]);
    return { rows: [] };
  } })(hostile);
});

test('actual gateway surface injects SQL recovery reader independently of the normal PDP executor', () => {
  const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const surfaceStart = source.indexOf('const surface = createCommerceToolSurface(executor, {');
  const surfaceEnd = source.indexOf('commerceSharedToolSurface = surface;', surfaceStart);
  assert.ok(surfaceStart > 0 && surfaceEnd > surfaceStart);
  const wiring = source.slice(surfaceStart, surfaceEnd);
  assert.match(wiring, /recoveryIdentityReader: require\('\.\/services\/reapRecoveryIdentity'\)\.createReapRecoveryIdentityReader\(\{ query \}\)/);
  const moduleSource = fs.readFileSync(require.resolve('../src/services/reapRecoveryIdentity'), 'utf8');
  assert.doesNotMatch(moduleSource, /\brequire\(|\bfetch\(|axios|invokeCommerce|merchantSource/);
});
