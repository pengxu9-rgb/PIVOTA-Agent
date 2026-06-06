import { createHash } from "node:crypto";

export const WRITE_OPERATIONS = new Set([
  "create_order",
  "submit_payment",
  "request_after_sales"
]);

export class UserRefError extends Error {
  constructor(message, code = "USER_REF_ERROR") {
    super(message);
    this.name = "UserRefError";
    this.code = code;
  }
}

export function deriveUserRef(claims) {
  if (!isPlainObject(claims)) {
    throw new UserRefError("Verified OAuth claims are required.", "CLAIMS_REQUIRED");
  }

  const { iss, sub } = claims;
  if (!hasNonEmptyString(iss) || !hasNonEmptyString(sub)) {
    throw new UserRefError(
      "Verified OAuth claims must include non-empty iss and sub.",
      "CLAIMS_MISSING_SUBJECT"
    );
  }

  const digest = createHash("sha256")
    .update(`${iss}|${sub}`, "utf8")
    .digest("base64url")
    .slice(0, 32);

  return `usr_${digest}`;
}

export function attachUserRef(envelope, user_ref) {
  if (!isPlainObject(envelope)) {
    throw new UserRefError("Canonical envelope is required.", "ENVELOPE_REQUIRED");
  }

  const { operation } = envelope;
  if (!hasNonEmptyString(operation)) {
    throw new UserRefError(
      "Canonical envelope must include a non-empty operation.",
      "OPERATION_REQUIRED"
    );
  }

  const sourcePayload = envelope.payload ?? {};
  if (!isPlainObject(sourcePayload)) {
    throw new UserRefError(
      "Canonical envelope payload must be an object.",
      "PAYLOAD_REQUIRED"
    );
  }

  const normalizedUserRef = normalizeUserRef(user_ref);
  if (!normalizedUserRef && WRITE_OPERATIONS.has(operation)) {
    throw new UserRefError(
      "user_ref is required for write operations.",
      "USER_REF_REQUIRED"
    );
  }

  const { user_ref: _untrustedUserRef, ...payload } = sourcePayload;
  if (normalizedUserRef) {
    payload.user_ref = normalizedUserRef;
  }

  return { operation, payload };
}

function normalizeUserRef(user_ref) {
  if (typeof user_ref !== "string") {
    return "";
  }

  return user_ref.trim();
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
