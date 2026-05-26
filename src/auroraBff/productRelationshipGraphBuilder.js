const {
  coerceRelationshipEdge,
  validateRelationshipEdge,
  __internal: relationshipInternals,
} = require('./productRelationshipGraph');

const CURATED_NEED_NODES = [
  {
    need_id: 'need:fragrance-free-barrier-repair',
    label: 'fragrance-free barrier repair',
    category_taxonomy: ['skincare', 'barrier repair', 'moisturizer'],
    evidence_grade_min: 'B',
    tags: ['fragrance-free', 'barrier', 'ceramide', 'sensitive skin'],
  },
  {
    need_id: 'need:budget-peptide-serum',
    label: 'budget peptide serum',
    category_taxonomy: ['skincare', 'serum', 'peptide'],
    evidence_grade_min: 'B',
    tags: ['peptide', 'budget', 'serum'],
  },
  {
    need_id: 'need:acne-prone-sensitive-skin',
    label: 'acne-prone sensitive skin',
    category_taxonomy: ['skincare', 'acne-prone', 'sensitive skin'],
    evidence_grade_min: 'B',
    tags: ['acne-prone', 'sensitive skin', 'low irritation'],
  },
  {
    need_id: 'need:pregnancy-safe-retinoid-alternative',
    label: 'pregnancy-safe retinoid alternative',
    category_taxonomy: ['skincare', 'retinoid alternative', 'pregnancy cautious'],
    evidence_grade_min: 'B',
    tags: ['retinoid alternative', 'bakuchiol', 'pregnancy cautious'],
  },
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeLower(value, max = 512) {
  return normalizeString(value, max).toLowerCase();
}

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return toNumberOrNull(value.amount ?? value.value ?? value.price ?? value.min ?? value.sale_price);
  }
  const n = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeTokens(value) {
  const rawItems = Array.isArray(value) ? value : [value];
  const items = rawItems.flatMap((item) => String(item == null ? '' : item).split(/[>,/|;:_\s-]+/g));
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    const token = normalizeLower(raw, 80).replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

const GENERIC_USE_CASE_TOKENS = new Set([
  'a',
  'an',
  'and',
  'as',
  'beauty',
  'bundle',
  'care',
  'collection',
  'comparison',
  'creates',
  'description',
  'cosmetic',
  'cosmetics',
  'daily',
  'duo',
  'edition',
  'essential',
  'essentials',
  'for',
  'full',
  'gift',
  'identifies',
  'kit',
  'listed',
  'needed',
  'makeup',
  'official',
  'page',
  'product',
  'routine',
  'set',
  'shopper',
  'shoppers',
  'size',
  'skin',
  'skincare',
  'source',
  'that',
  'the',
  'this',
  'tool',
  'use',
  'with',
]);

const BROAD_CATEGORY_VALUES = new Set([
  'accessory',
  'beauty',
  'beauty accessory',
  'body care',
  'cosmetic',
  'cosmetics',
  'makeup',
  'makeup set',
  'set',
  'skin care',
  'skincare',
  'tool',
]);

const STRONG_USE_CASE_TOKENS = new Set([
  'acne',
  'balm',
  'barrier',
  'blush',
  'body',
  'brush',
  'cleanser',
  'cleansing',
  'complexion',
  'concealer',
  'conditioner',
  'cream',
  'deodorant',
  'exfoliant',
  'exfoliating',
  'eyeliner',
  'eyeshadow',
  'foundation',
  'fragrance',
  'gloss',
  'hair',
  'hydrating',
  'lash',
  'lip',
  'loofah',
  'mascara',
  'mirror',
  'moisturizer',
  'peptide',
  'powder',
  'retinoid',
  'serum',
  'shampoo',
  'sponge',
  'sunscreen',
  'tint',
  'toner',
]);

const TOOL_FORM_TOKENS = new Set([
  'applicator',
  'brush',
  'case',
  'headband',
  'loofah',
  'mirror',
  'pouch',
  'sponge',
]);

const TOPICAL_FORM_TOKENS = new Set([
  'balm',
  'cleanser',
  'cleansing',
  'conditioner',
  'cream',
  'deodorant',
  'foundation',
  'fragrance',
  'gel',
  'gloss',
  'lipstick',
  'lotion',
  'mascara',
  'parfum',
  'perfume',
  'serum',
  'shampoo',
  'spray',
  'tint',
  'toner',
  'wash',
]);

const EYE_AREA_TOKENS = new Set(['brow', 'eye', 'eyeliner', 'eyeshadow', 'lash', 'shadow']);

const FACE_BODY_AREA_TOKENS = new Set([
  'blush',
  'body',
  'cheek',
  'complexion',
  'concealer',
  'face',
  'foundation',
  'kabuki',
  'powder',
]);

const SET_MARKER_TOKENS = new Set([
  'bundle',
  'combo',
  'duo',
  'essentials',
  'faves',
  'kit',
  'set',
  'trio',
]);

const BROAD_LOOK_SET_TOKENS = new Set([
  'bof',
  'bronzy',
  'fall',
  'fam',
  'fashion',
  'faves',
  'glam',
  'globes',
  'glowy',
  'golden',
  'look',
  'natural',
  'paris',
  'week',
]);

const SET_COMPONENT_GROUPS = new Set([
  'body_care',
  'cheek_color',
  'cleanse',
  'complexion',
  'eye_makeup',
  'face_color',
  'fragrance',
  'hair_care',
  'lip_care',
  'lip_color',
  'tool',
]);

const COMPLEXION_JOB_TOKENS = {
  concealer: ['conceal', 'concealer'],
  foundation: ['foundation', 'skin tint', 'tint'],
  powder: ['powder', 'setting'],
  highlighter: ['highlighter', 'highlight', 'skinstick', 'shimmer'],
  blush: ['blush', 'cheek'],
};

const LIP_CARE_TOKENS = ['balm', 'butter', 'care', 'hydrating', 'hydration', 'mask', 'oil', 'strengthening', 'treatz'];
const LIP_COLOR_TOKENS = ['color', 'gloss', 'glossy', 'liner', 'lipstick', 'luminizer', 'matte', 'pout', 'shine', 'shiny', 'stain', 'tint'];

const SKINCARE_JOB_TOKENS = {
  eye: ['eye', 'undereye'],
  face: ['face', 'facial'],
  cleanser: ['cleanser', 'cleansing'],
  moisturizer: ['cream', 'lotion', 'moisturiser', 'moisturizer'],
  serum: ['drops', 'serum'],
  toner: ['toner'],
  sunscreen: ['spf', 'sunscreen'],
  mask: ['mask'],
};

const SKIN_EFFECT_TOKENS = {
  acne_oil: ['acne', 'blemish', 'clear control', 'oil control', 'oily', 'pore', 'salicylic'],
  azelaic: ['azelaic'],
  barrier: ['barrier', 'ceramide', 'repair'],
  brightening: ['bright', 'brightening', 'glow', 'kojic', 'radiance', 'radiant'],
  calming: ['calm', 'calming', 'sensitive', 'soothing'],
  exfoliating: ['aha', 'bha', 'exfoliant', 'exfoliating', 'glycolic', 'lactic'],
  hydration: ['ha', 'hyaluronic', 'hydrate', 'hydrating', 'hydration', 'moisture'],
  peptide: ['peptide', 'peptides'],
  retinoid_alternative: ['bakuchiol', 'bio retinol', 'retinol', 'retinoid'],
};

const BODY_CARE_JOB_TOKENS = {
  body_cream: ['body butter', 'body cream', 'body lotion', 'body milk', 'cream', 'lotion', 'milk'],
  body_oil: ['body oil', 'dry oil', 'oil'],
  body_wash: ['body wash', 'cleanser', 'cleansing', 'shower', 'wash'],
  deodorant: ['deodorant'],
  sunscreen: ['spf', 'sunscreen'],
};

const HAIR_FORM_JOB_TOKENS = {
  shampoo: ['shampoo'],
  conditioner: ['conditioner'],
  rinse: ['acv', 'rinse', 'vinegar'],
  scalp_treatment: ['scalp', 'root'],
  styling: ['styling'],
};

const HAIR_EFFECT_TOKENS = {
  conditioning: ['conditioner', 'conditioning', 'detangle', 'detangling'],
  clarifying: ['clarifying', 'clear thinker'],
  density: ['density', 'growth', 'shedding', 'thinning'],
  hydrating: ['hydrate', 'hydrating', 'hydration', 'mekabu'],
  rinse: ['acv', 'ph', 'rinse', 'vinegar'],
  shine: ['glass', 'shine'],
  treated_hair: ['treated'],
};

const BRUSH_TARGET_TOKENS = {
  eye: ['eye', 'eyeshadow', 'shadow'],
  concealer: ['concealer'],
  foundation: ['foundation', 'kabuki'],
  blush: ['blush', 'cheek'],
  powder: ['powder'],
  highlighter: ['highlighter', 'highlight'],
};

const OUT_OF_SCOPE_MERCH_TOKENS = new Set([
  'apparel',
  'bag',
  'cap',
  'clothing',
  'crewneck',
  'hat',
  'hoodie',
  'keychain',
  'merch',
  'shirt',
  'socks',
  'sweatshirt',
  'tee',
  'tote',
]);

function rawProductTokens(snapshot = {}) {
  const rawValues = [
    snapshot.category,
    snapshot.use_case,
    snapshot.useCase,
    snapshot.name,
    snapshot.title,
    snapshot.display_name,
    snapshot.displayName,
    snapshot.product_name,
    snapshot.description,
    snapshot.short_description,
    snapshot.shortDescription,
  ];
  if (Array.isArray(snapshot.category_taxonomy)) rawValues.push(...snapshot.category_taxonomy);
  if (Array.isArray(snapshot.tags)) rawValues.push(...snapshot.tags);
  return new Set(normalizeTokens(rawValues).filter((token) => token.length > 1));
}

function tokenSetHasPhrase(tokens, phrase) {
  const words = normalizeTokens(phrase);
  if (!words.length) return false;
  if (words.length === 1) return tokens.has(words[0]);
  return words.every((word) => tokens.has(word));
}

function tokenSetHasAny(tokens, values) {
  for (const value of values) {
    if (tokenSetHasPhrase(tokens, value)) return true;
  }
  return false;
}

function tokenGroups(tokens, groupMap) {
  const groups = new Set();
  for (const [group, values] of Object.entries(groupMap)) {
    if (tokenSetHasAny(tokens, values)) groups.add(group);
  }
  return groups;
}

function isOutOfScopeBeautyProduct(snapshot = {}) {
  const tokens = rawProductTokens(snapshot);
  if (!hasAnyToken(tokens, OUT_OF_SCOPE_MERCH_TOKENS)) return false;
  return !tokenSetHasAny(tokens, ['beauty bag', 'beauty pouch', 'cosmetic bag', 'makeup bag', 'makeup pouch']);
}

function sharedGroups(left, right) {
  const shared = [];
  for (const group of left) {
    if (right.has(group)) shared.push(group);
  }
  return shared;
}

function filteredGroups(groups, allowedGroups) {
  return new Set([...groups].filter((group) => allowedGroups.has(group)));
}

function symmetricDifference(left, right) {
  const out = [];
  for (const group of left) {
    if (!right.has(group)) out.push(group);
  }
  for (const group of right) {
    if (!left.has(group)) out.push(group);
  }
  return out;
}

function isSetLikeProduct(snapshot = {}) {
  const category = normalizeCategoryValue(snapshot.category);
  if (category === 'set' || category === 'makeup set') return true;
  return tokenSetHasAny(rawProductTokens(snapshot), SET_MARKER_TOKENS);
}

function setCompositionGroups(snapshot = {}) {
  const tokens = rawProductTokens(snapshot);
  const groups = new Set();

  const hasLip = tokens.has('lip') || tokens.has('lips');
  if (hasLip && tokenSetHasAny(tokens, ['balm', 'butter', 'care', 'hydrating', 'hydration', 'mask', 'oil', 'savrs'])) {
    groups.add('lip_care');
  }
  if (hasLip && tokenSetHasAny(tokens, ['color', 'gloss', 'glossy', 'liner', 'luminizer', 'matte', 'pout', 'stain', 'tint'])) {
    groups.add('lip_color');
  }
  const hasCheekColor = tokenSetHasAny(tokens, ['blush', 'cheek']);
  const hasEyeMakeup = tokenSetHasAny(tokens, ['eye', 'eyeliner', 'eyeshadow', 'lash', 'mascara', 'shadow']);
  if (hasCheekColor) groups.add('cheek_color');
  if (tokenSetHasAny(tokens, ['bronzer', 'highlighter'])) groups.add('face_color');
  if (tokenSetHasAny(tokens, ['concealer', 'complexion', 'foundation']) ||
    tokenSetHasAny(tokens, ['powder']) && !hasCheekColor && !hasEyeMakeup ||
    tokens.has('skin') && tokens.has('tint')) {
    groups.add('complexion');
  }
  if (hasEyeMakeup) {
    groups.add('eye_makeup');
  }
  if (tokenSetHasAny(tokens, ['brush', 'loofah', 'sponge'])) groups.add('tool');
  if (tokenSetHasAny(tokens, ['cleanser', 'cleansing', 'gel', 'shower', 'wash'])) groups.add('cleanse');
  if (tokenSetHasAny(tokens, ['body']) && tokenSetHasAny(tokens, ['cream', 'lotion', 'oil', 'serum'])) {
    groups.add('body_care');
  }
  if (tokenSetHasAny(tokens, ['conditioner', 'hair', 'shampoo', 'styling'])) groups.add('hair_care');
  if (tokenSetHasAny(tokens, ['cream', 'lotion', 'moisturiser', 'moisturizer'])) groups.add('moisturize');
  if (tokenSetHasAny(tokens, ['drops', 'peptide', 'serum'])) groups.add('serum');
  if (tokenSetHasAny(tokens, ['fragrance', 'parfum', 'perfume', 'scent'])) groups.add('fragrance');

  return {
    groups,
    broadLookSet: tokenSetHasAny(tokens, BROAD_LOOK_SET_TOKENS),
    tokens,
  };
}

function setCompositionCompatibility(anchorSnapshot = {}, candidateSnapshot = {}) {
  const anchorSetLike = isSetLikeProduct(anchorSnapshot);
  const candidateSetLike = isSetLikeProduct(candidateSnapshot);
  if (!anchorSetLike && !candidateSetLike) return { compatible: true, reason: '', shared_groups: [] };

  const anchorProfile = setCompositionGroups(anchorSnapshot);
  const candidateProfile = setCompositionGroups(candidateSnapshot);

  if (anchorProfile.broadLookSet || candidateProfile.broadLookSet) {
    return { compatible: false, reason: 'broad_set_composition', shared_groups: [] };
  }
  if (anchorSetLike !== candidateSetLike) {
    return { compatible: false, reason: 'single_product_set_mismatch', shared_groups: [] };
  }

  const shared = [];
  for (const group of anchorProfile.groups) {
    if (candidateProfile.groups.has(group)) shared.push(group);
  }
  if (!shared.length) {
    return { compatible: false, reason: 'set_composition_mismatch', shared_groups: [] };
  }
  const anchorComponents = filteredGroups(anchorProfile.groups, SET_COMPONENT_GROUPS);
  const candidateComponents = filteredGroups(candidateProfile.groups, SET_COMPONENT_GROUPS);
  const componentDiff = symmetricDifference(anchorComponents, candidateComponents);
  if (componentDiff.length) {
    return {
      compatible: false,
      reason: 'set_composition_partial_mismatch',
      shared_groups: shared,
      component_diff: componentDiff,
    };
  }
  if (shared.length === 1 && shared[0] === 'fragrance') {
    return { compatible: false, reason: 'fragrance_set_needs_specific_scent_overlap', shared_groups: shared };
  }
  return { compatible: true, reason: '', shared_groups: shared };
}

function hasAnyToken(tokens, tokenSet) {
  for (const token of tokens) {
    if (tokenSet.has(token)) return true;
  }
  return false;
}

function productFormCompatibility(anchorSnapshot = {}, candidateSnapshot = {}) {
  const anchorTokens = new Set(collectUseCaseTokens(anchorSnapshot));
  const candidateTokens = new Set(collectUseCaseTokens(candidateSnapshot));
  const anchorHasTool = hasAnyToken(anchorTokens, TOOL_FORM_TOKENS);
  const candidateHasTool = hasAnyToken(candidateTokens, TOOL_FORM_TOKENS);
  const anchorHasTopical = hasAnyToken(anchorTokens, TOPICAL_FORM_TOKENS);
  const candidateHasTopical = hasAnyToken(candidateTokens, TOPICAL_FORM_TOKENS);

  if (anchorHasTool !== candidateHasTool) {
    if ((anchorHasTool && candidateHasTopical) || (candidateHasTool && anchorHasTopical)) {
      return { compatible: false, reason: 'tool_topical_form_mismatch' };
    }
  }

  const bothBrushes = anchorTokens.has('brush') && candidateTokens.has('brush');
  if (bothBrushes) {
    const anchorEye = hasAnyToken(anchorTokens, EYE_AREA_TOKENS);
    const candidateEye = hasAnyToken(candidateTokens, EYE_AREA_TOKENS);
    const anchorFaceBody = hasAnyToken(anchorTokens, FACE_BODY_AREA_TOKENS);
    const candidateFaceBody = hasAnyToken(candidateTokens, FACE_BODY_AREA_TOKENS);
    if ((anchorEye && candidateFaceBody && !candidateEye) || (candidateEye && anchorFaceBody && !anchorEye)) {
      return { compatible: false, reason: 'brush_application_area_mismatch' };
    }
  }

  return { compatible: true, reason: '' };
}

function productJobCompatibility(anchorSnapshot = {}, candidateSnapshot = {}) {
  const anchorTokens = rawProductTokens(anchorSnapshot);
  const candidateTokens = rawProductTokens(candidateSnapshot);
  const anchorCategory = normalizeCategoryValue(anchorSnapshot.category);
  const candidateCategory = normalizeCategoryValue(candidateSnapshot.category);
  const anchorBodyArea = anchorTokens.has('body');
  const candidateBodyArea = candidateTokens.has('body');
  const anchorFaceArea = tokenSetHasAny(anchorTokens, ['face', 'facial']);
  const candidateFaceArea = tokenSetHasAny(candidateTokens, ['face', 'facial']);
  const anchorScalpArea = anchorTokens.has('scalp');
  const candidateScalpArea = candidateTokens.has('scalp');

  const anchorComplexion = tokenGroups(anchorTokens, COMPLEXION_JOB_TOKENS);
  const candidateComplexion = tokenGroups(candidateTokens, COMPLEXION_JOB_TOKENS);
  if ((anchorCategory === 'complexion' || candidateCategory === 'complexion') && anchorComplexion.size && candidateComplexion.size) {
    const shared = sharedGroups(anchorComplexion, candidateComplexion);
    if (!shared.length) {
      return { compatible: false, reason: 'complexion_job_mismatch', shared_groups: [] };
    }
    const anchorCoverage = anchorComplexion.has('foundation') || anchorComplexion.has('concealer');
    const candidateCoverage = candidateComplexion.has('foundation') || candidateComplexion.has('concealer');
    if (shared.length === 1 && shared[0] === 'powder' && anchorCoverage !== candidateCoverage) {
      return { compatible: false, reason: 'complexion_coverage_setting_mismatch', shared_groups: shared };
    }
  }

  const anchorHasLip = anchorTokens.has('lip') || anchorTokens.has('lips') || anchorCategory.startsWith('lip');
  const candidateHasLip = candidateTokens.has('lip') || candidateTokens.has('lips') || candidateCategory.startsWith('lip');
  if (anchorHasLip || candidateHasLip) {
    const anchorCare = anchorHasLip && tokenSetHasAny(anchorTokens, LIP_CARE_TOKENS);
    const candidateCare = candidateHasLip && tokenSetHasAny(candidateTokens, LIP_CARE_TOKENS);
    const anchorColor = anchorHasLip && tokenSetHasAny(anchorTokens, LIP_COLOR_TOKENS);
    const candidateColor = candidateHasLip && tokenSetHasAny(candidateTokens, LIP_COLOR_TOKENS);
    if (anchorHasLip !== candidateHasLip) {
      return { compatible: false, reason: 'lip_area_mismatch', shared_groups: [] };
    }
    if ((anchorCare && candidateColor && !candidateCare) ||
      (candidateCare && anchorColor && !anchorCare)) {
      return { compatible: false, reason: 'lip_care_color_mismatch', shared_groups: [] };
    }
  }

  const anchorSkinCare = anchorCategory === 'skin care' || anchorCategory === 'skincare' || anchorCategory === 'skin_care';
  const candidateSkinCare = candidateCategory === 'skin care' || candidateCategory === 'skincare' || candidateCategory === 'skin_care';
  if (anchorSkinCare || candidateSkinCare) {
    const anchorHair = anchorTokens.has('hair');
    const candidateHair = candidateTokens.has('hair');
    if (anchorHair !== candidateHair) {
      return { compatible: false, reason: 'hair_skin_job_mismatch', shared_groups: [] };
    }

    const anchorSkinJobs = tokenGroups(anchorTokens, SKINCARE_JOB_TOKENS);
    const candidateSkinJobs = tokenGroups(candidateTokens, SKINCARE_JOB_TOKENS);
    if (anchorSkinJobs.has('eye') !== candidateSkinJobs.has('eye')) {
      return { compatible: false, reason: 'eye_face_skin_job_mismatch', shared_groups: [] };
    }
    if (anchorSkinJobs.has('sunscreen') !== candidateSkinJobs.has('sunscreen')) {
      return { compatible: false, reason: 'sunscreen_skin_job_mismatch', shared_groups: [] };
    }
    if ((anchorBodyArea && candidateFaceArea && !candidateBodyArea) ||
      (candidateBodyArea && anchorFaceArea && !anchorBodyArea)) {
      return { compatible: false, reason: 'face_body_skin_job_mismatch', shared_groups: [] };
    }
    if (anchorSkinJobs.size && candidateSkinJobs.size) {
      const shared = sharedGroups(anchorSkinJobs, candidateSkinJobs);
      if (!shared.length) {
        return { compatible: false, reason: 'skin_care_job_mismatch', shared_groups: [] };
      }
    }

    const anchorSkinEffects = tokenGroups(anchorTokens, SKIN_EFFECT_TOKENS);
    const candidateSkinEffects = tokenGroups(candidateTokens, SKIN_EFFECT_TOKENS);
    if (anchorSkinEffects.size && candidateSkinEffects.size) {
      const sharedEffects = sharedGroups(anchorSkinEffects, candidateSkinEffects);
      if (!sharedEffects.length) {
        return { compatible: false, reason: 'skin_effect_job_mismatch', shared_groups: [] };
      }
    }
  }

  const anchorBodyCare = anchorCategory === 'body care' || anchorCategory === 'body_care' || anchorCategory === 'body_cleanse' || anchorBodyArea;
  const candidateBodyCare = candidateCategory === 'body care' || candidateCategory === 'body_care' || candidateCategory === 'body_cleanse' || candidateBodyArea;
  if (anchorBodyCare || candidateBodyCare) {
    if (anchorBodyCare !== candidateBodyCare && (anchorBodyArea || candidateBodyArea)) {
      return { compatible: false, reason: 'body_nonbody_job_mismatch', shared_groups: [] };
    }
    const anchorBodyJobs = tokenGroups(anchorTokens, BODY_CARE_JOB_TOKENS);
    const candidateBodyJobs = tokenGroups(candidateTokens, BODY_CARE_JOB_TOKENS);
    if (anchorBodyJobs.has('sunscreen') !== candidateBodyJobs.has('sunscreen')) {
      return { compatible: false, reason: 'body_sunscreen_job_mismatch', shared_groups: [] };
    }
    if (anchorBodyJobs.has('deodorant') !== candidateBodyJobs.has('deodorant')) {
      return { compatible: false, reason: 'body_deodorant_job_mismatch', shared_groups: [] };
    }
    if (anchorBodyJobs.size && candidateBodyJobs.size) {
      const shared = sharedGroups(anchorBodyJobs, candidateBodyJobs);
      if (!shared.length) {
        return { compatible: false, reason: 'body_care_job_mismatch', shared_groups: [] };
      }
    }
  }

  if ((anchorScalpArea || candidateScalpArea) && anchorScalpArea !== candidateScalpArea) {
    return { compatible: false, reason: 'scalp_area_job_mismatch', shared_groups: [] };
  }

  const bothBrushes = anchorTokens.has('brush') && candidateTokens.has('brush');
  if (bothBrushes) {
    const anchorTargets = tokenGroups(anchorTokens, BRUSH_TARGET_TOKENS);
    const candidateTargets = tokenGroups(candidateTokens, BRUSH_TARGET_TOKENS);
    if (anchorTargets.size && candidateTargets.size) {
      const shared = sharedGroups(anchorTargets, candidateTargets);
      if (!shared.length) {
        return { compatible: false, reason: 'brush_target_mismatch', shared_groups: [] };
      }
    }
  }

  const anchorHairCleanse = anchorCategory === 'hair_cleanse' || anchorTokens.has('shampoo');
  const candidateHairCleanse = candidateCategory === 'hair_cleanse' || candidateTokens.has('shampoo');
  if (anchorHairCleanse && candidateHairCleanse) {
    const anchorEffects = tokenGroups(anchorTokens, HAIR_EFFECT_TOKENS);
    const candidateEffects = tokenGroups(candidateTokens, HAIR_EFFECT_TOKENS);
    if (anchorEffects.size && candidateEffects.size) {
      const shared = sharedGroups(anchorEffects, candidateEffects);
      if (!shared.length) {
        return { compatible: false, reason: 'hair_cleanse_effect_mismatch', shared_groups: [] };
      }
    }
  }

  const anchorHairCare = anchorCategory === 'hair_care' || anchorTokens.has('hair');
  const candidateHairCare = candidateCategory === 'hair_care' || candidateTokens.has('hair');
  if (anchorHairCare && candidateHairCare) {
    const anchorHairForms = tokenGroups(anchorTokens, HAIR_FORM_JOB_TOKENS);
    const candidateHairForms = tokenGroups(candidateTokens, HAIR_FORM_JOB_TOKENS);
    if (anchorHairForms.size && candidateHairForms.size) {
      const sharedForms = sharedGroups(anchorHairForms, candidateHairForms);
      if (!sharedForms.length) {
        return { compatible: false, reason: 'hair_form_job_mismatch', shared_groups: [] };
      }
    }
    const anchorEffects = tokenGroups(anchorTokens, HAIR_EFFECT_TOKENS);
    const candidateEffects = tokenGroups(candidateTokens, HAIR_EFFECT_TOKENS);
    if (anchorEffects.has('density') !== candidateEffects.has('density')) {
      return { compatible: false, reason: 'hair_density_claim_mismatch', shared_groups: [] };
    }
    if (anchorEffects.size && candidateEffects.size) {
      const shared = sharedGroups(anchorEffects, candidateEffects);
      if (!shared.length) {
        return { compatible: false, reason: 'hair_care_effect_mismatch', shared_groups: [] };
      }
    }
  }

  return { compatible: true, reason: '', shared_groups: [] };
}

function collectUseCaseTokens(snapshot = {}) {
  const rawValues = [
    snapshot.category,
    snapshot.use_case,
    snapshot.useCase,
    snapshot.name,
    snapshot.title,
    snapshot.display_name,
    snapshot.displayName,
    snapshot.product_name,
    snapshot.description,
    snapshot.short_description,
    snapshot.shortDescription,
  ];
  if (Array.isArray(snapshot.category_taxonomy)) rawValues.push(...snapshot.category_taxonomy);
  if (Array.isArray(snapshot.tags)) rawValues.push(...snapshot.tags);
  return normalizeTokens(rawValues)
    .filter((token) => token.length > 2)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !GENERIC_USE_CASE_TOKENS.has(token));
}

