#!/usr/bin/env node
/*
 * Verify B4: after a Stripe TEST PaymentIntent is completed and the webhook fires,
 * the order eventually finalizes to paid through the gateway's order-status operation.
 *
 * Env vars:
 * - PROBE_BASE        Required. Gateway base URL, for example http://localhost:8787.
 * - PROBE_KEY         Required. Auth bearer/API key. Read only, never printed.
 * - ORDER_ID          Required. Order id returned by create_order / probe_wire_format.
 * - PROBE_AUTH_HEADER Optional. Auth header name. Default "Authorization" (Bearer).
 * - POLL_SECONDS      Optional. Total polling window. Default 90.
 * - POLL_INTERVAL     Optional. Seconds between polls. Default 5.
 *
 * This script only calls POST {PROBE_BASE}/agent/shop/v1/invoke with
 * { operation: "get_order_status", payload: { status: { order_id } } }.
 * It never prints PROBE_KEY, Authorization, client_secret, acp_state, ap2_state,
 * or secret-looking values.
 */

const INVOKE_PATH = "/agent/shop/v1/invoke";
const ORDER_STATUS_OPERATION = "get_order_status";
const REDACTED = "[REDACTED]";

// From src/server.js normalizeSubmitPaymentStatus(): completed/succeeded/success/settled
// canonicalize to paid; paid is the terminal value B4 expects after webhook finalization.
const PAID_STATUS_VALUES = new Set(["paid", "completed", "succeeded", "success", "settled"]);

