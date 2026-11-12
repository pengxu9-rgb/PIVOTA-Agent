// THE `/mcp` DOOR REACHES THE SELLER'S OWN CART (AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED, default off).
//
// Before this, only the UCP door (`/ucp/mcp`) could answer a checkout for a seller Pivota is not connected to:
// its storefront escalation (ucpCheckoutEscalation.js) builds a cart on the seller's own UCP endpoint and answers
// with the seller's lines, totals and cart link. A native `create_checkout_session` for such a seller went to the
// kernel, which cannot price it, and was refused (`ucp_storefront_checkout_unavailable`).
//
// With the flag on, the native door takes THE SAME PATH. Nothing here decides anything the UCP door decides:
//   - the same functions run (assertChosenVariantsBelong, tryEscalateUcpCheckout, refuseUnservedStorefrontCheckout),
//     so the purchasability gate, the variant rules, the store `create_cart`, the exact-match checks on the
//     store's answer and the catalog fallback are the UCP door's own code;
//   - this module only (1) decides whether a native call is one for that path, (2) requires the native `market`
//     and hands it to the escalation in the place it reads a market from, and (3) restates the answer in the
//     native shape.
//
// THE ONE PLACE THIS DOOR IS STRICTER THAN THE UCP DOOR: a create for this path must NAME its market. No seller
// cart is built here for an assumed market (see marketRequiredRefusal).
//
// WHAT IT NEVER DOES: no store `create_checkout`, no payment, no credential. A cart only, as the UCP door.
//
// WHO IS ANSWERED. The surface has already required a verified buyer before this runs (`requiresUserRef` is a
// property of the canonical operation, so it holds on every dialect). This module adds no way around it.
//
// WHICH CALLS TAKE THE PATH (anything else returns undefined and the call continues exactly as before):
//   create   `quote.merchant_id` is external-seed supply (a seller Pivota is not connected to: the same id test
//            the native door's own storefront refusal uses), the rows can be read, at least one is a storefront
//            row, and every row's own seller is the seller named. A connected merchant's cart never enters.
//   get / update / complete / cancel / payment link
//            the `session_id` is an escalation id (`esc_…`) this door can decode.

import externalSeedLane from "../../src/services/externalSeedLane.js";
import partnerDoor from "../../src/services/partnerDoorOneProductId.js";
import requestMarket from "../../src/services/requestMarket.js";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import { intakeRefusal } from "../../safety-kernel/src/protocol/buyerIntake.js";
import {
  assertChosenVariantsBelong,
  decodeEscalationId,
  escalationIdReadable,
  escalationTargetOf,
  readCheckoutRows,
  refuseUnservedStorefrontCheckout,
  tryEscalateUcpCheckout,
  ucpEscalationEnabled,
} from "./ucpCheckoutEscalation.js";

export const MCP_STOREFRONT_ESCALATION_FLAG = "AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED";

/** Read per call, as the escalation's own switches are: turning it off stops the path on the next call. */
export function mcpStorefrontEscalationEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[MCP_STOREFRONT_ESCALATION_FLAG]) || "").trim());
}

// The native status of a checkout the buyer completes at the seller. Deliberately not `ready_for_payment`
// (a kernel session's status): nothing here can be paid through Pivota.
export const NATIVE_STOREFRONT_STATUS = "completes_on_seller_storefront";
// The store's amounts are restated exactly as the store gave them: integers in the currency's minor unit.
export const NATIVE_STOREFRONT_AMOUNT_UNIT = "minor";

// The tools whose calls the `/mcp` view marks for this path. Every other tool is passed through untouched.
const STOREFRONT_CART_TOOLS = new Set([
  "create_checkout_session",
  "get_checkout_session",
  "update_checkout_session",
  "complete_checkout_session",
  "cancel_checkout_session",
  "create_payment_link",
]);

const MAX_ITEMS = 50; // the escalation's own bound (MAX_ESCALATION_ITEMS)

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
function own(src, key) {
  if (!isPlainObject(src)) return undefined;
  return Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
}

// ---- the argument ----------------------------------------------------------------------------------------------

const MARKET_PROPERTY = Object.freeze({
  type: "string",
  description:
    "The buyer's country (ISO 3166-1 alpha-2), as on search_catalog, get_product and get_offers. Used only when the " +
    "checkout completes on the seller's own storefront: the seller is checked, and its cart priced, for this market. " +
    "REQUIRED for such a checkout: without it the call is refused (`market_required_for_seller_storefront`) and no cart is built; " +
    "no market is ever assumed. Optional, and ignored, for a checkout Pivota prices itself.",
});

