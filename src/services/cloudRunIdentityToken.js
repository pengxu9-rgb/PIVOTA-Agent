'use strict';

/*
 * Cloud Run service-to-service authentication for Store Audit workers.
 *
 * Shared by the commerce probe worker and the UCP probe worker; each passes
 * its own audience (or the env var name it is configured under). The audience
 * is supplied by deployment configuration and must be the exact Cloud Run web
 * service origin. The metadata request is deliberately fixed; it never
 * derives a URL from a merchant or receipt payload.
 */

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

/**
 * @param {{
 *   audience?: string,        // explicit audience; wins over audienceEnvVar
 *   audienceEnvVar?: string,  // env var to read the audience from when `audience` is not supplied
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
function createCloudRunIdTokenProvider({
  audience,
  audienceEnvVar = 'STORE_AUDIT_COMMERCE_PROBE_ID_TOKEN_AUDIENCE',
  fetchImpl = global.fetch,
} = {}) {
  const validAudience = cloudRunAudience(audience != null ? audience : process.env[audienceEnvVar]);
  let pending;
  async function getToken() {
    if (!validAudience || typeof fetchImpl !== 'function') return null;
    if (!pending) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      pending = Promise.resolve(fetchImpl(`${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(validAudience)}&format=full`, {
        headers: { 'metadata-flavor': 'Google' }, redirect: 'error', signal: controller.signal,
      }))
        .then(async (response) => (response && response.ok ? String(await response.text()).trim() || null : null))
        .catch(() => null)
        .finally(() => clearTimeout(timer));
    }
    return pending;
  }
  return { audience: validAudience, getToken };
}

module.exports = { cloudRunAudience, createCloudRunIdTokenProvider };
