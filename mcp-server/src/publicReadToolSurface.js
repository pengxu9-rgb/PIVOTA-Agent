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

  async function callTool(toolName, toolArgs = {}) {
    if (!PUBLIC_READ_TOOL_NAMES.includes(toolName)) {
      throw new UnknownToolError(toolName);
    }
    // Empty verified-session context: read ops are requiresUserRef:false and run anonymously; identity
    // fields in toolArgs are already allowlist-stripped by the commerce surface.
    const raw = await commerce.callTool(toolName, toolArgs, {});
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
