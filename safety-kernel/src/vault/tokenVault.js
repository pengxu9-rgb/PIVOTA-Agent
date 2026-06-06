import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { assertNoPan } from './pci.js';
import { asKeyProvider } from './keyProvider.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export class TokenVault {
  /**
   * @param {{ encryptionKey?: Buffer|Uint8Array|string, keyProvider?: object, now?: () => number|Date|string }} options
   *
   * Provide EITHER a `keyProvider` (KMS-backed, rotation-capable — see keyProvider.js) OR a raw
   * `encryptionKey` (dev/test; wrapped as a StaticKeyProvider). Each stored record records the
   * keyRef it was encrypted under, so keys can rotate without breaking existing records.
   */
  constructor({ encryptionKey, keyProvider, now = () => Date.now() } = {}) {
    if (!keyProvider && encryptionKey == null) throw new Error('TokenVault requires a keyProvider or encryptionKey');
    this._keys = asKeyProvider(keyProvider || encryptionKey);
    this._now = now;
    this._records = new Map();
  }

  /**
   * Store a PSP-issued token or handle. PAN-like values are refused before
   * encryption so a raw card number cannot enter the vault by mistake.
   *
   * @param {{ user_ref: string, psp: string, token: string, type: string, mandate_ref?: string, expiresAt?: string|Date|number }} input
   * @returns {Promise<{ vault_ref: string }>}
   */
  async store(input = {}) {
    const user_ref = requiredString(input.user_ref, 'user_ref');
    const psp = requiredString(input.psp, 'psp');
    const type = requiredString(input.type, 'type');
    const token = requiredString(input.token, 'token');
    const mandate_ref = optionalString(input.mandate_ref, 'mandate_ref');
    const expiresAt = normalizeExpiresAt(input.expiresAt);

    assertNoPan(token);
    if (mandate_ref) assertNoPan(mandate_ref);

    const vault_ref = `pmref_${randomBytes(18).toString('base64url')}`;
    const key_ref = this._keys.activeKeyRef();
    const recordBase = {
      vault_ref,
      user_ref,
      psp,
      type,
      mandate_ref,
      expiresAt,
      key_ref,
      created_at: new Date(coerceTimeMs(this._now())).toISOString(),
      revoked_at: null,
    };
    const key = await this._keys.getKey(key_ref);
    const encrypted_token = encryptToken(key, token, recordBase);

    this._records.set(vault_ref, {
      ...recordBase,
      encrypted_token,
    });

    return { vault_ref };
  }

  /**
   * Resolve metadata needed to charge. This never returns the raw token; callers
   * pass a PSP client callback to chargeWith so plaintext stays inside the vault
   * boundary.
   *
   * @param {string} vault_ref
   * @param {{ user_ref: string }} context
   * @returns {{ psp: string, type: string, mandate_ref?: string, chargeWith: Function }}
   */
  resolveForCharge(vault_ref, context = {}) {
    const record = this._activeOwnedRecord(vault_ref, context);
    const resolved = {
      psp: record.psp,
      type: record.type,
      chargeWith: makeChargeWith(this, record.vault_ref, record.user_ref),
    };
    if (record.mandate_ref) resolved.mandate_ref = record.mandate_ref;
    return resolved;
  }

  /**
   * @param {string} vault_ref
   * @param {{ user_ref: string }} context
   * @returns {{ revoked: true }}
   */
  revoke(vault_ref, context = {}) {
    const record = this._ownedRecord(vault_ref, context);
    record.revoked_at ||= new Date(coerceTimeMs(this._now())).toISOString();
    return { revoked: true };
  }

  /**
   * Fail closed for unknown refs. Revoked refs are considered unusable.
   *
   * @param {string} vault_ref
   * @param {number|Date|string} [now]
   * @returns {boolean}
   */
  isExpired(vault_ref, now = this._now()) {
    const record = this._records.get(requiredString(vault_ref, 'vault_ref'));
    if (!record || record.revoked_at) return true;
    if (!record.expiresAt) return false;
    return coerceTimeMs(now) >= Date.parse(record.expiresAt);
  }

  _ownedRecord(vault_ref, context = {}) {
    const ref = requiredString(vault_ref, 'vault_ref');
    const user_ref = requiredString(context.user_ref, 'user_ref');
    const record = this._records.get(ref);
    if (!record || record.user_ref !== user_ref) {
      throw new Error('vault reference is not available');
    }
    return record;
  }

  _activeOwnedRecord(vault_ref, context = {}) {
    const record = this._ownedRecord(vault_ref, context);
    if (record.revoked_at || this.isExpired(record.vault_ref)) {
      throw new Error('vault reference is not available');
    }
    return record;
  }
}

