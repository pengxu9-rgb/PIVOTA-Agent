// Key-provider tests — KMS readiness + key rotation for the vault DEK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { StaticKeyProvider, KmsKeyProvider, asKeyProvider, normalizeKeyMaterial } from '../src/vault/keyProvider.js';
import { TokenVault } from '../src/vault/tokenVault.js';

test('normalizeKeyMaterial accepts 32-byte buffer, hex, base64; rejects wrong length', () => {
  assert.equal(normalizeKeyMaterial(randomBytes(32)).length, 32);
  assert.equal(normalizeKeyMaterial('hex:' + '00'.repeat(32)).length, 32);
  assert.equal(normalizeKeyMaterial('base64:' + Buffer.alloc(32, 7).toString('base64')).length, 32);
  assert.throws(() => normalizeKeyMaterial('too-short'));
  assert.throws(() => normalizeKeyMaterial(randomBytes(16)));
});

test('StaticKeyProvider returns its key under a fixed ref and rejects unknown refs', () => {
  const p = new StaticKeyProvider(randomBytes(32), 'static');
  assert.equal(p.activeKeyRef(), 'static');
  assert.equal(p.getKey('static').length, 32);
  assert.throws(() => p.getKey('other'));
});

test('asKeyProvider passes a provider through and wraps raw material', () => {
  const p = new StaticKeyProvider(randomBytes(32));
  assert.equal(asKeyProvider(p), p);
  const wrapped = asKeyProvider(randomBytes(32));
  assert.equal(typeof wrapped.getKey, 'function');
  assert.equal(wrapped.activeKeyRef(), 'static');
});

test('KmsKeyProvider unwraps a wrapped DEK via the injected KMS client and caches it', async () => {
  const realKey = randomBytes(32);
  let decryptCalls = 0;
  const kmsClient = {
    async decrypt({ CiphertextBlob }) {
      decryptCalls += 1;
      assert.equal(CiphertextBlob, 'WRAPPED_BLOB_2026_06');
      return { Plaintext: realKey };
    },
  };
  const p = new KmsKeyProvider({ kmsClient }).register('2026-06', 'WRAPPED_BLOB_2026_06').setActive('2026-06');
  assert.equal(p.activeKeyRef(), '2026-06');
  const k1 = await p.getKey('2026-06');
  const k2 = await p.getKey('2026-06');
  assert.ok(k1.equals(realKey));
  assert.equal(decryptCalls, 1, 'DEK unwrap is cached (KMS called once)');
});

test('KmsKeyProvider hides KMS internals in the error and rejects unknown refs', async () => {
  const kmsClient = { async decrypt() { throw new Error('AWS KMS AccessDenied: secret-arn-xyz'); } };
  const p = new KmsKeyProvider({ kmsClient }).register('k1', 'blob').setActive('k1');
  await assert.rejects(() => p.getKey('k1'), (e) => e.message === 'KMS key unwrap failed' && !e.message.includes('secret-arn'));
  await assert.rejects(() => p.getKey('unknown'), /unknown keyRef/);
});

test('KmsKeyProvider requires a kmsClient with decrypt(); setActive validates registration', () => {
  assert.throws(() => new KmsKeyProvider({}));
  const p = new KmsKeyProvider({ kmsClient: { decrypt() {} } });
  assert.throws(() => p.setActive('nope'));
  assert.throws(() => p.activeKeyRef()); // none active yet
});

