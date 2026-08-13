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
//
// A MEASUREMENT TRAP WORTH REMEMBERING — and it cuts BOTH ways, which is the actual lesson.
//
// A merchant NEGOTIATES its tool list against the calling agent's profile. With Pivota's profile the 2026-08-13
// listing was 9 tools (cart+checkout); WITHOUT a profile the same endpoint listed 13, `get_product` among them.
// Reading only the first, this file recorded "a per-merchant endpoint does not expose get_product at all".
// Reading only the second, the correction claimed the opposite — that the tool is exposed and our profile
// merely loses it. BOTH single readings were wrong about something.
//
// What `tools/call` settles, which no listing can:
//   - with our profile   -> get_product / search_catalog / lookup_catalog all answer
//                           `-32602 { data: "Tool not found: <tool>" }`, while get_cart on the same
//                           connection runs. So the catalog lane is genuinely NOT granted to us here.
//   - without a profile  -> every call is refused `422 invalid_profile_url`. So the 13-tool listing is a
//                           phantom: nobody can call those tools without a profile either.
//
// The two questions are separate and only one of them is a listing's business: what SHAPE a tool takes
// (published in tools/list, and what this door mirrors) versus whether the caller is GRANTED it (only a
// tools/call answers that). Probe both ways, and probe with a CALL before concluding either.
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
//  3. THERE IS NO ADDRESS ON THIS LANE. UCP create_checkout carries no shipping_address, so a UCP-created
//     session's buyer_context has none — legal at quote time (both doors permit an address-less create) but
//     pivota-backend requires one UNCONDITIONALLY at order creation. Nothing here fabricates one.
//
//  4. `payment` IS REFUSED, NOT DROPPED. The buyer client hard-bounds itself against ever emitting one on
//     create/update; the server side must not accept one there either. A caller that sends `payment` on
//     create believes it is authorizing a charge, so it is told plainly that authorization arrives inline on
//     complete_checkout — silently discarding it would leave that caller believing it had paid.
//
// IDENTITY IS NEVER READ FROM HERE. `checkout.buyer.email` is mapped to `quote.customer_email`, which is a
// GAP-FILLER by construction: commerceToolSurface's intake runs it through buyerIntake `resolveBuyerEmail`,
// which reads the ATTESTED address from the verified session FIRST and only falls back to a body value when
// the credential carries none. Nothing in this file can override a verified buyer.

import {
  MAX_CART_ITEMS,
  intakeRefusal,
} from "../../safety-kernel/src/protocol/buyerIntake.js";

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

// The payment envelope, LIVE-VERIFIED at `checkout.payment` on complete_checkout (cosrx, 2026-08-13). The
// merchant declares additionalProperties:true around an `instruments` array; this door does NOT re-model
// those instruments, because `payment_authorization` is OPAQUE to the kernel by contract and is verified by
// verifyPaymentAuthorization downstream. Re-modelling it here would create a second, weaker validator for the
// one field whose validation actually gates a charge.
const PAYMENT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    instruments: {
      type: "array",
      description:
        "Payment instruments authorizing this checkout (each carries id, handler_id and type). Verified"
        + " server-side against the session's locked total; never trusted blindly.",
      items: { type: "object", additionalProperties: true },
    },
  },
  description:
    "The payment authorization for this checkout. Opaque at this door and VERIFIED server-side against the"
    + " locked total.",
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
    + " COMPLETE address (name, address_line1, city, postal_code, country), and these three fields cannot"
    + " become one without inventing the rest. Nothing here is fabricated into an address.",
};

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

function checkoutSchema() {
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
      attribution: ATTRIBUTION_SCHEMA,
    },
  };
}

