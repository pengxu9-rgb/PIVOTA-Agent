// PARTNER DOOR, ONE PRODUCT ID: the `/mcp` door (flag PARTNER_DOOR_ONE_PRODUCT_ID, default off).
//
// `partnerDoorSurface(surface)` is what the gateway hands the `/mcp` adapter. Off, it IS the surface. On, it is
// a view of it, and EVERYTHING the flag does happens in this view: the kernel hop, the canonical executor,
// get_pdp_v2 and the shared tool surface are not touched, so `/ucp/mcp`, `/public/mcp` and the invoke route
// answer the same with the flag on as with it off.
//
//   get_product
//     - a group id (`sig_` + 24 hex) is answered as the product get_pdp_v2's own group lookup elects, or refused
//       as a group id when that lookup finds no servable member;
//     - a refusal names one fact: PRODUCT_NOT_SERVABLE (with the gate's reason), UNKNOWN_PRODUCT_ID, or the
//       kernel's own retriable code, instead of NO_MERCHANT_OFFER for all of them;
//     - the answer's `product_id` is the signature the partner asked with (a connected merchant's backend
//       answers its platform id; that id stays, as `source_product_id`);
//     - a `merchant_id` that neither the answered product, its group nor the signature's own catalog rows name
//       is refused, not dropped;
//     - a product with no price says so (`price_unavailable_reason`); `{ product: null }` is a named refusal.
//   get_offers
//     - `product_group_id` is not an input and is refused by name; a group id passed as `product_id` resolves
//       like get_product's; an empty answer says why (`metadata.reason`).
//   search_catalog rows and get_product's product
//     - the group id fields are removed (see dropGroupIdFields: by key, top level only).
//   tools/list
//     - get_product takes the `product_id` from search, `merchant_id` optional; get_offers does not declare
//       `product_group_id`.

import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import partnerDoor from "../../src/services/partnerDoorOneProductId.js";

const {
  partnerDoorOneProductIdEnabled, isIdentityGroupIdShape, isCatalogSignatureShape,
  sellersNamedByProduct, sellerAmong, remapReadFailure, groupIdFailure,
} = partnerDoor;

/** Read once at load, like the surface's other flags (the adapter is built once). */
export const PARTNER_DOOR_ONE_PRODUCT_ID = partnerDoorOneProductIdEnabled(
  (typeof process !== "undefined" && process.env) || {},
);

const SIG_PREFIXED = /^sig_/i;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

// The row fields that hold a group id, and the ones that repeat a signature under another name.
const GROUP_ID_KEYS = ["product_group_id", "sellable_item_group_id", "canonical_sig_id"];
const SIGNATURE_ALIAS_KEYS = ["pivota_signature_id", "signature_id", "canonical_route_sig_id"];
// Never judged, whatever they hold: the row's ids, and the lists whose entries carry their OWN ids.
const KEPT_KEYS = new Set(["product_id", "id", "variant_id", "sku_id", "default_variant_id"]);

/**
 * A copy of `row` without the fields that put a SECOND product-looking id beside `product_id`.
 * BY KEY, AT THE TOP LEVEL ONLY: nothing nested is read or edited, so a variant keeps its `variant_id`, and
 * `group_members[]`, `other_seller_listings[]` and `offers[]` keep every id of their own entries.
 *   - a group-id field or a signature alias is removed when its value is a `sig_` id other than the row's own
 *     `product_id` (equal to it, it is the same id and stays);
 *   - any other top-level field holding a 24-hex group id is removed;
 *   - `id` is never removed.
 */
export function dropGroupIdFields(row) {
  if (!isObj(row)) return row;
  const ownId = nonEmpty(row.product_id) ? row.product_id.trim().toLowerCase() : null;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (!KEPT_KEYS.has(key) && typeof value === "string") {
      const text = value.trim();
      const isOwn = ownId !== null && text.toLowerCase() === ownId;
      const named = GROUP_ID_KEYS.includes(key) || SIGNATURE_ALIAS_KEYS.includes(key);
      if (!isOwn && ((named && SIG_PREFIXED.test(text)) || isIdentityGroupIdShape(text))) continue;
    }
    out[key] = value;
  }
  return out;
}

