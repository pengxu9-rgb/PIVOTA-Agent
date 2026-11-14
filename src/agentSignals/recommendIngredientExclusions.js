'use strict';

const {
  STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES,
  normalizeForMatch,
  productIngredientMention,
  productNamesIngredientFamily,
} = require('../findProductsMulti/strictIngredientQuery');

const EXTRA_ALIASES = new Map([
  ['snail mucin', 'snail_secretion_filtrate'],
  ['snail secretion filtrate', 'snail_secretion_filtrate'],
  ['fragrance', 'fragrance'],
  ['parfum', 'fragrance'],
  ['perfume', 'fragrance'],
]);

const EXTRA_DECLARATIONS = {
  snail_secretion_filtrate: ['snail secretion filtrate', 'snail mucin', 'snail extract', 'snail secretion'],
  fragrance: ['fragrance', 'parfum', 'perfume', 'aroma'],
};

function readIngredientExclusions(constraints) {
  const avoid = constraints?.avoid;
  if (avoid == null || (Array.isArray(avoid) && avoid.length === 0)) return null;
  const values = typeof avoid === 'string' ? avoid.split(/[,;\u3001\uff0c]/) : avoid;
  const supported = Array.isArray(values) && values.length > 0 && values.length <= 8 &&
    values.every((value) => typeof value === 'string' && value.trim() && value.length <= 120);
  if (!supported) return { ingredientIds: [], unsupported: true };

  const names = values.map(normalizeForMatch);
  const ids = names.map((name) => EXTRA_ALIASES.get(name) ||
    (Object.hasOwn(STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES, name)
      ? STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES[name] : null));
  return { ingredientIds: [...new Set(ids.filter(Boolean))], unsupported: ids.some((id) => !id) };
}

function assessIngredientExclusions(formula, exclusion) {
  if (typeof formula?.ingredientText !== 'string' || !formula.ingredientText.trim() ||
      !exclusion.ingredientIds.length) return 'unknown';
  const product = { ingredients_inci: formula.ingredientText };
  const present = exclusion.ingredientIds.some((id) => {
    const declarations = EXTRA_DECLARATIONS[id];
    if (declarations) {
      return declarations.some((name) => productIngredientMention(product, name.replaceAll(' ', '_')) === 'named');
    }
    return productNamesIngredientFamily(product, id);
  });

  if (present) return 'present';
  return exclusion.unsupported ? 'unknown' : 'absent_from_reviewed_ingredient_list';
}

module.exports = { readIngredientExclusions, assessIngredientExclusions };
