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
  // DISCOVERY WAS ONE KEY ADVERTISING AN ID THAT DOES NOT EXIST. `dev.ucp.shopping.discovery` appears
  // nowhere in the UCP vocabulary — verified against ucp.dev/2026-04-08 (specification/overview lists cart,
  // checkout, discount, fulfillment, order, ap2_mandate; specification/catalog lists exactly the two ids
  // below). Because negotiation is a set INTERSECTION, an id that exists nowhere intersects with nothing:
  // our discovery capability was dropped for EVERY platform, silently, and the five operations behind it
  // were invisible. That is the seller-side twin of the buyer-side bug fixed in #1973, pointing outward.
  //
  // It is split three ways because one key cannot honestly carry all five operations:
  //   catalog_search — free-text search                    -> `search_catalog`
  //   catalog_lookup — retrieval by identifier             -> `get_product`
  //   insights       — Pivota's OWN decision substrate     -> get_alternatives / get_offers / get_intel
  //
  // The spec's own words for the two catalog ids: `.search` is "Search for products using query text and
  // filters", `.lookup` is "Retrieve products or variants by identifier". Our five operations do not all fit
  // those two, and forcing the last three into either would advertise them as something a platform can
  // reasonably expect from a standard catalog capability. They are not standard: alternatives, cross-merchant
  // offers and reviewed intelligence are Pivota's decision layer, and UCP's answer for exactly this is a
  // VENDOR-NAMESPACED capability (spec: "Vendor: com.example.installments"; Shopify publishes
  // `dev.shopify.catalog` alongside the standard ids). `cc.pivota.*` is the reverse-DNS of pivota.cc, the
  // domain this gateway actually serves from.
  //
  // `spec` and `schema` are REQUIRED members of a published capability entry, so each capability carries the
  // PATHS for its own. Paths, not full URLs, so the version literal stays in ucpSpecVersion.cjs — and every
  // one was measured 200 on 2026-08-14 before being written here. That check is the point: a spec/schema URL
  // is a promise a platform can dereference, and this file has already shipped one capability id that
  // resolved to nothing. A capability with no documents is WITHHELD rather than published partial (see
  // `insights` below and `capabilityDocUrls` in ucpProfile.js).
  catalog_search: {
    ucp: 'dev.ucp.shopping.catalog.search',
    title: 'Catalog search (free text + filters)',
    specName: 'catalog',
    schemaName: 'shopping/catalog_search.json',
  },
  catalog_lookup: {
    ucp: 'dev.ucp.shopping.catalog.lookup',
    title: 'Catalog lookup by identifier',
    specName: 'catalog',
    schemaName: 'shopping/catalog_lookup.json',
  },
  // A ROOT vendor capability — deliberately NO `extends`, though that is a judgement call rather than the
  // only option. `extends` is a PRUNING KEY: intersection step 3 removes a capability whose declared parents
  // are ALL absent (single-parent needs its parent; multi-parent needs at least one). Declaring these reads
  // as extending `catalog.lookup` would delete Pivota's decision layer for any platform that does not
  // negotiate that standard capability — and the layer does not need it: these operations take a product
  // reference the platform already holds, from wherever it got it.
  //
  // Noting the divergence honestly: the live `dev.shopify.catalog` this file cites as the vendor-namespacing
  // precedent DOES declare `extends: [catalog.search, catalog.lookup]`. Root-ness costs nothing at step 1
  // (name matching ignores `extends`), so the only thing it changes is whether we can be pruned — which is
  // why we take it.
  //
  // NO specName/schemaName, and that WITHHOLDS THE WHOLE CAPABILITY rather than shipping it partial. The
  // spec: "The `spec` and `schema` fields are REQUIRED for all capabilities" — and a platform validating the
  // profile against that rule answers `profile_malformed` for the ENTIRE DOCUMENT, so one incomplete vendor
  // entry would take checkout, catalog and fulfillment down with it. Pivota hosts no spec or JSON Schema for
  // its decision layer today, and emitting a plausible `https://pivota.cc/...` would advertise a document
  // that does not exist — the same defect as advertising a capability id that does not exist, one field over.
  // The capability re-appears the moment the documents are real: pass them via `vendorCapabilityDocs` on
  // buildUcpProfile. Nothing here needs editing for that.
  insights: {
    ucp: 'cc.pivota.insights',
    title: 'Pivota Insights — alternatives, cross-merchant offers, reviewed decision intelligence',
  },
  checkout: {
    ucp: 'dev.ucp.shopping.checkout',
    title: 'Checkout session lifecycle',
    specName: 'checkout',
    schemaName: 'shopping/checkout.json',
  },
  order: {
    ucp: 'dev.ucp.shopping.order',
    title: 'Order lifecycle + after-sales',
    specName: 'order',
    schemaName: 'shopping/order.json',
  },
  identity: {
    ucp: 'dev.ucp.common.identity_linking',
    title: 'OAuth identity linking',
    // NOTE the two spellings, both measured: the spec PAGE is hyphenated, and the SCHEMA lives under
    // `common/` (not `shopping/`), matching this capability's `dev.ucp.common.*` namespace.
    specName: 'identity-linking',
    schemaName: 'common/identity_linking.json',
  },
  payment: {
    ucp: 'dev.ucp.shopping.ap2_mandate',
    title: 'Payment authorization (delegated token / AP2 mandate)',
    specName: 'ap2-mandates',
    schemaName: 'shopping/ap2_mandate.json',
  },
  // A MODIFIER capability: it carries no operation of its own. UCP models fulfillment as something that
  // EXTENDS checkout — it adds `checkout.fulfillment` to that capability's input shape and declares, in
  // machine-readable `config`, which combinations the seller can honour. Pivota's UCP door accepts exactly
  // ONE method and ONE destination (mcp-server/src/ucpArgumentAdapter.js `mapFulfillment`), because the
  // canonical quote holds a single `shipping_address` and picking among several would ship to an address the
  // buyer never chose for those lines. Declaring the bound is how a platform learns it from DISCOVERY instead
  // of from a refusal mid-checkout; the door and this config are asserted equal by
  // mcp-server/test/ucpFulfillmentAddressContract.test.js, so the advertisement cannot drift from the rule.
  fulfillment: {
    ucp: 'dev.ucp.shopping.fulfillment',
    title: 'Shipping destination on checkout',
    specName: 'fulfillment',
    schemaName: 'shopping/fulfillment.json',
    extends: ['dev.ucp.shopping.checkout'],
    config: Object.freeze({
      allows_multi_destination: Object.freeze({ shipping: false }),
      allows_method_combinations: Object.freeze([Object.freeze(['shipping'])]),
    }),
  },
});

