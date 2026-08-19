// The canonical executor — the ONE execution bridge every protocol adapter (UCP/ACP/MCP) calls. It enforces
// the canonical contract's safety flags in a single place (deny without a verified buyer; require an
// idempotency key on mutations; require verified payment authorization on complete) and routes each canonical
// operation to the kernel. Safety (INV-1..5, charge-once, ownership/T7) is therefore enforced once and never
// forked per ecosystem.
//
// The checkout-session lifecycle maps onto the kernel:
//   create/update_checkout_session -> previewQuote        (session_id == quote_id)
//   get_checkout_session           -> quotes.resolveForOrder (ownership + expiry checked)
//   complete_checkout_session      -> verifyPaymentAuthorization -> createOrder -> mintConfirmation -> submitPayment
//   cancel_checkout_session        -> mark a non-terminal kernel order canceled (best-effort)
//   get_order / request_after_sales-> get_order_status (ownership-gated) / requestAfterSales
//   search_catalog / get_product   -> upstream reads
//   start_identity_linking         -> handled at the edge (OAuth), not here
//   exchange_payment_token         -> PERMANENTLY REFUSED (see delegatedPaymentRefusal.js): that operation is
//                                     delegated-payment VAULTING, which belongs to the merchant's PSP.

import { PivotaCommerceError } from '../errors.js';
import { canonicalOp } from './canonicalContract.js';
import { delegatedPaymentRefusalDetail } from './delegatedPaymentRefusal.js';

const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- delegated PSP token (Stripe SharedPaymentToken) recognition -------------------------------------------
//
// An `spt_` in ACP `payment_data.token` is NOT a signed grant. It is an opaque handle minted by the buyer's
// agent platform against the MERCHANT's Stripe account; its allowance (`usage_limits{currency, max_amount,
// expires_at}`, single use, merchant scope) is readable and enforceable ONLY with the merchant's key, which
// this gateway does not and must not hold. `verifyPaymentAuthorization` attests signed JWS grants against
// pinned JWKS — it cannot attest this, and INV-3 forbids pretending it did. So the completion is ROUTED to the
// backend's own money endpoint, where the merchant's key confirms the charge and Stripe performs the
// attestation at confirmation time. The gateway keeps enforcing everything it CAN prove (buyer/session
// linkage, quote ownership + expiry, single-use claim, amount/currency identity with the locked quote); it
// simply refuses to claim an attestation it did not make.
const DELEGATED_PSP_TOKEN_PREFIX = 'spt_';

/**
 * Return the delegated PSP token iff `payment_data` carries one, else null. Deliberately narrow: ONLY a string
 * `token` with the `spt_` prefix. Anything else — including a signed grant that happens to sit next to one —
 * takes the verifier path unchanged (INV-3 is not weakened for non-SPT authorizations).
 */
// The ONLY door this lane serves. It is both the ctx gate above and the `protocol_name` written onto the
// backend order, so the label the backend gates on can never disagree with the door the request came from.
const DELEGATED_LANE_PROTOCOL = 'acp';

export function delegatedPspToken(paymentAuthorization) {
  if (!isPlainObject(paymentAuthorization)) return null;
  // OWN property only (review F3). A `token` inherited from a polluted Object.prototype must never route a
  // completion to the delegated lane: a legitimate SIGNED GRANT would then be diverted past the verifier and
  // charged with an attacker-chosen token. Not reachable through either door today (Express's JSON parse does
  // not pollute and the MCP surface strips `__proto__`), but this is a money branch and the codebase already
  // uses hasOwn for exactly this reason elsewhere.
  const raw = Object.hasOwn(paymentAuthorization, 'token') ? paymentAuthorization.token : undefined;
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  return token.startsWith(DELEGATED_PSP_TOKEN_PREFIX) && token.length > DELEGATED_PSP_TOKEN_PREFIX.length
    ? token
    : null;
}