// One derived schema per base schema object, so the schema tools/list publishes and the schema the door enforces
// are the same object.
const CREATE_SCHEMAS = new WeakMap();

/** create_checkout_session's input schema while the path is on: the base schema plus a top-level `market`. */
export function storefrontCartInputSchema(opId, base) {
  if (opId !== "create_checkout_session" || !isPlainObject(base) || !isPlainObject(base.properties)) return base;
  if (!CREATE_SCHEMAS.has(base)) {
    CREATE_SCHEMAS.set(base, Object.freeze({ ...base, properties: Object.freeze({ ...base.properties, market: MARKET_PROPERTY }) }));
  }
  return CREATE_SCHEMAS.get(base);
}

/**
 * Why a native `market` is not usable, or null. A named market must be a two-letter code: a store cart is never
 * built for a value this door cannot read. Unnamed (absent, null, blank) is not a problem HERE, because this runs
 * on every create, before anything is read, and a checkout Pivota prices itself needs no market; a create that
 * turns out to be for the storefront path is refused for it there (marketRequiredRefusal).
 */
export function storefrontMarketProblem(market) {
  if (requestMarket.marketIsUnnamed(market)) return null;
  if (typeof market !== "string" || !/^[A-Za-z]{2}$/.test(market.trim())) {
    return "`market` must be the buyer's country as an ISO 3166-1 alpha-2 code (for example US).";
  }
  return null;
}

/** The market a native create names, trimmed, or null when it names none (absent, null, blank). */
export function namedStorefrontMarket(toolArgs) {
  const market = own(toolArgs, "market");
  return requestMarket.marketIsUnnamed(market) ? null : String(market).trim();
}

// The escalation reads the request market from the UCP wire body (`checkout.context.address_country`). The native
// `market` is handed to it there, and nothing else is: no discount code, no expected seller, no buyer data.
// Always a NAMED market: an empty body is what the escalation reads as "assume US", and this door never sends it.
function escalationArgsFor(market) {
  return { checkout: { context: { address_country: market } } };
}

export const MARKET_REQUIRED_REASON = "market_required_for_seller_storefront";

// NO SELLER CART FOR AN ASSUMED MARKET on this door (owner decision: a market is never defaulted silently). Terminal: the same
// call is refused every time until it names a market. Says only what every answer of this path says (the checkout
// completes on the seller's storefront), never which seller or store.
// KNOWN GAP: the UCP door (`/ucp/mcp`) still builds this cart for an assumed US and labels it `market_assumed`.
function marketRequiredRefusal() {
  return intakeRefusal("QUOTE_REQUIRED", MARKET_REQUIRED_REASON,
    "This checkout completes on the seller's own storefront, and a seller-storefront cart is only built for a named market: no market is assumed. Send `market`, the buyer's country as an ISO 3166-1 alpha-2 code (for example `\"market\": \"US\"`), as a top-level argument of create_checkout_session. Retrying without it will not change this.",
    { required_argument: "market", format: "ISO 3166-1 alpha-2" });
}

// ---- the answer ------------------------------------------------------------------------------------------------

const DISCOUNT_CODES_NOT_SENT = Object.freeze({
  type: "warning",
  code: "discount_code_not_evaluated",
  path: "$.quote.discount_codes",
  content: "The discount codes were not sent to the seller's storefront: this door does not pass codes to a seller's cart. The totals shown have no discount from them; the buyer can enter a code on the storefront.",
  content_type: "plain",
});

/**
 * The escalation's checkout, in the native session's words. Members are copied, never recomputed:
 *   session_id    the escalation id (`esc_…`); get_checkout_session reads the same cart back with it
 *   status        NATIVE_STOREFRONT_STATUS
 *   amount_unit   `minor`: every amount below is an integer in the currency's minor unit, as the store gave it
 *   line_items    the escalation's lines, each also naming its `product_id` (and `variant_id` when one was chosen)
 *   totals, currency, continue_url, expires_at, links, buyer, discounts, messages, market_assumed: as answered
 *   (`market_assumed` only on a re-read of an id the UCP door minted for an assumed market: no create here has one)
 * The UCP envelope member (`ucp`) and the UCP `status` are not carried.
 */
