// C2 — Commerce Safety Kernel orchestrator.
// Ties INV-1..INV-5 together around the money path. Sits between the platform adapters
// and the existing Celestial core (the canonical POST /agent/shop/v1/invoke upstream).
//
// The kernel is transport-agnostic: you inject an `upstream(operation, payload, headers)`
// function that actually performs the authenticated canonical invoke. The kernel never
// calls /agent/gateway or /api/gateway (rail rule, §8).

import { QuoteRegistry } from './quoteRegistry.js';
import { IdempotencyLedger } from './idempotencyLedger.js';
import { ConfirmationTokenService } from './confirmationTokens.js';
import { PivotaCommerceError } from './errors.js';
import { redact } from './redact.js';
import { InMemoryKvStore } from './stores.js';
import { sameMinor, violatesChargeMultiple } from './money.js';

const AMOUNT_TOLERANCE = 0; // zero tolerance — INV-2

// The per-order charge lock must outlive the slowest synchronous submit_payment CALL (the async
// completion happens later via webhook, NOT under this lock). 2 min comfortably exceeds an upstream
// charge-call timeout while bounding a crashed holder.
const CHARGE_LOCK_TTL_MS = 2 * 60 * 1000;
export const IDEMPOTENT_REPLAY_MARKER = Symbol.for('pivota.safety_kernel.idempotent_replay');

