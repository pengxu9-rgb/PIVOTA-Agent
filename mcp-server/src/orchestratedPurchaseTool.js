// `start_purchase` — the native MCP door's tool for buying a product through a PAYMENT RAIL (a partner that
// places the order on the merchant's own checkout with the buyer's own card). Pivota never holds or moves the
// buyer's money and never sees card data: it picks the rail, hands the buyer the rail's page to add a card or
// approve, and reports the purchase back.
//
// WHAT IT CALLS. The backend's rail-neutral create, `POST /agent/v2/commerce/purchases`
// (src/services/agentPurchaseCreateClient.js), which routes the purchase to a rail (pivota-backend
// services/payment_orchestration/router.py) and answers with the purchase it opened. The answer is then read
// back once through the rail-neutral read (src/services/agentPurchaseReadClient.js) and returned in EXACTLY the
// shape get_order returns for a purchase (safety-kernel canonicalExecutor `agentPurchaseOrder`), so an agent
// polls the purchase it opened with get_order and reads one vocabulary throughout.
//
// DARK BY DEFAULT. `ORCHESTRATED_PURCHASE_TOOL_ENABLED` (read per call) off: the tool is not listed and a call to
// it is an unknown tool, exactly as before it existed. Native MCP dialect only.
//
// WHAT IS NEVER THE CALLER'S. The merchant's storefront host and the catalog key are derived here from OUR catalog
// row (the same row rules as the Reap lane's cart-link create, `resolveCartLinkPurchaseRow`), which must also list
// the selected variant; that variant goes to the backend as its storefront id, and the backend picks the sku; the
// price is the buyer-shown money the caller binds (`expected_unit_price_minor`/`expected_currency`), checked by the
// backend against our catalog AFTER its idempotency lookup (so a retry replays, and only a new attempt is refused). The buyer is the signed-in buyer: identity
// comes from the verified session, and an attested email wins over a body one.
//
// OUTCOMES. A definite backend refusal is a named, non-retriable error (`purchase_refused` + the backend's code,
// PRICE_CHANGED, IDEMPOTENCY_CONFLICT). ANY other failure of the create is CHECKOUT_OUTCOME_UNKNOWN: the purchase
// may exist, so the agent retries the SAME call (same idempotency_key, which replays the original on its original
// rail) and never starts another. A create the backend accepted but whose read-back failed still answers with the
// purchase id (`read_pending`), never an error.

import { createHash } from "node:crypto";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import { agentPurchaseOrder, AGENT_PURCHASE_RESULT } from "../../safety-kernel/src/protocol/canonicalExecutor.js";
import { intakeRefusal, normalizeEmail } from "../../safety-kernel/src/protocol/buyerIntake.js";
import { readCheckoutRows } from "./ucpCheckoutEscalation.js";
import { resolveCartLinkPurchaseRow } from "./ucpReapAgenticLane.js";

export const ORCHESTRATED_PURCHASE_TOOL_FLAG = "ORCHESTRATED_PURCHASE_TOOL_ENABLED";
export const START_PURCHASE_TOOL = "start_purchase";
export const START_PURCHASE_MAX_QUANTITY = 10;
const CONSENT_MAX_CHARS = 32;
const TRUTHY = new Set(["1", "true", "on", "yes"]);

/** The get_order purchase read's dial (src/server.js `isAgentPurchaseOrderReadEnabled`): the tool needs it. */
export const AGENT_PURCHASE_ORDER_READ_FLAG = "AGENT_PURCHASE_ORDER_READ_ENABLED";

/** On only while BOTH its own dial and the get_order purchase read are on: a purchase this tool opens must be
 * one the agent can poll, or get_order would answer an existing purchase with "not found". */
export function orchestratedPurchaseToolEnabled(env = process.env) {
  const on = (name) => TRUTHY.has(String(env[name] || "").trim().toLowerCase());
  return on(ORCHESTRATED_PURCHASE_TOOL_FLAG) && on(AGENT_PURCHASE_ORDER_READ_FLAG);
}

const PURCHASE_ADDRESS = {
  type: "object",
  required: ["name", "phone", "address_line1", "city", "country"],
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Recipient's full name, given name first (e.g. 'Ada Lovelace')." },
    phone: { type: "string" },
    address_line1: { type: "string" }, address_line2: { type: "string" },
    city: { type: "string" }, state: { type: "string" }, postal_code: { type: "string" },
    country: { type: "string", description: "ISO 3166-1 alpha-2. It is the buyer's market." },
  },
};

