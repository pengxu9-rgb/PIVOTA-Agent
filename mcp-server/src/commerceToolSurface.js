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

import { CANONICAL_OPERATIONS, canonicalOp, UCP_DIALECT_OPERATIONS } from "../../safety-kernel/src/protocol/canonicalContract.js";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import { sanitizeResult } from "../../safety-kernel/src/protocol/resultSanitizer.js";
// The SHARED buyer/address/item intake — the SAME module the ACP REST door uses. See the BUYER INTAKE note
// below the params mapping for what it fixes here and why it is imported rather than reimplemented.
// (buyerIntake.js is jose-free by construction, so this import keeps mcp-server jose-free too.)
import {
  attestedBuyerFromClaims,
  createDefaultVariantResolver,
  normalizeCartItems,
  pickCompleteAddress,
  resolveBuyerEmail,
  resolveBuyerName,
  surfaceableIntakeRefusal,
} from "../../safety-kernel/src/protocol/buyerIntake.js";
import { deriveUserRef } from "../auth/userRef.js";
import { createPublicReadCache, stableStringify } from "./publicReadCache.js";
// The UCP wire-shape translation (step 3). It owns the UCP `tools/list` schemas AND the `tools/call` argument
// mapping in one table, so what the dialect advertises is what it accepts.
import { shapeUcpResult } from "./ucpResponseShaper.js";
import { tryEscalateUcpCheckout } from "./ucpCheckoutEscalation.js";
import {
  UCP_INPUT_SCHEMAS,
  UCP_TOOL_DESCRIPTIONS,
  ucpToNativeToolArgs,
} from "./ucpArgumentAdapter.js";

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

// --- protocol dialects -------------------------------------------------------------------------------------
//
// The SAME tool surface, addressed by two vocabularies. A UCP platform sends the spec's flat tool names
// (`create_checkout`), Pivota's own MCP clients send ours (`create_checkout_session`); both resolve to the
// same canonical operation and therefore the same executor, kernel and money path. This is a NAMING layer on
// purpose — a second door with its own handlers is exactly the per-ecosystem fork the canonical contract
// exists to prevent (and would fork the safety invariants with it).
//
// The UCP dialect exposes only operations with an EVIDENCED spec name (canonicalContract UCP_TOOL_EVIDENCE);
// everything else is absent from that dialect rather than guessed at.
export const TOOL_DIALECTS = Object.freeze({ mcp: "mcp", ucp: "ucp" });

const UCP_COMMERCE_OPERATIONS = UCP_DIALECT_OPERATIONS.filter((op) => op.kernel !== "external");
const OP_BY_UCP_TOOL = Object.freeze(Object.fromEntries(UCP_COMMERCE_OPERATIONS.map((op) => [op.ucpTool, op])));

// A typo'd dialect must NOT quietly resolve to the MCP vocabulary: that would make a "UCP" door accept
// Pivota-native names (review finding on #1962).
function normalizeDialect(dialect) {
  if (dialect === undefined || dialect === null || dialect === TOOL_DIALECTS.mcp) return TOOL_DIALECTS.mcp;
  if (dialect === TOOL_DIALECTS.ucp) return TOOL_DIALECTS.ucp;
  throw new Error(`unknown tool dialect: ${String(dialect)}`);
}

function opIndexFor(dialect) {
  return normalizeDialect(dialect) === TOOL_DIALECTS.ucp ? OP_BY_UCP_TOOL : OP_BY_MCP;
}

// Which body field each dialect accepts a buyer email in. Threaded into the shared intake so its refusal names
// a field the CALLER can actually send: buyerIntake's own note records that a message naming a field the door
// strips makes a model retry the identical call and be refused identically.
const EMAIL_BODY_FIELDS = Object.freeze({
  [TOOL_DIALECTS.mcp]: Object.freeze(["quote.customer_email"]),
  [TOOL_DIALECTS.ucp]: Object.freeze(["checkout.buyer.email"]),
});

