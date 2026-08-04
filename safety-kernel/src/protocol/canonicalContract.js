// THE canonical merchant-side agentic-commerce contract — the single source of truth that every protocol
// adapter (UCP, OpenAI ACP REST, MCP) normalizes INTO. Each canonical operation binds to the kernel, so the
// safety invariants (quote-first, amount-from-quote, host-minted confirmation, idempotency, single-use,
// charge-once, ownership/T7) are enforced ONCE and never forked per ecosystem.
//
// Design references (Claude×Codex synthesis, MERCHANT_SIDE_READINESS_SYNTHESIS.md):
//  - UCP capabilities map 1:1 to MCP tools; UCP discovery is a /.well-known/ucp profile.
//  - ACP exposes 5 checkout-session REST endpoints + a product feed + delegated payment.
//  - The kernel's quote→order→confirm→pay maps onto the protocols' "checkout session" lifecycle:
//    create/update = previewQuote (re-quote), complete = (verify payment authorization) → createOrder →
//    mintConfirmation → submitPayment, cancel/get = session lifecycle.

/**
 * Canonical capabilities. `ucp` is the UCP capability identifier (for /.well-known/ucp); capabilities ↔ MCP
 * tools 1:1. ACP has no capability ids (it's REST endpoints + a feed), noted per-operation instead.
 */
export const CANONICAL_CAPABILITIES = Object.freeze({
  discovery: { ucp: 'dev.ucp.shopping.discovery', title: 'Product discovery / catalog' },
  checkout: { ucp: 'dev.ucp.shopping.checkout', title: 'Checkout session lifecycle' },
  order: { ucp: 'dev.ucp.shopping.order', title: 'Order lifecycle + after-sales' },
  identity: { ucp: 'dev.ucp.common.identity_linking', title: 'OAuth identity linking' },
  payment: { ucp: 'dev.ucp.shopping.ap2_mandate', title: 'Payment authorization (delegated token / AP2 mandate)' },
});

/**
 * Canonical operations. Each declares:
 *  - capability        : which CANONICAL_CAPABILITIES key
 *  - kernel            : how it binds to the kernel (a single op, a composition, or 'external' for non-kernel)
 *  - mutating          : writes state (needs an idempotency key)
 *  - requiresUserRef   : needs a verified buyer (the kernel's ownership key)
 *  - requiresPaymentAuthz : needs verified payment authorization (delegated token / AP2 Checkout Mandate)
 *  - acp / ucp / mcp   : the per-protocol surface name
 */
