// The MCP commerce tool surface — the UCP-aligned set of tools (capabilities ↔ MCP tools 1:1) that an
// agent (Gemini/UCP, or Claude over MCP) calls to discover, quote, and CHECKOUT against Pivota. Every tool
// routes through the ONE canonical executor → kernel, so the safety invariants (quote-first, amount-from-
// quote, host-minted confirmation, idempotency, single-use, charge-once, ownership/T7, cross-user isolation)
// are enforced once and never re-implemented at the adapter.
//
// SECURITY MODEL (the adapter boundary's job):
//   - Identity (user_ref / acp_session_id / agent_id) is taken from the SERVER-VERIFIED session context
//     ONLY, never from the model's tool arguments. Any identity fields a model puts in the args are stripped.
//   - A user-scoped tool with no verified buyer is refused (USER_AUTH_REQUIRED) before the executor runs.
//   - payment_authorization IS a tool argument (the delegated token / mandate the agent obtained), but it is
//     VERIFIED inside the executor (verifyPaymentAuthorization) — never trusted blindly.
//   - Results are sanitized: tokens / ap2_state / client secrets / PANs are scrubbed, while the data the
//     agent legitimately needs (status, requires_action redirect/qr/instructions, ids, amounts) is preserved.

import { CANONICAL_OPERATIONS, canonicalOp } from "../../safety-kernel/src/protocol/canonicalContract.js";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import { sanitizeResult } from "../../safety-kernel/src/protocol/resultSanitizer.js";
import { deriveUserRef } from "../auth/userRef.js";

export class UnknownToolError extends Error {
  constructor(name) {
    super(`Unknown Pivota commerce tool "${name}".`);
    this.name = "UnknownToolError";
    this.code = "UNKNOWN_TOOL";
  }
}

export class IdentityRequiredError extends Error {
  constructor(message = "A verified buyer (sign-in) is required for this operation.") {
    super(message);
    this.name = "IdentityRequiredError";
    this.code = "USER_AUTH_REQUIRED";
  }
}

export class ToolValidationError extends Error {
  constructor(message, code = "INVALID_ARGUMENTS") {
    super(message);
    this.name = "ToolValidationError";
    this.code = code;
  }
}

// Only kernel-backed operations belong on this surface. The 'external' ops (start_identity_linking,
// exchange_payment_token) are edge concerns: identity linking is the OAuth flow (auth/), and the payment
// token/mandate is verified at complete time — neither is routed through the executor's kernel path.
const COMMERCE_OPERATIONS = CANONICAL_OPERATIONS.filter((op) => op.kernel !== "external");
const OP_BY_MCP = Object.freeze(Object.fromEntries(COMMERCE_OPERATIONS.map((op) => [op.mcp, op])));

/**
 * Build the MCP commerce tool surface over an already-composed canonical executor.
 * @param {{ execute: (opId:string, params:object, ctx:object)=>Promise<any> }} executor
 * @param {{ log?: object }} [opts]
 * @returns {{ tools: Array<{name,description,inputSchema}>, callTool: Function, isCommerceTool: Function }}
 */