export function toNativeStorefrontCheckout(checkout, { discountCodesNotSent = false } = {}) {
  const sessionId = own(checkout, "id");
  const items = decodeEscalationId(sessionId) || [];
  const lines = Array.isArray(checkout.line_items) ? checkout.line_items : [];
  const named = items.length === lines.length;
  const messages = [
    ...(Array.isArray(checkout.messages) ? checkout.messages : []),
    ...(discountCodesNotSent ? [DISCOUNT_CODES_NOT_SENT] : []),
  ];
  const out = {
    session_id: sessionId,
    status: NATIVE_STOREFRONT_STATUS,
    currency: checkout.currency,
    amount_unit: NATIVE_STOREFRONT_AMOUNT_UNIT,
    line_items: lines.map((line, i) => (named && isPlainObject(line)
      ? { ...line, product_id: items[i].product_id, ...(items[i].variant_id ? { variant_id: items[i].variant_id } : {}) }
      : line)),
    totals: checkout.totals,
    discounts: checkout.discounts,
    buyer: checkout.buyer,
    continue_url: checkout.continue_url,
    links: checkout.links,
    expires_at: checkout.expires_at,
    messages,
    market_assumed: checkout.market_assumed,
  };
  for (const key of Object.keys(out)) if (out[key] === undefined || out[key] === null) delete out[key];
  return out;
}

// ---- refusals --------------------------------------------------------------------------------------------------

// The escalation words its refusals for the UCP wire. The one UCP field name they use is the market's; on this
// door the same fact is the `market` argument. Code, reason and detail are kept exactly.
const UCP_MARKET_FIELD = "checkout.context.address_country";
function inNativeWords(err) {
  if (!(err instanceof PivotaCommerceError) || !isPlainObject(err.detail)) return err;
  const message = err.detail.acp_message;
  if (typeof message !== "string" || !message.includes(UCP_MARKET_FIELD)) return err;
  const next = new PivotaCommerceError(err.code, { ...err.detail, acp_message: message.split(UCP_MARKET_FIELD).join("`market`") });
  if (err.marketAssumed === true) Object.defineProperty(next, "marketAssumed", { value: true, enumerable: false, configurable: true });
  return next;
}

// The UCP door has no cancel and no payment link, so it has no answer to copy for these two on an escalation id.
// Same meaning as its update and complete refusals: this checkout lives on the seller's storefront.
function storefrontOnlyRefusal(opId) {
  if (opId === "cancel_checkout_session") {
    return intakeRefusal("OPERATION_NOT_ALLOWED", "mcp_storefront_cart_cancel_refused",
      "This checkout completes on the seller's own storefront and there is nothing to cancel here: Pivota holds no order, no stock and no charge for it. The seller's cart expires on its own; an unpaid cart costs the buyer nothing.",
      { reason: "escalated_checkout" });
  }
  return intakeRefusal("OPERATION_NOT_ALLOWED", "mcp_storefront_cart_payment_link_refused",
    "This checkout completes on the seller's own storefront and cannot be paid through Pivota: Pivota does not charge for this seller. Send the buyer to continue_url to pay on the storefront.",
    { reason: "escalated_checkout", continue_url_required: true });
}

// ---- entry point -----------------------------------------------------------------------------------------------

/**
 * Called by commerceToolSurface.callTool on the native dialect, for the checkout operations, only when the `/mcp`
 * view marked the call (flag on). AFTER the identity check and the allowlist, BEFORE buyer intake and the kernel.
 * Returns the native answer, or undefined for "not this path: continue exactly as before". Throws the UCP door's
 * own refusals.
 *
 * @param {{ op:{id:string}, toolArgs:object, params:object, ctx:object, attested?:object,
 *           executor:{execute:Function}, merchantDoor?:object, log?:object, onMarketAssumed?:Function, env?:object }} a
 */
export async function tryNativeStorefrontCart({ op, toolArgs, params, ctx, attested = {}, executor, merchantDoor, log, onMarketAssumed, env = process.env, referralMinter, idempotencyStore, idempotencyPartner }) {
  const opId = op && op.id;
  try {
    if (opId === "create_checkout_session") {
      return await createStorefrontCart({ op, toolArgs, params, ctx, attested, executor, merchantDoor, log, env, referralMinter, idempotencyStore, idempotencyPartner });
    }
    const sessionId = str(own(params, "session_id"));
    // An id this buyer may not read (the id binding, ucpCheckoutEscalation.js) is treated as an id that is not one
    // of these at all, before anything below can say otherwise.
    if (!sessionId || !decodeEscalationId(sessionId) || !escalationIdReadable(sessionId, isPlainObject(ctx) ? ctx.user_ref : null, env)) return undefined; // a kernel session: untouched
    if (opId === "cancel_checkout_session" || opId === "create_payment_link") throw storefrontOnlyRefusal(opId);
    // get, update, complete: the UCP door's own answer for an escalation id. A re-read carries no market on the
    // wire on either door; the id carries the one the cart was created for. An id marked as created for an assumed
    // market can only be the UCP door's (no create here mints one); it is read back as that door reads it, label kept.
    const declines = [];
    const escalated = await tryEscalateUcpCheckout({ op, params, ctx, executor, ucpArgs: {}, attested, declines, merchantDoor, log, env });
    if (escalated) {
      if (isPlainObject(escalated.market_assumed) && typeof onMarketAssumed === "function") onMarketAssumed();
      return toNativeStorefrontCheckout(escalated);
    }
    // Not answered (the escalation is off, or the gate declined the re-read): refused by name, as on the UCP
    // door, never sent to the kernel as a session id it has never seen.
    await refuseUnservedStorefrontCheckout({ op, params, ctx, executor, declined: declines.length > 0, declineReasons: declines, env });
    return undefined;
  } catch (err) {
    throw inNativeWords(err);
  }
}

