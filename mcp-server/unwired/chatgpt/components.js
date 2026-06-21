function descriptor(component, props) {
  return {
    type: "component",
    component,
    props: toSerializable(props) ?? {}
  };
}

export function productListComponent(searchResult = {}) {
  const items = firstArray(
    searchResult.items,
    searchResult.products,
    searchResult.results,
    searchResult.data?.items,
    searchResult.data?.products
  );

  return descriptor("product_list", {
    items: (items ?? []).map(productSummary),
    query: searchResult.query ?? searchResult.search?.query,
    page_info: compactObject({
      page: searchResult.page,
      page_size: searchResult.page_size ?? searchResult.limit,
      total: searchResult.total,
      next_cursor: searchResult.next_cursor
    })
  });
}

export function productDetailComponent(detail = {}) {
  return descriptor("product_detail", {
    product: productDetail(detail)
  });
}

export function quoteCardComponent(quote = {}) {
  const quoteId = firstString(quote.quote_id, quote.id);

  if (!quoteId) {
    throw new TypeError("quoteCardComponent requires quote.quote_id.");
  }

  return descriptor("quote_card", {
    quote_id: quoteId,
    expires_at: quote.expires_at,
    currency: quote.currency,
    merchant_of_record: quote.merchant_of_record,
    locked_totals: lockedTotals(quote),
    line_items: firstArray(quote.line_items, quote.items) ?? [],
    actions: [
      {
        type: "confirm",
        label: "Confirm",
        action: "confirm_quote",
        quote_id: quoteId,
        payload: { quote_id: quoteId }
      }
    ]
  });
}

export function orderConfirmationComponent(order = {}) {
  return descriptor("order_confirmation", {
    order_id: firstString(order.order_id, order.id),
    quote_id: order.quote_id,
    status: order.status,
    amount_total: order.amount_total ?? order.total,
    currency: order.currency,
    merchant_of_record: order.merchant_of_record,
    confirmation_required: order.confirmation_required,
    estimated_delivery: order.estimated_delivery ?? order.eta,
    line_items: firstArray(order.line_items, order.items) ?? []
  });
}

export function paymentResultComponent(payment = {}) {
  const status = payment.status ?? payment.payment_status;

  return descriptor("payment_result", {
    status,
    order_id: payment.order_id,
    payment_id: payment.payment_id ?? payment.transaction_id,
    amount_total: payment.amount_total ?? payment.total,
    currency: payment.currency,
    requires_action: requiresAction(status, payment),
    error: payment.error
  });
}

export function afterSalesComponent(result = {}) {
  return descriptor("after_sales", {
    order_id: result.order_id ?? result.status?.order_id,
    requested_action: result.requested_action ?? result.status?.requested_action,
    status: result.status,
    message: result.message,
    next_steps: result.next_steps,
    label_url: result.label_url,
    pickup_window: result.pickup_window,
    timeline: result.timeline
  });
}

function productSummary(product = {}) {
  return compactObject({
    product_id: product.product_id ?? product.id,
    sku_id: product.sku_id,
    merchant_id: product.merchant_id,
    name: product.name ?? product.title,
    title: product.title,
    price: product.price ?? product.amount,
    currency: product.currency,
    image_url: product.image_url ?? product.image,
    url: product.url,
    attributes: product.attributes,
    estimated_delivery: product.estimated_delivery ?? product.delivery,
    in_stock: product.in_stock ?? product.available
  });
}

function productDetail(detail = {}) {
  return compactObject({
    product_id: detail.product_id ?? detail.id,
    sku_id: detail.sku_id,
    merchant_id: detail.merchant_id,
    name: detail.name ?? detail.title,
    title: detail.title,
    description: detail.description,
    price: detail.price ?? detail.amount,
    currency: detail.currency,
    images: firstArray(detail.images, detail.image_urls),
    variants: detail.variants,
    attributes: detail.attributes,
    offers: detail.offers,
    estimated_delivery: detail.estimated_delivery ?? detail.delivery,
    in_stock: detail.in_stock ?? detail.available
  });
}

function lockedTotals(quote) {
  const totals = quote.locked_totals ?? quote.totals ?? quote;

  return compactObject({
    subtotal: totals.subtotal,
    tax: totals.tax,
    shipping: totals.shipping,
    discount: totals.discount,
    total: totals.total ?? quote.amount_total
  });
}

function requiresAction(status, payment) {
  const explicit = firstPlainObject(
    payment.requires_action,
    payment.next_action,
    payment.action_required
  );

  if (explicit) {
    return explicit;
  }

  if (status !== "requires_action") {
    return undefined;
  }

  return compactObject({
    redirect_url: payment.redirect_url,
    qr_code: payment.qr_code,
    instructions: payment.instructions
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

function firstPlainObject(...values) {
  return values.find((value) => isPlainObject(value));
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
