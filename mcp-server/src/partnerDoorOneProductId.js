// PARTNER DOOR, ONE PRODUCT ID: the `/mcp` door (flag PARTNER_DOOR_ONE_PRODUCT_ID, default off).
//
// `partnerDoorSurface(surface)` is what the gateway hands the `/mcp` adapter. Off, it IS the surface. On, it is
// a view of it, and EVERYTHING the flag does happens in this view: the kernel hop, the canonical executor,
// get_pdp_v2 and the shared tool surface are not touched, so `/ucp/mcp`, `/public/mcp` and the invoke route
// answer the same with the flag on as with it off.
//
//   AN ID THE DOOR ITSELF EMITS KEEPS WORKING. Search can serve a row whose own `product_id` is group-shaped
//   (`sig_` + 24 hex: the canonical-entity public emit, src/server.js resolvePublicProductIdForEmit). So a
//   24-hex id is never rewritten up front and never refused for its shape: the call is made exactly as with the
//   flag off, and only when THAT fails as not-found (get_product) or returns no offer (get_offers) is the id
//   resolved to its signature and tried once more. Flag on is never worse than flag off for such an id.
//
//   get_product
//     - a 24-hex id today's path cannot serve is answered as the product get_pdp_v2's own group lookup elects;
//       it is refused as a group id only when that lookup finds nothing servable either;
//     - a refusal names one fact: PRODUCT_NOT_SERVABLE (with the gate's reason), UNKNOWN_PRODUCT_ID, or the
//       kernel's own retriable code, instead of NO_MERCHANT_OFFER for all of them;
//     - the answer's `product_id` (and `id`) is the signature: the one asked with, or the answer's own when the
//       id asked with was group-shaped. An answered id that is not a signature (a connected merchant's platform
//       id) stays as `source_product_id`; an answered id that IS a signature is never overwritten;
//     - a `merchant_id` that is neither the answered product's seller (or its seed counterpart) nor a seller of
//       the signature's own catalog rows is refused, not dropped: a sibling seller of the same group included;
//     - a product with no price says so (`price_unavailable_reason`); `{ product: null }` is a named refusal.
//   get_offers
//     - `product_group_id` is not an input and is refused by name; an empty answer says why (`metadata.reason`).
//   search_catalog rows and get_product's product
//     - a row whose `product_id` is group-shaped and that carries its 32-hex signature is re-stamped to the
//       signature (`product_id` and `id`); the group id fields are removed (see partnerDoorRow: by key, top
//       level only). A signature field is never removed.
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

// The row fields that hold a group id, and the ones that hold the row's catalog signature under another name.
const GROUP_ID_KEYS = ["product_group_id", "sellable_item_group_id", "canonical_sig_id"];
const SIGNATURE_KEYS = ["pivota_signature_id", "signature_id"];
// Never judged, whatever they hold: the row's own ids.
const KEPT_KEYS = new Set(["product_id", "id", "variant_id", "sku_id", "default_variant_id"]);

// The 32-hex signature a row carries beside its product_id, if any.
function signatureOnRow(row) {
  for (const key of SIGNATURE_KEYS) {
    if (isCatalogSignatureShape(row[key])) return row[key].trim();
  }
  return null;
}

/**
 * `row` under `signature`: `product_id` becomes the signature unless it already IS a catalog signature (an
 * answered signature is another product's id and is never overwritten), and `id` moves with it. A displaced id
 * that is not group-shaped (a platform id) is kept as `source_product_id`.
 */
export function restampProductId(row, signature) {
  if (!isObj(row) || !isCatalogSignatureShape(signature) || isCatalogSignatureShape(row.product_id)) return row;
  const answered = nonEmpty(row.product_id) ? row.product_id : undefined;
  const next = { ...row, product_id: signature };
  if (typeof row.id === "string" && !isCatalogSignatureShape(row.id)) next.id = signature;
  if (answered !== undefined && !isIdentityGroupIdShape(answered) && !nonEmpty(row.source_product_id)) next.source_product_id = answered;
  return next;
}

/**
 * A copy of `row` without the fields that put a SECOND product-looking id beside `product_id`.
 * BY KEY, AT THE TOP LEVEL ONLY: nothing nested is read or edited, so a variant keeps its `variant_id`, and
 * `group_members[]`, `other_seller_listings[]` and `offers[]` keep every id of their own entries.
 *   - a group-id field is removed when its value is a `sig_` id other than the row's own `product_id`;
 *   - any other top-level field holding a 24-hex group id other than the row's own id is removed;
 *   - `id` and the signature fields are never removed.
 */
