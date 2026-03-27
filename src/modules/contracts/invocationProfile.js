const { normalizeInvocationSurface } = require('./invocationSurface');

const TRANSPORTS = new Set(['http', 'websocket', 'rpc', 'stream']);
const AUTH_SCHEMES = new Set(['api_key', 'oauth', 'signed_request', 'session', 'delegated', 'unknown']);
const CONTINUATION_MODES = new Set(['none', 'cursor', 'callback', 'session_token']);
const RESPONSE_MODES = new Set(['sync', 'async', 'streaming']);

const DEFAULTS_BY_SURFACE = Object.freeze({
  acp: Object.freeze({
    protocol_family: 'ACP',
    transport: 'http',
    auth_scheme: 'signed_request',
    continuation_mode: 'callback',
    response_mode: 'async',
    supports_callbacks: true,
    supports_capability_negotiation: true,
  }),
  ucp: Object.freeze({
    protocol_family: 'UCP',
    transport: 'rpc',
    auth_scheme: 'delegated',
    continuation_mode: 'session_token',
    response_mode: 'streaming',
    supports_callbacks: true,
    supports_capability_negotiation: true,
  }),
  ap2: Object.freeze({
    protocol_family: 'AP2',
    transport: 'rpc',
    auth_scheme: 'signed_request',
    continuation_mode: 'session_token',
    response_mode: 'async',
    supports_callbacks: true,
    supports_capability_negotiation: true,
  }),
  direct_api: Object.freeze({
    protocol_family: 'DIRECT_API',
    transport: 'http',
    auth_scheme: 'api_key',
    continuation_mode: 'none',
    response_mode: 'sync',
    supports_callbacks: false,
    supports_capability_negotiation: false,
  }),
  mcp: Object.freeze({
    protocol_family: 'MCP',
    transport: 'rpc',
    auth_scheme: 'delegated',
    continuation_mode: 'session_token',
    response_mode: 'streaming',
    supports_callbacks: false,
    supports_capability_negotiation: true,
  }),
});

function cloneJsonSafe(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeToken(value, allowedValues, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return allowedValues.has(normalized) ? normalized : fallback;
}

function sanitizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function buildInvocationProfile(input = {}) {
  const surface = normalizeInvocationSurface(input.surface || input.invocation_surface, 'direct_api');
  const defaults = DEFAULTS_BY_SURFACE[surface] || DEFAULTS_BY_SURFACE.direct_api;

  return {
    surface,
    protocol_family: String(input.protocol_family || defaults.protocol_family).trim() || defaults.protocol_family,
    protocol_version: String(input.protocol_version || '').trim() || null,
    transport: normalizeToken(input.transport, TRANSPORTS, defaults.transport),
    auth_scheme: normalizeToken(input.auth_scheme, AUTH_SCHEMES, defaults.auth_scheme),
    continuation_mode: normalizeToken(input.continuation_mode, CONTINUATION_MODES, defaults.continuation_mode),
    response_mode: normalizeToken(input.response_mode, RESPONSE_MODES, defaults.response_mode),
    supports_callbacks:
      input.supports_callbacks === undefined ? defaults.supports_callbacks : input.supports_callbacks === true,
    supports_capability_negotiation:
      input.supports_capability_negotiation === undefined
        ? defaults.supports_capability_negotiation
        : input.supports_capability_negotiation === true,
    declared_capabilities: sanitizeCapabilities(input.declared_capabilities),
  };
}

function cloneInvocationProfile(profile) {
  return buildInvocationProfile(cloneJsonSafe(profile || {}));
}

module.exports = {
  DEFAULTS_BY_SURFACE,
  buildInvocationProfile,
  cloneInvocationProfile,
};
