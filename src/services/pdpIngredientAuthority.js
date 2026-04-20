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

function ingredientKey(value) {
  return asString(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function inferSunscreenActiveItems(product, items, rawText) {
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

function reconcileActiveItemsWithIngredients(product, activeItems, items, rawText, options = {}) {
  const normalizedItemsText = ingredientKey([rawText, ...(Array.isArray(items) ? items : [])].join(' '));
  const normalizedActiveItems = normalizeIngredientItems(activeItems, { max: 32 });
  const inferredSunscreenActives = inferSunscreenActiveItems(product, items, rawText);
  const shouldValidateAgainstIngredients =
    options.validateAgainstIngredients === true &&
    normalizedItemsText &&
    Array.isArray(items) &&
    items.length >= 3;
  if (!inferredSunscreenActives.length && !shouldValidateAgainstIngredients) return normalizedActiveItems;
  const retained = shouldValidateAgainstIngredients || inferredSunscreenActives.length
    ? normalizedActiveItems.filter((item) => {
        const key = ingredientKey(item);
        return !normalizedItemsText || normalizedItemsText.includes(key);
      })
    : normalizedActiveItems;
  return uniqueStrings([
    ...retained,
    ...inferredSunscreenActives,
  ]);
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
  const directItems = normalizeIngredientItems(
    Array.isArray(product?.ingredients_inci)
      ? product.ingredients_inci
      : Array.isArray(product?.ingredients)
        ? product.ingredients
        : Array.isArray(product?.inci)
          ? product.inci
          : [],
  );
  if (directItems.length < 3) return null;
  const activeItems = normalizeIngredientItems(
    Array.isArray(product?.active_ingredients)
      ? product.active_ingredients
      : Array.isArray(product?.activeIngredients)
        ? product.activeIngredients
        : [],
  );
  return buildAuthorityRecord({
    rawText: directItems.join(', '),
    items: directItems,
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

function activeCandidate(items, sourceOrigin, options = {}) {
  const normalized = normalizeIngredientItems(Array.isArray(items) ? items : [], { max: 16 });
  if (!normalized.length) return null;
  return {
    items: normalized,
    source_origin: sourceOrigin,
    validateAgainstIngredients: options.validateAgainstIngredients === true,
  };
}

function readActiveCandidates(product, inputs) {
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

  const blocks = [
    product?.pdp_active_ingredients_raw,
    product?.pdpActiveIngredientsRaw,
    inputs.seedData?.pdp_active_ingredients_raw,
    inputs.snapshot?.pdp_active_ingredients_raw,
  ];
  for (const block of blocks) {
    const sanitized = sanitizeIngredientRawText(block, { activeOnly: true });
    const items = normalizeIngredientItems(splitIngredientText(sanitized), { max: 16 });
    if (items.length) return activeCandidate(items, 'active_block');
  }

  const activeSections = inputs.sections
    .filter((section) => /active ingredients?/i.test(asString(section.heading)))
    .map((section) => section.content);
  for (const content of activeSections) {
    const sanitized = sanitizeIngredientRawText(content, { activeOnly: true });
    const items = normalizeIngredientItems(splitIngredientText(sanitized), { max: 16 });
    if (items.length) return activeCandidate(items, 'active_section');
  }

  return activeCandidate([], 'none') || { items: [], source_origin: 'none', validateAgainstIngredients: false };
}

function buildAuthoritativeIngredientView(product, options = {}) {
  const inputs = readIngredientInputs(product);
  const generatedAt = options.generatedAt || new Date().toISOString();

  const existingAuthority = asPlainObject(inputs.authoritative);
  if (existingAuthority) {
    const normalizedExisting = buildAuthorityRecord({
      rawText: existingAuthority.raw_text,
      items: existingAuthority.items,
      activeItems: existingAuthority.active_items,
      sourceOrigin: existingAuthority.source_origin || 'existing_authority',
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
    return buildAuthorityRecord({
      rawText: picked.raw_text,
      items: picked.items,
      activeItems: reconcileActiveItemsWithIngredients(
        product,
        activeItems.length ? activeItems : picked.active_items,
        picked.items,
        picked.raw_text,
        { validateAgainstIngredients: activeItems.length ? activeCandidateResult.validateAgainstIngredients : false },
      ),
      sourceOrigin: picked.source_origin,
      purityStatus: 'authoritative',
      generatedAt,
    });
  }

  if (activeItems.length) {
    return buildAuthorityRecord({
      items: [],
      activeItems,
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
          source_quality_status: authority.purity_status || 'authoritative',
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