function shapeSearch(value) {
  if (!isObj(value) || !Array.isArray(value.products)) return value;
  return { ...value, products: value.products.map(dropGroupIdFields) };
}

const refusal = (code, reason, operation) => new PivotaCommerceError(code, { reason, operation });

async function shapeProduct(value, { merchantId, signature, lookups }) {
  if (!isObj(value)) return value;
  if (!isObj(value.product)) {
    if (Object.prototype.hasOwnProperty.call(value, "product")) throw refusal("PRODUCT_NOT_SERVABLE", "product_detail_unavailable", "get_product");
    return value;
  }
  let product = value.product;
  // The seller the caller named, against every seller the answered product names; then, before refusing,
  // against the signature's own catalog rows (get_pdp_v2 can answer a group's canonical member, whose seller
  // is not the seller of the row search served).
  if (nonEmpty(merchantId) && !sellerAmong(merchantId, sellersNamedByProduct(product))) {
    const rowSellers = signature ? await lookups.listSignatureSellerIds({ productId: signature }) : null;
    if (!Array.isArray(rowSellers) || rowSellers.length === 0 || !sellerAmong(merchantId, rowSellers)) {
      throw refusal("MERCHANT_PRODUCT_MISMATCH", "merchant_not_seller_of_product", "get_product");
    }
  }
  // ONE ID IN, THE SAME ID OUT. A connected merchant's backend is asked by its platform id and answers it.
  if (signature && product.product_id !== signature) {
    const answered = nonEmpty(product.product_id) ? product.product_id : undefined;
    product = {
      ...product,
      product_id: signature,
      ...(answered !== undefined && !nonEmpty(product.source_product_id) ? { source_product_id: answered } : {}),
    };
  }
  product = dropGroupIdFields(product);
  // 0 is the catalog's "not priced" value, never a price.
  const unpriced = product.price === null || product.price === undefined || product.price === 0;
  if (unpriced && !nonEmpty(product.price_unavailable_reason)) {
    product = { ...product, price_unavailable_reason: "no_servable_price_in_market" };
  }
  return { ...value, product };
}

// A get_product the kernel refused, re-read on this door (services/partnerDoorOneProductId remapReadFailure).
async function readFailure(error, { merchantId, signature, lookups }) {
  if (!(error instanceof PivotaCommerceError)) return error;
  const mapped = remapReadFailure({ code: error.code, detail: error.detail, merchantId, productId: signature });
  if (!mapped) return error;
  let { code, reason } = mapped;
  // "This merchant has no such product", when the catalog knows the signature under OTHER sellers only, is a
  // wrong seller, not an unknown id.
  if (code === "UNKNOWN_PRODUCT_ID" && nonEmpty(merchantId) && signature) {
    const rowSellers = await lookups.listSignatureSellerIds({ productId: signature });
    if (Array.isArray(rowSellers) && rowSellers.length > 0 && !sellerAmong(merchantId, rowSellers)) {
      code = "MERCHANT_PRODUCT_MISMATCH";
      reason = "merchant_not_seller_of_product";
    }
  }
  const next = new PivotaCommerceError(code, { ...error.detail, reason, kernel_code: error.code });
  // The surface's market label rides on the error object (decision D-10): it is kept.
  if (error.marketAssumed === true) next.marketAssumed = true;
  return next;
}

// A group id where a product id belongs: the signature it stands for, or a thrown refusal.
async function productIdOf(productId, operation, lookups) {
  if (!isIdentityGroupIdShape(productId)) return productId;
  const resolved = await lookups.resolveGroupIdToProductId({ groupId: productId });
  if (resolved.status === "resolved") return resolved.productId;
  const [code, detail] = groupIdFailure(resolved, operation);
  throw new PivotaCommerceError(code, detail);
}

async function getProduct(surface, toolArgs, rest, lookups) {
  const args = isObj(toolArgs) ? toolArgs : {};
  const productId = await productIdOf(args.product_id, "get_product", lookups);
  const call = productId === args.product_id ? toolArgs : { ...args, product_id: productId };
  const context = {
    merchantId: args.merchant_id,
    signature: isCatalogSignatureShape(productId) ? productId.trim() : null,
    lookups,
  };
  let value;
  try {
    value = await surface.callTool("get_product", call, ...rest);
  } catch (error) {
    throw await readFailure(error, context);
  }
  return shapeProduct(value, context);
}

