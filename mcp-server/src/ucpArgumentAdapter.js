// The UCP↔canonical ARGUMENT adapter — step 3 of UCP transact.
//
// WHAT WAS STILL BROKEN AFTER #1962. Steps 1-2 taught the contract the UCP spec's flat tool NAMES
// (create_checkout, update_checkout, …) and gave the commerce surface a `ucp` dialect that routes those names
// to the same canonical operation, the same executor and the same kernel. But `ucpCommerceToolDefinitions`
// still published Pivota-NATIVE input schemas: `create_checkout` advertised `required:
// ["idempotency_key","quote"]`. A real platform sends UCP's wire shape — `{ meta, checkout: { line_items } }`
// — which carries none of those fields, so the call is rejected before it ever reaches the executor. The
// "advertised but not executable" defect simply moved from the tool NAME into its ARGUMENTS.
//
// This module is the translation, and it is a translation ONLY: UCP wire args -> the Pivota-native TOOL ARGS
// that commerceToolSurface's existing `toParams` allowlist + `applyBuyerIntake` already consume. Nothing here
// prices, resolves a variant, decides buyer identity or builds a quote. That is deliberate — the canonical
// quote builder, the attested-wins precedence, the variant resolution and the address completeness rule all
// live in safety-kernel/src/protocol/buyerIntake.js and are shared with the ACP REST door. A second quote
// builder here would recreate the twin-drift class this repo keeps paying for.
//
// SCHEMA AND MAPPER COME FROM ONE TABLE. Every entry below owns BOTH its `inputSchema` and its `map()`, so a
// field cannot be advertised without being read (or explicitly declared unread), and cannot be read without
// being advertised. mcp-server/test/ucpArgumentAdapter.test.js drives that equivalence rather than trusting it.
//
// ---- THE WIRE SHAPES, AND WHERE THEY COME FROM ---------------------------------------------------------
//
// LIVE-VERIFIED (cosrx UCP endpoint, 2026-07-13) via src/services/ucpBuyerAgentClient.js — the shapes Pivota
// itself sends when it acts as a BUYER against another merchant's UCP endpoint. Read `buildCheckoutArgs` and
// `addressToContextHints` there; they are the source, not this comment:
//   - create_checkout : { meta, checkout: { line_items?, cart_id?, buyer?, context?, attribution? } }
//   - update_checkout : the same PLUS a TOP-LEVEL `id` (NOT nested inside `checkout`)
//   - line_items      : [{ item: { id }, quantity }] — the id is NESTED under `item`, never a flat variant_id
//   - context         : DESTINATION HINTS ONLY — { address_country, address_region, postal_code }. There is
//                       no shipping_address on create_checkout at all.
//   - meta            : required at params.arguments.meta on both tools/list and tools/call; it carries
//                       `ucp-agent.profile` and, on state-changing calls, `idempotency-key`.
//
// ALSO LIVE-VERIFIED (same merchant, `tools/list`, 2026-08-13) — this pass exists because the two shapes
// below had NEVER been fetched, and one of them was wrong:
//   - get_checkout      : required ["meta","id"]. The extrapolation was correct.
//   - complete_checkout : required ["meta","id","checkout"], with `checkout.required = ["payment"]`. The
//                         extrapolation put `payment` at the TOP LEVEL and was WRONG. Published that way,
//                         this door would have refused every conforming platform ON THE CHARGE — the exact
//                         "advertised but not executable" defect the module exists to end, on the one
//                         operation where it costs a sale. An unverified shape is a guess; a guess on the
//                         money path is not a small one.
//
//     …AND THE SAME DEFECT SURVIVED ONE LEVEL DEEPER, in the envelope itself. Getting `payment`'s LOCATION
//     right is not the same as getting its CONTENTS right: #1966 then published the merchant's own
//     `payment.instruments[]` and forwarded it opaquely, and the kernel's verifier refused it for carrying no
//     method discriminator. Advertised, and still not executable, on the same operation. What closed it was
//     not re-reading the merchant's schema but driving the ADAPTER'S OUTPUT THROUGH THE REAL VERIFIER
//     (test/ucpPaymentAuthorizationContract.test.js) — the mutation-checked argument suite could not see the
//     gap, because no test crossed that seam. See PAYMENT_SCHEMA for the contract and the measurements.
//   - the live schemas also permit `checkout.buyer.phone_number` and an optional flat `id` on a line item.
//     Both are now accepted-and-unread: a door STRICTER than the spec turns conforming callers away, which
//     fails in the same direction as advertising the wrong shape.
//   - `checkout.payment` is additionally permitted on create/update by the live schema. Pivota REFUSES it
//     there anyway — a create/update never authorizes a charge here, and silently dropping an instrument the
//     caller believes authorized one is worse than an actionable refusal. That is a DELIBERATE narrowing,
//     recorded rather than accidental, and the only one in this file.
//
//   - get_product : required ["meta","catalog"], with `catalog.required = ["id"]`. The id is NESTED under
//                   `catalog`; there is no flat `id` and no `sku`. This file first published the buyer
//                   client's flat `{query,id,sku}` (`catalogSearch`), which is wrong against the live schema
//                   — that client has the same bug and is flagged separately.
//   - search_catalog : required ["meta","catalog"], and `catalog` declares NO required member — a query-less
//                   call is legal on the wire. It is a DIFFERENT tool from `get_product`, and the two are the
//                   reason a UCP catalog has two capability ids. FULL `catalog` shape, LIVE-VERIFIED
//                   (cosrx un-negotiated `tools/list`, 2026-08-18 — the first pass had only the member names):
//                     query      : string
//                     pagination : { cursor?: string, limit?: integer (default 10, minimum 1, NO maximum) }
//                     filters    : { categories?: string[] (OR), price?: { min?: integer, max?: integer } in
//                                    MINOR currency units, available?: boolean (default true) }
//                     context    : { address_country, address_region, postal_code, language, currency, intent }
//                     signals    : { "dev.ucp.buyer_ip", "dev.ucp.user_agent" }
//                   Every one of these objects is PERMISSIVE on the live schema (additionalProperties true or
//                   undeclared), so unknown members inside them are accepted; only the top level and
//                   `catalog` itself are strict here, as for get_product. What is READ, and why the rest is
//                   not, is the subject of the SPECS entry — see SEARCH_CATALOG_DESCRIPTION and
//                   UCP_ACCEPTED_BUT_UNMAPPED.search_catalog.
//
// A MEASUREMENT TRAP WORTH REMEMBERING. The first 2026-08-13 listing showed only 9 tools — cart and checkout —
// and this file recorded that a per-merchant endpoint "does not expose get_product at all". That was wrong:
// the merchant NEGOTIATES the tool list against the calling agent's profile, and ours is narrowed to
// cart+checkout. Listing WITHOUT an agent profile returns 13 tools, `get_product` among them. Absence from one
// negotiated listing is not evidence of absence — probe both ways before concluding a capability is missing.
// (Pivota's own profile requests `dev.ucp.shopping.catalog` and still loses it in negotiation; that is a
// separate open question, not something this file can fix.)
//
// ---- WHAT THE CANONICAL SIDE CANNOT ACCEPT, AND WHY IT IS NOT PAPERED OVER -------------------------------
//
//  1. `context` IS NOT FORWARDED. The canonical quote's only destination carrier is `shipping_address`, and
//     safety-kernel `buyerIntake.pickCompleteAddress` requires all five of name/address_line1/city/
//     postal_code/country together — because pivota-backend `_coerce_shipping_address` does. UCP's hints are
//     three fields and none of them is a name or a street, so promoting them into an address would mean
//     FABRICATING the other two. The one adjacent field the upstream body builder does read is
//     `quote.currency` (src/server.js buildInvokeRequestContext), and BOTH existing doors deliberately refuse
//     to copy a caller-set currency into pricing ("a caller-set amount/total/currency never reaches pricing,
//     because nothing here copies one" — acpRestAdapter mapItemsToQuote). Widening that for UCP alone would
//     weaken an invariant the other doors hold. So the hints are accepted on the wire, declared in the schema,
//     and carried nowhere — and the tests pin that a MISSING context fabricates nothing either.
//
//  2. `item.id` BECOMES `product_id`, and the variant is RESOLVED. UCP's line item carries exactly one
//     identity; the canonical item requires `product_id` and treats `variant_id` as optional-and-resolvable.
//     This is the same position the ACP door is already in — Pivota's own ACP feed publishes `sig_*` product
//     ids and NO variant identity, which is precisely why `createDefaultVariantResolver` exists — so the UCP
//     dialect inherits that contract rather than inventing a second one. A product that resolves to more than
//     one real variant is REFUSED, never guessed (buyerIntake rule 3), and a UCP caller has no field in which
//     to name the variant it wanted. That bound is real and is stated in the tool description.
//
//  3. THE ADDRESS ARRIVES AS `fulfillment`, AND IT RIDES ON THE QUOTE. This note twice said the wrong thing,
//     and each wrong version hid the same defect. It first said UCP "carries no shipping_address"; the live
//     create_checkout schema DOES carry a full destination at `checkout.fulfillment.methods[].destinations[]`.
//     It then recorded that as an open blocker: pivota-backend origin/main
//     `routes/agent_v2.py::_coerce_shipping_address` (reached from `POST /agent/v2/orders`) requires a complete
//     address UNCONDITIONALLY, so an address-less UCP completion was refused 400 INVALID_BUYER_CONTEXT AFTER a
//     valid authorization had verified — the lane could not place an order even with a good grant.
//     `mapFulfillment` closes it. What the mapping had to settle, and what decided each one:
//       - WHERE IT RIDES: create/update, never complete. `complete_checkout`'s checkout object accepts only
//         `{payment, attribution}` — there is no fulfillment member to put it in. It still reaches order
//         creation because `kernel.createOrder` prefers the LOCKED quote's `buyer_context.shipping_address`
//         over the payload's, so an address supplied at create survives to the order. Both create and update
//         carry it because an update RE-MINTS the snapshot (QUOTE_INTAKE_OPS), so an omitted address is dropped.
//       - MULTI-DESTINATION: REFUSED, not resolved. The canonical quote holds ONE address, and choosing among
//         several would ship goods to an address the buyer did not pick for those lines. Pivota declares
//         `allows_multi_destination: {shipping: false}` in its own profile and the door enforces exactly that,
//         so `selected_destination_id` has nothing to select and is accepted-and-unread.
//       - AN INCOMPLETE DESTINATION: refused AT THE DOOR, naming UCP's own field spellings — but by the SHARED
//         `pickCompleteAddress`, not a second completeness rule. Only the names are translated.
//     See the `DESTINATION_TO_CANONICAL` note for the per-field mapping and the four-file chain it relies on.
//
//  4. `payment` IS REFUSED, NOT DROPPED — ON BOTH LANES. The buyer client hard-bounds itself against ever
//     emitting one on create/update; the server side must not accept one there either. A caller that sends
//     `payment` on create believes it is authorizing a charge, so it is told plainly that authorization
//     arrives inline on complete_checkout — silently discarding it would leave that caller believing it had
//     paid. The SAME rule is why `payment.instruments` is refused by name on complete_checkout (PAYMENT_SCHEMA
//     and `requirePaymentEnvelope`): Pivota cannot charge a UCP payment-handler instrument, and accepting one
//     into an opaque passthrough would leave that caller believing it had paid too — one refusal later, and
//     several layers further from the field it would have to fix.
//
// IDENTITY IS NEVER READ FROM HERE. `checkout.buyer.email` is mapped to `quote.customer_email`, which is a
// GAP-FILLER by construction: commerceToolSurface's intake runs it through buyerIntake `resolveBuyerEmail`,
// which reads the ATTESTED address from the verified session FIRST and only falls back to a body value when
// the credential carries none. Nothing in this file can override a verified buyer.

