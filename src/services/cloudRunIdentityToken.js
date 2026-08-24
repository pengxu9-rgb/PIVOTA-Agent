'use strict';

/*
 * Cloud Run service-to-service authentication for the Store Audit worker.
 *
 * The audience is supplied by deployment configuration and must be the exact
 * Cloud Run web service origin. The metadata request is deliberately fixed;
 * it never derives a URL from a merchant or receipt payload.
 */

const METADATA_IDENTITY_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

function cloudRunAudience(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function createCloudRunIdTokenProvider({
  audience = process.env.STORE_AUDIT_UCP_PROBE_ID_TOKEN_AUDIENCE,
  fetchImpl = global.fetch,
} = {}) {
  const validAudience = cloudRunAudience(audience);
  let pending;

  async function getToken() {
    if (!validAudience || typeof fetchImpl !== 'function') return null;
    if (!pending) {
      const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(validAudience)}&format=full`;
      pending = Promise.resolve(fetchImpl(url, {
        headers: { 'metadata-flavor': 'Google' },
        redirect: 'error',
      }))
        .then(async (response) => {
          if (!response || !response.ok) return null;
          const token = String(await response.text()).trim();
          return token || null;
        })
        .catch(() => null);
    }
    return pending;
  }

  return { audience: validAudience, getToken };
}

module.exports = { cloudRunAudience, createCloudRunIdTokenProvider };
