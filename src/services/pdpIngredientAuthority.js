function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function uniqueStrings(values, limit = 64) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = asString(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function stripHtml(input) {
  return String(input || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const INGREDIENT_SECTION_RE =
  /\b(full ingredient(?:s| list)?|full ingredients? list|ingredients(?:\s*\(inci\))?|inci(?: list)?)\b\s*:?\s*/ig;
const ACTIVE_SECTION_RE = /\bactive ingredients?\s*:/ig;
const STOP_MARKERS = [
  /\bpeta-certified\b/i,
  /\bhow to pair\b/i,
  /\bshop now\b/i,
  /\bour story\b/i,
  /\bfaq\b/i,
  /\bfrequently asked questions\b/i,
  /\bcan i use this with an active ingredient\b/i,
  /\bwarning[s]?\s*:/i,
  /\bnote\s*:/i,
  /\bcaution\s*:/i,
  /\bfor external use only\b/i,
];
const MARKETING_SIGNAL_RE =
  /\b(soothes?|supports?|fades?|helps?|comforts?|improves?|hydrates?|nourishes?|good for|best for|works? well|pair with|apply|massage|barrier|redness|discoloration|irritation)\b/i;
const SECTION_HEADING_RE = /^(full ingredients?|ingredients(?:\s*\(inci\))?|inci(?: list)?|active ingredients?)$/i;
const INGREDIENT_FUNCTION_LABEL_RE =
  /^(?:carrier|antioxidant|chelating agent|emollient|emulsifier|emulsion stabilizer|film former|humectant|thickener|skin conditioner|preservative|surfactant|solvent|stabilizer|ph adjuster|buffering agent|colorant|opacifier|viscosity controlling|viscosity controller|absorbent|abrasive|binder|cleansing agent)$/i;
const SOURCE_PRIORITY = {
  kb_reviewed: 5,
  existing_authority: 4,
  pdp_section: 3,
  structured_array: 2,
  active_block: 1,
};
const SUNSCREEN_CONTEXT_RE = /\b(spf\s*\d*|sunscreen|sun screen|sunblock|sun care|uv protection|broad spectrum|pa\+|mineral sunscreen|chemical sunscreen)\b/i;
const HERO_ACTIVE_RE =
  /\b(niacinamide|hyaluronic acid|ceramide|peptides?|retinol|retinal|retinaldehyde|bakuchiol|vitamin c|ascorbic acid|ethyl ascorbic acid|tetrahexyldecyl ascorbate|glycolic acid|lactic acid|mandelic acid|salicylic acid|azelaic acid|tranexamic acid|pha|gluconolactone|panthenol|centella|madecassoside|snail mucin|rice|rice lipids?|propolis|alpha arbutin|caffeine|squalane|urea|colloidal oatmeal|ectoin|zinc pca|tamanu oil|aloe|n-?acetyl glucosamine|acetyl glucosamine|beta-?glucan|inulin|glycolipids?|behentrimonium chloride|palmitoyl isoleucine|volufiline|phyto ?ceramides?)\b/i;
const REGULATORY_ACTIVE_RE =
  /\b(zinc oxide|titanium dioxide|avobenzone|octocrylene|octisalate|homosalate|octinoxate|ensulizole|meradimate|oxybenzone|tinosorb s|tinosorb m|uvinul a plus|uvinul t 150|mexoryl sx|mexoryl xl|benzoyl peroxide|adapalene|sulfur)\b/i;
const CONTEXT_SENSITIVE_HERO_ACTIVE_RE =
  /\b(glycolic acid|lactic acid|mandelic acid|salicylic acid)\b/i;
const VITAMIN_C_ACTIVE_RE =
  /\b(vitamin c|ascorbic acid|ethyl ascorbic acid|tetrahexyldecyl ascorbate)\b/i;
const TRUE_VITAMIN_C_INGREDIENT_RE =
  /\b(ascorbic acid|ascorbyl|ascorbate|ethyl ascorbic acid|tetrahexyldecyl ascorbate|3-o-ethyl ascorbic acid)\b/i;
const LOW_SIGNAL_ACTIVE_ITEMS = new Set([
  'water',
  'aqua',
  'glycerin',
  'butylene glycol',
  'propylene glycol',
  'caprylyl glycol',
  'phenoxyethanol',
  'ethylhexylglycerin',
  'fragrance',
  'parfum',
  'disodium edta',
  'sodium chloride',
  'xanthan gum',
  'citric acid',
  'sodium hydroxide',
  'carbomer',
  'tocopherol',
  'alcohol',
  'alcohol denat',
  '1,2-hexanediol',
  'hexylene glycol',
  'dipropylene glycol',
  'polysorbate 20',
  'triethanolamine',
]);
const INVALID_ACTIVE_FRAGMENT_RE =
  /^(?:see|learn more|tab on|restores damaged|chapped|none|n\/a|select shade|choose shade)$/i;
const TITLE_DECLARED_ACTIVE_DEFS = [
  { display: 'Beta-Glucan', titleRe: /\bbeta[-\s]?glucan\b/i, evidenceKeys: ['betaglucan'] },
  { display: 'Inulin', titleRe: /\binulin\b/i, evidenceKeys: ['inulin'] },
  { display: 'Retinal', titleRe: /\bretinal\b/i, evidenceKeys: ['retinal'] },
  { display: 'Retinol', titleRe: /\bretinol\b/i, evidenceKeys: ['retinol'] },
  { display: 'Ectoin', titleRe: /\bectoin\b/i, evidenceKeys: ['ectoin'] },
  {
    display: 'Rice Lipids',
    titleRe: /\brace lipids?\b|\brice lipid/i,
    evidenceRe: /\b(?:oryza sativa.*rice.*lipids?|rice lipids?)\b/i,
  },
  { display: 'PHA', titleRe: /\bpha\b/i, evidenceKeys: ['gluconolactone'] },
  { display: 'Aloe', titleRe: /\baloe\b/i, evidenceRe: /\baloe barbadensis\b/i },
  {
    display: 'N-Acetyl Glucosamine',
    titleRe: /\b(?:nag|n[-\s]?acetyl glucosamine|acetyl glucosamine)\b/i,
    evidenceKeys: ['nacetylglucosamine', 'acetylglucosamine'],
  },
  {
    display: 'Behentrimonium Chloride',
    titleRe: /\bbehentrimonium chloride\b/i,
    evidenceKeys: ['behentrimoniumchloride'],
  },
  { display: 'Glycolipids', titleRe: /\bglycolipid/i, evidenceKeys: ['glycolipids', 'glycolipid'] },
  {
    display: 'Palmitoyl Isoleucine',
    titleRe: /\b(?:pal[-\s]?isoleucine|palmitoyl isoleucine)\b/i,
    evidenceKeys: ['palmitoylisoleucine'],
  },
  {
    display: 'Volufiline',
    titleRe: /\bvolufiline\b/i,
    evidenceRe: /\b(?:anemarrhena asphodeloides root extract|hydrogenated polyisobutene)\b/i,
  },
  {
    display: 'PhytoCeramides',
    titleRe: /\bphyto ?ceramides?\b/i,
    evidenceRe: /\b(?:phytosteryl|ceramide|phytoceramide)\b/i,
  },
];

function collectSectionBlocks(product) {
  const sections = [];
  const pushSection = (value) => {
    if (!value || typeof value !== 'object') return;
    const heading = asString(value.heading || value.title || value.name);
    const content = asString(value.content || value.body || value.value || value.text || value.raw_text);
    if (!heading || !content) return;
    sections.push({ heading, content });
  };

  const directLists = [
    product?.pdp_details_sections,
    product?.details_sections,
    product?.detail_sections,
    product?.details,
    product?.product_details?.sections,
    product?.seed_data?.pdp_details_sections,
    product?.seed_data?.details_sections,
    product?.seed_data?.detail_sections,
    product?.seed_data?.snapshot?.pdp_details_sections,
    product?.seed_data?.snapshot?.details_sections,
    product?.seed_data?.snapshot?.detail_sections,
  ];
  for (const list of directLists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) pushSection(entry);
  }
  return sections;
}

function readIngredientInputs(product) {
  const seedData = asPlainObject(product?.seed_data) || {};
  const snapshot = asPlainObject(seedData.snapshot) || {};
  const ingredientIntel = asPlainObject(product?.ingredient_intel) || asPlainObject(seedData.ingredient_intel) || {};
  const snapshotIngredientIntel = asPlainObject(snapshot.ingredient_intel) || {};
  const authoritative = asPlainObject(ingredientIntel.authoritative) || asPlainObject(snapshotIngredientIntel.authoritative);

  return {
    authoritative,
    seedData,
    snapshot,
    ingredientIntel,
    snapshotIngredientIntel,
    sections: collectSectionBlocks(product),
  };
}

function findLastSectionMatch(text, re) {
  let match = null;
  let next = re.exec(text);
  while (next) {
    match = next;
    next = re.exec(text);
  }
  re.lastIndex = 0;
  return match;
}

function sanitizeIngredientRawText(rawText, { activeOnly = false } = {}) {
  let text = stripHtml(rawText);
  if (!text) return '';

  const sectionRe = activeOnly ? ACTIVE_SECTION_RE : INGREDIENT_SECTION_RE;
  const sectionMatch = findLastSectionMatch(text, sectionRe);
  if (sectionMatch && typeof sectionMatch.index === 'number') {
    text = text.slice(sectionMatch.index + sectionMatch[0].length);
  }

  let cutoff = text.length;
  for (const marker of STOP_MARKERS) {
    const found = marker.exec(text);
    marker.lastIndex = 0;
    if (found && typeof found.index === 'number') {
      cutoff = Math.min(cutoff, found.index);
    }
  }
  text = text.slice(0, cutoff);

  text = text
    .replace(/^[\s:;,.|-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

function splitIngredientText(text) {
  const source = String(text || '');
  if (!source) return [];
  const items = [];
  let current = '';
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    const prev = source[index - 1] || '';
    const next = source[index + 1] || '';
    const nextNonSpace = source.slice(index + 1).match(/\S/)?.[0] || '';
    if (ch === '(') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    const numericChemicalComma = ch === ',' && /\d/.test(prev) && /\d/.test(nextNonSpace);
    const delimiter =
      !numericChemicalComma &&
      (ch === ';' ||
        ch === '\n' ||
        ch === '|' ||
        ch === '•' ||
        (ch === ',' && depth === 0));
    if (delimiter) {
      if (current.trim()) items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function looksLikeQuestion(text) {
  return /\?$/.test(text) || /^can i\b/i.test(text);
}

function isLikelyIngredientItem(value) {
  const text = asString(value);
  if (!text) return false;
  if (SECTION_HEADING_RE.test(text)) return false;
  if (INGREDIENT_FUNCTION_LABEL_RE.test(text)) return false;
  if (looksLikeQuestion(text)) return false;
  if (text.length > 140) return false;
  if (/[:]/.test(text)) return false;
  if (/[.!?]/.test(text)) return false;
  if (/^(warning|warnings|note|how to|shop now|our story|peta-certified)\b/i.test(text)) return false;
  if (MARKETING_SIGNAL_RE.test(text)) return false;
  if (/^\d+$/.test(text)) return false;
  const words = text.split(/\s+/g).filter(Boolean);
  if (words.length > 10) return false;
  return true;
}

function normalizeIngredientItems(values, { max = 160 } = {}) {
  const out = [];
  const seen = new Set();
  const source = Array.isArray(values) ? values : [];
  for (const value of source) {
    const text = asString(value)
      .replace(/^[\s:;,.|-]+/, '')
      .replace(/[\s:;,.|-]+$/, '')
      .replace(/\s+/g, ' ');
    if (!isLikelyIngredientItem(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

const SUNSCREEN_ACTIVE_ITEMS = [
  'Zinc Oxide',
  'Titanium Dioxide',
  'Avobenzone',
  'Octocrylene',
  'Octisalate',
  'Homosalate',
  'Octinoxate',
  'Ensulizole',
  'Meradimate',
  'Oxybenzone',
  'Tinosorb S',
  'Tinosorb M',
  'Uvinul A Plus',
  'Uvinul T 150',
  'Mexoryl SX',
  'Mexoryl XL',
];
const REGULATORY_ACTIVE_ITEMS = [
  ...SUNSCREEN_ACTIVE_ITEMS,
  'Benzoyl Peroxide',
  'Adapalene',
  'Sulfur',
];

function ingredientKey(value) {
  return asString(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function collectProductRoleContext(product) {
  const seedData = asPlainObject(product?.seed_data) || {};
  const snapshot = asPlainObject(seedData.snapshot) || {};
  const contextValues = [
    product?.title,
    product?.name,
    product?.category,
    product?.product_type,
    product?.description,
    product?.pdp_description_raw,
    seedData.description,
    seedData.pdp_description_raw,
    snapshot.description,
    snapshot.pdp_description_raw,
    ...(Array.isArray(product?.tags) ? product.tags : []),
  ];
  for (const section of collectSectionBlocks(product)) {
    if (/ingredient|inci|full ingredient/i.test(asString(section.heading))) continue;
    contextValues.push(section.heading, section.content);
  }
  return contextValues.map((value) => asString(value)).filter(Boolean).join(' ');
}

function collectProductTitleContext(product) {
  return [
    product?.title,
    product?.name,
    product?.category,
    product?.product_type,
  ].map((value) => asString(value)).filter(Boolean).join(' ');
}

function hasExplicitActiveRoleContext(product, value) {
  const text = asString(value);
  if (!text) return false;
  if (VITAMIN_C_ACTIVE_RE.test(text)) {
    const titleContext = collectProductTitleContext(product);
    const roleContext = collectProductRoleContext(product);
    return VITAMIN_C_ACTIVE_RE.test(titleContext) || TRUE_VITAMIN_C_INGREDIENT_RE.test(roleContext);
  }
  if (!CONTEXT_SENSITIVE_HERO_ACTIVE_RE.test(text)) return true;
  const context = collectProductRoleContext(product);
  if (!context) return false;
  return new RegExp(`\\b${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i')
    .test(context);
}

function hasSunscreenContext(product) {
  const contextText = [
    product?.title,
    product?.name,
    product?.category,
    product?.product_type,
    product?.description,
    ...(Array.isArray(product?.tags) ? product.tags : []),
  ]
    .map((value) => asString(value))
    .filter(Boolean)
    .join(' ');
  return SUNSCREEN_CONTEXT_RE.test(contextText);
}

function inferSunscreenActiveItems(product, items, rawText) {
  if (!hasSunscreenContext(product)) return [];
  const haystack = [
    product?.title,
    product?.name,
    product?.category,
    product?.product_type,
    product?.description,
    ...(Array.isArray(product?.tags) ? product.tags : []),
    rawText,
    ...(Array.isArray(items) ? items : []),
  ]
    .map((value) => asString(value))
    .filter(Boolean)
    .join(' ');
  if (!/\b(spf|sunscreen|sun screen|sunblock|sun care|uv protection|zinc oxide|titanium dioxide)\b/i.test(haystack)) {
    return [];
  }
  const normalized = ingredientKey(haystack);
  return SUNSCREEN_ACTIVE_ITEMS.filter((item) => normalized.includes(ingredientKey(item)));
}

function isLowSignalActiveItem(value) {
  return LOW_SIGNAL_ACTIVE_ITEMS.has(asString(value).toLowerCase());
}

function isInvalidActiveItem(value) {
  const text = asString(value);
  if (!text) return true;
  if (INVALID_ACTIVE_FRAGMENT_RE.test(text)) return true;
  if (text.length > 90) return true;
  if (/[.!?]/.test(text)) return true;
  if (/\$/.test(text)) return true;
  return false;
}

function isDisplayableActiveItem(product, value) {
  const text = asString(value);
  if (!text) return false;
  if (isInvalidActiveItem(text)) return false;
  if (REGULATORY_ACTIVE_RE.test(text)) {
    if (/zinc oxide|titanium dioxide/i.test(text)) return hasSunscreenContext(product);
    return true;
  }
  if (isLowSignalActiveItem(text)) return false;
  return HERO_ACTIVE_RE.test(text);
}

function hasPeptideIngredientEvidence(items, rawText) {
  const evidenceText = [
    rawText,
    ...(Array.isArray(items) ? items : []),
  ]
    .map((value) => asString(value))
    .filter(Boolean)
    .join(' ');
  return /\b(?:[a-z]+oyl\s+)?(?:oligo|di|tri|tetra|penta|hexa)?peptide(?:-\d+)?\b/i.test(evidenceText);
}

function ingredientEvidenceText(items, rawText) {
  return [
    rawText,
    ...(Array.isArray(items) ? items : []),
  ]
    .map((value) => asString(value))
    .filter(Boolean)
    .join(' ');
}

function hasTitleDeclaredActiveEvidence(def, normalizedItemsText, evidenceText) {
  if (!def) return false;
  if (Array.isArray(def.evidenceKeys) && def.evidenceKeys.some((key) => normalizedItemsText.includes(key))) {
    return true;
  }
  return def.evidenceRe ? def.evidenceRe.test(evidenceText) : false;
}

function inferTitleDeclaredActiveItems(product, items, rawText) {
  const titleContext = collectProductTitleContext(product);
  if (!titleContext) return [];
  const normalizedItemsText = ingredientKey([rawText, ...(Array.isArray(items) ? items : [])].join(' '));
  if (!normalizedItemsText) return [];
  const evidenceText = ingredientEvidenceText(items, rawText);
  const formulaTitleSignal = /\b\d+(?:\.\d+)?\s*%|\s\+\s|spf\s*\d+/i.test(titleContext);
  const activeItems = [];
  for (const def of TITLE_DECLARED_ACTIVE_DEFS) {
    const titleMatch = def.titleRe.exec(titleContext);
    if (!titleMatch) continue;
    def.titleRe.lastIndex = 0;
    if (!formulaTitleSignal && !/\b(glycolipids?|retinal|retinol|behentrimonium chloride)\b/i.test(def.display)) continue;
    if (!hasTitleDeclaredActiveEvidence(def, normalizedItemsText, evidenceText)) continue;
    activeItems.push({ item: def.display, index: titleMatch.index });
  }
  return uniqueStrings(
    activeItems
      .sort((left, right) => left.index - right.index)
      .map((entry) => entry.item),
    12,
  );
}

function resolveActiveItemWithIngredientEvidence(product, item, normalizedItemsText, items, rawText) {
  const text = asString(item);
  const key = ingredientKey(text);
  if (!text || !normalizedItemsText) return null;
  if (normalizedItemsText.includes(key)) return text;

  if (/^peptides?$/i.test(text) && hasPeptideIngredientEvidence(items, rawText)) {
    return text;
  }

  if (/^(?:panthenol|vitamin b5|provitamin b5)(?:\s*\(b5\))?$/i.test(text) && normalizedItemsText.includes('panthenol')) {
    return /panthenol/i.test(text) ? text : 'Panthenol (B5)';
  }

  if (/^pha$/i.test(text) && normalizedItemsText.includes('gluconolactone')) {
    return text;
  }

  if (
    /^phyto ?ceramides?$/i.test(text) &&
    /(?:phytosteryl|ceramide|phytoceramide)/i.test(ingredientEvidenceText(items, rawText))
  ) {
    return text;
  }

  if (
    /^volufiline$/i.test(text) &&
    /(?:anemarrhenaasphodeloidesrootextract|hydrogenatedpolyisobutene)/.test(normalizedItemsText)
  ) {
    return text;
  }

  if (
    VITAMIN_C_ACTIVE_RE.test(text) &&
    TRUE_VITAMIN_C_INGREDIENT_RE.test([rawText, collectProductRoleContext(product)].join(' '))
  ) {
    return text;
  }

  return null;
}

function filterDisplayableActiveItems(product, items) {
  return uniqueStrings(
    (Array.isArray(items) ? items : []).filter((item) => isDisplayableActiveItem(product, item)),
  );
}

function classifySuppressedActiveItems(items) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) return null;
  if (source.some(isInvalidActiveItem)) return 'active_items_invalid_fragment';
  if (source.some(isLowSignalActiveItem)) return 'active_items_low_signal';
  return 'active_items_not_displayable';
}

function reconcileActiveItemsWithIngredients(product, activeItems, items, rawText, options = {}) {
  const normalizedItemsText = ingredientKey([rawText, ...(Array.isArray(items) ? items : [])].join(' '));
  const normalizedActiveItems = normalizeIngredientItems(activeItems, { max: 32 });
  const inferredSunscreenActives = inferSunscreenActiveItems(product, items, rawText);
  const shouldValidateAgainstIngredients =
    options.validateAgainstIngredients === true &&
    normalizedItemsText &&
    Array.isArray(items) &&
    items.length >= 3;
  if (
    !inferredSunscreenActives.length &&
    !shouldValidateAgainstIngredients &&
    options.validateAgainstIngredients !== true
  ) {
    return normalizedActiveItems;
  }
  const retained = shouldValidateAgainstIngredients || inferredSunscreenActives.length
    ? normalizedActiveItems.map((item) => resolveActiveItemWithIngredientEvidence(
        product,
        item,
        normalizedItemsText,
        items,
        rawText,
      )).filter((item) => {
        if (!item) return false;
        if (
          shouldValidateAgainstIngredients &&
          (CONTEXT_SENSITIVE_HERO_ACTIVE_RE.test(item) || VITAMIN_C_ACTIVE_RE.test(item)) &&
          !hasExplicitActiveRoleContext(product, item)
        ) {
          return false;
        }
        return true;
      })
    : normalizedActiveItems;
  const roleValidated = options.validateAgainstIngredients === true
    ? retained.filter((item) => hasExplicitActiveRoleContext(product, item))
    : retained;
  return uniqueStrings([
    ...roleValidated,
    ...inferredSunscreenActives,
  ]).filter((item) => isDisplayableActiveItem(product, item));
}

function isReviewedIngredientAuthoritySource(sourceOrigin) {
  const normalized = asString(sourceOrigin).toLowerCase();
  return normalized === 'kb_reviewed' || normalized === 'kb_reviewed_read_through';
}

function buildAuthorityRecord({
  rawText = '',
  items = [],
  activeItems = [],
  sourceOrigin = '',
  purityStatus = '',
  suppressedReason = null,
  generatedAt = null,
} = {}) {
  const normalizedItems = normalizeIngredientItems(items, { max: 180 });
  const normalizedActives = normalizeIngredientItems(activeItems, { max: 32 });
  const raw = asString(rawText);
  return {
    raw_text: raw || undefined,
    items: normalizedItems,
    active_items: normalizedActives,
    source_origin: asString(sourceOrigin) || undefined,
    purity_status: asString(purityStatus) || undefined,
    suppressed_reason: asString(suppressedReason) || undefined,
    generated_at: asString(generatedAt) || new Date().toISOString(),
  };
}

function readStructuredArrayAuthority(product) {
  const readItems = (...values) => {
    for (const value of values) {
      const list = Array.isArray(value)
        ? value
        : value && typeof value === 'object' && Array.isArray(value.items)
          ? value.items
          : null;
      if (list) {
        return list.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
          return item.title || item.name || item.label || item.value || item.text || '';
        });
      }
    }
    return [];
  };
  const directItems = normalizeIngredientItems(
    readItems(
      product?.ingredients_inci,
      product?.ingredientsInci,
      product?.inci_ingredients,
      product?.inciIngredients,
      product?.ingredients,
      product?.inci,
    ),
  );
  const rawText = asString(
    product?.ingredients_inci?.raw_text ||
      product?.ingredientsInci?.raw_text ||
      product?.inci_ingredients?.raw_text ||
      product?.inciIngredients?.raw_text ||
      product?.ingredients?.raw_text ||
      product?.inci?.raw_text,
  );
  const parsedRawItems = directItems.length < 3 && rawText
    ? normalizeIngredientItems(splitIngredientText(sanitizeIngredientRawText(rawText)), { max: 180 })
    : [];
  const finalItems = directItems.length >= 3 ? directItems : parsedRawItems;
  if (finalItems.length < 3) return null;
  const activeItems = normalizeIngredientItems(
    readItems(product?.active_ingredients, product?.activeIngredients),
  );
  return buildAuthorityRecord({
    rawText: rawText || finalItems.join(', '),
    items: finalItems,
    activeItems,
    sourceOrigin: 'structured_array',
    purityStatus: 'authoritative',
  });
}

function parseCandidateRawText(rawText, sourceOrigin) {
  const sanitized = sanitizeIngredientRawText(rawText);
  if (!sanitized) return null;
  const items = normalizeIngredientItems(splitIngredientText(sanitized), { max: 180 });
  if (items.length < 3) return null;
  return buildAuthorityRecord({
    rawText: sanitized,
    items,
    sourceOrigin,
    purityStatus: 'authoritative',
  });
}

function buildAuthorityFromSections(product, sections) {
  const ranked = [];
  for (const section of sections) {
    const heading = asString(section.heading);
    const content = asString(section.content);
    if (!heading || !content) continue;
    const normalizedHeading = heading.toLowerCase();
    if (normalizedHeading.includes('active ingredient')) continue;
    const hasIngredientHeading =
      SECTION_HEADING_RE.test(heading) || /(full ingredients?|ingredients|inci)/i.test(heading);
    const hasInlineIngredientLabel = INGREDIENT_SECTION_RE.test(content);
    INGREDIENT_SECTION_RE.lastIndex = 0;
    if (!hasIngredientHeading && !hasInlineIngredientLabel) continue;
    const parsed = parseCandidateRawText(content, 'pdp_section');
    if (!parsed) continue;
    ranked.push(parsed);
  }
  return ranked
    .sort((left, right) => {
      const leftPriority = SOURCE_PRIORITY[left.source_origin] || 0;
      const rightPriority = SOURCE_PRIORITY[right.source_origin] || 0;
      if (leftPriority !== rightPriority) return rightPriority - leftPriority;
      return (right.items?.length || 0) - (left.items?.length || 0);
    })
    .shift() || null;
}

function buildAuthorityFromLegacyRaw(product, inputs) {
  const candidates = [
    product?.pdp_ingredients_raw,
    product?.pdpIngredientsRaw,
    product?.raw_ingredient_text_clean,
    product?.inci_list,
    inputs.seedData?.pdp_ingredients_raw,
    inputs.seedData?.raw_ingredient_text_clean,
    inputs.seedData?.inci_list,
    inputs.snapshot?.pdp_ingredients_raw,
    inputs.snapshot?.raw_ingredient_text_clean,
    inputs.snapshot?.inci_list,
    inputs.ingredientIntel?.raw_ingredient_text_clean,
    inputs.ingredientIntel?.inci_list,
    inputs.snapshotIngredientIntel?.raw_ingredient_text_clean,
    inputs.snapshotIngredientIntel?.inci_list,
  ];
  const parsed = [];
  for (const candidate of candidates) {
    const authority = parseCandidateRawText(candidate, 'pdp_section');
    if (authority) parsed.push(authority);
  }
  return parsed.sort((left, right) => (right.items?.length || 0) - (left.items?.length || 0)).shift() || null;
}

function canonicalizeActiveCandidateLabel(value) {
  const text = asString(value);
  if (!text) return '';
  const sunscreenActive = REGULATORY_ACTIVE_ITEMS.find((item) => {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`^${escaped}\\b`, 'i').test(text);
  });
  if (sunscreenActive) return sunscreenActive;
  const percentMatch = text.match(/^([A-Za-z][A-Za-z\s-]+?)\s+\d+(?:\.\d+)?\s*%/);
  if (percentMatch) {
    const label = asString(percentMatch[1]);
    if (label && (HERO_ACTIVE_RE.test(label) || REGULATORY_ACTIVE_RE.test(label))) return label;
  }
  return text;
}

function extractRegulatoryActiveItemsFromText(value) {
  const text = asString(value);
  if (!text) return [];
  return REGULATORY_ACTIVE_ITEMS.map((item) => {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const match = new RegExp(`\\b${escaped}\\b`, 'i').exec(text);
    return match ? { item, index: match.index } : null;
  })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index)
    .map((match) => match.item);
}

function isActiveCompatibilityText(value) {
  const text = asString(value);
  if (!text) return false;
  ACTIVE_SECTION_RE.lastIndex = 0;
  if (ACTIVE_SECTION_RE.test(text)) {
    ACTIVE_SECTION_RE.lastIndex = 0;
    return false;
  }
  ACTIVE_SECTION_RE.lastIndex = 0;
  return /\b(can i use this with an active ingredient|works? well with active ingredients?|active ingredients? or treatments?)\b/i
    .test(text);
}

function activeCandidate(items, sourceOrigin, options = {}) {
  const normalized = normalizeIngredientItems(
    (Array.isArray(items) ? items : []).map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return canonicalizeActiveCandidateLabel(item);
      return canonicalizeActiveCandidateLabel(item.title || item.name || item.label || item.value || item.text || '');
    }),
    { max: 16 },
  );
  if (!normalized.length) return null;
  return {
    items: normalized,
    source_origin: sourceOrigin,
    validateAgainstIngredients: options.validateAgainstIngredients === true,
  };
}

function readExplicitActiveCandidates(product, inputs) {
  const blocks = [
    product?.pdp_active_ingredients_raw,
    product?.pdpActiveIngredientsRaw,
    inputs.seedData?.pdp_active_ingredients_raw,
    inputs.snapshot?.pdp_active_ingredients_raw,
  ];
  for (const block of blocks) {
    if (isActiveCompatibilityText(block)) continue;
    const sanitized = sanitizeIngredientRawText(block, { activeOnly: true });
    const candidate = activeCandidate([
      ...extractRegulatoryActiveItemsFromText(sanitized),
      ...splitIngredientText(sanitized),
    ], 'active_block');
    if (candidate && candidate.items.some((item) => isDisplayableActiveItem(product, item))) {
      return candidate;
    }
  }

  const activeSections = inputs.sections
    .filter((section) => (
      /active ingredients?/i.test(asString(section.heading)) &&
      !looksLikeQuestion(asString(section.heading)) &&
      !isActiveCompatibilityText(section.content)
    ))
    .map((section) => section.content);
  for (const content of activeSections) {
    const sanitized = sanitizeIngredientRawText(content, { activeOnly: true });
    const candidate = activeCandidate([
      ...extractRegulatoryActiveItemsFromText(sanitized),
      ...splitIngredientText(sanitized),
    ], 'active_section');
    if (candidate && candidate.items.some((item) => isDisplayableActiveItem(product, item))) {
      return candidate;
    }
  }

  return null;
}

function readActiveCandidates(product, inputs) {
  const explicit = readExplicitActiveCandidates(product, inputs);
  if (explicit) return explicit;

  const arrays = [
    { value: product?.active_ingredients, source: 'product_active_array', validateAgainstIngredients: true },
    { value: product?.activeIngredients, source: 'product_active_array', validateAgainstIngredients: true },
    { value: inputs.ingredientIntel?.authoritative?.active_items, source: 'existing_authority' },
    { value: inputs.ingredientIntel?.active_ingredients, source: 'ingredient_intel_array', validateAgainstIngredients: true },
    { value: inputs.seedData?.active_ingredients, source: 'seed_active_array', validateAgainstIngredients: true },
    { value: inputs.snapshot?.active_ingredients, source: 'snapshot_active_array', validateAgainstIngredients: true },
  ];
  for (const candidate of arrays) {
    const result = activeCandidate(candidate.value, candidate.source, {
      validateAgainstIngredients: candidate.validateAgainstIngredients,
    });
    if (result) return result;
  }

  return activeCandidate([], 'none') || { items: [], source_origin: 'none', validateAgainstIngredients: false };
}

function buildAuthoritativeIngredientView(product, options = {}) {
  const inputs = readIngredientInputs(product);
  const generatedAt = options.generatedAt || new Date().toISOString();

  const existingAuthority = asPlainObject(inputs.authoritative);
  if (existingAuthority) {
    const existingSourceOrigin = existingAuthority.source_origin || 'existing_authority';
    const normalizedExisting = buildAuthorityRecord({
      rawText: existingAuthority.raw_text,
      items: existingAuthority.items,
      activeItems: existingAuthority.active_items,
      sourceOrigin: existingSourceOrigin,
      purityStatus: existingAuthority.purity_status || 'authoritative',
      suppressedReason: existingAuthority.suppressed_reason,
      generatedAt: existingAuthority.generated_at || generatedAt,
    });
    if (normalizedExisting.items.length || normalizedExisting.active_items.length) {
      return {
        ...normalizedExisting,
        active_items: reconcileActiveItemsWithIngredients(
          product,
          normalizedExisting.active_items,
          normalizedExisting.items,
          normalizedExisting.raw_text,
          { validateAgainstIngredients: !isReviewedIngredientAuthoritySource(existingSourceOrigin) },
        ),
      };
    }
  }

  const fromStructuredArray = readStructuredArrayAuthority(product);
  const fromSections = buildAuthorityFromSections(product, inputs.sections);
  const fromLegacy = buildAuthorityFromLegacyRaw(product, inputs);
  const picked =
    [fromSections, fromStructuredArray, fromLegacy]
      .filter(Boolean)
      .sort((left, right) => {
        const leftPriority = SOURCE_PRIORITY[left.source_origin] || 0;
        const rightPriority = SOURCE_PRIORITY[right.source_origin] || 0;
        if (leftPriority !== rightPriority) return rightPriority - leftPriority;
        return (right.items?.length || 0) - (left.items?.length || 0);
      })[0] || null;

  const activeCandidateResult = readActiveCandidates(product, inputs);
  const activeItems = activeCandidateResult.items;
  if (picked) {
    const titleDeclaredActiveItems = inferTitleDeclaredActiveItems(product, picked.items, picked.raw_text);
    const candidateActiveItems = uniqueStrings([
      ...(activeItems.length ? activeItems : picked.active_items),
      ...titleDeclaredActiveItems,
    ]);
    const reconciledActiveItems = reconcileActiveItemsWithIngredients(
      product,
      candidateActiveItems,
      picked.items,
      picked.raw_text,
      {
        validateAgainstIngredients: activeItems.length
          ? activeCandidateResult.validateAgainstIngredients
          : titleDeclaredActiveItems.length > 0,
      },
    );
    return buildAuthorityRecord({
      rawText: picked.raw_text,
      items: picked.items,
      activeItems: reconciledActiveItems,
      sourceOrigin: picked.source_origin,
      purityStatus: 'authoritative',
      suppressedReason:
        candidateActiveItems.length && !reconciledActiveItems.length
          ? classifySuppressedActiveItems(candidateActiveItems)
          : null,
      generatedAt,
    });
  }

  if (activeItems.length) {
    const displayableActiveItems = filterDisplayableActiveItems(product, activeItems)
      .filter((item) => {
        if (!activeCandidateResult.validateAgainstIngredients) return true;
        return hasExplicitActiveRoleContext(product, item);
      });
    if (!displayableActiveItems.length) {
      return buildAuthorityRecord({
        items: [],
        activeItems: [],
        sourceOrigin: 'none',
        purityStatus: 'suppressed',
        suppressedReason: classifySuppressedActiveItems(activeItems) || 'active_items_not_displayable',
        generatedAt,
      });
    }
    return buildAuthorityRecord({
      items: [],
      activeItems: displayableActiveItems,
      sourceOrigin: 'active_block',
      purityStatus: 'suppressed',
      suppressedReason: 'full_inci_low_purity',
      generatedAt,
    });
  }

  return buildAuthorityRecord({
    items: [],
    activeItems: [],
    sourceOrigin: 'none',
    purityStatus: 'suppressed',
    suppressedReason: 'no_authoritative_source',
    generatedAt,
  });
}

function mergeIngredientIntelWithAuthority(existingValue, authority) {
  const existing = asPlainObject(existingValue) || {};
  if (!authority || (authority.items?.length || 0) === 0 && (authority.active_items?.length || 0) === 0) {
    return existing;
  }
  return {
    ...existing,
    authoritative: {
      ...asPlainObject(existing.authoritative),
      ...authority,
    },
  };
}

function buildStructuredPdpIngredientModules(product, options = {}) {
  const authority = buildAuthoritativeIngredientView(product, options);
  const ingredientsInciData =
    authority.purity_status === 'authoritative' && Array.isArray(authority.items) && authority.items.length
      ? {
          title: 'Ingredients (INCI)',
          items: authority.items,
          raw_text: authority.raw_text || undefined,
          source_origin: authority.source_origin || 'pdp_section',
          source_quality_status: authority.purity_status,
        }
      : null;
  const activeIngredientsData =
    Array.isArray(authority.active_items) && authority.active_items.length
      ? {
          title: 'Active Ingredients',
          items: authority.active_items,
          source_origin: authority.source_origin || 'active_block',
          source_quality_status: authority.active_items.some((item) => REGULATORY_ACTIVE_RE.test(item))
            ? 'regulatory_active'
            : authority.purity_status === 'suppressed'
              ? 'captured'
              : authority.purity_status || 'authoritative',
        }
      : null;
  return {
    authority,
    ingredientsInciData,
    activeIngredientsData,
  };
}

module.exports = {
  buildAuthoritativeIngredientView,
  buildStructuredPdpIngredientModules,
  mergeIngredientIntelWithAuthority,
  _internals: {
    sanitizeIngredientRawText,
    splitIngredientText,
    normalizeIngredientItems,
    isLikelyIngredientItem,
  },
};