import {
  MAX_CART_ITEMS,
  intakeRefusal,
  pickCompleteAddress,
  REQUIRED_ADDRESS_FIELDS,
} from "../../safety-kernel/src/protocol/buyerIntake.js";
import { CANONICAL_PAYMENT_METHODS } from "../../safety-kernel/src/protocol/paymentAuthorizationVerifier.js";
import { isoMinorUnitExponent } from "../../safety-kernel/src/money.js";

// The prototype guard used across the doors: admits `Object.prototype` and a null prototype, nothing else.
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const nonEmpty = (s) => typeof s === "string" && s.trim() !== "";

/** Own-property read that can never resolve through the prototype chain. */
function own(src, key) {
  if (!isPlainObject(src)) return undefined;
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
}

/**
 * A UCP wire-shape refusal. Built through the SHARED `intakeRefusal` so it arrives at the model through the
 * same curated-message + field-detail opt-in every other intake refusal uses (`surfaceableIntakeRefusal` ->
 * `toToolError`), instead of a generic per-code userMessage that names nothing the caller could fix.
 *
 * Every message names UCP's OWN field spelling. This is not cosmetic: buyerIntake's own note records that a
 * shared message telling MCP callers to supply `buyer.email` — a field that door strips — made models retry
 * the identical call. A refusal that misdirects burns a retry and teaches the wrong contract.
 */
function ucpRefusal(code, reason, message, extra = {}) {
  return intakeRefusal(code, reason, message, { dialect: "ucp", ...extra });
}

// Checkout-lane refusals keep QUOTE_REQUIRED, matching what the ACP and MCP doors already raise for an
// intake problem on these operations, so a client's existing branch on the code keeps working.
const CHECKOUT_REFUSAL_CODE = "QUOTE_REQUIRED";

// ---- shared pieces of the wire shape ---------------------------------------------------------------------

const META_DESCRIPTION = [
  "UCP request meta, required at params.arguments.meta on every tools/list and tools/call.",
  "Carries `ucp-agent.profile` (the calling agent's hosted capability profile) and, on state-changing calls,",
  "`idempotency-key`.",
].join(" ");

const IDEMPOTENCY_KEY_DESCRIPTION = [
  "REQUIRED on this state-changing tool. Client-generated; a replay returns the original result rather than",
  "minting a second quote or a second charge. Pivota does NOT generate one for you — a server-minted key would",
  "make every retry a new request, which is the opposite of what the key is for.",
].join(" ");

function metaSchema({ idempotency }) {
  return {
    type: "object",
    // The meta envelope belongs to UCP, not to Pivota: unknown members are the platform's business and are
    // neither rejected nor read.
    additionalProperties: true,
    ...(idempotency ? { required: ["idempotency-key"] } : {}),
    properties: {
      "ucp-agent": {
        type: "object",
        additionalProperties: true,
        properties: { profile: { type: "string", description: "URL of the calling agent's UCP capability profile." } },
      },
      "idempotency-key": { type: "string", minLength: 8, description: IDEMPOTENCY_KEY_DESCRIPTION },
    },
    description: META_DESCRIPTION,
  };
}

const LINE_ITEM_ID_DESCRIPTION = [
  "The Pivota `product_id` for this line (the id `get_product` answers about).",
  "Pivota resolves the product's default variant server-side and REFUSES rather than guessing when that is",
  "ambiguous — a variant id is never derived from a product id. The UCP line-item shape has no field in which",
  "to name a specific variant, so a product with more than one purchasable variant cannot be checked out over",
  "this dialect.",
].join(" ");

const LINE_ITEMS_SCHEMA = {
  type: "array",
  minItems: 1,
  // The shared per-cart bound, imported rather than restated so the schema cannot drift from the runtime cap.
  maxItems: MAX_CART_ITEMS,
  items: {
    type: "object",
    required: ["item", "quantity"],
    additionalProperties: false,
    properties: {
      item: {
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: { id: { type: "string", description: LINE_ITEM_ID_DESCRIPTION } },
      },
      quantity: { type: "integer", minimum: 1 },
      // LIVE-VERIFIED (cosrx tools/list, 2026-08-13): the line may ALSO carry an optional flat `id` beside
      // `item`. It is accepted and NOT read — `item.id` is the required identity and the only one this door
      // prices from. Declaring it matters: without it a conforming platform that sends the optional field is
      // refused by the strict unknown-field guard for a shape the spec allows.
      id: {
        type: "string",
        description: "Optional line id. Accepted and NOT read — `item.id` is the purchasable identity.",
      },
    },
  },
  description: "Required. The lines to price; the id is NESTED under `item`, per the UCP wire shape.",
};

const BUYER_SCHEMA = {
  type: "object",
  // LIVE-VERIFIED: the merchant declares `buyer` with additionalProperties:true and the members
  // ["email","phone_number"]. Mirrored rather than narrowed — a stricter door than the spec refuses
  // conforming callers, which is the same "not executable" failure as advertising the wrong shape.
  additionalProperties: true,
  properties: {
    email: {
      type: "string",
      description:
        "Buyer email for the order/receipt. Used ONLY when the verified session carries no attested address —"
        + " an attested email always wins and this field is then ignored. Never assert an address on the"
        + " buyer's behalf.",
    },
    phone_number: {
      type: "string",
      description: "Accepted and NOT read: Pivota's canonical quote carries no buyer phone.",
    },
  },
};

// The payment envelope. This is the ONE field on this dialect whose contents decide whether money moves, so it
// is published as exactly what the gate downstream can actually verify — no more, and no less.
//
// WHAT THE GATE ACTUALLY REQUIRES (safety-kernel verifyPaymentAuthorization + createSignedGrantVerifier, both
// exercised directly by test/ucpPaymentAuthorizationContract.test.js rather than described):
//   1. a METHOD DISCRIMINATOR — `method` (or `protocol`) drawn from CANONICAL_PAYMENT_METHODS. Absent, the
//      verifier throws CONFIRMATION_INVALID{unknown_authorization_method} and no charge happens.
//   2. a SIGNED ALLOWANCE GRANT at `token` — a compact JWT from a registered issuer (pinned JWKS, asymmetric
//      alg allowlist) whose claims carry max_amount/currency/merchant_id/checkout_session_id and an `exp`.
//      The binding invariant is checked against THOSE claims, never the raw envelope.
//
// WHY THE MERCHANT'S OWN `instruments` SHAPE IS NOT PUBLISHED HERE. The live cosrx schema (2026-08-13) declares
// `payment.instruments[]` as `{id, handler_id, type, credential:{token,type}, billing_address, display}`, where
// `credential.token` is an OPAQUE PSP token (`stripe.token`, `google.pay`) — a payment-handler instrument the
// MERCHANT charges on its own rail. Pivota is the merchant of record on this lane and holds no UCP
// payment-handler integration, so that instrument authorizes nothing here. Measured, not assumed:
//   - the live shape as published by #1966  -> unknown_authorization_method
//   - the same shape + method:'ucp_handler' -> grant_token_missing      (the discriminator ALONE fixes nothing)
//   - the same, credential.token lifted     -> malformed_credential     (a PSP token is not a signed grant)
//   - method:'ucp_handler' + a signed grant -> OK
// So mapping `handler_id` into a discriminator would have swapped one refusal for another one deeper in the
// money path — a fallback that is valid-looking and still cannot charge. The envelope below publishes the one
// shape that completes, and `instruments` is REFUSED BY NAME (see `requirePaymentEnvelope`) rather than
// accepted-and-dropped: a caller that attached an instrument believes it authorized a charge.
//
// The published method is a LITERAL, CHECKED against the kernel's vocabulary — not derived from it. The
// distinction matters and an earlier version of this comment got it wrong: renaming the method in the kernel
// does not silently re-point this door, it makes the check below fail. That is the intended direction (a
// rename is a decision someone must make on both sides), but it is a guard, not a derivation.
//
// Only `ucp_handler` is published: it is the method productionWiring wires for this dialect, and advertising
// `ap2_mandate` (whose carrier is a `mandate`, and which is off unless `enableAp2`) would re-open exactly the
// advertised-but-not-executable gap this module exists to close.
const UCP_PAYMENT_METHOD = "ucp_handler";

/**
 * Fail closed if the published discriminator is not one the kernel's verifier will accept.
 *
 * EXPORTED AND CALLED AT LOAD, deliberately both. Called at load because a door publishing a method the gate
 * refuses is the exact defect this module exists to end, and it should not wait for a charge to surface.
 * Exported because when this lived inline as a bare `if (…) throw`, deleting it left the whole suite green —
 * and by this file's own standard (see the depth-walk test) a guard no test can kill is not a guard.
 */
export function assertPublishedPaymentMethodIsCanonical(method = UCP_PAYMENT_METHOD, canonical = CANONICAL_PAYMENT_METHODS) {
  if (!canonical.includes(method)) {
    throw new Error(
      `ucpArgumentAdapter: "${method}" is not a canonical payment method `
      + `(${canonical.join(", ")}) — the published payment envelope would not verify`,
    );
  }
  return method;
}
assertPublishedPaymentMethodIsCanonical();

const PAYMENT_METHOD_DESCRIPTION = [
  `REQUIRED. The payment-authorization method. Must be \`${UCP_PAYMENT_METHOD}\` on this dialect — it selects`,
  "the server-side verifier that checks the grant against this checkout's locked total.",
].join(" ");

