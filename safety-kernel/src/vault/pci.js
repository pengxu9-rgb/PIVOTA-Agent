import { redact } from '../redact.js';

const PAN_SEPARATOR_CHARS = ' \\t\\r\\n.-';
const PAN_CANDIDATE_RE = new RegExp(
  `(?<!\\d)(?<!\\d[${PAN_SEPARATOR_CHARS}])(?:\\d[${PAN_SEPARATOR_CHARS}]?){12,18}\\d(?![${PAN_SEPARATOR_CHARS}]?\\d)`,
  'g',
);

const VAULT_LOG_SECRET_KEYS = new Set([
  'auth_tag',
  'authtag',
  'ciphertext',
  'decrypt_handle',
  'decrypthandle',
  'encrypted_token',
  'encryptedtoken',
  'encryption_key',
  'encryptionkey',
  'iv',
  'mandate_ref',
  'mandateref',
  'token_decrypt_handle',
  'tokendecrypthandle',
  'vault_ref',
  'vaultref',
]);

export const PCI_SCOPE_NOTES = `Pivota stays on the intended SAQ-A boundary by never accepting,
storing, returning, or logging PAN/CVV data. The vault may store only PSP-issued payment
tokens, handles, and mandate references, encrypted at rest and bound to a user_ref.
Production encryption keys must come from KMS or a secret manager, not source code.`;

/**
 * Fail closed if a value contains a Luhn-valid PAN-like digit sequence.
 * The thrown error intentionally omits the candidate value.
 *
 * @param {unknown} value
 * @returns {true}
 */
export function assertNoPan(value) {
  const seen = new WeakSet();

  const visit = (candidate) => {
    if (candidate == null) return;

    if (typeof candidate === 'string') {
      assertStringHasNoPan(candidate);
      return;
    }

    if (typeof candidate === 'number' || typeof candidate === 'bigint') {
      assertStringHasNoPan(String(candidate));
      return;
    }

    if (typeof candidate !== 'object') return;
    if (seen.has(candidate)) return;
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }

    for (const [key, item] of Object.entries(candidate)) {
      assertStringHasNoPan(key);
      visit(item);
    }
  };

  visit(value);
  return true;
}

/**
 * Redact with the kernel's normal posture, plus vault-specific handles and
 * encrypted payload fields that should not appear near a vault_ref in logs.
 *
 * @param {unknown} obj
 * @returns {unknown}
 */
export function scrubForLog(obj) {
  return scrubVaultFields(redact(obj));
}

function assertStringHasNoPan(value) {
  PAN_CANDIDATE_RE.lastIndex = 0;
  let match;
  while ((match = PAN_CANDIDATE_RE.exec(value)) !== null) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      throw new Error('PAN-like payment value is not allowed');
    }
  }
}

function luhnValid(digits) {
  let sum = 0;
  let doubleDigit = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (doubleDigit) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    doubleDigit = !doubleDigit;
  }

  return sum > 0 && sum % 10 === 0;
}

function scrubVaultFields(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'function') return '[REDACTED_FUNCTION]';
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => scrubVaultFields(item, seen));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    out[key] = VAULT_LOG_SECRET_KEYS.has(normalized) ? '[REDACTED]' : scrubVaultFields(item, seen);
  }
  return out;
}
