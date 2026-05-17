/**
 * Lightweight creator configuration.
 *
 * This is intentionally simple and in-memory for now so we can
 * later replace it with a DB-backed or remote configuration without
 * changing call sites.
 */

/**
 * @typedef {Object} CreatorConfig
 * @property {string} creatorId
 * @property {string[]} merchantIds
 */

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const s = String(value || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function parseCreatorConfigsFromEnv() {
  const rawJson = String(process.env.CREATOR_CONFIGS_JSON || '').trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => ({
            creatorId: String(item?.creatorId || item?.creator_id || '').trim(),
            merchantIds: uniqueStrings(item?.merchantIds || item?.merchant_ids),
          }))
          .filter((item) => item.creatorId && item.merchantIds.length > 0);
      }
    } catch (_) {
      // Fall through to compact env parsing.
    }
  }

  const defaultCreatorId = String(process.env.DEFAULT_CREATOR_ID || process.env.CREATOR_ID || '').trim();
  const merchantIds = uniqueStrings(
    String(process.env.CREATOR_CATALOG_MERCHANT_IDS || '')
      .split(',')
      .map((item) => item.trim()),
  );
  return defaultCreatorId && merchantIds.length
    ? [{ creatorId: defaultCreatorId, merchantIds }]
    : [];
}

/** @type {CreatorConfig[]} */
const CREATOR_CONFIGS = parseCreatorConfigsFromEnv();

/**
 * Resolve the configuration for a given creator id / slug.
 *
 * @param {string} creatorId
 * @returns {CreatorConfig|undefined}
 */
function getCreatorConfig(creatorId) {
  if (!creatorId) return undefined;
  return CREATOR_CONFIGS.find((c) => c.creatorId === creatorId);
}

module.exports = {
  CREATOR_CONFIGS,
  getCreatorConfig,
};
