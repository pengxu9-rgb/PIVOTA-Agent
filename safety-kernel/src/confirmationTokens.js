// C2 — Confirmation token service. Implements INV-3 (explicit user confirmation).
// A token is minted ONLY by this service (server-side), after the host UI reports the
// user acted on the quote/confirmation card. The model cannot forge one: tokens are
// HMAC-signed and bound to (order_id, user_ref, amount, currency), single-use, short-lived.
//
// Single-use is enforced via KvStore.putIfAbsent on the token's jti — ATOMIC across instances, so a
// token cannot be redeemed twice even under concurrent requests on different processes.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PivotaCommerceError } from './errors.js';
import { InMemoryKvStore } from './stores.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class ConfirmationTokenService {
  /** @param {{secret:string, store?:object, ttlMs?:number, now?:()=>number}} opts */
  constructor({ secret, store, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() }) {
    if (!secret || secret.length < 16) throw new Error('ConfirmationTokenService requires a strong secret');
    this._secret = secret;
    this._ttlMs = ttlMs;
    this._now = now;
    this._store = store || new InMemoryKvStore({ now });
  }

  _sign(payload) {
    return createHmac('sha256', this._secret).update(payload).digest('hex');
  }

  /**
   * Mint a token bound to the exact amount the user confirmed.
   * @param {{order_id:string, user_ref:string, amount:number, currency:string}} binding
   */
  mint(binding) {
    const jti = randomUUID();
    const exp = this._now() + this._ttlMs;
    const body = `${binding.order_id}|${binding.user_ref}|${binding.amount}|${binding.currency}|${jti}|${exp}`;
    return `${Buffer.from(body).toString('base64url')}.${this._sign(body)}`;
  }

  /**
   * Verify + consume a token against the live charge binding. Throws on any mismatch.
   * Single-use is enforced atomically: the jti is claimed via putIfAbsent; a second redemption loses.
   * @param {string} token
   * @param {{order_id:string, user_ref:string, amount:number, currency:string}} binding
   */
  async verifyAndConsume(token, binding) {
    if (!token || typeof token !== 'string' || !token.includes('.')) {
      throw new PivotaCommerceError('CONFIRMATION_REQUIRED');
    }
    const [b64, sig] = token.split('.');
    const body = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = this._sign(body);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'bad_signature' });
    }
    const [order_id, user_ref, amountStr, currency, jti, expStr] = body.split('|');
    const exp = Number(expStr);
    if (this._now() > exp) throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'expired' });
    // Binding must match the live charge EXACTLY — this is what ties confirmation to amount.
    // Checked BEFORE consuming so a binding-mismatch attempt does not burn the token.
    if (
      order_id !== binding.order_id ||
      user_ref !== binding.user_ref ||
      Number(amountStr) !== binding.amount ||
      currency !== binding.currency
    ) {
      throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'binding_mismatch' });
    }
    // ATOMIC single-use: first redemption claims the jti; any later one loses and is rejected.
    // TTL bounds growth — the row self-expires shortly after the token would have expired anyway.
    const claimed = await this._store.putIfAbsent(`jti:${jti}`, 1, { ttlMs: Math.max(1, exp - this._now()) });
    if (!claimed) throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'already_used' });
    return true;
  }
}