function markIdempotentReplay(result, replayed) {
  if (replayed && result && typeof result === 'object' && Object.isExtensible(result)) {
    Object.defineProperty(result, IDEMPOTENT_REPLAY_MARKER, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  return result;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeBuyerAddress(value) {
  if (!isPlainObject(value)) return undefined;
  const out = {
    ...value,
    name: firstNonEmpty(value.name, value.recipient_name, value.recipientName),
    recipient_name: firstNonEmpty(value.recipient_name, value.recipientName, value.name),
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined || out[key] === null || out[key] === '') delete out[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeBuyerContext(value) {
  if (!isPlainObject(value)) return undefined;
  const out = {
    customer_email: firstNonEmpty(value.customer_email, value.customerEmail),
    customer_name: firstNonEmpty(value.customer_name, value.customerName),
    shipping_address: normalizeBuyerAddress(value.shipping_address),
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined || out[key] === null) delete out[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function buyerContextFromQuotePayload(payload) {
  const quote = isPlainObject(payload?.quote) ? payload.quote : {};
  return normalizeBuyerContext({
    customer_email: quote.customer_email ?? payload?.customer_email,
    customer_name: quote.customer_name ?? payload?.customer_name,
    shipping_address: quote.shipping_address ?? payload?.shipping_address,
  });
}

// Map a backend payment_status to a coarse class for the order state machine.
// success → terminal paid; failure → terminal failed (retry allowed); in_flight → charge_pending
// (completes via webhook). Unknown/missing is treated as in_flight (fail SAFE: keep the order locked
// against re-charge until a definitive webhook resolves it).
const PAYMENT_SUCCESS = new Set(['succeeded', 'success', 'paid', 'captured', 'complete', 'completed']);
const PAYMENT_FAILURE = new Set(['payment_failed', 'failed', 'declined', 'canceled', 'cancelled', 'error', 'voided']);
export function classifyPaymentStatus(status) {
  const s = String(status || '').toLowerCase();
  if (PAYMENT_SUCCESS.has(s)) return 'success';
  if (PAYMENT_FAILURE.has(s)) return 'failure';
  return 'in_flight'; // processing, requires_action, pending, unknown, '' → keep the order locked
}

export class SafetyKernel {
  /**
   * @param {{
   *   upstream: (operation:string, payload:object, headers?:object) => Promise<any>,
   *   secret: string,
   *   log?: { info:Function, warn:Function, error:Function },
   *   quoteTtlMs?: number, confirmationTtlMs?: number, now?: ()=>number
   * }} deps
   */
  constructor({ upstream, secret, log = console, quoteTtlMs, confirmationTtlMs, afterSalesSupported, storeFactory = null, now = () => Date.now(), requireBackendAmount = false }) {
    if (typeof upstream !== 'function') throw new Error('SafetyKernel requires an upstream() function');
    this._upstream = upstream;
    this._log = log;
    this._now = now;
    // Codex: on the confirmed-real money path the backend ALWAYS returns an order amount+currency, so a
    // create_order response that omits it is a schema regression — fail closed rather than silently skip
    // the units cross-check. (Left off for plain/legacy upstreams + unit tests that stub a bare order.)
    this._requireBackendAmount = requireBackendAmount;
    // storeFactory(namespace) -> KvStore (safety-kernel/src/stores.js). Each stateful component gets
    // its OWN namespace so a durable backend (PostgresKvStore) keeps them isolated. When no factory is
    // provided, each component defaults to its own InMemoryKvStore — identical single-process behavior.
    this._storeFactory = storeFactory;
    const store = (ns) => (storeFactory ? storeFactory(ns) : undefined);
    // Default: only 'refund' is wired upstream (per pivota-api-mapping.md). Override per merchant.
    this._afterSalesSupported = afterSalesSupported || new Set(['refund']);
    this.quotes = new QuoteRegistry({ store: store('quotes'), ttlMs: quoteTtlMs, now });
    this.idempotency = new IdempotencyLedger({ store: store('idempotency'), now });
    this.confirmations = new ConfirmationTokenService({ secret, store: store('confirmations'), ttlMs: confirmationTtlMs, now });
    // Order registry (fixes Codex B1/B2): the kernel persists the authoritative amount per order so
    // submit_payment NEVER trusts a caller-supplied amount. Now durable-backed via the store seam.
    this._orderStore = store('orders') || new InMemoryKvStore({ now });
    // Single-use quote claim (INV-1): a quote backs exactly ONE order. createOrder claims the quote_id
    // atomically (putIfAbsent) so a SECOND createOrder on the same session — a DIFFERENT idempotency key,
    // which a same-key retry never reaches because the ledger short-circuits first — cannot mint a second
    // order from one locked quote and double-charge.
    this._quoteClaims = store('quote_claims') || new InMemoryKvStore({ now });
  }

  _requireUser(ctx) {
    if (!ctx || !ctx.user_ref) throw new PivotaCommerceError('USER_AUTH_REQUIRED');
    // Codex P1-3: require an explicit ACP session so linkage checks can never degrade to
    // `undefined === undefined` (which would silently disable cross-session protection).
    if (!ctx.acp_session_id) throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { reason: 'missing_acp_session' });
  }

  /** preview_quote: call upstream, then snapshot the LOCKED result into the registry. */
  async previewQuote(payload, ctx) {
    this._requireUser(ctx);
    const upstreamResult = await this._upstream('preview_quote', payload);
    // Fix Codex S4: fail closed if upstream did not return a well-formed locked quote,
    // rather than snapshotting undefined totals.
    const lt = upstreamResult?.locked_totals;
    // Codex #7: reject not just missing totals but non-finite / negative ones.
    // Codex P1-4: enforce the canonical integer-MINOR-unit invariant at the kernel boundary, so a
    // bypassed/misconfigured adapter cannot inject a fractional total (e.g. 95.5) that would propagate
    // through the charge as a non-integer minor amount. total is required; present components must also be
    // safe non-negative integers.
    const isMinorInt = (n) => Number.isSafeInteger(n) && n >= 0;
    if (
      !upstreamResult?.currency ||
      !upstreamResult?.merchant_of_record ||
      !lt || !isMinorInt(lt.total) ||
      [lt.subtotal, lt.tax, lt.shipping].some((c) => c !== undefined && !isMinorInt(c))
    ) {
      throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'malformed_upstream_quote' });
    }
    // Canonicalize the currency to UPPERCASE so every downstream compare (cross-check + submit echo) and
    // the confirmation-token binding are case-insensitive (the adapter does this too; enforce here so a
    // bypassed/raw upstream can't desync casing).
    const currency = String(upstreamResult.currency).toUpperCase();
    // Codex round-2 P2: enforce the PSP CHARGE divisibility constraint at the earliest point (before any
    // order side effect). No-op for USD (multiple of 1); rejects e.g. a fractional-major UGX/ISK total or
    // a 3-decimal amount not a multiple of 10 — which would pass quote/order/confirmation and then fail at
    // the PSP, leaving an orphaned charge_pending order.
    if (violatesChargeMultiple(lt.total, currency)) {
      throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'unchargeable_amount_for_currency', currency });
    }
    // Trust the upstream's authoritative pricing, not the model's payload.
    const snapshot = await this.quotes.issue({
      user_ref: ctx.user_ref,
      acp_session_id: ctx.acp_session_id,
      upstream_quote_id: upstreamResult.quote_id,
      merchant_of_record: upstreamResult.merchant_of_record,
      currency, // canonical UPPERCASE
      locked_totals: upstreamResult.locked_totals,
      line_items: upstreamResult.line_items,
      buyer_context: buyerContextFromQuotePayload(payload),
    });
    return {
      quote_id: snapshot.quote_id,
      expires_at: new Date(snapshot.expires_at).toISOString(),
      currency: snapshot.currency,
      merchant_of_record: snapshot.merchant_of_record,
      locked_totals: snapshot.locked_totals,
      line_items: snapshot.line_items,
      acp_state: upstreamResult.acp_state,
    };
  }

  /** create_order: INV-1 (quote required), INV-4 (idempotent), INV-5 (amount from snapshot). */
  async createOrder(payload, ctx) {
    this._requireUser(ctx);
    const key = payload?.idempotency_key;

    // Codex P0/P1 fix: the idempotency ledger is the OUTERMOST layer. A replay of a
    // succeeded order short-circuits to the cached result BEFORE quote resolution, so a
    // same-key retry after the quote has expired returns the original order, not QUOTE_EXPIRED.
    // The fingerprint is the full order body (incl. quote_id) so a different body conflicts.
    const { result, replayed } = await this.idempotency.run(
      key,
      { op: 'create_order', order: payload?.order ?? null },
      async (runCtx) => {
        const quote = await this.quotes.resolveForOrder(payload?.order?.quote_id, ctx);
        // INV-1 single-use: claim the quote atomically. A same-key retry short-circuits in the idempotency
        // ledger above and never reaches here, so a failed claim means a DIFFERENT request already turned
        // this quote into an order — refuse, so one locked quote can never become two orders (double charge).
        const claimedQuote = await this._quoteClaims.putIfAbsent(quote.quote_id, { idempotency_key: key });
        if (!claimedQuote) throw new PivotaCommerceError('QUOTE_ALREADY_USED', { quote_id: quote.quote_id });
        const lockedBuyerContext = normalizeBuyerContext(quote.buyer_context);
        const requestedBuyerContext = normalizeBuyerContext(payload.order);
        const lockedShipping = lockedBuyerContext && lockedBuyerContext.shipping_address;
        const requestedShipping = requestedBuyerContext && requestedBuyerContext.shipping_address;
        const buyerContext = {
          ...(requestedBuyerContext || {}),
          ...(lockedBuyerContext || {}),
          shipping_address: lockedShipping || requestedShipping
            ? { ...(requestedShipping || {}), ...(lockedShipping || {}) }
            : payload.order?.shipping_address,
        };
        // Pricing is forced from the snapshot; model-supplied amounts are ignored.
        const upstreamPayload = {
          ...payload,
          order: {
            ...payload.order,
            customer_email: buyerContext.customer_email ?? payload.order?.customer_email,
            customer_name: buyerContext.customer_name ?? payload.order?.customer_name,
            shipping_address: buyerContext.shipping_address ?? payload.order?.shipping_address,
            quote_id: quote.upstream_quote_id || quote.quote_id,
            _kernel_quote_id: quote.quote_id,
            _locked_totals: quote.locked_totals,
            _currency: quote.currency,
            _merchant_of_record: quote.merchant_of_record,
          },
        };
        const r = await this._upstream('create_order', upstreamPayload, { 'Idempotency-Key': key });
        runCtx.sideEffectDone = true; // order created upstream — past this point, failures are ambiguous
        // MONEY-UNITS CROSS-CHECK: the quote snapshot and the backend's own order are two INDEPENDENT
        // sources of the same money. Both are MINOR units (the adapter converts the quote; the backend
        // amount is already minor). Disagreement is most dangerously a major/minor confusion that would
        // mis-charge ~100×. Fail CLOSED before any charge. (The charge still uses the quote snapshot —
        // INV-5; this only detects, never becomes a charge source.)
        // Helper: a post-create failure happens AFTER the upstream order exists. Emit a traceable signal
        // (with the upstream order_id) so ops can reconcile/void the orphan — the idempotency ledger marks
        // this key 'ambiguous' (no same-key retry) and the order is unpayable via the kernel (no stored
        // record), but a compensating upstream cancel is a go-live requirement (needs the backend cancel
        // API). Codex round-2 P2.
        const failPostCreate = (reason, extra = {}) => {
          this._log.warn?.('order_units_mismatch_orphan', redact({ reason, upstream_order_id: r.order_id, ...extra }));
          throw new PivotaCommerceError('PRICE_CHANGED', { reason, ...extra });
        };
        const backendCurrency = r.backend_currency != null ? String(r.backend_currency).toUpperCase() : null;
        // Codex: on the real money path the backend always returns an amount; its absence is a schema
        // regression that would silently disable the units cross-check — fail closed.
        if (this._requireBackendAmount && !r.backend_amount_present) {
          failPostCreate('backend_amount_missing');
        }
        if (r.backend_amount_present) {
          // Codex P1-2: a surfaced-but-unparseable amount (e.g. a major-decimal "95.00") must FAIL CLOSED,
          // not silently skip the check — that shape is exactly what the guard exists to catch.
          if (r.backend_amount_minor == null) failPostCreate('backend_amount_unparseable');
          if (!sameMinor(r.backend_amount_minor, quote.locked_totals.total)) {
            failPostCreate('amount_units_mismatch', { quote_total_minor: quote.locked_totals.total, backend_amount_minor: r.backend_amount_minor });
          }
          // Codex round-2 P1: when the backend gives us an AMOUNT to verify, it must also give a CURRENCY —
          // otherwise we cannot confirm the amount is in the quote's currency (a same-number order in a
          // different currency would slip through). Fail CLOSED on a missing currency for a charged amount.
          if (backendCurrency == null) failPostCreate('backend_currency_missing');
        }
        // Codex P0-2: amounts can match while the CURRENCY differs (9500 USD quote vs a backend order the
        // backend reports as 9500 JPY). Compare canonical UPPERCASE (round-2 P2) and fail CLOSED.
        if (backendCurrency != null && backendCurrency !== quote.currency) {
          failPostCreate('currency_mismatch', { quote_currency: quote.currency, backend_currency: backendCurrency });
        }
        // Persist the authoritative amount server-side (fix B2). This is the ONLY
        // source submit_payment will trust for the charge.
        await this._orderStore.set(r.order_id, {
          amount: quote.locked_totals.total,
          currency: quote.currency,
          quote_id: quote.quote_id,
          user_ref: ctx.user_ref,
          // T7 (Codex): bind the order to the creating ACP session + agent, so a reused token in a DIFFERENT
          // session/platform cannot resolve/confirm/pay this order even if it has the order_id. acp_session_id
          // is always present (required by _requireUser); agent_id is bound when the caller provides it.
          acp_session_id: ctx.acp_session_id,
          agent_id: ctx.agent_id ?? null,
          merchant_of_record: quote.merchant_of_record,
          status: 'created',
        });
        return {
          order_id: r.order_id,
          amount_total: quote.locked_totals.total, // authoritative
          currency: quote.currency,
          merchant_of_record: quote.merchant_of_record,
          confirmation_required: true,
          acp_state: r.acp_state,
        };
      },
    );
    if (replayed) this._log.info?.('idempotent_replay', redact({ op: 'create_order', key }));
    return markIdempotentReplay(result, replayed);
  }

  /** Look up an order's authoritative record, enforcing ownership. */
  async _requireOrder(order_id, ctx) {
    const o = await this._orderStore.get(order_id);
    if (!o) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'order_not_found', order_id });
    if (o.user_ref !== ctx.user_ref) throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { order_id, reason: 'user_mismatch' });
    // T7 (Codex): cross-user is blocked above; also block same-user WRONG-session/agent access (a reused
    // token in another conversation/platform). Compare only when bound on the order (legacy orders without
    // these stamps skip the check), and only when the ctx supplies the value.
    if (o.acp_session_id != null && ctx.acp_session_id != null && o.acp_session_id !== ctx.acp_session_id) {
      throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { order_id, reason: 'acp_session_mismatch' });
    }
    if (o.agent_id != null && ctx.agent_id != null && o.agent_id !== ctx.agent_id) {
      throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { order_id, reason: 'agent_mismatch' });
    }
    return o;
  }

  /**
   * Mint a confirmation token. Called by the adapter/host AFTER the user acts on the
   * confirmation card — never by the model. The amount/currency are read from the
   * server-side order record (fix B1), NOT from the caller, so the token can only ever
   * bind to the true charge.
   */
  async mintConfirmation({ order_id }, ctx) {
    this._requireUser(ctx);
    const order = await this._requireOrder(order_id, ctx);
    // Defense in depth (Codex P0): never mint a confirmation for a TERMINAL order — 'paid' (already charged)
    // or 'canceled' (voided) — so a token can't bind a charge to an order the charge guard would reject.
    // 'charge_pending' is intentionally allowed: the requires_action flow re-mints while a charge is in
    // flight (the webhook, not a second submit, finalizes it); submitPayment's own allowlist blocks a
    // second charge on 'charge_pending'.
    if (order.status === 'paid' || order.status === 'canceled') {
      throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { reason: `not_confirmable:${order.status}`, order_id });
    }
    return this.confirmations.mint({ order_id, user_ref: ctx.user_ref, amount: order.amount, currency: order.currency });
  }

  /** submit_payment: INV-2 (amount verify), INV-3 (confirmation), INV-4 (idempotent). */
  async submitPayment(payload, ctx) {
    this._requireUser(ctx);
    const p = payload?.payment || {};
    const order_id = p.order_id;
    if (!order_id) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'missing_order_id' });

    const key = payload?.idempotency_key;
    // Codex P0 fix: ledger is the OUTERMOST layer. A same-key replay of a succeeded payment
    // returns the cached result WITHOUT re-consuming the (single-use) confirmation token, so a
    // network-timeout retry no longer fails with CONFIRMATION_INVALID. The amount check and
    // token consume happen only on first execution, inside the op. Codex P1: the fingerprint is
    // the full payment body so a different body (currency, handler, return_url, ...) conflicts.
    const { result, replayed } = await this.idempotency.run(
      key,
      { op: 'submit_payment', payment: p, confirmation_token: payload?.confirmation_token ?? null },
      async (runCtx) => {
        // Payment re-model — LOCK FIRST. The atomic per-order charge lock is acquired BEFORE reading
        // the order, so the status guard below is evaluated under the lock (closes a TOCTOU where a
        // submit that read status='created' earlier could re-charge after a prior submit finished).
        const lockKey = `charge-lock:${order_id}`;
        const gotLock = await this._orderStore.putIfAbsent(lockKey, { owner: key }, { ttlMs: CHARGE_LOCK_TTL_MS });
        if (!gotLock) {
          throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { reason: 'charge_in_progress', order_id });
        }
        try {
          // INV-2 (fix B1): the charge amount is read from the kernel's OWN order record,
          // never from the caller/adapter/model.
          const order = await this._requireOrder(order_id, ctx);
          const authoritativeAmount = order.amount;
          const authoritativeCurrency = order.currency;

          // Charge-once per ORDER. 'paid' = terminal success; 'charge_pending' = a charge is in flight
          // (async checkout-session / client-confirmation, completing via webhook). Both block a new
          // submit. Only 'created' and 'failed' (retry-after-failure) admit one.
          if (order.status === 'paid') {
            throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { reason: 'order_already_paid', order_id });
          }
          if (order.status === 'charge_pending') {
            throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { reason: 'charge_pending', order_id });
          }
          // Codex P0: the two guards above are a DENYLIST — a 'canceled' order (written by
          // cancel_checkout_session) or any unknown status would otherwise slip through and be charged.
          // ALLOWLIST instead: only 'created' (first charge) and 'failed' (retry after a declined charge)
          // are payable; everything else fails CLOSED.
          if (order.status !== 'created' && order.status !== 'failed') {
            throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { reason: `not_payable:${order.status}`, order_id });
          }

          // Fix S3: fail closed. expected_amount is a required echo; absence or mismatch rejects.
          // Codex P2-2: require a SAFE INTEGER (minor units), not merely typeof 'number' — otherwise NaN
          // passes the type check AND `Math.abs(NaN - x) > 0` is false, so a NaN echo would slip through
          // the comparison in-process (the HTTP validator catches it, but the kernel invariant must too).
          if (!Number.isSafeInteger(p.expected_amount)) {
            throw new PivotaCommerceError('PRICE_CHANGED', { reason: 'missing_expected_amount' });
          }
          if (Math.abs(p.expected_amount - authoritativeAmount) > AMOUNT_TOLERANCE) {
            throw new PivotaCommerceError('PRICE_CHANGED', { expected: p.expected_amount });
          }
          // Codex P0-1: INV-2 covers amount AND currency.
          // Compare canonical UPPERCASE (round-2 P2): the stored currency is uppercase, and a caller may
          // echo "usd"; a raw compare would falsely reject it.
          const echoCurrency = typeof p.currency === 'string' ? p.currency.toUpperCase() : p.currency;
          if (echoCurrency !== authoritativeCurrency) {
            throw new PivotaCommerceError('PRICE_CHANGED', { reason: 'currency_mismatch' });
          }

          // INV-3: confirmation token must validate against the live charge binding.
          await this.confirmations.verifyAndConsume(payload?.confirmation_token, {
            order_id,
            user_ref: ctx.user_ref,
            amount: authoritativeAmount,
            currency: authoritativeCurrency,
          });

          // Codex P0-1/P0-2 fix: write the DURABLE 'charge_pending' status (with this attempt's id)
          // BEFORE the charge call. This makes the durable status — not the ephemeral lock — the
          // guard, so a slow charge that outlives CHARGE_LOCK_TTL_MS, or a timeout AFTER the PSP
          // accepted, cannot reopen the order for a second charge: any retry now sees 'charge_pending'
          // and is rejected. If the charge throws, the order STAYS 'charge_pending' (fail closed —
          // reconciliation may be needed) rather than reopening.
          await this._orderStore.set(order_id, { ...order, status: 'charge_pending', attempt: key, payment_id: null, charge_pending_at: this._now() });
          runCtx.sideEffectDone = true; // from here, a failure is AMBIGUOUS (a charge may have landed)

          // Codex P0-1 cont.: forward an amount/currency-pinned payment to upstream.
          const safePayment = { ...p, expected_amount: authoritativeAmount, currency: authoritativeCurrency };
          const r = await this._upstream('submit_payment', { ...payload, payment: safePayment }, { 'Idempotency-Key': key });

          // Charge call returned. Finalize the state machine + record this attempt's payment_id so the
          // webhook can correlate (reject a stale webhook for a previous attempt).
          const cls = classifyPaymentStatus(r.payment_status);
          const newStatus = cls === 'success' ? 'paid' : cls === 'failure' ? 'failed' : 'charge_pending';
          // Codex P1-2: do NOT blindly overwrite with the stale snapshot. Re-read; only write if the
          // order is still 'charge_pending' for THIS attempt. If a webhook/reconcile already resolved it
          // (e.g. an early success webhook), honor that terminal state instead of reopening it.
          const cur = await this._orderStore.get(order_id);
          if (cur && cur.status === 'charge_pending' && cur.attempt === key) {
            await this._orderStore.set(order_id, { ...cur, status: newStatus, payment_id: r.payment_id ?? cur.payment_id ?? null, charge_pending_at: newStatus === 'charge_pending' ? this._now() : undefined });
          }

          // Surface the client-confirmation hand-off verbatim (never fabricate). When the charge is
          // pending and confirmation_owner=client, the adapter UI completes it via client_secret /
          // payment_action; the kernel does NOT mark paid here — it waits for the webhook.
          return {
            payment_id: r.payment_id,
            payment_status: r.payment_status,
            order_status: newStatus,
            confirmation_owner: r.confirmation_owner,
            requires_client_confirmation: r.requires_client_confirmation,
            redirect_url: r.redirect_url,
            client_secret: r.client_secret, // sensitive — adapters must not log
            qr_code: r.qr_code,
            instructions: r.instructions,
            ap2_state: r.ap2_state, // sensitive — adapters must not log
          };
        } finally {
          // The lock's only job is to serialize THIS submit's execution. Once the durable order status
          // is written (paid/charge_pending/failed), that status is the guard — so release the lock.
          await this._orderStore.compareAndDelete(lockKey, 'owner', key);
        }
      },
    );
    if (replayed) this._log.info?.('idempotent_replay', redact({ op: 'submit_payment', key }));
    return markIdempotentReplay(result, replayed);
  }

  /**
   * Payment re-model — webhook ingestion. The real charge completes ASYNCHRONOUSLY: submit_payment
   * returns processing/requires_action, and the PSP/backend later sends a webhook with the terminal
   * outcome. This method transitions the order to paid/failed.
   *
   * The CALLER MUST verify the webhook signature BEFORE calling this (the kernel trusts the event is
   * authentic). No user ctx — webhooks are a system/server-to-server path keyed by order_id.
   *
   * Idempotent + ordering-tolerant (webhooks retry and can arrive out of order). Codex P0-3/P1 fixes:
   * a webhook may ONLY transition an order that is currently 'charge_pending' (an active attempt), and
   * the event MUST correlate to that attempt by payment_id — so a stale webhook for a PREVIOUS attempt
   * (e.g. a failure for attempt A arriving after a retry B is already pending) cannot corrupt the live
   * attempt, and a webhook for a never-submitted 'created' order cannot mark it paid.
   *  - unknown order / not 'charge_pending' (created/failed/paid) → ignored (paid stays sticky)
   *  - payment_id present on both and mismatched                  → ignored (stale attempt)
   *  - success → 'paid' · failure → 'failed' · non-terminal → ignored (still in flight)
   *
   * @param {{ order_id: string, status: string, payment_id?: string }} event  a VERIFIED webhook event
   */
  async onPaymentWebhook(event = {}) {
    const order_id = event?.order_id;
    if (!order_id) return { ignored: true, reason: 'missing_order_id' };
    const order = await this._orderStore.get(order_id);
    if (!order) return { ignored: true, reason: 'unknown_order' };
    if (order.status === 'paid') return { idempotent: true, reason: 'already_paid' };
    // Only an actively-charging order can be transitioned by a webhook. A 'created' order was never
    // submitted; a 'failed' order's attempt is terminal — neither may be advanced by a webhook.
    if (order.status !== 'charge_pending') return { ignored: true, reason: `not_pending:${order.status}` };
    // Codex P1-1: correlation is REQUIRED, not optional. A terminal transition must PROVE it belongs to
    // the order's current PSP attempt. If we cannot correlate — the order has no recorded payment_id yet
    // (the brief in-flight window before submit's response is stored), or the event carries none, or
    // they differ — IGNORE the event. The PSP retries; reconcile catches it once payment_id is set.
    if (!order.payment_id || !event.payment_id) {
      return { ignored: true, reason: 'uncorrelated_attempt' };
    }
    if (event.payment_id !== order.payment_id) {
      return { ignored: true, reason: 'stale_attempt' };
    }

    const cls = classifyPaymentStatus(event.status);
    if (cls === 'success') {
      await this._orderStore.set(order_id, { ...order, status: 'paid' });
      await this._orderStore.delete(`charge-lock:${order_id}`);
      this._log.info?.('payment_webhook', redact({ order_id, transitioned: 'paid' }));
      return { transitioned: 'paid' };
    }
    if (cls === 'failure') {
      await this._orderStore.set(order_id, { ...order, status: 'failed' });
      await this._orderStore.delete(`charge-lock:${order_id}`);
      this._log.info?.('payment_webhook', redact({ order_id, transitioned: 'failed' }));
      return { transitioned: 'failed' };
    }
    return { ignored: true, reason: 'non_terminal_status' };
  }

  /**
   * request_after_sales: kernel-side, idempotent, ownership-enforced, and ACTION-GATED
   * (closes Codex P1-4). Only actions the merchant connector actually supports may be requested;
   * unsupported actions are refused so the model can never promise an unfulfillable outcome.
   *
   * @param {object} payload  { idempotency_key, status:{ order_id, requested_action, reason } }
   * @param {object} ctx      { user_ref, acp_session_id }
   * @param {{supportedActions?: Set<string>}} [opts]
   */
  async requestAfterSales(payload, ctx, opts = {}) {
    this._requireUser(ctx);
    const supported = opts.supportedActions || this._afterSalesSupported;
    const status = payload?.status || {};
    const order_id = status.order_id;
    if (!order_id) throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { reason: 'missing_order_id' });

    // Ownership: the order must belong to this user (reuses the order registry).
    const order = await this._requireOrder(order_id, ctx);

    // Codex P1-2: an EXPLICIT supported action is required. A missing action must NOT pass the gate,
    // because upstream defaults a missing action to refund — that would let an unspecified request
    // trigger a real refund.
    const action = status.requested_action;
    if (action === undefined || !supported.has(action)) {
      throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', {
        reason: action === undefined ? 'after_sales_action_required' : 'unsupported_after_sales_action',
        requested: action ?? null,
        supported: [...supported],
      });
    }

    const key = payload?.idempotency_key;
    const { result, replayed } = await this.idempotency.run(
      key,
      // Codex P1-3: fingerprint the FULL status body (not just action/reason) so a same-key replay
      // with a different refund body (amount, restore_inventory, etc.) conflicts instead of replaying.
      { op: 'request_after_sales', order_id, status },
      async () => {
        const r = await this._upstream('request_after_sales', payload, { 'Idempotency-Key': key });
        return {
          request_id: r.request_id,
          order_id,
          requested_action: action,
          status: r.status,
          message: r.message,
          merchant_of_record: order.merchant_of_record,
        };
      },
    );
    if (replayed) this._log.info?.('idempotent_replay', redact({ op: 'request_after_sales', key }));
    return markIdempotentReplay(result, replayed);
  }
}

export { PivotaCommerceError };
