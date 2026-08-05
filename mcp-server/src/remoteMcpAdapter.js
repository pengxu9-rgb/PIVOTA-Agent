import { toToolError, toToolResult } from "./commerceToolSurface.js";

const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

/**
 * Framework-neutral remote MCP JSON-RPC adapter over the canonical commerce surface.
 *
 * The adapter intentionally owns only protocol mechanics. The host must authenticate the HTTP request and
 * supply a server-verified session context via `resolveSessionContext`; tool arguments are passed through the
 * commerce surface, where identity fields are allowlist-stripped and user-scoped tools fail closed without
 * `{ user_ref, acp_session_id }`.
 *
 * @param {{ tools:Array, callTool:Function }} surface
 * @param {{
 *   authenticate?: (req:object)=>Promise<any>|any,
 *   resolveSessionContext?: (req:object, authResult:any)=>Promise<object>|object,
 *   allowUnauthenticated?: boolean,
 *   serverInfo?: { name?:string, version?:string },
 *   protocolVersion?: string,
 * }} opts
 */
export function createRemoteMcpAdapter(surface, opts = {}) {
  const {
    authenticate,
    resolveSessionContext,
    allowUnauthenticated = false,
    serverInfo = { name: "pivota-commerce-mcp", version: "0.1.0" },
    protocolVersion = DEFAULT_PROTOCOL_VERSION,
    supportedProtocolVersions,
    // Optional custom tool-result formatter: (value, toolName) => MCP tool result. Defaults to the commerce
    // text-only wrapper; the public read tier supplies one that adds `structuredContent` + a human summary.
    formatResult = toToolResult,
  } = opts;
  const supportedVersions =
    Array.isArray(supportedProtocolVersions) && supportedProtocolVersions.length > 0
      ? supportedProtocolVersions
      : [protocolVersion];

  if (!surface || !Array.isArray(surface.tools) || typeof surface.callTool !== "function") {
    throw new Error("createRemoteMcpAdapter requires a canonical commerce surface");
  }
  if (typeof authenticate !== "function" && allowUnauthenticated !== true) {
    throw new Error("createRemoteMcpAdapter requires authenticate() or allowUnauthenticated:true");
  }

  async function handleJsonRpc(req) {
    let id = null;
    try {
      const rpc = parseJsonRpc(req);
      id = hasOwn(rpc, "id") ? rpc.id : null;
      const authResult = typeof authenticate === "function" ? await authenticate(req) : undefined;

      if (rpc.method === "initialize") {
        // Version negotiation: echo the client's requested version when this adapter supports it; otherwise
        // answer with the default (per MCP spec, the server replies with its preferred supported version).
        const requested = isPlainObject(rpc.params) ? rpc.params.protocolVersion : undefined;
        const negotiated =
          typeof requested === "string" && supportedVersions.includes(requested) ? requested : protocolVersion;
        return ok(id, {
          protocolVersion: negotiated,
          serverInfo,
          capabilities: { tools: {} },
        });
      }

      if (rpc.method === "tools/list") {
        return ok(id, { tools: surface.tools });
      }

      if (rpc.method === "tools/call") {
        const params = isPlainObject(rpc.params) ? rpc.params : {};
        if (typeof params.name !== "string" || params.name.trim() === "") {
          return jsonRpcError(id, -32602, "Invalid tools/call params.");
        }
        const sessionContext = typeof resolveSessionContext === "function"
          ? await resolveSessionContext(req, authResult)
          : defaultSessionContext(req, authResult);
        try {
          const value = await surface.callTool(params.name, params.arguments ?? {}, sessionContext ?? {});
          return ok(id, formatResult(value, params.name));
        } catch (error) {
          return ok(id, toToolError(error));
        }
      }

      if (rpc.method === "notifications/initialized") {
        return { status: 202, headers: jsonHeaders(), body: null };
      }

      return jsonRpcError(id, -32601, "Method not found.");
    } catch (error) {
      if (error?.rpc === true) {
        return jsonRpcError(null, -32600, "Invalid JSON-RPC request.");
      }
      return jsonRpcError(id, -32001, "Authentication failed.");
    }
  }

  return { handleJsonRpc };
}

/** Mount the adapter on an Express-style app. A raw-body parser is optional for MCP; parsed JSON is fine. */
export function mountRemoteMcp(app, adapter, { path = "/mcp" } = {}) {
  if (!app || typeof app.post !== "function") throw new Error("mountRemoteMcp requires an Express-style app");
  if (!adapter || typeof adapter.handleJsonRpc !== "function") throw new Error("mountRemoteMcp requires an adapter");
  app.post(path, async (req, res) => {
    const out = await adapter.handleJsonRpc(normalizeHttpRequest(req));
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    if (out.body == null) return res.status(out.status).end();
    return res.status(out.status).json(out.body);
  });
}

export function normalizeHttpRequest(req) {
  return {
    headers: req?.headers ?? {},
    rawBody: req?.rawBody,
    body: req?.body,
    authInfo: req?.authInfo,
    sessionContext: req?.sessionContext,
  };
}

function parseJsonRpc(req) {
  const body = parseBody(req);
  if (!isPlainObject(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    const err = new Error("Invalid JSON-RPC request.");
    err.rpc = true;
    throw err;
  }
  return body;
}

function parseBody(req) {
  if (isPlainObject(req?.body)) return req.body;
  const raw = rawBodyString(req?.rawBody);
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function rawBodyString(rawBody) {
  if (typeof rawBody === "string") return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody).toString("utf8");
  return undefined;
}

function defaultSessionContext(req, authResult) {
  const verified = authResult?.sessionContext ?? req?.sessionContext ?? req?.authInfo ?? {};
  const out = {};
  if (nonEmpty(verified.user_ref)) out.user_ref = verified.user_ref.trim();
  // Claims alongside user_ref, not instead of it — an `else if` here drops the attested buyer email on
  // every signed-in request, letting a model-asserted customer_email win. The gateway passes an explicit
  // resolveSessionContext today, but this is the adapter's documented DEFAULT.
  if (isPlainObject(verified.claims)) out.claims = verified.claims;
  if (nonEmpty(verified.acp_session_id)) out.acp_session_id = verified.acp_session_id.trim();
  if (nonEmpty(verified.agent_id)) out.agent_id = verified.agent_id.trim();
  return out;
}

function ok(id, result) {
  return { status: 200, headers: jsonHeaders(), body: { jsonrpc: "2.0", id, result } };
}

function jsonRpcError(id, code, message) {
  return { status: 200, headers: jsonHeaders(), body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function jsonHeaders() {
  return { "content-type": "application/json" };
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const p = Object.getPrototypeOf(value);
  return p === Object.prototype || p === null;
}
