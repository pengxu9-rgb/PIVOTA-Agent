const PDP_SCHEMA_PROFILES = Object.freeze({
  BEAUTY_FORMULA: 'beauty_formula',
  BEAUTY_TOOL: 'beauty_tool',
  GENERIC_MERCH: 'generic_merch',
  GENERIC_PRODUCT: 'generic_product',
});

const ALLOWED_PDP_SCHEMA_PROFILES = new Set(Object.values(PDP_SCHEMA_PROFILES));

const MERCH_KEYWORDS = [
  'apparel',
  'bag',
  'beanie',
  'belt',
  'cap',
  'carryall',
  'clothing',
  'duffel',
  'fanny pack',
  'hat',
  'hoodie',
  'jacket',
  'merch',
  'organizer',
  'pouch',
  'shirt',
  'sweatpants',
  'sweatshirt',
  'tee',
  'tote',
  'travel case',
  'travel organizer',
  'wallet',
];

const BEAUTY_TOOL_KEYWORDS = [
  'applicator',
  'beauty tool',
  'blender',
  'brush',
  'comb',
  'curler',
  'device',
  'gua sha',
  'led mask',
  'mirror',
  'roller',
  'sponge',
  'tool',
  'tweezer',
  'wand',
];

const BEAUTY_FORMULA_KEYWORDS = [
  'balm',
  'body wash',
  'cleanser',
  'conditioner',
  'cream',
  'essence',
  'exfoliant',
  'fragrance',
  'gel',
  'gloss',
  'haircare',
  'lip',
  'lipstick',
  'lotion',
  'makeup',
  'mascara',
  'moisturiser',
  'moisturizer',
  'perfume',
  'powder',
  'serum',
  'shampoo',
  'skin care',
  'skincare',
  'spf',
  'sunscreen',
  'toner',
  'treatment',
];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function hasKeyword(haystack, keywords) {
  const normalized = ` ${normalizeText(haystack)} `;
  if (!normalized.trim()) return false;
  return keywords.some((keyword) => normalized.includes(` ${normalizeText(keyword)} `));
}

function explicitProfile(product) {
  const candidates = [
    product?.pdp_schema_profile,
    product?.pdpSchemaProfile,
    product?.schema_profile,
    product?.schemaProfile,
    product?.pdp_profile,
    product?.pdpProfile,
    product?.seed_data?.pdp_schema_profile,
    product?.seed_data?.schema_profile,
    product?.seed_data?.snapshot?.pdp_schema_profile,
    product?.seed_data?.snapshot?.schema_profile,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeText(candidate).replace(/\s+/g, '_');
    if (ALLOWED_PDP_SCHEMA_PROFILES.has(normalized)) return normalized;
  }
  return null;
}

function hasFormulaEvidence(product) {
  if (!product || typeof product !== 'object') return false;
  return Boolean(
    product.raw_ingredient_text_clean ||
      product.pdp_ingredients_raw ||
      product.pdp_active_ingredients_raw ||
      (Array.isArray(product.inci_list) && product.inci_list.length > 0) ||
      (Array.isArray(product.ingredients_inci) && product.ingredients_inci.length > 0) ||
      (product.ingredients_inci && typeof product.ingredients_inci === 'object') ||
      (Array.isArray(product.active_ingredients) && product.active_ingredients.length > 0),
  );
}

function resolvePdpSchemaProfile(product) {
  if (!product || typeof product !== 'object') return PDP_SCHEMA_PROFILES.GENERIC_PRODUCT;

  const explicit = explicitProfile(product);
  if (explicit) return explicit;

  const categoryText = asArray(product.category_path || product.categoryPath)
    .concat(asArray(product.category))
    .concat(asArray(product.product_type || product.productType))
    .concat(asArray(product.department))
    .join(' ');
  const tagsText = asArray(product.tags).join(' ');
  const titleText = [product.title, product.name, product.subtitle].filter(Boolean).join(' ');
  const optionText = asArray(product.options || product.product_options)
    .map((option) => (typeof option === 'string' ? option : option?.name || option?.title || option?.label))
    .join(' ');
  const classificationText = [categoryText, tagsText, titleText, optionText].join(' ');

  if (hasKeyword(classificationText, MERCH_KEYWORDS)) return PDP_SCHEMA_PROFILES.GENERIC_MERCH;
  if (hasKeyword(classificationText, BEAUTY_TOOL_KEYWORDS)) return PDP_SCHEMA_PROFILES.BEAUTY_TOOL;
  if (hasFormulaEvidence(product) || hasKeyword(classificationText, BEAUTY_FORMULA_KEYWORDS)) {
    return PDP_SCHEMA_PROFILES.BEAUTY_FORMULA;
  }
  return PDP_SCHEMA_PROFILES.GENERIC_PRODUCT;
}

function isBeautyFormulaPdpProfile(profile) {
  return profile === PDP_SCHEMA_PROFILES.BEAUTY_FORMULA;
}

function isBeautyToolPdpProfile(profile) {
  return profile === PDP_SCHEMA_PROFILES.BEAUTY_TOOL;
}

function isGenericPdpProfile(profile) {
  return (
    profile === PDP_SCHEMA_PROFILES.GENERIC_MERCH ||
    profile === PDP_SCHEMA_PROFILES.GENERIC_PRODUCT ||
    profile === PDP_SCHEMA_PROFILES.BEAUTY_TOOL
  );
}

module.exports = {
  PDP_SCHEMA_PROFILES,
  resolvePdpSchemaProfile,
  isBeautyFormulaPdpProfile,
  isBeautyToolPdpProfile,
  isGenericPdpProfile,
};
