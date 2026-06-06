import { randomUUID } from "node:crypto";

import { getAllowedOperations } from "./operationMap.js";

const IDEMPOTENT_WRITE_OPERATIONS = new Set([
  "create_order",
  "submit_payment",
  "request_after_sales"
]);

const REDACTED = "[REDACTED]";
// Codex Minor P2: canonicalize keys (drop non-alphanumerics + lowercase) so snake_case AND camelCase
// forms collapse to the same token — ap2_state / ap2State, confirmation_token / confirmationToken,
// access_token / accessToken all match.
const SENSITIVE_VALUE_KEYS = new Set([
  "ap2state",
  "confirmationtoken",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "paymenttoken",
  "mandatetoken",
  "cardtoken",
  "token",
  "pan",
  "cvv",
  "cvc"
]);

// Codex Substantive P1-1: a Luhn-shaped PAN inside a free-text upstream error body must be masked.
const PAN_RE = /\b(?:\d[ -]*?){13,19}\b/g;
function canonicalKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export class ToolValidationError extends Error {
  constructor(message, code = "TOOL_VALIDATION_ERROR") {
    super(message);
    this.name = "ToolValidationError";
    this.code = code;
  }
}

export function assertAllowedOperation(toolName, operation) {
  const allowed = getAllowedOperations(toolName);

  if (!allowed) {
    throw new ToolValidationError(
      `Unknown Pivota tool "${toolName}".`,
      "UNKNOWN_TOOL"
    );
  }

  if (!allowed.includes(operation)) {
    throw new ToolValidationError(
      `Operation "${operation}" is not allowed for tool "${toolName}". Allowed operations: ${allowed.join(", ")}.`,
      "OPERATION_NOT_ALLOWED"
    );
  }
}

export function requiresIdempotency(operation) {
  return IDEMPOTENT_WRITE_OPERATIONS.has(operation);
}

export function prepareToolCall(
  toolName,
  args,
  { idempotencyKeyFactory = randomUUID } = {}
) {
  if (!isPlainObject(args)) {
    throw new ToolValidationError(
      "Tool arguments must be an object.",
      "INVALID_ARGUMENTS"
    );
  }

  const { operation } = args;
  if (typeof operation !== "string" || operation.length === 0) {
    throw new ToolValidationError(
      "Tool arguments must include a non-empty operation string.",
      "OPERATION_REQUIRED"
    );
  }

  assertAllowedOperation(toolName, operation);

  const payload = clonePlainObject(args.payload ?? {});
  validateInvariantShape(operation, payload);

  const { payload: payloadWithIdempotency, idempotencyKey, generated } =
    ensureIdempotency(operation, payload, idempotencyKeyFactory);

  return {
    operation,
    payload: payloadWithIdempotency,
    idempotencyKey,
    idempotencyKeyGenerated: generated
  };
}

export function ensureIdempotency(
  operation,
  payload,
  idempotencyKeyFactory = randomUUID
) {
  if (!requiresIdempotency(operation)) {
    return { payload, idempotencyKey: undefined, generated: false };
  }

  const existing = payload.idempotency_key;
  if (existing === undefined || existing === null) {
    if (idempotencyKeyFactory !== randomUUID) {
      const generated = idempotencyKeyFactory();
      if (typeof generated !== "string" || generated.trim().length < 8) {
        throw new ToolValidationError(
          "idempotency_key must be a string of at least 8 characters for write operations.",
          "INVALID_IDEMPOTENCY_KEY"
        );
      }

      const nextPayload = { ...payload, idempotency_key: generated };
      return { payload: nextPayload, idempotencyKey: generated, generated: true };
    }

    throw new ToolValidationError(
      "idempotency_key is required for write operations.",
      "IDEMPOTENCY_KEY_REQUIRED"
    );
  }

  if (typeof existing === "string" && existing.trim().length === 0) {
    throw new ToolValidationError(
      "idempotency_key is required for write operations.",
      "IDEMPOTENCY_KEY_REQUIRED"
    );
  }

  if (typeof existing !== "string" || existing.trim().length < 8) {
    throw new ToolValidationError(
      "idempotency_key must be a string of at least 8 characters for write operations.",
      "INVALID_IDEMPOTENCY_KEY"
    );
  }

  return { payload, idempotencyKey: existing, generated: false };
}

export function validateInvariantShape(operation, payload) {
  if (!isPlainObject(payload)) {
    throw new ToolValidationError(
      "Tool payload must be an object.",
      "INVALID_PAYLOAD"
    );
  }

  if (operation === "create_order") {
    if (!isPlainObject(payload.order)) {
      throw new ToolValidationError(
        "create_order requires payload.order.",
        "ORDER_REQUIRED"
      );
    }

    if (!hasNonEmptyString(payload.order.quote_id)) {
      throw new ToolValidationError(
        "create_order requires order.quote_id from a locked quote.",
        "QUOTE_ID_REQUIRED"
      );
    }
  }

  if (operation === "submit_payment") {
    if (!hasNonEmptyString(payload.confirmation_token)) {
      throw new ToolValidationError(
        "submit_payment requires confirmation_token minted by the host UI / Safety Kernel.",
        "CONFIRMATION_TOKEN_REQUIRED"
      );
    }

    if (!isPlainObject(payload.payment)) {
      throw new ToolValidationError(
        "submit_payment requires payload.payment.",
        "PAYMENT_REQUIRED"
      );
    }

    if (!hasNonEmptyString(payload.payment.order_id)) {
      throw new ToolValidationError(
        "submit_payment requires payment.order_id.",
        "PAYMENT_ORDER_ID_REQUIRED"
      );
    }
  }

  if (operation === "request_after_sales") {
    if (!isPlainObject(payload.status)) {
      throw new ToolValidationError(
        "request_after_sales requires payload.status.",
        "STATUS_REQUIRED"
      );
    }

    if (!hasNonEmptyString(payload.status.order_id)) {
      throw new ToolValidationError(
        "request_after_sales requires status.order_id.",
        "STATUS_ORDER_ID_REQUIRED"
      );
    }
  }
}

export function redact(value) {
  return redactValue(value, new WeakSet());
}

function redactValue(value, seen) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  // Codex P1-1: scrub PAN-shaped digit runs from any string (e.g. a raw/{raw} upstream error body).
  if (typeof value === "string") {
    return value.replace(PAN_RE, "[REDACTED_PAN]");
  }

  if (!isObjectLike(value)) {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = canonicalKey(key);

    if (normalizedKey === "payment") {
      output[key] = "[REDACTED_PAYMENT_BODY]";
      continue;
    }

    if (
      SENSITIVE_VALUE_KEYS.has(normalizedKey) ||
      normalizedKey.endsWith("token") ||
      normalizedKey.includes("paymenttoken")
    ) {
      output[key] = REDACTED;
      continue;
    }

    output[key] = redactValue(item, seen);
  }

  return output;
}

function clonePlainObject(value) {
  if (!isPlainObject(value)) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}

function isPlainObject(value) {
  if (!isObjectLike(value) || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