async function getOffers(surface, toolArgs, rest, lookups) {
  const args = isObj(toolArgs) ? toolArgs : {};
  if (Object.prototype.hasOwnProperty.call(args, "product_group_id")) {
    throw refusal("PRODUCT_GROUP_ID_NOT_PRODUCT_ID", "product_group_id_argument", "get_offers");
  }
  const productId = await productIdOf(args.product_id, "get_offers", lookups);
  const call = productId === args.product_id ? toolArgs : { ...args, product_id: productId };
  const answer = await surface.callTool("get_offers", call, ...rest);
  if (!isObj(answer)) return answer;
  const metadata = isObj(answer.metadata) ? { ...answer.metadata } : {};
  if (typeof metadata.product_group_id === "string" && SIG_PREFIXED.test(metadata.product_group_id.trim())) metadata.product_group_id = null;
  const empty = !answer.best_offer && (!Array.isArray(answer.signals) || answer.signals.length === 0);
  if (empty && !nonEmpty(metadata.reason)) metadata.reason = "no_offer_for_product";
  return { ...answer, metadata };
}

const GET_PRODUCT_LEAD = "Get full detail for one product (merchant_id + product_id).";
const GET_PRODUCT_PARTNER_LEAD = "Get full detail for one product. Pass `product_id`: the product_id of a search_catalog row (sig_ followed by 32 hex characters), exactly as returned. `merchant_id` is optional; when you pass it, pass the merchant_id returned with that product, and a seller that is not the product's is refused (MERCHANT_PRODUCT_MISMATCH) rather than ignored. A product group id is not a product id (PRODUCT_GROUP_ID_NOT_PRODUCT_ID). A product answered without a price carries `price_unavailable_reason`.";

/** The door's own declaration of the two read tools; every other tool definition is returned as is. */
export function partnerDoorToolDefinition(tool) {
  if (!isObj(tool) || !isObj(tool.inputSchema) || !isObj(tool.inputSchema.properties)) return tool;
  const properties = tool.inputSchema.properties;
  if (tool.name === "get_product") {
    const description = typeof tool.description === "string" ? tool.description : "";
    return {
      ...tool,
      description: description.startsWith(GET_PRODUCT_LEAD)
        ? `${GET_PRODUCT_PARTNER_LEAD}${description.slice(GET_PRODUCT_LEAD.length)}`
        : `${GET_PRODUCT_PARTNER_LEAD} ${description}`.trim(),
      inputSchema: {
        ...tool.inputSchema,
        required: ["product_id"],
        properties: {
          ...properties,
          merchant_id: { type: "string", description: "Optional. The merchant_id returned with the product. A seller that is not the product's is refused, not ignored." },
          product_id: { type: "string", description: "The product_id of a search_catalog row: sig_ followed by 32 hex characters." },
        },
      },
    };
  }
  if (tool.name === "get_offers" && Object.prototype.hasOwnProperty.call(properties, "product_group_id")) {
    const { product_group_id: _notAnInput, ...declared } = properties;
    return { ...tool, inputSchema: { ...tool.inputSchema, properties: declared } };
  }
  return tool;
}

/**
 * The surface the `/mcp` adapter serves. `enabled` and `lookups` are injectable for tests; the defaults are the
 * load-time flag and the gateway's own lookups (bounded statements, services/partnerDoorOneProductId).
 */
export function partnerDoorSurface(surface, { enabled = PARTNER_DOOR_ONE_PRODUCT_ID, lookups = partnerDoor } = {}) {
  if (!enabled) return surface;
  return {
    get tools() {
      return surface.tools.map(partnerDoorToolDefinition);
    },
    isCommerceTool: surface.isCommerceTool,
    async callTool(toolName, toolArgs, ...rest) {
      if (toolName === "get_product") return getProduct(surface, toolArgs, rest, lookups);
      if (toolName === "get_offers") return getOffers(surface, toolArgs, rest, lookups);
      const value = await surface.callTool(toolName, toolArgs, ...rest);
      return toolName === "search_catalog" ? shapeSearch(value) : value;
    },
  };
}