const PAYMENT_TOKEN_DESCRIPTION = [
  "REQUIRED. The signed UCP payment-handler GRANT authorizing this checkout: a compact JWT from an issuer",
  "Pivota has registered, whose claims carry `max_amount`, `currency`, `merchant_id`, `checkout_session_id`",
  "(the id of THIS checkout) and `exp`. It is verified against a pinned key set and bound to the locked total,",
  "the merchant of record, this session and this buyer; the charge is taken from the locked quote, never from",
  "`max_amount`. An opaque PSP/wallet instrument token is NOT a grant and cannot authorize a charge here.",
].join(" ");

const PAYMENT_SCHEMA = {
  type: "object",
  required: ["method", "token"],
  // Strict, and the mapper enforces the SAME strictness. This is deliberately NARROWER than the merchant's own
  // envelope (which is additionalProperties:true around `instruments`): publishing a field this door cannot
  // honour on the money path is the defect, not the strictness.
  additionalProperties: false,
  properties: {
    method: { type: "string", enum: [UCP_PAYMENT_METHOD], description: PAYMENT_METHOD_DESCRIPTION },
    token: { type: "string", description: PAYMENT_TOKEN_DESCRIPTION },
  },
  description:
    "The payment authorization for this checkout. VERIFIED server-side against the locked total, the merchant"
    + " of record, this checkout session and this buyer — never trusted blindly.",
};

const CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    address_country: { type: "string" },
    address_region: { type: "string" },
    postal_code: { type: "string" },
  },
  description:
    "Destination HINTS. Accepted and NOT forwarded into pricing: Pivota's quote carries a destination only as a"
    + " COMPLETE address, and these three fields cannot become one without inventing the rest. Nothing here is"
    + " fabricated into an address — send the real destination as"
    + " `checkout.fulfillment.methods[0].destinations[0]`, which IS read.",
};

// ---- fulfillment: the destination, and the ONE table that maps it -----------------------------------------
//
// LIVE-VERIFIED (cosrx `tools/list`, 2026-08-13) at `checkout.fulfillment.methods[].destinations[]`. This is
// the field that makes the UCP lane able to place an order at all: pivota-backend `_coerce_shipping_address`
// requires a complete address UNCONDITIONALLY at `POST /agent/v2/orders`, so before this mapping a UCP
// completion was refused 400 INVALID_BUYER_CONTEXT *after* a valid payment authorization had verified.
//
// WHY IT RIDES ON create/update AND NOT ON complete. Not a preference — the live schemas leave no choice, and
// the kernel makes it work:
//   - `complete_checkout`'s checkout object accepts ONLY `{payment, attribution}` (checkout.required =
//     ["payment"]). There is no fulfillment member, so a door that collected the address there would be
//     advertising a field no conforming platform will ever send — the same defect in the other direction.
//   - It still reaches order creation, because the address is carried by the LOCKED QUOTE, not by the
//     completing call: create/update put it in `quote.shipping_address` -> kernel `buyerContextFromQuotePayload`
//     -> the quote snapshot's `buyer_context.shipping_address` -> and `kernel.createOrder` prefers that LOCKED
//     address over the one on the order payload (`lockedShipping || requestedShipping`). canonicalExecutor's
//     `params.shipping_address ?? {}` at completion is therefore the FALLBACK, not the source.
//   That chain crosses four files, so it is not asserted here — test/ucpFulfillmentAddressContract.test.js
//   drives a real create through the real kernel and reads the address off the `create_order` body the backend
//   would receive. This module's own history is why: a seam no test crosses is where the defect lives.
//
// ONE TABLE, BOTH DIRECTIONS. It builds the canonical address, and it names the missing fields back in UCP's
// own spelling when the destination is incomplete. A refusal that says `address_line1` to a caller whose field
// is called `street_address` names nothing it can fix — the same misdirection buyerIntake already records for
// `buyer.email`, where it made models retry the identical call.
const DESTINATION_TO_CANONICAL = Object.freeze({
  street_address: "address_line1",
  extended_address: "address_line2",
  address_locality: "city",
  address_region: "state",
  postal_code: "postal_code",
  address_country: "country",
  phone_number: "phone",
});

// The reverse direction, as REAL FIELD NAMES rather than a display string — `detail.missing_fields` is a
// structured contract clients branch on, so it must carry names they can look up, not prose. `name` is the one
// canonical field with no single UCP counterpart: it is composed from first_name + last_name, so it maps to
// BOTH.
const CANONICAL_TO_DESTINATION_FIELDS = Object.freeze({
  ...Object.fromEntries(Object.entries(DESTINATION_TO_CANONICAL).map(([ucp, canonical]) => [canonical, [ucp]])),
  name: Object.freeze(["first_name", "last_name"]),
});

// The backend's five required fields, split by the RULE THAT ACTUALLY APPLIES to each. Every one is required,
// but `name` is satisfied by EITHER part — `mapFulfillment` composes it from whichever arrived, so a buyer
// with one name is not an error. Derived from REQUIRED_ADDRESS_FIELDS so a field added to the shared rule
// cannot be missed here.
const REQUIRED_ADDRESS_ANY_OF = CANONICAL_TO_DESTINATION_FIELDS.name;
const REQUIRED_ADDRESS_ALL_OF = Object.freeze(
  REQUIRED_ADDRESS_FIELDS.filter((f) => f !== "name")
    .flatMap((f) => CANONICAL_TO_DESTINATION_FIELDS[f] ?? [f]),
);

const DESTINATION_FIELDS = Object.freeze(["id", "first_name", "last_name", ...Object.keys(DESTINATION_TO_CANONICAL)]);

const DESTINATION_SCHEMA = {
  type: "array",
  // SINGLE destination, declared in the schema and enforced by the mapper. Pivota's canonical quote carries
  // exactly ONE `shipping_address`; splitting a cart across destinations is a fulfillment capability this
  // lane does not have. Choosing one of several would ship goods to an address the buyer did not pick for
  // those lines — a silent, physical wrong answer — so the bound is advertised instead of guessed. It is also
  // what Pivota declares in its own profile (`allows_multi_destination: {shipping: false}`), so the door
  // enforces exactly the bound it publishes.
  minItems: 1,
  maxItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        description:
          "Accepted and NOT read. With a single destination there is nothing to select between; Pivota refuses"
          + " a multi-destination checkout rather than choosing among them.",
      },
      first_name: { type: "string", description: "Recipient's first name; joined with `last_name`." },
      last_name: { type: "string", description: "Recipient's last name; joined with `first_name`." },
      phone_number: { type: "string", description: "Recipient phone, carried with the address." },
      street_address: { type: "string", description: "Street address (canonical `address_line1`)." },
      extended_address: { type: "string", description: "Apartment/suite (canonical `address_line2`)." },
      address_locality: { type: "string", description: "City (canonical `city`)." },
      address_region: { type: "string", description: "State/region." },
      postal_code: { type: "string", description: "Postal code." },
      address_country: { type: "string", description: "Country (canonical `country`)." },
    },
  },
  description:
    "The destination to ship to — EXACTLY ONE. Required together: `first_name`/`last_name`, `street_address`,"
    + " `address_locality`, `postal_code`, `address_country`; a destination missing any of them is refused"
    + " here, naming the missing fields, rather than failing later at order creation.",
};

/** The methods array. `required` differs between the two live tools, so it is a parameter, not a constant. */
function fulfillmentSchema({ update }) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      methods: {
        type: "array",
        minItems: 1,
        // ONE method, for the same reason as one destination: Pivota's quote has a single destination and
        // prices one shipment. This matches the `allows_method_combinations: [["shipping"]]` Pivota declares.
        maxItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          // LIVE-VERIFIED, and the two tools genuinely DIFFER: create_checkout's method requires `type`,
          // update_checkout's requires `line_item_ids` and additionally permits a method `id`. Publishing one
          // shape for both would refuse a conforming caller on whichever tool it got wrong.
          required: update ? ["line_item_ids"] : ["type"],
          properties: {
            ...(update
              ? { id: { type: "string", description: "Accepted and NOT read — the merchant's own method id." } }
              : {}),
            type: {
              type: "string",
              // NOT constrained to an enum. The only evidence for the vocabulary is the live capability config
              // (`allows_method_combinations: [["shipping"]]`); ucp.dev's own fulfillment schema was
              // unreachable from this network when this was written, and inventing an enum from one merchant's
              // config would refuse conforming callers over a token never verified. Ambiguity is refused
              // structurally instead — more than one method, or more than one destination.
              description: "Accepted and NOT read. Pivota ships the cart to the single destination below.",
            },
            line_item_ids: {
              type: "array",
              items: { type: "string" },
              description:
                "Accepted and NOT read. With one destination the whole cart ships to it; Pivota cannot"
                + " fulfil a subset of lines separately.",
            },
            selected_destination_id: {
              type: "string",
              description: "Accepted and NOT read — there is exactly one destination to select.",
            },
            destinations: DESTINATION_SCHEMA,
            groups: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                // LIVE: update_checkout's group requires `id`; create_checkout's declares no required member.
                // The key is OMITTED rather than set to `[]`, which is not a valid JSON Schema `required`.
                ...(update ? { required: ["id"] } : {}),
                properties: {
                  id: { type: "string" },
                  selected_option_id: { type: "string" },
                },
              },
              description:
                "Accepted and NOT read. Pivota prices and selects shipping itself; the locked quote's"
                + " shipping total is authoritative.",
            },
          },
        },
      },
    },
    description:
      "Where to ship. Supply it here (or on `update_checkout`) — `complete_checkout` has no fulfillment member,"
      + " so an address given only at completion cannot exist. The address is held on the LOCKED quote and is"
      + " what the order is created with.",
  };
}

/** The method keys the mapper accepts, kept in lockstep with the schema above. */
function methodFields({ update }) {
  return [
    ...(update ? ["id"] : []),
    "type", "line_item_ids", "selected_destination_id", "destinations", "groups",
  ];
}

/**
 * UCP `checkout.fulfillment` -> the canonical `shipping_address`, or `undefined` when no destination was given
 * (absent is legal — a checkout may be opened without one and the address supplied by `update_checkout`).
 *
 * Nothing here is fabricated: every canonical field comes from a field the caller actually sent, and the
 * COMPLETENESS RULE IS THE SHARED ONE (`pickCompleteAddress`) rather than a second copy — only the refusal's
 * field NAMES are translated back into UCP's spelling.
 */