test('vault: a record encrypted under key A still decrypts after rotation to key B', async () => {
  const keyA = randomBytes(32);
  const keyB = randomBytes(32);
  const kmsClient = {
    async decrypt({ CiphertextBlob }) {
      if (CiphertextBlob === 'blobA') return { Plaintext: keyA };
      if (CiphertextBlob === 'blobB') return { Plaintext: keyB };
      throw new Error('unknown');
    },
  };
  const provider = new KmsKeyProvider({ kmsClient }).register('A', 'blobA').setActive('A');
  const vault = new TokenVault({ keyProvider: provider });

  // Store a token under key A.
  const { vault_ref: refA } = await vault.store({ user_ref: 'u1', psp: 'stripe', token: 'pm_under_A', type: 'card' });

  // Rotate: register + activate key B. New records use B; the old record keeps key_ref 'A'.
  provider.register('B', 'blobB').setActive('B');
  const { vault_ref: refB } = await vault.store({ user_ref: 'u1', psp: 'stripe', token: 'pm_under_B', type: 'card' });

  // Both still decrypt — A via the old key, B via the new key.
  const gotA = await vault.resolveForCharge(refA, { user_ref: 'u1' }).chargeWith((t) => t === 'pm_under_A' ? 'okA' : 'WRONG');
  const gotB = await vault.resolveForCharge(refB, { user_ref: 'u1' }).chargeWith((t) => t === 'pm_under_B' ? 'okB' : 'WRONG');
  assert.equal(gotA, 'okA');
  assert.equal(gotB, 'okB');

  // The records record distinct key_refs.
  assert.equal(vault._records.get(refA).key_ref, 'A');
  assert.equal(vault._records.get(refB).key_ref, 'B');
});

test('vault: legacy encryptionKey option still works (backward compatible)', async () => {
  const vault = new TokenVault({ encryptionKey: randomBytes(32) });
  const { vault_ref } = await vault.store({ user_ref: 'u1', psp: 'stripe', token: 'pm_legacy', type: 'card' });
  // The PSP callback sees the real token (asserted inside), but returns a DERIVED value so the
  // anti-leak guard is satisfied.
  const got = await vault.resolveForCharge(vault_ref, { user_ref: 'u1' }).chargeWith((t) => {
    assert.equal(t, 'pm_legacy');
    return 'charged';
  });
  assert.equal(got, 'charged');
  assert.equal(vault._records.get(vault_ref).key_ref, 'static');
});

test('vault: requires a keyProvider or encryptionKey', () => {
  assert.throws(() => new TokenVault({}));
});

// --- Codex KMS review regression tests ---

test('KMS-P1: a provider does NOT leak the DEK via JSON.stringify or util.inspect', async () => {
  const realKey = Buffer.alloc(32, 0x41); // recognizable bytes (0x41 = 'A')
  const hexKey = realKey.toString('hex');
  const stat = new StaticKeyProvider(realKey);
  assert.ok(!JSON.stringify(stat).includes(hexKey));
  assert.ok(!inspect(stat, { depth: 5 }).includes('41 41 41'), 'inspect must not print raw key bytes');

  const kms = { async decrypt() { return { Plaintext: realKey }; } };
  const p = new KmsKeyProvider({ kmsClient: kms }).register('k', 'blob').setActive('k');
  await p.getKey('k'); // populate the cache
  assert.ok(!JSON.stringify(p).includes(hexKey));
  assert.ok(!inspect(p, { depth: 5 }).includes('41 41 41'), 'cached DEK must not print');
});

test('KMS-P2: getKey returns a DEFENSIVE COPY — mutating it does not corrupt the provider', async () => {
  const stat = new StaticKeyProvider(Buffer.alloc(32, 9));
  stat.getKey('static').fill(0); // attacker zeroes their copy
  assert.ok(stat.getKey('static').equals(Buffer.alloc(32, 9)), 'static provider key unchanged');

  const kms = { async decrypt() { return { Plaintext: Buffer.alloc(32, 7) }; } };
  const p = new KmsKeyProvider({ kmsClient: kms }).register('k', 'blob').setActive('k');
  (await p.getKey('k')).fill(0);
  assert.ok((await p.getKey('k')).equals(Buffer.alloc(32, 7)), 'cached DEK unchanged by caller mutation');
});

test('KMS-P3: clearCache actually clears (KMS re-unwrap required after)', async () => {
  let calls = 0;
  const kms = { async decrypt() { calls += 1; return { Plaintext: Buffer.alloc(32, 5) }; } };
  const p = new KmsKeyProvider({ kmsClient: kms }).register('k', 'blob').setActive('k');
  await p.getKey('k');
  p.clearCache();
  await p.getKey('k');
  assert.equal(calls, 2, 'cache cleared → KMS called again');
});
