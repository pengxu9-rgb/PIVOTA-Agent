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

export const PUBLIC_READ_TOOL_NAMES = Object.freeze([
  "search_catalog",
  "get_product",
  "get_intel",
  "get_alternatives",
]);

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
    .map((tool) => ({ ...tool }));
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
    return commerce.callTool(toolName, toolArgs, {});
  }

  function isPublicReadTool(name) {
    return PUBLIC_READ_TOOL_NAMES.includes(name);
  }

  return { tools, callTool, isPublicReadTool };
}