export const START_PURCHASE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  required: [
    "idempotency_key", "merchant_id", "product_id", "quantity", "expected_unit_price_minor", "expected_currency",
    "consent_version", "shipping_address",
  ],
  additionalProperties: false,
  properties: {
    idempotency_key: {
      type: "string", minLength: 8,
      description: "Client-generated, one per purchase attempt. A retry with the same key and body returns the SAME purchase; never reuse it for a different purchase.",
    },
    merchant_id: { type: "string" },
    product_id: { type: "string" },
    variant_id: {
      type: "string",
      description: "The storefront variant the buyer chose (as listed in get_product's variants). Required when the product has more than one variant.",
    },
    quantity: { type: "integer", minimum: 1, maximum: START_PURCHASE_MAX_QUANTITY },
    expected_unit_price_minor: {
      type: "integer", minimum: 1,
      description: "The unit price SHOWN to the buyer, in minor units (cents). A purchase is refused if the price has changed since.",
    },
    expected_currency: { type: "string", pattern: "^[A-Z]{3}$" },
    consent_version: {
      type: "string", minLength: 1, maxLength: CONSENT_MAX_CHARS,
      description: "The version tag of the purchase terms the buyer accepted. Required: no purchase is opened without the buyer's consent.",
    },
    customer_email: {
      type: "string",
      description: "Buyer's email. Required unless the signed-in buyer's verified credential carries one (that address is then used).",
    },
    shipping_address: PURCHASE_ADDRESS,
    payment_preference: {
      type: "object", additionalProperties: false,
      properties: { rail: { type: "string", enum: ["reap", "a2a"], description: "Optional. Omitted, Pivota picks the rail." } },
    },
  },
});

export const START_PURCHASE_TOOL_DEFINITION = Object.freeze({
  name: START_PURCHASE_TOOL,
  description:
    "Buy one product for the signed-in buyer through Pivota's payment partners. The partner places the order on the merchant's own checkout with the buyer's own card; Pivota never sees card data. Returns the purchase: when `next_action.action_url` is present, give it to the buyer verbatim (they add a card or approve the purchase there), then poll with get_order using `order_id`. Requires the buyer's consent_version, the price shown to them, and an idempotency_key.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: START_PURCHASE_INPUT_SCHEMA,
});

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** The semantic checks the JSON schema cannot express. Returns problems (field + message); [] when fine. */
export function startPurchaseArgumentProblems(args) {
  const problems = [];
  const need = (field, ok, message) => { if (!ok) problems.push({ field, message }); };
  need("idempotency_key", nonEmpty(args.idempotency_key) && args.idempotency_key.length >= 8, "must be a string of at least 8 characters");
  need("merchant_id", nonEmpty(args.merchant_id), "is required");
  need("product_id", nonEmpty(args.product_id), "is required");
  need("variant_id", args.variant_id === undefined || (typeof args.variant_id === "string" && /^[1-9][0-9]{0,24}$/.test(args.variant_id)), "must be a storefront variant id (a string of digits)");
  need("quantity", Number.isSafeInteger(args.quantity) && args.quantity >= 1 && args.quantity <= START_PURCHASE_MAX_QUANTITY, `must be an integer from 1 to ${START_PURCHASE_MAX_QUANTITY}`);
  need("expected_unit_price_minor", Number.isSafeInteger(args.expected_unit_price_minor) && args.expected_unit_price_minor >= 1, "must be a positive integer (minor units)");
  need("expected_currency", typeof args.expected_currency === "string" && /^[A-Z]{3}$/.test(args.expected_currency), "must be a three-letter currency code");
  need("consent_version", nonEmpty(args.consent_version) && args.consent_version.trim().length <= CONSENT_MAX_CHARS, `is required (at most ${CONSENT_MAX_CHARS} characters)`);
  const address = args.shipping_address;
  need("shipping_address", isPlainObject(address), "is required");
  if (isPlainObject(address)) {
    for (const field of PURCHASE_ADDRESS.required) {
      need(`shipping_address.${field}`, nonEmpty(address[field]), "is required");
    }
    for (const field of ["address_line2", "state", "postal_code"]) {
      need(`shipping_address.${field}`, address[field] === undefined || typeof address[field] === "string", "must be a string");
    }
    // The rail needs a given name AND a family name (it refuses an address without one): ask now, by name.
    need("shipping_address.name", !nonEmpty(address.name) || /\S\s+\S/.test(address.name.trim()), "must be the recipient's full name (given and family name)");
    need("shipping_address.country", !nonEmpty(address.country) || /^[A-Za-z]{2}$/.test(address.country.trim()), "must be two letters");
  }
  const rail = isPlainObject(args.payment_preference) ? args.payment_preference.rail : undefined;
  need("payment_preference.rail", rail === undefined || rail === "reap" || rail === "a2a", "must be reap or a2a");
  return problems;
}

