#!/usr/bin/env node
/*
 * Probe Pivota shop wire-format money units against a live gateway.
 *
 * What it does:
 * - Calls POST {PROBE_BASE}/agent/shop/v1/invoke with { operation, payload }.
 * - Default mode is read-only: find_products, then preview_quote.
 * - --create-order also creates one backend order draft. This is a write, but no charge.
 * - --charge also submits payment. This can move real money.
 * - --dry-run prints the request bodies for enabled steps and exits without network.
 * - --json additionally prints a machine-readable summary object.
 *
 * Env vars:
 * - PROBE_BASE        Required. Gateway base URL, for example https://example.com.
 * - PROBE_KEY         Required. Auth bearer/API key. Read only, never printed.
 * - PROBE_AUTH_HEADER Optional. Auth header name. Default "Authorization" (Bearer). Set to e.g.
 *                     "X-API-Key" if the gateway uses an API-key header instead of a Bearer token.
 * - PROBE_MERCHANT_ID Optional. Merchant to use for the quote/order.
 * - PROBE_PRODUCT_ID  Optional. Product to use for the quote/order.
 * - PROBE_QUERY       Optional. Product search query. Defaults to a generic cheap query.
 * - PROBE_CURRENCY    Optional. Payment currency. Defaults to USD.
 * - PROBE_ALLOW_CHARGE Required as "1" when using --charge.
 * - PROBE_PAYMENT_HANDLER_TYPE Optional PSP selector for --charge, e.g. stripe or adyen.
 * - PROBE_PAYMENT_HANDLER_ID   Optional PSP handler id for --charge.
 * - PROBE_REPEAT_SUBMIT Optional. Set "1" with --charge to repeat the same submit body once (TEST MODE ONLY).
 *
 * Example invocations:
 * - Read-only:
 *     PROBE_BASE=https://gateway.example PROBE_KEY=... node scripts/probe_wire_format.mjs
 * - With create_order:
 *     PROBE_BASE=https://gateway.example PROBE_KEY=... node scripts/probe_wire_format.mjs --create-order
 * - With submit_payment:
 *     PROBE_BASE=https://gateway.example PROBE_KEY=... PROBE_ALLOW_CHARGE=1 node scripts/probe_wire_format.mjs --create-order --charge
 *
 * Safety notes:
 * - Prefer Stripe TEST mode. Live charges move real money.
 * - Stripe live minimum is about $0.50 USD, so a 1-cent live charge is rejected.
 * - If a live test is necessary, use the cheapest acceptable item and refund immediately.
 * - This script never calls Stripe directly. It prints returned PSP IDs and tells the
 *   human operator to verify the amount in the Stripe dashboard.
 * - It never prints PROBE_KEY, Authorization, client_secret, ap2_state, or secret-looking values.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_QUERY = "cheap test item";
const DEFAULT_CURRENCY = "USD";
const INVOKE_PATH = "/agent/shop/v1/invoke";
const REDACTED = "[REDACTED]";

class ProbeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProbeError";
    this.details = details;
  }
}

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function parseArgs(argv) {
  const flags = {
    createOrder: false,
    charge: false,
    dryRun: false,
    json: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--create-order") {
      flags.createOrder = true;
    } else if (arg === "--charge") {
      flags.charge = true;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else {
      throw new UsageError(`Unknown flag: ${arg}`);
    }
  }

  return flags;
}

function usageText() {
  return [
    "Usage: node scripts/probe_wire_format.mjs [--create-order] [--charge] [--dry-run] [--json]",
    "",
    "Default: read-only find_products + preview_quote.",
    "--create-order: also run create_order, a backend write with no charge.",
    "--charge: also run submit_payment, a real charge unless the backend/PSP is in test mode.",
    "--dry-run: print enabled request bodies and exit without network.",
    "--json: also emit a machine-readable results object.",
  ].join("\n");
}

function loadConfig() {
  const base = mustEnv("PROBE_BASE");
  const key = mustEnv("PROBE_KEY");

  return {
    base,
    key,
    // Auth header name. Default "Authorization" (Bearer). Set e.g. PROBE_AUTH_HEADER=X-API-Key if the
    // gateway authenticates agent requests with an API-key header instead of a Bearer token.
    authHeader: optionalEnv("PROBE_AUTH_HEADER") || "Authorization",
    merchantId: optionalEnv("PROBE_MERCHANT_ID"),
    productId: optionalEnv("PROBE_PRODUCT_ID"),
    variantId: optionalEnv("PROBE_VARIANT_ID"),
    query: optionalEnv("PROBE_QUERY") || DEFAULT_QUERY,
    currency: (optionalEnv("PROBE_CURRENCY") || DEFAULT_CURRENCY).toUpperCase(),
    allowCharge: process.env.PROBE_ALLOW_CHARGE === "1",
    chargeConfirm: optionalEnv("PROBE_CHARGE_CONFIRM"),
    paymentHandlerType: optionalEnv("PROBE_PAYMENT_HANDLER_TYPE"),
    paymentHandlerId: optionalEnv("PROBE_PAYMENT_HANDLER_ID"),
    repeatSubmit: process.env.PROBE_REPEAT_SUBMIT === "1",
  };
}

function mustEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new UsageError(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function validateSafety(flags, config) {
  if (flags.charge && !flags.createOrder) {
    throw new UsageError("Refusing --charge without --create-order. create_order only runs when --create-order is explicit.");
  }

  if (flags.charge && !config.allowCharge) {
    throw new UsageError("Refusing --charge unless PROBE_ALLOW_CHARGE=1 is set.");
  }

  // Confirmation: interactively a typed "yes" (TTY); non-interactively (CI) an explicit
  // PROBE_CHARGE_CONFIRM=yes. Without one of those, refuse — so a charge can never fire by accident.
  if (flags.charge && !flags.dryRun && !process.stdin.isTTY && config.chargeConfirm !== "yes") {
    throw new UsageError("Refusing --charge non-interactively without PROBE_CHARGE_CONFIRM=yes (use this ONLY when the backend/PSP is in test mode).");
  }
}

function buildInvokeUrl(base) {
  return `${base.replace(/\/+$/, "")}${INVOKE_PATH}`;
}

function buildAuthHeaders(config) {
  // For the default Authorization header, add a Bearer prefix unless the key already carries a scheme.
  // For a custom header (e.g. X-API-Key) send the raw key value verbatim.
  if (config.authHeader.toLowerCase() === "authorization") {
    const value = /^(Bearer|ApiKey|Basic)\s+/i.test(config.key) ? config.key : `Bearer ${config.key}`;
    return { Authorization: value };
  }
  return { [config.authHeader]: config.key };
}

function requestBody(operation, payload) {
  return { operation, payload };
}

function buildFindProductsBody(config) {
  return requestBody("find_products", {
    search: {
      query: config.query,
    },
  });
}

function buildProductDetailBody(selection) {
  return requestBody("get_product_detail", {
    product: { merchant_id: selection.merchantId, product_id: selection.productId },
  });
}

// Find a variants[] array anywhere in a get_product_detail response and return the first usable id.
function extractVariantId(detail) {
  const queue = [detail];
  while (queue.length) {
    const v = queue.shift();
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v)) { v.forEach((x) => queue.push(x)); continue; }
    for (const [k, child] of Object.entries(v)) {
      if (k === "variants" && Array.isArray(child)) {
        for (const variant of child) {
          const vid = variant && (variant.variant_id || variant.variantId || variant.id);
          if (vid) return String(vid);
        }
      }
      queue.push(child);
    }
  }
  return undefined;
}

// The order's shipping geo MUST match the quote's, or create_order fails with QUOTE_MISMATCH
// (drift_fields: ["shipping_geo"]). Keep these two in lockstep.
const PROBE_SHIP_GEO = { country: "US", postal_code: "94102", city: "SF" };

function buildPreviewQuoteBody(selection, variantId) {
  return requestBody("preview_quote", {
    quote: {
      merchant_id: selection.merchantId,
      items: [
        {
          product_id: selection.productId,
          ...(variantId ? { variant_id: variantId } : {}),
          quantity: 1,
        },
      ],
      shipping_address: { ...PROBE_SHIP_GEO },
    },
  });
}

function buildCreateOrderBody(selection, quoteId, majorPrice, variantId) {
  return requestBody("create_order", {
    order: {
      quote_id: quoteId,
      customer_email: "probe@pivota.test",
      items: [
        {
          merchant_id: selection.merchantId,
          product_id: selection.productId,
          ...(variantId ? { variant_id: variantId } : {}),
          product_title: selection.productTitle || "probe",
          quantity: 1,
          unit_price: majorPrice,
        },
      ],
      shipping_address: { name: "Probe", address_line1: "1 Test St", ...PROBE_SHIP_GEO },
    },
  });
}

function buildSubmitPaymentBody(orderId, quoteId, expectedMinor, currency, handler = {}) {
  const payment = {
    order_id: orderId,
    quote_id: quoteId,
    expected_amount: expectedMinor,
    currency,
    payment_method_hint: "card",
  };
  if (handler.type) payment.payment_handler_type = handler.type;
  if (handler.id) payment.payment_handler_id = handler.id;
  return requestBody("submit_payment", { payment });
}

async function invoke(operationBody, config) {
  const url = buildInvokeUrl(config.base);
  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        ...buildAuthHeaders(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(operationBody),
    });
  } catch (error) {
    throw new ProbeError("Network error", {
      operation: operationBody.operation,
      message: redactString(error && error.message ? error.message : String(error)),
    });
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch (error) {
    throw new ProbeError("JSON parse error", {
      operation: operationBody.operation,
      status: response.status,
      body: redactValue(text),
      parse_error: redactString(error && error.message ? error.message : String(error)),
    });
  }

  if (!response.ok) {
    throw new ProbeError("HTTP non-2xx response", {
      operation: operationBody.operation,
      status: response.status,
      body: parsed === undefined ? "" : redactValue(parsed),
    });
  }

  return parsed;
}

function safeProducts(data) {
  const candidates = [
    data?.products,
    data?.results,
    data?.items,
    data?.data?.products,
    data?.data?.results,
    data?.data?.items,
    data?.payload?.products,
    data?.payload?.items,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function selectProduct(products, config) {
  const exact = products.find((product) => {
    const productId = getFirst(product, ["product_id", "productId", "id", "sku_id"]);
    const merchantId = getFirst(product, ["merchant_id", "merchantId", "seller_id", "merchant"]);
    const productMatches = config.productId ? String(productId) === config.productId : true;
    const merchantMatches = config.merchantId ? String(merchantId) === config.merchantId : true;
    return productMatches && merchantMatches;
  });

  const product = exact || products[0] || {};
  const productId = config.productId || getFirst(product, ["product_id", "productId", "id", "sku_id"]);
  const merchantId = config.merchantId || getFirst(product, ["merchant_id", "merchantId", "seller_id", "merchant"]);

  return {
    product,
    productId,
    merchantId,
    productTitle: getFirst(product, ["title", "name", "product_title", "productTitle"]) || "probe",
    currency: getCurrency(product),
    price: extractMajorPriceFromProduct(product),
    selectedFromResponse: Boolean(exact || products[0]),
  };
}

function productToSelection(product, config) {
  const productId = config.productId || getFirst(product, ["product_id", "productId", "id", "sku_id"]);
  const merchantId = config.merchantId || getFirst(product, ["merchant_id", "merchantId", "seller_id", "merchant"]);
  return {
    product,
    productId,
    merchantId,
    productTitle: getFirst(product, ["title", "name", "product_title", "productTitle"]) || "probe",
    currency: getCurrency(product),
    price: extractMajorPriceFromProduct(product),
  };
}

// Ordered candidate products to attempt preview_quote on. A pinned PROBE_PRODUCT_ID yields exactly one;
// otherwise up to `max` from the search, so a stale/unpurchasable item doesn't fail the whole probe.
function buildCandidates(products, config, max = 12) {
  if (config.productId) {
    const found = products.find((p) => String(getFirst(p, ["product_id", "productId", "id", "sku_id"])) === config.productId);
    const sel = productToSelection(found || {}, config);
    return sel.productId && sel.merchantId ? [sel] : [];
  }
  return products.slice(0, max).map((p) => productToSelection(p, config)).filter((s) => s.productId && s.merchantId);
}

function getFirst(object, keys) {
  if (!object || typeof object !== "object") {
    return undefined;
  }

  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== "") {
      return object[key];
    }
  }

  return undefined;
}

function getCurrency(object) {
  const value = getFirst(object, ["currency", "currency_code", "currencyCode"]);
  if (typeof value === "string" && value.trim()) {
    return value.trim().toUpperCase();
  }

  if (object?.price && typeof object.price === "object") {
    const nested = getFirst(object.price, ["currency", "currency_code", "currencyCode"]);
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim().toUpperCase();
    }
  }

  return undefined;
}

function extractMajorPriceFromProduct(product) {
  if (!product || typeof product !== "object") {
    return undefined;
  }

  const directPrice = product.price;
  const direct = parseMoneyValue(directPrice);
  if (direct !== undefined) {
    return direct;
  }

  const candidateKeys = [
    "unit_price",
    "unitPrice",
    "amount",
    "display_price",
    "displayPrice",
    "sale_price",
    "salePrice",
  ];

  for (const key of candidateKeys) {
    const parsed = parseMoneyValue(product[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function extractMajorPriceFromQuote(quoteResponse) {
  const values = [
    quoteResponse?.pricing?.unit_price,
    quoteResponse?.pricing?.unitPrice,
    quoteResponse?.pricing?.subtotal,
    quoteResponse?.pricing?.total,
    quoteResponse?.quote?.pricing?.unit_price,
    quoteResponse?.quote?.pricing?.unitPrice,
    quoteResponse?.quote?.pricing?.subtotal,
    quoteResponse?.quote?.pricing?.total,
    quoteResponse?.data?.pricing?.unit_price,
    quoteResponse?.data?.pricing?.unitPrice,
    quoteResponse?.data?.pricing?.subtotal,
    quoteResponse?.data?.pricing?.total,
    quoteResponse?.data?.quote?.pricing?.unit_price,
    quoteResponse?.data?.quote?.pricing?.unitPrice,
    quoteResponse?.data?.quote?.pricing?.subtotal,
    quoteResponse?.data?.quote?.pricing?.total,
  ];

  for (const value of values) {
    const parsed = parseMajorMoneyValueFromQuote(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function parseMajorMoneyValueFromQuote(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? undefined : value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/[$,\s]/g, "");
    if (!normalized || !normalized.includes(".")) {
      return undefined;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (value && typeof value === "object") {
    const nestedKeys = ["amount", "value", "total", "price", "display"];
    for (const key of nestedKeys) {
      const parsed = parseMajorMoneyValueFromQuote(value[key]);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }

  return undefined;
}

function parseMoneyValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/[$,\s]/g, "");
    if (!normalized) {
      return undefined;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (value && typeof value === "object") {
    const nestedKeys = ["amount", "value", "total", "price", "display"];
    for (const key of nestedKeys) {
      const parsed = parseMoneyValue(value[key]);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }

  return undefined;
}

function quoteInfo(response) {
  const pricing = response?.pricing || response?.quote?.pricing || response?.data?.pricing || response?.data?.quote?.pricing;
  const quote = response?.quote || response?.data?.quote || response?.data || response;
  const currencyRaw = getFirst(response, ["currency", "currency_code"]) || getFirst(quote, ["currency", "currency_code"]) || getFirst(pricing, ["currency", "currency_code"]);
  return {
    quoteId: getFirst(quote, ["quote_id", "quoteId", "id"]),
    currency: normalizeCurrency(currencyRaw),
    currencyRaw,
    pricing,
    pricingTotal: pricing?.total,
  };
}

function orderInfo(response) {
  const order = response?.order || response?.data?.order || response?.data || response;
  const amounts = order?.amounts || order?.pricing || {};
  const currencyRaw = amounts?.currency || order?.currency || response?.currency;
  return {
    order,
    orderId: getFirst(order, ["order_id", "orderId", "id"]),
    amounts,
    total: amounts?.total,
    currency: normalizeCurrency(currencyRaw),
    currencyRaw,
  };
}

function paymentInfo(response) {
  const payment = response?.payment || response?.data?.payment || response?.data || response;
  return {
    status: getFirst(response, ["status"]) || getFirst(payment, ["status"]),
    paymentStatus: getFirst(response, ["payment_status", "paymentStatus"]) || getFirst(payment, ["payment_status", "paymentStatus", "status"]),
    psp: getFirst(response, ["psp", "provider", "payment_provider", "paymentProvider", "routed_psp", "routedPsp"]) || getFirst(payment, ["psp", "provider", "payment_provider", "paymentProvider", "routed_psp", "routedPsp", "payment_handler_type", "paymentHandlerType"]),
    confirmationOwner: getFirst(response, ["confirmation_owner", "confirmationOwner"]) || getFirst(payment, ["confirmation_owner", "confirmationOwner"]),
    requiresClientConfirmation: getFirst(response, ["requires_client_confirmation", "requiresClientConfirmation"]) ?? getFirst(payment, ["requires_client_confirmation", "requiresClientConfirmation"]),
    paymentId: findByKey(response, ["payment_id", "paymentId"]),
    paymentIntentId: findByKey(response, ["payment_intent_id", "paymentIntentId", "id"], (key, value, path) => {
      return /payment[_-]?intent/i.test(path.join(".")) || /^pi_(test|live)?_?/.test(String(value));
    }),
    checkoutSessionId: findByKey(response, ["checkout_session_id", "checkoutSessionId", "id"], (key, value, path) => {
      return /checkout[_-]?session/i.test(path.join(".")) || /^cs_(test|live)_/.test(String(value));
    }),
    pspReference: findByKey(response, ["pspReference", "psp_reference", "psp_ref", "pspRef"], (key, value, path) => {
      return /psp/i.test(path.join(".")) || /psp/i.test(key);
    }),
    echoedAmount: findPaymentAmount(response),
  };
}

function paymentIdentity(info) {
  return info?.paymentIntentId || info?.checkoutSessionId || info?.pspReference || info?.paymentId || null;
}

function normalizeCurrency(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim().toUpperCase();
  }
  return undefined;
}

function expectedMinorFromMajor(majorPrice) {
  if (typeof majorPrice !== "number" || !Number.isFinite(majorPrice)) {
    return undefined;
  }
  return Math.round(majorPrice * 100);
}

function classifyAmount(value, majorPrice) {
  const numeric = parseMoneyValue(value);
  if (numeric === undefined || typeof majorPrice !== "number" || !Number.isFinite(majorPrice)) {
    return "UNKNOWN";
  }

  const expectedMinor = expectedMinorFromMajor(majorPrice);
  if (approximatelyEqual(numeric, expectedMinor)) {
    return "MINOR";
  }

  if (approximatelyEqual(numeric, majorPrice)) {
    return "MAJOR";
  }

  return "INCONSISTENT";
}

function approximatelyEqual(left, right) {
  return Math.abs(Number(left) - Number(right)) < 1e-9;
}

function classifyByFormat(value) {
  // Classify a value's unit by FORMAT alone, no external reference. A decimal string ("95.00") or a
  // non-integer number is unambiguously MAJOR. A bare integer can't be told from minor units by format.
  if (typeof value === "string" && /\d/.test(value) && value.includes(".")) return "MAJOR (decimal string)";
  if (typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)) return "MAJOR (decimal)";
  if ((typeof value === "number" && Number.isInteger(value)) || (typeof value === "string" && /^\s*\d+\s*$/.test(value))) return "AMBIGUOUS (bare integer)";
  return "UNKNOWN";
}

function jsType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function describeValue(value) {
  if (value === undefined) {
    return "not present";
  }
  if (typeof value === "string") {
    return JSON.stringify(redactString(value));
  }
  return safeStringify(redactValue(value));
}

function describeWithType(value) {
  return `${describeValue(value)} (${jsType(value)})`;
}

function findByKey(root, keys, predicate) {
  const queue = [{ value: root, path: [] }];
  const wanted = new Set(keys);

  while (queue.length) {
    const { value, path } = queue.shift();
    if (!value || typeof value !== "object") {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => queue.push({ value: item, path: path.concat(String(index)) }));
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      const childPath = path.concat(key);
      if (wanted.has(key) && (!predicate || predicate(key, child, childPath))) {
        return child;
      }
      queue.push({ value: child, path: childPath });
    }
  }

  return undefined;
}

function findPaymentAmount(root) {
  const amountFields = [
    "expected_amount",
    "expectedAmount",
    "amount_total",
    "amountTotal",
    "amount",
    "total",
  ];

  const queue = [{ value: root, path: [] }];

  while (queue.length) {
    const { value, path } = queue.shift();
    if (!value || typeof value !== "object") {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => queue.push({ value: item, path: path.concat(String(index)) }));
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      const childPath = path.concat(key);
      const pathText = childPath.join(".");
      const looksPaymentRelated = /(payment|intent|checkout|session|stripe|psp|wire|amount|expected)/i.test(pathText);
      if (amountFields.includes(key) && looksPaymentRelated && isMoneyScalar(child)) {
        return { field: pathText, value: child };
      }
      queue.push({ value: child, path: childPath });
    }
  }

  return undefined;
}

function isMoneyScalar(value) {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    return parseMoneyValue(value) !== undefined;
  }
  return false;
}

function detectBackend(responses) {
  for (const [step, response] of Object.entries(responses)) {
    const evidence = findBackendEvidence(response);
    if (evidence) {
      return {
        label: "v2 (/agent/v2/*, Node)",
        evidence: `${evidence} in ${step}`,
      };
    }
  }

  return {
    label: "unknown",
    evidence: "no payment_action, checkout_session, or engine_ref found in attempted responses",
  };
}

function findBackendEvidence(root) {
  const queue = [root];
  const evidenceKeys = new Set(["payment_action", "paymentAction", "checkout_session", "checkoutSession", "engine_ref", "engineRef"]);

  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object") {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => queue.push(item));
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      if (evidenceKeys.has(key)) {
        return key;
      }
      queue.push(child);
    }
  }

  return undefined;
}

function makeInitialResults(flags) {
  return {
    attempted: {
      find_products: true,
      preview_quote: true,
      create_order: flags.createOrder,
      submit_payment: flags.charge,
    },
    backend_detection: {
      label: "unknown",
      evidence: "not evaluated yet",
    },
    step1: {},
    step2: {},
    step3: flags.createOrder ? {} : { not_attempted: true },
    step4: flags.charge ? {} : { not_attempted: true },
    step5: {
      stripe_charged: "manual dashboard check required; script does not call Stripe",
      currency: "manual dashboard check required",
      equals_intended: "manual dashboard check required",
      refunded_or_voided: "manual: yes / n/a (test mode)",
    },
    evaluation: {},
  };
}

function computeVerdict(results) {
  const orderClass = results.step3?.amounts_total_classification;
  const paymentClass = results.step4?.payment_wire_amount_classification;

  // If the reference total's own unit isn't self-evidently major, no MINOR/MAJOR verdict is trustworthy.
  if (results.evaluation?.reference_trusted === false) {
    return {
      verdict: "UNRELIABLE - reference unit ambiguous",
      codeMeaning: "Re-run against an item whose quote total is a decimal with cents before drawing any units conclusion; the raw captured values + types above are still informative.",
    };
  }

  if (results.step3?.not_attempted) {
    return {
      verdict: "READ-ONLY PARTIAL - create_order not attempted",
      codeMeaning: "No code decision yet; run with --create-order to classify order.amounts.total before enabling kernel-mediated submit_payment.",
    };
  }

  if (orderClass === "MAJOR") {
    return {
      verdict: "MAJOR - kernel cross-check must flip",
      codeMeaning: "Parse backend order.amounts.total as major units before comparing to the kernel's intended minor-unit amount.",
    };
  }

  if (orderClass === "INCONSISTENT" || orderClass === "UNKNOWN") {
    return {
      verdict: "INCONSISTENT - investigate",
      codeMeaning: "Do not enable kernel-mediated submit_payment until the backend order total unit is explained.",
    };
  }

  if (paymentClass && paymentClass !== "MINOR") {
    return {
      verdict: paymentClass === "MAJOR" ? "MAJOR - kernel cross-check must flip" : "INCONSISTENT - investigate",
      codeMeaning: "Do not enable submit_payment forwarding until the payment wire amount unit matches the kernel expectation.",
    };
  }

  if (results.step4?.not_attempted) {
    return {
      verdict: "MINOR confirmed for create_order; payment wire not attempted",
      codeMeaning: "The order total matches the kernel's minor-unit cross-check, but run --charge in test mode to verify PSP forwarding.",
    };
  }

  return {
    verdict: "MINOR confirmed",
    codeMeaning: "The kernel can keep minor-unit order cross-checking and minor-unit expected_amount forwarding.",
  };
}

function buildDryRunBodies(config, flags) {
  const selection = {
    merchantId: config.merchantId || "__FROM_STEP1_MERCHANT_ID__",
    productId: config.productId || "__FROM_STEP1_PRODUCT_ID__",
    productTitle: "__FROM_STEP1_PRODUCT_TITLE_OR_probe__",
  };
  const quoteId = "__FROM_STEP2_QUOTE_ID__";
  const majorPrice = "__MAJOR_UNIT_PRICE_FROM_STEP1_OR_STEP2__";
  const orderId = "__FROM_STEP3_ORDER_ID__";
  const expectedMinor = "__ROUND_MAJOR_PRICE_TIMES_100__";

  const bodies = [
    buildFindProductsBody(config),
    buildPreviewQuoteBody(selection),
  ];

  if (flags.createOrder) {
    bodies.push(buildCreateOrderBody(selection, quoteId, majorPrice));
  }

  if (flags.charge) {
    bodies.push(buildSubmitPaymentBody(orderId, quoteId, expectedMinor, config.currency, { type: config.paymentHandlerType, id: config.paymentHandlerId }));
  }

  return bodies;
}

function printDryRun(config, flags) {
  const bodies = buildDryRunBodies(config, flags);

  console.log("DRY RUN: no network calls will be made.");
  console.log("Request bodies for enabled steps. Placeholder strings mark values normally supplied by earlier live responses.");
  for (const body of bodies) {
    console.log("");
    console.log(`${body.operation}:`);
    console.log(safeStringify(redactValue(body)));
  }

  return bodies;
}

async function confirmCharge(config) {
  console.error("");
  console.error("!!! WARNING: --charge can move REAL money unless the backend and PSP are in test mode.");
  console.error("!!! This script does not call Stripe. After submit_payment, verify the returned PSP ID and amount in the Stripe dashboard.");

  // Non-interactive (CI): validateSafety already required PROBE_CHARGE_CONFIRM=yes. Log loudly and proceed.
  if (!process.stdin.isTTY) {
    console.error("!!! Non-interactive run: proceeding because PROBE_CHARGE_CONFIRM=yes (intended for TEST mode).");
    return;
  }

  console.error("!!! Type exactly \"yes\" to send submit_payment.");
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Send submit_payment now? ");
    if (answer.trim() !== "yes") {
      throw new UsageError("Charge confirmation was not exactly \"yes\". No submit_payment call was sent.");
    }
  } finally {
    rl.close();
  }
}

function printResults(results) {
  console.log("");
  console.log("Results to send back");
  console.log("");
  console.log(`Which backend serves prod?   ${results.backend_detection.label}  (${results.backend_detection.evidence})`);
  console.log(`Step2  pricing.total      = ${describeWithType(results.step2.pricing_total)}   (${results.step2.pricing_total_classification || "not classified"})`);
  console.log(`Step3  amounts.total      = ${results.step3.not_attempted ? "not attempted" : `${describeWithType(results.step3.amounts_total)}   (${results.step3.amounts_total_classification})`}`);
  console.log(`Step3  amounts.currency   = ${results.step3.not_attempted ? "not attempted" : `${describeValue(results.step3.amounts_currency)}   (${currencyPresence(results.step3.amounts_currency)})`}`);
  console.log(`Step4  payment_status     = ${results.step4.not_attempted ? "not attempted" : describeValue(results.step4.payment_status)}   confirmation_owner = ${results.step4.not_attempted ? "not attempted" : describeValue(results.step4.confirmation_owner)}  requires_client_confirmation = ${results.step4.not_attempted ? "not attempted" : describeValue(results.step4.requires_client_confirmation)}`);
  console.log(`Step4  psp/provider       = ${results.step4.not_attempted ? "not attempted" : describeValue(results.step4.psp)}   payment_id = ${results.step4.not_attempted ? "not attempted" : describeValue(results.step4.payment_id)}   pspReference = ${results.step4.not_attempted ? "not attempted" : describeValue(results.step4.psp_reference)}`);
  console.log(`Step4  payment_intent_id  = ${results.step4.not_attempted ? "not attempted" : describeValue(results.step4.payment_intent_id)}   checkout_session_id = ${results.step4.not_attempted ? "not attempted" : describeValue(results.step4.checkout_session_id)}`);
  console.log(`Step4  repeat_submit      = ${results.step4.not_attempted ? "not attempted" : describeValue(results.step4.repeat_submit)}`);
  console.log(`Step4  the wire field carrying the amount to the PSP, and its unit = ${results.step4.not_attempted ? "not attempted" : results.step4.payment_wire_amount_summary}`);
  console.log(`Step5  Stripe charged     = ${results.step5.stripe_charged}   currency = ${results.step5.currency}   (== intended amount ? ${results.step5.equals_intended})`);
  console.log(`Refunded/voided?           = ${results.step5.refunded_or_voided}`);
  console.log("");
  console.log(`Reference order-total (major) = ${describeValue(results.evaluation.reference_major)}  source = ${results.evaluation.reference_source || "unknown"}  trusted = ${results.evaluation.reference_trusted === undefined ? "n/a" : results.evaluation.reference_trusted}`);
  if (results.evaluation.warning) {
    console.log(`WARNING: ${results.evaluation.warning}`);
  }
  console.log(`VERDICT: ${results.evaluation.verdict}`);
  console.log(`What this means for our code: ${results.evaluation.codeMeaning}`);
}

function currencyPresence(currency) {
  if (!currency) {
    return "absent";
  }
  return currency === currency.toUpperCase() ? "present, uppercase" : "present";
}

function redactValue(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(child, seen);
    }
  }

  return out;
}

function isSecretKey(key) {
  return /(authorization|api[-_]?key|client[-_]?secret|secret|ap2[-_]?state|acp[-_]?state|access[-_]?token|refresh[-_]?token|id[-_]?token|(^|[-_])token($|[-_])|password|credential)/i.test(key);
}

function redactString(value) {
  let out = String(value);
  const probeKey = process.env.PROBE_KEY;
  if (probeKey) {
    out = out.split(probeKey).join(REDACTED);
  }

  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  out = out.replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]+/g, REDACTED);
  out = out.replace(/\b[A-Za-z0-9_-]+_secret_[A-Za-z0-9_-]+\b/g, REDACTED);
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED);
  out = out.replace(/([?&](?:client_secret|api_key|key|token|secret)=)[^&\s"']+/gi, `$1${REDACTED}`);
  out = out.replace(/(["']?(?:authorization|api[-_]?key|client[-_]?secret|secret|ap2[-_]?state|acp[-_]?state|access[-_]?token|refresh[-_]?token|id[-_]?token|password|credential)["']?\s*[:=]\s*)(["'][^"']*["']|\{[^}]*\}|\[[^\]]*\]|[^\s,}]+)/gi, `$1${REDACTED}`);
  return out;
}

function safeStringify(value) {
  return JSON.stringify(value, null, 2);
}

function printJsonResults(results) {
  console.log("");
  console.log("JSON_RESULTS:");
  console.log(safeStringify(redactValue(results)));
}

function fail(error, includeUsage = false) {
  if (error instanceof UsageError) {
    console.error(`ERROR: ${error.message}`);
    if (includeUsage) {
      console.error("");
      console.error(usageText());
    }
    process.exitCode = 1;
    return;
  }

  if (error instanceof ProbeError) {
    console.error(`ERROR: ${error.message}`);
    console.error(safeStringify(redactValue(error.details)));
    process.exitCode = 1;
    return;
  }

  console.error("ERROR: Unexpected failure");
  console.error(safeStringify(redactValue({ message: error && error.message ? error.message : String(error) })));
  process.exitCode = 1;
}

async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error, true);
    return;
  }

  if (flags.help) {
    console.log(usageText());
    return;
  }

  let config;
  try {
    config = loadConfig();
    validateSafety(flags, config);
  } catch (error) {
    fail(error, true);
    return;
  }

  if (flags.dryRun) {
    const bodies = printDryRun(config, flags);
    if (flags.json) {
      console.log("");
      console.log("JSON_RESULTS:");
      console.log(safeStringify(redactValue({
        dry_run: true,
        network_calls_made: 0,
        enabled_operations: bodies.map((body) => body.operation),
        request_bodies: bodies,
      })));
    }
    return;
  }

  if (typeof fetch !== "function") {
    fail(new UsageError("Global fetch is unavailable. Use Node 18 or newer."));
    return;
  }

  const results = makeInitialResults(flags);
  const responses = {};

  try {
    console.log("Step1 find_products: sending read-only request.");
    const findProductsBody = buildFindProductsBody(config);
    const findResponse = await invoke(findProductsBody, config);
    responses.step1 = findResponse;

    const products = safeProducts(findResponse);
    const candidates = buildCandidates(products, config);
    if (candidates.length === 0) {
      throw new ProbeError("Unable to determine product_id and merchant_id from find_products response or env overrides", {
        operation: "find_products",
        products_seen: products.length,
      });
    }

    results.step1 = { products_seen: products.length, candidates_available: candidates.length };

    // Step2: a live catalog can contain stale products whose variant no longer prices (e.g. Shopify
    // SHOPIFY_PRICING_UNAVAILABLE / "variant not found"). Try candidates in order until one returns a real
    // quote, instead of failing on the first stale item. A pinned PROBE_PRODUCT_ID yields a single candidate.
    console.log(`Step2 preview_quote: trying up to ${candidates.length} candidate(s) until one prices.`);
    let selection;
    let quoteResponse;
    let selectedVariantId;
    const quoteFailures = [];
    for (const cand of candidates) {
      try {
        // preview_quote needs a variant_id, but find_products does NOT return one — resolve it via
        // get_product_detail (or the PROBE_VARIANT_ID override). Without it the backend can't map the
        // product to a Shopify variant and returns "variant not found".
        let variantId = config.variantId;
        if (!variantId) {
          try {
            variantId = extractVariantId(await invoke(buildProductDetailBody(cand), config));
          } catch (e) { /* fall through; try preview_quote anyway */ }
        }
        const resp = await invoke(buildPreviewQuoteBody(cand, variantId), config);
        const qi = quoteInfo(resp);
        if (!qi.quoteId && qi.pricingTotal === undefined) {
          quoteFailures.push({ product_id: cand.productId, variant_id_present: Boolean(variantId), reason: "no_quote_id_or_pricing" });
          continue;
        }
        selection = cand;
        selectedVariantId = variantId;
        quoteResponse = resp;
        break;
      } catch (err) {
        if (err instanceof ProbeError) {
          quoteFailures.push({ product_id: cand.productId, status: err.details?.status, code: err.details?.body?.error?.code || err.details?.body?.error?.message });
          continue;
        }
        throw err;
      }
    }
    if (!quoteResponse) {
      throw new ProbeError("All candidate products failed to preview_quote — the live catalog is likely stale (variants not purchasable). The gateway + auth WORK (find_products succeeded), so this is a catalog/data issue, NOT a probe or money-units issue.", {
        operation: "preview_quote",
        candidates_tried: candidates.length,
        failures: quoteFailures,
        hint: "Pin a known-purchasable PROBE_PRODUCT_ID + PROBE_MERCHANT_ID, or resync the store's products, then re-run.",
      });
    }
    results.step1.quote_candidate_failures = quoteFailures.length;
    responses.step2 = quoteResponse;

    const qInfo = quoteInfo(quoteResponse);
    // Reference for unit classification = the ORDER TOTAL from the quote's pricing.total (a known
    // major-unit decimal like "95.00"), NOT the product unit price: with tax/shipping/discounts the unit
    // price != the order total, and create_order.amounts.total must match the QUOTE TOTAL — which is exactly
    // what the kernel cross-check compares. Fall back to the product price only if the quote total is absent.
    const quoteTotalMajor = parseMoneyValue(qInfo.pricingTotal);
    const referenceMajor = quoteTotalMajor ?? selection.price ?? extractMajorPriceFromQuote(quoteResponse);
    const referenceSource = quoteTotalMajor !== undefined ? "preview_quote.pricing.total"
      : selection.price !== undefined ? "find_products.price (FALLBACK — may exclude tax/shipping)"
      : referenceMajor !== undefined ? "preview_quote.pricing (fallback)" : "unknown";
    // The classification is only trustworthy if the reference's OWN unit is self-evidently major. A quote
    // total as a decimal string is known-major; a bare integer is not. Warn so the operator can re-run
    // against a fractionally-priced item rather than trust a possibly-wrong verdict.
    const referenceTrusted = classifyByFormat(qInfo.pricingTotal).startsWith("MAJOR")
      || (quoteTotalMajor === undefined && typeof selection.price === "number" && !Number.isInteger(selection.price));
    const expectedMinor = expectedMinorFromMajor(referenceMajor);

    results.step2 = {
      quote_id_present: Boolean(qInfo.quoteId),
      pricing_total: qInfo.pricingTotal,
      pricing_total_type: jsType(qInfo.pricingTotal),
      pricing_total_classification: classifyByFormat(qInfo.pricingTotal),
      currency: qInfo.currency,
    };

    results.evaluation.reference_major = referenceMajor;
    results.evaluation.reference_source = referenceSource;
    results.evaluation.reference_trusted = referenceTrusted;
    results.evaluation.expected_minor = expectedMinor;
    if (!referenceTrusted) {
      results.evaluation.warning = "Reference order-total unit is NOT self-evidently major (quote pricing.total was not a decimal string). The MINOR/MAJOR verdict may be unreliable — re-run against an item whose quote total has cents (e.g. $0.99), or set PROBE_PRODUCT_ID to one.";
    }

    let orderId;
    let orderCurrency = qInfo.currency || selection.currency || config.currency;
    // Per-unit price for the create_order REQUEST body (not the classification reference).
    const unitPriceForBody = selection.price ?? referenceMajor;

    if (flags.createOrder) {
      if (!qInfo.quoteId) {
        throw new ProbeError("preview_quote did not return a quote_id; refusing to create_order", {
          operation: "preview_quote",
          quote_id_present: false,
        });
      }

      if (typeof referenceMajor !== "number" || !Number.isFinite(referenceMajor)) {
        throw new ProbeError("Unable to determine a major-unit reference total from preview_quote or find_products; refusing to create_order", {
          operation: "create_order",
          product_price_present: selection.price !== undefined,
          quote_pricing_total_present: qInfo.pricingTotal !== undefined,
        });
      }

      console.log("Step3 create_order: sending backend write with no charge.");
      const createBody = buildCreateOrderBody(selection, qInfo.quoteId, unitPriceForBody, selectedVariantId);
      const orderResponse = await invoke(createBody, config);
      responses.step3 = orderResponse;

      const oInfo = orderInfo(orderResponse);
      orderId = oInfo.orderId;
      orderCurrency = oInfo.currency || orderCurrency;
      const orderClass = classifyAmount(oInfo.total, referenceMajor);

      results.step3 = {
        order_id_present: Boolean(orderId),
        amounts_total: oInfo.total,
        amounts_total_type: jsType(oInfo.total),
        amounts_total_classification: orderClass,
        amounts_currency: oInfo.currencyRaw,
      };

      if (flags.charge) {
        if (!orderId) {
          throw new ProbeError("create_order did not return order_id; refusing to submit_payment", {
            operation: "create_order",
            order_id_present: false,
          });
        }

        if (typeof expectedMinor !== "number" || !Number.isFinite(expectedMinor)) {
          throw new ProbeError("Unable to compute expected minor-unit amount; refusing to submit_payment", {
            operation: "submit_payment",
            reference_major_present: typeof referenceMajor === "number" && Number.isFinite(referenceMajor),
          });
        }

        await confirmCharge(config);

        console.log("Step4 submit_payment: sending charge request.");
        const submitBody = buildSubmitPaymentBody(orderId, qInfo.quoteId, expectedMinor, orderCurrency || config.currency, { type: config.paymentHandlerType, id: config.paymentHandlerId });
        const paymentResponse = await invoke(submitBody, config);
        responses.step4 = paymentResponse;

        const pInfo = paymentInfo(paymentResponse);
        const echoed = pInfo.echoedAmount;
        const wireField = echoed?.field || "payment.expected_amount (request)";
        const wireValue = echoed?.value ?? expectedMinor;
        const wireClass = classifyAmount(wireValue, referenceMajor);
        const wireSummary = `${wireField} = ${describeWithType(wireValue)} (${wireClass}${echoed ? "" : "; no response echo found"})`;

        results.step4 = {
          status: pInfo.status,
          payment_status: pInfo.paymentStatus,
          psp: pInfo.psp,
          payment_id: pInfo.paymentId,
          psp_reference: pInfo.pspReference,
          confirmation_owner: pInfo.confirmationOwner,
          requires_client_confirmation: pInfo.requiresClientConfirmation,
          payment_intent_id: pInfo.paymentIntentId,
          checkout_session_id: pInfo.checkoutSessionId,
          payment_wire_amount_field: wireField,
          payment_wire_amount: wireValue,
          payment_wire_amount_type: jsType(wireValue),
          payment_wire_amount_classification: wireClass,
          payment_wire_amount_summary: wireSummary,
          repeat_submit: { attempted: false },
          stripe_dashboard_instruction: "Verify the returned payment_intent_id/checkout_session_id amount in the Stripe dashboard; this script does not call Stripe.",
        };

        if (config.repeatSubmit) {
          console.log("Step4 repeat_submit: re-sending the same submit_payment body once for B3 idempotency observation.");
          const repeatResponse = await invoke(submitBody, config);
          responses.step4_repeat = repeatResponse;
          const repeatInfo = paymentInfo(repeatResponse);
          const firstIdentity = paymentIdentity(pInfo);
          const repeatIdentity = paymentIdentity(repeatInfo);
          results.step4.repeat_submit = {
            attempted: true,
            status: repeatInfo.status,
            payment_status: repeatInfo.paymentStatus,
            psp: repeatInfo.psp,
            payment_id: repeatInfo.paymentId,
            payment_intent_id: repeatInfo.paymentIntentId,
            checkout_session_id: repeatInfo.checkoutSessionId,
            psp_reference: repeatInfo.pspReference,
            first_identity: firstIdentity,
            repeat_identity: repeatIdentity,
            same_payment_identity: Boolean(firstIdentity && repeatIdentity && firstIdentity === repeatIdentity),
          };
        }

        console.log("");
        console.log("Stripe dashboard verification required:");
        console.log(`- payment_intent_id: ${describeValue(pInfo.paymentIntentId)}`);
        console.log(`- checkout_session_id: ${describeValue(pInfo.checkoutSessionId)}`);
        console.log("- Verify the dashboard amount equals the intended amount for the selected item and currency.");
      }
    }

    results.backend_detection = detectBackend(responses);
    Object.assign(results.evaluation, computeVerdict(results));

    printResults(results);
    if (flags.json) {
      printJsonResults(results);
    }
  } catch (error) {
    fail(error);
  }
}

main();