export function dropGroupIdFields(row) {
  if (!isObj(row)) return row;
  const ownId = nonEmpty(row.product_id) ? row.product_id.trim().toLowerCase() : null;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (!KEPT_KEYS.has(key) && typeof value === "string") {
      const text = value.trim();
      const isOwn = ownId !== null && text.toLowerCase() === ownId;
      if (!isOwn && ((GROUP_ID_KEYS.includes(key) && SIG_PREFIXED.test(text)) || isIdentityGroupIdShape(text))) continue;
    }
    out[key] = value;
  }
  return out;
}

/** A search row as the door serves it: under its signature when it carries one, without the group id fields. */
export function partnerDoorRow(row) {
  if (!isObj(row)) return row;
  const signature = isIdentityGroupIdShape(row.product_id) ? signatureOnRow(row) : null;
  return dropGroupIdFields(signature ? restampProductId(row, signature) : row);
}

function shapeSearch(value) {
  if (!isObj(value) || !Array.isArray(value.products)) return value;
  return { ...value, products: value.products.map(partnerDoorRow) };
}

const refusal = (code, reason, operation) => new PivotaCommerceError(code, { reason, operation });

// `asked` is the id the partner sent; `resolved` the signature a group-shaped id was resolved to, if it was.
async function shapeProduct(value, { merchantId, asked, resolved, lookups }) {
  if (!isObj(value)) return value;
  if (!isObj(value.product)) {
    if (Object.prototype.hasOwnProperty.call(value, "product")) throw refusal("PRODUCT_NOT_SERVABLE", "product_detail_unavailable", "get_product");
    return value;
  }
  let product = value.product;
  // THE PRODUCT'S SIGNATURE: the one asked with; for a group-shaped id, the one it was resolved to, else the
  // answer's own.
  const signature = isCatalogSignatureShape(asked) ? asked.trim()
    : resolved || (isCatalogSignatureShape(product.product_id) ? product.product_id.trim() : signatureOnRow(product));
  // The seller the caller named, against the answered product's own seller (or its seed counterpart); then,
  // before refusing, against the signature's own catalog rows (get_pdp_v2 can answer a group's canonical
  // member, whose seller is not the seller of the row search served). A seller the answer merely LISTS (a
  // group member, another listing, an offer) is another seller's product and is not accepted.
  if (nonEmpty(merchantId) && !sellerAmong(merchantId, sellersNamedByProduct(product))) {
    const rowSellers = signature ? await lookups.listSignatureSellerIds({ productId: signature }) : null;
    if (!Array.isArray(rowSellers) || rowSellers.length === 0 || !sellerAmong(merchantId, rowSellers)) {
      throw refusal("MERCHANT_PRODUCT_MISMATCH", "merchant_not_seller_of_product", "get_product");
    }
  }
  // ONE ID IN, THE SAME ID OUT (a connected merchant's backend is asked by its platform id and answers it).
  product = dropGroupIdFields(signature ? restampProductId(product, signature) : product);
  // 0 is the catalog's "not priced" value, never a price.
  const unpriced = product.price === null || product.price === undefined || product.price === 0;
  if (unpriced && !nonEmpty(product.price_unavailable_reason)) {
    product = { ...product, price_unavailable_reason: "no_servable_price_in_market" };
  }
  return { ...value, product };
}

// The kernel's "nothing at this id" for the single-product read: its two terminal read codes.
function isKernelNotFound(error) {
  return error instanceof PivotaCommerceError && (error.code === "NO_MERCHANT_OFFER" || error.code === "UNKNOWN_PRODUCT_ID")
    && isObj(error.detail) && error.detail.operation === "get_product_detail";
}

// A get_product the kernel refused, re-read on this door (services/partnerDoorOneProductId remapReadFailure).
async function readFailure(error, { merchantId, signature, lookups, log }) {
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
  // The kernel has already counted this refusal under its own code (its audit event and metric fire before the
  // error reaches the door). This line is where the two names meet: codes only, no id and no seller.
  noteRelabel(log, { kernel_code: error.code, code, reason });
  const next = new PivotaCommerceError(code, { ...error.detail, reason, kernel_code: error.code });
  // The surface's market label rides on the error object (decision D-10): it is kept.
  if (error.marketAssumed === true) next.marketAssumed = true;
  return next;
}

function noteRelabel(log, fields) {
  try {
    if (log && typeof log.info === "function") {
      log.info({ event: "partner_door_read_relabel", door: "mcp", ...fields }, "partner door: read refusal relabelled");
    }
  } catch {
    /* a log line never costs the answer */
  }
}

