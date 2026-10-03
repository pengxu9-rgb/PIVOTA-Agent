'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { assertStoredCatalogRehearsal, DISABLED_FLAGS, REQUIRED_TRUE_FLAGS, REMOTE_INDEX_CONFIG } =
  require('../src/config/storedCatalogRehearsal');

function safeConfig() {
  return { GATEWAY_STORED_CATALOG_REHEARSAL: '1',
    ...Object.fromEntries(DISABLED_FLAGS.map((name) => [name, 'false'])),
    ...Object.fromEntries(REQUIRED_TRUE_FLAGS.map((name) => [name, 'true'])) };
}

test('ordinary startup remains unchanged and the rehearsal config is not mutated', () => {
  const ordinary = { MERCHANT_VARIANT_SOURCING_ENABLED: 'true' };
  assert.deepEqual(assertStoredCatalogRehearsal(ordinary), { enabled: false });
  assert.equal(ordinary.MERCHANT_VARIANT_SOURCING_ENABLED, 'true');
  const safe = safeConfig(); const before = JSON.stringify(safe);
  assert.equal(assertStoredCatalogRehearsal(safe).enabled, true);
  assert.equal(JSON.stringify(safe), before);
});

for (const flag of DISABLED_FLAGS) {
  test(`rehearsal refuses missing or armed ${flag}`, () => {
    const missing = safeConfig(); delete missing[flag];
    assert.throws(() => assertStoredCatalogRehearsal(missing), new RegExp(flag));
    assert.throws(() => assertStoredCatalogRehearsal({ ...safeConfig(), [flag]: 'true' }), new RegExp(flag));
  });
}

test('cache kill switches require their actual literal false spelling', () => {
  for (const value of ['0', 'FALSE', 'off', ' false ', '']) {
    assert.throws(() => assertStoredCatalogRehearsal({ ...safeConfig(),
      PDP_SIMILAR_CARD_ENRICH_CACHE_ENABLED: value }), /PDP_SIMILAR_CARD_ENRICH_CACHE_ENABLED/);
  }
});

test('a remote serving index cannot be shadowed or queried during stored-only rehearsal', () => {
  for (const name of REMOTE_INDEX_CONFIG) {
    assert.throws(() => assertStoredCatalogRehearsal({ ...safeConfig(), [name]: 'https://secret-user:secret-value@example.invalid' }),
      (error) => error.message.includes(name) && !error.message.includes('secret-value'));
  }
});

test('a misspelled opt-in cannot silently turn off rehearsal safety', () => {
  for (const value of ['true', '0', 'false', 'yes']) {
    assert.throws(() => assertStoredCatalogRehearsal({ GATEWAY_STORED_CATALOG_REHEARSAL: value }), /FLAG_INVALID/);
  }
});

test('actual server entry exits before app/listener/DB startup with an unsafe rehearsal config', () => {
  // This guard runs before app imports; no version-specific Node flag is needed.
  const env = { PATH: process.env.PATH,
    ...safeConfig(), MERCHANT_VARIANT_SOURCING_ENABLED: 'true',
    DATABASE_URL: 'postgres://private-user:must-not-log@127.0.0.1:9/private-db', PORT: '0' };
  const child = spawnSync(process.execPath, [path.join(__dirname, '../src/server.js')], { env,
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /STORED_CATALOG_REHEARSAL_UNSAFE_CONFIG:MERCHANT_VARIANT_SOURCING_ENABLED/);
  assert.equal(child.stdout, '');
  assert.doesNotMatch(child.stderr, /must-not-log|Gateway.*listen|DB migrations/);
});

for (const flag of REQUIRED_TRUE_FLAGS) {
  test(`rehearsal refuses absent/disabled marked-budget protection ${flag}`, () => {
    for (const value of [undefined, 'false', '', '0']) {
      assert.throws(() => assertStoredCatalogRehearsal({ ...safeConfig(), [flag]: value }), new RegExp(flag));
    }
  });
}