function mapFulfillment(checkout, { update }) {
  const code = CHECKOUT_REFUSAL_CODE;
  const fulfillment = own(checkout, "fulfillment");
  if (fulfillment === undefined) return undefined;
  if (!isPlainObject(fulfillment)) {
    throw ucpRefusal(code, "ucp_fulfillment_invalid",
      "`checkout.fulfillment` must be an object carrying `methods`.",
      { rejected_field: "checkout.fulfillment" });
  }
  rejectUnknown(fulfillment, ["methods"], "checkout.fulfillment", code);

  const methods = own(fulfillment, "methods");
  if (methods === undefined) return undefined;
  if (!Array.isArray(methods)) {
    throw ucpRefusal(code, "ucp_fulfillment_methods_invalid",
      "`checkout.fulfillment.methods` must be an array.",
      { rejected_field: "checkout.fulfillment.methods" });
  }
  if (methods.length > 1) {
    throw ucpRefusal(code, "ucp_fulfillment_multi_method_unsupported", [
      "`checkout.fulfillment.methods` may name at most ONE method. Pivota prices a single shipment to a",
      "single destination and cannot split a cart across fulfilment methods, so combining them is refused",
      "rather than partially honoured.",
    ].join(" "), { rejected_field: "checkout.fulfillment.methods", max_methods: 1 });
  }
  // EMPTY IS REFUSED, NOT READ AS "NONE". The schema declares `minItems: 1`, and a mapper that quietly
  // treated `[]` as "no fulfillment supplied" would be laxer than the contract it publishes — the drift this
  // module exists to end, on the field that decides whether an order can be created. The cost is not
  // cosmetic: a caller whose destination list came out empty (not yet chosen, or an upstream mapping bug)
  // would be ACCEPTED here, open an address-less checkout, authorize payment, and only then be refused 400
  // INVALID_BUYER_CONTEXT by pivota-backend at order creation — the exact blocker `mapFulfillment` closes,
  // reappearing after a valid grant has verified and naming canonical fields UCP has no word for. Refusing
  // now names the caller's own field while nothing has been priced.
  if (methods.length === 0) {
    throw ucpRefusal(code, "ucp_fulfillment_methods_empty", [
      "`checkout.fulfillment.methods` must name one method if `fulfillment` is present. Send the shipping",
      "destination as `fulfillment.methods[0].destinations[0]`, or omit `checkout.fulfillment` entirely and",
      "supply the address later via `update_checkout` — an empty list is neither, and a checkout with no",
      "address cannot be completed into an order.",
    ].join(" "), { rejected_field: "checkout.fulfillment.methods", min_methods: 1 });
  }

  const method = methods[0];
  if (!isPlainObject(method)) {
    throw ucpRefusal(code, "ucp_fulfillment_method_invalid",
      "`checkout.fulfillment.methods[]` entries must be objects.",
      { rejected_field: "checkout.fulfillment.methods[]" });
  }
  rejectUnknown(method, methodFields({ update }), "checkout.fulfillment.methods[]", code);
  const groups = own(method, "groups");
  if (Array.isArray(groups)) {
    for (const group of groups) {
      rejectUnknown(group, ["id", "selected_option_id"], "checkout.fulfillment.methods[].groups[]", code);
    }
  }

  const destinations = own(method, "destinations");
  if (destinations === undefined) return undefined;
  if (!Array.isArray(destinations)) {
    throw ucpRefusal(code, "ucp_fulfillment_destinations_invalid",
      "`checkout.fulfillment.methods[].destinations` must be an array.",
      { rejected_field: "checkout.fulfillment.methods[].destinations" });
  }
  if (destinations.length > 1) {
    throw ucpRefusal(code, "ucp_fulfillment_multi_destination_unsupported", [
      "`checkout.fulfillment.methods[].destinations` may name EXACTLY ONE destination. Pivota's checkout",
      "carries a single shipping address, and picking one of several would ship to an address the buyer did",
      "not choose for those lines — so this is refused rather than resolved by guessing. Open one checkout",
      "per destination.",
    ].join(" "), {
      rejected_field: "checkout.fulfillment.methods[].destinations",
      max_destinations: 1,
      destination_count: destinations.length,
    });
  }
  // Same rule as the empty `methods` above, and the more likely of the two to arrive from a real platform:
  // `destinations: []` is the shape a caller produces when its own destination lookup returned nothing.
  if (destinations.length === 0) {
    throw ucpRefusal(code, "ucp_fulfillment_destinations_empty", [
      "`checkout.fulfillment.methods[].destinations` must name exactly ONE destination when `fulfillment` is",
      "present. Send the shipping address there, or omit `checkout.fulfillment` entirely and supply it later",
      "via `update_checkout` — an empty list is neither, and a checkout with no address cannot be completed",
      "into an order.",
    ].join(" "), {
      rejected_field: "checkout.fulfillment.methods[].destinations",
      min_destinations: 1,
      max_destinations: 1,
    });
  }

  const destination = destinations[0];
  if (!isPlainObject(destination)) {
    throw ucpRefusal(code, "ucp_fulfillment_destination_invalid",
      "`checkout.fulfillment.methods[].destinations[]` entries must be objects.",
      { rejected_field: "checkout.fulfillment.methods[].destinations[]" });
  }
  rejectUnknown(destination, DESTINATION_FIELDS, "checkout.fulfillment.methods[].destinations[]", code);

  // ABSENT AND UNUSABLE ARE NOT THE SAME MISTAKE, and telling them apart is the difference between a refusal
  // the caller can act on and one that burns a retry. `nonEmpty` requires a non-blank STRING, so a field sent
  // as a JSON number (`postal_code: 90210` — a routine serialization slip for numeric postcodes) or as `""`
  // is skipped here and would otherwise be reported as MISSING, telling the caller to supply a field it
  // demonstrably just sent. `unusable` records those separately so the refusal can name the real problem.
  const address = {};
  const unusable = [];
  for (const [ucpField, canonicalField] of Object.entries(DESTINATION_TO_CANONICAL)) {
    const value = own(destination, ucpField);
    if (nonEmpty(value)) address[canonicalField] = value.trim();
    else if (value !== undefined) unusable.push(ucpField);
  }
  // `name` is COMPOSED, never invented: whichever of the two parts arrived is used, and if neither did the
  // completeness rule below refuses naming both. A missing surname does not block an order.
  const nameParts = ["first_name", "last_name"].map((part) => [part, own(destination, part)]);
  for (const [part, value] of nameParts) {
    if (value !== undefined && !nonEmpty(value)) unusable.push(part);
  }
  const name = nameParts
    .map(([, value]) => value)
    .filter((value) => nonEmpty(value))
    .map((value) => value.trim())
    .join(" ");
  if (name) address.name = name;

  let complete;
  try {
    // THE SHARED RULE, imported. A second completeness check here is exactly the twin-drift class this repo
    // keeps paying for — pivota-backend `_coerce_shipping_address` is the authority and buyerIntake is its one
    // mirror. Only the NAMES in the refusal are UCP's.
    complete = pickCompleteAddress(address, { updateHint: "the `update_checkout` tool" });
  } catch (error) {
    // ONLY the shared completeness refusal is translated. `intakeRefusal` nests its structured extras under
    // `detail.acp_detail` (the door-mapper opt-in), NOT on `detail` itself — reading the wrong level yields
    // `[]` and a refusal that names nothing. Anything else — a future validation with a different detail
    // shape, or a plain programming error inside buyerIntake — is RETHROWN UNCHANGED rather than dressed up
    // as "your destination is incomplete", which would both mislead the caller and bury the real fault.
    const missingCanonical = error?.detail?.acp_detail?.missing_fields;
    if (!Array.isArray(missingCanonical) || missingCanonical.length === 0) throw error;

    // ONE canonical field can map to SEVERAL UCP fields that satisfy it EITHER-OR — `name` is composed, so
    // `first_name` ALONE is enough and a mononymous buyer is not an error. Walking per canonical field keeps
    // that: if any of its UCP parts was sent-but-unusable, THAT part is the fix and none of the others is
    // reported missing; only when nothing arrived for the field at all are its parts listed as absent.
    // (Flattening first and filtering afterwards said `last_name` was missing when un-blanking `first_name`
    // would have satisfied it — the same misdirection this refusal exists to remove.)
    const absent = [];
    const sentButUnusable = [];
    for (const canonicalField of missingCanonical) {
      const fields = CANONICAL_TO_DESTINATION_FIELDS[canonicalField] ?? [canonicalField];
      const sent = fields.filter((f) => unusable.includes(f));
      if (sent.length) sentButUnusable.push(...sent);
      else absent.push(...fields);
    }

    // The address itself is PII and is never echoed — only field names travel.
    throw ucpRefusal(code, "ucp_fulfillment_destination_incomplete", [
      "`checkout.fulfillment.methods[].destinations[]` is incomplete. A destination is OPTIONAL — a checkout",
      "may be opened without one and the address supplied later via `update_checkout` — but one that IS given",
      `must carry ${REQUIRED_ADDRESS_ALL_OF.map((f) => `\`${f}\``).join(", ")}, and at least one of`,
      `${REQUIRED_ADDRESS_ANY_OF.map((f) => `\`${f}\``).join(" or ")},`,
      "because order creation requires a complete address.",
      ...(absent.length ? [`Missing: ${absent.map((f) => `\`${f}\``).join(", ")}.`] : []),
      ...(sentButUnusable.length ? [
        `Sent but unusable: ${sentButUnusable.map((f) => `\`${f}\``).join(", ")} —`,
        "each must be a NON-EMPTY JSON STRING (a number such as `90210` is not, and was ignored).",
      ] : []),
    ].join(" "), {
      missing_fields: absent,
      // Present but not a usable string. Distinct from `missing_fields` on purpose: the two need different
      // fixes, and conflating them is what made the refusal unactionable.
      invalid_fields: sentButUnusable,
      // ALL-OF and ANY-OF are separate keys because they are separate rules. Listing `first_name` and
      // `last_name` side by side in one required list says BOTH are needed, and a caller validating against
      // it would refuse a mononymous buyer's address or invent a surname — fabricating buyer data, which is
      // exactly what this door refuses to do anywhere else.
      required_fields: [...REQUIRED_ADDRESS_ALL_OF],
      required_any_of: [[...REQUIRED_ADDRESS_ANY_OF]],
    });
  }
  return complete;
}

const CART_ID_SCHEMA = {
  type: "string",
  description:
    "Accepted and NOT read. Pivota is quote-first and mints no UCP cart (create_cart/get_cart are deliberately"
    + " absent from this dialect), so a cart id was issued by some other system. `line_items` is what prices —"
    + " which is also what the live create_checkout schema requires even when converting a cart.",
};

const ATTRIBUTION_SCHEMA = {
  type: "object",
  additionalProperties: true,
  description: "Accepted and NOT read. Pivota's canonical quote carries no attribution field.",
};

/** The `checkout` object. `update` selects the live per-tool differences inside `fulfillment.methods[]`. */
function checkoutSchema({ update } = {}) {
  return {
    type: "object",
    required: ["line_items"],
    // Strict, and the mapper enforces the SAME strictness (see `rejectUnknown`): a schema that says
    // additionalProperties:false while the mapper silently ignores extras is exactly the drift this module
    // exists to end. `payment` is refused by name, with a message that says where authorization belongs.
    additionalProperties: false,
    properties: {
      line_items: LINE_ITEMS_SCHEMA,
      cart_id: CART_ID_SCHEMA,
      buyer: BUYER_SCHEMA,
      context: CONTEXT_SCHEMA,
      fulfillment: fulfillmentSchema({ update }),
      attribution: ATTRIBUTION_SCHEMA,
    },
  };
}

/** The `checkout` members the mapper accepts, kept in lockstep with `checkoutSchema` above. */
const CHECKOUT_FIELDS = Object.freeze(["line_items", "cart_id", "buyer", "context", "fulfillment", "attribution"]);

// Fields this adapter deliberately ACCEPTS and does not carry into the canonical params. Exported so the
// anti-drift test can assert that every advertised field is either mapped or listed here — i.e. that no field
// is quietly ignored without a decision having been recorded.
//
// LEAF-EXACT, and matched that way by the test. An earlier version named ancestors (`checkout.context`) and
// let the test treat an entry as covering everything beneath it. That was a blanket permit, not a shorthand:
// a newly advertised `checkout.context.shipping_address` would have been accepted-and-unread with nothing
// objecting — on the one lane whose live blocker is a missing address. `.*` denotes the members of a
// free-form (additionalProperties:true) object, and `[]` an array element.
export const UCP_ACCEPTED_BUT_UNMAPPED = Object.freeze({
  // The fulfillment entries are the shape of a lane that ships ONE cart to ONE destination: the routing
  // members (`type`, `line_item_ids`, `selected_destination_id`, `groups`) all describe choices Pivota does
  // not have to make, because the door refuses more than one method and more than one destination outright.
  // Everything inside `destinations[]` EXCEPT its `id` is read — that is the whole point of this mapping.
  create_checkout_session: Object.freeze([
    "checkout.cart_id", "checkout.attribution.*",
    "checkout.context.address_country", "checkout.context.address_region", "checkout.context.postal_code",
    "checkout.buyer.phone_number", "checkout.line_items[].id",
    "checkout.fulfillment.methods[].type",
    "checkout.fulfillment.methods[].line_item_ids[]",
    "checkout.fulfillment.methods[].selected_destination_id",
    "checkout.fulfillment.methods[].groups[].id",
    "checkout.fulfillment.methods[].groups[].selected_option_id",
    "checkout.fulfillment.methods[].destinations[].id",
  ]),
  update_checkout_session: Object.freeze([
    "checkout.cart_id", "checkout.attribution.*",
    "checkout.context.address_country", "checkout.context.address_region", "checkout.context.postal_code",
    "checkout.buyer.phone_number", "checkout.line_items[].id",
    "checkout.fulfillment.methods[].id",
    "checkout.fulfillment.methods[].type",
    "checkout.fulfillment.methods[].line_item_ids[]",
    "checkout.fulfillment.methods[].selected_destination_id",
    "checkout.fulfillment.methods[].groups[].id",
    "checkout.fulfillment.methods[].groups[].selected_option_id",
    "checkout.fulfillment.methods[].destinations[].id",
  ]),
  get_checkout_session: Object.freeze([]),
  complete_checkout_session: Object.freeze(["checkout.attribution.*"]),
  get_product: Object.freeze([
    "catalog.selected[].*", "catalog.preferences[].*", "catalog.context.*", "catalog.signals.*",
    "catalog.filters.*",
  ]),
  // Leaf-exact, per the live 2026-08-18 shape. READ: pagination.limit, filters.price.min/max,
  // filters.available, context.currency. NOT read, each for a stated reason (SEARCH_CATALOG_DESCRIPTION):
  // cursor (nothing in the native response to continue from), categories (vocabulary mismatch + OR-of-many
  // has no native field), the other context members (nothing on the native search reads them), and signals
  // (caller-identifying — this read is caller-independent by construction and shared through one cache).
  search_catalog: Object.freeze([
    "catalog.pagination.cursor",
    "catalog.filters.categories[]",
    "catalog.context.address_country", "catalog.context.address_region", "catalog.context.postal_code",
    "catalog.context.language", "catalog.context.intent",
    "catalog.signals.dev.ucp.buyer_ip", "catalog.signals.dev.ucp.user_agent",
  ]),
});

// ---- shared readers --------------------------------------------------------------------------------------

function requireArgsObject(args, code) {
  if (!isPlainObject(args)) {
    throw ucpRefusal(code, "ucp_arguments_object_required", "UCP tool arguments must be a JSON object.", {
      required_fields: ["meta"],
    });
  }
  return args;
}

/**
 * `meta` is required on EVERY UCP call — that is the live schema's rule for tools/list and tools/call alike,
 * and it is how the merchant reaches the calling agent's capability profile. Only its PRESENCE is required
 * here; its members are the platform's business, except for the idempotency key below.
 */
function requireMeta(args, code) {
  const meta = own(args, "meta");
  if (!isPlainObject(meta)) {
    throw ucpRefusal(code, "ucp_meta_required", [
      "Every UCP call must carry `meta` at params.arguments.meta — it is where the calling agent's",
      "`ucp-agent.profile` pointer lives (and, on state-changing calls, `idempotency-key`).",
    ].join(" "), { required_fields: ["meta"] });
  }
  return meta;
}

/**
 * The idempotency key for a state-changing call, read from `meta["idempotency-key"]` — UCP's carrier for it.
 *
 * REFUSED WHEN ABSENT, never minted. A server-generated key makes every retry a distinct request, which on
 * this lane means a second quote or a second charge; the whole point of the key is that the CLIENT can repeat
 * itself safely.
 */
function requireIdempotencyKey(meta, code) {
  const key = own(meta, "idempotency-key");
  if (!nonEmpty(key)) {
    throw ucpRefusal(code, "ucp_idempotency_key_required", [
      "This tool changes state, so `meta[\"idempotency-key\"]` is required: it is what makes a retry return the",
      "original result instead of minting a second quote or a second charge. Pivota will not generate one on",
      "your behalf.",
    ].join(" "), { required_fields: ['meta["idempotency-key"]'] });
  }
  return key.trim();
}