export function createCommerceToolSurface(executor, { log } = {}) {
  if (!executor || typeof executor.execute !== "function") {
    throw new Error("createCommerceToolSurface requires a canonical executor with execute()");
  }

  const tools = commerceToolDefinitions.map((tool) => ({ ...tool }));

  /**
   * Execute a commerce tool call.
   * @param {string} toolName       the MCP tool name (== canonical op.mcp)
   * @param {object} toolArgs       model-supplied arguments (identity fields are ignored/stripped)
   * @param {object} sessionContext SERVER-VERIFIED identity context: { user_ref } or { claims }, plus an
   *                                optional verified acp_session_id / agent_id.
   * @returns {Promise<object>}     sanitized result; THROWS PivotaCommerceError / IdentityRequiredError /
   *                                UnknownToolError on failure (the MCP server formats these).
   */
  async function callTool(toolName, toolArgs = {}, sessionContext = {}) {
    const op = OP_BY_MCP[toolName];
    if (!op) throw new UnknownToolError(toolName);

    // tool args must be a plain object. Omitted (undefined) → empty; anything else non-object (null, string,
    // number, array) is a malformed call, rejected rather than silently treated as empty.
    if (toolArgs === undefined) toolArgs = {};
    if (!isPlainObject(toolArgs)) {
      throw new ToolValidationError("Tool arguments must be an object.");
    }

    // 1) trusted identity from the verified session ONLY. Identity-derivation errors are swallowed for
    //    read-only ops (anonymous) and surface as USER_AUTH_REQUIRED for user-scoped ops below.
    const ctx = buildContext(sessionContext);

    // 2) a user-scoped op needs BOTH a verified buyer AND a verified session id (the T7 quote↔order linkage
    //    the kernel binds). Refuse early — clean, non-leaky — rather than fabricating a weak session id.
    if (op.requiresUserRef && (!nonEmpty(ctx.user_ref) || !nonEmpty(ctx.acp_session_id))) {
      throw new IdentityRequiredError();
    }

    // 3) build executor params by ALLOWLIST (only the fields this op defines). One move strips identity,
    //    extra money fields (e.g. a model-set refund amount), and prototype-polluting keys.
    const params = toParams(op, toolArgs);

    // 4) the single execution bridge enforces the contract flags + routes to the kernel.
    const result = await executor.execute(op.id, params, ctx);
    // 5) sanitize. A payment redirect (requires_action) is only LEGITIMATE for the checkout flow, so handoff
    //    URLs are preserved verbatim ONLY for checkout ops (PayPal `?token=EC-…`, OAuth `?code=…`, Stripe 3DS
    //    `client_secret` must reach the buyer intact). For discovery/order results a redirect-named field is
    //    NOT a payment handoff and is scrubbed aggressively.
    return sanitizeResult(result, { handoffAllowed: op.capability === "checkout" });
  }

  function isCommerceTool(name) {
    return Object.prototype.hasOwnProperty.call(OP_BY_MCP, name);
  }

  return { tools, callTool, isCommerceTool };
}

// --- identity ---------------------------------------------------------------------------------------------

// Resolve TRUSTED identity from server-verified context. user_ref may be pre-derived or come from verified
// OAuth claims. acp_session_id is the verified per-connection session the kernel binds quote↔order to — it is
// NOT fabricated here (a deterministic per-user fallback would collapse all of a user's sessions and defeat
// T7); the session layer must supply it. Malformed claims do not throw here — they leave user_ref undefined,
// which fails closed for user-scoped ops (USER_AUTH_REQUIRED) while leaving read-only ops anonymous.
function buildContext(sessionContext = {}) {
  let user_ref;
  try {
    if (nonEmpty(sessionContext.user_ref)) user_ref = sessionContext.user_ref.trim();
    else if (isPlainObject(sessionContext.claims)) user_ref = deriveUserRef(sessionContext.claims);
  } catch {
    user_ref = undefined;
  }
  const acp_session_id = nonEmpty(sessionContext.acp_session_id) ? sessionContext.acp_session_id.trim() : undefined;
  const agent_id = nonEmpty(sessionContext.agent_id) ? sessionContext.agent_id.trim() : undefined;

  const ctx = { user_ref, acp_session_id };
  if (agent_id) ctx.agent_id = agent_id;
  return ctx;
}

// --- params mapping (ALLOWLIST) ---------------------------------------------------------------------------
//
// Build a clean, minimal params object per op from ONLY the fields that op defines. This is stronger than
// stripping a denylist: extra money fields (a model-set refund amount), nested identity, and prototype-
// polluting keys (__proto__/constructor) all simply never get copied. Each field is read by OWN-property
// lookup, so a JSON `__proto__` entry cannot inject anything.

const QUOTE_KEYS = ["merchant_id", "discount_codes", "customer_email", "customer_name"];
const ITEM_KEYS = ["product_id", "sku_id", "variant_id", "quantity"];
const ADDR_KEYS = ["country", "city", "postal_code", "state", "address_line1", "address_line2", "name", "recipient_name", "phone"];