/**
 * Canonical operations. Each declares:
 *  - capability        : which CANONICAL_CAPABILITIES key
 *  - kernel            : how it binds to the kernel (a single op, a composition, or 'external' for non-kernel)
 *  - mutating          : writes state (needs an idempotency key)
 *  - requiresUserRef   : needs a verified buyer (the kernel's ownership key)
 *  - requiresPaymentAuthz : needs verified payment authorization (delegated token / AP2 Checkout Mandate)
 *  - acp / ucp / mcp   : the per-protocol surface name
 *  - ucpTool           : the UCP SPEC tool name (flat, e.g. 'create_checkout') for the JSON-RPC
 *                        `tools/call` dialect. DISTINCT from `ucp`, which is Pivota's internal dotted
 *                        capability-operation label ('checkout.create') and is NOT what a UCP platform
 *                        sends. `null` = deliberately not exposed on the UCP dialect: only names with
 *                        EVIDENCE of the real spec name are mapped (see UCP_TOOL_EVIDENCE below).
 *                        Inventing a spec name is the "advertised but not executable" defect.
 */
export const CANONICAL_OPERATIONS = Object.freeze([
  {
    // `ucpTool: 'search_catalog'` is the spec's flat name, evidenced the same way as the checkout tools
    // (UCP_TOOL_EVIDENCE below): the buyer client took it from a live `tools/list` (cosrx, 2026-08-13),
    // alongside `lookup_catalog`, and it is a DIFFERENT tool from `get_product` — free text vs one id. Until
    // this field existed the profile builder's reachability rule (ucpProfile.js `invocableOperations`)
    // withheld `dev.ucp.shopping.catalog.search` entirely, so a UCP platform could look a product up but
    // could not ask a question. Mapping the tool is what lets that capability advertise itself.
    id: 'search_catalog', capability: 'catalog_search', kernel: 'find_products',
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: 'product_feed', ucp: 'catalog.search', mcp: 'search_catalog', ucpTool: 'search_catalog',
  },
  {
    id: 'get_product', capability: 'catalog_lookup', kernel: 'get_product_detail',
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: 'product_feed', ucp: 'catalog.get', mcp: 'get_product', ucpTool: 'get_product',
  },
  {
    // Read-only intelligence projections (decision substrate, not catalog). kernel:'local' routes them to
    // the executor's injected localReads handlers — they never touch the money kernel or upstream checkout.
    //
    // Their `ucpTool` names are VENDOR names under `cc.pivota.insights`, not dev.ucp spec names: the evidence
    // for them is Pivota's own hosted capability document (UCP_TOOL_EVIDENCE.vendor), which is the only
    // authority a vendor capability can have. They are spelled identically to the native MCP names on purpose:
    // one vocabulary for the decision layer on every door.
    id: 'get_alternatives', capability: 'insights', kernel: 'local',
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: null, ucp: 'catalog.alternatives', mcp: 'get_alternatives', ucpTool: 'get_alternatives',
  },
  {
    id: 'get_offers', capability: 'insights', kernel: 'local',
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: null, ucp: 'catalog.offers', mcp: 'get_offers', ucpTool: 'get_offers',
  },
  {
    id: 'get_intel', capability: 'insights', kernel: 'local',
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: null, ucp: 'catalog.intel', mcp: 'get_intel', ucpTool: 'get_intel',
  },
  {
    // NEED-anchored, not product-anchored: a natural-language need (+ constraints) → a reasoned shortlist.
    // The bridge to Pivota's prompt-level recommendation lane (src/agentSignals/recommendProducts.js). No
    // ucpTool yet: the UCP vendor capability document does not describe it (adding it is a docs + mapper
    // change, same as the three insights reads), so it is native-/mcp-only until then.
    id: 'recommend_products', capability: 'insights', kernel: 'local',
    mutating: false, requiresUserRef: false, requiresPaymentAuthz: false,
    acp: null, ucp: 'catalog.recommend', mcp: 'recommend_products',
  },
  {
    id: 'create_checkout_session', capability: 'checkout', kernel: 'preview_quote',
    mutating: true, requiresUserRef: true, requiresPaymentAuthz: false,
    acp: 'POST /checkout_sessions', ucp: 'checkout.create', mcp: 'create_checkout_session',
    ucpTool: 'create_checkout',
  },
  {
    id: 'update_checkout_session', capability: 'checkout', kernel: 'preview_quote', // re-quote on change
    mutating: true, requiresUserRef: true, requiresPaymentAuthz: false,
    acp: 'POST /checkout_sessions/{id}', ucp: 'checkout.update', mcp: 'update_checkout_session',
    ucpTool: 'update_checkout',
  },
  {
    id: 'get_checkout_session', capability: 'checkout', kernel: 'get_quote_snapshot',
    mutating: false, requiresUserRef: true, requiresPaymentAuthz: false,
    acp: 'GET /checkout_sessions/{id}', ucp: 'checkout.get', mcp: 'get_checkout_session',
    ucpTool: 'get_checkout',
  },
  {
    // complete = verify payment authorization → createOrder → mintConfirmation → submitPayment.
    id: 'complete_checkout_session', capability: 'checkout',
    kernel: 'create_order+mint_confirmation+submit_payment',
    mutating: true, requiresUserRef: true, requiresPaymentAuthz: true,
    acp: 'POST /checkout_sessions/{id}/complete', ucp: 'checkout.complete', mcp: 'complete_checkout_session',
    ucpTool: 'complete_checkout',
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

/**
 * WHERE THE UCP TOOL NAMES COME FROM. `src/services/ucpBuyerAgentClient.js` calls real UCP merchants and
 * carries the spec's tool names verbatim in its `TOOL` constant ("MCP tool names (verbatim from the live
 * spec)"). Those are the names a UCP platform will send US, so they are the names this contract maps.
 *
 * Deliberately NOT mapped (no evidenced spec name — inventing one would advertise an operation no platform
 * can actually call, and would fail the moment the real name differs):
 *   cancel_checkout_session, create_payment_link, get_order, request_after_sales, start_identity_linking,
 *   exchange_payment_token.
 * get_alternatives / get_offers / get_intel left that list on 2026-08-19 as VENDOR tools of
 * `cc.pivota.insights` — a vendor capability's names are evidenced by the vendor's own hosted document, not
 * by a dev.ucp listing (see UCP_TOOL_EVIDENCE.vendor).
 * `search_catalog` left that list on 2026-08-18: its spec name AND wire shape (`{ meta, catalog: { query,
 * pagination?, context?, signals?, filters? } }`, required ["meta","catalog"], no required member under
 * `catalog`) come from the same live cosrx listing as `get_product`'s, and the buyer client's
 * `searchCatalog` sends exactly that. `lookup_catalog` (batch by `catalog.ids`) is in that listing too and
 * stays unmapped: no canonical operation answers a batch, and mapping it onto N `get_product` reads here
 * would be a second composition to drift.
 * The UCP spec's `create_cart` / `get_cart` have no canonical counterpart: Pivota is quote-first, so a UCP
 * cart maps onto a checkout session rather than a separate object.
 *
 * mcp-server/test/ucpToolVocabulary.test.js pins this against the buyer client's constant, so drift on EITHER side
 * fails CI rather than being discovered by a platform integration.
 */
export const UCP_TOOL_EVIDENCE = Object.freeze({
  source: 'src/services/ucpBuyerAgentClient.js TOOL constant (verbatim from the live UCP spec)',
  mapped: Object.freeze(['search_catalog', 'get_product', 'create_checkout', 'update_checkout', 'get_checkout', 'complete_checkout']),
  unmappedSpecTools: Object.freeze(['create_cart', 'get_cart']),
  // VENDOR tools under `cc.pivota.insights`. Not in any dev.ucp listing and never will be — their evidence is
  // the capability document Pivota hosts on pivota.cc (UCP_INSIGHTS_SPEC_URL / UCP_INSIGHTS_SCHEMA_URL; the
  // profile builder publishes the capability ONLY when both resolve on that host). The vocabulary test pins
  // every vendor tool here so a name cannot be added to the dialect without also being declared as ours.
  vendorSource: 'cc.pivota.insights capability document hosted on pivota.cc (see src/server.js ucpVendorCapabilityDocs)',
  vendor: Object.freeze(['get_alternatives', 'get_offers', 'get_intel']),
});

const OPS_BY_UCP_TOOL = Object.freeze(Object.fromEntries(
  CANONICAL_OPERATIONS.filter((o) => o.ucpTool).map((o) => [o.ucpTool, o]),
));

/** Canonical operations exposed on the UCP `tools/call` dialect (evidenced spec names only). */
export const UCP_DIALECT_OPERATIONS = Object.freeze(CANONICAL_OPERATIONS.filter((o) => o.ucpTool));

/** Look up a canonical operation by its UCP spec tool name; undefined when the name is not exposed. */
export function canonicalOpForUcpTool(toolName) {
  return OPS_BY_UCP_TOOL[toolName];
}

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