// --- result cache (search_catalog ONLY) -------------------------------------------------------------------
//
// Cold search costs seconds and the commerce lane had no cache at all, so a repeated identical query paid
// full price every time (measured on prod 2026-08-05: an identical repeat still cost 21.2s).
//
// SHARING RESULTS ACROSS CALLERS IS ONLY SAFE BECAUSE search_catalog IS CALLER-INDEPENDENT END TO END.
// Each leg was verified in the code, not assumed:
//   1. params are built by ALLOWLIST (toParams) from tool args alone — no identity field can enter;
//   2. canonicalExecutor's `search_catalog` case calls read(), and read() is `upstream(op, payload)` — the
//      ctx carrying user_ref / acp_session_id / agent_id is DROPPED, never forwarded;
//   3. the upstream request forces the INTERNAL api key (forceInternalFallback, forwardAgentUserJwt:false),
//      AND suppresses X-Buyer-Ref on exactly these cached read lanes (forwardBuyerRef, keyed on
//      COMMERCE_CACHED_READ_OPS in src/server.js). That header is attached to every other upstream call and
//      is the one caller-derived byte that would otherwise leave the process — including on the
//      merchant-scoped find_products lane, which reaches the Python backend where we cannot audit what it
//      does with it. Suppressed, "the upstream sees one identity" is true BY CONSTRUCTION, not by trusting
//      a backend we cannot read;
//   4. the response carries no user, buyer, session or account field.
// THEREFORE the cache key is the ALLOWLISTED params and NOTHING else (see the note at the getOrCompute call
// for why params rather than the raw tool args). Adding user_ref/agent_id would shred the hit rate for zero
// safety gain. If any of the four legs ever changes — most plausibly (2), by threading ctx through read() —
// this cache MUST be re-scoped or removed.
//
// The guard is a test, not this comment: commerceReadCache asserts that two different verified sessions
// produce byte-identical upstream invocations, recording EVERY argument the upstream receives. Both parts
// of that sentence were learned the hard way — a draft recorded at a stubbed executor (which stubs out legs
// 2 and 3 entirely), and its replacement recorded only (op, payload), which let a leak through the third
// `headers` argument land green.
//
// DELIBERATELY search_catalog ALONE. get_alternatives / get_offers / get_intel DO receive ctx in the
// executor (localReads take (params, ctx)), so they are not covered by the argument above and are not
// cached until each has its own analysis.
const CACHEABLE_TOOLS = Object.freeze(["search_catalog"]);

function envValue(name) {
  return (typeof process !== "undefined" && process.env && process.env[name]) || "";
}

