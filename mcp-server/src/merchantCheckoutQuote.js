import { randomUUID } from "node:crypto";
import buyerClientModule from "../../src/services/ucpBuyerAgentClient.js";
import { isAcceptableLineQuantity, MAX_CART_ITEMS, pickCompleteAddress } from "../../safety-kernel/src/protocol/buyerIntake.js";
import { checkoutSwitchOn, marketCurrencyOf } from "./ucpCheckoutEscalation.js";
import { canonicalReapMerchantDomain } from "./ucpExpectedSeller.js";
import { isAcceptableDiscountCode } from "./ucpMerchantDoorPricing.js";

const { createUcpBuyerAgentClient, normalizeDiscounts, unwrapToolPayload, TRUST_TIER } = buyerClientModule;

export const MERCHANT_CHECKOUT_QUOTE_ENABLED = "AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED";
const SELLERS_ENV = "AGENT_MERCHANT_CHECKOUT_QUOTE_SELLERS_JSON";
const LOOKUP_TIMEOUT_MS = 8000;
const SHOPIFY_ENDPOINT = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com\/api\/ucp\/mcp$/;
const VARIANT_ID = /^\d{6,20}$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/(\d{6,20})$/;
const CHECKOUT_GID = /^gid:\/\/shopify\/Checkout\/[^\s#]{1,350}$/;
const CHECKOUT_STATES = new Set(["incomplete", "requires_escalation", "ready_for_complete"]);
const RECOGNIZED_BUYER_REQUIREMENTS = new Set([
  "customer_account_required", "delivery_phone_number_required", "buyer_identity_contact_method_required",
]);
const BREAKDOWN_TYPES = new Set(["subtotal", "fulfillment", "tax", "discount", "items_discount", "fee", "total"]);
const DISCOUNT_TYPES = new Set(["discount", "items_discount"]);
const BLOCKING_SEVERITIES = new Set(["recoverable", "requires_buyer_input", "requires_buyer_review", "unrecoverable"]);
const MESSAGE_TYPES = new Set(["error", "warning", "info"]);
const STOCK_MESSAGE = /stock|inventory|quantity|unavailable|sold[ _-]?out|discontinued|back[ _-]?order|pre[ _-]?order/i;
const ADDRESS_FIELDS = ["street_address", "extended_address", "address_locality", "address_region", "postal_code", "address_country"];

export function merchantCheckoutQuoteEnabled(env = process.env) {
  return checkoutSwitchOn(env, MERCHANT_CHECKOUT_QUOTE_ENABLED);
}

/**
 * Review-controlled map: exact merchant storefront host -> exact Shopify single-tenant checkout endpoint.
 * Malformed config disables the lane. The catalog caller must already have resolved this merchant.
 */
export function merchantCheckoutQuoteAllowedSellers(env = process.env) {
  let parsed;
  try { parsed = JSON.parse(String(env[SELLERS_ENV] || "{}")); } catch { return {}; }
  if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype) return {};
  const sellers = Object.create(null);
  for (const [host, endpoint] of Object.entries(parsed)) {
    const seller = canonicalReapMerchantDomain(host);
    if (!seller || typeof endpoint !== "string" || !SHOPIFY_ENDPOINT.test(endpoint)
      || Object.hasOwn(sellers, seller)) return {};
    sellers[seller] = endpoint;
  }
  return sellers;
}

function refusal(reason, detail = {}) {
  return { state: "checkout_unverified", reason, verifiedQuotedTotalMinor: null, payableMinor: null, ...detail };
}

function unknownOutcome(reason) {
  return { ...refusal(reason), state: "checkout_outcome_unknown" };
}

function wireDestination(shippingAddress, market) {
  let address;
  try { address = pickCompleteAddress(shippingAddress); } catch { return null; }
  if (!address || address.country.trim().toUpperCase() !== market) return null;
  const [firstName, ...rest] = (address.name || address.recipient_name).trim().split(/\s+/);
  return {
    id: "pivota-quote-destination",
    first_name: firstName,
    ...(rest.length ? { last_name: rest.join(" ") } : {}),
    street_address: address.address_line1.trim(),
    ...(address.address_line2?.trim() ? { extended_address: address.address_line2.trim() } : {}),
    address_locality: address.city.trim(),
    ...(address.state?.trim() ? { address_region: address.state.trim() } : {}),
    postal_code: address.postal_code.trim(),
    address_country: market,
  };
}