// Flags are accepted as a boolean OR a thunk. The executor is built ONCE per process, so a boolean freezes the
// flag at build time; a money kill-switch must be readable live, and the app wiring passes a thunk.
const flagOn = (v) => (typeof v === 'function' ? v() === true : v === true);

// Namespace a caller-chosen idempotency key by the verified buyer + session. Idempotency keys are not
// globally unique across users; the ledger replays a hit BEFORE ownership is checked, so an un-scoped key
// lets one user read back another's cached result. We encode (user_ref, acp_session_id, rawKey) as a JSON
// array so the scoping is UNAMBIGUOUS regardless of field contents: a plain delimiter could collide if a
// field held it (e.g. a space inside acp_session_id re-segmenting into a different triple), and a NUL
// delimiter would break Postgres text keys. Distinct triples => distinct strings. user_ref is always present
// here (the contract required it upstream), so the base is always over the ledger min-length floor.
const scopedBaseKey = (rawKey, ctx) => JSON.stringify(['cs', ctx.user_ref ?? null, ctx.acp_session_id ?? null, rawKey ?? null]);

/**
 * Build the PivotaCommerceError for a PERMANENTLY-refused canonical operation. One function so the pre-gate
 * refusal and the switch-case backstop can never drift. Takes only the op id — never params: the one operation
 * in this class (`exchange_payment_token` == ACP delegate_payment) carries raw cardholder data.
 */
function refusalFor(opId) {
  if (opId === 'exchange_payment_token') {
    return new PivotaCommerceError('OPERATION_NOT_ALLOWED', delegatedPaymentRefusalDetail(opId));
  }
  return new PivotaCommerceError('OPERATION_NOT_ALLOWED', { op: opId, reason: 'operation_permanently_refused' });
}

/**
 * @param {{
 *   kernel: object,                      // SafetyKernel
 *   upstream?: (op:string, payload:object, headers?:object) => Promise<any>,  // for reads
 *   // NOTE: on complete, `bound.order_id` is null — the authorization is verified against the locked quote
 *   // BEFORE the order exists (see completeCheckout). A verifier must bind on amount/currency/merchant_id/
 *   // checkout_session_id/user_ref, never on order_id.
 *   verifyPaymentAuthorization?: (authorization:any, bound:{order_id,user_ref,amount,currency,merchant_id,checkout_session_id,ctx}) => Promise<void>,
 *   localReads?: Record<string, (params:object, ctx:object) => Promise<any>>,  // read-only intelligence ops (get_alternatives/get_offers)
 *   // The DELEGATED-PSP-TOKEN lane (ACP `payment_data.token = spt_…`). Transport-agnostic by injection: the
 *   // executor is kernel-side and must never speak HTTP, so the app wiring supplies the dispatcher that calls
 *   // the backend's off-session money endpoint on the merchant's key. Charged through kernel.submitPayment's
 *   // dispatch seam, so every charge-once guard still applies.
 *   submitDelegatedPayment?: (bound:{order_id,amount,currency,idempotency_key,token,user_ref}) => Promise<object>,
 *   delegatedTokenHandoffEnabled?: boolean | (() => boolean),   // ACP_SPT_GATEWAY_HANDOFF_ENABLED; default OFF
 * }} deps
 */