async function createStorefrontCart({ op, toolArgs, params, ctx, attested, executor, merchantDoor, log, env, referralMinter, idempotencyStore, idempotencyPartner }) {
  const quote = isPlainObject(own(params, "quote")) ? own(params, "quote") : {};
  // ONLY A SELLER PIVOTA IS NOT CONNECTED TO. A connected merchant's product read can carry a storefront link too
  // (the backend stamps Pivota's own hop on it), so the row alone does not decide: the seller named must be
  // external-seed supply, the one id test the native door's storefront refusal already uses.
  if (!externalSeedLane.isExternalSeedSupplyMerchantId(quote.merchant_id)) return undefined;
  // A MUTATION NEEDS ITS IDEMPOTENCY KEY, as on the kernel path (canonicalExecutor: `missing_idempotency_key`), which
  // this path never reaches. Before any read, gate or store call. (The allowlist keeps a string key only, so a
  // numeric or blank one is a missing one here exactly as it is there.)
  if (typeof params.idempotency_key !== "string" || params.idempotency_key.trim() === "") {
    throw new PivotaCommerceError("IDEMPOTENCY_CONFLICT", { reason: "missing_idempotency_key", op: op && op.id });
  }
  const items = Array.isArray(quote.items)
    ? quote.items.filter((it) => isPlainObject(it) && str(it.product_id)).map((it) => ({ ...it, product_id: str(it.product_id) }))
    : [];
  // The carts intake refuses on shape alone stay intake's to refuse.
  if (items.length === 0 || items.length > MAX_ITEMS) return undefined;
  if (items.some((it) => !Number.isSafeInteger(it.quantity) || it.quantity < 1)) return undefined;
  // The rows, by the read the escalation itself performs (the per-call memo makes it the same read). A read that
  // fails is not this path's refusal to give: the call continues as it did before this path existed.
  let rows;
  try {
    rows = await readCheckoutRows(items, executor, ctx);
  } catch {
    return undefined;
  }
  if (![...rows.values()].some((row) => escalationTargetOf(row))) return undefined; // no storefront row: kernel path
  // THE SELLER NAMED IS THE ROWS' SELLER. The escalation sends the buyer to the row's seller; a quote that names
  // another seller is not answered with that seller's cart. It continues as before (and is refused as before).
  for (const row of rows.values()) {
    if (!partnerDoor.sellerMatchesProduct(quote.merchant_id, row)) return undefined;
  }
  // THIS IS A STOREFRONT CART, SO ITS MARKET MUST BE NAMED. Decided on the reads above (which this path makes with
  // or without a market), before the variant check, the purchasability gate and any store call. With the
  // escalation's own switch off no store cart can be built, so nothing is required: that call continues as before.
  const escalationOn = ucpEscalationEnabled(env);
  const market = namedStorefrontMarket(toolArgs);
  if (escalationOn && market === null) throw marketRequiredRefusal();
  await assertChosenVariantsBelong({ params, ctx, executor });
  if (!escalationOn) return undefined;
  const declines = [];
  const escalated = await tryEscalateUcpCheckout({
    op, params, ctx, executor, ucpArgs: escalationArgsFor(market), attested, declines, merchantDoor, log, env, referralMinter,
    // A retried create returns the same checkout (storefrontCartIdempotency.js). This door's keys are its own.
    idempotencyStore, idempotencyDoor: "mcp", idempotencyPartner,
  });
  if (escalated) {
    const codes = own(quote, "discount_codes");
    return toNativeStorefrontCheckout(escalated, { discountCodesNotSent: Array.isArray(codes) && codes.length > 0 });
  }
  // The gate declined this seller for this market: refused by name (`merchant_not_purchasable`), as on the UCP
  // door. With no decline the call continues as before.
  if (declines.length > 0) {
    await refuseUnservedStorefrontCheckout({ op, params, ctx, executor, declined: true, declineReasons: declines, env });
  }
  return undefined;
}

