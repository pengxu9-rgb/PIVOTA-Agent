import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { invokePivota, InvokeClientError } from "./invokeClient.js";
import { toolDefinitions } from "./operationMap.js";
import {
  redact,
  ToolValidationError
} from "./safety.js";
import { secureInvoke, IdentityRequiredError } from "./secureInvoke.js";

const server = new Server(
  {
    name: "pivota-mcp-server",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: toolArgs = {} } = request.params;

  try {
    // X-P0-1: resolve TRUSTED identity from the server-verified MCP session context, NOT from the
    // model's tool args. The OAuth layer (auth/) populates this on the authenticated session; we
    // read it here and let secureInvoke bind it + strip any model-supplied payload.user_ref.
    const identity = resolveSessionIdentity(extra);
    const response = await secureInvoke(name, toolArgs, identity);
    return toToolResult(response);
  } catch (error) {
    return toErrorToolResult(error);
  }
});

/**
 * Pull the verified identity the OAuth/session layer attached to this MCP request. Returns
 * { user_ref } or { claims }; an unauthenticated session yields {} so writes are refused downstream.
 * Kept deliberately small: identity must come from server-verified context, never from tool args.
 */
function resolveSessionIdentity(extra) {
  const auth = extra?.authInfo ?? extra?.sessionContext ?? {};
  if (typeof auth.user_ref === "string" && auth.user_ref.trim()) {
    return { user_ref: auth.user_ref };
  }
  if (auth.claims && typeof auth.claims === "object") {
    return { claims: auth.claims };
  }
  return {};
}

const transport = new StdioServerTransport();
await server.connect(transport);

function toToolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

/** Uniform error tool-result. Caller is responsible for redacting any body BEFORE passing it. */
function errorResult(errorObj) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: errorObj }, null, 2)
      }
    ]
  };
}

function toErrorToolResult(error) {
  // X-P0-1: a write without trusted identity is a clean, non-leaky refusal.
  if (error instanceof IdentityRequiredError) {
    return errorResult({ code: error.code, message: error.message });
  }

  // The kernel's strict validator (X-P2-4) throws PivotaCommerceError-shaped errors with a `code`.
  if (error && typeof error.code === "string" && error.name === "PivotaCommerceError") {
    return errorResult({ code: error.code, message: error.userMessage || "Request rejected." });
  }

  if (error instanceof ToolValidationError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: {
                code: error.code,
                message: error.message
              }
            },
            null,
            2
          )
        }
      ]
    };
  }

  if (error instanceof InvokeClientError) {
    // X-P2-1: the upstream error body may contain ap2_state / payment tokens / auth details.
    // Redact it before returning to the model/user instead of surfacing it verbatim.
    return errorResult({
      code: "PIVOTA_INVOKE_FAILED",
      message: error.message,
      status: error.status,
      body: redact(error.body)
    });
  }

  console.error(
    `Unexpected Pivota MCP error: ${JSON.stringify(
      redact({ name: error?.name, message: error?.message }),
      null,
      2
    )}`
  );

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: {
              code: "UNEXPECTED_ERROR",
              message: "Unexpected Pivota MCP server error."
            }
          },
          null,
          2
        )
      }
    ]
  };
}