function specificUseCaseOverlap(anchorSnapshot = {}, candidateSnapshot = {}) {
  const anchorTokens = new Set(collectUseCaseTokens(anchorSnapshot));
  const candidateTokens = new Set(collectUseCaseTokens(candidateSnapshot));
  const overlap = [];
  const strongOverlap = [];
  for (const token of anchorTokens) {
    if (candidateTokens.has(token)) {
      overlap.push(token);
      if (STRONG_USE_CASE_TOKENS.has(token)) strongOverlap.push(token);
    }
  }
  const denominator = Math.max(1, Math.min(anchorTokens.size, candidateTokens.size));
  return {
    count: overlap.length,
    score: overlap.length / denominator,
    overlap,
    strong_overlap: strongOverlap,
    strong_count: strongOverlap.length,
  };
}

function normalizeCategoryValue(value) {
  return normalizeLower(value, 120).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isBroadCategoryValue(value) {
  const text = normalizeCategoryValue(value);
  if (!text) return true;
  return BROAD_CATEGORY_VALUES.has(text);
}

function hasSpecificUseCaseAlignment(anchorSnapshot = {}, candidateSnapshot = {}, { ingredientScore = 0 } = {}) {
  const anchorCategory = normalizeCategoryValue(anchorSnapshot.category);
  const candidateCategory = normalizeCategoryValue(candidateSnapshot.category);
  const exactSpecificCategory = Boolean(
    anchorCategory &&
      candidateCategory &&
      anchorCategory === candidateCategory &&
      !isBroadCategoryValue(anchorCategory),
  );
  const overlap = specificUseCaseOverlap(anchorSnapshot, candidateSnapshot);
  const hasStrongOverlap = overlap.strong_count >= 1;
  return {
    aligned: Boolean(
      hasStrongOverlap &&
        (overlap.count >= 2 || exactSpecificCategory || ingredientScore >= 0.6),
    ),
    exactSpecificCategory,
    overlap,
  };
}

function jaccard(left, right) {
  const l = new Set(normalizeTokens(left));
  const r = new Set(normalizeTokens(right));
  if (!l.size || !r.size) return 0;
  let intersect = 0;
  for (const token of l) {
    if (r.has(token)) intersect += 1;
  }
  return intersect / (l.size + r.size - intersect);
}

function pickFirstString(...values) {
  for (const value of values) {
    const text = normalizeString(value);
    if (text) return text;
  }
  return '';
}

function normalizeProductSnapshot(input = {}) {
  const src = isPlainObject(input) ? input : {};
  const product = isPlainObject(src.product) ? src.product : src;
  const ref = pickFirstString(
    src.product_ref,
    src.productRef,
    product.product_ref,
    product.productRef,
    product.product_id,
    product.productId,
    product.sku_id,
    product.skuId,
    product.id,
    product.url,
  );
  const brand = pickFirstString(product.brand_id, product.brandId, product.brand, product.brand_name, product.vendor);
  const name = pickFirstString(product.name, product.display_name, product.displayName, product.title, product.product_name);
  return {
    product_ref: ref ? (ref.includes(':') ? ref : `product:${ref}`) : '',
    snapshot: {
      ...product,
      ...(brand ? { brand } : {}),
      ...(name ? { name } : {}),
    },
  };
}

function extractScore(candidate, names, fallback = 0) {
  const src = isPlainObject(candidate) ? candidate : {};
  const breakdown = isPlainObject(src.score_breakdown || src.scoreBreakdown)
    ? (src.score_breakdown || src.scoreBreakdown)
    : {};
  for (const name of names) {
    const value = src[name] ?? breakdown[name];
    if (value != null && value !== '') return clamp01(value, fallback);
  }
  return fallback;
}

function buildSourceRefs(candidate) {
  const src = isPlainObject(candidate) ? candidate : {};
  const refs = [];
  if (Array.isArray(src.source_refs || src.sourceRefs)) {
    refs.push(...(src.source_refs || src.sourceRefs));
  }
  if (src.source || src.source_type || src.sourceType) {
    refs.push(src.source || src.source_type || src.sourceType);
  }
  if (!refs.length) refs.push({ type: 'products_cache', authoritative: true });
  return refs;
}

function needCandidateCompatibility(need = {}, candidateSnapshot = {}, candidate = {}) {
  const needId = normalizeLower(need.need_id || need.id || need.label, 160);
  const needTokens = rawProductTokens({
    ...need,
    name: need.label || need.name,
    category: Array.isArray(need.category_taxonomy) ? need.category_taxonomy.join(' ') : need.category,
  });
  const candidateTokens = rawProductTokens(candidateSnapshot);
  const candidateCategory = normalizeCategoryValue(candidateSnapshot.category);
  const candidatePrice = toNumberOrNull(candidateSnapshot.price ?? candidateSnapshot.price_amount ?? candidate.price);
  const isBodyOrHair = candidateTokens.has('body') || candidateTokens.has('hair') || candidateTokens.has('scalp') ||
    candidateCategory.startsWith('body') || candidateCategory.startsWith('hair') || candidateCategory === 'scalp care';

  if (needId.includes('budget-peptide-serum')) {
    if (candidatePrice == null) return { compatible: false, reason: 'budget_need_missing_price' };
    if (!tokenSetHasAny(candidateTokens, ['peptide', 'peptides'])) return { compatible: false, reason: 'budget_peptide_need_missing_peptide' };
    if (!tokenSetHasAny(candidateTokens, ['serum', 'drops'])) return { compatible: false, reason: 'budget_peptide_need_missing_serum_form' };
  }

  if (needId.includes('fragrance-free-barrier-repair')) {
    if (isBodyOrHair) return { compatible: false, reason: 'barrier_need_body_or_hair_mismatch' };
    if (!tokenSetHasAny(candidateTokens, ['barrier', 'ceramide', 'repair'])) return { compatible: false, reason: 'barrier_need_missing_barrier_evidence' };
    if (!tokenSetHasAny(candidateTokens, ['fragrance free', 'fragrance-free', 'unscented', 'sensitive'])) {
      return { compatible: false, reason: 'barrier_need_missing_fragrance_free_evidence' };
    }
  }

  if (needId.includes('acne-prone-sensitive-skin')) {
    if (isBodyOrHair) return { compatible: false, reason: 'acne_sensitive_need_body_or_hair_mismatch' };
    if (!tokenSetHasAny(candidateTokens, ['acne', 'blemish', 'sensitive', 'salicylic'])) {
      return { compatible: false, reason: 'acne_sensitive_need_missing_need_evidence' };
    }
  }

  if (needId.includes('pregnancy-safe-retinoid-alternative')) {
    if (isBodyOrHair) return { compatible: false, reason: 'retinoid_alt_need_body_or_hair_mismatch' };
    if (!tokenSetHasAny(candidateTokens, ['bakuchiol', 'bio retinol', 'retinoid alternative'])) {
      return { compatible: false, reason: 'retinoid_alt_need_missing_alternative_evidence' };
    }
    if (!tokenSetHasAny(candidateTokens, ['pregnancy', 'pregnancy cautious', 'pregnancy safe'])) {
      return { compatible: false, reason: 'retinoid_alt_need_missing_pregnancy_evidence' };
    }
  }

  const sharedStrongTokens = sharedGroups(
    filteredGroups(needTokens, STRONG_USE_CASE_TOKENS),
    filteredGroups(candidateTokens, STRONG_USE_CASE_TOKENS),
  );
  if (!sharedStrongTokens.length && Number(candidate.score_total || candidate.similarity_score || 0) < 0.85) {
    return { compatible: false, reason: 'need_candidate_weak_overlap' };
  }
  return { compatible: true, reason: '' };
}

function inferRelationship(anchorSnapshot, candidateSnapshot, candidate = {}) {
  const anchorBrand = relationshipInternals.extractBrand(anchorSnapshot);
  const candidateBrand = relationshipInternals.extractBrand(candidateSnapshot);
  const sameBrand = Boolean(anchorBrand && candidateBrand && anchorBrand === candidateBrand);
  const categoryScore = extractScore(
    candidate,
    ['category_use_case_match', 'category_match', 'categoryMatch'],
    jaccard(anchorSnapshot.category_taxonomy || anchorSnapshot.category, candidateSnapshot.category_taxonomy || candidateSnapshot.category),
  );
  const ingredientScore = extractScore(candidate, ['ingredient_functional_similarity', 'ingredient_similarity'], 0);
  const explicitSim = extractScore(candidate, ['similarity_score', 'similarityScore', 'score_total'], 0);
  const scoreTotal = Math.max(explicitSim, ingredientScore, categoryScore * 0.75);
  const anchorPrice = toNumberOrNull(anchorSnapshot.price ?? anchorSnapshot.price_amount);
  const candidatePrice = toNumberOrNull(candidateSnapshot.price ?? candidateSnapshot.price_amount ?? candidate.price);
  const priceRatio = anchorPrice != null && candidatePrice != null && anchorPrice > 0
    ? candidatePrice / anchorPrice
    : null;
  const setCompatibility = setCompositionCompatibility(anchorSnapshot, candidateSnapshot);
  const formCompatibility = productFormCompatibility(anchorSnapshot, candidateSnapshot);
  const jobCompatibility = productJobCompatibility(anchorSnapshot, candidateSnapshot);
  const useCaseAlignment = hasSpecificUseCaseAlignment(anchorSnapshot, candidateSnapshot, { ingredientScore });

  if (isOutOfScopeBeautyProduct(anchorSnapshot) || isOutOfScopeBeautyProduct(candidateSnapshot)) {
    return {
      relation_type: 'rejected',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      scopeCompatibility: { compatible: false, reason: 'non_beauty_merch_scope' },
      setCompatibility,
      formCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  if (sameBrand) return { relation_type: 'related_product', categoryScore, ingredientScore, scoreTotal, priceRatio };
  if (!setCompatibility.compatible) {
    return {
      relation_type: 'rejected',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      formCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  if (!jobCompatibility.compatible) {
    return {
      relation_type: 'rejected',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      formCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  if (!formCompatibility.compatible) {
    return {
      relation_type: 'rejected',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      formCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  if (!useCaseAlignment.aligned) {
    return {
      relation_type: 'rejected',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  if (categoryScore >= 0.55 && scoreTotal >= 0.82 && priceRatio != null && priceRatio <= 1.0) {
    return {
      relation_type: 'dupe',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  if (categoryScore >= 0.55) {
    return {
      relation_type: 'competitive_alternative',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  return {
    relation_type: 'rejected',
    categoryScore,
    ingredientScore,
    scoreTotal,
    priceRatio,
    setCompatibility,
    jobCompatibility,
    useCaseAlignment,
  };
}

function buildEdgeForCandidate({ anchor, candidate, market = 'US', nowIso, reviewStatus = 'pending' } = {}) {
  const anchorNorm = normalizeProductSnapshot(anchor);
  const candidateNorm = normalizeProductSnapshot(candidate);
  if (!anchorNorm.product_ref || !candidateNorm.product_ref) {
    return {
      edge: null,
      errors: ['missing_anchor_or_candidate_ref'],
    };
  }
  const inferred = inferRelationship(anchorNorm.snapshot, candidateNorm.snapshot, candidate);
  if (inferred.relation_type === 'rejected') {
    return {
      edge: null,
      errors: ['candidate_below_relationship_threshold'],
      metrics: inferred,
    };
  }
  const anchorPrice = toNumberOrNull(anchorNorm.snapshot.price ?? anchorNorm.snapshot.price_amount);
  const candidatePrice = toNumberOrNull(candidateNorm.snapshot.price ?? candidateNorm.snapshot.price_amount ?? candidate.price);
  const observedAt = normalizeString(candidate.price_observed_at || candidate.priceObservedAt || candidate.observed_at || nowIso);
  const edge = coerceRelationshipEdge({
    anchor_type: 'product',
    anchor_ref: anchorNorm.product_ref,
    anchor_snapshot: anchorNorm.snapshot,
    candidate_product_ref: candidateNorm.product_ref,
    candidate_snapshot: candidateNorm.snapshot,
    relation_type: inferred.relation_type,
    market,
    category_taxonomy: candidate.category_taxonomy || candidate.categoryTaxonomy || candidateNorm.snapshot.category_taxonomy || candidateNorm.snapshot.category,
    use_case: normalizeString(candidate.use_case || candidate.useCase || candidateNorm.snapshot.use_case || candidateNorm.snapshot.category, 240),
    score_total: inferred.scoreTotal,
    score_breakdown: {
      category_use_case_match: inferred.categoryScore,
      ingredient_functional_similarity: inferred.ingredientScore,
      price_advantage: inferred.priceRatio == null ? 0 : clamp01(1 - Math.min(inferred.priceRatio, 1)),
      evidence_quality: extractScore(candidate, ['evidence_quality'], 0.65),
      availability_confidence: extractScore(candidate, ['availability_confidence'], 0.7),
      social_reference_strength: extractScore(candidate, ['social_reference_strength'], 0),
      score_total: inferred.scoreTotal,
    },
    price_evidence: {
      anchor_price_amount: anchorPrice,
      candidate_price_amount: candidatePrice,
      price_ratio: inferred.priceRatio,
      observed_at: observedAt,
    },
    source_refs: buildSourceRefs(candidate),
    evidence_grade: candidate.evidence_grade || candidate.evidenceGrade || 'B',
    review_status: reviewStatus,
    why_candidate: isPlainObject(candidate.why_candidate || candidate.whyCandidate)
      ? (candidate.why_candidate || candidate.whyCandidate)
      : {
        summary: inferred.relation_type === 'dupe'
          ? 'Lower-priced alternative with similar category and function signals.'
          : inferred.relation_type === 'related_product'
            ? 'Same-brand or adjacent product for the routine context.'
            : 'Cross-brand alternative with matching category and use-case signals.',
        reasons_user_visible: ['Category/use-case evidence is aligned.', 'Source provenance is available.'],
      },
    tradeoffs: Array.isArray(candidate.tradeoffs) ? candidate.tradeoffs : [],
    watchouts: Array.isArray(candidate.watchouts) ? candidate.watchouts : [],
    provenance: {
      pipeline: 'product_relationship_graph_builder.v1',
      generated_at: nowIso,
    },
    last_verified_at: candidate.last_verified_at || candidate.lastVerifiedAt || null,
    expires_at: candidate.expires_at || candidate.expiresAt || null,
  });
  const validation = validateRelationshipEdge(edge, { nowMs: new Date(nowIso).getTime() });
  return {
    edge: validation.value,
    errors: validation.errors,
    metrics: inferred,
  };
}

function buildNicheSpecialistEdge({ need, candidate, market = 'US', nowIso, reviewStatus = 'pending' } = {}) {
  const needObj = isPlainObject(need) ? need : {};
  const candidateNorm = normalizeProductSnapshot(candidate);
  const needCompatibility = needCandidateCompatibility(needObj, candidateNorm.snapshot, candidate);
  if (!needCompatibility.compatible) {
    return {
      edge: null,
      errors: ['candidate_below_relationship_threshold'],
      metrics: { needCompatibility },
    };
  }
  const edge = coerceRelationshipEdge({
    anchor_type: 'need',
    anchor_ref: normalizeString(needObj.need_id || needObj.id || needObj.label, 260),
    anchor_snapshot: needObj,
    candidate_product_ref: candidateNorm.product_ref,
    candidate_snapshot: candidateNorm.snapshot,
    relation_type: 'niche_specialist',
    market,
    category_taxonomy: needObj.category_taxonomy || needObj.categoryTaxonomy,
    use_case: normalizeString(needObj.label || needObj.use_case || needObj.useCase, 240),
    score_total: extractScore(candidate, ['score_total', 'similarity_score'], 0.72),
    score_breakdown: {
      category_use_case_match: extractScore(candidate, ['category_use_case_match', 'category_match'], 0.65),
      ingredient_functional_similarity: extractScore(candidate, ['ingredient_functional_similarity', 'ingredient_similarity'], 0.6),
      evidence_quality: extractScore(candidate, ['evidence_quality'], 0.7),
      availability_confidence: extractScore(candidate, ['availability_confidence'], 0.7),
      score_total: extractScore(candidate, ['score_total', 'similarity_score'], 0.72),
    },
    price_evidence: {
      candidate_price_amount: toNumberOrNull(candidateNorm.snapshot.price ?? candidate.price),
      observed_at: normalizeString(candidate.price_observed_at || candidate.priceObservedAt || candidate.observed_at || nowIso),
    },
    source_refs: buildSourceRefs(candidate),
    evidence_grade: candidate.evidence_grade || candidate.evidenceGrade || needObj.evidence_grade_min || 'B',
    review_status: reviewStatus,
    why_candidate: isPlainObject(candidate.why_candidate || candidate.whyCandidate)
      ? (candidate.why_candidate || candidate.whyCandidate)
      : {
        summary: `Specialist candidate for ${normalizeString(needObj.label || needObj.need_id)}.`,
        reasons_user_visible: ['Need-specific tags and source evidence are available.'],
      },
    tradeoffs: Array.isArray(candidate.tradeoffs) ? candidate.tradeoffs : [],
    watchouts: Array.isArray(candidate.watchouts) ? candidate.watchouts : [],
    provenance: {
      pipeline: 'product_relationship_graph_builder.v1',
      generated_at: nowIso,
    },
    last_verified_at: candidate.last_verified_at || candidate.lastVerifiedAt || null,
    expires_at: candidate.expires_at || candidate.expiresAt || null,
  });
  const validation = validateRelationshipEdge(edge, { nowMs: new Date(nowIso).getTime() });
  return {
    edge: validation.value,
    errors: validation.errors,
    metrics: { needCompatibility },
  };
}

function edgeIdentity(edge) {
  return [
    normalizeLower(edge.market),
    normalizeLower(edge.anchor_type),
    normalizeLower(edge.anchor_ref),
    normalizeLower(edge.candidate_product_ref),
    normalizeLower(edge.relation_type),
  ].join('|');
}

function dedupeEdgesByIdentity(edges) {
  const byKey = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge) continue;
    const key = edgeIdentity(edge);
    const previous = byKey.get(key);
    if (!previous || Number(edge.score_total || 0) > Number(previous.score_total || 0)) {
      byKey.set(key, edge);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => Number(b.score_total || 0) - Number(a.score_total || 0));
}

function buildProductRelationshipGraphDryRun({
  anchors = [],
  candidatesByAnchor = {},
  needCandidatesById = {},
  needs = CURATED_NEED_NODES,
  market = 'US',
  now = new Date(),
  reviewStatus = 'pending',
  limit = 200,
} = {}) {
  const nowIso = new Date(now).toISOString();
  const edges = [];
  const rejected_edges = [];
  const anchorRows = (Array.isArray(anchors) ? anchors : []).slice(0, Math.max(1, Number(limit) || 200));
  for (const anchor of anchorRows) {
    const anchorNorm = normalizeProductSnapshot(anchor);
    const lookupKeys = [
      anchorNorm.product_ref,
      anchorNorm.product_ref.replace(/^product:/, ''),
      normalizeString(anchor.id || anchor.product_id || anchor.productId || anchor.url),
    ].filter(Boolean);
    const candidates = lookupKeys.flatMap((key) => (Array.isArray(candidatesByAnchor[key]) ? candidatesByAnchor[key] : []));
    const seenCandidate = new Set();
    for (const candidate of candidates) {
      const candidateNorm = normalizeProductSnapshot(candidate);
      const familyKey = normalizeLower(
        candidate.product_family_id ||
          candidate.productFamilyId ||
          candidate.variant_of ||
          candidate.variantOf ||
          candidateNorm.product_ref,
      );
      if (familyKey && seenCandidate.has(familyKey)) continue;
      if (familyKey) seenCandidate.add(familyKey);
      const built = buildEdgeForCandidate({ anchor, candidate, market, nowIso, reviewStatus });
      if (built.edge && !built.errors.length) {
        edges.push(built.edge);
      } else {
        rejected_edges.push({
          anchor_ref: anchorNorm.product_ref,
          candidate_ref: candidateNorm.product_ref,
          errors: built.errors,
          metrics: built.metrics || null,
        });
      }
    }
  }

  for (const need of Array.isArray(needs) ? needs : []) {
    const needId = normalizeString(need.need_id || need.id || need.label);
    const candidates = Array.isArray(needCandidatesById[needId]) ? needCandidatesById[needId] : [];
    for (const candidate of candidates) {
      const built = buildNicheSpecialistEdge({ need, candidate, market, nowIso, reviewStatus });
      if (built.edge && !built.errors.length) {
        edges.push(built.edge);
      } else {
        rejected_edges.push({
          anchor_ref: needId,
          candidate_ref: normalizeProductSnapshot(candidate).product_ref,
          errors: built.errors,
        });
      }
    }
  }

  const deduped = dedupeEdgesByIdentity(edges);
  const anchorsWithApprovedAlternative = new Set(
    deduped
      .filter((edge) => ['dupe', 'competitive_alternative'].includes(edge.relation_type))
      .map((edge) => edge.anchor_ref),
  );
  const review_packets = deduped.map((edge) => ({
    edge_id: edge.id,
    anchor_ref: edge.anchor_ref,
    candidate_product_ref: edge.candidate_product_ref,
    relation_type: edge.relation_type,
    display_label: edge.display_label,
    score_total: edge.score_total,
    evidence_grade: edge.evidence_grade,
    source_refs: edge.source_refs,
    why_candidate: edge.why_candidate,
    review_status: edge.review_status,
  }));

  return {
    summary: {
      market,
      anchor_count: anchorRows.length,
      edge_count: deduped.length,
      rejected_count: rejected_edges.length,
      anchors_with_alternative_count: anchorsWithApprovedAlternative.size,
      niche_specialist_count: deduped.filter((edge) => edge.relation_type === 'niche_specialist').length,
      relation_counts: deduped.reduce((acc, edge) => {
        acc[edge.relation_type] = Number(acc[edge.relation_type] || 0) + 1;
        return acc;
      }, {}),
      generated_at: nowIso,
    },
    edges: deduped,
    rejected_edges,
    review_packets,
  };
}

module.exports = {
  CURATED_NEED_NODES,
  normalizeProductSnapshot,
  buildEdgeForCandidate,
  buildNicheSpecialistEdge,
  dedupeEdgesByIdentity,
  buildProductRelationshipGraphDryRun,
  __internal: {
    inferRelationship,
    jaccard,
    normalizeTokens,
    hasSpecificUseCaseAlignment,
    productFormCompatibility,
    setCompositionCompatibility,
    productJobCompatibility,
    needCandidateCompatibility,
    isOutOfScopeBeautyProduct,
  },
};
