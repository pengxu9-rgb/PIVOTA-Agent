// The PUBLIC read-only MCP tool surface — the auth:none tier an app directory (OpenAI Apps SDK) points at.
// A strict subset of the commerce surface: the four discovery/intelligence read tools, no money, nothing
// user-scoped. Anonymous by construction: the session context handed to the commerce surface is ALWAYS
// empty, so no header, token, or model-supplied field can ever bind a buyer identity on this surface, and
// every tool outside the allowlist is refused as unknown BEFORE dispatch — on this surface the commerce
// tools do not exist (they are absent from tools/list, not "forbidden").
//
// get_offers is deliberately NOT on the v1 surface: cross-merchant offers concentrate reseller-sourced
// listings, which the app-directory sourcing policy excludes (docs/openai_apps_v1_plan.md §1, §5).

import { createCommerceToolSurface, UnknownToolError } from "./commerceToolSurface.js";
import { projectPublicReadResult } from "./publicReadProjection.js";
import {
  filterFirstPartyRows,
  isResellerRow,
  resellerHostSet,
  isFirstPartyOnlyEnabled,
} from "./publicReadSourcing.js";
import { createPublicReadCache, stableStringify } from "./publicReadCache.js";

export const PUBLIC_READ_TOOL_NAMES = Object.freeze([
  "search_catalog",
  "get_product",
  "get_intel",
  "get_alternatives",
]);

// Public PDP base for citable URLs, overridable via env so a domain move needs no code change.
const PUBLIC_PDP_BASE =
  (typeof process !== "undefined" && process.env && process.env.PUBLIC_READ_PDP_BASE) ||
  "https://agent.pivota.cc";

// De-marketed, plain-language descriptions for the public app surface (docs/openai_apps_v1_plan.md §4).
// The commerce descriptions carry attribution/marketing tone ("why it stands out", "per Pivota Insights")
// and, for search, a broad-trigger phrasing the review bar prohibits. The public surface presents accurate,
// narrow descriptions instead; the only attribution that survives is a factual "cite the citation URLs".
const PUBLIC_DESCRIPTIONS = Object.freeze({
  search_catalog:
    "Search Pivota's normalized catalog of beauty and skincare products by query, category, or price " +
    "range. Returns product identity, price, availability, key active ingredients, and a canonical Pivota " +
    "URL for each result. Read-only.",
  get_product:
    "Get detail for one product by its Pivota product_id (the id returned by search_catalog): " +
    "description, ingredient list, images, price, availability, and a canonical Pivota URL. Pass " +
    "include:['decision'] to also attach an evidence-graded decision summary when reviewed intelligence " +
    "exists. Read-only.",
  get_intel:
    "Get Pivota's reviewed intelligence for a product: a plain-language summary, who it suits, and " +
    "evidence-graded claims, each with citation URLs (e.g. PubMed). Cite the provided citation URLs when " +
    "repeating these claims. Returns empty when no reviewed intelligence exists rather than guessing. " +
    "Read-only.",
  get_alternatives:
    "Find reviewed alternatives or related products for a given product, with price comparison, tradeoffs, " +
    "and cited evidence. Cheaper look-alikes ('dupes') are returned only when explicitly requested. " +
    "Read-only.",
});

// Apply the public presentation to a read tool: the de-marketed description, and — for get_product only —
// relax the schema so it resolves by the single public sig id alone (the backend product cache matches by
// product_id when merchant_id is absent; routes/agent_shop_gateway.py _load_product_by_id). Annotations are
// inherited unchanged from the commerce definition (readOnlyHint:true, openWorldHint:false on all four).
function publicPresentation(tool) {
  const next = { ...tool };
  if (PUBLIC_DESCRIPTIONS[tool.name]) next.description = PUBLIC_DESCRIPTIONS[tool.name];
  if (tool.name === "get_product" && tool.inputSchema) {
    next.inputSchema = { ...tool.inputSchema, required: ["product_id"] };
  }
  return next;
}

