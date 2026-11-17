'use strict';

// recommend_products' reviewed ingredient exclusion (gw#2582): `constraints.avoid` as a hard filter over
// reviewed US formula evidence, and the tool wording that tells an agent an ingredient "was absent".
// DEFAULT OFF. The matcher does not yet know an ingredient's salts, esters or fragrance components, so off,
// `avoid` is a hint to the model exactly as it was before gw#2582: no evidence lookup, no withheld items,
// no ingredient fields in the answer and the earlier tool descriptions. Read per call, so the dial needs no
// redeploy. Only '1' and 'true' turn it on.
const RECOMMEND_INGREDIENT_EXCLUSION_FLAG = 'AGENT_RECOMMEND_INGREDIENT_EXCLUSION_ENABLED';

function recommendIngredientExclusionEnabled(env = process.env) {
  const raw = env && env[RECOMMEND_INGREDIENT_EXCLUSION_FLAG];
  return ['1', 'true'].includes(String(raw == null ? '' : raw).trim().toLowerCase());
}

module.exports = { RECOMMEND_INGREDIENT_EXCLUSION_FLAG, recommendIngredientExclusionEnabled };