async function getProduct(surface, toolArgs, rest, { lookups, log }) {
  const args = isObj(toolArgs) ? toolArgs : {};
  const asked = args.product_id;
  const merchantId = args.merchant_id;
  const groupShaped = isIdentityGroupIdShape(asked);
  let value;
  try {
    // Exactly the call the partner made, whatever the id's shape.
    value = await surface.callTool("get_product", toolArgs, ...rest);
  } catch (error) {
    if (!groupShaped) throw await readFailure(error, { merchantId, signature: isCatalogSignatureShape(asked) ? asked.trim() : null, lookups, log });
    // A GROUP-SHAPED ID TODAY'S PATH COULD NOT SERVE. Anything but "not found" is today's answer, untouched.
    if (!isKernelNotFound(error)) throw error;
    const group = await lookups.resolveGroupIdToProductId({ groupId: asked });
    // The lookup could not be asked: the answer is exactly the one given with the flag off.
    if (group.status === "unavailable") throw error;
    if (group.status !== "resolved") {
      const [code, detail] = groupIdFailure(group, "get_product");
      throw new PivotaCommerceError(code, detail);
    }
    try {
      value = await surface.callTool("get_product", { ...args, product_id: group.productId }, ...rest);
    } catch (retryError) {
      throw await readFailure(retryError, { merchantId, signature: group.productId, lookups, log });
    }
    return shapeProduct(value, { merchantId, asked, resolved: group.productId, lookups });
  }
  return shapeProduct(value, { merchantId, asked, resolved: null, lookups });
}

const hasOffer = (answer) => isObj(answer) && (Boolean(answer.best_offer) || (Array.isArray(answer.signals) && answer.signals.length > 0));

async function getOffers(surface, toolArgs, rest, { lookups }) {
  const args = isObj(toolArgs) ? toolArgs : {};
  if (Object.prototype.hasOwnProperty.call(args, "product_group_id")) {
    throw refusal("PRODUCT_GROUP_ID_NOT_PRODUCT_ID", "product_group_id_argument", "get_offers");
  }
  // The id the partner sent, first and unchanged: it is the path that answers today. Only when it finds no
  // offer is a group-shaped id tried once more under its signature, and whichever found an offer is returned.
  let answer = await surface.callTool("get_offers", toolArgs, ...rest);
  if (!hasOffer(answer) && isIdentityGroupIdShape(args.product_id)) {
    const group = await lookups.resolveGroupIdToProductId({ groupId: args.product_id });
    if (group.status === "resolved") {
      try {
        const retried = await surface.callTool("get_offers", { ...args, product_id: group.productId }, ...rest);
        if (hasOffer(retried)) answer = retried;
      } catch {
        /* the first answer stands */
      }
    }
  }
  if (!isObj(answer)) return answer;
  const metadata = isObj(answer.metadata) ? { ...answer.metadata } : {};
  if (typeof metadata.product_group_id === "string" && SIG_PREFIXED.test(metadata.product_group_id.trim())) metadata.product_group_id = null;
  if (!hasOffer(answer) && !nonEmpty(metadata.reason)) metadata.reason = "no_offer_for_product";
  return { ...answer, metadata };
}

const GET_PRODUCT_LEAD = "Get full detail for one product (merchant_id + product_id).";
const GET_PRODUCT_PARTNER_LEAD = "Get full detail for one product. Pass `product_id`: the product_id of a search_catalog row (sig_ followed by 32 hex characters), exactly as returned. `merchant_id` is optional; when you pass it, pass the merchant_id returned with that product, and a seller that is not the product's is refused (MERCHANT_PRODUCT_MISMATCH) rather than ignored. A product group id is not a product id (PRODUCT_GROUP_ID_NOT_PRODUCT_ID); group ids may still appear nested inside an answer (for example on its group members) and are not product ids either. A product answered without a price carries `price_unavailable_reason`.";

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
 * load-time flag and the gateway's own lookups (bounded statements, services/partnerDoorOneProductId). `log` is
 * the gateway's logger (one line per relabelled refusal).
 */
export function partnerDoorSurface(surface, { enabled = PARTNER_DOOR_ONE_PRODUCT_ID, lookups = partnerDoor, log = null } = {}) {
  if (!enabled) return surface;
  return {
    get tools() {
      return surface.tools.map(partnerDoorToolDefinition);
    },
    isCommerceTool: surface.isCommerceTool,
    async callTool(toolName, toolArgs, ...rest) {
      if (toolName === "get_product") return getProduct(surface, toolArgs, rest, { lookups, log });
      if (toolName === "get_offers") return getOffers(surface, toolArgs, rest, { lookups });
      const value = await surface.callTool(toolName, toolArgs, ...rest);
      return toolName === "search_catalog" ? shapeSearch(value) : value;
    },
  };
}
