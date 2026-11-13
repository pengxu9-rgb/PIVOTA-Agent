// C2 — Quote registry. Implements INV-1 (quote-first), INV-5 (price/tax/ship & MoR lock).
// Backed by a KvStore (safety-kernel/src/stores.js): InMemoryKvStore by default, PostgresKvStore in
// production via the mount's storeFactory. All methods are async (durable backends are I/O).

import { randomUUID } from 'node:crypto';
import { PivotaCommerceError } from './errors.js';
import { InMemoryKvStore } from './stores.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Store records past their logical expiry briefly so resolveForOrder can return the precise
// QUOTE_EXPIRED (vs QUOTE_NOT_FOUND) error before the row is swept.
const EXPIRY_GRACE_MS = 5 * 60 * 1000;

/** `{ market, market_currency }` when both are well formed (ISO 3166-1 alpha-2, ISO 4217, upper case), else null. */
function boundMarketOf(value) {
  if (!value || typeof value !== 'object') return null;
  const { market, market_currency } = value;
  if (typeof market !== 'string' || !/^[A-Z]{2}$/.test(market)) return null;
  if (typeof market_currency !== 'string' || !/^[A-Z]{3}$/.test(market_currency)) return null;
  return { market, market_currency };
}

export class QuoteRegistry {
  /** @param {{store?: object, ttlMs?: number, now?: () => number}} [opts] */
  constructor({ store, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this._ttlMs = ttlMs;
    this._now = now;
    this._store = store || new InMemoryKvStore({ now });
  }

  /**
   * Persist a quote returned by the upstream pricing call as an immutable snapshot.
   * The snapshot — NOT the model — is the source of truth for the charge.
   */
  async issue(input) {
    // THE MARKET A SESSION IS FOR (`input.market`, `{ market, market_currency }`, only when the checkout named one)
    // is kept on the snapshot, so a later re-quote of this session is judged for the same market (the executor's
    // update case). A snapshot bound to a market is in that market's currency BY CONSTRUCTION: one that is not is
    // never stored, whatever the caller checked before, so no reader of a session (a read, a completion, a payment
    // link) can be handed a market-bound quote in another currency. Absent: nothing is recorded, nothing assumed.
    // This runs only for a quote a caller handed in WITH a market, that is, only on a call the market rule judged;
    // every other quote is stored exactly as before, with no check. The refusal is the rule's own, by name and not
    // retriable: the caller's own check should have given it first, so this is the same answer, not a new one.
    const bound = boundMarketOf(input.market);
    if (bound && input.currency !== bound.market_currency) {
      const reason = 'seller_not_priced_in_market_currency';
      const sellerCurrency = typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency) ? input.currency : null;
      throw new PivotaCommerceError('NO_MERCHANT_OFFER', {
        reason,
        acp_message: `No price can be stated for a buyer in ${bound.market} for this checkout: its seller is priced in ${sellerCurrency || 'another currency'}, and a price for ${bound.market} must be in ${bound.market_currency}. Nothing was converted or relabelled, and no checkout session was stored. This will not change on retry; offer the buyer alternatives priced for ${bound.market}.`,
        acp_detail: { reason, market: bound.market, market_currency: bound.market_currency, ...(sellerCurrency ? { seller_currencies: [sellerCurrency] } : {}) },
      });
    }
    const quote_id = `q_${randomUUID()}`;
    const issued_at = this._now();
    const snapshot = {
      quote_id,
      user_ref: input.user_ref,
      acp_session_id: input.acp_session_id,
      merchant_of_record: input.merchant_of_record,
      currency: input.currency,
      upstream_quote_id: input.upstream_quote_id,
      locked_totals: { ...input.locked_totals },
      line_items: (input.line_items || []).map((i) => ({ ...i })),
      buyer_context: input.buyer_context && typeof input.buyer_context === 'object'
        ? {
            ...input.buyer_context,
            shipping_address: input.buyer_context.shipping_address && typeof input.buyer_context.shipping_address === 'object'
              ? { ...input.buyer_context.shipping_address }
              : undefined,
          }
        : undefined,
      ...(bound || {}),
      issued_at,
      expires_at: issued_at + this._ttlMs,
    };
    await this._store.set(quote_id, snapshot, { ttlMs: this._ttlMs + EXPIRY_GRACE_MS });
    return Object.freeze(snapshot);
  }

  /**
   * The market a session of THIS buyer was created for: `{ market, market_currency }`, or null. Null for an id that
   * names no stored session, for a session that is another buyer's or another ACP session's (nothing about it is
   * said), and for a session that recorded no market. Reads the one record and nothing else; never throws for an
   * unknown or expired id (what an update does with such an id is the caller's rule, not this method's).
   */
  async sessionMarket(quote_id, ctx) {
    if (typeof quote_id !== 'string' || quote_id === '') return null;
    const q = await this._store.get(quote_id);
    if (!q || !ctx || q.user_ref !== ctx.user_ref || q.acp_session_id !== ctx.acp_session_id) return null;
    return boundMarketOf(q);
  }

  /**
   * Resolve a quote for an order, enforcing existence, expiry, and linkage (INV-1 + §6).
   * @returns {Promise<object>} the snapshot
   */
  async resolveForOrder(quote_id, ctx) {
    if (!quote_id) throw new PivotaCommerceError('QUOTE_REQUIRED');
    const q = await this._store.get(quote_id);
    if (!q) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { quote_id });
    // Logical expiry is checked against the snapshot (precise error) even though the store row may
    // still be within its grace window.
    if (this._now() > q.expires_at) throw new PivotaCommerceError('QUOTE_EXPIRED', { quote_id });
    // Linkage: a quote belongs to one user and one ACP session. No cross-mixing.
    if (q.user_ref !== ctx.user_ref || q.acp_session_id !== ctx.acp_session_id) {
      throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { quote_id });
    }
    return q;
  }
}