export function createCanonicalExecutor({
  kernel,
  upstream,
  verifyPaymentAuthorization,
  hostedLinkEnabled = false,
  localReads,
  submitDelegatedPayment,
  delegatedTokenHandoffEnabled = false,
} = {}) {
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

    // A PERMANENTLY-REFUSED operation is answered BEFORE the auth/session/idempotency gates. Those gates exist
    // to protect an operation that can succeed; running them first would answer "sign in and bind a session"
    // to a caller who can never get past this line — the sign-in-then-be-refused loop this refusal exists to
    // end. Nothing is disclosed by answering early: `op.refusalOnly` is a fixed property of the published
    // contract, and no params are read. See delegatedPaymentRefusal.js.
    if (op.refusalOnly) throw refusalFor(opId);

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
      case 'search_catalog': {
        // Lane selection: an UNscoped search ("find a niacinamide serum") must hit the multi-merchant
        // canonical index (find_products_multi) — the per-merchant find_products lane degenerates to a
        // single store's catalog without a merchant_id (observed live: 2 products from one Shopify store).
        // A merchant-scoped search keeps the per-merchant lane, so in-store agent flows are unchanged.
        const searchPayload = params.payload ?? params;
        const merchantScoped =
          searchPayload && typeof searchPayload === 'object' &&
          searchPayload.search && typeof searchPayload.search === 'object' &&
          typeof searchPayload.search.merchant_id === 'string' && searchPayload.search.merchant_id.trim() !== '';
        return read(merchantScoped ? 'find_products' : 'find_products_multi', searchPayload);
      }
      case 'get_product': {
        const result = await read('get_product_detail', params.payload ?? params);
        // Optional inline decision substrate (why/fit/evidence) attached when the caller asks for it via
        // include:['decision']. Double-gated: the get_intel localRead is itself flag-gated (returns no
        // signal when the intel surface is off), and the caller must opt in. Read-only + best-effort — a
        // failure here NEVER affects the product result.
        try {
          const reqPayload = (params && params.payload) || params || {};
          const include = Array.isArray(reqPayload.include)
            ? reqPayload.include
            : Array.isArray(params?.include) ? params.include : [];
          const getIntel = localReads && typeof localReads.get_intel === 'function' ? localReads.get_intel : null;
          if (getIntel && include.includes('decision') && result && typeof result === 'object') {
            const target = result.product && typeof result.product === 'object' ? result.product : result;
            const reqProduct = (reqPayload.product && typeof reqPayload.product === 'object') ? reqPayload.product : reqPayload;
            const intel = await getIntel({
              payload: {
                product_id: target.product_id ?? reqProduct.product_id,
                merchant_id: target.merchant_id ?? reqProduct.merchant_id,
                pivota_signature_id: target.pivota_signature_id ?? reqProduct.pivota_signature_id,
              },
            }, ctx);
            const sig = intel && Array.isArray(intel.signals) ? intel.signals[0] : null;
            if (sig && sig.value) {
              target.decision = {
                ...sig.value,
                evidence: sig.evidence,
                freshness: sig.freshness,
                review_state: sig.review_state,
              };
            }
          }
        } catch {
          /* decision block is best-effort; the base product result is unaffected */
        }
        return result;
      }

      case 'get_alternatives':
      case 'get_offers':
      case 'get_intel':
      case 'recommend_products': {
        // Read-only intelligence projections (relationships, cross-merchant offers, why/fit/evidence, and the
        // need-anchored recommendation shortlist) → Signal envelope.
        // Handled by an app-layer handler injected as localReads[opId] (the relationship graph + offers
        // live in the app DB, not the kernel). No money, no state; the contract gates above already passed
        // (requiresUserRef:false, mutating:false). Fail closed if no handler is wired.
        const handler = localReads && typeof localReads[opId] === 'function' ? localReads[opId] : null;
        if (!handler) throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'no_local_read_handler', op: opId });
        return handler(params, ctx);
      }

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
        return completeCheckout(
          { kernel, verifyPaymentAuthorization, submitDelegatedPayment, delegatedTokenHandoffEnabled },
          params,
          ctx,
        );

      case 'create_payment_link':
        // GUEST hosted checkout: lock the quote into an order, then mint a hosted Stripe URL the buyer
        // pays on. NON-charging — never calls submitPayment, so no payment authorization is required.
        // Defense-in-depth: enforce the enable flag HERE (not only in the /mcp route) so every adapter
        // — MCP today, ACP/UCP tomorrow — inherits the gate and can't reach it with the flag off.
        if (!hostedLinkEnabled) {
          throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { op: opId, reason: 'hosted_link_disabled' });
        }
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
        // Backstop: the pre-gate `op.refusalOnly` check above already threw this. Kept so the refusal survives
        // even if the contract flag is ever dropped — an operation that vaults cardholder data must never be
        // able to fall through to the kernel because of an edit elsewhere.
        throw refusalFor(opId);

      default:
        throw new PivotaCommerceError('OPERATION_NOT_ALLOWED', { op: opId });
    }
  }

  return { execute };
}