function positiveIntEnv(name, fallback) {
  const n = Number(envValue(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function commerceCacheEnabled() {
  const raw = String(envValue("COMMERCE_READ_CACHE_ENABLED")).trim().toLowerCase();
  if (raw === "") return true; // default ON, mirroring the public read tier
  return !["0", "false", "off", "no"].includes(raw);
}

// A thrown error is not the only answer worth NOT keeping. The upstream returns its body unthrown whenever
// `ok !== true`, and the search lane can answer HTTP-200 with a degraded envelope and an empty list — so
// without this a transient degradation is pinned for the full TTL and replayed to every later caller. A
// legitimately empty result (a real search that matched nothing) is still cached: absence of an error, not
// presence of products, is the test.
function isCacheableSearchResult(value) {
  if (!isPlainObject(value)) return false;
  if (value.ok === false) return false;
  if (value.success === false) return false;
  if (value.error !== undefined && value.error !== null) return false;
  if (typeof value.status === "string" && value.status.toLowerCase() === "error") return false;
  return true;
}

// Cached values are handed to every later caller, so they must not be a shared mutable object: one consumer
// editing a product row in place would serve the edit to everyone else for the rest of the TTL. Nothing
// downstream mutates today — the commerce path stringifies, the public tier rebuilds with spreads — but the
// public tier is exactly where post-processing accretes, and its sourcing filter reads fields the projector
// later strips. Cloning on read costs a few ms against a search measured in seconds.
function cloneCachedValue(value, onCloneFailure) {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch (err) {
    // Non-cloneable values are not something this cache should be holding, but degrade to the shared
    // reference rather than failing a caller's search. Logged because silently degrading here removes the
    // isolation above with no other signal that it is gone.
    if (onCloneFailure) onCloneFailure(err);
    return value;
  }
}

/**
 * Build the MCP commerce tool surface over an already-composed canonical executor.
 * @param {{ execute: (opId:string, params:object, ctx:object)=>Promise<any> }} executor
 * @param {{ log?: object, cache?: boolean }} [opts] pass cache:false when the CALLER already caches this
 *   surface's results (the public read tier does). Two stacked caches would put the public tier's own
 *   documented kill switch behind this one and double the resident payload for no extra hit rate.
 * @returns {{ tools: Array<{name,description,inputSchema}>, callTool: Function, isCommerceTool: Function }}
 */
export function createCommerceToolSurface(executor, { log, cache: cacheOpt = true } = {}) {
  if (!executor || typeof executor.execute !== "function") {
    throw new Error("createCommerceToolSurface requires a canonical executor with execute()");
  }

  const tools = commerceToolDefinitions.map((tool) => ({ ...tool }));

  // Default-variant resolution over THIS surface's executor — the same canonical `get_product` read the ACP
  // door resolves through, built by the same factory. Nothing about the rule lives here.
  const resolveDefaultVariants = createDefaultVariantResolver({ executor });

  // Shorter-lived than the public tier's 10min/60min: these results carry prices and availability an agent
  // may act on. Search staleness cannot produce a wrong charge — the money path re-quotes against the
  // backend (preview_quote) rather than trusting a search row — but discovery should still turn over
  // faster here than on the anonymous read tier.
  const logger = log && typeof log.warn === "function" ? log : null;
  const ttlMs = positiveIntEnv("COMMERCE_READ_CACHE_TTL_MS", 5 * 60 * 1000);
  // A staleMs below ttlMs makes the stale-serve and expiry branches unreachable — a silent
  // misconfiguration rather than a loud one, so clamp it.
  const staleMs = Math.max(positiveIntEnv("COMMERCE_READ_CACHE_STALE_MS", 15 * 60 * 1000), ttlMs);
  const cache = cacheOpt !== false && commerceCacheEnabled()
    ? createPublicReadCache({
        ttlMs,
        staleMs,
        // 60, not the public tier's 300: these entries are FAT. The public tier caches slim projected
        // rows (~5KB); a commerce search result is the unprojected product list, measured at ~460KB on
        // prod (68 products, ingredient_intel alone about half of it). 300 of those would be ~150MB
        // resident for a cache, which is how a latency fix turns into an OOM. 60 covers the head of the
        // query distribution for ~28MB — one instance, because the public tier passes cache:false rather
        // than stacking a second copy of the same payloads.
        maxEntries: positiveIntEnv("COMMERCE_READ_CACHE_MAX", 60),
        onRevalidateError: (err, key) => {
          if (logger) {
            logger.warn(
              { err: err?.message || String(err), key },
              "commerce read cache revalidation failed (stale kept)",
            );
          }
        },
        shouldCache: isCacheableSearchResult,
      })
    : null;

  /**
   * Execute a commerce tool call.
   * @param {string} toolName       the MCP tool name (== canonical op.mcp)
   * @param {object} toolArgs       model-supplied arguments (identity fields are ignored/stripped)
   * @param {object} sessionContext SERVER-VERIFIED identity context: { user_ref } or { claims }, plus an
   *                                optional verified acp_session_id / agent_id.
   * @returns {Promise<object>}     sanitized result; THROWS PivotaCommerceError / IdentityRequiredError /
   *                                UnknownToolError on failure (the MCP server formats these).
   */
  async function callTool(toolName, toolArgs = {}, sessionContext = {}, options = {}) {
    // dialect defaults to MCP, so every existing caller is unchanged.
    const dialect = normalizeDialect(options.dialect);
    const op = (dialect === TOOL_DIALECTS.ucp ? OP_BY_UCP_TOOL : OP_BY_MCP)[toolName];
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
    // The ATTESTED buyer, read from the same verified claims — kept OUT of ctx on purpose: ctx is what the
    // executor receives, and widening it would change what every op sees for the sake of two.
    const attested = attestedBuyerFromSession(sessionContext);

    // 2) a user-scoped op needs BOTH a verified buyer AND a verified session id (the T7 quote↔order linkage
    //    the kernel binds). Refuse early — clean, non-leaky — rather than fabricating a weak session id.
    if (op.requiresUserRef && (!nonEmpty(ctx.user_ref) || !nonEmpty(ctx.acp_session_id))) {
      throw new IdentityRequiredError();
    }

    // 2b) DIALECT ARGUMENT TRANSLATION. A UCP platform sends the spec's wire shape
    //     (`{ meta, checkout: { line_items: [{ item: { id }, quantity }] } }`), which shares no field name
    //     with Pivota's native tool args. Translating here — before the allowlist — means everything
    //     downstream (allowlist, buyer intake, executor, kernel) is the SAME code the MCP door runs; the
    //     dialect difference ends at this line. See ucpArgumentAdapter.js for what maps and what deliberately
    //     does not.
    const nativeArgs = dialect === TOOL_DIALECTS.ucp ? ucpToNativeToolArgs(op, toolArgs) : toolArgs;

    // 3) build executor params by ALLOWLIST (only the fields this op defines). One move strips identity,
    //    extra money fields (e.g. a model-set refund amount), and prototype-polluting keys.
    const params = toParams(op, nativeArgs);

    // 3a) UCP CHECKOUT ESCALATION (path 2 — rows Pivota does not transact). On the UCP dialect only, for the
    //     checkout operations, a cart of OBSERVED-seller rows is answered with a spec `requires_escalation`
    //     checkout whose continue_url is the seller's storefront — no intake, no quote, no kernel, no charge:
    //     there is nothing Pivota could honestly price or charge for such a row. Contracted rows return null
    //     here and take the kernel path below unchanged. Kill-switched (AGENT_CHECKOUT_UCP_ESCALATION_ENABLED,
    //     default OFF). Deliberately AFTER the identity check (2) — an escalated checkout is still a buyer's
    //     checkout — and after the allowlist, so it only ever sees fields this op defines. See
    //     ucpCheckoutEscalation.js for the classification rule and the wire shape.
    let resolveVariantsForThisCall = resolveDefaultVariants;
    if (dialect === TOOL_DIALECTS.ucp && op.capability === "checkout") {
      // ONE read per product per call: the escalation classifier and the checkout resolver both perform the
      // unscoped `get_product` read; a memoizing view of the executor lets a contracted cart (classified
      // "kernel path" here) be read once and the resolver reuse the same result. Scoped to this call.
      const reads = memoizedProductReads(executor);
      const escalated = await tryEscalateUcpCheckout({ op, params, ctx, executor: reads, ucpArgs: toolArgs, attested });
      if (escalated) return escalated;
      resolveVariantsForThisCall = createDefaultVariantResolver({ executor: reads });
    }

    // 3b) BUYER INTAKE — the shared rules, applied before anything is priced. See the note below toParams.
    //     Deliberately AFTER the allowlist (so intake only ever sees fields this op defines) and BEFORE
    //     `executor.execute` (so a refused request performs no pricing call and takes no inventory hold).
    await applyBuyerIntake(op, params, attested, resolveVariantsForThisCall, ctx, EMAIL_BODY_FIELDS[dialect]);

    const execute = async () => {
      // 4) the single execution bridge enforces the contract flags + routes to the kernel.
      const result = await executor.execute(op.id, params, ctx);
      // 5) sanitize. A payment redirect (requires_action) is only LEGITIMATE for the checkout flow, so
      //    handoff URLs are preserved verbatim ONLY for checkout ops (PayPal `?token=EC-…`, OAuth `?code=…`,
      //    Stripe 3DS `client_secret` must reach the buyer intact). For discovery/order results a
      //    redirect-named field is NOT a payment handoff and is scrubbed aggressively.
      return sanitizeResult(result, { handoffAllowed: op.capability === "checkout" });
    };

    // 6) cache read-only, caller-independent results. Gated on the op being cacheable — never on anything
    //    about the caller — so a mutating or user-scoped op can never reach this branch. The cached value
    //    is the SANITIZED result, so a cache hit is byte-identical to a miss. Only successes are stored
    //    (getOrCompute lets errors propagate uncached), which keeps a transient MERCHANT_UNAVAILABLE from
    //    being served for the rest of the TTL. See the CACHEABLE_TOOLS note above for why the key omits
    //    identity — that omission is the whole safety argument and is asserted by tests.
    //    The key is the ALLOWLISTED params, never the raw tool args. Nothing rejects unknown argument
    //    properties, so keying on the raw args lets any caller mint unlimited distinct keys for one
    //    identical upstream call (`{query, _cb: <nonce>}`) — a 0% hit rate, and 60 such requests evict
    //    every real entry. Keying on what actually reaches the executor makes that impossible by
    //    construction: junk properties are already gone by this line.
    // 7) DIALECT RESULT SHAPING — the outbound twin of step 2b, applied to whatever the steps above produced
    //    (fresh or cached). Deliberately AFTER the cache: the cache stores the NATIVE sanitized value keyed on
    //    dialect-agnostic params, and both dialects read the same entry — shaping before the cache would let
    //    a UCP call poison the entry the next /mcp call reads, and vice versa. The shaper is pure and runs on
    //    the clone `cloneCachedValue` hands out. See mcp-server/src/ucpResponseShaper.js for what maps.
    const shape = (value) => (dialect === TOOL_DIALECTS.ucp ? shapeUcpResult(op, value, { params, ucpArgs: toolArgs }) : value);

    if (!cache || !CACHEABLE_TOOLS.includes(op.id)) return shape(await execute());
    const value = await cache.getOrCompute(`${op.id}:${stableStringify(params ?? {})}`, execute);
    return shape(cloneCachedValue(value, (err) => {
      if (logger) {
        logger.warn(
          { err: err?.message || String(err), tool: op.id },
          "commerce read cache: value not cloneable, serving shared reference",
        );
      }
    }));
  }

  function isCommerceTool(name, dialect) {
    return Object.prototype.hasOwnProperty.call(opIndexFor(dialect), name);
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

/**
 * The ATTESTED buyer fields (email/name) carried by the SERVER-VERIFIED claims, if any.
 *
 * The claims really are here: both live identity paths in src/server.js put the full verified JWT payload on
 * the session context — `buildOAuthCommerceCtx` (`claims`, from mcpOAuthResourceServer's `{user_ref, claims:
 * payload, scopes}`) and the `X-Agent-User-JWT` branch of `deriveStrictCommerceCtxAsync` (`claims:
 * verified.claims`). Before this, `buildContext` read `claims` only in the `else if` branch that fires when
 * `user_ref` is ABSENT — i.e. never on a signed-in request — so a verified buyer's own email was sitting one
 * field away from the door and being dropped, while a model-asserted `quote.customer_email` sailed through to
 * the receipt.
 *
 * `attested_email` is DELIBERATELY NOT derived from `user_ref`: ownership stays `iss|sub` and this changes
 * nothing about it. An unparseable/absent claims object yields `{}`, which simply means "nothing attested".
 */
function attestedBuyerFromSession(sessionContext = {}) {
  const claims = isPlainObject(sessionContext.claims) ? sessionContext.claims : null;
  if (!claims) return {};
  try {
    return attestedBuyerFromClaims(claims);
  } catch {
    return {};
  }
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
    case "recommend_products":
      // `constraints` is a free-form object: cloned through the same prototype-safe copier the payment
      // envelope uses, so a hostile key cannot ride into the lane.
      return {
        payload: {
          ...pick(a, ["need", "language", "limit"]),
          constraints: a.constraints === undefined ? undefined : safeClone(a.constraints),
        },
      };
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

// An address is OPTIONAL but must be COMPLETE IF PRESENT — the shared rule, because the five required
// fields come from pivota-backend `_coerce_shipping_address` and are the same for every door. This refuses
// where the allowlist used to wave a partial address through to pricing (see the BUYER INTAKE note).
function pickAddress(addr) {
  return isPlainObject(addr) ? pickCompleteAddress(addr, { updateHint: 'the `update_checkout_session` tool' }) : undefined;
}

// --- BUYER INTAKE (shared with the ACP door) ---------------------------------------------------------------
//
// WHAT WAS WRONG. `toParams` above is a pure ALLOWLIST, and an allowlist is a filter, not a validator. It
// copies whatever named field arrived and asks nothing of it, so three defects were reachable on this door
// TODAY — measured through the real wiring, not inferred:
//
//   | tool args                          | body the backend received                                        |
//   |------------------------------------|------------------------------------------------------------------|
//   | no `customer_email`                | no `buyer_context` -> the session mints, then order-create 400s   |
//   |                                    | INVALID_BUYER_CONTEXT (agent_v2.py, UNCONDITIONAL)               |
//   | `items:[{sku_id:'s1'}]`            | `offer_refs` ENTIRELY ABSENT -> prices an EMPTY cart              |
//   | `items:[{product_id:'p1'}]`        | `offer_refs:[{product_id:'p1', variant_id:'p1'}]` -> the variant  |
//   |                                    | FORGED from the product id                                       |
//   | `customer_email:'model@evil.test'` | passed through even for a signed-in buyer whose credential       |
//   |                                    | attests a different address                                      |
//   | `shipping_address:{city:'London'}` | a partial destination priced for shipping/tax                    |
//
// The middle two are MONEY-CORRECTNESS bugs: the cart that gets priced is not the cart that was requested,
// and both fail SILENTLY with a 200. They are not left reachable to preserve a caller's convenience.
//
// WHY IT IS IMPORTED, NOT REIMPLEMENTED. Every rule here already existed at the ACP REST door (#1918).
// Writing a second copy would recreate the twin-drift class this project keeps paying for, so the rules moved
// into safety-kernel/src/protocol/buyerIntake.js and BOTH doors import them. There is exactly one definition
// of attested-wins precedence, of the required-address field set, and of the variant-resolution rule.
//
// WHAT THIS DOOR STILL OWNS: which of its ops carry a cart, and where in its params each field sits.

// Ops whose params carry a full quote (items + buyer + address). `update_checkout_session` is included
// because the executor routes create and update through the SAME `kernel.previewQuote` — an update RE-MINTS
// the snapshot rather than merging into it, so whatever the update body omits is DROPPED, not kept. Holding
// update to weaker intake than create would just move every defect one call to the right.
const QUOTE_INTAKE_OPS = Object.freeze(["create_checkout_session", "update_checkout_session"]);

/**
 * Apply the shared intake to an op's already-allowlisted params. Mutates `params` in place; THROWS a curated
 * PivotaCommerceError (surfaced by toToolError) on any refusal.
 */
async function applyBuyerIntake(op, params, attested = {}, resolveDefaultVariants, ctx = {}, emailBodyFields = ['quote.customer_email']) {
  if (QUOTE_INTAKE_OPS.includes(op.id)) {
    const quote = params.quote;
    // Items first: it is the cheapest refusal and the one that decides whether a read is even needed.
    // (`quote.items` absent -> QUOTE_REQUIRED/no_items, which is what closes the `quote:{}` hole that let an
    // update price a cart with no line items at all.)
    quote.items = normalizeCartItems(quote.items);
    // PRECEDENCE: attested first, ALWAYS. A caller-supplied `customer_email` can only fill a gap — it can
    // never override the address the buyer's own verified credential asserts, which is what stopped an agent
    // picking the receipt address for a signed-in buyer.
    // The accepted field name is the DIALECT's, not this door's: a UCP caller supplies it as
    // `checkout.buyer.email` and has no `quote` object at all.
    quote.customer_email = resolveBuyerEmail(attested.attested_email, [quote.customer_email], {
      acceptedBodyFields: emailBodyFields,
    });
    const customer_name = resolveBuyerName(attested.attested_name, [quote.customer_name]);
    if (customer_name) quote.customer_name = customer_name;
    else delete quote.customer_name;
    // LAST, because it is the only step that costs an upstream read: resolve a default variant for every item
    // that arrived without one. Items are mutated in place, so the RESOLVED id is what reaches pricing —
    // and a synthesised one never does.
    await resolveDefaultVariants(quote.items, quote.merchant_id, { user_ref: ctx.user_ref });
    return;
  }
  if (op.id === "create_payment_link") {
    // Guest hosted checkout: there may be no verified buyer at all, so a caller-supplied email is the NORMAL
    // source here and stays accepted. But when the session DOES carry an attested one, it wins — same rule,
    // same direction, and it breaks nobody (the field keeps its existing `required` status either way).
    params.customer_email = resolveBuyerEmail(attested.attested_email, [params.customer_email], {
      acceptedBodyFields: ['customer_email'],
    });
  }
  // complete_checkout_session needs nothing here: its only intake field is `shipping_address`, already held
  // to the shared completeness rule by pickAddress above — the same point at which the ACP door checks it.
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
      "Compare offers for a product across merchants (price, availability, seller). Returns offer Signals plus the best offer. An external offer may carry `cart_prefilled`, which says what following its `affiliate_url` actually does: true = the buyer lands on the merchant's own checkout with the item already in the cart; false = a bare product page they must add from themselves; null = Pivota does not know. Treat null as unknown and say nothing about where the link lands — only an explicit false licenses telling a buyer to expect a product page. Read-only; surfaces real cross-merchant competition only when it exists.",
    recommend_products:
      "Recommend products for a NEED stated in natural language (e.g. 'a gentle retinol for beginners under $40') — Pivota's prompt-level recommendation lane. Returns a ranked shortlist of recommendation Signals, each with the resolved catalog product (id, brand, title, price, url), why it fits, watchouts, and grounding; plus metadata.confidence_overall, missing_info (what else Pivota would need to know) and warnings. Each item also carries a `recommendation_id`, and the response a `metadata.recommendation_set_id`: opaque keys identifying this recommendation. Retain the `recommendation_id` of whatever you act on: it is how a purchase, a price change or a failure will be attributed to the recommendation that caused it, once the outcome endpoint ships. Use search_catalog when the buyer names a product; use this when they describe a need. Today's lane is tuned for beauty/skincare: off-vertical needs answer with an empty shortlist and a reason, never with fabricated products. Read-only; calls an external decision service (several seconds); results are not cached and may vary between calls on purpose. Attribute the reasoning to Pivota when you surface it.",
    get_intel:
      "Get Pivota's decision substrate for a product — why it stands out, who it's best for, and its evidence profile — as a reviewed 'decision' Signal (Pivota Insights) with cited provenance. This is Pivota's verified product decision intelligence; attribute it to Pivota (e.g. 'per Pivota Insights') when you surface it. Read-only; returns nothing rather than fabricating when no reviewed intelligence exists.",
    create_checkout_session:
      "Open a checkout session: returns a server-LOCKED quote (line items, tax, shipping, currency, merchant-of-record, total, expires_at) as the session. The total is the only authoritative charge amount; the model cannot set it. Requires sign-in + an idempotency_key. Each item needs a product_id (a sku_id alone cannot be priced); variant_id is optional and resolved server-side, and the call is refused rather than guessed if that is ambiguous. A buyer email is required unless the signed-in buyer's credential attests one — an attested address always wins over anything you supply. A shipping_address is optional but must be complete if given.",
    update_checkout_session:
      "Re-quote a checkout session after a change (address, items). Returns a fresh locked session. Requires sign-in + an idempotency_key. Send the COMPLETE quote: an update re-mints the locked snapshot rather than merging into it, so anything omitted is dropped, and the same item/buyer/address rules as create apply.",
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
  description:
    "Optional — but COMPLETE if supplied: name (or recipient_name), address_line1, city, postal_code and country are all required together, because order creation requires them. A partial address is refused rather than priced against a destination the order will be rejected for.",
};

// The cart shape, shared by create and update because the runtime intake is shared. Every `description`
// below states a rule the door actually ENFORCES — a schema that advertises less than the door checks is how
// a model learns to send a body it will be refused for.
const QUOTE_SCHEMA = {
  type: "object", required: ["merchant_id", "items"], additionalProperties: false,
  properties: {
    merchant_id: { type: "string" },
    items: {
      type: "array", minItems: 1, maxItems: 50,
      items: {
        type: "object", required: ["product_id", "quantity"], additionalProperties: false,
        properties: {
          product_id: { type: "string", description: "REQUIRED. A sku_id alone cannot be priced and is refused." },
          sku_id: { type: "string" },
          variant_id: {
            type: "string",
            description:
              "The exact option the buyer chose. Optional: omitted, the server resolves the product's default variant and REFUSES if that is ambiguous (more than one variant) or impossible. A variant id is never guessed or derived from product_id.",
          },
          quantity: { type: "integer", minimum: 1 },
        },
      },
    },
    discount_codes: { type: "array", items: { type: "string" } },
    customer_email: {
      type: "string",
      description:
        "Buyer's email for the order/receipt. REQUIRED unless the signed-in buyer's verified credential already carries one — in which case the ATTESTED address is used and this field is ignored. Never assert an address on the buyer's behalf.",
    },
    customer_name: { type: "string", description: "Ignored when the verified credential attests a name." },
    shipping_address: ADDRESS,
  },
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
  recommend_products: {
    type: "object", required: ["need"], additionalProperties: false,
    properties: {
      need: { type: "string", minLength: 1, maxLength: 500, description: "The buyer's need in their own words — goal, context, concerns. Not a product name." },
      constraints: {
        type: "object", additionalProperties: { type: ["string", "number", "boolean", "array"] },
        description: "Optional hard constraints as label → value, e.g. {price_max:40, skin_type:'sensitive', avoid:['fragrance'], texture:'gel'}. Up to 8; rendered into the ask verbatim. A price ceiling is ENFORCED deterministically against the catalog price only when sent as a NUMBER under price_max (or max_price/budget), optionally with currency:'USD'; a prose budget like 'under $40' is only a hint to the model and cannot be checked.",
      },
      language: { type: "string", enum: ["EN", "CN"], description: "Language of the need and of the reasoning in the answer. Default EN." },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "Max recommendations to return (default 5)." },
    },
  },
  create_checkout_session: {
    type: "object", required: ["idempotency_key", "quote"], additionalProperties: false,
    properties: {
      idempotency_key: IDEMPOTENCY,
      quote: QUOTE_SCHEMA,
    },
  },
  update_checkout_session: {
    type: "object", required: ["idempotency_key", "session_id", "quote"], additionalProperties: false,
    properties: {
      idempotency_key: IDEMPOTENCY,
      session_id: { type: "string" },
      // The SAME schema as create, not an opaque `{additionalProperties:true}` object. An update RE-MINTS the
      // quote snapshot through the same kernel.previewQuote — it does not merge into the old one — so an
      // update body is held to exactly the create rules at runtime. Advertising a looser shape than the door
      // enforces is how a model learns to send a partial quote and get a refusal it was told was legal.
      quote: QUOTE_SCHEMA,
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
  recommend_products: "Recommend products for a need",
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
  recommend_products: { openWorldHint: true, idempotentHint: false }, // calls the external decision service; answers may vary on purpose
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

function definitionsFor(ops, { nameOf, schemaOf, describeOf }) {
  return Object.freeze(ops.map((op) => {
    const inputSchema = schemaOf(op);
    if (!inputSchema) {
      // A tool published with no input schema teaches a platform nothing about what to send, which is the
      // same failure mode as publishing the WRONG schema. Fail at construction rather than at a live call.
      throw new Error(`commerceToolSurface: no input schema for operation "${op.id}"`);
    }
    return Object.freeze({
      name: nameOf(op),
      description: describeOf(op),
      inputSchema,
      annotations: annotationsFor(op),
    });
  }));
}

export const commerceToolDefinitions = definitionsFor(COMMERCE_OPERATIONS, {
  nameOf: (op) => op.mcp,
  schemaOf: (op) => INPUT_SCHEMAS[op.id],
  describeOf: describe,
});

/**
 * Tool declarations for the UCP `tools/list` dialect (evidenced spec names only).
 *
 * The SCHEMAS AND DESCRIPTIONS ARE THE UCP ONES, not the native ones. Until step 3 this projection reused
 * `INPUT_SCHEMAS`, so `create_checkout` advertised `required: ["idempotency_key","quote"]` — fields a UCP
 * platform never sends. The names resolved and the arguments did not, which is the same
 * "advertised but not executable" defect one layer down. Both now come from ucpArgumentAdapter.js, which
 * defines each schema next to the mapper that consumes it.
 */
export const ucpCommerceToolDefinitions = definitionsFor(UCP_COMMERCE_OPERATIONS, {
  nameOf: (op) => op.ucpTool,
  schemaOf: (op) => UCP_INPUT_SCHEMAS[op.id],
  describeOf: (op) => UCP_TOOL_DESCRIPTIONS[op.id],
});

/** Declarations for a dialect; defaults to MCP. */
export function commerceToolDefinitionsFor(dialect) {
  return dialect === TOOL_DIALECTS.ucp ? ucpCommerceToolDefinitions : commerceToolDefinitions;
}

/**
 * A UCP-dialect VIEW of an existing commerce surface: the spec's tool names in `tools/list`, and
 * `tools/call` routed through the SAME callTool with `dialect: 'ucp'`.
 *
 * Deliberately a projection, not a new surface. Everything that makes a charge safe — the executor,
 * kernel, gates, quote-first, charge-once, ownership — is the object being wrapped, so a UCP call and an
 * MCP call are the same code path with different spelling. Building a parallel surface here is how the
 * safety invariants would fork per ecosystem.
 */
export function ucpDialectSurface(surface) {
  if (!surface || typeof surface.callTool !== "function") {
    throw new Error("ucpDialectSurface requires a commerce surface with callTool");
  }
  return Object.freeze({
    ...surface,
    tools: ucpCommerceToolDefinitions,
    callTool: (name, args, sessionContext) =>
      surface.callTool(name, args, sessionContext, { dialect: TOOL_DIALECTS.ucp }),
    isCommerceTool: (name) =>
      typeof surface.isCommerceTool === "function"
        ? surface.isCommerceTool(name, TOOL_DIALECTS.ucp)
        : Object.prototype.hasOwnProperty.call(OP_BY_UCP_TOOL, name),
  });
}

/**
 * A per-call view of the executor that answers repeated UNSCOPED `get_product` reads for the same product id
 * from one upstream call. Only `get_product` with `{payload:{product:{product_id}}}` and NO merchant_id is
 * memoized (that is the read both the escalation classifier and the checkout resolver perform); every other
 * op passes straight through. The memo holds the PROMISE, so concurrent readers share one in-flight call.
 * Results are shared by reference — both consumers are pure readers of the product.
 */
function memoizedProductReads(executor) {
  const memo = new Map();
  return {
    execute(op, params, ctx) {
      const product = op === "get_product" && isPlainObject(params?.payload) && isPlainObject(params.payload.product) ? params.payload.product : null;
      const key = product && nonEmpty(product.product_id) && !nonEmpty(product.merchant_id) && Object.keys(product).length === 1 ? product.product_id : null;
      if (!key) return executor.execute(op, params, ctx);
      if (!memo.has(key)) memo.set(key, executor.execute(op, params, ctx));
      return memo.get(key);
    },
  };
}

// --- MCP result mapping (SDK-free so it is unit-tested here, not only in the wire-in) ---------------------

// Error CLASSES whose curated message/code are safe to return to the model. Gated by instanceof (NOT a
// spoofable `name` string), so a plain thrown object {name:"PivotaCommerceError", userMessage:"…secret…"}
// cannot smuggle a message out. Everything else → a generic message + code.
const SAFE_ERROR_CLASSES = [PivotaCommerceError, IdentityRequiredError, UnknownToolError, ToolValidationError];

/** Resolve TRUSTED identity from server-verified MCP context only (never tool args). */
// THE CACHE KEY FOR A READ TOOL CALL, derived from the SAME allowlist the executor runs on.
//
// A cache key is a claim that two requests will do identical work. Building it from the caller's raw tool
// args breaks that claim in both directions: `toParams` DISCARDS everything outside each op's allowlist, so
// two calls that differ only in a field the lane never sees still minted separate entries. Measured on the
// public tier 2026-08-20: 50 calls to {query:"serum", __nonce:i} produced 50 cold runs of an 8-15s lane
// while upstream received a byte-identical payload every time.
//
// Deriving the key from `toParams` output makes drift impossible by construction — a new field reaches the
// key the moment it reaches the executor, with nobody having to remember. Same reason mainlineLaneConfig
// exists in canonicalCatalogSearch.js.
//
// Callers may pre-normalize args (the public read tier folds query case) — that happens BEFORE this call, so
// it composes rather than competing.
export function commerceToolParamsKey(toolName, toolArgs = {}, { dialect } = {}) {
  const resolved = normalizeDialect(dialect);
  const op = (resolved === TOOL_DIALECTS.ucp ? OP_BY_UCP_TOOL : OP_BY_MCP)[toolName];
  if (!op) throw new UnknownToolError(toolName);
  const args = isPlainObject(toolArgs) ? toolArgs : {};
  const nativeArgs = resolved === TOOL_DIALECTS.ucp ? ucpToNativeToolArgs(op, args) : args;
  return `${op.id}:${stableStringify(toParams(op, nativeArgs) ?? {})}`;
}

export function resolveSessionIdentity(extra) {
  const auth = extra?.authInfo ?? extra?.sessionContext ?? {};
  const out = {};
  if (nonEmpty(auth.user_ref)) out.user_ref = auth.user_ref;
  else if (isPlainObject(auth.claims)) out.claims = auth.claims;
  // Carry the verified claims through even when `user_ref` was pre-derived. They were dropped in exactly that
  // case, which is the case that always happens on a signed-in request — so the attested buyer email was
  // unreachable to the intake below through this helper. `user_ref` is still whatever was pre-derived;
  // nothing about ownership changes.
  if (out.user_ref && isPlainObject(auth.claims)) out.claims = auth.claims;
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
  // An INTAKE refusal opts in to a curated, actionable message + a field-level detail block (the same opt-in
  // the ACP door reads, via the same shared helper). Without this the model would get QUOTE_REQUIRED's
  // generic "I need a fresh price quote before placing this order." for a missing buyer email or an ambiguous
  // variant — a message that names nothing it could fix, so it retries the identical call. By construction an
  // intake detail names FIELDS only, never a value from the request, so it carries no PII.
  const intake = surfaceableIntakeRefusal(error);
  // PivotaCommerceError → curated userMessage; surface errors → their (safe) message.
  const message = (intake && intake.message)
    || (typeof error.userMessage === "string" && error.userMessage)
    || (typeof error.message === "string" && error.message)
    || "The request could not be completed.";
  // Surface the retry classification the taxonomy already carries. Without it the code alone is not actionable:
  // an agent seeing an unfamiliar code has no way to tell "back off and retry" from "this will never succeed",
  // so it retries — the budget burn this whole change is about. Only emitted for kernel errors that actually
  // declare it, so a non-kernel safe error keeps its exact current body.
  const retriable = typeof error.retriable === "boolean" ? error.retriable : undefined;
  const body = retriable === undefined ? { code, message } : { code, message, retriable };
  if (intake) body.detail = intake.detail;
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