/** The top-level `id` — NOT `checkout.id`. update/get/complete_checkout all carry it at the top level. */
function requireTopLevelId(args, code, tool) {
  const id = own(args, "id");
  if (!nonEmpty(id)) {
    throw ucpRefusal(code, "ucp_checkout_id_required", [
      `\`${tool}\` requires the checkout id as a TOP-LEVEL \`id\` argument (a sibling of \`meta\`), not nested`,
      "inside `checkout`.",
    ].join(" "), { required_fields: ["id"] });
  }
  return id.trim();
}

/**
 * Enforce the schema's `additionalProperties:false` in the MAPPER too. Without this the door would accept what
 * it advertises it rejects, which is the same drift in the other direction.
 */
function rejectUnknown(obj, allowed, where, code) {
  for (const key of Object.keys(isPlainObject(obj) ? obj : {})) {
    if (allowed.includes(key)) continue;
    throw ucpRefusal(code, "ucp_unknown_field", [
      `\`${where}.${key}\` is not part of this tool's UCP input schema, which declares`,
      "additionalProperties:false. Send only the documented fields.",
    ].join(" "), { rejected_field: `${where}.${key}`, accepted_fields: [...allowed] });
  }
}

/**
 * The `checkout` object, with `payment` refused BY NAME before the generic unknown-field refusal — a caller
 * that attached a payment instrument to create/update believes it has authorized a charge, and deserves to be
 * told where authorization actually goes rather than a shrug about an unknown field.
 */
function requireCheckoutObject(args, tool) {
  const code = CHECKOUT_REFUSAL_CODE;
  const checkout = own(args, "checkout");
  if (!isPlainObject(checkout)) {
    throw ucpRefusal(code, "ucp_checkout_required", [
      `\`${tool}\` requires a \`checkout\` object carrying \`line_items\`.`,
    ].join(" "), { required_fields: ["checkout", "checkout.line_items"] });
  }
  if (own(checkout, "payment") !== undefined) {
    throw ucpRefusal(code, "ucp_payment_not_accepted", [
      "`checkout.payment` is not accepted here and was not forwarded. Creating or re-pricing a checkout never",
      "authorizes a charge on this door; payment authorization is presented inline on `complete_checkout`,",
      "against the locked total this call returns.",
    ].join(" "), { rejected_field: "checkout.payment", authorization_tool: "complete_checkout" });
  }
  rejectUnknown(checkout, CHECKOUT_FIELDS, "checkout", code);
  return checkout;
}

/**
 * The `checkout.payment` envelope on complete_checkout — the one read on this dialect that gates a charge.
 *
 * It validates HERE, at the door, rather than letting the envelope travel and die inside the kernel, because
 * the two refusals are not equally useful: the verifier's `CONFIRMATION_INVALID{unknown_authorization_method}`
 * names nothing the caller could send, arrives after the executor has taken the completion path, and reads to
 * a platform like a Pivota fault rather than a wire-shape one. Every refusal below names UCP's own spelling of
 * the field the caller must fix.
 *
 * `instruments` is refused BY NAME before the generic unknown-field refusal, for the same reason `payment` is
 * refused by name on create/update: a caller that attached a payment instrument believes it authorized a
 * charge, and a shrug about an unknown field would leave it believing it had paid.
 */
