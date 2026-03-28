const INVOCATION_SURFACES = Object.freeze([
  'acp',
  'ucp',
  'ap2',
  'direct_api',
  'mcp',
]);

const INVOCATION_SURFACE_ALIASES = Object.freeze({
  acp: 'acp',
  ucp: 'ucp',
  ap2: 'ap2',
  api: 'direct_api',
  'direct-api': 'direct_api',
  direct_api: 'direct_api',
  directapi: 'direct_api',
  mcp: 'mcp',
});

function normalizeInvocationSurface(value, fallback = null) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '_');
  return INVOCATION_SURFACE_ALIASES[normalized] || fallback;
}

function isInvocationSurface(value) {
  return normalizeInvocationSurface(value) !== null;
}

module.exports = {
  INVOCATION_SURFACES,
  normalizeInvocationSurface,
  isInvocationSurface,
};
