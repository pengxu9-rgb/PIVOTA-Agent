import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenVault } from '../src/vault/tokenVault.js';
import { assertNoPan, scrubForLog, PCI_SCOPE_NOTES } from '../src/vault/pci.js';

function makeVault(options = {}) {
  return new TokenVault({ encryptionKey: randomBytes(32), ...options });
}

test('vault stores and resolves charge metadata without returning the raw token', async () => {
  const vault = makeVault();
  const rawToken = 'pm_test_safe_handle_abc123';
  const { vault_ref } = await vault.store({
    user_ref: 'user_1',
    psp: 'stripe',
    token: rawToken,
    type: 'card',
    mandate_ref: 'mandate_safe_ref_1',
  });

  const resolved = vault.resolveForCharge(vault_ref, { user_ref: 'user_1' });
  assert.equal(resolved.psp, 'stripe');
  assert.equal(resolved.type, 'card');
  assert.equal(resolved.mandate_ref, 'mandate_safe_ref_1');
  assert.equal(resolved.token, undefined);
  assert.equal(resolved.rawToken, undefined);
  assert.equal(resolved.token_decrypt_handle, undefined);
  assert.equal(resolved.decryptForPsp, undefined);
  assert.equal(typeof resolved.chargeWith, 'function');
  assert.ok(!JSON.stringify(resolved).includes(rawToken));

  const chargeResult = await resolved.chargeWith((token) => {
    assert.equal(token, rawToken);
    return { psp_charge_id: 'charge_123', status: 'authorized' };
  });

  assert.deepEqual(chargeResult, {
    psp_charge_id: 'charge_123',
    status: 'authorized',
  });

  await assert.rejects(
    () => resolved.chargeWith((token) => token),
    /PSP callback result must not include raw token/,
  );
});

test('FWBC-P1: chargeWith blocks the raw token escaping as an object KEY', async () => {
  const vault = makeVault();
  const rawToken = 'pm_key_escape_xyz';
  const { vault_ref } = await vault.store({ user_ref: 'u1', psp: 'stripe', token: rawToken, type: 'card' });
  const resolved = vault.resolveForCharge(vault_ref, { user_ref: 'u1' });
  await assert.rejects(
    () => resolved.chargeWith((token) => ({ [token]: 'x' })),
    /raw token/,
  );
});

test('FWBC-P1: chargeWith scrubs the raw token from a SYNC thrown error', async () => {
  const vault = makeVault();
  const rawToken = 'pm_sync_throw_xyz';
  const { vault_ref } = await vault.store({ user_ref: 'u1', psp: 'stripe', token: rawToken, type: 'card' });
  const resolved = vault.resolveForCharge(vault_ref, { user_ref: 'u1' });
  await assert.rejects(
    () => resolved.chargeWith((token) => { throw new Error(`psp failed for ${token}`); }),
    (e) => !e.message.includes(rawToken),
  );
});

test('FWBC-P1: chargeWith scrubs the raw token from an ASYNC rejected error', async () => {
  const vault = makeVault();
  const rawToken = 'pm_async_reject_xyz';
  const { vault_ref } = await vault.store({ user_ref: 'u1', psp: 'stripe', token: rawToken, type: 'card' });
  const resolved = vault.resolveForCharge(vault_ref, { user_ref: 'u1' });
  await assert.rejects(
    () => resolved.chargeWith((token) => Promise.reject(new Error(`async psp failed ${token}`))),
    (e) => !e.message.includes(rawToken),
  );
});

test('KMS-P1: chargeWith scrubs the raw token from an error CAUSE chain', async () => {
  const vault = makeVault();
  const rawToken = 'pm_cause_leak_xyz';
  const { vault_ref } = await vault.store({ user_ref: 'u1', psp: 'stripe', token: rawToken, type: 'card' });
  const resolved = vault.resolveForCharge(vault_ref, { user_ref: 'u1' });
  // The token hides in the error's CAUSE, not its message.
  await assert.rejects(
    () => resolved.chargeWith((token) => { throw new Error('payment declined', { cause: new Error(`token was ${token}`) }); }),
    (e) => {
      const blob = `${e.message}|${e.stack || ''}|${e.cause ? (e.cause.message + (e.cause.stack || '')) : ''}`;
      return !blob.includes(rawToken);
    },
  );
});

test('cross-user resolve is rejected with a generic error', async () => {
  const vault = makeVault();
  const rawToken = 'shop_pay_handle_safe_abc123';
  const { vault_ref } = await vault.store({
    user_ref: 'user_1',
    psp: 'shop_pay',
    token: rawToken,
    type: 'wallet',
  });

  assert.throws(
    () => vault.resolveForCharge(vault_ref, { user_ref: 'user_2' }),
    (error) => error.message === 'vault reference is not available' && !error.message.includes(rawToken),
  );
});

test('assertNoPan rejects a Luhn-valid PAN and accepts PSP token shapes', async () => {
  assert.throws(
    () => assertNoPan('4242424242424242'),
    (error) => error.message === 'PAN-like payment value is not allowed' && !error.message.includes('4242'),
  );
  assert.equal(assertNoPan('pm_test_safe_handle_abc123'), true);
});