class B4Error extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "B4Error";
    this.details = details;
  }
}

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function loadConfig() {
  return {
    base: mustEnv("PROBE_BASE"),
    key: mustEnv("PROBE_KEY"),
    orderId: mustEnv("ORDER_ID"),
    authHeader: optionalEnv("PROBE_AUTH_HEADER") || "Authorization",
    pollSeconds: parsePositiveSeconds(optionalEnv("POLL_SECONDS"), 90, "POLL_SECONDS"),
    pollInterval: parsePositiveSeconds(optionalEnv("POLL_INTERVAL"), 5, "POLL_INTERVAL"),
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

function parsePositiveSeconds(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${name} must be a positive number of seconds`);
  }
  return parsed;
}

function buildInvokeUrl(base) {
  return `${base.replace(/\/+$/, "")}${INVOKE_PATH}`;
}

function buildAuthHeaders(config) {
  if (config.authHeader.toLowerCase() === "authorization") {
    const value = /^(Bearer|ApiKey|Basic)\s+/i.test(config.key) ? config.key : `Bearer ${config.key}`;
    return { Authorization: value };
  }
  return { [config.authHeader]: config.key };
}

function buildStatusBody(orderId) {
  return {
    operation: ORDER_STATUS_OPERATION,
    payload: {
      status: {
        order_id: orderId,
      },
    },
  };
}

async function invokeOrderStatus(config) {
  const body = buildStatusBody(config.orderId);
  let response;

  try {
    response = await fetch(buildInvokeUrl(config.base), {
      method: "POST",
      headers: {
        ...buildAuthHeaders(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new B4Error("Network error", {
      operation: body.operation,
      message: redactString(error && error.message ? error.message : String(error)),
    });
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new B4Error("JSON parse error", {
      operation: body.operation,
      status: response.status,
      body: redactValue(text),
      parse_error: redactString(error && error.message ? error.message : String(error)),
    });
  }

  if (!response.ok) {
    throw new B4Error("HTTP non-2xx response", {
      operation: body.operation,
      status: response.status,
      body: redactValue(parsed),
    });
  }

  return parsed;
}

function extractStatusSummary(response) {
  const paymentStatus = firstNonEmptyString(
    response?.payment_status,
    response?.paymentStatus,
    response?.payment?.payment_status,
    response?.payment?.paymentStatus,
    response?.order?.payment_status,
    response?.order?.paymentStatus,
  );
  const orderStatus = firstNonEmptyString(
    response?.status,
    response?.tracking?.status,
    response?.order?.status,
  );
  const paidCandidate = firstNonEmptyString(paymentStatus, orderStatus);

  return {
    orderId: firstNonEmptyString(
      response?.order_id,
      response?.orderId,
      response?.order?.order_id,
      response?.order?.orderId,
    ),
    paymentStatus,
    orderStatus,
    paidCandidate,
    psp: firstNonEmptyString(
      response?.psp,
      response?.payment?.psp,
      response?.order?.payment_summary?.psp,
      response?.order?.payment?.psp,
    ),
    paymentIntentId: firstNonEmptyString(
      response?.payment_intent_id,
      response?.paymentIntentId,
      response?.payment?.payment_intent_id,
      response?.payment?.paymentIntentId,
      response?.payment?.id,
    ),
    pspReference: firstNonEmptyString(
      response?.pspReference,
      response?.psp_reference,
      response?.payment?.pspReference,
      response?.payment?.psp_reference,
    ),
  };
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const token = String(value).trim();
    if (token) return token;
  }
  return "";
}

function isPaidStatus(value) {
  return PAID_STATUS_VALUES.has(String(value || "").trim().toLowerCase());
}

function describeStatus(summary) {
  const statusParts = [];
  if (summary.paymentStatus) statusParts.push(`payment_status=${summary.paymentStatus}`);
  if (summary.orderStatus) statusParts.push(`status=${summary.orderStatus}`);
  return statusParts.length ? statusParts.join(" ") : "status=<missing>";
}

function formatPollLine(summary, config) {
  const printable = {
    order_id: summary.orderId || config.orderId,
    payment_status: summary.paymentStatus || null,
    status: summary.orderStatus || null,
    psp: summary.psp || null,
    payment_intent_id: summary.paymentIntentId || null,
    pspReference: summary.pspReference || null,
  };
  return `B4 poll ${safeStringify(redactValue(printable))}`;
}

function redactValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : redactValue(child, seen);
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
  return JSON.stringify(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilPaid(config) {
  const deadline = Date.now() + config.pollSeconds * 1000;
  let lastSummary = null;

  while (true) {
    const response = await invokeOrderStatus(config);
    lastSummary = extractStatusSummary(response);
    console.log(formatPollLine(lastSummary, config));

    if (isPaidStatus(lastSummary.paidCandidate)) {
      return { paid: true, summary: lastSummary };
    }

    if (Date.now() >= deadline) {
      return { paid: false, summary: lastSummary };
    }

    await sleep(Math.min(config.pollInterval * 1000, Math.max(0, deadline - Date.now())));
  }
}

function printVerdict(result, config) {
  const summary = result.summary || {};
  const orderId = summary.orderId || config.orderId;
  const psp = summary.psp || "unknown";
  const pi = summary.paymentIntentId || summary.pspReference || "unknown";

  if (result.paid) {
    console.log(`VERDICT: B4 PASS — order ${redactString(orderId)} finalized to paid (psp=${redactString(psp)}, pi=${redactString(pi)})`);
    return;
  }

  console.log(`VERDICT: B4 NOT CONFIRMED — last status ${redactString(describeStatus(summary))}`);
}

function fail(error) {
  if (error instanceof UsageError) {
    console.error(`ERROR: ${redactString(error.message)}`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof B4Error) {
    console.error(`ERROR: ${redactString(error.message)}`);
    console.error(safeStringify(redactValue(error.details)));
    process.exitCode = 1;
    return;
  }
  console.error("ERROR: Unexpected failure");
  console.error(safeStringify(redactValue({ message: error && error.message ? error.message : String(error) })));
  process.exitCode = 1;
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    fail(error);
    return;
  }

  try {
    const result = await pollUntilPaid(config);
    printVerdict(result, config);
    process.exitCode = result.paid ? 0 : 2;
  } catch (error) {
    fail(error);
  }
}

main();
