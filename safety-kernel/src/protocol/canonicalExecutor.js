// The canonical executor — the ONE execution bridge every protocol adapter (UCP/ACP/MCP) calls. It enforces
// the canonical contract's safety flags in a single place (deny without a verified buyer; require an
// idempotency key on mutations; require verified payment authorization on complete) and routes each canonical
// operation to the kernel. Safety (INV-1..5, charge-once, ownership/T7) is therefore enforced once and never
// forked per ecosystem.
//
// The checkout-session lifecycle maps onto the kernel:
//   create/update_checkout_session -> previewQuote        (session_id == quote_id)
//   get_checkout_session           -> quotes.resolveForOrder (ownership + expiry checked)
//   complete_checkout_session      -> createOrder -> verifyPaymentAuthorization -> mintConfirmation -> submitPayment
//   cancel_checkout_session        -> mark a non-terminal kernel order canceled (best-effort)
//   get_order / request_after_sales-> get_order_status (ownership-gated) / requestAfterSales
//   search_catalog / get_product   -> upstream reads
//   start_identity_linking / exchange_payment_token -> handled at the edge (OAuth / token verify), not here

import { PivotaCommerceError } from '../errors.js';
import { canonicalOp } from './canonicalContract.js';

const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

// Namespace a caller-chosen idempotency key by the verified buyer + session. Idempotency keys are not
// globally unique across users; the ledger replays a hit BEFORE ownership is checked, so an un-scoped key
// lets one user read back another's cached result. We encode (user_ref, acp_session_id, rawKey) as a JSON
// array so the scoping is UNAMBIGUOUS regardless of field contents: a plain delimiter could collide if a
// field held it (e.g. a space inside acp_session_id re-segmenting into a different triple), and a NUL
// delimiter would break Postgres text keys. Distinct triples => distinct strings. user_ref is always present
// here (the contract required it upstream), so the base is always over the ledger min-length floor.
const scopedBaseKey = (rawKey, ctx) => JSON.stringify(['cs', ctx.user_ref ?? null, ctx.acp_session_id ?? null, rawKey ?? null]);

/**
 * @param {{
 *   kernel: object,                      // SafetyKernel
 *   upstream?: (op:string, payload:object, headers?:object) => Promise<any>,  // for reads
 *   verifyPaymentAuthorization?: (authorization:any, bound:{order_id,user_ref,amount,currency,merchant_id,checkout_session_id,ctx}) => Promise<void>,
 * }} deps
 */