function requirePaymentEnvelope(checkout) {
  const code = CHECKOUT_REFUSAL_CODE;
  const payment = own(checkout, "payment");
  if (!isPlainObject(payment)) {
    throw ucpRefusal(code, "ucp_payment_required", [
      "`checkout.payment` is required — the signed grant authorizing this checkout's locked total, as",
      `\`{ method: "${UCP_PAYMENT_METHOD}", token }\`. It is verified server-side; an unauthorized completion`,
      "is refused.",
    ].join(" "), { required_fields: ["checkout.payment.method", "checkout.payment.token"] });
  }
  if (own(payment, "instruments") !== undefined) {
    throw ucpRefusal(code, "ucp_payment_instruments_not_accepted", [
      "`checkout.payment.instruments` is not accepted here and was NOT charged. A UCP payment-handler",
      "instrument is charged on the handler's own rail by the merchant that issued it; Pivota is the merchant",
      "of record for this checkout and holds no such integration, so an instrument authorizes nothing on this",
      `lane. Authorize instead with \`checkout.payment = { method: "${UCP_PAYMENT_METHOD}", token }\`, where`,
      "`token` is a signed grant from an issuer Pivota has registered, bound to this checkout id.",
    ].join(" "), {
      rejected_field: "checkout.payment.instruments",
      required_fields: ["checkout.payment.method", "checkout.payment.token"],
    });
  }
  rejectUnknown(payment, ["method", "token"], "checkout.payment", code);

  const method = own(payment, "method");
  if (method !== UCP_PAYMENT_METHOD) {
    throw ucpRefusal(code, "ucp_payment_method_required", [
      `\`checkout.payment.method\` must be \`"${UCP_PAYMENT_METHOD}"\` — it selects the server-side verifier`,
      "that checks the grant against this checkout's locked total. A payment envelope carrying no method",
      "cannot be verified and is refused rather than charged.",
    ].join(" "), {
      rejected_field: "checkout.payment.method",
      accepted_values: [UCP_PAYMENT_METHOD],
      required_fields: ["checkout.payment.method"],
    });
  }
  const token = own(payment, "token");
  if (!nonEmpty(token)) {
    throw ucpRefusal(code, "ucp_payment_token_required", [
      "`checkout.payment.token` is required — the signed grant (a compact JWT from an issuer Pivota has",
      "registered) whose claims carry `max_amount`, `currency`, `merchant_id`, this checkout's",
      "`checkout_session_id` and `exp`. An opaque PSP or wallet instrument token is not a grant and cannot",
      "authorize a charge here.",
    ].join(" "), { required_fields: ["checkout.payment.token"] });
  }
  // `.trim()` matches every other reader here (`requireIdempotencyKey`, `requireTopLevelId`). Without it a
  // padded token — a pure wire-shape slip — reaches the gate and comes back as `credential_signature_invalid`,
  // an opaque crypto refusal several layers from the field the caller would have to fix.
  //
  // Rebuilt from the two READ fields rather than passed through. `rejectUnknown` above already bounds the
  // envelope to those two, so this is belt-and-braces rather than the thing that stops an extra field — but it
  // makes the money-path contract structural: the verifier receives an object this function CONSTRUCTED from
  // values it checked, so a future relaxation of the unknown-field guard cannot quietly widen what travels.
  return { method, token: token.trim() };
}

/**
 * UCP `line_items` -> canonical `quote.items`.
 *
 * `item.id` becomes `product_id` (see the header note); `quantity` is passed through UNTOUCHED so that
 * buyerIntake `normalizeCartItems` — the one definition of what a valid cart line is — remains the thing that
 * validates it. Nothing here defaults, coerces or invents a quantity: a default would price a cart the buyer
 * never named.
 */
function mapLineItems(checkout) {
  const code = CHECKOUT_REFUSAL_CODE;
  const lineItems = own(checkout, "line_items");
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw ucpRefusal(code, "ucp_line_items_required", [
      "`checkout.line_items` is required and must name at least one line, even when converting a cart:",
      "`line_items` is what Pivota prices.",
    ].join(" "), { required_fields: ["checkout.line_items"] });
  }
  return lineItems.map((line) => {
    // `id` is the OPTIONAL flat line id the live schema also permits beside `item`; accepted, never read.
    rejectUnknown(line, ["item", "quantity", "id"], "checkout.line_items[]", code);
    const item = own(line, "item");
    if (isPlainObject(item)) rejectUnknown(item, ["id"], "checkout.line_items[].item", code);
    const id = isPlainObject(item) ? own(item, "id") : undefined;
    if (!nonEmpty(id)) {
      // NAMED for UCP. Falling through to normalizeCartItems here would refuse with a message about
      // `product_id`/`sku_id` — fields that do not exist in the UCP line-item shape, so a model following the
      // advice would retry the identical call and be refused identically.
      throw ucpRefusal(code, "ucp_line_item_id_required", [
        "Every line item must carry `item.id` — the Pivota product id, NESTED under `item`. A flat",
        "`variant_id`/`product_id` on the line is not part of the UCP shape and is not read.",
      ].join(" "), { required_item_fields: ["item.id", "quantity"] });
    }
    // `quantity` is copied verbatim (including a malformed one) so the shared cart rule refuses it, with the
    // same message every other door gives for the same mistake.
    return { product_id: id.trim(), quantity: own(line, "quantity") };
  });
}

/**
 * UCP `checkout` -> the canonical `quote` TOOL-ARG shape that commerceToolSurface's `pickQuote` consumes.
 *
 * No `merchant_id`: the UCP checkout shape carries none, so this lands on the unscoped/canonical lane exactly
 * as an ACP-feed-discovered cart does. Nothing is invented to fill it.
 */
function mapQuote(checkout, { update } = {}) {
  const quote = { items: mapLineItems(checkout) };
  // The destination, when one was supplied. It rides on the QUOTE — which is what puts it on the locked
  // snapshot's buyer_context, where kernel.createOrder reads it at completion (see the fulfillment note).
  const shipping_address = mapFulfillment(checkout, { update });
  if (shipping_address) quote.shipping_address = shipping_address;
  const buyer = own(checkout, "buyer");
  if (isPlainObject(buyer)) {
    // No rejectUnknown here: the live schema declares `buyer` with additionalProperties:true, so refusing an
    // unlisted member would be stricter than the spec. Only `email` is READ — `phone_number` and anything
    // else the platform sends are inert, because the canonical quote has nowhere truthful to put them.
    const email = own(buyer, "email");
    // Copied as a CANDIDATE only. buyerIntake `resolveBuyerEmail` reads the attested address first, so this
    // can fill a gap and can never override the verified buyer's own credential.
    if (email !== undefined) quote.customer_email = email;
  }
  // checkout.context / checkout.cart_id / checkout.attribution are read by NOTHING here, on purpose — see
  // UCP_ACCEPTED_BUT_UNMAPPED and the header note.
  return quote;
}

// ---- the per-tool table (schema + mapper, one entry each) -------------------------------------------------

const CREATE_CHECKOUT_DESCRIPTION = [
  "Open a checkout: returns a server-LOCKED quote (line items, tax, shipping, currency, merchant-of-record,",
  "total, expires_at). The total is the only authoritative charge amount; a caller cannot set it.",
  "Send `{ meta, checkout: { line_items } }`. Each line is `{ item: { id }, quantity }`, where `item.id` is the",
  "Pivota product id — the product's default variant is resolved server-side and the call is REFUSED rather",
  "than guessed when that is ambiguous. `meta[\"idempotency-key\"]` is required. A buyer email is required",
  "unless the signed-in buyer's credential attests one, in which case the attested address wins.",
  "`checkout.context` destination hints are accepted but not forwarded into pricing. Supply the shipping",
  "destination as `checkout.fulfillment.methods[0].destinations[0]` — EXACTLY ONE method and ONE destination,",
  "carrying `first_name`/`last_name`, `street_address`, `address_locality`, `postal_code` and",
  "`address_country`; it is optional here and may be supplied later via `update_checkout`, but an order cannot",
  "be placed without it and `complete_checkout` has no field to carry it.",
  "This call NEVER charges: `checkout.payment` is refused, and payment authorization is",
  "presented inline on `complete_checkout`.",
].join(" ");

const UPDATE_CHECKOUT_DESCRIPTION = [
  "Re-price an existing checkout. Send `{ meta, id, checkout: { line_items } }` — the checkout id is a",
  "TOP-LEVEL `id`, not nested inside `checkout`. Send the COMPLETE checkout: an update RE-MINTS the locked",
  "quote rather than merging into it, so anything omitted is dropped — INCLUDING the shipping destination, so",
  "re-send `checkout.fulfillment` if one was already supplied. The same line-item, buyer and fulfillment rules",
  "as create apply. `meta[\"idempotency-key\"]` is required. Never charges.",
].join(" ");

const GET_CHECKOUT_DESCRIPTION = [
  "Read a checkout (the locked quote) you own. Send `{ meta, id }`. Read-only.",
].join(" ");

const COMPLETE_CHECKOUT_DESCRIPTION = [
  "Complete the checkout: verifies the buyer's payment authorization against the session's locked total, then",
  "places the order and charges ONCE. Send `{ meta, id, checkout: { payment } }` — the checkout id is",
  "TOP-LEVEL and the payment envelope is nested under `checkout`.",
  `The envelope MUST be \`{ method: "${UCP_PAYMENT_METHOD}", token }\`, where \`token\` is a SIGNED GRANT: a`,
  "compact JWT from an issuer Pivota has registered, carrying `max_amount`, `currency`, `merchant_id`, this",
  "checkout's `checkout_session_id` and `exp`. It is verified against a pinned key set and bound to the locked",
  "total, the merchant of record, this session and this buyer; the charge is taken from the locked quote,",
  "never from `max_amount`. A UCP payment-handler instrument (`payment.instruments`, carrying an opaque",
  "PSP/wallet `credential.token`) is REFUSED and never charged: Pivota is the merchant of record here and has",
  "no handler integration to charge it on. `meta[\"idempotency-key\"]` is required. Surface any requires_action",
  "(redirect_url/qr/instructions) verbatim; never fabricate a payment URL or status.",
].join(" ");

const GET_PRODUCT_DESCRIPTION = [
  "Get full detail for one product. Send `{ meta, catalog: { id } }` — the product id is NESTED under",
  "`catalog`. Read-only. This tool answers about one identified product; for free text use `search_catalog`,",
  "which returns the ids this tool reads.",
].join(" ");

const SEARCH_CATALOG_DESCRIPTION = [
  "Search Pivota's normalized multi-merchant catalog with free text. Send `{ meta, catalog: { query } }` —",
  "the query is NESTED under `catalog`. Read-only; no money, no state change. Returns Pivota product ids",
  "(`product_id`, e.g. `sig_…`) that `get_product` and `create_checkout` line items accept. The response is",
  "Pivota's native product list (page-numbered; it carries no cursor).",
  "Read: `catalog.pagination.limit` (results per page, 1..50 — larger values are capped at 50);",
  "`catalog.filters.price.min` / `.max` (integers in MINOR units of `catalog.context.currency`, default USD",
  "cents; `min` must not exceed `max`); `catalog.filters.available` (true = in-stock only, the default);",
  "`catalog.context.currency` (ISO 4217).",
  "Accepted and NOT read: `pagination.cursor` (no cursor exists in the native response to continue from),",
  "`filters.categories` (Pivota filters on its own category vocabulary, which a platform's labels would not",
  "match — filter client-side instead), the other `context` members, and `signals`.",
].join(" ");

// The refusal code for a search wire-shape violation. No PivotaErrorCode means "malformed arguments": the
// two discovery-adjacent codes both misdirect a caller here — UNKNOWN_PRODUCT_ID's recovery is "re-run search"
// (this IS the search), and QUOTE_REQUIRED belongs to the checkout lane. OPERATION_NOT_ALLOWED is the one code
// whose meaning is "this call, as made, is not something this tool performs", it carries the right
// retriable:false, and the curated message + `reason` (`ucp_*`) are what the caller actually reads —
// toToolError surfaces `{code, message, retriable, detail}` and never the catalog's recovery string.
const SEARCH_REFUSAL_CODE = "OPERATION_NOT_ALLOWED";

