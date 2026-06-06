# Token Vault Implementation Notes

## Design

- `TokenVault` is an additive, in-memory reference implementation.
- Records are keyed by an opaque `pmref_...` value and bound to `user_ref`.
- The candidate token is checked with `assertNoPan()` before storage.
- Token plaintext is encrypted with AES-256-GCM using a random 96-bit IV per record.
- Ciphertext, IV, and auth tag are stored with authenticated metadata as AAD.
- `resolveForCharge()` enforces ownership and returns PSP routing metadata plus a
  `token_decrypt_handle`; it does not return the raw token.
- `revoke()` marks a reference unusable. `isExpired()` fails closed for missing or
  revoked references.

## Reference Only

This module intentionally keeps records in memory so the behavior is easy to test
offline. Production needs a durable encrypted store, concurrency controls, audit hooks,
KMS-backed key loading, key ids per record, and a rotation worker. The encryption key
must come from KMS or a secret manager, never from source code or logs.

## Production Wiring

`submit_payment` should accept or derive a `vault_ref` for saved instruments instead of
handling a raw card or payment token. The payment path would:

1. Validate the quote, confirmation token, amount, idempotency key, and user_ref as it
   does today.
2. Call `vault.resolveForCharge(vault_ref, { user_ref })`.
3. Route by `psp` and `type`.
4. Pass `token_decrypt_handle` directly to the PSP client boundary.
5. Let the PSP client unwrap the handle immediately before its charge call.

The kernel should continue treating `ap2_state` as sensitive opaque state. It should
not parse or log AP2 tokens, mandate payloads, or decrypted payment instruments.
