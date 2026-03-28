const { normalizeInvocationSurface } = require('../../../modules/contracts/invocationSurface');

function readHeader(headers = {}, key) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return '';
  return headers[key] || headers[key.toLowerCase()] || '';
}

function resolveInvocationSurface(input = {}, fallback = 'direct_api') {
  const headers = input.headers && typeof input.headers === 'object' ? input.headers : {};
  const candidates = [
    input.invocation_surface,
    input.invocationSurface,
    input.surface,
    input.invocation_profile && input.invocation_profile.surface,
    input.invocationProfile && input.invocationProfile.surface,
    readHeader(headers, 'x-pivota-invocation-surface'),
    readHeader(headers, 'x-invocation-surface'),
    readHeader(headers, 'x-mcp-surface'),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeInvocationSurface(candidate);
    if (normalized) return normalized;
  }
  return normalizeInvocationSurface(fallback, 'direct_api');
}

module.exports = {
  resolveInvocationSurface,
};
