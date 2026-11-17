'use strict';

/*
 * Minting the buyer's AgenPas link, `<AGENPAS_PUBLIC_BASE_URL>/agenpas/p/<purchase id>?t=<link token>`.
 *
 * Used by `start_purchase` (mcp-server/src/commerceToolSurface.js) to add `agenpas_url` to its answer. Every
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
      purchaseId, agentId: agentId.trim(), userRef: userRef.trim(), secret, ttlSeconds: config.linkTtlSeconds(env), now,
    });
    return `${base}${PAGE_PATH_PREFIX}${purchaseId}?t=${token}`;
  } catch {
    return null;
  }
}

/** The minter the tool surface takes (`orchestratedPurchase.agenpasLink`). */
function createAgenpasLinkMinter({ env } = {}) {
  return Object.freeze({
    mint: (input) => mintAgenpasUrl({ ...input, ...(env ? { env } : {}) }),
  });
}

module.exports = {
  PAGE_PATH_PREFIX,
  createAgenpasLinkMinter,
  mintAgenpasUrl,
};