function toParams(op, toolArgs) {
  const a = asObj(toolArgs);
  switch (op.id) {
    case "search_catalog":
      return { payload: { search: pick(a, ["query", "merchant_id", "category", "price_min", "price_max", "currency", "in_stock_only", "page", "page_size"]) } };
    case "get_product":
      return {
        payload: {
          product: pick(a, ["merchant_id", "product_id", "sku_id"]),
          ...(Array.isArray(a.include) ? { include: a.include } : {}),
        },
      };
    case "get_alternatives":
      return { payload: pick(a, ["merchant_id", "product_id", "product_ref", "relation", "include_dupes", "market", "max_price_ratio", "limit"]) };
    case "get_offers":
      return { payload: pick(a, ["merchant_id", "product_id", "product_group_id", "currency", "limit"]) };
    case "get_intel":
      return { payload: pick(a, ["merchant_id", "product_id", "product_ref", "pivota_signature_id"]) };
    case "create_checkout_session":
      return { idempotency_key: str(a.idempotency_key), quote: pickQuote(a.quote) };
    case "update_checkout_session":
      return { idempotency_key: str(a.idempotency_key), session_id: str(a.session_id), quote: pickQuote(a.quote) };
    case "get_checkout_session":
      return { session_id: str(a.session_id) };
    case "complete_checkout_session":
      return {
        idempotency_key: str(a.idempotency_key),
        session_id: str(a.session_id),
        // opaque to the kernel — verified downstream by verifyPaymentAuthorization. Safe-cloned so a hostile
        // __proto__/constructor key can't pollute when the verifier inspects it.
        payment_authorization: a.payment_authorization === undefined ? undefined : safeClone(a.payment_authorization),
        shipping_address: pickAddress(a.shipping_address),
      };
    case "create_payment_link":
      return {
        idempotency_key: str(a.idempotency_key),
        session_id: str(a.session_id),
        customer_email: str(a.customer_email),
        shipping_address: pickAddress(a.shipping_address),
        return_url: str(a.return_url),
      };
    case "cancel_checkout_session":
      return { idempotency_key: str(a.idempotency_key), session_id: str(a.session_id), order_id: str(a.order_id) };
    case "get_order":
      return { order_id: str(a.order_id) };
    case "request_after_sales":
      return { idempotency_key: str(a.idempotency_key), status: pick(asObj(a.status), ["order_id", "requested_action", "reason"]) };
    default:
      return {};
  }
}

function pickQuote(q) {
  const src = asObj(q);
  const out = pick(src, QUOTE_KEYS);
  if (Array.isArray(src.items)) out.items = src.items.map((it) => pick(asObj(it), ITEM_KEYS));
  const addr = pickAddress(src.shipping_address);
  if (addr) out.shipping_address = addr;
  return out;
}

function pickAddress(addr) {
  return isPlainObject(addr) ? pick(addr, ADDR_KEYS) : undefined;
}

// Copy ONLY the named own properties; never __proto__/constructor/prototype (defends against pollution).
function pick(src, keys) {
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const k of keys) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

