'use strict';

const assert = require('node:assert/strict');

const INGREDIENT_EXCLUSION_DESCRIPTION = ' For an explicit ingredient exclusion, pass constraints.avoid as a list of names. For each returned product, say the requested ingredient was absent from its current reviewed US ingredient list. This check covers named ingredients on the label; trace contaminants and cross-contact remain unverified. Read ingredient_exclusion_verification for withheld counts and no_verified_ingredient_matches for an empty result caused by this check.';
const CONSTRAINTS_DESCRIPTION = "Optional constraints, e.g. {price_max:40, skin_type:'sensitive', avoid:['snail mucin'], texture:'gel'}. Send explicit ingredient exclusions in avoid as up to 8 named ingredients. The shortlist requires current reviewed US formula evidence for each exclusion and may be empty. Unsupported ingredient names are reported as unverified. Send a numeric price_max (or max_price/budget) for a deterministic price check. Other constraints guide the model.";
const PREVIOUS_CONSTRAINTS_DESCRIPTION = "Optional hard constraints as label → value, e.g. {price_max:40, skin_type:'sensitive', avoid:['fragrance'], texture:'gel'}. Up to 8; rendered into the ask verbatim. A price ceiling is ENFORCED deterministically against the catalog price only when sent as a NUMBER under price_max (or max_price/budget), optionally with currency:'USD'; a prose budget like 'under $40' is only a hint to the model and cannot be checked.";

function replaceDescription(body, current, previous) {
  const serialized = JSON.stringify(current);
  assert.equal(body.split(serialized).length, 2, 'the description appears exactly once');
  return body.replace(serialized, () => JSON.stringify(previous));
}

// The native tool list golden hashes predate reviewed ingredient exclusions. Pin both published edits
// to the recommend_products declaration, then restore the two values without reserializing the rest.
function revertRecommendationIngredientDescriptionEdits(body) {
  const tools = JSON.parse(body).result.tools.filter((tool) => tool.name === 'recommend_products');
  assert.equal(tools.length, 1, 'the native list publishes one recommend_products declaration');
  const [tool] = tools;
  assert.equal(tool.description.split(INGREDIENT_EXCLUSION_DESCRIPTION).length, 2,
    'recommend_products documents reviewed ingredient exclusions exactly once');
  assert.equal(tool.inputSchema.properties.constraints.description, CONSTRAINTS_DESCRIPTION);

  const reverted = replaceDescription(body, tool.description, tool.description.replace(INGREDIENT_EXCLUSION_DESCRIPTION, ''));
  return replaceDescription(reverted, CONSTRAINTS_DESCRIPTION, PREVIOUS_CONSTRAINTS_DESCRIPTION);
}

module.exports = { revertRecommendationIngredientDescriptionEdits };
