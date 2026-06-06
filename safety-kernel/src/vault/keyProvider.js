// Vault key providers — where the AES-256-GCM data-encryption key (DEK) comes from.
//
// PCI/SAQ-A posture: the platform stores only PSP tokens (never PANs), encrypted at rest. The DEK
// must NOT be hardcoded in source; in production it comes from a KMS / secret manager. This seam lets
// the TokenVault resolve a key BY REFERENCE so keys can ROTATE: each record records the keyRef it was
// encrypted under, old records keep decrypting with the old key, new records use the active key.
//
// SECURITY (Codex KMS review): key material is held in PRIVATE class fields (#) so it can never be
// enumerated, JSON.stringify'd, or printed by util.inspect/console.log of a provider; getKey() returns
// DEFENSIVE COPIES so a caller cannot mutate the provider's canonical key; clearCache() ZEROES the
// plaintext before dropping it. A custom inspect/toJSON returns a redacted marker as belt-and-suspenders.
//
// Two providers:
//   StaticKeyProvider  — dev/test: one key, one keyRef ('static'). Wraps the legacy single-key option.
//   KmsKeyProvider     — prod: keys are wrapped DEKs unwrapped via an injected KMS client; cached.

import { inspect } from 'node:util';

const KEY_BYTES = 32;
const REDACTED_VIEW = '[RedactedKeyProvider]';

export function normalizeKeyMaterial(material) {
  if (material == null) throw new Error('key material must be provided');
  let key;
  if (typeof material === 'string') {
    if (material.startsWith('base64:')) key = Buffer.from(material.slice(7), 'base64');
    else if (material.startsWith('hex:')) key = Buffer.from(material.slice(4), 'hex');
    else if (/^[0-9a-fA-F]{64}$/.test(material)) key = Buffer.from(material, 'hex');
    else key = Buffer.from(material, 'utf8');
  } else if (Buffer.isBuffer(material) || material instanceof Uint8Array) {
    key = Buffer.from(material);
  }
  if (!key || key.length !== KEY_BYTES) throw new Error('key material must be 32 bytes for AES-256-GCM');
  return key;
}

/**
 * The KeyProvider contract the vault relies on:
 *   activeKeyRef(): string                  — the keyRef new records should be encrypted under
 *   getKey(keyRef): Promise<Buffer>|Buffer  — a DEFENSIVE COPY of the 32-byte DEK (throws if unknown)
 */

/** Dev/test provider: a single static key under a fixed keyRef. */
export class StaticKeyProvider {
  #key;
  #keyRef;
  constructor(material, keyRef = 'static') {
    this.#key = normalizeKeyMaterial(material); // private — not enumerable / serializable
    this.#keyRef = keyRef;
  }
  activeKeyRef() { return this.#keyRef; }
  getKey(keyRef) {
    if (keyRef !== this.#keyRef) throw new Error(`unknown keyRef: ${keyRef}`);
    return Buffer.from(this.#key); // defensive copy — caller cannot mutate our key
  }
  toJSON() { return REDACTED_VIEW; }
  [inspect.custom]() { return REDACTED_VIEW; }
}

/**
 * Production provider: envelope encryption via KMS. You register one or more WRAPPED data keys
 * (the ciphertext blob KMS gave you when you generated the DEK). The provider unwraps a wrapped key
 * via the injected KMS client's `decrypt({ CiphertextBlob }) -> { Plaintext }` and caches the
 * resulting 32-byte DEK in memory keyed by keyRef. The plaintext DEK is NEVER persisted or logged.
 *
 * Rotation: register a new wrapped key with a new keyRef and call setActive(newKeyRef). Old records
 * keep their keyRef and still decrypt; new records use the new active key.
 *
 * @example
 *   const kms = new KMSClient(...); // AWS SDK or any client exposing decrypt()
 *   const provider = new KmsKeyProvider({ kmsClient: kms });
 *   provider.register('2026-06', wrappedKeyBlobFromKms);   // CiphertextBlob
 *   provider.setActive('2026-06');
 */
export class KmsKeyProvider {
  #kms;
  #wrapped;   // keyRef -> wrapped CiphertextBlob
  #cache;     // keyRef -> unwrapped 32-byte DEK (canonical; never returned by reference)
  #active;

  /** @param {{ kmsClient: { decrypt: (args:object)=>Promise<{Plaintext: Buffer|Uint8Array|string}> } }} opts */
  constructor({ kmsClient }) {
    if (!kmsClient || typeof kmsClient.decrypt !== 'function') {
      throw new Error('KmsKeyProvider requires a kmsClient with decrypt()');
    }
    this.#kms = kmsClient;
    this.#wrapped = new Map();
    this.#cache = new Map();
    this.#active = null;
  }

  register(keyRef, wrappedKeyBlob) {
    if (!keyRef || !wrappedKeyBlob) throw new Error('register requires keyRef and wrappedKeyBlob');
    this.#wrapped.set(keyRef, wrappedKeyBlob);
    return this;
  }

  setActive(keyRef) {
    if (!this.#wrapped.has(keyRef)) throw new Error(`cannot activate unregistered keyRef: ${keyRef}`);
    this.#active = keyRef;
    return this;
  }

  activeKeyRef() {
    if (!this.#active) throw new Error('no active keyRef set');
    return this.#active;
  }

  async getKey(keyRef) {
    const cached = this.#cache.get(keyRef);
    if (cached) return Buffer.from(cached); // defensive copy
    const wrapped = this.#wrapped.get(keyRef);
    if (!wrapped) throw new Error(`unknown keyRef: ${keyRef}`);
    let plaintext;
    try {
      const res = await this.#kms.decrypt({ CiphertextBlob: wrapped, KeyRef: keyRef });
      plaintext = res?.Plaintext;
    } catch {
      // Never surface KMS internals / key material in the error (no cause chaining).
      throw new Error('KMS key unwrap failed');
    }
    const key = normalizeKeyMaterial(plaintext);
    this.#cache.set(keyRef, key);
    return Buffer.from(key); // defensive copy
  }

  /** Zero + drop cached plaintext DEKs (e.g. on rotation or shutdown). */
  clearCache() {
    for (const buf of this.#cache.values()) {
      if (Buffer.isBuffer(buf)) buf.fill(0); // wipe plaintext before releasing
    }
    this.#cache.clear();
  }

  toJSON() { return REDACTED_VIEW; }
  [inspect.custom]() { return REDACTED_VIEW; }
}

/** Coerce a constructor option into a KeyProvider: a provider passes through; raw material → Static. */
export function asKeyProvider(keyOrProvider) {
  if (keyOrProvider && typeof keyOrProvider.getKey === 'function' && typeof keyOrProvider.activeKeyRef === 'function') {
    return keyOrProvider;
  }
  return new StaticKeyProvider(keyOrProvider);
}
