// Fix-Wave A — the single hardened path every adapter (Claude MCP, ChatGPT, Gemini) must use to
// reach the canonical invoke. Consolidates the three things that were missing or inconsistent at
// the adapter boundary:
//
//   X-P0-1  identity binding: derive a TRUSTED user_ref from verified OAuth claims and attach it,
//           stripping any model/caller-supplied payload.user_ref. Writes without trusted identity
//           are refused (USER_AUTH_REQUIRED) BEFORE any upstream call.
//   X-P2-4  strict validation at the boundary: run the kernel's validateCanonical() here so the
//           closed-payload / quote-first / confirmation guarantees hold even though the model-facing
//           Gemini/ChatGPT schemas can't express additionalProperties:false.
//   X-P1-1  (adapter side) a missing idempotency key on a write is rejected, never minted.
//
// This module does NOT duplicate kernel logic — it calls the kernel's own validateCanonical so the
// adapter boundary can never be weaker than the server.

import { prepareToolCall } from "./safety.js";
import { attachUserRef, deriveUserRef, WRITE_OPERATIONS } from "../auth/userRef.js";
import { validateCanonical } from "../../safety-kernel/src/contractValidation.js";
import { invokePivota } from "./invokeClient.js";

export class IdentityRequiredError extends Error {
  constructor(message = "Trusted user_ref is required for this operation.") {
    super(message);
    this.name = "IdentityRequiredError";
    this.code = "USER_AUTH_REQUIRED";
  }
}

/**
 * Resolve a TRUSTED user_ref from server-verified context only. Never from the tool args / model.
 * Accepts either an already-derived `user_ref` (server context) or verified OAuth `claims`.
 * @param {{ user_ref?: string, claims?: object }} identity
 * @returns {string|undefined}
 */
export function resolveTrustedUserRef(identity = {}) {
  if (typeof identity.user_ref === "string" && identity.user_ref.trim()) {
    return identity.user_ref.trim();
  }
  if (identity.claims && typeof identity.claims === "object") {
    return deriveUserRef(identity.claims); // throws if iss/sub missing
  }
  return undefined;
}

/**
 * Build a SAFE canonical envelope from a raw tool call. The single choke point for all adapters.
 *
 * @param {string} toolName  e.g. pivota_create_order
 * @param {object} toolArgs  { operation, payload } from the model
 * @param {{ user_ref?: string, claims?: object }} identity  SERVER-verified identity context
 * @returns {{ operation: string, payload: object, idempotencyKey?: string }}
 */
export function buildSecureEnvelope(toolName, toolArgs, identity = {}) {
  // 1) op-allowlist + idempotency presence (X-P1-1 enforced in safety.js: missing write key throws)
  const prepared = prepareToolCall(toolName, toolArgs);

  // 2) trusted identity (X-P0-1). attachUserRef strips any caller-supplied payload.user_ref and
  //    refuses to attach to a write op when user_ref is absent.
  const trusted = resolveTrustedUserRef(identity);
  if (!trusted && WRITE_OPERATIONS.has(prepared.operation)) {
    throw new IdentityRequiredError();
  }
  const withIdentity = attachUserRef(
    { operation: prepared.operation, payload: prepared.payload },
    trusted
  );

  // 3) strict kernel validation at the boundary (X-P2-4). Throws PivotaCommerceError on violation;
  //    closed payment payload, quote-first, confirmation-token, etc. — same rules as the server.
  validateCanonical(withIdentity.operation, withIdentity.payload);

  return {
    operation: withIdentity.operation,
    payload: withIdentity.payload,
    idempotencyKey: prepared.idempotencyKey
  };
}

/**
 * One-call secure invoke for adapters: build the safe envelope, then POST the canonical rail.
 * @param {string} toolName
 * @param {object} toolArgs
 * @param {{ user_ref?: string, claims?: object }} identity
 * @param {object} [invokeOpts] passthrough to invokePivota (gatewayUrl/agentKey/fetchImpl for tests)
 */
export async function secureInvoke(toolName, toolArgs, identity = {}, invokeOpts = {}) {
  const envelope = buildSecureEnvelope(toolName, toolArgs, identity);
  // Codex P2: whitelist transport-only options. The validated envelope (operation/payload/
  // idempotencyKey) must NEVER be overridable by invokeOpts, or identity+validation could be bypassed.
  const { gatewayUrl, agentKey, fetchImpl } = invokeOpts;
  const transport = {};
  if (gatewayUrl !== undefined) transport.gatewayUrl = gatewayUrl;
  if (agentKey !== undefined) transport.agentKey = agentKey;
  if (fetchImpl !== undefined) transport.fetchImpl = fetchImpl;
  return invokePivota({ ...transport, ...envelope });
}
