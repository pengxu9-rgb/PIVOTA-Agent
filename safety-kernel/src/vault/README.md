# Pivota Token Vault

This directory contains a reference token vault for PSP-issued payment handles. Its
purpose is to keep Pivota on the intended PCI SAQ-A boundary: the platform must not
store, return, or log PAN/CVV data.

## Stored

- `vault_ref`: an opaque internal reference such as `pmref_...`.
- `user_ref`: the user that owns the reference.
- PSP metadata needed to route a charge: `psp`, `type`, optional `mandate_ref`.
- The PSP token or handle encrypted at rest with AES-256-GCM.
- Expiry and revocation metadata.

## Not Stored

- PANs or raw card numbers.
- CVV/CVC values.
- Raw AP2 state blobs.
- Payment authorization URLs or fabricated PSP transaction identifiers.

`assertNoPan()` rejects Luhn-valid 13-19 digit values before encryption so accidental
card-number storage fails closed.

## Key Management — KMS + rotation (keyProvider.js)

`TokenVault` resolves its 32-byte AES data-encryption key (DEK) through a **key provider**, so the
key never has to be hardcoded and can rotate. Pass EITHER:

- `new TokenVault({ keyProvider })` — production. Use `KmsKeyProvider`:
  ```js
  import { KmsKeyProvider } from './keyProvider.js';
  const provider = new KmsKeyProvider({ kmsClient })   // kmsClient.decrypt({CiphertextBlob}) -> {Plaintext}
    .register('2026-06', wrappedDekBlobFromKms)         // the KMS-wrapped DEK (CiphertextBlob)
    .setActive('2026-06');
  const vault = new TokenVault({ keyProvider: provider });
  ```
  Envelope encryption: KMS holds the key-encryption key; you store only the *wrapped* DEK. The
  provider unwraps it via KMS on first use and caches the plaintext DEK in memory (never persisted,
  never logged — KMS errors are surfaced as a generic `KMS key unwrap failed`).

- `new TokenVault({ encryptionKey })` — dev/test only. Wrapped as a `StaticKeyProvider` (keyRef
  `static`). Accepts a 32-byte Buffer, `hex:...`, `base64:...`, or a 64-char hex string.

**Rotation is real here.** Each stored record records the `key_ref` it was encrypted under (and that
ref is bound into the GCM AAD, so ciphertext can't be replayed under a different key). To rotate:
`provider.register(newRef, newWrappedBlob).setActive(newRef)`. New records use the new key; existing
records keep decrypting with their original key. No re-encryption sweep is required for correctness
(do one later if you want to retire an old KMS key). See `keyProvider.test.js` for the A→B rotation
proof.

## Charging Flow

The rest of the safety kernel should use `vault_ref` instead of raw instruments. At charge time,
`await resolveForCharge(vault_ref, { user_ref })` enforces ownership/expiry/revocation and returns
only PSP routing fields plus `chargeWith(pspClientFn)`. The raw token is decrypted **inside**
`chargeWith` (which resolves the DEK by the record's `key_ref`), passed to your PSP callback, and
NEVER returned to the caller — the guard even blocks the token escaping via the callback's return
value, a thrown error, or an async rejection. Application logs should call `scrubForLog()` before
logging objects that may contain vault fields.
