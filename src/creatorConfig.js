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

/** @type {CreatorConfig[]} */
const CREATOR_CONFIGS = [
  {
    creatorId: 'nina-studio',
    // NOTE: Currently mapped to the live "Chydan" merchant so that
    // creator flows have real products in production.
    // This can be adjusted later or driven from DB.
    merchantIds: ['merch_efbc46b4619cfbdf'],
  },
  {
    // Alias used by creator UI demo fixtures.
    creatorId: 'creator_demo_001',
    merchantIds: ['merch_efbc46b4619cfbdf'],
  },
];

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