/** The address in the backend's (rail client's) field names. The name splits on its LAST space. */
export function backendShippingAddress(address) {
  const whole = String(address.name || "").trim();
  const cut = whole.lastIndexOf(" ");
  const out = {
    firstName: cut > 0 ? whole.slice(0, cut).trim() : whole,
    phone: String(address.phone).trim(),
    addressLine1: String(address.address_line1).trim(),
    city: String(address.city).trim(),
    country: String(address.country).trim().toUpperCase(),
  };
  if (cut > 0) out.lastName = whole.slice(cut + 1).trim();
  if (nonEmpty(address.address_line2)) out.addressLine2 = address.address_line2.trim();
  if (nonEmpty(address.state)) out.region = address.state.trim();
  if (nonEmpty(address.postal_code)) out.postalCode = address.postal_code.trim();
  return out;
}

/** The backend key for this tool's key: namespaced, so a key reused on another tool or door is another attempt. */
export function purchaseIdempotencyKey(toolKey) {
  const digest = createHash("sha256").update(`pivota-mcp-start-purchase:v1:${toolKey}`).digest("hex");
  return `mcp-purchase-v1-${digest.slice(0, 48)}`;
}

/** Our catalog row cannot be bought this way, decided BEFORE anything is sent. If this call retries one whose
 * outcome was unknown, that earlier purchase may still exist (the row changed in between): the recovery says so. */
function notAvailable(code) {
  return new PivotaCommerceError("OPERATION_NOT_ALLOWED", {
    op: START_PURCHASE_TOOL, reason: "purchase_not_available", refusal_code: code, retry_of_unknown_outcome_may_exist: true,
  });
}

/** A purchase the backend opened (it answered 202) but could not read back yet: its rail id and that it was
 * accepted; its state is not claimed. Poll it with get_order. */
function pendingRead(purchaseId, rail) {
  const out = {
    order_id: purchaseId, purchase_id: purchaseId, rail, status: "accepted", source: "agent_purchase", read_pending: true,
  };
  Object.defineProperty(out, AGENT_PURCHASE_RESULT, { value: true, enumerable: false });
  return out;
}

/**
 * Open one purchase. `executor` is a (memoized) canonical executor view for the catalog read; `createClient` and
 * `readClient` are the backend clients. Throws PivotaCommerceError / an intake refusal; never a raw error.
 */
