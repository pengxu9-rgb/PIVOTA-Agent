const AUTHORITATIVE_COMMERCE = 'authoritative_commerce';
const PUBLIC_OBSERVABILITY = 'public_observability';

const DEFAULT_INVOKE_BASE_URL = 'https://pivota-agent-production.up.railway.app';
const DEFAULT_PUBLIC_BASE_URL = 'https://agent.pivota.cc';
const DEFAULT_INVOKE_ENDPOINT = '/agent/shop/v1/invoke';
const DEFAULT_PUBLIC_ENDPOINT = '/api/gateway';

function normalizeRailMode(rawMode) {
  const normalized = String(rawMode || '').trim().toLowerCase();
  if (normalized === PUBLIC_OBSERVABILITY) return PUBLIC_OBSERVABILITY;
  return AUTHORITATIVE_COMMERCE;
}

function normalizeEndpoint(endpoint, railMode) {
  const text = String(endpoint || '').trim();
  if (text) {
    return text.startsWith('/') ? text : `/${text}`;
  }
  return normalizeRailMode(railMode) === PUBLIC_OBSERVABILITY
    ? DEFAULT_PUBLIC_ENDPOINT
    : DEFAULT_INVOKE_ENDPOINT;
}

function resolveBaseUrl(baseUrl, railMode) {
  const normalized = String(baseUrl || '').trim();
  if (normalized) return normalized.replace(/\/$/, '');
  return normalizeRailMode(railMode) === PUBLIC_OBSERVABILITY
    ? DEFAULT_PUBLIC_BASE_URL
    : DEFAULT_INVOKE_BASE_URL;
}

function assertRailAuth({
  railMode,
  authToken,
  agentApiKey,
  context = 'authoritative_commerce',
}) {
  if (normalizeRailMode(railMode) !== AUTHORITATIVE_COMMERCE) return;
  if (String(authToken || '').trim() || String(agentApiKey || '').trim()) return;
  throw new Error(
    `${context} requires AUTH_TOKEN or AGENT_API_KEY for ${DEFAULT_INVOKE_ENDPOINT}`,
  );
}

module.exports = {
  AUTHORITATIVE_COMMERCE,
  PUBLIC_OBSERVABILITY,
  DEFAULT_INVOKE_BASE_URL,
  DEFAULT_PUBLIC_BASE_URL,
  DEFAULT_INVOKE_ENDPOINT,
  DEFAULT_PUBLIC_ENDPOINT,
  normalizeRailMode,
  normalizeEndpoint,
  resolveBaseUrl,
  assertRailAuth,
};