/**
 * Build the public read surface over an already-composed canonical executor (the SAME shared executor the
 * commerce /mcp door uses — one kernel, never a second).
 * @param {{ execute: (opId:string, params:object, ctx:object)=>Promise<any> }} executor
 * @param {{ log?: object }} [opts]
 * @returns {{ tools: Array<{name,description,inputSchema}>, callTool: Function, isPublicReadTool: Function }}
 */
export function createPublicReadToolSurface(executor, { log } = {}) {
  const commerce = createCommerceToolSurface(executor, { log });
  const tools = commerce.tools
    .filter((tool) => PUBLIC_READ_TOOL_NAMES.includes(tool.name))
    .map((tool) => publicPresentation({ ...tool }));
  if (tools.length !== PUBLIC_READ_TOOL_NAMES.length) {
    // Fail loud at construction: a missing read tool means the canonical contract changed under us and the
    // public app would silently lose capability.
    throw new Error("public read surface: expected read tools missing from the commerce surface");
  }

  const logger = log && typeof log.info === "function" ? log : null;
  const extraHostsCsv =
    (typeof process !== "undefined" && process.env && process.env.PUBLIC_READ_RESELLER_HOSTS) || "";

  // Projected-result cache (TTL + stale-while-revalidate): the mainline multi-merchant search costs ~8–15s
  // per cold query (sequential recall legs — a search-perf workstream of its own); the public tier serves
  // deterministic, slowly-changing catalog reads, so cached/popular queries answer in <100ms while cold
  // queries keep the honest full cost. Caches ONLY successful projected values (≤ ~25KB each). Disable via
  // PUBLIC_READ_CACHE_ENABLED=0; tune PUBLIC_READ_CACHE_TTL_MS / PUBLIC_READ_CACHE_STALE_MS /
  // PUBLIC_READ_CACHE_MAX.
  const env = (typeof process !== "undefined" && process.env) || {};
  const cacheEnabled = !["0", "false", "off", "no"].includes(String(env.PUBLIC_READ_CACHE_ENABLED ?? "").trim().toLowerCase() || "on");
  const cache = cacheEnabled
    ? createPublicReadCache({
        ttlMs: Number(env.PUBLIC_READ_CACHE_TTL_MS) > 0 ? Number(env.PUBLIC_READ_CACHE_TTL_MS) : 10 * 60 * 1000,
        staleMs: Number(env.PUBLIC_READ_CACHE_STALE_MS) > 0 ? Number(env.PUBLIC_READ_CACHE_STALE_MS) : 60 * 60 * 1000,
        maxEntries: Number(env.PUBLIC_READ_CACHE_MAX) > 0 ? Number(env.PUBLIC_READ_CACHE_MAX) : 300,
        onRevalidateError: (err, key) => {
          if (logger) logger.warn({ err: err?.message || String(err), key }, "public_read cache revalidation failed (stale kept)");
        },
      })
    : null;

  async function callTool(toolName, toolArgs = {}) {
    if (!PUBLIC_READ_TOOL_NAMES.includes(toolName)) {
      throw new UnknownToolError(toolName);
    }
    if (!cache) return computeTool(toolName, toolArgs);
    const key = `${toolName}:${stableStringify(toolArgs ?? {})}`;
    return cache.getOrCompute(key, () => computeTool(toolName, toolArgs));
  }

  async function computeTool(toolName, toolArgs) {
    // Empty verified-session context: read ops are requiresUserRef:false and run anonymously; identity
    // fields in toolArgs are already allowlist-stripped by the commerce surface.
    let raw = await commerce.callTool(toolName, toolArgs, {});

    // First-party / brand-official sourcing filter (docs/openai_apps_v1_plan.md §5): drop reseller-sourced
    // rows BEFORE projection (the projector strips the destination host the filter needs). ON by default
    // within the public tier; PUBLIC_READ_FIRST_PARTY_ONLY=0 disables. Runs on the raw list-bearing shape.
    if (isFirstPartyOnlyEnabled()) {
      if (toolName === "search_catalog" && raw && Array.isArray(raw.products)) {
        const { kept, droppedCount } = filterFirstPartyRows(raw.products, { extraHostsCsv });
        if (droppedCount > 0) {
          // No silent caps: record what the sourcing policy removed (§5).
          if (logger) logger.info({ tool: toolName, dropped_reseller_rows: droppedCount, kept: kept.length }, "public_read sourcing filter");
          raw = { ...raw, products: kept };
        }
      } else if (toolName === "get_product") {
        // A directly-requested reseller product is not surfaced either (consistent with search).
        const detail = raw && typeof raw === "object" && raw.product && typeof raw.product === "object" ? raw.product : raw;
        if (isResellerRow(detail, resellerHostSet(extraHostsCsv))) {
          if (logger) logger.info({ tool: toolName }, "public_read sourcing filter: reseller product withheld");
          return { note: "Product not found." };
        }
      }
    }

    // Slim the verbose internal result to the public allowlisted shape (docs/openai_apps_v1_plan.md §3):
    // strips diagnostics/telemetry/internal ids/timestamps, caps size. The search limit is threaded so the
    // projector honors the requested page size even though the upstream ignores it.
    const limit =
      toolName === "search_catalog" && toolArgs && typeof toolArgs.page_size === "number"
        ? toolArgs.page_size
        : undefined;
    return projectPublicReadResult(toolName, raw, { base: PUBLIC_PDP_BASE, limit });
  }

  function isPublicReadTool(name) {
    return PUBLIC_READ_TOOL_NAMES.includes(name);
  }

  return { tools, callTool, isPublicReadTool };
}