export async function startOrchestratedPurchase({ args, ctx, attested, executor, createClient, readClient, env = process.env, log }) {
  if (!createClient || typeof createClient.startPurchase !== "function"
    || !readClient || typeof readClient.getPurchase !== "function") {
    throw new PivotaCommerceError("MERCHANT_UNAVAILABLE", { reason: "purchase_unavailable" });
  }
  // The backend needs the agent's API key AND the buyer's token; a door that authenticates otherwise cannot buy.
  if (typeof createClient.hasCallerCredentials === "function" && !createClient.hasCallerCredentials()) {
    throw new PivotaCommerceError("OPERATION_NOT_ALLOWED", { op: START_PURCHASE_TOOL, reason: "agent_api_key_required" });
  }
  const email = (isPlainObject(attested) && nonEmpty(attested.attested_email) ? attested.attested_email : null)
    || normalizeEmail(args.customer_email) || null;
  if (!email) {
    throw intakeRefusal("QUOTE_REQUIRED", "purchase_buyer_email_required",
      "I need the buyer's email address to open this purchase.", { missing_fields: ["customer_email"] });
  }

  const productId = args.product_id.trim();
  let row;
  try {
    const rows = await readCheckoutRows([{ product_id: productId, quantity: args.quantity }], executor, ctx, { merchantId: args.merchant_id.trim() });
    row = rows.get(productId);
  } catch (err) {
    if (err instanceof PivotaCommerceError) throw err;
    throw new PivotaCommerceError("MERCHANT_UNAVAILABLE", { reason: "purchase_row_unavailable" });
  }
  if (!row) throw notAvailable("row_not_found");
  const resolved = resolveCartLinkPurchaseRow(row, { selectedVariantId: args.variant_id, env });
  if (resolved.code) throw notAvailable(resolved.code);
  // NO LOCAL PRICE REFUSAL. The shown price goes to the backend as given, and the backend decides: it looks the
  // idempotency key up FIRST, so a retry of an unknown outcome replays the ORIGINAL purchase even if our price has
  // moved since; only a NEW attempt is refused there (`409 price_changed`, definite, before any write). A refusal
  // here would answer that retry "price changed" without asking, and an agent would re-quote and buy twice.

  const body = {
    item_source: "cart_link",
    merchant_domain: resolved.merchantDomain,
    product_key: resolved.productKey,
    quantity: args.quantity,
    buyer: {
      email,
      consent_version: args.consent_version.trim(),
      shipping_address: backendShippingAddress(args.shipping_address),
    },
    idempotency_key: purchaseIdempotencyKey(args.idempotency_key),
    expected_unit_price_minor: args.expected_unit_price_minor,
    expected_currency: args.expected_currency,
  };
  // THE BUYER'S VARIANT AS THE STOREFRONT NUMBERS IT, never a sku key spelled here: the catalog spells one variant
  // several ways (`::sku_<hash>`, `::v:<n>`, `::v::<n>`, a seller-scoped `::v:retailer-<hash>`), and a key we
  // guessed that is not there is `row_not_found` (prod 2026-10-13: 878 of 6,336 variants on the Tier B domains).
  // The backend resolves it to its own sku. `resolveCartLinkPurchaseRow` above has already checked that the id is
  // one of THIS row's variants and priced it.
  if (args.variant_id !== undefined) body.variant_id = args.variant_id;
  const rail = isPlainObject(args.payment_preference) ? args.payment_preference.rail : undefined;
  if (rail !== undefined) body.payment_preference = { rail };

  let created;
  try {
    created = await createClient.startPurchase(body);
  } catch {
    created = { kind: "unavailable", code: "threw" };
  }
  switch (created && created.kind) {
    case "accepted": {
      let read;
      try {
        read = await readClient.getPurchase(created.purchaseId);
      } catch {
        read = { kind: "unavailable" };
      }
      if (read && read.kind === "accepted") return agentPurchaseOrder(created.purchaseId, read);
      if (log && typeof log.warn === "function") {
        log.warn({ event: "start_purchase", outcome: "read_pending", code: read && read.kind }, "start_purchase read-back pending");
      }
      return pendingRead(created.purchaseId, created.rail);
    }
    case "refused":
      if (created.code === "price_changed") {
        throw new PivotaCommerceError("PRICE_CHANGED", { op: START_PURCHASE_TOOL, reason: "purchase_price_changed" });
      }
      if (created.code === "idempotency_conflict") {
        // NOT the kernel's IDEMPOTENCY_CONFLICT ("Starting fresh" / "use a new idempotency_key"). The backend's
        // fingerprint includes facts this tool fills from OUR catalog row (product_key, the host), so a
        // retry of an unknown outcome conflicts when that row changed in between, and the key's purchase EXISTS. The
        // answer says so: check that purchase before starting another; a new key only for a different purchase.
        throw new PivotaCommerceError("OPERATION_NOT_ALLOWED", {
          op: START_PURCHASE_TOOL, reason: "purchase_idempotency_conflict",
          ...(created.existingPurchaseId ? { purchase_id: created.existingPurchaseId } : {}),
        });
      }
      throw new PivotaCommerceError("OPERATION_NOT_ALLOWED", { op: START_PURCHASE_TOOL, reason: "purchase_refused", refusal_code: created.code });
    case "unauthenticated":
      throw new PivotaCommerceError("OPERATION_NOT_ALLOWED", { op: START_PURCHASE_TOOL, reason: "agent_api_key_required" });
    case "not_available":
      // The backend door is dark (404 `not_available`), or an explicit rail choice cannot be honoured (404
      // `not_available_on_this_rail`). Nothing is opened by this call, and retrying it cannot help, so it is a
      // definite answer, not "retry the same key" (an agent would loop). The dark door answers BEFORE its key
      // lookup, so the recovery keeps the warning that an earlier unknown-outcome purchase may exist.
      throw new PivotaCommerceError("OPERATION_NOT_ALLOWED", {
        op: START_PURCHASE_TOOL, reason: "purchase_unavailable", refusal_code: created.code, retry_of_unknown_outcome_may_exist: true,
      });
    case "rejected":
      // The backend refused the caller's credentials before any write (401): no retry of this call can work.
      throw new PivotaCommerceError("OPERATION_NOT_ALLOWED", { op: START_PURCHASE_TOOL, reason: "caller_credentials_rejected" });
    default:
      throw new PivotaCommerceError("CHECKOUT_OUTCOME_UNKNOWN", { reason: "purchase_outcome_unknown" });
  }
}
