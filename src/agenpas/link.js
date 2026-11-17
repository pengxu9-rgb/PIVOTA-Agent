'use strict';

/*
 * Minting the buyer's AgenPas link, `<AGENPAS_PUBLIC_BASE_URL>/agenpas/p/<purchase id>#t=<link token>`.
 *
 * THE TOKEN IS IN THE FRAGMENT: a browser never sends `#…` to a server, so the token never reaches an access log,
 * an edge log or our request log. The page reads it from `location.hash`, clears the hash, and sends the token only
 * in the `X-Agenpas-Link` header of its API calls.
 *
 * Used by `start_purchase` and by `get_order` for an A2A-rail purchase (mcp-server/src/commerceToolSurface.js) to add
 * `agenpas_url` to the answer (a fresh link on every call). Every
 * precondition is checked per call and any miss answers null, which the caller reads as "add nothing": the flag
 * (AGENPAS_ENABLED), the secret, the public base URL, a well-formed purchase id, and the VERIFIED caller identity
 * (agent id + user ref from the server-side request context, never from tool arguments).
 */

const config = require('./config');
const { PURCHASE_ID_RE, mintLinkToken } = require('./linkToken');

const PAGE_PATH_PREFIX = '/agenpas/p/';

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** The link for one purchase, or null when AgenPas is off or anything it needs is missing. Never throws. */
function mintAgenpasUrl({ purchaseId, agentId, userRef, env = process.env, now } = {}) {
  try {
    if (!config.isEnabled(env)) return null;
    const secret = config.linkSecret(env);
    const base = config.publicBaseUrl(env);
    if (!secret || !base) return null;
    if (typeof purchaseId !== 'string' || !PURCHASE_ID_RE.test(purchaseId)) return null;
    if (!nonEmpty(agentId) || !nonEmpty(userRef)) return null;
    const token = mintLinkToken({
      purchaseId, agentId: agentId.trim(), userRef: userRef.trim(), aud: base, secret, ttlSeconds: config.linkTtlSeconds(env), now,
    });
    return `${base}${PAGE_PATH_PREFIX}${purchaseId}#t=${token}`;
  } catch {
    return null;
  }
}

/** True only while a link can be minted: the flag on, a usable secret, and a public base URL. */
function agenpasLinksAvailable(env = process.env) {
  try {
    return config.isEnabled(env) && Boolean(config.linkSecret(env)) && Boolean(config.publicBaseUrl(env));
  } catch {
    return false;
  }
}

/** The minter the tool surface takes (`orchestratedPurchase.agenpasLink`). */
function createAgenpasLinkMinter({ env } = {}) {
  return Object.freeze({
    mint: (input) => mintAgenpasUrl({ ...input, ...(env ? { env } : {}) }),
    available: () => agenpasLinksAvailable(env || process.env),
    ttlMinutes: () => config.linkTtlMinutes(env || process.env),
  });
}

module.exports = {
  PAGE_PATH_PREFIX,
  agenpasLinksAvailable,
  createAgenpasLinkMinter,
  mintAgenpasUrl,
};
