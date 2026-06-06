// EXAMPLE wire-in (not started by default) — how the MCP commerce tool surface composes end to end:
//
//   verified MCP session ──identity──┐
//                                    ▼
//   model tool call ─► commerceToolSurface.callTool(name, args, sessionContext)
//                                    │  (strips identity from args; binds it from the session)
//                                    ▼
//                          canonicalExecutor.execute(opId, params, ctx)
//                                    │  (enforces the contract flags ONCE)
//                                    ▼
//                              SafetyKernel  +  reads upstream  +  payment-authorization verifier
//
// This is the kernel-DIRECT commerce path (UCP/Gemini + Claude-over-MCP). It is intentionally separate from
// the legacy operationMap tools that POST to the HTTP gateway (src/server.js) — pick one per deployment.
//
// Kept as `.example.js` so it never auto-runs; copy into a real entrypoint when wiring to prod.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { SafetyKernel } from "../../safety-kernel/src/kernel.js";
import { createCanonicalExecutor } from "../../safety-kernel/src/protocol/canonicalExecutor.js";
import {
  createCommerceToolSurface, resolveSessionIdentity, toToolResult, toToolError,
} from "./commerceToolSurface.js";

// re-export the SDK-free glue so callers can import everything from one place
export { resolveSessionIdentity, toToolResult, toToolError };

/**
 * Compose the surface. The two injected functions are the only deployment-specific pieces:
 *  - merchantRead(op, payload): the read path for discovery (find_products / get_product_detail) — your
 *    merchant connector or the read side of the gateway.
 *  - verifyPaymentAuthorization(authorization, bound): MUST throw OR return a positive attestation
 *    {ok:true, amount, currency, user_ref} that matches `bound` (the authoritative order amount/currency/
 *    buyer). This is where the ACP delegated token / UCP payment handler / AP2 mandate is verified.
 */
export function composeCommerceSurface({ kernelUpstream, merchantRead, verifyPaymentAuthorization, secret, log = console }) {
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret, log });
  const executor = createCanonicalExecutor({ kernel, upstream: merchantRead, verifyPaymentAuthorization });
  return createCommerceToolSurface(executor, { log });
}

/** Mount the surface onto an MCP Server's ListTools + CallTool handlers. The identity resolution + the
 *  non-leaky error mapping live in the SDK-free surface module (resolveSessionIdentity / toToolResult /
 *  toToolError) so they are unit-tested there; this is just the SDK glue. */
export function mountCommerceSurface(server, surface) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: surface.tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: toolArgs = {} } = request.params;
    try {
      const result = await surface.callTool(name, toolArgs, resolveSessionIdentity(extra));
      return toToolResult(result);
    } catch (error) {
      return toToolError(error);
    }
  });
}

// Example boot (commented — fill in the deployment-specific pieces):
//
//   const surface = composeCommerceSurface({
//     kernelUpstream: realKernelUpstream,       // preview_quote / create_order / submit_payment
//     merchantRead: realMerchantRead,           // find_products / get_product_detail
//     verifyPaymentAuthorization: verifyDelegatedTokenOrMandate,
//     secret: process.env.CONFIRMATION_SECRET,
//   });
//   const server = new Server({ name: "pivota-commerce-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
//   mountCommerceSurface(server, surface);
//   await server.connect(new StdioServerTransport());