export { assertNoPan };

function makeChargeWith(vault, vault_ref, user_ref) {
  // chargeWith is async: the DEK is resolved by the record's key_ref via the key provider (KMS may
  // be an async unwrap). Plaintext stays inside this function; the token never escapes.
  return async function chargeWith(pspClientFn) {
    if (typeof pspClientFn !== 'function') {
      throw new Error('pspClientFn must be a function');
    }

    const record = vault._activeOwnedRecord(vault_ref, { user_ref });
    const key = await vault._keys.getKey(record.key_ref);
    const rawToken = decryptToken(key, record);

    // Codex P1: the raw token must not escape through ANY channel — the return value, a thrown
    // error (sync), or a rejected promise (async). Wrap all three.
    let result;
    try {
      result = pspClientFn(rawToken);
    } catch (err) {
      throw scrubTokenFromError(err, rawToken);
    }

    if (isPromiseLike(result)) {
      return result.then(
        (value) => assertNoRawTokenReturned(value, rawToken),
        (err) => { throw scrubTokenFromError(err, rawToken); },
      );
    }

    return assertNoRawTokenReturned(result, rawToken);
  };
}

function scrubTokenFromError(err, rawToken) {
  // Never let a PSP callback error carry the raw token back to the resolver's caller.
  if (containsRawToken(err, rawToken)) {
    return new Error('PSP callback failed (token-bearing error suppressed)');
  }
  return err;
}

function assertNoRawTokenReturned(value, rawToken) {
  if (containsRawToken(value, rawToken)) {
    throw new Error('PSP callback result must not include raw token');
  }
  return value;
}

function containsRawToken(value, rawToken, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return value.includes(rawToken);
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8').includes(rawToken);
  }

  if (value instanceof Error) {
    if (seen.has(value)) return false;
    seen.add(value);
    // Codex P1: scan message, the NON-ENUMERABLE stack, the cause chain, AND enumerable own props.
    // A callback can throw `new Error("safe", { cause: new Error(token) })` or carry the token in stack.
    if (typeof value.message === 'string' && value.message.includes(rawToken)) return true;
    if (typeof value.stack === 'string' && value.stack.includes(rawToken)) return true;
    if (value.cause !== undefined && containsRawToken(value.cause, rawToken, seen)) return true;
    return containsRawToken({ ...value }, rawToken, seen);
  }

  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  // Codex P1: scan KEYS as well as values — `{ [token]: 'x' }` must be caught.
  return Object.entries(value).some(
    ([key, nested]) => key.includes(rawToken) || containsRawToken(nested, rawToken, seen),
  );
}

function isPromiseLike(value) {
  return value && typeof value.then === 'function';
}

function encryptToken(key, token, recordBase) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(recordAad(recordBase));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptToken(key, record) {
  const encrypted = record.encrypted_token;
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAAD(recordAad(record));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function recordAad(record) {
  // key_ref is bound into the AAD so ciphertext cannot be replayed under a different key.
  return Buffer.from([
    record.vault_ref,
    record.user_ref,
    record.psp,
    record.type,
    record.mandate_ref || '',
    record.expiresAt || '',
    record.key_ref || '',
  ].join('\0'), 'utf8');
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalString(value, name) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function normalizeExpiresAt(value) {
  if (value == null) return undefined;
  const ms = coerceTimeMs(value);
  return new Date(ms).toISOString();
}

function coerceTimeMs(value) {
  const ms = value instanceof Date ? value.getTime() : (typeof value === 'string' ? Date.parse(value) : Number(value));
  if (!Number.isFinite(ms)) throw new Error('time value is invalid');
  return ms;
}
