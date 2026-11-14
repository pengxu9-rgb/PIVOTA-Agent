import { createHmac, randomUUID } from "node:crypto";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import {
  assertIdempotencyKeyAcceptable, assertLineQuantitiesWithinMaximum, assertNoDuplicateLines,
  MAX_CART_ITEMS, pickCompleteAddress,
} from "../../safety-kernel/src/protocol/buyerIntake.js";
import { createMerchantCheckoutQuoteService, merchantCheckoutQuoteAllowedSellers } from "./merchantCheckoutQuote.js";
import { escalationTargetOf, marketCurrencyOf } from "./ucpCheckoutEscalation.js";
import { canonicalReapMerchantDomain, judgeSellerUrl, sellerDestinationsOfRow } from "./ucpExpectedSeller.js";
import { sellerVariantChoiceOf } from "./ucpMerchantDoorPricing.js";
import { ucpToNativeToolArgs } from "./ucpArgumentAdapter.js";
import { isAcceptableDiscountCode } from "./ucpMerchantDoorPricing.js";

export const MERCHANT_QUOTE_TOOL = "preview_merchant_checkout_quote";
export const merchantQuoteToolDefinition = {
  name: MERCHANT_QUOTE_TOOL,
  description: "Verify an address-specific quote for the exact color and quantity on a supported Shopify seller. The provided shipping address is sent to that seller with your consent. Returns a live quote and buyer requirements without an order or a payment session.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["meta", "checkout", "consent_to_share_shipping_address"],
    properties: {
      consent_to_share_shipping_address: { const: true },
      meta: { type: "object", required: ["idempotency-key"], properties: { "idempotency-key": { type: "string" } } },
      checkout: {
        type: "object", additionalProperties: false, required: ["line_items", "context", "fulfillment"],
        properties: {
          line_items: { type: "array", items: { type: "object", required: ["item", "quantity"],
            properties: { item: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
              quantity: { type: "integer", minimum: 1 } } } },
          context: { type: "object", required: ["address_country"],
            properties: { address_country: { type: "string", pattern: "^[A-Z]{2}$" } } },
          fulfillment: { type: "object" },
        },
      },
      discount_code: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
};

const RECORD_TTL_MS = 10 * 60 * 1000;
const PRODUCT_READ_TIMEOUT_MS = 3000;
const OP = { id: "create_checkout_session" };
const refusal = (reason, code = "QUOTE_REQUIRED") => new PivotaCommerceError(code, { reason });
const isPlainObject = value => value !== null && typeof value === "object"
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function createMerchantQuoteTool({ executor, stateStore, service = createMerchantCheckoutQuoteService(),
  env = process.env, partnerPrincipal, confirmCatalogVariant } = {}) {
  return async function preview(args, ctx) {
    if (!isPlainObject(args) || args.consent_to_share_shipping_address !== true
      || Object.keys(args).some(key => !Object.hasOwn(merchantQuoteToolDefinition.inputSchema.properties, key))
      || !isPlainObject(args.checkout)
      || Object.keys(args.checkout).some(key => !Object.hasOwn(merchantQuoteToolDefinition.inputSchema.properties.checkout.properties, key))) {
      throw refusal("merchant_quote_address_consent_required");
    }
    const market = args.checkout.context?.address_country;
    const expectedCurrency = marketCurrencyOf(market);
    if (args.discount_code !== undefined && !isAcceptableDiscountCode(args.discount_code)) {
      throw refusal("merchant_quote_discount_invalid");
    }
    const rawKey = args.meta?.["idempotency-key"];
    assertIdempotencyKeyAcceptable(rawKey);
    const { quote } = ucpToNativeToolArgs(OP, { meta: args.meta, checkout: args.checkout }, env);
    const address = pickCompleteAddress(quote.shipping_address);
    if (!expectedCurrency || !address || address.country.trim().toUpperCase() !== market) {
      throw refusal("merchant_quote_market_address_required");
    }
    if (!Array.isArray(quote.items) || !quote.items.length || quote.items.length > MAX_CART_ITEMS
      || quote.items.some(item => !item.variant_id)) throw refusal("merchant_quote_exact_variants_required");
    assertLineQuantitiesWithinMaximum(quote.items);
    assertNoDuplicateLines(quote.items);
    const allowedSellers = merchantCheckoutQuoteAllowedSellers(env);
    const partner = partnerPrincipal?.();
    const key = env.AGENT_MERCHANT_CHECKOUT_QUOTE_IDEMPOTENCY_SECRET;
    if (!partner || !ctx.user_ref || !ctx.acp_session_id || typeof key !== "string" || key.length < 32
      || !stateStore?.durable) throw refusal("merchant_quote_state_unavailable");

    const items = quote.items.map(item => [item.product_id, item.variant_id, item.quantity])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const digest = value => createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
    const scope = [partner, ctx.user_ref, ctx.acp_session_id, rawKey];
    const recordKey = digest(["key", scope]);
    const destination = { ...address };
    delete destination.phone;
    const fingerprint = digest(["input", scope, items, market, destination, args.discount_code ?? null]);
    const claim = randomUUID();
    if (!await stateStore.putIfAbsent(recordKey, { fingerprint, claim }, { ttlMs: RECORD_TTL_MS })) {
      const prior = await stateStore.get(recordKey);
      if (prior?.fingerprint !== fingerprint) throw refusal("merchant_quote_key_conflict", "IDEMPOTENCY_CONFLICT");
      if (!prior.result) throw refusal("merchant_quote_outcome_pending", "CHECKOUT_OUTCOME_UNKNOWN");
      return prior.result;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PRODUCT_READ_TIMEOUT_MS);
    let result;
    try {
      const productIds = [...new Set(items.map(([id]) => id))];
      const rows = await Promise.all(productIds.map(async id => {
        const response = await executor.execute("get_product",
          { payload: { product: { product_id: id }, market } }, { ...ctx, signal: controller.signal });
        const row = response?.product ?? response;
        const known = [row?.product_id, row?.product_key, row?.pivota_signature_id].includes(id);
        const target = escalationTargetOf(row);
        const seller = known && target && Object.keys(allowedSellers).find(host =>
          judgeSellerUrl(host, target).ok && sellerDestinationsOfRow(row, target).every(candidate =>
            candidate.kind === "domain" ? canonicalReapMerchantDomain(candidate.value) === host
              : judgeSellerUrl(host, candidate.value).ok));
        if (!seller) throw refusal("merchant_quote_seller_unverified");
        return [id, { row, seller }];
      }));
      const byId = new Map(rows);
      const sellerHost = rows[0][1].seller;
      if (rows.some(([, row]) => row.seller !== sellerHost)) throw refusal("merchant_quote_mixed_sellers");
      const lineItems = await Promise.all(items.map(async ([id, variant, quantity]) => {
        const { row } = byId.get(id);
        const { gid, stored } = sellerVariantChoiceOf(row, sellerHost, variant);
        const variantId = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/.exec(gid ?? "")?.[1];
        const confirmed = variantId && (typeof confirmCatalogVariant === "function"
          ? await confirmCatalogVariant({ row, variantId, market, currency: expectedCurrency })
          : stored);
        if (!confirmed) {
          throw refusal("merchant_quote_native_variant_unverified");
        }
        return { variantId, quantity };
      }));
      result = await service.quote({ sellerHost, market, expectedCurrency, lineItems, shippingAddress: destination,
        discountCodes: args.discount_code === undefined ? undefined : [args.discount_code] });
    } catch (error) {
      result = { state: "checkout_unverified", reason: error instanceof PivotaCommerceError
        ? error.detail.reason : "merchant_quote_unavailable", verifiedQuotedTotalMinor: null, payableMinor: null };
    } finally {
      clearTimeout(timer);
    }
    await stateStore.compareAndSet(recordKey, "claim", claim, { fingerprint, result }, { ttlMs: RECORD_TTL_MS });
    return result;
  };
}

export function createMerchantQuoteCatalogVerifier(query) {
  return async ({ row, variantId, market, currency }) => {
    if (typeof row.product_key !== "string" || typeof row.merchant_id !== "string") return false;
    const result = await query(
      `SELECT DISTINCT s.sku_key FROM catalog_skus s
        JOIN catalog_offers o ON o.sku_key=s.sku_key AND o.product_key=s.product_key AND o.merchant_id=s.merchant_id
        WHERE s.product_key=$1 AND s.merchant_id=$2 AND s.source_variant_id=$3
          AND s.suppressed_at IS NULL AND o.suppressed_at IS NULL AND o.market=$4 AND o.currency=$5
          AND o.offer_payload->>'variant_id'=$3
        LIMIT 2`,
      [row.product_key, row.merchant_id, variantId, market, currency],
    );
    return result?.rows?.length === 1;
  };
}