export function createCanonicalExecutor({ kernel, upstream, verifyPaymentAuthorization } = {}) {
  if (!kernel || typeof kernel.previewQuote !== 'function') {
    throw new Error('createCanonicalExecutor requires a kernel');
  }

  const read = async (backendOp, payload) => {
    if (typeof upstream !== 'function') {
      throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'no_upstream_for_reads', op: backendOp });
    }
    return upstream(backendOp, payload || {});
  };

  async function execute(opId, params = {}, ctx = {}) {
    const op = canonicalOp(opId); // throws on unknown — adapters can never route an unknown op

    // --- contract-level safety enforcement (single place, all protocols) ---
    // A user-scoped op needs BOTH a verified buyer AND a verified session id. Enforcing the session id HERE
    // (not only deep in the kernel, and not only in the MCP adapter) means every executor consumer — the MCP
    // surface today, an ACP REST adapter tomorrow — gets consistent T7 (quote↔order) session binding and
    // can't be called with a buyer but no session. (Codex re-review: defense-in-depth, no direct-adapter gap.)
    if (op.requiresUserRef && !nonEmpty(ctx?.user_ref)) {
      throw new PivotaCommerceError('USER_AUTH_REQUIRED', { op: opId });
    }
    if (op.requiresUserRef && !nonEmpty(ctx?.acp_session_id)) {
      throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { op: opId, reason: 'missing_acp_session' });
    }
    if (op.mutating && !nonEmpty(params?.idempotency_key)) {
      throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { reason: 'missing_idempotency_key', op: opId });
    }

    switch (opId) {
      case 'search_catalog':
        return read('find_products', params.payload ?? params);
      case 'get_product':
        return read('get_product_detail', params.payload ?? params);

      case 'create_checkout_session':
      case 'update_checkout_session': {
        const quote = await kernel.previewQuote({ quote: params.quote ?? {} }, ctx);
        return toSession(quote);
      }

      case 'get_checkout_session': {
        if (!nonEmpty(params.session_id)) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'missing_session_id' });
        const snapshot = await kernel.quotes.resolveForOrder(params.session_id, ctx); // ownership + expiry
        return toSession(snapshot);
      }

      case 'cancel_checkout_session':
        return cancelSession(kernel, params, ctx);

      case 'complete_checkout_session':
        return completeCheckout({ kernel, verifyPaymentAuthorization }, params, ctx);

      case 'create_payment_link':
        // GUEST hosted checkout: lock the quote into an order, then mint a hosted Stripe URL the buyer
        // pays on. NON-charging — never calls submitPayment, so no payment authorization is required.
        return createPaymentLink({ kernel, upstream }, params, ctx);

      case 'get_order': {
        if (!nonEmpty(params.order_id)) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'missing_order_id' });
        // Fail CLOSED (Codex P0): prove kernel ownership before any read. _requireOrder throws
        // QUOTE_NOT_FOUND (untracked) or STATE_LINKAGE_MISMATCH (cross-user/session) — both propagate, so a
        // verified user can never read an order the kernel does not know to be theirs (no fail-open on an
        // untracked id, no swallowing of store errors). The upstream read is ALSO scoped by user_ref
        // (defense in depth: the backend must enforce it even if it is order-id addressable).
        await kernel._requireOrder(params.order_id, ctx);
        return read('get_order_status', { status: { order_id: params.order_id, user_ref: ctx.user_ref } });
      }

      case 'request_after_sales':
        return kernel.requestAfterSales(params, ctx);

      case 'start_identity_linking':
        // OAuth identity linking is performed at the edge (verified token -> ctx.user_ref), not in the kernel.
        throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { reason: 'identity_linking_is_edge_oauth', op: opId });

      case 'exchange_payment_token':
        // Payment-token / mandate verification happens via verifyPaymentAuthorization at complete time.
        throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { reason: 'token_exchange_verified_at_complete', op: opId });

      default:
        throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { op: opId });
    }
  }

  return { execute };
}

