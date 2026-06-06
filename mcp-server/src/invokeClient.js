import { redact } from "./safety.js";

const CANONICAL_PATH = "/agent/shop/v1/invoke";
const FORBIDDEN_RAILS = ["/agent/gateway", "/api/gateway"];

export class InvokeClientError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "InvokeClientError";
    this.status = status;
    this.body = body;
  }
}

export async function invokePivota({
  operation,
  payload,
  idempotencyKey,
  gatewayUrl = process.env.PIVOTA_GATEWAY_URL,
  agentKey = process.env.PIVOTA_AGENT_KEY,
  fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== "function") {
    throw new InvokeClientError(
      "No fetch implementation is available. Node 18+ is required."
    );
  }

  if (!agentKey) {
    throw new InvokeClientError("PIVOTA_AGENT_KEY is required.");
  }

  const endpoint = buildInvokeEndpoint(gatewayUrl);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${agentKey}`
  };

  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  debugLog("Pivota invoke request", {
    endpoint,
    operation,
    payload,
    headers
  });

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ operation, payload })
  });

  const body = await readResponseBody(response);

  debugLog("Pivota invoke response", {
    status: response.status,
    body
  });

  if (!response.ok) {
    throw new InvokeClientError(`Pivota invoke failed with HTTP ${response.status}.`, {
      status: response.status,
      body
    });
  }

  return body;
}

export function buildInvokeEndpoint(gatewayUrl) {
  if (!gatewayUrl || typeof gatewayUrl !== "string") {
    throw new InvokeClientError("PIVOTA_GATEWAY_URL is required.");
  }

  const trimmed = gatewayUrl.replace(/\/+$/, "");
  const endpoint = trimmed.endsWith(CANONICAL_PATH)
    ? trimmed
    : `${trimmed}${CANONICAL_PATH}`;

  for (const forbidden of FORBIDDEN_RAILS) {
    if (endpoint.includes(forbidden)) {
      throw new InvokeClientError(
        `Forbidden Pivota rail configured: ${forbidden}. Use only ${CANONICAL_PATH}.`
      );
    }
  }

  if (!endpoint.endsWith(CANONICAL_PATH)) {
    throw new InvokeClientError(
      `Invalid Pivota endpoint. Use only ${CANONICAL_PATH}.`
    );
  }

  return endpoint;
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function debugLog(message, value) {
  if (process.env.PIVOTA_MCP_DEBUG !== "1") {
    return;
  }

  console.error(
    `${message}: ${JSON.stringify(redact(value), null, 2)}`
  );
}