function quoteLines(items) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_CART_ITEMS) return null;
  const lineItems = new Map();
  for (const line of items) {
    if (!line || typeof line.variantId !== "string" || !VARIANT_ID.test(line.variantId)
      || !isAcceptableLineQuantity(line.quantity) || lineItems.has(line.variantId)) return null;
    lineItems.set(line.variantId, line.quantity);
  }
  return lineItems;
}

function readPayload(result) {
  if (!result || result.status !== 200 || result.response?.error) return null;
  const inner = result.response?.result?.structuredContent ?? unwrapToolPayload(result);
  const data = inner?.checkout ?? inner;
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

function validRpc(result) {
  return result?.status === 200 && !result.error && !result.response?.error && !result.response?.result?.isError;
}

async function readCheckout(client, endpoint, id) {
  try {
    const result = await client.callTool(endpoint, "get_checkout", { id });
    const checkout = validRpc(result) ? readPayload(result) : null;
    return checkout?.id === id ? checkout : null;
  } catch { return null; }
}

function cancellationConfirmed(checkout, id) {
  return checkout?.id === id && checkout.status === "canceled" && !checkout.order;
}

async function cancelTemporaryCheckout(client, endpoint, id, idempotencyKey) {
  try {
    const result = await client.callTool(endpoint, "cancel_checkout", { id }, { idempotencyKey });
    if (validRpc(result) && cancellationConfirmed(readPayload(result), id)) return true;
  } catch { /* Resolve the exact checkout before declaring cleanup pending. */ }
  return cancellationConfirmed(await readCheckout(client, endpoint, id), id);
}

function summarizeTotals(rows) {
  if (!Array.isArray(rows)) return null;
  const totals = {};
  for (const row of rows) {
    if (!row || !BREAKDOWN_TYPES.has(row.type) || !Number.isSafeInteger(row.amount) || Object.hasOwn(totals, row.type)
      || (DISCOUNT_TYPES.has(row.type) ? row.amount > 0 : row.amount < 0)) return null;
    totals[row.type] = row.amount;
  }
  if (!["subtotal", "fulfillment", "tax", "total"].every(type => Object.hasOwn(totals, type))) return null;
  const reconciled = Object.entries(totals).filter(([type]) => type !== "total").reduce((sum, [, value]) => sum + value, 0);
  return Number.isSafeInteger(reconciled) && reconciled === totals.total
    ? Object.fromEntries(Object.entries(totals).sort(([a], [b]) => a.localeCompare(b))) : null;
}

function summarizeLines(lines, requested, subtotal) {
  if (!Array.isArray(lines) || lines.length !== requested.size) return null;
  const seenVariants = new Set();
  const lineIds = new Set();
  const result = [];
  for (const line of lines) {
    const variantId = typeof line?.item?.id === "string" ? VARIANT_GID.exec(line.item.id)?.[1] : null;
    const unitMinor = line?.item?.price;
    if (!variantId || seenVariants.has(variantId) || requested.get(variantId) !== line.quantity
      || typeof line.id !== "string" || !line.id.trim() || lineIds.has(line.id)
      || !Number.isSafeInteger(unitMinor) || unitMinor < 0) return null;
    seenVariants.add(variantId);
    lineIds.add(line.id);
    result.push({ variantId, quantity: line.quantity, unitMinor });
  }
  const computed = result.reduce((sum, line) => sum + line.unitMinor * line.quantity, 0);
  return Number.isSafeInteger(computed) && computed === subtotal
    ? { lines: result.sort((a, b) => a.variantId.localeCompare(b.variantId)), lineIds }
    : null;
}

function sameAddress(actual, requested) {
  return ADDRESS_FIELDS.every(field => {
    const sent = (requested[field] || "").trim().toUpperCase();
    const returned = typeof actual[field] === "string" ? actual[field].trim().toUpperCase() : "";
    return sent === returned;
  });
}

function summarizeDelivery(fulfillment, destination, charge, lineIds) {
  const methods = fulfillment?.methods;
  if (!Array.isArray(methods) || methods.length !== 1) return null;
  const coversAllLines = ids => {
    if (!Array.isArray(ids) || ids.length !== lineIds.size) return false;
    const covered = new Set(ids);
    return covered.size === lineIds.size && [...covered].every(id => lineIds.has(id));
  };
  const method = methods[0];
  if (method?.type !== "shipping" || !Array.isArray(method.destinations) || !Array.isArray(method.groups)
    || method.groups.length !== 1 || !coversAllLines(method.line_item_ids)) return null;
  const addresses = method.selected_destination_id
    ? method.destinations.filter(address => address?.id === method.selected_destination_id) : method.destinations;
  if (addresses.length !== 1 || !addresses[0] || !sameAddress(addresses[0], destination)) return null;
  const [group] = method.groups;
  if (typeof group?.selected_option_id !== "string" || !group.selected_option_id || !Array.isArray(group.options)
    || !coversAllLines(group.line_item_ids)) return null;
  const options = group.options.filter(option => option?.id === group.selected_option_id);
  if (options.length !== 1 || !Array.isArray(options[0].totals)) return null;
  const totals = options[0].totals.filter(total => total?.type === "total");
  if (totals.length !== 1 || totals[0].amount !== charge) return null;
  // Keep the selected option reference only in memory. It is compared across create/get but never returned.
  return { selected: group.selected_option_id, amount: charge };
}

function summarizeDiscounts(payload, totals, requestedCode, lines) {
  const normalized = normalizeDiscounts(payload);
  if (normalized.unreadable.length || normalized.unmapped_rejections.length) return null;
  const allocated = normalized.applied.reduce((sum, entry) => sum + entry.amount_minor, 0);
  if (!Number.isSafeInteger(allocated) || allocated !== Math.abs((totals.discount || 0) + (totals.items_discount || 0))) return null;
  const applied = normalized.applied.map(entry => ({
    automatic: entry.automatic,
    amount: entry.amount_minor,
    allocations: entry.allocations.map(allocation => {
      const index = allocation.target === "line" ? Number(allocation.path?.match(/^\$\.line_items\[(\d+)\]$/)?.[1]) : null;
      const variantId = index !== null ? VARIANT_GID.exec(payload.line_items[index]?.item?.id || "")?.[1] : null;
      return { target: allocation.target, amount: allocation.amount_minor, ...(variantId ? { variantId } : {}) };
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const sumFor = target => applied.flatMap(entry => entry.allocations)
    .filter(allocation => allocation.target === target)
    .reduce((sum, allocation) => sum + allocation.amount, 0);
  if (sumFor("shipping") > totals.fulfillment || sumFor("fee") > (totals.fee || 0)) return null;
  for (const line of lines) {
    const lineAmount = applied.flatMap(entry => entry.allocations).filter(allocation => allocation.variantId === line.variantId)
      .reduce((sum, allocation) => sum + allocation.amount, 0);
    if (lineAmount > line.unitMinor * line.quantity) return null;
  }
  let codeOutcome = "not_requested";
  if (requestedCode) {
    const key = requestedCode.toUpperCase();
    const matches = normalized.applied.filter(entry => entry.code?.toUpperCase() === key).length;
    const rejected = normalized.rejected.filter(result => result.code.toUpperCase() === key).length;
    if (matches === 1 && !rejected) codeOutcome = "applied";
    else if (rejected === 1 && !matches) codeOutcome = "rejected";
    else return null;
  }
  return { applied, codeOutcome };
}

function buyerRequirements(payload, discounts) {
  const raw = payload.messages;
  if (raw !== undefined && !Array.isArray(raw)) return null;
  const needs = new Set();
  for (const message of raw ?? []) {
    if (!message || typeof message.code !== "string" || !MESSAGE_TYPES.has(message.type)) return null;
    if (message.type !== "info" && STOCK_MESSAGE.test(message.code)) return null;
    if (discounts.codeOutcome === "rejected" && /^discount_code_[a-z0-9_]+$/.test(message.code)) continue;
    if (message.type !== "error" && !BLOCKING_SEVERITIES.has(message.severity)) continue;
    if (message.type !== "error" || !["recoverable", "requires_buyer_input"].includes(message.severity)
      || !RECOGNIZED_BUYER_REQUIREMENTS.has(message.code)) return null;
    needs.add(message.code);
  }
  return payload.status === "incomplete" && !needs.size ? null : [...needs].sort();
}

function quoteSnapshot(payload, currency, requested, destination, requestedCode) {
  if (!payload || payload.order || !CHECKOUT_STATES.has(payload.status) || payload.currency !== currency) return null;
  const totals = summarizeTotals(payload.totals);
  if (!totals) return null;
  const cart = summarizeLines(payload.line_items, requested, totals.subtotal);
  if (!cart) return null;
  const { lines, lineIds } = cart;
  const delivery = summarizeDelivery(payload.fulfillment, destination, totals.fulfillment, lineIds);
  if (!delivery) return null;
  const discounts = summarizeDiscounts(payload, totals, requestedCode, lines);
  if (!discounts) return null;
  const requirements = buyerRequirements(payload, discounts);
  if (!requirements) return null;
  const expires = payload.expires_at === undefined ? null : Date.parse(payload.expires_at);
  if (expires !== null && !Number.isFinite(expires)) return null;
  return { totals, lines, delivery, discounts, requirements, expires };
}

// Quote-only calls never return the merchant checkout ID, link, buyer data, payment state or raw errors.
// The creator must invoke the service only for an explicitly requested quote from an authenticated caller.
export function createMerchantCheckoutQuoteService({ client, env = process.env, allowedSellers, clock = Date.now } = {}) {
  let defaultClient;
  function endpointFor(seller) {
    const allowed = allowedSellers ?? merchantCheckoutQuoteAllowedSellers(env);
    const endpoint = seller && Object.hasOwn(allowed, seller) ? allowed[seller] : null;
    return typeof endpoint === "string" && SHOPIFY_ENDPOINT.test(endpoint) ? endpoint : null;
  }

  function signedClient() {
    if (!client && (!env.UCP_AGENT_PROFILE_URL?.trim() || !env.UCP_AGENT_SIGNING_PRIVATE_KEY?.trim()
      || !env.UCP_AGENT_SIGNING_KEY_ID?.trim())) return null;
    try {
      const candidate = client ?? (defaultClient ??= createUcpBuyerAgentClient({
        allowTokenTier: false,
        profileUrl: env.UCP_AGENT_PROFILE_URL,
        signingPrivateKey: env.UCP_AGENT_SIGNING_PRIVATE_KEY,
        signingKeyId: env.UCP_AGENT_SIGNING_KEY_ID,
        timeoutMs: LOOKUP_TIMEOUT_MS,
        retryAttempts: 0,
      }));
      return candidate.tier === TRUST_TIER.SIGNED ? candidate : null;
    } catch { return null; }
  }

  return {
    async recoverCleanup({ sellerHost, endpoint, checkoutId, cancelKey }) {
      const sellerClient = signedClient();
      if (!sellerClient || endpointFor(canonicalReapMerchantDomain(sellerHost)) !== endpoint
        || typeof checkoutId !== "string" || !CHECKOUT_GID.test(checkoutId)) return false;
      const checkout = await readCheckout(sellerClient, endpoint, checkoutId);
      if (cancellationConfirmed(checkout, checkoutId)) return true;
      if (!checkout || checkout.order || !CHECKOUT_STATES.has(checkout.status)) return false;
      return cancelTemporaryCheckout(sellerClient, endpoint, checkoutId, cancelKey);
    },

    async quote({ sellerHost, market, expectedCurrency, lineItems, shippingAddress, discountCodes } = {},
      { beforeCreate, checkoutCreated } = {}) {
      if (!merchantCheckoutQuoteEnabled(env)) return refusal("merchant_checkout_quote_disabled");
      const seller = canonicalReapMerchantDomain(sellerHost);
      const endpoint = endpointFor(seller);
      if (!endpoint) return refusal("merchant_checkout_quote_seller_unavailable");
      if (!expectedCurrency || expectedCurrency !== marketCurrencyOf(market)) return refusal("merchant_checkout_quote_currency_mismatch");
      const requested = quoteLines(lineItems);
      const destination = wireDestination(shippingAddress, market);
      if (!requested || !destination) return refusal("merchant_checkout_quote_invalid_request");
      if (discountCodes !== undefined && (!Array.isArray(discountCodes) || discountCodes.length > 1
        || (discountCodes.length === 1 && !isAcceptableDiscountCode(discountCodes[0])))) return refusal("merchant_checkout_quote_invalid_discount");
      const requestedCode = discountCodes?.[0]?.trim();
      const sellerClient = signedClient();
      if (!sellerClient) return refusal("merchant_checkout_quote_signed_client_unavailable");

      try {
        const profile = await sellerClient.discoverEndpoint(`https://${seller}`);
        if (profile?.mcpEndpoint !== endpoint) return refusal("merchant_checkout_quote_seller_profile_mismatch");
        const catalog = await sellerClient.listTools(endpoint);
        const tools = catalog?.response?.result?.tools;
        const checkout = Array.isArray(tools) ? tools.find(tool => tool?.name === "create_checkout") : null;
        const properties = checkout?.inputSchema?.properties?.checkout?.properties;
        const method = properties?.fulfillment?.properties?.methods?.items?.properties;
        if (!method?.destinations || !method?.selected_destination_id
          || !tools.some(tool => tool?.name === "get_checkout") || !tools.some(tool => tool?.name === "cancel_checkout")
          || (requestedCode && !properties.discounts)) return refusal("merchant_checkout_quote_capability_unavailable");
      } catch { return refusal("merchant_checkout_quote_capability_unavailable"); }

      const createKey = randomUUID();
      const cancelKey = randomUUID();
      await beforeCreate?.({ sellerHost: seller, endpoint, createKey });
      let checkoutId;
      let checkpointFailed = false;
      let lifecycle = null;
      let result = refusal("merchant_checkout_quote_shopify_unverified");
      try {
        const created = await sellerClient.createCheckout(endpoint, {
          lineItems: [...requested.entries()].map(([variantId, quantity]) => ({
            item: { id: `gid://shopify/ProductVariant/${variantId}` }, quantity,
          })),
          context: {
            address_country: market, address_region: destination.address_region, postal_code: destination.postal_code,
            currency: expectedCurrency,
          },
          checkout: {
            currency: expectedCurrency,
            fulfillment: { methods: [{ type: "shipping", destinations: [destination], selected_destination_id: destination.id }] },
          },
          ...(requestedCode ? { discountCodes: [requestedCode] } : {}),
        }, { idempotencyKey: createKey });
        const original = readPayload(created);
        if (typeof original?.id === "string" && CHECKOUT_GID.test(original.id) && CHECKOUT_STATES.has(original.status) && !original.order) {
          checkoutId = original.id;
        }
        if (!checkoutId) return unknownOutcome("merchant_checkout_quote_create_unverified");
        try {
          await checkoutCreated?.({ sellerHost: seller, endpoint, checkoutId, cancelKey });
        } catch { checkpointFailed = true; }
        if (validRpc(created)) {
          const reread = lifecycle = await readCheckout(sellerClient, endpoint, checkoutId);
          const first = quoteSnapshot(original, expectedCurrency, requested, destination, requestedCode);
          const second = reread?.id === checkoutId ? quoteSnapshot(reread, expectedCurrency, requested, destination, requestedCode) : null;
          if (first && second && ["totals", "lines", "delivery", "discounts"].every(field =>
            JSON.stringify(first[field]) === JSON.stringify(second[field]))) {
            const timestamps = [first.expires, second.expires].filter(value => value !== null);
            const expires = timestamps.length ? Math.min(...timestamps) : null;
            const capturedAt = clock();
            if (expires === null || expires > capturedAt) {
              const requirements = [...new Set([...first.requirements, ...second.requirements])].sort();
              result = {
                state: requirements.length ? "verified_quote_with_buyer_requirements" : "verified_checkout_quote",
                source: "shopify_checkout_mcp", market, currency: expectedCurrency, sellerHost: seller,
                lines: second.lines,
                totals: second.totals,
                discounts: second.discounts,
                buyerRequirements: requirements,
                verifiedQuotedTotalMinor: second.totals.total,
                payableMinor: null,
                quotedAt: new Date(capturedAt).toISOString(),
                merchantExpiresAt: expires === null ? null : new Date(expires).toISOString(),
              };
            }
          }
        }
      } catch { result = refusal("merchant_checkout_quote_transport_unverified"); }

      if (!checkoutId) return unknownOutcome("merchant_checkout_quote_create_unverified");
      if (cancellationConfirmed(lifecycle, checkoutId)) {
        return { ...refusal("merchant_checkout_quote_already_canceled"), checkoutCancelled: true };
      }
      if (lifecycle && (lifecycle.order || !CHECKOUT_STATES.has(lifecycle.status))) {
        return unknownOutcome("merchant_checkout_quote_lifecycle_changed");
      }
      if (!await cancelTemporaryCheckout(sellerClient, endpoint, checkoutId, cancelKey)) {
        return { ...unknownOutcome("merchant_checkout_quote_cleanup_unverified"), checkoutCancelled: false };
      }
      return { ...(checkpointFailed ? refusal("merchant_checkout_quote_checkpoint_unavailable") : result),
        checkoutCancelled: true };
    },
  };
}
