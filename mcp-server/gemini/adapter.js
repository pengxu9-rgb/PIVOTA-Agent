import { buildSecureEnvelope } from "../src/secureInvoke.js";

// Codex P1-3 fix: Gemini now routes through the SAME secure boundary as the MCP server
// (buildSecureEnvelope): op-allowlist + idempotency presence (no minting) + trusted-identity
// attachment + the kernel's validateCanonical strict check — one choke point for every adapter.
export function geminiCallToInvoke(
  functionCall,
  { deriveUserRefFromClaims, claims, user_ref, userRef } = {}
) {
  const { name, args } = normalizeFunctionCall(functionCall);
  // Resolve trusted identity from server-verified context only (never from the model's args).
  // Direct user_ref/userRef is a server-only escape hatch and must already be a derived usr_ ref.
  const identity = resolveIdentity({ deriveUserRefFromClaims, claims, user_ref, userRef, functionCall });
  const envelope = buildSecureEnvelope(name, args, identity);
  return { operation: envelope.operation, payload: envelope.payload };
}

export function invokeResultToGeminiResponse(toolName, result) {
  if (typeof toolName !== "string" || toolName.length === 0) {
    throw new TypeError("toolName must be a non-empty string.");
  }

  return {
    functionResponse: {
      name: toolName,
      response: responseObject(result)
    }
  };
}

export async function geminiCallToCommerceTool(functionCall, surface, sessionContext = {}) {
  if (!surface || typeof surface.callTool !== "function") {
    throw new TypeError("Gemini commerce adapter requires a canonical commerce surface.");
  }
  const { name, args } = normalizeFunctionCall(functionCall);
  const result = await surface.callTool(name, args, sessionContext);
  return invokeResultToGeminiResponse(name, result);
}

function normalizeFunctionCall(functionCall) {
  const call = functionCall?.functionCall ?? functionCall;

  if (!isPlainObject(call)) {
    throw new TypeError("Gemini functionCall must be an object.");
  }

  const { name, args = {} } = call;
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("Gemini functionCall.name must be a non-empty string.");
  }

  return {
    name,
    args: parseArgs(args)
  };
}

function parseArgs(args) {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch (error) {
      throw new TypeError("Gemini functionCall.args must be an object or JSON object string.");
    }
  }

  return args;
}

// Returns an identity context for buildSecureEnvelope: { user_ref } or { claims } (or {}).
// Identity must come from server-verified context; the model's args are never consulted here.
function resolveIdentity({ deriveUserRefFromClaims, claims, user_ref, userRef, functionCall }) {
  // Codex P1: verified claims ALWAYS take precedence. A direct user_ref is a server-only escape hatch
  // used ONLY when no claims are available — otherwise a host that accidentally forwards a
  // model-shaped `usr_...` value alongside real claims could inject identity. Claims first.
  const verifiedClaims = claims ?? resolveClaims(deriveUserRefFromClaims, { functionCall });
  if (isPlainObject(verifiedClaims)) {
    return { claims: verifiedClaims };
  }
  if (typeof verifiedClaims === "string") {
    return { user_ref: verifiedClaims };
  }
  // No claims → fall back to a direct user_ref, but only if it is a server-derived usr_ ref.
  const directUserRef = firstString(user_ref, userRef);
  if (directUserRef && isDerivedUserRef(directUserRef)) {
    return { user_ref: directUserRef.trim() };
  }
  if (directUserRef) {
    throw new TypeError("Gemini direct user_ref/userRef must be a server-derived usr_ reference.");
  }
  return {};
}

function resolveClaims(deriveUserRefFromClaims, context) {
  if (typeof deriveUserRefFromClaims === "function") {
    return deriveUserRefFromClaims(context);
  }

  return deriveUserRefFromClaims;
}

function responseObject(result) {
  if (isPlainObject(result)) {
    return result;
  }

  return { result };
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function isDerivedUserRef(value) {
  return /^usr_[A-Za-z0-9_-]+$/.test(value.trim());
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
