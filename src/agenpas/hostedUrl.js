'use strict';

/*
 * The gateway's own check on a hosted page URL before the buyer's page may open it. The backend has already vetted
 * the URL against ITS allowlist; this is the second, independent gate, configured on the gateway
 * (AGENPAS_HOSTED_HOSTS; empty = refuse everything):
 *   - https only, default port only, no user-info;
 *   - the host is EXACTLY one of the allowlisted names (no suffix or wildcard matching);
 *   - at most 4096 characters.
 */

const MAX_URL_CHARS = 4096;

function isAllowedHostedUrl(url, allowedHosts) {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_CHARS) return false;
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port !== '' && u.port !== '443') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return allowedHosts.includes(host);
}

/** The https origins of the allowlist, for a CSP source list (embed mode). */
function hostedOrigins(allowedHosts) {
  return (Array.isArray(allowedHosts) ? allowedHosts : []).map((h) => `https://${h}`);
}

module.exports = { isAllowedHostedUrl, hostedOrigins };
