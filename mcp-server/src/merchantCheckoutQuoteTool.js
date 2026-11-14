import { createHmac, randomUUID } from "node:crypto";
import merchantPurchasability from "../../src/services/merchantPurchasabilityClient.js";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import {
  assertIdempotencyKeyAcceptable, assertLineQuantitiesWithinMaximum, assertNoDuplicateLines,
  mapWithConcurrency, MAX_CART_ITEMS, pickCompleteAddress, VARIANT_RESOLUTION_CONCURRENCY, withDeadline,
} from "../../safety-kernel/src/protocol/buyerIntake.js";
import { createMerchantCheckoutQuoteService, merchantCheckoutQuoteAllowedSellers } from "./merchantCheckoutQuote.js";
import {
  ESCALATION_GATE_MAX_MS, escalationTargetOf, marketCurrencyOf, mayOfferPurchaseForDomain, readCheckoutRows,
} from "./ucpCheckoutEscalation.js";
import { canonicalReapMerchantDomain, judgeSellerUrl, sellerDestinationsOfRow } from "./ucpExpectedSeller.js";
import { isAcceptableDiscountCode, sellerVariantChoiceOf } from "./ucpMerchantDoorPricing.js";
import { openCheckoutId, partnerPrincipalOf, sealCheckoutId } from "./storefrontCartIdempotency.js";
import { ucpToNativeToolArgs } from "./ucpArgumentAdapter.js";
import { realVariantsOf } from "./ucpVariantIds.js";