// The native tool's published page-size ceiling (commerceToolSurface NATIVE_INPUT_SCHEMAS.search_catalog
// `page_size.maximum`). UCP's `pagination.limit` declares NO maximum, so a larger value is CAPPED here rather
// than refused: capping a page size is an ordinary server bound and keeps a UCP call inside the native tool's
// contract, whereas refusing would turn a conforming caller away over a number the lane would clamp anyway.
// Exported ONLY so the test suite can pin it to the native schema's `page_size.maximum` (the adapter cannot
// import commerceToolSurface — that module imports this one).
export const SEARCH_PAGE_SIZE_MAX = 50;

/** `catalog.context.currency` — a string when supplied; trimmed, blank => undefined (as for `query`). */
function readSearchCurrency(context, code) {
  if (!isPlainObject(context)) return undefined; // absent, or a non-object the permissive schema tolerates
  const currency = own(context, "currency");
  if (currency === undefined) return undefined;
  if (typeof currency !== "string") {
    throw ucpRefusal(code, "ucp_currency_string_required",
      "`catalog.context.currency` must be an ISO 4217 code string when supplied.", { rejected_field: "catalog.context.currency" });
  }
  // Blank -> ABSENT, the same rule `catalog.query` follows: the schema types it as a string and a blank
  // string is a string, so a door that refused it would be stricter than what it advertises.
  return nonEmpty(currency) ? currency.trim() : undefined;
}

/**
 * `catalog.pagination` -> native `page_size`. `limit` is read (integer >= 1, capped at SEARCH_PAGE_SIZE_MAX);
 * `cursor` is accepted and NOT read — the native lane pages by number and its response carries no cursor, so
 * there is nothing a caller could have obtained to send back. Faking one would advertise a continuation that
 * does not exist.
 */
function mapSearchPagination(pagination, code) {
  if (!isPlainObject(pagination)) return {};
  const limit = own(pagination, "limit");
  if (limit === undefined) return {};
  if (!Number.isInteger(limit) || limit < 1) {
    throw ucpRefusal(code, "ucp_pagination_limit_invalid",
      "`catalog.pagination.limit` must be an integer >= 1 when supplied.", { rejected_field: "catalog.pagination.limit" });
  }
  return { page_size: Math.min(limit, SEARCH_PAGE_SIZE_MAX) };
}

/**
 * `catalog.filters` -> native `price_min` / `price_max` / `in_stock_only`.
 *
 * PRICE IS IN MINOR UNITS ON THE WIRE and MAJOR units on the native lane (`min_price` reaches the search stack
 * as-is, and the catalog's own prices are majors: 6, 24, 38 USD in the live probe). The conversion uses the
 * kernel's money table via isoMinorUnitExponent — ISO 4217, which is what "minor currency units" means to a
 * counterparty — so JPY 1500 stays 1500, BHD 1500 is 1.5 and UGX 5000 stays 5000, rather than the "divide by
 * 100" that is silently wrong for every zero- and three-decimal currency (and the CHARGE exponent that is
 * deliberately wrong for UGX/ISK). With no `context.currency` the exponent is USD's (2), the default market.
 *
 * `categories` is accepted and NOT read (see SEARCH_CATALOG_DESCRIPTION): the native `category` is one of
 * Pivota's own facet strings, and OR-of-many cannot be expressed on it either; forwarding a platform's label
 * would filter to zero and read as "no products", which is worse than a broader page the caller can narrow.
 */
function mapSearchFilters(filters, currency, code) {
  if (!isPlainObject(filters)) return {};
  const out = {};
  const available = own(filters, "available");
  if (available !== undefined) {
    if (typeof available !== "boolean") {
      throw ucpRefusal(code, "ucp_filters_available_boolean_required",
        "`catalog.filters.available` must be a boolean when supplied.", { rejected_field: "catalog.filters.available" });
    }
    out.in_stock_only = available;
  }
  const price = own(filters, "price");
  if (price !== undefined) {
    if (!isPlainObject(price)) {
      throw ucpRefusal(code, "ucp_filters_price_object_required",
        "`catalog.filters.price` must be an object `{ min?, max? }` in minor currency units when supplied.",
        { rejected_field: "catalog.filters.price" });
    }
    // ISO exponent, NOT the kernel's charge exponent: UCP says "minor currency units", which is ISO 4217,
    // and the two differ for UGX/ISK (0 in ISO, 2 for a Stripe charge). See money.js isoMinorUnitExponent.
    const exp = isoMinorUnitExponent(currency);
    const toMajor = (field) => {
      const v = own(price, field);
      if (v === undefined) return undefined;
      if (!Number.isInteger(v) || v < 0) {
        throw ucpRefusal(code, "ucp_filters_price_bound_invalid",
          `\`catalog.filters.price.${field}\` must be a non-negative integer in MINOR currency units when supplied.`,
          { rejected_field: `catalog.filters.price.${field}` });
      }
      return v / 10 ** exp;
    };
    const min = toMajor("min");
    const max = toMajor("max");
    if (min !== undefined && max !== undefined && min > max) {
      // An inverted range can only ever match nothing; answering it with an empty page would read as
      // "no products", which is the wrong lesson for a caller that transposed two numbers.
      throw ucpRefusal(code, "ucp_filters_price_range_inverted",
        "`catalog.filters.price.min` must not exceed `catalog.filters.price.max`.",
        { rejected_field: "catalog.filters.price", required_fields: ["catalog.filters.price.min <= catalog.filters.price.max"] });
    }
    if (min !== undefined) out.price_min = min;
    if (max !== undefined) out.price_max = max;
  }
  return out;
}

/**
 * One entry per canonical operation on the UCP dialect. `inputSchema` is what `tools/list` publishes and
 * `map` is what `tools/call` runs; they are written together so neither can move without the other.
 */