// Deep clone an opaque object, dropping prototype-polluting keys and bounding depth. At the depth cap it
// returns null (NOT the raw subobject) so a hostile __proto__/constructor buried deep cannot pass through.
function safeClone(v, depth = 0) {
  if (v === null || typeof v !== "object") return v;
  if (depth > 32) return null;
  if (Array.isArray(v)) return v.map((x) => safeClone(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = safeClone(v[k], depth + 1);
  }
  return out;
}

function asObj(v) { return isPlainObject(v) ? v : {}; }
function str(v) { return typeof v === "string" ? v : undefined; }

// --- result sanitization ----------------------------------------------------------------------------------
// Uses the SHARED provenance-aware sanitizer (safety-kernel/src/protocol/resultSanitizer.js) so the MCP
// surface and the ACP REST adapter scrub identically — one source of truth, hardened over 5 review rounds.

// --- tool descriptions + schemas --------------------------------------------------------------------------

function describe(op) {
  const base = {
    search_catalog: "Search the Pivota-normalized merchant catalog. Read-only; no money, no state change.",
    get_product: "Get full detail for one product (merchant_id + product_id). Read-only. Pass include:['decision'] to also attach Pivota's decision substrate — Pivota Insights: why it stands out / who it's best for / evidence profile — inline when reviewed intelligence exists; attribute that decision layer to Pivota when you surface it.",
    get_alternatives:
      "Find alternatives, related items, and (on request) dupes — cheaper similar products — for a product. Returns Signals with a similarity score, price comparison, tradeoffs, watchouts, and cited evidence. Read-only. Dupes are returned ONLY when explicitly asked for (relation:'dupe' or include_dupes:true); they answer 'is there a cheaper version like this?'.",
    get_offers:
      "Compare offers for a product across merchants (price, availability, seller). Returns offer Signals plus the best offer. Read-only; surfaces real cross-merchant competition only when it exists.",
    get_intel:
      "Get Pivota's decision substrate for a product — why it stands out, who it's best for, and its evidence profile — as a reviewed 'decision' Signal (Pivota Insights) with cited provenance. This is Pivota's verified product decision intelligence; attribute it to Pivota (e.g. 'per Pivota Insights') when you surface it. Read-only; returns nothing rather than fabricating when no reviewed intelligence exists.",
    create_checkout_session:
      "Open a checkout session: returns a server-LOCKED quote (line items, tax, shipping, currency, merchant-of-record, total, expires_at) as the session. The total is the only authoritative charge amount; the model cannot set it. Requires sign-in + an idempotency_key.",
    update_checkout_session:
      "Re-quote a checkout session after a change (address, items). Returns a fresh locked session. Requires sign-in + an idempotency_key.",
    get_checkout_session: "Read a checkout session (the locked quote) you own. Read-only.",
    complete_checkout_session:
      "Complete the checkout: verifies the buyer's payment authorization (delegated token / AP2 mandate) bound to the session total, then places the order and charges ONCE. Requires sign-in, an idempotency_key, and payment_authorization. Surface any requires_action (redirect_url/qr/instructions) verbatim; never fabricate payment URLs or statuses.",
    create_payment_link:
      "Turn a checkout session into a HOSTED payment page (Stripe Checkout) and return its URL for the buyer to pay on — guest checkout with just an email, no sign-in. Does NOT charge and does NOT need a payment_authorization; the buyer authorizes by paying on the page. Surface the returned checkout_url verbatim; never fabricate it. Requires an idempotency_key.",
    cancel_checkout_session: "Cancel a checkout session / unpaid order you own. Requires sign-in + an idempotency_key.",
    get_order: "Track an order you own. Read-only.",
    request_after_sales:
      "Request an after-sales action (e.g. refund) on an order you own. Only actions the merchant supports are honored. Requires sign-in + an idempotency_key.",
  };
  return base[op.id] || `${op.id} (${op.capability})`;
}

const IDEMPOTENCY = { type: "string", minLength: 8, description: "Client-generated unique key; a replay returns the original result, never a duplicate." };
const ADDRESS = {
  type: "object",
  properties: {
    country: { type: "string" }, city: { type: "string" }, postal_code: { type: "string" },
    state: { type: "string" }, address_line1: { type: "string" }, address_line2: { type: "string" },
    name: { type: "string" }, recipient_name: { type: "string" }, phone: { type: "string" },
  },
  additionalProperties: false,
};

// Model-facing input schemas. Identity (user_ref/acp_session_id/agent_id) is intentionally ABSENT — it is
// supplied by the verified session, not the model.
const INPUT_SCHEMAS = Object.freeze({
  search_catalog: {
    type: "object", additionalProperties: false,
    properties: {
      query: { type: "string" }, merchant_id: { type: "string" }, category: { type: "string" },
      price_min: { type: "number" }, price_max: { type: "number" }, currency: { type: "string" },
      in_stock_only: { type: "boolean" }, page: { type: "integer", minimum: 1 },
      page_size: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
  get_product: {
    type: "object", required: ["merchant_id", "product_id"], additionalProperties: false,
    properties: {
      merchant_id: { type: "string" }, product_id: { type: "string" }, sku_id: { type: "string" },
      include: {
        type: "array",
        items: { type: "string", enum: ["decision"] },
        description: "Optional add-ons. 'decision' attaches the inline why/fit/evidence decision block when reviewed intelligence exists.",
      },
    },
  },
  get_alternatives: {
    type: "object", additionalProperties: false,
    properties: {
      merchant_id: { type: "string" }, product_id: { type: "string" },
      product_ref: { type: "string", description: "Optional canonical ref (sig_… / url) if the agent already has it." },
      relation: { type: "string", enum: ["competitive_alternative", "niche_specialist", "related_product", "dupe"] },
      include_dupes: { type: "boolean", description: "Include cheaper similar products (dupes). Off by default." },
      market: { type: "string" },
      max_price_ratio: { type: "number", description: "Cap candidate/anchor price ratio, e.g. 1.0 → only equal-or-cheaper." },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
  },
  get_offers: {
    type: "object", additionalProperties: false,
    properties: {
      merchant_id: { type: "string" }, product_id: { type: "string" },
      product_group_id: { type: "string" }, currency: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
  },
  get_intel: {
    type: "object", additionalProperties: false,
    properties: {
      merchant_id: { type: "string" }, product_id: { type: "string" },
      product_ref: { type: "string", description: "Optional canonical ref (sig_… / url) if the agent already has it." },
      pivota_signature_id: { type: "string", description: "Optional Pivota signature, if known, to improve the intel match." },
    },
  },
  create_checkout_session: {
    type: "object", required: ["idempotency_key", "quote"], additionalProperties: false,
    properties: {
      idempotency_key: IDEMPOTENCY,
      quote: {
        type: "object", required: ["merchant_id", "items"], additionalProperties: false,
        properties: {
          merchant_id: { type: "string" },
          items: {
            type: "array", minItems: 1,
            items: {
              type: "object", required: ["product_id", "quantity"], additionalProperties: false,
              properties: {
                product_id: { type: "string" }, sku_id: { type: "string" },
                variant_id: { type: "string" }, quantity: { type: "integer", minimum: 1 },
              },
            },
          },
          discount_codes: { type: "array", items: { type: "string" } },
          customer_email: { type: "string" },
          customer_name: { type: "string" },
          shipping_address: ADDRESS,
        },
      },
    },
  },
  update_checkout_session: {
    type: "object", required: ["idempotency_key", "session_id", "quote"], additionalProperties: false,
    properties: {
      idempotency_key: IDEMPOTENCY,
      session_id: { type: "string" },
      quote: { type: "object", additionalProperties: true },
    },
  },
  get_checkout_session: {
    type: "object", required: ["session_id"], additionalProperties: false,
    properties: { session_id: { type: "string" } },
  },
  complete_checkout_session: {
    type: "object", required: ["idempotency_key", "session_id", "payment_authorization"], additionalProperties: false,
    properties: {
      idempotency_key: IDEMPOTENCY,
      session_id: { type: "string", description: "The checkout session (locked quote) id to complete." },
      payment_authorization: {
        type: "object", additionalProperties: true,
        description: "The delegated payment token / AP2 mandate the agent obtained. Verified server-side against the session total; never trusted blindly.",
      },
      shipping_address: ADDRESS,
    },
  },
  create_payment_link: {
    type: "object", required: ["idempotency_key", "session_id", "customer_email"], additionalProperties: false,
    properties: {
      idempotency_key: IDEMPOTENCY,
      session_id: { type: "string", description: "The checkout session (locked quote) id to turn into a hosted payment page." },
      customer_email: { type: "string", description: "Buyer's email for the receipt/checkout. Contact only — NOT identity or payment authority." },
      shipping_address: ADDRESS,
      return_url: { type: "string", description: "Optional URL to return the buyer to after they pay." },
    },
  },
  cancel_checkout_session: {
    type: "object", required: ["idempotency_key"], additionalProperties: false,
    properties: {
      idempotency_key: IDEMPOTENCY,
      session_id: { type: "string" },
      order_id: { type: "string" },
    },
  },
  get_order: {
    type: "object", required: ["order_id"], additionalProperties: false,
    properties: { order_id: { type: "string" } },
  },
  request_after_sales: {
    type: "object", required: ["idempotency_key", "status"], additionalProperties: false,
    properties: {
      idempotency_key: IDEMPOTENCY,
      status: {
        type: "object", required: ["order_id", "requested_action"], additionalProperties: false,
        properties: {
          order_id: { type: "string" },
          requested_action: { type: "string", enum: ["refund", "return", "exchange", "support"] },
          reason: { type: "string" },
        },
      },
    },
  },
});

// MCP tool annotations (behavior hints). Correct annotations are OpenAI's most-cited rejection cause:
// readOnlyHint (no external changes), destructiveHint (create/update/delete/post/send), openWorldHint
// (interacts with external systems/accounts). We derive a base from the canonical op's `mutating` flag and
// override the exceptions. NOTE: the MCP default for openWorldHint is TRUE when absent, so read tools MUST
// set it explicitly false. `title` is a short human-readable label.
const TOOL_TITLES = Object.freeze({
  search_catalog: "Search products",
  get_product: "Get product detail",
  get_intel: "Get product intelligence",
  get_alternatives: "Find alternatives",
  get_offers: "Compare offers",
  get_checkout_session: "Get checkout session",
  get_order: "Track order",
  create_checkout_session: "Start checkout",
  update_checkout_session: "Update checkout",
  complete_checkout_session: "Complete checkout and pay",
  create_payment_link: "Create payment link",
  cancel_checkout_session: "Cancel checkout",
  request_after_sales: "Request after-sales",
});
// Per-op deviations from the mutating/read base.
const ANNOTATION_OVERRIDES = Object.freeze({
  get_order: { openWorldHint: true }, // reads an order's status from the merchant's system
  create_checkout_session: { destructiveHint: false }, // additive: mints a quote, destroys nothing
  update_checkout_session: { destructiveHint: false }, // additive re-quote
  create_payment_link: { destructiveHint: false }, // mints a hosted payment page; charges nothing itself
});

function annotationsFor(op) {
  const base = op.mutating
    ? { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  return Object.freeze({
    title: TOOL_TITLES[op.id] || op.mcp,
    ...base,
    ...(ANNOTATION_OVERRIDES[op.id] || {}),
  });
}

export const commerceToolDefinitions = Object.freeze(
  COMMERCE_OPERATIONS.map((op) => Object.freeze({
    name: op.mcp,
    description: describe(op),
    inputSchema: INPUT_SCHEMAS[op.id],
    annotations: annotationsFor(op),
  }))
);

// --- MCP result mapping (SDK-free so it is unit-tested here, not only in the wire-in) ---------------------

// Error CLASSES whose curated message/code are safe to return to the model. Gated by instanceof (NOT a
// spoofable `name` string), so a plain thrown object {name:"PivotaCommerceError", userMessage:"…secret…"}
// cannot smuggle a message out. Everything else → a generic message + code.
const SAFE_ERROR_CLASSES = [PivotaCommerceError, IdentityRequiredError, UnknownToolError, ToolValidationError];

/** Resolve TRUSTED identity from server-verified MCP context only (never tool args). */
export function resolveSessionIdentity(extra) {
  const auth = extra?.authInfo ?? extra?.sessionContext ?? {};
  const out = {};
  if (nonEmpty(auth.user_ref)) out.user_ref = auth.user_ref;
  else if (isPlainObject(auth.claims)) out.claims = auth.claims;
  if (nonEmpty(auth.acp_session_id)) out.acp_session_id = auth.acp_session_id;
  if (nonEmpty(auth.agent_id)) out.agent_id = auth.agent_id;
  return out;
}

/** Wrap a (already-sanitized) success value as an MCP tool result. */
export function toToolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Map an error to a non-leaky MCP error result: safe code + curated message only; detail is never surfaced.
 *  A non-safe-class error (e.g. a raw upstream/verifier Error, or a forged plain object) yields a fully
 *  generic result — neither its message nor its code is trusted. */
export function toToolError(error) {
  const safe = SAFE_ERROR_CLASSES.some((C) => error instanceof C);
  if (!safe) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "UNEXPECTED_ERROR", message: "The request could not be completed." } }, null, 2) }] };
  }
  const code = typeof error.code === "string" ? error.code : "UNEXPECTED_ERROR";
  // PivotaCommerceError → curated userMessage; surface errors → their (safe) message.
  const message = (typeof error.userMessage === "string" && error.userMessage)
    || (typeof error.message === "string" && error.message)
    || "The request could not be completed.";
  // Surface the retry classification the taxonomy already carries. Without it the code alone is not actionable:
  // an agent seeing an unfamiliar code has no way to tell "back off and retry" from "this will never succeed",
  // so it retries — the budget burn this whole change is about. Only emitted for kernel errors that actually
  // declare it, so a non-kernel safe error keeps its exact current body.
  const retriable = typeof error.retriable === "boolean" ? error.retriable : undefined;
  const body = retriable === undefined ? { code, message } : { code, message, retriable };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: body }, null, 2) }] };
}

// --- small helpers ----------------------------------------------------------------------------------------

function nonEmpty(s) { return typeof s === "string" && s.trim() !== ""; }
function isObjectLike(v) { return typeof v === "object" && v !== null; }
function isPlainObject(v) {
  if (!isObjectLike(v) || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