export const CANONICAL_OPERATIONS = Object.freeze([
  {
    id: 'search_catalog', capability: 'discovery', kernel: 'find_products',
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: 'product_feed', ucp: 'catalog.search', mcp: 'search_catalog',
  },
  {
    id: 'get_product', capability: 'discovery', kernel: 'get_product_detail',
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: 'product_feed', ucp: 'catalog.get', mcp: 'get_product',
  },
  {
    // Read-only intelligence projections (decision substrate, not catalog). kernel:'local' routes them to
    // the executor's injected localReads handlers — they never touch the money kernel or upstream checkout.
    id: 'get_alternatives', capability: 'discovery', kernel: 'local',
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: null, ucp: 'catalog.alternatives', mcp: 'get_alternatives',
  },
  {
    id: 'get_offers', capability: 'discovery', kernel: 'local',
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: null, ucp: 'catalog.offers', mcp: 'get_offers',
  },
  {
    id: 'get_intel', capability: 'discovery', kernel: 'local',
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: null, ucp: 'catalog.intel', mcp: 'get_intel',
  },
  {
    id: 'create_checkout_session', capability: 'checkout', kernel: 'preview_quote',
    mutating: true, requiresUserRef: true, requiresPaymentAuthz: false,
    acp: 'POST /checkout_sessions', ucp: 'checkout.create', mcp: 'create_checkout_session',
  },
  {
    id: 'update_checkout_session', capability: 'checkout', kernel: 'preview_quote', // re-quote on change
    mutating: true, requiresUserRef: true, requiresPaymentAuthz: false,
    acp: 'POST /checkout_sessions/{id}', ucp: 'checkout.update', mcp: 'update_checkout_session',
  },
  {
    id: 'get_checkout_session', capability: 'checkout', kernel: 'get_quote_snapshot',
    mutating: false, requiresUserRef: true, requiresPaymentAuthz: false,
    acp: 'GET /checkout_sessions/{id}', ucp: 'checkout.get', mcp: 'get_checkout_session',
  },
  {
    // complete = verify payment authorization → createOrder → mintConfirmation → submitPayment.
    id: 'complete_checkout_session', capability: 'checkout',
    kernel: 'create_order+mint_confirmation+submit_payment',
    mutating: true, requiresUserRef: true, requiresPaymentAuthz: true,
    acp: 'POST /checkout_sessions/{id}/complete', ucp: 'checkout.complete', mcp: 'complete_checkout_session',
  },
  {
    // GUEST hosted checkout: createOrder (locked quote) -> mint a HOSTED Stripe checkout URL the buyer
    // pays on. NON-charging: never calls submitPayment, so it needs NO delegated payment authorization
    // (the buyer authorizes by paying on Stripe). Gated separately by AGENT_CHECKOUT_HOSTED_LINK_ENABLED.
    id: 'create_payment_link', capability: 'checkout', kernel: 'create_order+create_hosted_checkout',
    mutating: true, requiresUserRef: true, requiresPaymentAuthz: false,
    acp: null, ucp: 'checkout.payment_link', mcp: 'create_payment_link',
  },
  {
    id: 'cancel_checkout_session', capability: 'checkout', kernel: 'cancel_order',
    mutating: true, requiresUserRef: true, requiresPaymentAuthz: false,
    acp: 'POST /checkout_sessions/{id}/cancel', ucp: 'checkout.cancel', mcp: 'cancel_checkout_session',
  },
  {
    id: 'get_order', capability: 'order', kernel: 'get_order_status',
    mutating: false, requiresUserRef: true, requiresPaymentAuthz: false,
    acp: 'order_webhook', ucp: 'order.get', mcp: 'get_order',
  },
  {
    id: 'request_after_sales', capability: 'order', kernel: 'request_after_sales',
    mutating: true, requiresUserRef: true, requiresPaymentAuthz: false,
    acp: 'order_webhook', ucp: 'order.after_sales', mcp: 'request_after_sales',
  },
  {
    id: 'start_identity_linking', capability: 'identity', kernel: 'external', // OAuth at the edge → user_ref
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: null, ucp: 'identity_linking.start', mcp: 'start_identity_linking',
  },
  {
    // Delegated-payment VAULTING: ACP `POST /agentic_commerce/delegate_payment`. PERMANENTLY REFUSED — that
    // endpoint receives raw cardholder data (FPAN + CVC) and the spec scopes it to a PSP or a PCI-DSS Level 1
    // merchant running its own vault. Pivota is a commerce index / protocol edge, never the vault and never the
    // merchant of record, so it stays outside cardholder-data scope by design. The operation REMAINS in the
    // contract — the door must answer a named, diagnosable refusal rather than a bare 404 that reads as a
    // routing bug — but `refusalOnly` keeps it out of every discovery profile: advertising an operation that
    // permanently refuses is exactly the "advertised but not executable" defect. See delegatedPaymentRefusal.js.
    // NOTE: this is NOT the payment-authorization path. An ACP delegated token / AP2 mandate is presented
    // INLINE as `payment_data` on complete_checkout_session and verified there — no exchange step exists.
    id: 'exchange_payment_token', capability: 'payment', kernel: 'external',
    mutating: false, requiresUserRef: true, requiresPaymentAuthz: false,
    refusalOnly: true,
    acp: 'POST /agentic_commerce/delegate_payment', ucp: 'payment.token_exchange', mcp: 'exchange_payment_token',
  },
]);

const OPS_BY_ID = Object.freeze(Object.fromEntries(CANONICAL_OPERATIONS.map((o) => [o.id, o])));

/** Look up a canonical operation by id (throws on unknown so adapters can't silently route an unknown op). */
export function canonicalOp(id) {
  const op = OPS_BY_ID[id];
  if (!op) throw new Error(`unknown canonical operation: ${id}`);
  return op;
}

/**
 * All canonical operation ids for a capability.
 * @param {string} capability
 * @param {{ includeRefusalOnly?: boolean }} [opts] — `includeRefusalOnly:false` drops PERMANENTLY-refused
 *   operations. Discovery profiles pass false; the default stays true so the contract view (and every existing
 *   caller/test) is unchanged.
 */
export function operationsForCapability(capability, { includeRefusalOnly = true } = {}) {
  return CANONICAL_OPERATIONS
    .filter((o) => o.capability === capability && (includeRefusalOnly || !o.refusalOnly))
    .map((o) => o.id);
}

/**
 * Operations the contract defines a door for but that PERMANENTLY refuse — the door answers a named refusal
 * instead of 404ing, but nothing may advertise them as executable.
 */
export const REFUSAL_ONLY_OPERATIONS = Object.freeze(CANONICAL_OPERATIONS.filter((o) => o.refusalOnly).map((o) => o.id));

/** Operations that mutate state (must carry an idempotency key) / need a verified buyer / need payment authz. */
export const MUTATING_OPERATIONS = Object.freeze(CANONICAL_OPERATIONS.filter((o) => o.mutating).map((o) => o.id));
export const USER_SCOPED_OPERATIONS = Object.freeze(CANONICAL_OPERATIONS.filter((o) => o.requiresUserRef).map((o) => o.id));
export const PAYMENT_AUTHZ_OPERATIONS = Object.freeze(CANONICAL_OPERATIONS.filter((o) => o.requiresPaymentAuthz).map((o) => o.id));