// complete = (idempotent, replayable on the base key) resolve locked quote -> verify payment authorization ->
// createOrder -> re-check the attestation against the minted order -> mintConfirmation -> submitPayment.
//
// The verify comes BEFORE createOrder deliberately. createOrder claims the quote single-use (INV-1), so
// verifying after it meant a complete whose authorization did NOT verify permanently burned the checkout
// session: no order was payable and no money had moved, yet a retry with a CORRECTED authorization got
// QUOTE_ALREADY_USED ("this checkout was already completed" — untrue). Nothing is lost by verifying first:
// the binding invariant is over the money (amount/currency/merchant), the checkout session and the buyer,
// and the LOCKED QUOTE fixes all of those before an order exists — createOrder derives order.amount_total /
// currency / merchant_of_record from that same snapshot. Step 3 re-checks the attestation against the
// authoritative order anyway, so a divergence still fails closed before any confirmation or charge.
async function completeCheckout(
  { kernel, verifyPaymentAuthorization, submitDelegatedPayment, delegatedTokenHandoffEnabled },
  params,
  ctx,
) {
  if (!nonEmpty(params.session_id)) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'missing_session_id' });

  // THE ROUTING DECISION, taken once and before anything else reads the authorization. P5 of the routing
  // design: it must precede the kernel verifier. Flag OFF (default) ⇒ always null ⇒ every line below behaves
  // exactly as it did before this lane existed.
  // Scoped to the ACP door (review F2). This branch lives in the SHARED completeCheckout, and the MCP tool
  // surface also accepts a free-form `payment_authorization` — so without this an /mcp completion carrying an
  // `spt_` would route here too, under a flag named ACP_SPT_GATEWAY_HANDOFF_ENABLED, and would write
  // `protocol_name: 'acp'` onto the backend order. That field is exactly what the backend's off-session gate
  // keys on, so a false value there is a falsified provenance record on the money path. The door declares
  // itself in ctx; anything that is not the ACP door takes the verifier path unchanged.
  const delegatedToken = flagOn(delegatedTokenHandoffEnabled) && ctx?.protocol === DELEGATED_LANE_PROTOCOL
    ? delegatedPspToken(params.payment_authorization)
    : null;

  if (typeof verifyPaymentAuthorization !== 'function' && !delegatedToken) {
    // Fail closed: never complete a charge without a way to verify the buyer's payment authorization.
    //
    // The delegated-PSP-token lane is exempt because it never calls this verifier — its trust anchor is
    // Stripe's enforcement of the token's usage_limits at confirmation on the merchant's key (§3), not a JWS
    // attestation. Requiring an unrelated JWKS verifier to be configured would gate that lane on something it
    // does not use. Its OWN fail-closed gates are the flag, the route-level submit_payment kill-switch, and
    // the dispatcher-presence check in completeWithDelegatedPspToken.
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
  // because sideEffectDone is still false. That release only makes retrying POSSIBLE; what makes it
  // SUCCEED is that a failed verify now happens before createOrder, so the quote is still unspent.
  //
  // On retry keys, precisely (an earlier draft of this comment got it wrong): after a FAILED verify the
  // ledger has COMPARE-AND-DELETED its record, so there is nothing left to conflict with — the buyer may
  // retry a corrected authorization on the SAME key or a new one, and both work. A fingerprint conflict
  // only arises while a prior attempt is still pending/done/ambiguous, i.e. never on this recovery path.
  // The inner createOrder/submitPayment ledgers remain the charge-once backstop.
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

      // 1. INV-1/5: resolve the session's LOCKED quote. This is a READ — it enforces existence, expiry and
      //    user/session linkage exactly as createOrder does, but it does NOT claim the quote (createOrder's
      //    atomic putIfAbsent is what makes a quote single-use). So it hands us the authoritative money —
      //    the same snapshot createOrder will price the order from — while the session is still spendable.
      const quote = await kernel.quotes.resolveForOrder(params.session_id, ctx);
      // resolveForOrder matches createOrder on existence, expiry and user/session linkage but NOT on the
      // single-use claim, so without this a SPENT quote would reach the verifier — presenting the buyer's
      // grant before refusing. That costs nothing with a pure-crypto verifier, but a verifier that consumes
      // the grant (PSP-side validation, a jti replay cache) would burn it and answer CONFIRMATION_INVALID
      // where the honest answer is QUOTE_ALREADY_USED — the same misreporting this reordering set out to fix.
      // Advisory only: createOrder's atomic claim below is still the enforcement, so a concurrent claim that
      // lands after this read is refused there, exactly as before.
      if (typeof kernel.isQuoteClaimed === 'function' && (await kernel.isQuoteClaimed(quote.quote_id))) {
        throw new PivotaCommerceError('QUOTE_ALREADY_USED', { quote_id: quote.quote_id });
      }

      // --- THE BRANCH (decided above, taken here) -------------------------------------------------------
      // A delegated PSP token (`spt_`) is routed to the backend's off-session money endpoint INSTEAD of being
      // handed to the verifier — which would answer CONFIRMATION_INVALID / unknown_authorization_method, its
      // correct answer for a token it cannot attest. The branch is taken HERE, after the shared prologue, so
      // quote ownership, expiry, buyer/session linkage and the spent-quote pre-check are enforced in exactly
      // ONE place for both lanes, and the whole completion stays inside the same user-scoped idempotency run.
      if (delegatedToken) {
        return completeWithDelegatedPspToken(
          { kernel, submitDelegatedPayment },
          { params, ctx, runCtx, quote, orderKey, payKey, token: delegatedToken },
        );
      }

      // Shaped like the order the kernel is about to mint, so the ONE attestation check runs against the
      // quote here and against the real order in step 3 with no second, drifting copy of the rules.
      const authorized = {
        amount_total: quote.locked_totals?.total,
        currency: quote.currency,
        merchant_of_record: quote.merchant_of_record,
      };

      // 2. INV-3: verify the buyer's payment authorization (ACP delegated token / AP2 Checkout Mandate) BEFORE
      //    anything irreversible — before the quote is consumed and long before minting confirmation. Codex P0:
      //    require a POSITIVE attestation, not merely a non-throw — a verifier that silently returns
      //    (undefined / {ok:false}) for malformed auth must FAIL CLOSED — and the attestation must MATCH the
      //    authoritative amount/currency/buyer.
      const attestation = await verifyPaymentAuthorization(params.payment_authorization, {
        // No order exists yet, by design. order_id was never part of the binding invariant
        // (assertPaymentBinding checks merchant/amount/currency/checkout session/buyer/expiry and never reads
        // it); the checkout session id below is what ties a grant to THIS checkout.
        order_id: null,
        user_ref: ctx.user_ref,
        amount: authorized.amount_total,
        currency: authorized.currency,
        merchant_id: authorized.merchant_of_record,
        checkout_session_id: nonEmpty(params.authorization_checkout_session_id)
          ? params.authorization_checkout_session_id
          : params.session_id,
        ctx,
      });
      assertAttestation(attestation, authorized, ctx);

      // 3. Order from the locked quote (this is what claims it single-use); amount is the server-side
      //    snapshot, not the caller's. Then re-check the attestation against the AUTHORITATIVE order and
      //    confirm its merchant too. The order is derived from the very snapshot we just verified against, so
      //    these must agree; a divergence means the money we are about to charge is not the money the buyer
      //    authorized — fail CLOSED here, before any confirmation is minted. (The authorization is verified
      //    ONCE: re-running the verifier would re-present a single-use/nonce-bearing grant.)
      const order = await kernel.createOrder(
        { idempotency_key: orderKey, order: { quote_id: params.session_id, shipping_address: params.shipping_address ?? {} } },
        ctx,
      );
      assertAttestation(attestation, order, ctx);
      // Require the field on BOTH sides: a bare string compare would pass when both are absent
      // ("undefined" === "undefined"), which is exactly the regression class this line exists to catch.
      // (previewQuote already refuses a quote with no merchant_of_record, so this is defense in depth.)
      if (!nonEmpty(order.merchant_of_record) || !nonEmpty(authorized.merchant_of_record)
        || String(order.merchant_of_record) !== String(authorized.merchant_of_record)) {
        throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'authorization_merchant_mismatch' });
      }

      // 4. host-mint the confirmation (ownership + amount/currency bound inside the kernel).
      const confirmation_token = await kernel.mintConfirmation({ order_id: order.order_id }, ctx);

      // 5. INV-2/4: charge once; amount/currency from the order, never the caller. From here a failure is
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