test('assertNoPan rejects Luhn-valid PANs in object keys', async () => {
  assert.throws(
    () => assertNoPan({ 'card_4242424242424242': 'not a value PAN' }),
    (error) => error.message === 'PAN-like payment value is not allowed' && !error.message.includes('4242'),
  );
});

test('assertNoPan detects PAN separators without flagging non-Luhn long numbers', async () => {
  assert.throws(
    () => assertNoPan('card=4242.4242.4242.4242'),
    (error) => error.message === 'PAN-like payment value is not allowed',
  );
  assert.throws(
    () => assertNoPan('card=4242\t4242\n4242 4242'),
    (error) => error.message === 'PAN-like payment value is not allowed',
  );
  assert.equal(assertNoPan('non-luhn 4242424242424241'), true);
});

test('revoke makes resolve fail', async () => {
  const vault = makeVault();
  const { vault_ref } = await vault.store({
    user_ref: 'user_1',
    psp: 'stripe',
    token: 'pm_revoke_safe_handle_abc123',
    type: 'card',
  });

  assert.deepEqual(vault.revoke(vault_ref, { user_ref: 'user_1' }), { revoked: true });
  assert.equal(vault.isExpired(vault_ref), true);
  assert.throws(
    () => vault.resolveForCharge(vault_ref, { user_ref: 'user_1' }),
    /vault reference is not available/,
  );
});

test('resolved chargeWith re-checks revocation before decrypting', async () => {
  const vault = makeVault();
  const { vault_ref } = await vault.store({
    user_ref: 'user_1',
    psp: 'stripe',
    token: 'pm_revoke_after_resolve_safe_handle_abc123',
    type: 'card',
  });

  const resolved = vault.resolveForCharge(vault_ref, { user_ref: 'user_1' });
  vault.revoke(vault_ref, { user_ref: 'user_1' });

  await assert.rejects(
    () => resolved.chargeWith(() => ({ psp_charge_id: 'charge_123' })),
    /vault reference is not available/,
  );
});

test('chargeWith supports async PSP clients without leaking token material', async () => {
  const vault = makeVault();
  const rawToken = 'pm_async_charge_safe_handle_abc123';
  const { vault_ref } = await vault.store({
    user_ref: 'user_1',
    psp: 'stripe',
    token: rawToken,
    type: 'card',
  });

  const resolved = vault.resolveForCharge(vault_ref, { user_ref: 'user_1' });
  const chargeResult = await resolved.chargeWith(async (token) => {
    assert.equal(token, rawToken);
    return { psp_charge_id: 'charge_async_123', status: 'captured' };
  });

  assert.deepEqual(chargeResult, {
    psp_charge_id: 'charge_async_123',
    status: 'captured',
  });
  await assert.rejects(
    () => resolved.chargeWith(async (token) => ({ leaked: token })),
    /PSP callback result must not include raw token/,
  );
});

test('stored record is encrypted at rest and does not contain the plaintext token', async () => {
  const vault = makeVault();
  const rawToken = 'pm_plaintext_must_not_be_stored_123';
  const { vault_ref } = await vault.store({
    user_ref: 'user_1',
    psp: 'stripe',
    token: rawToken,
    type: 'card',
  });

  const record = vault._records.get(vault_ref);
  assert.equal(record.token, undefined);
  assert.equal(record.encrypted_token.algorithm, 'aes-256-gcm');
  assert.ok(record.encrypted_token.iv);
  assert.ok(record.encrypted_token.authTag);
  assert.ok(record.encrypted_token.ciphertext);
  assert.ok(!JSON.stringify(record).includes(rawToken));
});

test('expiry is enforced during resolve', async () => {
  let now = Date.parse('2026-06-01T00:00:00.000Z');
  const vault = makeVault({ now: () => now });
  const { vault_ref } = await vault.store({
    user_ref: 'user_1',
    psp: 'stripe',
    token: 'pm_expiring_safe_handle_abc123',
    type: 'card',
    expiresAt: '2026-06-01T00:05:00.000Z',
  });

  assert.equal(vault.isExpired(vault_ref), false);
  now = Date.parse('2026-06-01T00:06:00.000Z');
  assert.equal(vault.isExpired(vault_ref), true);
  assert.throws(
    () => vault.resolveForCharge(vault_ref, { user_ref: 'user_1' }),
    /vault reference is not available/,
  );
});

test('scrubForLog masks vault-adjacent sensitive fields', async () => {
  const scrubbed = scrubForLog({
    vault_ref: 'pmref_secret',
    token_decrypt_handle: { vault_ref: 'pmref_secret', decryptForPsp() {} },
    encrypted_token: { iv: 'iv', authTag: 'tag', ciphertext: 'ct' },
    token: 'pm_secret',
    expected_amount: 123,
  });

  assert.equal(scrubbed.vault_ref, '[REDACTED]');
  assert.equal(scrubbed.token_decrypt_handle, '[REDACTED]');
  assert.equal(scrubbed.encrypted_token, '[REDACTED]');
  assert.equal(scrubbed.token, '[REDACTED]');
  assert.equal(scrubbed.expected_amount, '[REDACTED_AMOUNT]');
  assert.match(PCI_SCOPE_NOTES, /SAQ-A/);
});