export const MERCHANT_QUOTE_TOOL = "preview_merchant_checkout_quote";
const SHIPPING_ADDRESS_FIELDS = {
  id: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" },
  street_address: { type: "string" }, extended_address: { type: "string" },
  address_locality: { type: "string" }, address_region: { type: "string" },
  postal_code: { type: "string" }, address_country: { type: "string" },
};
const SHIPPING_METHOD_FIELDS = {
  type: { const: "shipping" },
  destinations: {
    type: "array", minItems: 1, maxItems: 1, items: {
      type: "object", additionalProperties: false,
      required: ["street_address", "address_locality", "postal_code", "address_country"],
      properties: SHIPPING_ADDRESS_FIELDS,
    },
  },
};
export const merchantQuoteToolDefinition = {
  name: MERCHANT_QUOTE_TOOL,
  description: "Verify an address-specific quote at the seller's default shipping rate for the exact color and quantity. The provided shipping address is sent to the resolved Shopify seller with your consent. Returns a live quote and buyer requirements without an order or a payment session.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["meta", "checkout", "consent_to_share_shipping_address"],
    properties: {
      consent_to_share_shipping_address: { const: true },
      meta: { type: "object", required: ["idempotency-key"], properties: { "idempotency-key": { type: "string" } } },
      checkout: {
        type: "object", additionalProperties: false, required: ["line_items", "context", "fulfillment"],
        properties: {
          line_items: { type: "array", items: { type: "object", required: ["item", "quantity"],
            properties: { item: { type: "object", required: ["id"], properties: { id: { type: "string",
              description: "Use the UCP get_product variant item ID, or combine the native get_product signature and variant ID as <product_id>::v::<variant_id>. A plain product ID requires one proven merchant variant." } } },
              quantity: { type: "integer", minimum: 1 } } } },
          context: { type: "object", required: ["address_country"],
            properties: { address_country: { type: "string", pattern: "^[A-Z]{2}$" } } },
          fulfillment: { type: "object", additionalProperties: false, required: ["methods"], properties: {
            methods: { type: "array", minItems: 1, maxItems: 1, items: {
              type: "object", additionalProperties: false, required: ["type", "destinations"],
              properties: SHIPPING_METHOD_FIELDS,
            } },
          } },
        },
      },
      discount_code: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
};

const RECORD_TTL_MS = 10 * 60 * 1000;
const CLEANUP_LEASE_MS = 75 * 1000;
const QUOTE_FRESHNESS_MS = 60 * 1000;
const PRODUCT_READ_TIMEOUT_MS = 3000;
const SKU_PROOF_TIMEOUT_MS = 3000;
const OP = { id: "create_checkout_session" };
const refusal = (reason, code = "QUOTE_REQUIRED") => new PivotaCommerceError(code, { reason });
const unverified = reason => ({ state: "checkout_unverified", reason, verifiedQuotedTotalMinor: null, payableMinor: null });
const isPlainObject = value => value !== null && typeof value === "object"
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function createMerchantQuoteTool({ executor, stateStore, service = createMerchantCheckoutQuoteService(),
  env = process.env, partnerPrincipal, confirmCatalogVariant,
  shouldOfferPurchase = merchantPurchasability.shouldOfferPurchase, now = Date.now } = {}) {
  return async function preview(args, ctx) {
    if (!isPlainObject(args) || args.consent_to_share_shipping_address !== true
      || Object.keys(args).some(key => !Object.hasOwn(merchantQuoteToolDefinition.inputSchema.properties, key))
      || !isPlainObject(args.checkout)
      || Object.keys(args.checkout).some(key => !Object.hasOwn(merchantQuoteToolDefinition.inputSchema.properties.checkout.properties, key))) {
      throw refusal("merchant_quote_address_consent_required");
    }
    const market = args.checkout.context?.address_country;
    const expectedCurrency = marketCurrencyOf(market);
    const methods = args.checkout.fulfillment?.methods;
    const method = Array.isArray(methods) && methods.length === 1 ? methods[0] : null;
    const suppliedAddress = Array.isArray(method?.destinations) && method.destinations.length === 1
      ? method.destinations[0] : null;
    if (!isPlainObject(method) || method.type !== "shipping"
      || Object.keys(method).some(field => !Object.hasOwn(SHIPPING_METHOD_FIELDS, field))
      || !isPlainObject(suppliedAddress)
      || Object.keys(suppliedAddress).some(field => !Object.hasOwn(SHIPPING_ADDRESS_FIELDS, field))) {
      throw refusal("merchant_quote_default_shipping_required");
    }
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
    if (!Array.isArray(quote.items) || !quote.items.length || quote.items.length > MAX_CART_ITEMS) {
      throw refusal("merchant_quote_exact_variants_required");
    }
    assertLineQuantitiesWithinMaximum(quote.items);
    assertNoDuplicateLines(quote.items);
    const allowedSellers = merchantCheckoutQuoteAllowedSellers(env);
    const canQuoteSeller = seller => mayOfferPurchaseForDomain(seller, market, shouldOfferPurchase,
      merchantPurchasability.isGateEnabled(env), ESCALATION_GATE_MAX_MS, merchantPurchasability.RAIL.human);
    const partner = partnerPrincipalOf(partnerPrincipal?.());
    const key = env.AGENT_MERCHANT_CHECKOUT_QUOTE_IDEMPOTENCY_SECRET;
    if (!partner || !ctx.user_ref || !ctx.acp_session_id || typeof key !== "string" || key.length < 32
      || !stateStore?.durable) throw refusal("merchant_quote_state_unavailable");

    const items = quote.items.map(item => [item.product_id, item.variant_id, item.quantity])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const digest = value => createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
    // OAuth reconnects may change the transport session. The same verified buyer and partner can
    // recover their original request without presenting the previous connection's session header.
    const scope = [partner, ctx.user_ref, rawKey.trim()];
    const recordKey = digest(["key", scope]);
    const sealingScope = {
      door: MERCHANT_QUOTE_TOOL, partner, userRef: ctx.user_ref,
      rawKey: rawKey.trim(), serverKey: createHmac("sha256", key).update("merchant-quote-cleanup/v1").digest(),
    };
    const destination = { ...address };
    delete destination.phone;
    const fingerprint = digest(["input", scope, items, market, destination, args.discount_code ?? null]);
    const claim = randomUUID();
    const outcomePending = () => refusal("merchant_quote_outcome_pending", "CHECKOUT_OUTCOME_UNKNOWN");
    async function releasePreflight() {
      try { await stateStore.compareAndDelete(recordKey, "claim", claim); } catch { /* The preflight lease expires. */ }
      throw refusal("merchant_quote_unavailable", "MERCHANT_UNAVAILABLE");
    }
    async function writeClaim(owner, value, options) {
      try {
        if (await stateStore.compareAndSet(recordKey, "claim", owner, value, options)) return;
      } catch { /* A response may be lost after the state was committed. */ }
      throw outcomePending();
    }
    let claimed;
    try { claimed = await stateStore.putIfAbsent(recordKey, { fingerprint, claim }, { ttlMs: RECORD_TTL_MS }); }
    catch { throw refusal("merchant_quote_unavailable", "MERCHANT_UNAVAILABLE"); }
    if (!claimed) {
      let prior;
      try { prior = await stateStore.get(recordKey); } catch { throw outcomePending(); }
      if (!prior) throw refusal("merchant_quote_unavailable", "MERCHANT_UNAVAILABLE");
      if (prior.fingerprint !== fingerprint) throw refusal("merchant_quote_key_conflict", "IDEMPOTENCY_CONFLICT");
      if (!prior.result) {
        if (!prior.cleanup || now() < prior.resumeAfter) throw outcomePending();
        const { sealedId, ...cleanup } = prior.cleanup;
        const checkoutId = openCheckoutId(sealedId, sealingScope);
        if (!checkoutId || typeof service.recoverCleanup !== "function") throw outcomePending();
        const lease = { ...prior, claim, resumeAfter: now() + CLEANUP_LEASE_MS };
        await writeClaim(prior.claim, lease);
        let cancelled = false;
        try { cancelled = await service.recoverCleanup({ ...cleanup, checkoutId }); } catch { /* Keep the lease. */ }
        if (!cancelled) throw outcomePending();
        const result = { ...unverified("merchant_checkout_quote_recovered"), checkoutCancelled: true };
        await writeClaim(claim, { fingerprint, result, expiresAt: null }, { ttlMs: RECORD_TTL_MS });
        return result;
      }
      if (prior.expiresAt !== null && (!Number.isFinite(prior.expiresAt) || now() >= prior.expiresAt)) {
        throw refusal("merchant_quote_expired", "QUOTE_EXPIRED");
      }
      if (prior.result.verifiedQuotedTotalMinor != null
        && (!Object.hasOwn(allowedSellers, prior.result.sellerHost) || !await canQuoteSeller(prior.result.sellerHost))) {
        return unverified("merchant_quote_seller_unavailable");
      }
      return prior.result;
    }
    let merchantRequest;
    let result;
    try {
      const marketExecutor = {
        execute(op, { payload }, context) {
          return executor.execute(op, { payload: { ...payload, market } }, context);
        },
      };
      const products = await readCheckoutRows(quote.items, marketExecutor, ctx, {
        timeoutMs: PRODUCT_READ_TIMEOUT_MS, preserveProductRefusals: true,
      });
      const rows = [...products].map(([id, row]) => {
        const known = [row?.product_id, row?.product_key, row?.pivota_signature_id].includes(id);
        const target = escalationTargetOf(row);
        const seller = known && target && Object.keys(allowedSellers).find(host =>
          judgeSellerUrl(host, target).ok && sellerDestinationsOfRow(row, target).every(candidate =>
            candidate.kind === "domain" ? canonicalReapMerchantDomain(candidate.value) === host
              : judgeSellerUrl(host, candidate.value).ok));
        if (!seller) throw refusal("merchant_quote_seller_unverified");
        return [id, { row, seller }];
      });
      const byId = new Map(rows);
      const sellerHost = rows[0][1].seller;
      if (rows.some(([, row]) => row.seller !== sellerHost)) throw refusal("merchant_quote_mixed_sellers");
      const skuController = new AbortController();
      const proof = mapWithConcurrency(items, VARIANT_RESOLUTION_CONCURRENCY, async ([id, variant, quantity]) => {
        const { row } = byId.get(id);
        // Count the canonical row's variants before the UCP publication filters by price and currency.
        const chosen = variant ?? (row.variants?.length === 1 ? realVariantsOf(row)[0]?.id : undefined);
        if (!chosen) throw refusal("merchant_quote_exact_variants_required");
        const { gid } = sellerVariantChoiceOf(row, sellerHost, chosen);
        const variantId = /^gid:\/\/shopify\/ProductVariant\/(\d{6,20})$/.exec(gid ?? "")?.[1];
        if (!variantId || typeof confirmCatalogVariant !== "function"
          || !await confirmCatalogVariant({ row, variantId, market, currency: expectedCurrency, requireSingle: !variant })) {
          throw refusal("merchant_quote_native_variant_unverified");
        }
        return { variantId, quantity };
      }, skuController);
      const lineItems = await withDeadline(proof, SKU_PROOF_TIMEOUT_MS, skuController);
      if (!await canQuoteSeller(sellerHost)) throw refusal("merchant_quote_seller_browse_only");
      merchantRequest = { sellerHost, market, expectedCurrency, lineItems, shippingAddress: destination,
        discountCodes: args.discount_code === undefined ? undefined : [args.discount_code] };
    } catch (error) {
      if (!(error instanceof PivotaCommerceError) || error.retriable
        || error.detail?.acp_detail?.variant_resolution === "resolution_unavailable") {
        // No merchant operation ran. Release only our claim so the same request can retry.
        await releasePreflight();
      }
      result = unverified(error.detail.reason || error.code);
    }
    if (merchantRequest) {
      let pending;
      try {
        result = await service.quote(merchantRequest, {
          async beforeCreate(attempt) {
            const startedAt = now();
            pending = { fingerprint, claim, attempt, startedAt, resumeAfter: startedAt + CLEANUP_LEASE_MS };
            // The signed create might be accepted without returning an ID. A pending create has no TTL
            // and cannot trigger a replacement through this key without verified cleanup.
            await writeClaim(claim, pending);
          },
          async checkoutCreated({ checkoutId, ...cleanup }) {
            pending = { ...pending, cleanup: { ...cleanup, sealedId: sealCheckoutId(checkoutId, sealingScope) } };
            await writeClaim(claim, pending);
          },
        });
      } catch (error) {
        if (pending) throw outcomePending();
        if (error instanceof PivotaCommerceError && error.retriable) await releasePreflight();
        result = unverified("merchant_quote_unavailable");
      }
      if (pending && result.checkoutCancelled !== true) throw outcomePending();
    }
    const merchantExpiry = result.merchantExpiresAt == null ? Infinity : Date.parse(result.merchantExpiresAt);
    const expiresAt = result.verifiedQuotedTotalMinor == null ? null
      : Math.min(merchantExpiry, Date.parse(result.quotedAt) + QUOTE_FRESHNESS_MS);
    const recordedExpiry = expiresAt === null || Number.isFinite(expiresAt) ? expiresAt : 0;
    await writeClaim(claim, { fingerprint, result, expiresAt: recordedExpiry }, { ttlMs: RECORD_TTL_MS });
    if (recordedExpiry !== null && now() >= recordedExpiry) {
      throw refusal("merchant_quote_expired", "QUOTE_EXPIRED");
    }
    return result;
  };
}

export function createMerchantQuoteCatalogVerifier(query) {
  return async ({ row, variantId, market, currency, requireSingle = false }) => {
    if (typeof row.product_key !== "string" || typeof row.merchant_id !== "string") return false;
    const result = await query(
      `SELECT DISTINCT s.sku_key, s.source_variant_id IN ($3, $6) AS selected FROM catalog_skus s
        JOIN catalog_offers o ON o.sku_key=s.sku_key AND o.product_key=s.product_key AND o.merchant_id=s.merchant_id
        WHERE s.product_key=$1 AND s.merchant_id=$2 AND ($7 OR s.source_variant_id IN ($3, $6))
          AND s.suppressed_at IS NULL AND o.suppressed_at IS NULL AND o.market=$4 AND o.currency=$5
          AND s.suppression_reason IS NULL AND o.suppression_reason IS NULL
          AND s.source_variant_id ~ '^(gid://shopify/ProductVariant/)?[0-9]{6,20}$'
          AND o.offer_payload->>'variant_id' IN (s.source_variant_id,
            regexp_replace(s.source_variant_id, '^gid://shopify/ProductVariant/', ''),
            'gid://shopify/ProductVariant/' || regexp_replace(s.source_variant_id, '^gid://shopify/ProductVariant/', ''))
        LIMIT 2`,
      [row.product_key, row.merchant_id, variantId, market, currency, `gid://shopify/ProductVariant/${variantId}`, requireSingle],
    );
    return result?.rows?.length === 1 && result.rows[0].selected === true;
  };
}