// Fields this adapter deliberately ACCEPTS and does not carry into the canonical params. Exported so the
// anti-drift test can assert that every advertised field is either mapped or listed here — i.e. that no field
// is quietly ignored without a decision having been recorded.
export const UCP_ACCEPTED_BUT_UNMAPPED = Object.freeze({
  create_checkout_session: Object.freeze([
    "checkout.cart_id", "checkout.context", "checkout.attribution",
    "checkout.buyer.phone_number", "checkout.line_items[].id",
  ]),
  update_checkout_session: Object.freeze([
    "checkout.cart_id", "checkout.context", "checkout.attribution",
    "checkout.buyer.phone_number", "checkout.line_items[].id",
  ]),
  get_checkout_session: Object.freeze([]),
  complete_checkout_session: Object.freeze(["checkout.attribution"]),
  get_product: Object.freeze(["catalog.selected", "catalog.preferences", "catalog.context", "catalog.signals", "catalog.filters"]),
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
  rejectUnknown(checkout, ["line_items", "cart_id", "buyer", "context", "attribution"], "checkout", code);
  return checkout;
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
function mapQuote(checkout) {
  const quote = { items: mapLineItems(checkout) };
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
  "`checkout.context` destination hints are accepted but not forwarded into pricing, and no shipping address",
  "is collected here. This call NEVER charges: `checkout.payment` is refused, and payment authorization is",
  "presented inline on `complete_checkout`.",
].join(" ");

const UPDATE_CHECKOUT_DESCRIPTION = [
  "Re-price an existing checkout. Send `{ meta, id, checkout: { line_items } }` — the checkout id is a",
  "TOP-LEVEL `id`, not nested inside `checkout`. Send the COMPLETE checkout: an update RE-MINTS the locked",
  "quote rather than merging into it, so anything omitted is dropped, and the same line-item and buyer rules as",
  "create apply. `meta[\"idempotency-key\"]` is required. Never charges.",
].join(" ");

const GET_CHECKOUT_DESCRIPTION = [
  "Read a checkout (the locked quote) you own. Send `{ meta, id }`. Read-only.",
].join(" ");

const COMPLETE_CHECKOUT_DESCRIPTION = [
  "Complete the checkout: verifies the buyer's payment authorization against the session's locked total, then",
  "places the order and charges ONCE. Send `{ meta, id, checkout: { payment } }` — the checkout id is",
  "TOP-LEVEL and the payment instruments are nested under `checkout`. The payment envelope is verified",
  "server-side and never trusted blindly. `meta[\"idempotency-key\"]` is required. Surface any requires_action",
  "(redirect_url/qr/instructions) verbatim; never fabricate a payment URL or status.",
].join(" ");

const GET_PRODUCT_DESCRIPTION = [
  "Get full detail for one product. Send `{ meta, catalog: { id } }` — the product id is NESTED under",
  "`catalog`. Read-only. Free-text catalog search is NOT exposed on this dialect; this tool answers about one",
  "identified product.",
].join(" ");

/**
 * One entry per canonical operation on the UCP dialect. `inputSchema` is what `tools/list` publishes and
 * `map` is what `tools/call` runs; they are written together so neither can move without the other.
 */
const SPECS = Object.freeze({
  get_product: Object.freeze({
    ucpTool: "get_product",
    description: GET_PRODUCT_DESCRIPTION,
    inputSchema: {
      // LIVE-VERIFIED (cosrx tools/list, 2026-08-13): required ["meta","catalog"], with
      // `catalog.required = ["id"]`. The id is NESTED under `catalog` — NOT a flat top-level `id`, and there
      // is no `sku`. The flat `{query,id,sku}` shape this file first published came from the buyer client's
      // `catalogSearch`, which is itself wrong against the live schema (flagged there for its own fix).
      //
      // Where the schema came from, given the tool is NOT served to us: a merchant negotiates its tool list
      // against the calling agent's profile. With ours the listing is 9 tools (cart+checkout) and a
      // `get_product` call answers `-32602 { data: "Tool not found" }`; listing WITHOUT a profile returns 13,
      // this one included, which is how the schema was captured. That larger listing is NOT a capability we
      // hold — `tools/call` without a profile is refused outright (422 invalid_profile_url), so nobody can
      // call those 13 — but it IS the merchant's own published shape for the tool, which is what this door
      // mirrors. The shape and the grant are separate questions; only the first one is settled here.
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
          "Free-text catalog search is not exposed on this dialect, so a query alone cannot be answered here.",
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
      properties: { meta: metaSchema({ idempotency: true }), checkout: checkoutSchema() },
    },
    map(args) {
      const code = CHECKOUT_REFUSAL_CODE;
      requireArgsObject(args, code);
      rejectUnknown(args, ["meta", "checkout"], "arguments", code);
      const meta = requireMeta(args, code);
      const idempotency_key = requireIdempotencyKey(meta, code);
      const checkout = requireCheckoutObject(args, "create_checkout");
      return { idempotency_key, quote: mapQuote(checkout) };
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
        checkout: checkoutSchema(),
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
      return { idempotency_key, session_id, quote: mapQuote(checkout) };
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
      const payment = own(checkout, "payment");
      if (!isPlainObject(payment)) {
        throw ucpRefusal(code, "ucp_payment_required", [
          "`checkout.payment` is required — the payment instruments authorizing this checkout's locked total.",
          "It is verified server-side; an unauthorized completion is refused.",
        ].join(" "), { required_fields: ["checkout.payment"] });
      }
      // Passed through OPAQUELY as the canonical `payment_authorization` (which is defined as opaque to the
      // kernel and verified by verifyPaymentAuthorization). commerceToolSurface safe-clones it before it
      // travels, so a hostile __proto__ key cannot pollute the verifier. `checkout.attribution` is accepted
      // and not read, exactly as on create/update.
      return { idempotency_key, session_id, payment_authorization: payment };
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
