import { PivotaCommerceError } from "../../../safety-kernel/src/errors.js";
import { operationMap } from "../../src/operationMap.js";

export const CHECKOUT_STAGES = Object.freeze({
  discover: "discover",
  quote: "quote",
  confirm: "confirm",
  createOrder: "create_order",
  pay: "pay",
  track: "track"
});

const TOOLS = Object.freeze({
  search: "pivota_search",
  quote: "pivota_quote",
  createOrder: "pivota_create_order",
  pay: "pivota_pay",
  orders: "pivota_orders"
});

export function nextStep(state = {}) {
  if (hasFinishedPayment(state)) {
    return step({
      stage: CHECKOUT_STAGES.track,
      tool: TOOLS.orders,
      operation: operationFor(TOOLS.orders, "get_order_status"),
      requiresConfirmationBeforePay: false,
      context: { order_id: orderId(state) }
    });
  }

  if (hasOrder(state)) {
    const confirmed = hasConfirmation(state);
    return step({
      stage: confirmed ? CHECKOUT_STAGES.pay : CHECKOUT_STAGES.confirm,
      tool: confirmed ? TOOLS.pay : null,
      operation: confirmed ? operationFor(TOOLS.pay, "submit_payment") : null,
      requiresConfirmationBeforePay: !confirmed,
      context: { quote_id: quoteId(state), order_id: orderId(state) }
    });
  }

  if (hasQuote(state)) {
    const confirmed = hasConfirmation(state);
    return step({
      stage: confirmed ? CHECKOUT_STAGES.createOrder : CHECKOUT_STAGES.confirm,
      tool: confirmed ? TOOLS.createOrder : null,
      operation: confirmed ? operationFor(TOOLS.createOrder, "create_order") : null,
      requiresConfirmationBeforePay: !confirmed,
      context: { quote_id: quoteId(state) }
    });
  }

  if (hasSelectedItems(state)) {
    return step({
      stage: CHECKOUT_STAGES.quote,
      tool: TOOLS.quote,
      operation: operationFor(TOOLS.quote, "preview_quote"),
      requiresConfirmationBeforePay: false
    });
  }

  return step({
    stage: CHECKOUT_STAGES.discover,
    tool: TOOLS.search,
    operation: operationFor(TOOLS.search, "find_products"),
    requiresConfirmationBeforePay: false
  });
}

export function assertConfirmedBeforePay(state = {}) {
  if (hasConfirmation(state)) {
    return true;
  }

  throw new PivotaCommerceError("CONFIRMATION_REQUIRED", {
    quote_id: quoteId(state),
    order_id: orderId(state),
    message:
      "Payment requires the user confirmation step and a host-minted confirmation_token."
  });
}

function step({
  stage,
  tool,
  operation,
  requiresConfirmationBeforePay,
  context = {}
}) {
  return {
    stage,
    tool,
    operation,
    requiresConfirmationBeforePay,
    userConfirmationRequired: stage === CHECKOUT_STAGES.confirm,
    context: compactObject(context)
  };
}

function hasSelectedItems(state) {
  return firstArray(
    state.selected_items,
    state.selectedItems,
    state.items,
    state.cart?.items
  )?.length > 0;
}

function hasQuote(state) {
  return Boolean(quoteId(state) || state.quote);
}

function hasOrder(state) {
  return Boolean(orderId(state) || state.order);
}

function hasFinishedPayment(state) {
  const payment = state.payment ?? {};
  const status = state.payment_status ?? payment.status ?? payment.payment_status;
  return status === "succeeded" || status === "paid" || status === "captured";
}

function hasConfirmation(state) {
  return Boolean(
    nonEmptyString(state.confirmation_token) ||
      nonEmptyString(state.confirmationToken)
  );
}

function quoteId(state) {
  return firstString(
    state.quote_id,
    state.quoteId,
    state.quote?.quote_id,
    state.quote?.id,
    state.order?.quote_id
  );
}

function orderId(state) {
  return firstString(state.order_id, state.orderId, state.order?.order_id, state.order?.id);
}

function operationFor(tool, operation) {
  if (!operationMap[tool]?.includes(operation)) {
    throw new Error(`Operation ${operation} is not allowed for ${tool}.`);
  }

  return operation;
}

function compactObject(value) {
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
  return values.find(nonEmptyString);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