// complete = (idempotent, replayable on the base key) createOrder -> verify payment authorization ->
// mintConfirmation -> submitPayment.
async function completeCheckout({ kernel, verifyPaymentAuthorization }, params, ctx) {
  if (!nonEmpty(params.session_id)) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'missing_session_id' });
  if (typeof verifyPaymentAuthorization !== 'function') {
    // Fail closed: never complete a charge without a way to verify the buyer's payment authorization.
    throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'no_payment_authorization_verifier' });
  }
  if (params.payment_authorization == null) {
    // Require the authorization up front — don't create an order (and consume the single-use quote) for a
    // request that carries no payment authorization at all.
    throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'missing_payment_authorization' });
  }

  // Cross-user replay defense (Codex re-review): idempotency keys are caller-chosen and NOT globally unique
  // across users, and the ledger short-circuits a replay BEFORE ownership is checked. So namespace EVERY
  // ledger key on this money path by the verified buyer + session: User B replaying User A's captured
  // key+body lands on a DIFFERENT ledger key and can never read back A's cached {order, payment}. The scope
  // also makes the base always long enough for the ledger's min-length check, regardless of the raw key.
  const base = scopedBaseKey(params.idempotency_key, ctx);

  // Codex P1: make the WHOLE complete idempotent + replayable on the base key. A retry after a SUCCESSFUL
  // complete returns the original {order, payment} (no IDEMPOTENCY_CONFLICT from a freshly-minted token, no
  // re-charge). A retry after a FAILED verify (no charge yet) is allowed — the ledger releases the key
  // because sideEffectDone is still false — so the buyer can re-complete with a corrected authorization. The
  // inner createOrder/submitPayment ledgers remain the charge-once backstop.
  const { result } = await kernel.idempotency.run(
    base,
    {
      op: 'complete_checkout_session',
      user_ref: ctx.user_ref,
      acp_session_id: ctx.acp_session_id ?? null,
      session_id: params.session_id,
      authorization_checkout_session_id: params.authorization_checkout_session_id ?? null,
      payment_authorization: params.payment_authorization,
      shipping_address: params.shipping_address ?? null,
    },
    async (runCtx) => {
      // createOrder and submitPayment cannot share an idempotency key (different fingerprints conflict in the
      // ledger), so derive distinct, stable sub-keys from the single (user-scoped) base (a retry replays both).
      const orderKey = `${base}:order`;
      const payKey = `${base}:pay`;

      // 1. INV-1/5: order from the session's locked quote; amount is the server-side snapshot, not the caller's.
      const order = await kernel.createOrder(
        { idempotency_key: orderKey, order: { quote_id: params.session_id, shipping_address: params.shipping_address ?? {} } },
        ctx,
      );

      // 2. INV-3: verify the buyer's payment authorization (ACP delegated token / AP2 Checkout Mandate) BEFORE
      //    minting confirmation. Codex P0: require a POSITIVE attestation, not merely a non-throw — a verifier
      //    that silently returns (undefined / {ok:false}) for malformed auth must FAIL CLOSED — and the
      //    attestation must MATCH the authoritative order amount/currency/buyer.
      const attestation = await verifyPaymentAuthorization(params.payment_authorization, {
        order_id: order.order_id,
        user_ref: ctx.user_ref,
        amount: order.amount_total,
        currency: order.currency,
        merchant_id: order.merchant_of_record,
        checkout_session_id: nonEmpty(params.authorization_checkout_session_id)
          ? params.authorization_checkout_session_id
          : params.session_id,
        ctx,
      });
      assertAttestation(attestation, order, ctx);

      // 3. host-mint the confirmation (ownership + amount/currency bound inside the kernel).
      const confirmation_token = await kernel.mintConfirmation({ order_id: order.order_id }, ctx);

      // 4. INV-2/4: charge once; amount/currency from the order, never the caller. From here a failure is
      //    AMBIGUOUS (a charge may have landed) — mark the outer attempt so a base-key retry can't re-run it.
      runCtx.sideEffectDone = true;
      const payment = await kernel.submitPayment(
        {
          idempotency_key: payKey,
          confirmation_token,
          payment: { order_id: order.order_id, expected_amount: order.amount_total, currency: order.currency },
        },
        ctx,
      );

      return { order, payment };
    },
  );
  return result;
}

