'use strict';

// Fixed Cloud Run metadata endpoint. Merchant URLs never influence auth.
const METADATA_IDENTITY_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

function cloudRunAudience(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch {
    return null;
  }
}

function createCloudRunIdTokenProvider({ audience = process.env.STORE_AUDIT_COMMERCE_PROBE_ID_TOKEN_AUDIENCE, fetchImpl = global.fetch } = {}) {
  const validAudience = cloudRunAudience(audience);
  let pending;
  async function getToken() {
    if (!validAudience || typeof fetchImpl !== 'function') return null;
    if (!pending) {
      pending = Promise.resolve(fetchImpl(`${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(validAudience)}&format=full`, {
        headers: { 'metadata-flavor': 'Google' }, redirect: 'error',
      }))
        .then(async (response) => (response && response.ok ? String(await response.text()).trim() || null : null))
        .catch(() => null);
    }
    return pending;
  }
  return { audience: validAudience, getToken };
}

module.exports = { cloudRunAudience, createCloudRunIdTokenProvider };
