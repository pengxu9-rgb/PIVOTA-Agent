export const ACP_MAPPING_ASSUMPTIONS = Object.freeze([
  "ACP state is an opaque pass-through object and is copied without inspecting or rewriting it.",
  "Pivota locked_totals are represented as the ACP checkout amount summary because the quote is authoritative.",
  "Pivota canonical quote/order payloads are preserved under extensions.pivota.canonical for lossless adapter round-trips until final ACP field names are locked."
]);

export function toAcpCheckout(quote = {}, order = {}) {
  const canonicalQuote = toSerializable(quote) ?? {};
  const canonicalOrder = toSerializable(order) ?? {};
  const totals = lockedTotals(canonicalQuote, canonicalOrder);
  const currency = canonicalQuote.currency ?? canonicalOrder.currency;
  const quoteId = firstString(canonicalQuote.quote_id, canonicalQuote.id, canonicalOrder.quote_id);
  const orderId = firstString(canonicalOrder.order_id, canonicalOrder.id);
  const acpState = canonicalOrder.acp_state ?? canonicalQuote.acp_state;

  return compactObject({
    protocol: "agentic-commerce-protocol",
    type: "checkout",
    version: "pivota.acp.best_effort.v1",
    checkout_id: orderId ?? quoteId,
    quote: compactObject({
      quote_id: quoteId,
      expires_at: canonicalQuote.expires_at,
      currency,
      merchant_of_record:
        canonicalQuote.merchant_of_record ?? canonicalOrder.merchant_of_record,
      locked_totals: totals,
      line_items: firstArray(canonicalQuote.line_items, canonicalQuote.items)
    }),
    order: compactObject({
      order_id: orderId,
      quote_id: canonicalOrder.quote_id ?? quoteId,
      status: canonicalOrder.status,
      amount_total: canonicalOrder.amount_total ?? canonicalOrder.total ?? totals?.total,
      currency,
      merchant_of_record:
        canonicalOrder.merchant_of_record ?? canonicalQuote.merchant_of_record,
      line_items: firstArray(canonicalOrder.line_items, canonicalOrder.items)
    }),
    acp_state: toSerializable(acpState),
    extensions: {
      pivota: {
        mapping_version: "x3.best_effort.v1",
        canonical: {
          quote: canonicalQuote,
          order: canonicalOrder
        }
      }
    }
  });
}

export function fromAcpEvent(evt = {}) {
  const checkout = evt.checkout ?? evt.payload?.checkout ?? evt.data?.checkout ?? evt;
  const canonical = checkout.extensions?.pivota?.canonical ?? evt.extensions?.pivota?.canonical;

  if (canonical) {
    return compactObject({
      quote: toSerializable(canonical.quote) ?? {},
      order: toSerializable(canonical.order) ?? {},
      acp_state: toSerializable(
        checkout.acp_state ?? canonical.order?.acp_state ?? canonical.quote?.acp_state
      )
    });
  }

  const quote = checkout.quote ?? {};
  const order = checkout.order ?? {};
  const acpState = checkout.acp_state;

  return compactObject({
    quote: compactObject({
      quote_id: quote.quote_id,
      expires_at: quote.expires_at,
      currency: quote.currency ?? order.currency,
      merchant_of_record: quote.merchant_of_record ?? order.merchant_of_record,
      locked_totals: quote.locked_totals,
      line_items: quote.line_items,
      acp_state: acpState
    }),
    order: compactObject({
      order_id: order.order_id,
      quote_id: order.quote_id ?? quote.quote_id,
      status: order.status,
      amount_total: order.amount_total ?? quote.locked_totals?.total,
      currency: order.currency ?? quote.currency,
      merchant_of_record: order.merchant_of_record ?? quote.merchant_of_record,
      line_items: order.line_items,
      acp_state: acpState
    }),
    acp_state: acpState
  });
}

function lockedTotals(quote, order) {
  const totals = quote.locked_totals ?? quote.totals;

  if (totals) {
    return toSerializable(totals);
  }

  return compactObject({
    subtotal: quote.subtotal,
    tax: quote.tax,
    shipping: quote.shipping,
    discount: quote.discount,
    total: quote.total ?? quote.amount_total ?? order.amount_total ?? order.total
  });
}

function compactObject(value) {
  if (!isPlainObject(value)) {
    return value;
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      output[key] = item;
    }
  }
  return output;
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value));
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function toSerializable(value, seen = new WeakSet()) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .map((item) => toSerializable(item, seen))
      .filter((item) => item !== undefined);
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const next = toSerializable(item, seen);
    if (next !== undefined) {
      output[key] = next;
    }
  }

  return output;
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