// GUEST hosted checkout (grant-free). Locks the quote into an order (server-side amount) and asks the
// backend to mint a HOSTED checkout surface (Stripe Checkout page) the buyer pays on. This path MUST NEVER
// call kernel.submitPayment / charge: the agent only ever hands the buyer a page; the buyer authorizes
// payment by paying on it, and the PSP webhook finalizes the order. So no delegated payment grant is needed.
async function createPaymentLink({ kernel, upstream }, params, ctx) {
  if (!nonEmpty(params.session_id)) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'missing_session_id' });
  if (typeof upstream !== 'function') {
    throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'no_upstream_for_hosted_checkout' });
  }
  // User-scoped, single-use-quote, replay-safe — same base-key discipline as complete (so a retry returns
  // the SAME order + checkout link, never a second order or a second hosted session).
  const base = scopedBaseKey(params.idempotency_key, ctx);
  const { result } = await kernel.idempotency.run(
    base,
    {
      op: 'create_payment_link',
      user_ref: ctx.user_ref,
      acp_session_id: ctx.acp_session_id ?? null,
      session_id: params.session_id,
      customer_email: params.customer_email ?? null,
      shipping_address: params.shipping_address ?? null,
      return_url: params.return_url ?? null,
    },
    async (runCtx) => {
      const orderKey = `${base}:order`;
      // 1. INV-1/5: order from the session's locked quote; amount is the server-side snapshot, not the caller's.
      const order = await kernel.createOrder(
        { idempotency_key: orderKey, order: { quote_id: params.session_id, shipping_address: params.shipping_address ?? {} } },
        ctx,
      );
      // 2. Mint the HOSTED checkout surface. Creating a backend session is a side effect; mark it so a
      //    base-key retry replays the cached link rather than minting a second session. NO CHARGE happens
      //    here — the buyer pays on the returned page.
      runCtx.sideEffectDone = true;
      const hosted = await upstream('create_payment_link', {
        order_id: order.order_id,
        customer_email: params.customer_email ?? null,
        shipping_address: params.shipping_address ?? null,
        return_url: params.return_url ?? null,
        user_ref: ctx.user_ref,
      });
      // accept either a flat shape ({checkout_url,...}) or the backend's nested {checkout_session:{hosted_url,...}}.
      const cs = (hosted && typeof hosted.checkout_session === 'object' && hosted.checkout_session) || hosted || {};
      const checkout_url = cs.hosted_url ?? cs.checkout_url ?? cs.url ?? cs.redirect_url ?? null;
      if (!nonEmpty(checkout_url)) {
        // fail closed: a hosted-checkout op that didn't return a payable URL must not look successful.
        throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'hosted_checkout_no_url', order_id: order.order_id });
      }
      return {
        order_id: order.order_id,
        status: 'awaiting_payment',
        checkout_url,
        checkout_session_id: cs.checkout_session_id ?? cs.session_id ?? null,
        expires_at: cs.expires_at ?? null,
        currency: order.currency,
        amount_total: order.amount_total,
      };
    },
  );
  return result;
}

// A payment-authorization verifier must return a POSITIVE attestation that matches the authoritative order.
// Absence-of-throw is NOT success (Codex P0). Codex re-review: the echo fields are MANDATORY, not optional —
// a verifier returning bare {ok:true} (no amount/currency/user_ref) proves nothing about WHICH order/buyer it
// authorized, so an authorization bound to a different user or amount would slip through. Require all three
// present AND exactly matching the authoritative order; anything missing or mismatched fails CLOSED.
function assertAttestation(attestation, order, ctx) {
  if (!attestation || attestation.ok !== true) {
    throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'payment_authorization_not_attested' });
  }
  if (!Number.isSafeInteger(attestation.amount) || attestation.amount !== order.amount_total) {
    throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'authorization_amount_mismatch' });
  }
  if (typeof attestation.currency !== 'string' || attestation.currency.toUpperCase() !== String(order.currency).toUpperCase()) {
    throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'authorization_currency_mismatch' });
  }
  if (attestation.user_ref !== ctx.user_ref) {
    throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'authorization_user_mismatch' });
  }
}

async function cancelSession(kernel, params, ctx) {
  const order_id = params.order_id;
  if (nonEmpty(order_id)) {
    const o = await kernel._orderStore.get(order_id);
    if (o) {
      if (o.user_ref !== ctx.user_ref) throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { order_id });
      if (o.status === 'paid' || o.status === 'charge_pending') {
        throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { reason: 'cannot_cancel_paid_or_pending', order_id });
      }
      await kernel._orderStore.set(order_id, { ...o, status: 'canceled' });
    }
  }
  return { session_id: params.session_id ?? null, order_id: order_id ?? null, status: 'canceled' };
}

// Map a kernel quote snapshot → the canonical "checkout session" shape adapters return.
function toSession(q) {
  return {
    session_id: q.quote_id,
    status: 'ready_for_payment',
    currency: q.currency,
    merchant_of_record: q.merchant_of_record,
    totals: q.locked_totals,
    line_items: q.line_items,
    expires_at: q.expires_at,
    acp_state: q.acp_state,
  };
}