const SPECS = Object.freeze({
  search_catalog: Object.freeze({
    ucpTool: "search_catalog",
    description: SEARCH_CATALOG_DESCRIPTION,
    inputSchema: {
      // LIVE-VERIFIED (cosrx tools/list, 2026-08-13, via the buyer client's `searchCatalog`): required
      // ["meta","catalog"]; `catalog` has NO required member, and carries query/pagination/context/signals/
      // filters. Same nesting rule as get_product — the payload rides under `catalog`, never flat.
      type: "object",
      required: ["meta", "catalog"],
      additionalProperties: false,
      properties: {
        meta: metaSchema({ idempotency: false }),
        catalog: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "Free-text search query. Optional on the wire." },
            // The four live sub-objects, each declared with the members the live schema declares (2026-08-18
            // listing) and PERMISSIVE like the live schema — an unknown member inside them is the platform's
            // business. Which leaves are read is decided in map() and pinned leaf-exact by the test suite.
            pagination: {
              type: "object",
              additionalProperties: true,
              description: "Pagination. `limit` is read (capped at 50); `cursor` is accepted and NOT read — the native response is page-numbered and carries no cursor to continue from.",
              properties: {
                cursor: { type: "string", description: "Accepted and NOT read (no cursor exists in the native response)." },
                limit: { type: "integer", minimum: 1, description: "Results per page. Read; values above 50 are capped at 50." },
              },
            },
            filters: {
              type: "object",
              additionalProperties: true,
              description: "Read: `price` (minor units of context.currency, default USD) and `available`. `categories` is accepted and NOT read.",
              properties: {
                categories: {
                  type: "array", items: { type: "string" },
                  description: "Accepted and NOT read: Pivota filters on its own category vocabulary, which a platform's labels would not match — filter client-side.",
                },
                price: {
                  type: "object",
                  additionalProperties: true,
                  description: "Price range in MINOR currency units (cents for USD, yen for JPY). Read.",
                  properties: {
                    min: { type: "integer", minimum: 0, description: "Minimum price in minor units. Read." },
                    max: { type: "integer", minimum: 0, description: "Maximum price in minor units. Read; must be >= min." },
                  },
                },
                available: { type: "boolean", description: "true = in-stock only (the default when omitted). Read." },
              },
            },
            context: {
              type: "object",
              additionalProperties: true,
              description: "Buyer context. `currency` is read (ISO 4217; also sets the minor unit of filters.price). Other members are accepted and NOT read.",
              properties: {
                address_country: { type: "string", description: "Accepted and NOT read." },
                address_region: { type: "string", description: "Accepted and NOT read." },
                postal_code: { type: "string", description: "Accepted and NOT read." },
                language: { type: "string", description: "Accepted and NOT read." },
                currency: { type: "string", description: "ISO 4217 code. Read." },
                intent: { type: "string", description: "Accepted and NOT read." },
              },
            },
            signals: {
              type: "object",
              additionalProperties: true,
              description: "Accepted and NEVER read: buyer signals are caller-identifying, and this read is caller-independent by construction (shared cache).",
              properties: {
                "dev.ucp.buyer_ip": { type: "string", description: "Accepted and NOT read." },
                "dev.ucp.user_agent": { type: "string", description: "Accepted and NOT read." },
              },
            },
          },
        },
      },
    },
    map(args) {
      const code = SEARCH_REFUSAL_CODE;
      requireArgsObject(args, code);
      // A FLAT `query` is refused BY NAME before the generic unknown-field refusal — it is the exact shape our
      // own buyer client used to send (`catalogSearch`, since fixed), so it is the likeliest wrong shape a
      // caller brings, and "not part of this schema" would leave that caller no closer to `catalog.query`.
      if (own(args, "query") !== undefined) {
        throw ucpRefusal(code, "ucp_query_must_nest_under_catalog", [
          "`search_catalog` takes the query NESTED as `catalog.query`, never as a flat top-level `query`.",
          "Send `{ meta, catalog: { query } }`.",
        ].join(" "), { rejected_field: "query", required_fields: ["catalog.query"] });
      }
      rejectUnknown(args, ["meta", "catalog"], "arguments", code);
      requireMeta(args, code);
      const catalog = own(args, "catalog");
      if (!isPlainObject(catalog)) {
        throw ucpRefusal(code, "ucp_catalog_object_required", [
          "`search_catalog` requires a `catalog` object — the query rides NESTED under it as `catalog.query`,",
          "never as a flat top-level field.",
        ].join(" "), { required_fields: ["catalog"] });
      }
      rejectUnknown(catalog, ["query", "pagination", "context", "signals", "filters"], "catalog", code);
      const query = own(catalog, "query");
      if (query !== undefined && typeof query !== "string") {
        // The live schema types `catalog.query` as a string. Refusing a number here mirrors getProduct's
        // rule for `catalog.id`, and the message says WHICH mistake was made so the caller does not just
        // resend the same non-string.
        throw ucpRefusal(code, "ucp_query_string_required",
          "`catalog.query` must be a string when supplied.", { rejected_field: "catalog.query" });
      }
      // -> the NATIVE search_catalog tool args. No merchant_id exists in the UCP shape, so canonicalExecutor
      // routes this to the UNSCOPED multi-merchant lane (find_products_multi), which is caller-independent
      // and cached — the same lane the native tool takes for a merchant-less search. An absent or blank query
      // is passed through as ABSENT (never as ""), so the native lane sees the same call it would from /mcp.
      const native = nonEmpty(query) ? { query: query.trim() } : {};
      // `context.currency` first: it names the native currency AND the minor unit `filters.price` is
      // expressed in. Forwarded TRIMMED and otherwise verbatim — the native lane normalizes case; an unknown
      // code falls back to exponent 2 in minorUnitExponent, exactly as it does for the kernel's own amounts.
      const currency = readSearchCurrency(own(catalog, "context"), code);
      if (currency !== undefined) native.currency = currency;
      Object.assign(native, mapSearchPagination(own(catalog, "pagination"), code));
      Object.assign(native, mapSearchFilters(own(catalog, "filters"), currency, code));
      return native;
    },
  }),

  get_product: Object.freeze({
    ucpTool: "get_product",
    description: GET_PRODUCT_DESCRIPTION,
    inputSchema: {
      // LIVE-VERIFIED (cosrx tools/list, 2026-08-13): required ["meta","catalog"], with
      // `catalog.required = ["id"]`. The id is NESTED under `catalog` — NOT a flat top-level `id`, and there
      // is no `sku`. The flat `{query,id,sku}` shape this file first published came from the buyer client's
      // `catalogSearch`, which is itself wrong against the live schema (flagged there for its own fix).
      //
      // Why the earlier probe missed it: a per-merchant endpoint HIDES `get_product` from an agent whose
      // profile it has negotiated down to cart+checkout, so that listing showed 9 tools and this file
      // concluded the catalog lane was not exposed at all. Listing WITHOUT an agent profile returns 13,
      // including this one. Absence from one negotiated listing is not evidence of absence.
      type: "object",
      required: ["meta", "catalog"],
      additionalProperties: false,
      properties: {
        meta: metaSchema({ idempotency: false }),
        catalog: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "The Pivota product id to read." },
            // Live members accepted and NOT read: variant narrowing is resolved server-side from the
            // canonical product, so honouring a caller's pre-selection would answer about something the
            // read never confirmed.
            selected: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: "Accepted and NOT read — variant selection is resolved server-side.",
            },
            preferences: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: "Accepted and NOT read.",
            },
            context: { type: "object", additionalProperties: true, description: "Accepted and NOT read." },
            signals: { type: "object", additionalProperties: true, description: "Accepted and NOT read." },
            filters: { type: "object", additionalProperties: true, description: "Accepted and NOT read." },
          },
        },
      },
    },
    map(args) {
      // A read: UNKNOWN_PRODUCT_ID carries the right recovery ("re-run search to obtain a valid product_id")
      // and the right retriable:false, and the curated message below is what the caller actually sees.
      const code = "UNKNOWN_PRODUCT_ID";
      requireArgsObject(args, code);
      rejectUnknown(args, ["meta", "catalog"], "arguments", code);
      requireMeta(args, code);
      const catalog = own(args, "catalog");
      if (isPlainObject(catalog)) {
        rejectUnknown(catalog, ["id", "selected", "preferences", "context", "signals", "filters"], "catalog", code);
      }
      const id = isPlainObject(catalog) ? own(catalog, "id") : undefined;
      if (!nonEmpty(id)) {
        throw ucpRefusal(code, "ucp_product_id_required", [
          "`get_product` requires `catalog.id` — the Pivota product id to read, NESTED under `catalog`.",
          "For free text call `search_catalog` with `{ meta, catalog: { query } }`; it returns the ids this",
          "tool reads.",
        ].join(" "), { required_fields: ["catalog.id"] });
      }
      // -> the NATIVE get_product tool args. No merchant_id exists in the UCP shape, so this reads the
      // unscoped lane, which is the same lane an ACP-feed `sig_*` id resolves through.
      return { product_id: id.trim() };
    },
  }),

  create_checkout_session: Object.freeze({
    ucpTool: "create_checkout",
    description: CREATE_CHECKOUT_DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["meta", "checkout"],
      additionalProperties: false,
      properties: { meta: metaSchema({ idempotency: true }), checkout: checkoutSchema({ update: false }) },
    },
    map(args) {
      const code = CHECKOUT_REFUSAL_CODE;
      requireArgsObject(args, code);
      rejectUnknown(args, ["meta", "checkout"], "arguments", code);
      const meta = requireMeta(args, code);
      const idempotency_key = requireIdempotencyKey(meta, code);
      const checkout = requireCheckoutObject(args, "create_checkout");
      return { idempotency_key, quote: mapQuote(checkout, { update: false }) };
    },
  }),

  update_checkout_session: Object.freeze({
    ucpTool: "update_checkout",
    description: UPDATE_CHECKOUT_DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["meta", "id", "checkout"],
      additionalProperties: false,
      properties: {
        meta: metaSchema({ idempotency: true }),
        id: {
          type: "string",
          description: "The checkout id to re-price. TOP-LEVEL — not a member of `checkout`.",
        },
        checkout: checkoutSchema({ update: true }),
      },
    },
    map(args) {
      const code = CHECKOUT_REFUSAL_CODE;
      requireArgsObject(args, code);
      rejectUnknown(args, ["meta", "id", "checkout"], "arguments", code);
      const meta = requireMeta(args, code);
      const idempotency_key = requireIdempotencyKey(meta, code);
      // Read from the TOP LEVEL only. `checkout.id` is not part of the live update_checkout shape and is not
      // consulted — reading it would let a caller re-price a session it never named at the top level.
      const session_id = requireTopLevelId(args, code, "update_checkout");
      const checkout = requireCheckoutObject(args, "update_checkout");
      return { idempotency_key, session_id, quote: mapQuote(checkout, { update: true }) };
    },
  }),

  get_checkout_session: Object.freeze({
    ucpTool: "get_checkout",
    description: GET_CHECKOUT_DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["meta", "id"],
      additionalProperties: false,
      properties: {
        meta: metaSchema({ idempotency: false }),
        id: { type: "string", description: "The checkout id to read." },
      },
    },
    map(args) {
      const code = CHECKOUT_REFUSAL_CODE;
      requireArgsObject(args, code);
      rejectUnknown(args, ["meta", "id"], "arguments", code);
      requireMeta(args, code);
      return { session_id: requireTopLevelId(args, code, "get_checkout") };
    },
  }),

  complete_checkout_session: Object.freeze({
    ucpTool: "complete_checkout",
    description: COMPLETE_CHECKOUT_DESCRIPTION,
    inputSchema: {
      type: "object",
      // LIVE-VERIFIED (cosrx tools/list, 2026-08-13): required = ["meta","id","checkout"], and the payment
      // envelope is `checkout.payment` — NOT a top-level `payment`. This file's first revision extrapolated a
      // top-level field from update_checkout's top-level `id`, and would have refused EVERY conforming
      // platform on the charge itself. The lesson is the one this module already states about tool names:
      // an unverified shape is a guess, and a guess on the money path is the defect it exists to prevent.
      required: ["meta", "id", "checkout"],
      additionalProperties: false,
      properties: {
        meta: metaSchema({ idempotency: true }),
        id: { type: "string", description: "The checkout id to complete. TOP-LEVEL, a sibling of `meta`." },
        checkout: {
          type: "object",
          required: ["payment"],
          additionalProperties: false,
          properties: {
            payment: PAYMENT_SCHEMA,
            attribution: ATTRIBUTION_SCHEMA,
          },
        },
      },
    },
    map(args) {
      const code = CHECKOUT_REFUSAL_CODE;
      requireArgsObject(args, code);
      rejectUnknown(args, ["meta", "id", "checkout"], "arguments", code);
      const meta = requireMeta(args, code);
      const idempotency_key = requireIdempotencyKey(meta, code);
      const session_id = requireTopLevelId(args, code, "complete_checkout");
      const checkout = own(args, "checkout");
      if (!isPlainObject(checkout)) {
        throw ucpRefusal(code, "ucp_checkout_required",
          "`complete_checkout` requires a `checkout` object carrying `payment`.",
          { required_fields: ["checkout", "checkout.payment"] });
      }
      rejectUnknown(checkout, ["payment", "attribution"], "checkout", code);
      // The envelope travels on as the canonical `payment_authorization`. commerceToolSurface safe-clones it
      // before it travels, so a hostile __proto__ key cannot pollute the verifier. `checkout.attribution` is
      // accepted and not read, exactly as on create/update.
      return { idempotency_key, session_id, payment_authorization: requirePaymentEnvelope(checkout) };
    },
  }),
});

/** canonical op id -> the UCP `tools/list` inputSchema. */
export const UCP_INPUT_SCHEMAS = Object.freeze(
  Object.fromEntries(Object.entries(SPECS).map(([id, spec]) => [id, Object.freeze(spec.inputSchema)])),
);

/** canonical op id -> the UCP-dialect tool description (the NATIVE one names fields UCP does not have). */
export const UCP_TOOL_DESCRIPTIONS = Object.freeze(
  Object.fromEntries(Object.entries(SPECS).map(([id, spec]) => [id, spec.description])),
);

/** The canonical op ids this adapter can translate — exported so the surface can fail loudly on a gap. */
export const UCP_MAPPED_OPERATION_IDS = Object.freeze(Object.keys(SPECS));

/**
 * Translate UCP wire arguments into the Pivota-NATIVE tool arguments for a canonical operation.
 *
 * @param {{id:string, ucpTool?:string}} op  the canonical operation (from canonicalContract)
 * @param {object} ucpArgs                   `params.arguments` exactly as the platform sent them
 * @returns {object}                         native tool args for commerceToolSurface's `toParams`
 * @throws {PivotaCommerceError}             a curated, field-naming refusal on any wire-shape violation
 */
export function ucpToNativeToolArgs(op, ucpArgs) {
  const spec = op && SPECS[op.id];
  if (!spec) {
    // A UCP-dialect operation with no argument mapping would otherwise be published with a native schema and
    // fail at the executor — the exact defect this module closes. Fail loudly at the door instead.
    throw new Error(`ucpArgumentAdapter: no UCP argument mapping for canonical operation "${op?.id}"`);
  }
  return spec.map(ucpArgs);
}
