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
    // For now we map Nina to the same demo merchant used elsewhere in this
    // gateway so that creator flows work out of the box in MOCK mode.
    merchantIds: ['merch_208139f7600dbf42'],
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