// ---- MCP tool-result formatting (structuredContent + human summary) ---------------------------------------
// docs/openai_apps_v1_plan.md §6 (v1): return the slim projected object as `structuredContent` (what the
// model/app consumes) ALONGSIDE a short human-readable `content` text block. No custom widget / resources
// in v1 — that's the fast-follow. The projected value is already slim + leak-free (PR-2), so it is safe to
// surface verbatim as structuredContent.

function pluralize(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Build a concise, honest human summary from the already-projected value (never re-derives from raw).
function summarizePublicReadValue(value, toolName) {
  const v = value && typeof value === "object" ? value : {};
  switch (toolName) {
    case "search_catalog": {
      const products = Array.isArray(v.products) ? v.products : [];
      if (products.length === 0) return v.note || "No products matched this search.";
      const names = products
        .slice(0, 3)
        .map((p) => [p.brand, p.title].filter(Boolean).join(" ").trim())
        .filter(Boolean);
      const lead = `Found ${pluralize(products.length, "product", "products")}`;
      const tail = typeof v.total === "number" && v.total > products.length ? ` of ${v.total}` : "";
      return names.length ? `${lead}${tail}: ${names.join("; ")}.` : `${lead}${tail}.`;
    }
    case "get_product": {
      if (v.note && !v.product_id) return v.note;
      const name = [v.brand, v.title].filter(Boolean).join(" ").trim() || "Product";
      const price = v.price && typeof v.price.amount === "number"
        ? ` — ${v.price.amount}${v.price.currency ? " " + v.price.currency : ""}`
        : "";
      const intel = v.decision ? " (reviewed intelligence available)" : "";
      return `${name}${price}${intel}.`;
    }
    case "get_intel": {
      if (!v.intel) return v.note || "No reviewed intelligence for this product yet.";
      const grade = v.intel.grade ? `evidence grade ${v.intel.grade}` : "reviewed intelligence";
      const claims = Array.isArray(v.intel.claims) ? v.intel.claims.length : 0;
      return claims
        ? `Pivota ${grade} with ${pluralize(claims, "cited claim", "cited claims")}.`
        : `Pivota ${grade}.`;
    }
    case "get_alternatives": {
      const alts = Array.isArray(v.alternatives) ? v.alternatives : [];
      if (alts.length === 0) return v.note || "No reviewed alternatives for this product yet.";
      return `Found ${pluralize(alts.length, "alternative", "alternatives")}.`;
    }
    default:
      return "";
  }
}

/**
 * Format a public read tool's projected value as an MCP tool result: the projected object as
 * `structuredContent` for the app/model, plus a short human-readable text `content` block.
 */
export function formatPublicReadToolResult(value, toolName) {
  const summary = summarizePublicReadValue(value, toolName);
  return {
    content: [{ type: "text", text: summary || JSON.stringify(value) }],
    structuredContent: value,
  };
}