// The DELEGATED-PSP-TOKEN lane. Runs INSIDE completeCheckout's idempotency run, on the already-resolved
// (owned, unexpired, unspent) locked quote — it never re-derives any of that, and it never re-enters the
// ledger under a second base key.
//
// What differs from the normal lane, and only this:
//   - no attestation is claimed. There is no verifier call, and nothing here fabricates an `ok:true`. The
//     buyer's authorization is attested by STRIPE at confirmation, on the merchant's key (usage_limits,
//     merchant scope, single use). §3 of the routing design: a different trust anchor, not a waived one.
//   - the charge is dispatched to the backend's off-session money endpoint instead of the hosted-checkout
//     surface `kernel._upstream('submit_payment')` routes to. Everything AROUND the charge — the per-order
//     lock, the payable-status allowlist, the amount/currency pin from the kernel's own order record, the
//     host-minted confirmation token, the durable charge_pending write BEFORE dispatch, the attempt-scoped
//     idempotency key — still runs, because the dispatch is injected into kernel.submitPayment rather than
//     replacing it.
//
// THE TOKEN IS NEVER PERSISTED OR LOGGED. It lives only in this function's arguments and in the dispatch
// closure: it is not part of any idempotency fingerprint, not written to the order record, and never placed
// in a PivotaCommerceError detail (which flows to logs and to /invoke error bodies).
async function completeWithDelegatedPspToken(
  { kernel, submitDelegatedPayment },
  { params, ctx, runCtx, quote, orderKey, payKey, token },
) {
  // Fail closed BEFORE the quote is claimed: with no dispatcher wired there is no way to charge this token,
  // and burning the single-use quote for a completion that cannot proceed is the QUOTE_ALREADY_USED trap
  // PR #1902 removed. Nothing irreversible has happened at this point, so the ledger releases the base key
  // and the buyer may retry once the lane is wired.
  if (typeof submitDelegatedPayment !== 'function') {
    throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'no_delegated_payment_dispatcher' });
  }

  // 1. Order from the locked quote — SAME call as the normal lane, so INV-1's single-use claim, the
  //    createOrder idempotency ledger and `quote_id: quote.upstream_quote_id` (the backend's OWN quote id,
  //    i.e. the price the agent was quoted) are all inherited rather than reimplemented.
  //
  //    `metadata.protocol_name = 'acp'` is REQUIRED, not decorative: without it the backend's off-session
  //    gate evaluates guarded=False/engaged=False and the delegated-token capture lane never engages — the
  //    charge falls to a client-confirm path that cannot complete off-session. The gateway's own order
  //    metadata builder merges rather than replaces, so this key survives to POST /agent/v2/orders alongside
  //    whatever else that builder adds.
  //
  //    RESOLVED (traced in pivota-backend origin/main): applyStrictHostedOrderMetadata also stamps
  //    `metadata.agent_v2.{checkout_provider:'pivota_hosted_checkout', hosted_checkout:true}` on every order,
  //    including this one — which is not a hosted checkout. The backend's off-session lane reads only
  //    `protocol_name` and `payment_flow` from order metadata (agent_payment_sdk / acp_offsession_payment /
  //    acp_offsession_capture contain no reference to the hosted keys, and the gateway never sets
  //    `payment_flow`), so those keys are inert here. Left in place: they are honest about which builder made
  //    the order, and removing them would change the normal lane too.
  const order = await kernel.createOrder(
    {
      idempotency_key: orderKey,
      order: {
        quote_id: params.session_id,
        shipping_address: params.shipping_address ?? {},
        metadata: { protocol_name: DELEGATED_LANE_PROTOCOL },
      },
    },
    ctx,
  );

  // 2. The money the backend will charge must be the money the locked quote fixed — the amount the buyer's
  //    token allowance was sized against. createOrder derives both from that snapshot and cross-checks the
  //    backend's own figures, so a divergence here means a kernel/adapter regression. Fail CLOSED, before any
  //    confirmation is minted and before any charge. (Same three checks the normal lane runs in its step 3;
  //    there they compare against the attestation, here against the snapshot itself.)
  if (!Number.isSafeInteger(order.amount_total) || order.amount_total !== quote.locked_totals?.total) {
    throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'delegated_amount_mismatch' });
  }
  if (!nonEmpty(order.currency) || !nonEmpty(quote.currency)
    || String(order.currency).toUpperCase() !== String(quote.currency).toUpperCase()) {
    throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'delegated_currency_mismatch' });
  }
  // Require the field on BOTH sides — a bare string compare passes when both are absent.
  if (!nonEmpty(order.merchant_of_record) || !nonEmpty(quote.merchant_of_record)
    || String(order.merchant_of_record) !== String(quote.merchant_of_record)) {
    throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'delegated_merchant_mismatch' });
  }

  // 3. Host-mint the confirmation (ownership + amount/currency bound inside the kernel), exactly as the
  //    normal lane does. submitPayment consumes it; keeping it means INV-3's host-minted binding still gates
  //    this charge even though the buyer's authorization is attested downstream.
  const confirmation_token = await kernel.mintConfirmation({ order_id: order.order_id }, ctx);

  // 4. Charge once. From here a failure is AMBIGUOUS — the backend may have dispatched to Stripe — so mark
  //    the outer attempt: the ledger records the base key 'ambiguous' and refuses a same-key retry, while a
  //    NEW-key retry is refused by the quote's single-use claim (QUOTE_ALREADY_USED). Neither route can mint
  //    a second charge.
  runCtx.sideEffectDone = true;
  const payment = await kernel.submitPayment(
    {
      idempotency_key: payKey,
      confirmation_token,
      payment: { order_id: order.order_id, expected_amount: order.amount_total, currency: order.currency },
    },
    ctx,
    {
      // The token rides the closure, NOT the payment payload — so it stays out of the submit_payment
      // idempotency fingerprint and out of the kernel's order record. amount/currency/idempotency_key are
      // supplied BY the kernel from its authoritative record; this closure may not choose its own.
      dispatch: async ({ order_id, amount, currency, idempotency_key }) => submitDelegatedPayment({
        order_id,
        amount,
        currency,
        idempotency_key,
        token,
        user_ref: ctx.user_ref,
      }),
    },
  );

  return { order, payment };
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
      // The URL is surfaced verbatim to the buyer; require https so a malformed/typo'd upstream field can't
      // relay a non-secure or javascript:/data: link. (Host allowlisting is a further hardening option.)
      let parsedUrl;
      try { parsedUrl = new URL(checkout_url); } catch { parsedUrl = null; }
      if (!parsedUrl || parsedUrl.protocol !== 'https:') {
        throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'hosted_checkout_bad_url', order_id: order.order_id });
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
