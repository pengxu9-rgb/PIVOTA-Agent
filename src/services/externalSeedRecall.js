const SYNTHETIC_SUMMARY_RE = /\bOFFICIAL:[\s\S]*\/\/\/\s*SOCIAL HIGHLIGHTS:/i;
const TEMPLATE_PREFIX_RE = /^experience the ultimate luxury with\s+/i;
const RECALL_NOISE_RE =
  /\b(contact us|customer service|privacy policy|terms(?: and conditions)?|shipping policy|return policy|about us|our story|blog|blogs|impact|foundation transparency|transparency|give 20%|give back|charity|donation|store locator|faq|support)\b/i;
const GIFT_CARD_RE = /\b(e-?gift\s*card|gift\s*card|digital\s+gift\s+card)\b/i;
const DONATION_RE = /\b(donation|donate|charity)\b/i;
const NON_MERCH_PAGE_RE =
  /(?:^|\/)(?:collections?|collection|category|catalogsearch|search|cart|account|customer|blog|blogs|pages?|faq|privacy|terms|wishlist|gift(?:ing)?|store-locator|customer-service|all-products|appointments?|booking|online-booking|locations?|contact-us)(?:\/|$)/i;
const BEAUTY_VERTICAL_PATTERNS = Object.freeze([
  ['gift_card', GIFT_CARD_RE],
  ['fragrance', /\b(fragrance|perfume|parfum|cologne|eau de parfum|eau de toilette|scent)\b/i],
  ['haircare', /\b(shampoo|conditioner|hair|leave-in|leave in|detangling|repair mask|hair mask|scalp|curl|edge control|styling gel)\b/i],
  ['beauty_tools', /\b(brush|makeup brush|kabuki|tool|tools|applicator|sponge|detangling brush)\b/i],
  ['makeup', /\b(concealer|foundation|powder|mascara|lip|lipstick|gloss|blush|bronzer|eyeshadow|eye shadow|brow|liner|highlighter)\b/i],
  ['skincare', /\b(cleanser|serum|toner|mist|cream|moisturizer|moisturiser|mask|treatment|essence|ampoule|sunscreen|spf|lotion)\b/i],
]);

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function decodeHtmlEntities(input) {
  return String(input || '')
    .replace(/&#(\d+);?/g, (_match, code) => {
      const numeric = Number(code);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : _match;
    })
    .replace(/&#x([0-9a-f]+);?/gi, (_match, code) => {
      const numeric = Number.parseInt(code, 16);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : _match;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&mdash;/gi, '-')
    .replace(/&ndash;/gi, '-')
    .replace(/&hellip;/gi, '...');
}

function ensureJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeUrlLike(value) {
  const normalized = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function normalizeWhitespace(value) {
  return decodeHtmlEntities(value)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/?\s*(?:p|div|section|article|header|footer|blockquote|h[1-6]|ul|ol|li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeKey(value) {
  return normalizeNonEmptyString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = normalizeNonEmptyString(value);
    if (normalized) return normalized;
  }
  return '';
}

function splitSentences(value) {
  return normalizeWhitespace(value)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitBlocks(value) {
  return normalizeWhitespace(value)
    .split(/\n{2,}|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupeStrings(items, maxItems = 64) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeNonEmptyString(item);
    const key = normalizeKey(normalized);
    if (!normalized || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function looksLikeRecallNoise(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) return false;
  return SYNTHETIC_SUMMARY_RE.test(normalized) || RECALL_NOISE_RE.test(normalized);
}

function stripRecallNarrativeNoise(value) {
  let text = normalizeWhitespace(value);
  if (!text) return '';
  text = text.replace(/^(?:details?\b[\s:.-]*){1,}/i, '').trim();
  const cutPatterns = [
    /\blearn more\s+close\b/i,
    /\bavoid contact with eyes\b/i,
    /\bkeep out of reach of children\b/i,
    /\bcustomerservice@/i,
    /\bgive\s+20%/i,
  ];
  for (const pattern of cutPatterns) {
    const match = text.match(pattern);
    const cutIndex = match?.index ?? -1;
    if (cutIndex >= 0 && cutIndex < 24) return '';
    if (cutIndex >= 24) {
      text = text.slice(0, cutIndex).trim();
      break;
    }
  }
  return text;
}

function cleanRecallTitle(value, { brand = '' } = {}) {
  let text = stripRecallNarrativeNoise(value);
  if (!text) return '';
  text = text.replace(SYNTHETIC_SUMMARY_RE, ' ').replace(TEMPLATE_PREFIX_RE, '').trim();
  text = text.split(/\s*\/\/\/\s*/)[0].trim();
  text = text.replace(/^\s*(official|social highlights?)\s*:\s*/i, '').trim();
  if (!text || looksLikeRecallNoise(text)) return '';

  const normalizedBrand = normalizeKey(brand);
  if (normalizedBrand) {
    const brandPrefix = new RegExp(`^${normalizedBrand.replace(/\s+/g, '\\s+')}\\s*[-:|/]+\\s*`, 'i');
    const brandSuffix = new RegExp(`\\s*[-:|/]+\\s*${normalizedBrand.replace(/\s+/g, '\\s+')}$`, 'i');
    text = text.replace(brandPrefix, '').replace(brandSuffix, '').trim() || text;
  }

  return text.replace(/\s+/g, ' ').trim();
}

function cleanRecallBlocks(items, { maxItems = 24 } = {}) {
  const out = [];
  const seen = new Set();
  for (const rawItem of Array.isArray(items) ? items : []) {
    const normalized = stripRecallNarrativeNoise(rawItem);
    const key = normalizeKey(normalized);
    if (!normalized || !key || seen.has(key)) continue;
    if (looksLikeRecallNoise(normalized)) continue;
    if (normalized.length < 12 && /^(details?|benefits?|ingredients?|how to use)$/i.test(normalized)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanRecallSummary(value, { maxSentences = 2, maxChars = 320 } = {}) {
  const sentences = cleanRecallBlocks(splitSentences(stripRecallNarrativeNoise(value)), {
    maxItems: Math.max(2, maxSentences * 2),
  });
  if (!sentences.length) return '';
  let summary = sentences.slice(0, maxSentences).join(' ');
  if (summary.length > maxChars) {
    summary = `${summary.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
  }
  return summary;
}

function cleanRecallBody(values, { maxChars = 1800 } = {}) {
  const blocks = cleanRecallBlocks(
    (Array.isArray(values) ? values : [values])
      .map((value) => stripRecallNarrativeNoise(value))
      .filter(Boolean)
      .flatMap((value) => splitBlocks(value)),
    { maxItems: 24 },
  );
  if (!blocks.length) return '';
  let body = blocks.join('\n\n');
  if (body.length > maxChars) {
    body = `${body.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
  }
  return body;
}

function normalizeToken(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildTokenList(values, { maxItems = 32, minLength = 3 } = {}) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const normalized = normalizeToken(value);
    if (!normalized) return;
    for (const part of normalized.split(/\s+/)) {
      if (!part || part.length < minLength || /^\d+$/.test(part) || seen.has(part)) continue;
      seen.add(part);
      out.push(part);
      if (out.length >= maxItems) return;
    }
  };

  const visit = (input) => {
    if (out.length >= maxItems || input == null) return;
    if (typeof input === 'string') {
      push(input);
      return;
    }
    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }
    if (typeof input === 'object') {
      Object.values(input).forEach(visit);
    }
  };

  visit(values);
  return out.slice(0, maxItems);
}

function normalizeIngredientTokens(seedData = {}, snapshot = {}, row = {}) {
  return buildTokenList(
    [
      row?.ingredient_tokens,
      row?.key_ingredients,
      row?.active_ingredients,
      seedData?.ingredient_tokens,
      seedData?.key_ingredients,
      seedData?.keyIngredients,
      seedData?.active_ingredients,
      seedData?.activeIngredients,
      seedData?.ingredient_names,
      seedData?.ingredientNames,
      seedData?.ingredients,
      snapshot?.ingredient_tokens,
      snapshot?.key_ingredients,
      snapshot?.keyIngredients,
      snapshot?.active_ingredients,
      snapshot?.activeIngredients,
      snapshot?.ingredient_names,
      snapshot?.ingredientNames,
      snapshot?.ingredients,
    ],
    { maxItems: 24, minLength: 2 },
  );
}

function buildAliasTokens({ retrievalTitle = '', category = '', brand = '' } = {}) {
  const stopwords = new Set(
    ['the', 'and', 'for', 'with', 'from', 'official', 'beauty', 'shop', 'product', 'products', 'new'],
  );
  const brandTokens = new Set(buildTokenList([brand], { maxItems: 8, minLength: 2 }));
  return buildTokenList([retrievalTitle, category], { maxItems: 24, minLength: 2 }).filter(
    (token) => !stopwords.has(token) && !brandTokens.has(token),
  );
}

function detectExclusionFlags({ title = '', canonicalUrl = '', destinationUrl = '', summary = '', body = '' } = {}) {
  const combined = [title, canonicalUrl, destinationUrl, summary, body].filter(Boolean).join(' ');
  return {
    gift_card: GIFT_CARD_RE.test(combined),
    donation_bundle: DONATION_RE.test(combined),
    non_merchandise: NON_MERCH_PAGE_RE.test(canonicalUrl) || NON_MERCH_PAGE_RE.test(destinationUrl),
  };
}

function inferVertical({ title = '', category = '', summary = '', body = '', exclusionFlags = null } = {}) {
  if (exclusionFlags?.gift_card) return 'gift_card';
  const combined = [title, category, summary, body]
    .filter(Boolean)
    .join(' ')
    .replace(/\bfragrance[-\s]?free\b/gi, ' ');
  for (const [label, pattern] of BEAUTY_VERTICAL_PATTERNS) {
    if (pattern.test(combined)) return label;
  }
  return 'beauty';
}

function getRecallSourceTitle(seedData = {}, snapshot = {}, row = {}) {
  return firstNonEmptyString(snapshot.title, seedData.title, row.title, row.seed_title);
}

function collectRecallTextCandidates(seedData = {}, snapshot = {}, row = {}) {
  const detailBodies = []
    .concat(Array.isArray(seedData.pdp_details_sections) ? seedData.pdp_details_sections : [])
    .concat(Array.isArray(snapshot.pdp_details_sections) ? snapshot.pdp_details_sections : [])
    .map((section) => normalizeNonEmptyString(section?.body || section?.content || section?.text))
    .filter(Boolean);

  return dedupeStrings([
    seedData.pdp_description_raw,
    snapshot.pdp_description_raw,
    seedData.description,
    snapshot.description,
    row.description,
    row.seed_description,
    ...detailBodies,
  ]);
}

function buildExternalSeedRecallDoc({ row = {}, seedData = {}, snapshot = {} } = {}) {
  const brand = firstNonEmptyString(seedData.brand, snapshot.brand, row.seed_brand, row.brand);
  const category = firstNonEmptyString(
    seedData.category,
    seedData.product_type,
    seedData?.product?.category,
    snapshot.category,
    snapshot.product_type,
    row.seed_category,
    row.seed_product_type,
    row.category,
    row.product_type,
  );
  const titleSource = getRecallSourceTitle(seedData, snapshot, row);
  const rawTextCandidates = collectRecallTextCandidates(seedData, snapshot, row);
  const summary = cleanRecallSummary(rawTextCandidates.join('\n\n'));
  const body = cleanRecallBody(rawTextCandidates);
  const retrievalTitle =
    cleanRecallTitle(titleSource, { brand }) || cleanRecallTitle(firstNonEmptyString(row.title, titleSource), { brand });
  const exclusionFlags = detectExclusionFlags({
    title: retrievalTitle || titleSource,
    canonicalUrl: normalizeUrlLike(snapshot.canonical_url || row.canonical_url || seedData.canonical_url),
    destinationUrl: normalizeUrlLike(snapshot.destination_url || row.destination_url || seedData.destination_url),
    summary,
    body,
  });
  const vertical = inferVertical({
    title: retrievalTitle,
    category,
    summary,
    body,
    exclusionFlags,
  });
  const syntheticSummary =
    SYNTHETIC_SUMMARY_RE.test(rawTextCandidates.join('\n\n')) ||
    normalizeNonEmptyString(seedData.seed_description_origin || snapshot.seed_description_origin) === 'synthetic_summary';
  const templatePolluted = rawTextCandidates.some((item) => TEMPLATE_PREFIX_RE.test(item) || looksLikeRecallNoise(item));
  const ingredientTokens = normalizeIngredientTokens(seedData, snapshot, row);

  return {
    retrieval_title: retrievalTitle || titleSource || normalizeUrlLike(row.canonical_url || row.destination_url),
    retrieval_summary: summary,
    retrieval_body: body,
    brand: brand || null,
    category: category || null,
    vertical: vertical || null,
    ingredient_tokens: ingredientTokens,
    alias_tokens: buildAliasTokens({ retrievalTitle: retrievalTitle || titleSource, category, brand }),
    exclusion_flags: exclusionFlags,
    quality_signals: {
      template_polluted: Boolean(templatePolluted),
      synthetic_summary: Boolean(syntheticSummary),
      extractor_description_present: Boolean(
        normalizeNonEmptyString(seedData.pdp_description_raw || snapshot.pdp_description_raw),
      ),
    },
    version: 'v1',
  };
}

function readStoredRecallDoc(seedData) {
  return ensureJsonObject(ensureJsonObject(seedData).derived?.recall);
}

function resolveExternalSeedRecallDoc({ row = {}, seedData = {}, snapshot = {} } = {}) {
  const stored = readStoredRecallDoc(seedData);
  if (
    normalizeNonEmptyString(stored.retrieval_title) ||
    normalizeNonEmptyString(stored.retrieval_summary) ||
    normalizeNonEmptyString(stored.retrieval_body)
  ) {
    const fallback = buildExternalSeedRecallDoc({ row, seedData, snapshot });
    const brand = firstNonEmptyString(stored.brand, fallback.brand);
    const category = firstNonEmptyString(stored.category, fallback.category);
    const retrievalTitle =
      cleanRecallTitle(firstNonEmptyString(stored.retrieval_title, fallback.retrieval_title), { brand }) ||
      fallback.retrieval_title;
    const retrievalSummary =
      cleanRecallSummary(firstNonEmptyString(stored.retrieval_summary, fallback.retrieval_summary, stored.retrieval_body)) ||
      fallback.retrieval_summary;
    const retrievalBody = cleanRecallBody([stored.retrieval_body, fallback.retrieval_body, stored.retrieval_summary]);
    const exclusionFlags = detectExclusionFlags({
      title: retrievalTitle,
      canonicalUrl: normalizeUrlLike(snapshot.canonical_url || row.canonical_url || seedData.canonical_url),
      destinationUrl: normalizeUrlLike(snapshot.destination_url || row.destination_url || seedData.destination_url),
      summary: retrievalSummary,
      body: retrievalBody,
    });
    const vertical = inferVertical({
      title: retrievalTitle,
      category,
      summary: retrievalSummary,
      body: retrievalBody,
      exclusionFlags,
    });

    return {
      ...buildExternalSeedRecallDoc({ row, seedData, snapshot }),
      ...stored,
      retrieval_title: retrievalTitle,
      retrieval_summary: retrievalSummary,
      retrieval_body: retrievalBody,
      brand: brand || null,
      category: category || null,
      vertical: vertical || null,
      exclusion_flags: exclusionFlags,
      quality_signals: {
        template_polluted: Boolean(stored?.quality_signals?.template_polluted),
        synthetic_summary: Boolean(stored?.quality_signals?.synthetic_summary),
        extractor_description_present: Boolean(stored?.quality_signals?.extractor_description_present),
      },
    };
  }
  return buildExternalSeedRecallDoc({ row, seedData, snapshot });
}

const EXTERNAL_SEED_RECALL_SQL_FIELDS = Object.freeze({
  retrievalTitle: "lower(coalesce(seed_data->'derived'->'recall'->>'retrieval_title', ''))",
  retrievalSummary: "lower(coalesce(seed_data->'derived'->'recall'->>'retrieval_summary', ''))",
  retrievalBody: "lower(coalesce(seed_data->'derived'->'recall'->>'retrieval_body', ''))",
  brand: "lower(coalesce(seed_data->'derived'->'recall'->>'brand', seed_data->>'brand', seed_data->'snapshot'->>'brand', ''))",
  category:
    "lower(coalesce(seed_data->'derived'->'recall'->>'category', seed_data->>'category', seed_data->'product'->>'category', seed_data->'snapshot'->>'category', seed_data->>'product_type', seed_data->'product'->>'product_type', seed_data->'snapshot'->>'product_type', ''))",
  vertical: "lower(coalesce(seed_data->'derived'->'recall'->>'vertical', ''))",
  ingredientTokens: "lower(coalesce(seed_data#>>'{derived,recall,ingredient_tokens}', ''))",
  aliasTokens: "lower(coalesce(seed_data#>>'{derived,recall,alias_tokens}', ''))",
});

function buildExternalSeedRecallLikePredicate(bind, { includeLegacyFallback = false } = {}) {
  return `(
    lower(coalesce(title, '')) LIKE ANY(${bind}::text[])
    OR lower(coalesce(domain, '')) LIKE ANY(${bind}::text[])
    OR lower(coalesce(canonical_url, '')) LIKE ANY(${bind}::text[])
    OR lower(coalesce(destination_url, '')) LIKE ANY(${bind}::text[])
    OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalTitle} LIKE ANY(${bind}::text[])
    OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalSummary} LIKE ANY(${bind}::text[])
    OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalBody} LIKE ANY(${bind}::text[])
    OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.brand} LIKE ANY(${bind}::text[])
    OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.category} LIKE ANY(${bind}::text[])
    OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.ingredientTokens} LIKE ANY(${bind}::text[])
    OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.aliasTokens} LIKE ANY(${bind}::text[])
    ${includeLegacyFallback ? `OR lower(coalesce(seed_data::text, '')) LIKE ANY(${bind}::text[])` : ''}
  )`;
}

function classifyExternalSeedRecallMatchSource(row, patterns = []) {
  const tokens = (Array.isArray(patterns) ? patterns : [])
    .map((pattern) => String(pattern || '').replace(/^%+|%+$/g, '').trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) return 'unknown';

  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const recall = resolveExternalSeedRecallDoc({ row, seedData, snapshot });
  const checks = [
    ['exact_title', [row?.title, snapshot?.title]],
    ['title_url', [row?.canonical_url, row?.destination_url, snapshot?.canonical_url, snapshot?.destination_url, row?.domain]],
    ['brand_category', [recall.brand, recall.category]],
    ['recall_title', [recall.retrieval_title]],
    ['recall_summary', [recall.retrieval_summary, recall.retrieval_body]],
    ['token', [recall.ingredient_tokens, recall.alias_tokens]],
    ['raw_seed_fallback', [JSON.stringify(seedData)]],
  ];

  for (const [label, values] of checks) {
    const haystack = normalizeToken(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .filter(Boolean)
        .join(' '),
    );
    if (tokens.some((token) => haystack.includes(normalizeToken(token)))) {
      return label;
    }
  }
  return 'unknown';
}

module.exports = {
  SYNTHETIC_SUMMARY_RE,
  RECALL_NOISE_RE,
  GIFT_CARD_RE,
  DONATION_RE,
  NON_MERCH_PAGE_RE,
  ensureJsonObject,
  normalizeNonEmptyString,
  normalizeUrlLike,
  buildExternalSeedRecallDoc,
  resolveExternalSeedRecallDoc,
  readStoredRecallDoc,
  cleanRecallTitle,
  cleanRecallSummary,
  cleanRecallBody,
  detectExclusionFlags,
  inferVertical,
  buildExternalSeedRecallLikePredicate,
  classifyExternalSeedRecallMatchSource,
  EXTERNAL_SEED_RECALL_SQL_FIELDS,
};