// ---- the `/mcp` view -------------------------------------------------------------------------------------------

const CREATE_SENTENCES =
  " SELLER-STOREFRONT CHECKOUT: when `quote.merchant_id` and every item belong to one seller whose checkout is its own storefront (a seller Pivota is not connected to), the answer is NOT a locked quote and nothing can be paid through Pivota." +
  ` Its \`status\` is \`${NATIVE_STOREFRONT_STATUS}\`: the buyer completes the purchase at the seller by opening \`continue_url\`; \`session_id\` starts with \`esc_\`.` +
  " Read `messages`: code `checkout.priced_by_seller_storefront` means the seller's own storefront built a cart for these items and `line_items`, `totals` and `continue_url` are that cart's (shipping and tax it does not show are added on the storefront);" +
  " code `checkout.completes_on_seller_storefront` means the seller's cart could not be used, the totals are the catalog's last observed prices and `continue_url` is the product page: verify the price there." +
  ` Amounts in such an answer are integers in the currency's minor unit (\`amount_unit: "${NATIVE_STOREFRONT_AMOUNT_UNIT}"\`).` +
  " `market` (the buyer's country, ISO 3166-1 alpha-2) is REQUIRED for such a checkout: the seller is checked and the cart priced for that market, and without it the call is refused (`QUOTE_REQUIRED`, `detail.reason: market_required_for_seller_storefront`) with no cart built. No market is assumed." +
  " One seller per checkout. `quote.discount_codes` are not sent to a seller's storefront. Such a checkout cannot be updated, completed, paid or cancelled here.";

const SESSION_SENTENCES = Object.freeze({
  get_checkout_session:
    ` For a seller-storefront checkout (a \`session_id\` starting with \`esc_\`, \`status\` \`${NATIVE_STOREFRONT_STATUS}\`), this reads the same seller cart back: its lines, totals and \`continue_url\`, in the shape create_checkout_session answered.`,
  update_checkout_session:
    " A seller-storefront checkout (a `session_id` starting with `esc_`) cannot be updated here: create a new checkout, or change the items on the storefront.",
  complete_checkout_session:
    " A seller-storefront checkout (a `session_id` starting with `esc_`) cannot be completed here: the buyer pays on the storefront via `continue_url`.",
  create_payment_link:
    " A seller-storefront checkout (a `session_id` starting with `esc_`) has no payment link: the buyer pays on the storefront via `continue_url`.",
  cancel_checkout_session:
    " A seller-storefront checkout (a `session_id` starting with `esc_`) has nothing to cancel here: the seller's cart expires on its own.",
});

/** The door's own declaration of the checkout tools while the path is on; every other definition is returned as is. */
export function storefrontCartToolDefinition(tool) {
  if (!isPlainObject(tool) || typeof tool.description !== "string") return tool;
  if (tool.name === "create_checkout_session") {
    return {
      ...tool,
      description: `${tool.description}${CREATE_SENTENCES}`,
      inputSchema: storefrontCartInputSchema("create_checkout_session", tool.inputSchema),
    };
  }
  const sentence = Object.prototype.hasOwnProperty.call(SESSION_SENTENCES, tool.name) ? SESSION_SENTENCES[tool.name] : null;
  return sentence ? { ...tool, description: `${tool.description}${sentence}` } : tool;
}

/**
 * The surface the `/mcp` adapter serves. While the flag is off, every call and every tools/list is the wrapped
 * surface's own, with the arguments it was given. While it is on, a checkout tool's call is marked for the path
 * (`storefrontCartDoor`, an option only this view sets) and the checkout tools' declarations say what it answers.
 * The UCP door, the public door and the invoke route do not go through this view.
 * `enabled` is injectable for tests; the default reads the flag per call.
 */
export function mcpStorefrontCartSurface(surface, { enabled = () => mcpStorefrontEscalationEnabled(process.env) } = {}) {
  const on = typeof enabled === "function" ? enabled : () => enabled === true;
  return {
    get tools() {
      return on() ? surface.tools.map(storefrontCartToolDefinition) : surface.tools;
    },
    isCommerceTool: surface.isCommerceTool,
    callTool(toolName, toolArgs, ...rest) {
      if (!STOREFRONT_CART_TOOLS.has(toolName) || !on()) return surface.callTool(toolName, toolArgs, ...rest);
      const [sessionContext, options] = rest;
      return surface.callTool(toolName, toolArgs, sessionContext, { ...(isPlainObject(options) ? options : {}), storefrontCartDoor: true });
    },
  };
}
