// PARTNER DOOR, ONE PRODUCT ID: the `/mcp` door's own half (flag PARTNER_DOOR_ONE_PRODUCT_ID, default off).
//
// `partnerDoorSurface(surface)` is what the gateway hands the `/mcp` adapter. Off, it IS the surface. On, it
// wraps `callTool` for the native read tools:
//   - search_catalog rows and get_product's product carry ONE id that looks like a product id: `product_id`.
//     Every other field whose value starts with `sig_` is dropped, at any depth (see dropOtherSigFields);
//   - get_product: a `merchant_id` that is not the answered product's seller is refused by name, not dropped;
//     a product answered with no price says so (`price_unavailable_reason`); an answer with no product is a
//     named refusal instead of `{ product: null }`;
//   - get_offers: `product_group_id` is not an input any more, and is refused by name;
//   - tools/list says so: get_product takes the `product_id` from search and `merchant_id` is optional;
//     get_offers no longer declares `product_group_id`.
// The `/ucp/mcp` and `/public/mcp` doors do not pass through here: they project their own shapes and keep
// their own tool lists (the public list is derived from the commerce definitions, which this leaves alone).

import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import partnerDoor from "../../src/services/partnerDoorOneProductId.js";

const { partnerDoorOneProductIdEnabled, sellerMatchesProduct } = partnerDoor;

/** Read once at load, like the surface's other schema-shaping flags (the tool list is built once). */
export const PARTNER_DOOR_ONE_PRODUCT_ID = partnerDoorOneProductIdEnabled(
  (typeof process !== "undefined" && process.env) || {},
);

const SIG_PREFIXED = /^sig_/i;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

/**
 * A copy of `row` in which the only `sig_`-prefixed string is `product_id` (the row's own, wherever it is
 * repeated under that same key). A group id is DROPPED rather than moved under another name: its value would
 * still be a second `sig_` id on the row, and no tool takes it.
 */
export function dropOtherSigFields(row) {
  if (!isObj(row)) return row;
  const ownId = nonEmpty(row.product_id) ? row.product_id.trim() : null;
  const walk = (value, key, depth) => {
    if (typeof value === "string") {
      if (!SIG_PREFIXED.test(value.trim())) return value;
      return key === "product_id" && ownId !== null && value.trim() === ownId ? value : undefined;
    }
    if (depth > 32) return value;
    if (Array.isArray(value)) {
      return value.map((el) => walk(el, null, depth + 1)).filter((el) => el !== undefined);
    }
    if (isObj(value)) {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const kept = walk(v, k, depth + 1);
        if (kept !== undefined) out[k] = kept;
      }
      return out;
    }
    return value;
  };
  return walk(row, null, 0);
}

function shapeSearch(value) {
  if (!isObj(value) || !Array.isArray(value.products)) return value;
  return { ...value, products: value.products.map(dropOtherSigFields) };
}

function shapeProduct(value, args) {
  if (!isObj(value)) return value;
  if (!isObj(value.product)) {
    if (Object.prototype.hasOwnProperty.call(value, "product")) {
      throw new PivotaCommerceError("PRODUCT_NOT_SERVABLE", { reason: "product_detail_unavailable", operation: "get_product" });
    }
    return value;
  }
  // The seller the caller named, against the seller of the product that was answered.
  if (nonEmpty(args.merchant_id) && !sellerMatchesProduct(args.merchant_id, value.product.merchant_id)) {
    throw new PivotaCommerceError("MERCHANT_PRODUCT_MISMATCH", { reason: "merchant_not_seller_of_product", operation: "get_product" });
  }
  const product = dropOtherSigFields(value.product);
  const unpriced = product.price === null || product.price === undefined;
  return {
    ...value,
    product: unpriced && !nonEmpty(product.price_unavailable_reason)
      ? { ...product, price_unavailable_reason: "no_servable_price_in_market" }
      : product,
  };
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

/** The surface the `/mcp` adapter serves. `enabled` is injectable for tests; the default is the load-time flag. */
export function partnerDoorSurface(surface, { enabled = PARTNER_DOOR_ONE_PRODUCT_ID } = {}) {
  if (!enabled) return surface;
  return {
    get tools() {
      return surface.tools.map(partnerDoorToolDefinition);
    },
    isCommerceTool: surface.isCommerceTool,
    async callTool(toolName, toolArgs, ...rest) {
      const args = isObj(toolArgs) ? toolArgs : {};
      if (toolName === "get_offers" && Object.prototype.hasOwnProperty.call(args, "product_group_id")) {
        throw new PivotaCommerceError("PRODUCT_GROUP_ID_NOT_PRODUCT_ID", { reason: "product_group_id_argument", operation: "get_offers" });
      }
      const value = await surface.callTool(toolName, toolArgs, ...rest);
      if (toolName === "search_catalog") return shapeSearch(value);
      if (toolName === "get_product") return shapeProduct(value, args);
      return value;
    },
  };
}
