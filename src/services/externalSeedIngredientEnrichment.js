const { query } = require('../db');
const { kbQuery } = require('./pciKbClient');
const { ensureJsonObject } = require('./externalSeedProducts');
const {
  buildAuthoritativeIngredientView,
  mergeIngredientIntelWithAuthority,
} = require('./pdpIngredientAuthority');
const {
  buildExternalSeedHarvesterCandidates,
  extractRawIngredientText,
} = require('./externalSeedHarvesterBridge');
const {
  LOCAL_INGREDIENT_RECALL_REGISTRY,
  resolveIngredientRecallProfile,
  normalizeIngredientRecallText,
} = require('./ingredientRecallRegistry');

const SEED_INGREDIENT_WRITEBACK_VERSION = 'external_seed_ingredient_writeback_v1';
const ENRICHMENT_SOURCE = Object.freeze({
  kbReviewed: 'kb_reviewed',
  pdpIngredientFields: 'pdp_ingredient_fields',
  descriptionParse: 'description_parse',
  titleUrlAnchor: 'title_url_anchor',
  none: 'none',
});
const ENRICHMENT_SOURCE_PRIORITY = Object.freeze({
  [ENRICHMENT_SOURCE.none]: 0,
  [ENRICHMENT_SOURCE.titleUrlAnchor]: 1,
  [ENRICHMENT_SOURCE.descriptionParse]: 2,
  [ENRICHMENT_SOURCE.pdpIngredientFields]: 3,
  [ENRICHMENT_SOURCE.kbReviewed]: 4,
});
const SEED_ANCHOR_SOURCE_KIND = Object.freeze({
  kbReviewed: 'kb_reviewed',
  descriptionParse: 'description_parse',
  explicitTitleAnchor: 'explicit_title_anchor',
  explicitTitleUrlAnchor: 'explicit_title_url_anchor',
  explicitUrlAssistedAnchor: 'explicit_url_assisted_anchor',
  none: 'none',
});
const SEED_ANCHOR_CONFLICT_STATUS = Object.freeze({
  none: 'none',
  urlAnchorConflict: 'url_anchor_conflict',
});
const SEED_STRUCTURED_STATUS = Object.freeze({
  present: 'present',
  partial: 'partial',
  missing: 'missing',
});
const SEED_KB_SYNC_STATUS = Object.freeze({
  synced: 'synced',
  kbOnlyUnsynced: 'kb_only_unsynced',
  seedOnly: 'seed_only',
  missingBoth: 'missing_both',
});
const SEED_QUARANTINE_BUCKET = Object.freeze({
  attachedContamination: 'attached_contamination',
  urlAnchorConflict: 'url_anchor_conflict',
  rowIngredientNameOnly: 'row_ingredient_name_only',
  nonBeautyDomain: 'non_beauty_domain',
  manualUpstreamRequired: 'manual_upstream_required',
});
const PDP_FIELD_STATUS = Object.freeze({
  present: 'present',
  partial: 'partial',
  missing: 'missing',
});
const SEED_DESCRIPTION_ORIGIN = Object.freeze({
  pdpProductDescription: 'pdp_product_description',
  pdpVariantDescription: 'pdp_variant_description',
  syntheticSummary: 'synthetic_summary',
  legacyUnknown: 'legacy_unknown',
});
const REVIEW_STATUS_BLOCKLIST = new Set(['blocked', 'rejected', 'fail', 'failed']);
const ATTACHED_CONTAMINATION_DOMAIN_BLOCKLIST = new Set([
  'jwx893-fz.myshopify.com',
]);
const NON_BEAUTY_TITLE_PATTERNS = [
  /\beyeshadow\s+brush\b/i,
  /\bmakeup\s+brush\b/i,
  /\bbrush\b/i,
  /\blingerie\b/i,
  /\bbralette\b/i,
  /\bunderwear\b/i,
  /\bbra\b/i,
  /\bpant(?:y|ies)\b/i,
  /\bsleepwear\b/i,
  /\bpajama\b/i,
  /\bgift\s*card\b/i,
  /\bcarte\s+cadeau\b/i,
  /\bpet\b/i,
  /\bdog\b/i,
  /\bcat\b/i,
  /\bharness\b/i,
  /\btoy\b/i,
];
const WAVE1_OFF_SURFACE_PATTERNS = [
  /\beye\b/i,
  /\blip\b/i,
  /\bpout\b/i,
  /\bhand\b/i,
  /\bfoot\b/i,
  /\bhair\b/i,
  /\bscalp\b/i,
  /\bbody\b/i,
  /\bbase\b/i,
  /\bprimer\b/i,
];
const WAVE1_BUNDLE_PATTERNS = [
  /\bkit\b/i,
  /\bset\b/i,
  /\bduo\b/i,
  /\btrio\b/i,
  /\bcollection\b/i,
  /\bbundle\b/i,
  /\bcollector'?s?\s+case\b/i,
];
const WAVE1_SAFE_FACE_SKINCARE_PATTERNS = [
  /\bserum\b/i,
  /\bcream\b/i,
  /\btonic\b/i,
  /\btoner\b/i,
  /\bpeel\b/i,
  /\bmist\b/i,
  /\bmask\b/i,
  /\bcleanser\b/i,
  /\bface\s+wash\b/i,
  /\bwash\b/i,
  /\bmoisturi[sz]er\b/i,
  /\blotion\b/i,
  /\bessence\b/i,
  /\bampoule\b/i,
  /\boil\b/i,
  /\bgel\b/i,
  /\btreatment\b/i,
  /\bsolution\b/i,
  /\bsuspension\b/i,
  /\bsunscreen\b/i,
  /\bspf\b/i,
];
const HARD_WRITEBACK_QUARANTINE_BUCKETS = new Set([
  SEED_QUARANTINE_BUCKET.attachedContamination,
  SEED_QUARANTINE_BUCKET.urlAnchorConflict,
  SEED_QUARANTINE_BUCKET.rowIngredientNameOnly,
  SEED_QUARANTINE_BUCKET.nonBeautyDomain,
]);
const INGREDIENT_SECTION_HEADING_PATTERNS = [/\b(ingredients?|inci)\b/i];
const ACTIVE_INGREDIENT_SECTION_HEADING_PATTERNS = [/\bactive ingredients?\b/i];
const HOW_TO_USE_SECTION_HEADING_PATTERNS = [/\bhow to use\b/i];
const SYNTHETIC_SUMMARY_RE = /\bOFFICIAL:\b[\s\S]*\/\/\/\s*SOCIAL HIGHLIGHTS:/i;

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function uniqStrings(values, maxItems = 32) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeNonEmptyString(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= Math.max(1, Number(maxItems) || 32)) break;
  }
  return out;
}

function uniqNormalizedStrings(values, maxItems = 32) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeIngredientRecallText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= Math.max(1, Number(maxItems) || 32)) break;
  }
  return out;
}

function asStringArray(value) {
  if (Array.isArray(value)) return uniqStrings(value, 64);
  if (typeof value === 'string') {
    return uniqStrings(value.split(/[,\n;|/]+/), 64);
  }
  return [];
}

function normalizeDetailsSections(value, maxItems = 24) {
  const items = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const heading = normalizeNonEmptyString(item?.heading);
    const body = normalizeNonEmptyString(item?.body);
    const sourceKind = normalizeNonEmptyString(item?.source_kind || item?.sourceKind) || 'unknown';
    if (!heading || !body) continue;
    const key = `${heading.toLowerCase()}|${body.toLowerCase()}|${sourceKind.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      heading,
      body,
      source_kind: sourceKind,
    });
    if (out.length >= Math.max(1, Number(maxItems) || 24)) break;
  }
  return out;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function countPhraseMatches(text, phrases) {
  const haystack = ` ${normalizeIngredientRecallText(text)} `;
  if (!haystack.trim()) return 0;
  let hits = 0;
  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    const normalized = normalizeIngredientRecallText(phrase);
    if (!normalized) continue;
    if (haystack.includes(` ${normalized} `)) hits += 1;
  }
  return hits;
}

function readSeedPdpContentView(seedDataValue) {
  const seedData = ensureJsonObject(seedDataValue);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return {
    pdp_description_raw:
      normalizeNonEmptyString(seedData.pdp_description_raw) ||
      normalizeNonEmptyString(snapshot.pdp_description_raw),
    pdp_details_sections: normalizeDetailsSections(
      Array.isArray(seedData.pdp_details_sections) && seedData.pdp_details_sections.length > 0
        ? seedData.pdp_details_sections
        : snapshot.pdp_details_sections,
    ),
    pdp_ingredients_raw:
      normalizeNonEmptyString(seedData.pdp_ingredients_raw) ||
      normalizeNonEmptyString(snapshot.pdp_ingredients_raw),
    pdp_active_ingredients_raw:
      normalizeNonEmptyString(seedData.pdp_active_ingredients_raw) ||
      normalizeNonEmptyString(snapshot.pdp_active_ingredients_raw),
    pdp_how_to_use_raw:
      normalizeNonEmptyString(seedData.pdp_how_to_use_raw) ||
      normalizeNonEmptyString(snapshot.pdp_how_to_use_raw),
    seed_description_origin:
      normalizeNonEmptyString(seedData.seed_description_origin) ||
      normalizeNonEmptyString(snapshot.seed_description_origin),
    pdp_field_capture_status: isPlainObject(seedData.pdp_field_capture_status)
      ? seedData.pdp_field_capture_status
      : isPlainObject(snapshot.pdp_field_capture_status)
        ? snapshot.pdp_field_capture_status
        : {},
  };
}

function findSectionBodiesByHeading(sections, patterns) {
  return normalizeDetailsSections(sections)
    .filter((section) => patterns.some((pattern) => pattern.test(section.heading)))
    .map((section) => normalizeNonEmptyString(section.body))
    .filter(Boolean);
}

function allowDescriptionIngredientFallback(seedDataValue) {
  const pdpView = readSeedPdpContentView(seedDataValue);
  const origin = normalizeNonEmptyString(pdpView.seed_description_origin);
  return (
    origin === SEED_DESCRIPTION_ORIGIN.pdpProductDescription ||
    origin === SEED_DESCRIPTION_ORIGIN.pdpVariantDescription
  );
}

function classifySeedPdpFieldCoverageStatus(seedDataValue) {
  const pdpView = readSeedPdpContentView(seedDataValue);
  const hasDescription = Boolean(pdpView.pdp_description_raw);
  const hasSections = Array.isArray(pdpView.pdp_details_sections) && pdpView.pdp_details_sections.length > 0;
  const hasIngredientFields = Boolean(
    pdpView.pdp_ingredients_raw ||
      pdpView.pdp_active_ingredients_raw ||
      findSectionBodiesByHeading(
        pdpView.pdp_details_sections,
        [...INGREDIENT_SECTION_HEADING_PATTERNS, ...ACTIVE_INGREDIENT_SECTION_HEADING_PATTERNS],
      ).length > 0,
  );
  const hasHowToUse = Boolean(
    pdpView.pdp_how_to_use_raw ||
      findSectionBodiesByHeading(pdpView.pdp_details_sections, HOW_TO_USE_SECTION_HEADING_PATTERNS).length > 0,
  );
  const categories = [hasDescription, hasSections, hasIngredientFields, hasHowToUse].filter(Boolean).length;
  if (categories >= 2) return PDP_FIELD_STATUS.present;
  if (categories === 1) return PDP_FIELD_STATUS.partial;
  return PDP_FIELD_STATUS.missing;
}

function buildIngredientSourceQualityStatus({ seedDataValue, reviewedKbRows = [] } = {}) {
  if (Array.isArray(reviewedKbRows) && reviewedKbRows.length > 0) return 'kb_reviewed';
  const pdpView = readSeedPdpContentView(seedDataValue);
  if (
    pdpView.pdp_ingredients_raw ||
    pdpView.pdp_active_ingredients_raw ||
    findSectionBodiesByHeading(
      pdpView.pdp_details_sections,
      [...INGREDIENT_SECTION_HEADING_PATTERNS, ...ACTIVE_INGREDIENT_SECTION_HEADING_PATTERNS],
    ).length > 0
  ) {
    return 'pdp_ingredient_fields';
  }
  if (allowDescriptionIngredientFallback(seedDataValue) && extractRawIngredientText(pdpView.pdp_description_raw)) {
    return 'pdp_labeled_description_only';
  }
  if (
    normalizeNonEmptyString(pdpView.seed_description_origin) === SEED_DESCRIPTION_ORIGIN.syntheticSummary ||
    SYNTHETIC_SUMMARY_RE.test(pdpView.pdp_description_raw)
  ) {
    return 'synthetic_summary_blocked';
  }
  if (normalizeNonEmptyString(pdpView.seed_description_origin) === SEED_DESCRIPTION_ORIGIN.legacyUnknown) {
    return 'legacy_description_only';
  }
  return 'none';
}

function candidatePdpIngredientTexts(row = {}) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const variants = Array.isArray(snapshot.variants)
    ? snapshot.variants
    : Array.isArray(seedData.variants)
      ? seedData.variants
      : [];
  const pdpView = readSeedPdpContentView(seedData);
  const labeledDescriptionText = allowDescriptionIngredientFallback(seedData)
    ? extractRawIngredientText(pdpView.pdp_description_raw)
    : '';
  const labeledVariantTexts = allowDescriptionIngredientFallback(seedData)
    ? variants.map((variant) => extractRawIngredientText(variant?.description)).filter(Boolean)
    : [];
  return uniqStrings([
    pdpView.pdp_ingredients_raw,
    pdpView.pdp_active_ingredients_raw,
    ...findSectionBodiesByHeading(pdpView.pdp_details_sections, INGREDIENT_SECTION_HEADING_PATTERNS),
    ...findSectionBodiesByHeading(pdpView.pdp_details_sections, ACTIVE_INGREDIENT_SECTION_HEADING_PATTERNS),
    labeledDescriptionText,
    ...labeledVariantTexts,
  ], 16);
}

function candidateIngredientTexts(row = {}) {
  const seedData = ensureJsonObject(row.seed_data);
  const pdpView = readSeedPdpContentView(seedData);
  if (allowDescriptionIngredientFallback(seedData)) {
    return uniqStrings([extractRawIngredientText(pdpView.pdp_description_raw)], 8);
  }
  return [];
}

function readStructuredIngredientView(seedDataValue) {
  const seedData = ensureJsonObject(seedDataValue);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const ingredientIntel = ensureJsonObject(seedData.ingredient_intel);
  const snapshotIngredientIntel = ensureJsonObject(snapshot.ingredient_intel);

  return {
    raw_ingredient_text_clean:
      normalizeNonEmptyString(seedData.raw_ingredient_text_clean) ||
      normalizeNonEmptyString(snapshot.raw_ingredient_text_clean) ||
      normalizeNonEmptyString(ingredientIntel.raw_ingredient_text_clean) ||
      normalizeNonEmptyString(snapshotIngredientIntel.raw_ingredient_text_clean),
    inci_list:
      normalizeNonEmptyString(seedData.inci_list) ||
      normalizeNonEmptyString(snapshot.inci_list) ||
      normalizeNonEmptyString(ingredientIntel.inci_list) ||
      normalizeNonEmptyString(snapshotIngredientIntel.inci_list),
    ingredient_tokens: uniqStrings([
      ...asStringArray(seedData.ingredient_tokens),
      ...asStringArray(snapshot.ingredient_tokens),
      ...asStringArray(seedData.key_ingredients),
      ...asStringArray(snapshot.key_ingredients),
      ...asStringArray(seedData.keyIngredients),
      ...asStringArray(snapshot.keyIngredients),
    ], 32),
    active_ingredients: uniqStrings([
      ...asStringArray(seedData.active_ingredients),
      ...asStringArray(snapshot.active_ingredients),
      ...asStringArray(seedData.activeIngredients),
      ...asStringArray(snapshot.activeIngredients),
    ], 32),
    key_ingredients: uniqStrings([
      ...asStringArray(seedData.key_ingredients),
      ...asStringArray(snapshot.key_ingredients),
      ...asStringArray(seedData.keyIngredients),
      ...asStringArray(snapshot.keyIngredients),
    ], 32),
    ingredient_intel: isPlainObject(seedData.ingredient_intel)
      ? seedData.ingredient_intel
      : isPlainObject(snapshot.ingredient_intel)
        ? snapshot.ingredient_intel
        : {},
  };
}

function classifySeedStructuredIngredientStatus(seedDataValue) {
  const view = readStructuredIngredientView(seedDataValue);
  const hasText = Boolean(view.raw_ingredient_text_clean || view.inci_list);
  const hasArrays = Boolean(
    (Array.isArray(view.ingredient_tokens) && view.ingredient_tokens.length > 0) ||
      (Array.isArray(view.active_ingredients) && view.active_ingredients.length > 0) ||
      (Array.isArray(view.key_ingredients) && view.key_ingredients.length > 0),
  );
  const hasIntel = isPlainObject(view.ingredient_intel) && Object.keys(view.ingredient_intel).length > 0;
  const categories = [hasText, hasArrays, hasIntel].filter(Boolean).length;
  if (categories >= 2) return SEED_STRUCTURED_STATUS.present;
  if (categories === 1) return SEED_STRUCTURED_STATUS.partial;
  return SEED_STRUCTURED_STATUS.missing;
}

function hasSeedStructuredIngredientEvidence(seedDataValue) {
  return classifySeedStructuredIngredientStatus(seedDataValue) !== SEED_STRUCTURED_STATUS.missing;
}

async function runKbQuery(text, params) {
  try {
    const result = await kbQuery(text, params);
    if (result) return result;
    return await query(text, params);
  } catch (_err) {
    return null;
  }
}

function isReviewedKbIngredientRow(row) {
  const parseStatus = normalizeNonEmptyString(row?.parse_status).toUpperCase();
  const reviewStatus = normalizeNonEmptyString(row?.review_status).toLowerCase();
  const auditStatus = normalizeNonEmptyString(row?.audit_status).toLowerCase();
  const ingestAllowed = row?.ingest_allowed === true;
  if (ingestAllowed) return true;
  if (REVIEW_STATUS_BLOCKLIST.has(reviewStatus) || REVIEW_STATUS_BLOCKLIST.has(auditStatus)) return false;
  return parseStatus === 'OK';
}

async function fetchReviewedKbRowsForSeedRow(row) {
  const candidates = buildExternalSeedHarvesterCandidates(row);
  const candidateIds = uniqStrings(candidates.map((candidate) => candidate.candidate_id).filter(Boolean), 80);
  if (!candidateIds.length) return [];
  const tableCheck = await runKbQuery(`SELECT to_regclass('pci_kb.sku_ingredients') AS table_name`);
  if (!tableCheck?.rows?.[0]?.table_name) return [];
  const res = await runKbQuery(
    `
      SELECT
        sku_key,
        market,
        brand,
        product_name,
        source_ref,
        parse_status,
        review_status,
        audit_status,
        ingest_allowed,
        raw_ingredient_text_clean,
        inci_list,
        created_at
      FROM pci_kb.sku_ingredients
      WHERE sku_key = ANY($1::text[])
      ORDER BY created_at DESC NULLS LAST, sku_key ASC
    `,
    [candidateIds],
  );
  return (Array.isArray(res?.rows) ? res.rows : []).filter(isReviewedKbIngredientRow);
}

function profileAnchorTitleTexts(row = {}, ingredientName = '') {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return uniqStrings([
    ingredientName,
    row.title,
    seedData.title,
    snapshot.title,
  ], 12);
}

function profileAnchorUrlTexts(row = {}) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return uniqStrings([
    row.canonical_url,
    row.destination_url,
    seedData.canonical_url,
    seedData.destination_url,
    snapshot.canonical_url,
    snapshot.destination_url,
  ], 12);
}

function getProfileStrongAnchorScore(profile, texts) {
  const joined = uniqStrings(texts, 24).join(' ');
  if (!joined || !profile) return { exactHits: 0, aliasHits: 0 };
  return {
    exactHits: countPhraseMatches(joined, profile?.exact_phrases),
    aliasHits: countPhraseMatches(joined, profile?.alias_phrases),
  };
}

function profileHasStrongAnchor(profile, texts) {
  const score = getProfileStrongAnchorScore(profile, texts);
  return score.exactHits > 0 || score.aliasHits > 0;
}

function resolveStrongAnchorProfileFromTexts(texts, preferredProfiles = []) {
  const orderedProfiles = [
    ...preferredProfiles.filter(Boolean),
    ...Object.values(LOCAL_INGREDIENT_RECALL_REGISTRY).filter(Boolean),
  ];
  const seen = new Set();
  let bestProfile = null;
  let bestExactHits = 0;
  let bestAliasHits = 0;
  for (const profile of orderedProfiles) {
    const profileId = normalizeNonEmptyString(profile?.ingredient_id || profile?.display_name || profile?.ingredient_name)
      .toLowerCase();
    if (!profileId || seen.has(profileId)) continue;
    seen.add(profileId);
    const score = getProfileStrongAnchorScore(profile, texts);
    if (score.exactHits <= 0 && score.aliasHits <= 0) continue;
    if (
      !bestProfile ||
      score.exactHits > bestExactHits ||
      (score.exactHits === bestExactHits && score.aliasHits > bestAliasHits)
    ) {
      bestProfile = profile;
      bestExactHits = score.exactHits;
      bestAliasHits = score.aliasHits;
    }
  }
  return bestProfile;
}

function readExternalSeedEnrichmentMetadata(seedDataValue) {
  const seedData = ensureJsonObject(seedDataValue);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const rootMeta = ensureJsonObject(ensureJsonObject(seedData.ingredient_intel).external_seed_enrichment);
  const snapshotMeta = ensureJsonObject(ensureJsonObject(snapshot.ingredient_intel).external_seed_enrichment);
  const meta = Object.keys(rootMeta).length > 0 ? rootMeta : snapshotMeta;
  return {
    source: normalizeNonEmptyString(meta.source) || ENRICHMENT_SOURCE.none,
    seed_anchor_source_kind:
      normalizeNonEmptyString(meta.seed_anchor_source_kind) || SEED_ANCHOR_SOURCE_KIND.none,
    seed_anchor_conflict_status:
      normalizeNonEmptyString(meta.seed_anchor_conflict_status) || SEED_ANCHOR_CONFLICT_STATUS.none,
    url_anchor_conflict: meta.url_anchor_conflict === true,
    quarantine_reason: normalizeNonEmptyString(meta.quarantine_reason) || null,
    seed_quarantine_bucket: normalizeNonEmptyString(meta.seed_quarantine_bucket) || null,
    quarantined_from_wave1: meta.quarantined_from_wave1 === true,
    contamination_signal_source: normalizeNonEmptyString(meta.contamination_signal_source) || null,
  };
}

function hasRowIngredientNameOnlySignal(row = {}) {
  const seedData = ensureJsonObject(row.seed_data);
  return Boolean(
    normalizeNonEmptyString(row.ingredient_name) ||
      normalizeNonEmptyString(seedData.ingredient_name) ||
      normalizeNonEmptyString(seedData.snapshot?.ingredient_name),
  );
}

function resolveAnchorProfileDecision({ row, ingredientId = '', ingredientName = '' } = {}) {
  const hasExplicitIngredientAnchor =
    Boolean(normalizeNonEmptyString(ingredientId)) || Boolean(normalizeNonEmptyString(ingredientName));
  const directProfile = resolveIngredientRecallProfile({
    ingredientId,
    query: ingredientName,
    target: row?.title || '',
  });
  const preferredProfiles = directProfile ? [directProfile] : [];
  const titleProfile = resolveStrongAnchorProfileFromTexts(
    profileAnchorTitleTexts(row, ingredientName),
    preferredProfiles,
  );
  const urlProfile = resolveStrongAnchorProfileFromTexts(profileAnchorUrlTexts(row), preferredProfiles);
  const titleIngredientId = normalizeNonEmptyString(titleProfile?.ingredient_id).toLowerCase();
  const urlIngredientId = normalizeNonEmptyString(urlProfile?.ingredient_id).toLowerCase();
  const hasConflict =
    Boolean(titleIngredientId) &&
    Boolean(urlIngredientId) &&
    titleIngredientId !== urlIngredientId;
  if (hasConflict) {
    return {
      anchorProfile: null,
      titleProfile,
      urlProfile,
      hasExplicitIngredientAnchor,
      seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.none,
      seed_anchor_conflict_status: SEED_ANCHOR_CONFLICT_STATUS.urlAnchorConflict,
      url_anchor_conflict: true,
      quarantine_reason: 'url_anchor_conflict',
    };
  }
  if (titleProfile && urlProfile) {
    return {
      anchorProfile: titleProfile,
      titleProfile,
      urlProfile,
      hasExplicitIngredientAnchor,
      seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.explicitTitleUrlAnchor,
      seed_anchor_conflict_status: SEED_ANCHOR_CONFLICT_STATUS.none,
      url_anchor_conflict: false,
      quarantine_reason: null,
    };
  }
  if (titleProfile) {
    return {
      anchorProfile: titleProfile,
      titleProfile,
      urlProfile,
      hasExplicitIngredientAnchor,
      seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.explicitTitleAnchor,
      seed_anchor_conflict_status: SEED_ANCHOR_CONFLICT_STATUS.none,
      url_anchor_conflict: false,
      quarantine_reason: null,
    };
  }
  if (urlProfile && hasExplicitIngredientAnchor) {
    return {
      anchorProfile: urlProfile,
      titleProfile,
      urlProfile,
      hasExplicitIngredientAnchor,
      seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.explicitUrlAssistedAnchor,
      seed_anchor_conflict_status: SEED_ANCHOR_CONFLICT_STATUS.none,
      url_anchor_conflict: false,
      quarantine_reason: null,
    };
  }
  if (urlProfile && !hasExplicitIngredientAnchor) {
    return {
      anchorProfile: null,
      titleProfile,
      urlProfile,
      hasExplicitIngredientAnchor,
      seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.none,
      seed_anchor_conflict_status: SEED_ANCHOR_CONFLICT_STATUS.none,
      url_anchor_conflict: false,
      quarantine_reason: 'url_only_anchor',
    };
  }
  if (hasRowIngredientNameOnlySignal(row) && !hasExplicitIngredientAnchor) {
    return {
      anchorProfile: null,
      titleProfile,
      urlProfile,
      hasExplicitIngredientAnchor,
      seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.none,
      seed_anchor_conflict_status: SEED_ANCHOR_CONFLICT_STATUS.none,
      url_anchor_conflict: false,
      quarantine_reason: 'row_ingredient_name_only',
    };
  }
  return {
    anchorProfile: null,
    titleProfile,
    urlProfile,
    hasExplicitIngredientAnchor,
    seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.none,
    seed_anchor_conflict_status: SEED_ANCHOR_CONFLICT_STATUS.none,
    url_anchor_conflict: false,
    quarantine_reason: null,
  };
}

function extractRegistryTokensFromText(text, preferredProfiles = []) {
  const normalizedText = normalizeIngredientRecallText(text);
  if (!normalizedText) return [];
  const out = [];
  const seen = new Set();
  const orderedProfiles = [
    ...preferredProfiles.filter(Boolean),
    ...Object.values(LOCAL_INGREDIENT_RECALL_REGISTRY).filter(Boolean),
  ];
  for (const profile of orderedProfiles) {
    const displayName = normalizeNonEmptyString(profile?.display_name || profile?.ingredient_name);
    if (!displayName) continue;
    const key = displayName.toLowerCase();
    if (seen.has(key)) continue;
    const exactHits = countPhraseMatches(normalizedText, profile?.exact_phrases);
    const aliasHits = countPhraseMatches(normalizedText, profile?.alias_phrases);
    if (exactHits <= 0 && aliasHits <= 0) continue;
    seen.add(key);
    out.push(displayName);
    if (out.length >= 24) break;
  }
  return out;
}

function buildIngredientBlock({
  rawIngredientText = '',
  inciList = '',
  ingredientTokens = [],
  activeIngredients = [],
  keyIngredients = [],
  source = ENRICHMENT_SOURCE.none,
  metadata = {},
} = {}) {
  const rawText = normalizeNonEmptyString(rawIngredientText);
  const normalizedInciList = normalizeNonEmptyString(inciList || rawText);
  const normalizedIngredientTokens = uniqStrings(ingredientTokens, 24);
  const normalizedActiveIngredients = uniqStrings(activeIngredients, 16);
  const normalizedKeyIngredients = uniqStrings(
    keyIngredients.length ? keyIngredients : normalizedIngredientTokens,
    16,
  );
  const authoritativeIngredientView =
    source === ENRICHMENT_SOURCE.kbReviewed || source === ENRICHMENT_SOURCE.descriptionParse
      ? buildAuthoritativeIngredientView({
          raw_ingredient_text_clean: rawText,
          inci_list: normalizedInciList,
          active_ingredients: normalizedActiveIngredients,
        })
      : null;
  const intel = {
    ...(normalizedIngredientTokens.length
      ? { inci_normalized: normalizedIngredientTokens, key_ingredients: normalizedKeyIngredients }
      : {}),
    ...(normalizedActiveIngredients.length ? { active_ingredients: normalizedActiveIngredients } : {}),
    ...(rawText ? { raw_ingredient_text_clean: rawText } : {}),
    ...(normalizedInciList ? { inci_list: normalizedInciList, inci_raw: rawText || normalizedInciList } : {}),
    ...(authoritativeIngredientView &&
    ((authoritativeIngredientView.items && authoritativeIngredientView.items.length) ||
      (authoritativeIngredientView.active_items && authoritativeIngredientView.active_items.length))
      ? { authoritative: authoritativeIngredientView }
      : {}),
    external_seed_enrichment: {
      source,
      version: SEED_INGREDIENT_WRITEBACK_VERSION,
      synced_at: new Date().toISOString(),
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
    },
  };
  return {
    raw_ingredient_text_clean: rawText || undefined,
    inci_list: normalizedInciList || undefined,
    ingredient_tokens: normalizedIngredientTokens.length ? normalizedIngredientTokens : undefined,
    active_ingredients: normalizedActiveIngredients.length ? normalizedActiveIngredients : undefined,
    key_ingredients: normalizedKeyIngredients.length ? normalizedKeyIngredients : undefined,
    ingredient_intel: intel,
  };
}

function buildBlockFromKbRows(kbRows, { anchorProfile = null } = {}) {
  const rows = Array.isArray(kbRows) ? kbRows.filter(Boolean) : [];
  if (!rows.length) return null;
  const rawIngredientTexts = uniqStrings(
    rows.flatMap((row) => [
      row?.raw_ingredient_text_clean,
      row?.inci_list,
    ]),
    8,
  );
  const productTexts = uniqStrings(
    rows.flatMap((row) => [row?.product_name, row?.source_ref]),
    8,
  );
  const combinedText = uniqStrings([...rawIngredientTexts, ...productTexts], 16).join(' ');
  const ingredientTokens = extractRegistryTokensFromText(combinedText, anchorProfile ? [anchorProfile] : []);
  if (!ingredientTokens.length && !rawIngredientTexts.length && !productTexts.length) return null;
  return buildIngredientBlock({
    rawIngredientText: rawIngredientTexts[0] || '',
    inciList: rawIngredientTexts.join(', '),
    ingredientTokens:
      ingredientTokens.length || !anchorProfile?.display_name
        ? ingredientTokens
        : [anchorProfile.display_name],
    activeIngredients: ingredientTokens,
    keyIngredients: ingredientTokens,
    source: ENRICHMENT_SOURCE.kbReviewed,
    metadata: {
      kb_candidate_ids: uniqStrings(rows.map((row) => row?.sku_key), 32),
      kb_row_count: rows.length,
      seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.kbReviewed,
      seed_anchor_conflict_status: SEED_ANCHOR_CONFLICT_STATUS.none,
      url_anchor_conflict: false,
      quarantine_reason: null,
    },
  });
}

function buildBlockFromPdpIngredientFields(row, { anchorProfile = null } = {}) {
  const rawIngredientTexts = candidatePdpIngredientTexts(row);
  if (!rawIngredientTexts.length) return null;
  const combined = rawIngredientTexts.join(', ');
  const ingredientTokens = extractRegistryTokensFromText(combined, anchorProfile ? [anchorProfile] : []);
  return buildIngredientBlock({
    rawIngredientText: rawIngredientTexts[0],
    inciList: combined,
    ingredientTokens,
    activeIngredients: ingredientTokens,
    keyIngredients: ingredientTokens,
    source: ENRICHMENT_SOURCE.pdpIngredientFields,
    metadata: {
      parsed_from_pdp_fields: true,
      seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.descriptionParse,
      seed_anchor_conflict_status: SEED_ANCHOR_CONFLICT_STATUS.none,
      url_anchor_conflict: false,
      quarantine_reason: null,
    },
  });
}

function buildBlockFromDescriptionParse(row, { anchorProfile = null } = {}) {
  const rawIngredientTexts = candidateIngredientTexts(row);
  if (!rawIngredientTexts.length) return null;
  const combined = rawIngredientTexts.join(', ');
  const ingredientTokens = extractRegistryTokensFromText(combined, anchorProfile ? [anchorProfile] : []);
  return buildIngredientBlock({
    rawIngredientText: rawIngredientTexts[0],
    inciList: combined,
    ingredientTokens,
    activeIngredients: ingredientTokens,
    keyIngredients: ingredientTokens,
    source: ENRICHMENT_SOURCE.descriptionParse,
    metadata: {
      parsed_from_description: true,
      seed_anchor_source_kind: SEED_ANCHOR_SOURCE_KIND.descriptionParse,
      seed_anchor_conflict_status: SEED_ANCHOR_CONFLICT_STATUS.none,
      url_anchor_conflict: false,
      quarantine_reason: null,
    },
  });
}

function buildBlockFromAnchor(anchorDecision = {}) {
  const anchorProfile = anchorDecision?.anchorProfile || null;
  if (!anchorProfile) return null;
  const displayName = normalizeNonEmptyString(anchorProfile.display_name || anchorProfile.ingredient_name);
  if (!displayName) return null;
  return buildIngredientBlock({
    ingredientTokens: [displayName],
    keyIngredients: [displayName],
    source: ENRICHMENT_SOURCE.titleUrlAnchor,
    metadata: {
      anchored_ingredient_id: normalizeNonEmptyString(anchorProfile.ingredient_id) || null,
      seed_anchor_source_kind:
        normalizeNonEmptyString(anchorDecision?.seed_anchor_source_kind) || SEED_ANCHOR_SOURCE_KIND.none,
      seed_anchor_conflict_status:
        normalizeNonEmptyString(anchorDecision?.seed_anchor_conflict_status) || SEED_ANCHOR_CONFLICT_STATUS.none,
      url_anchor_conflict: anchorDecision?.url_anchor_conflict === true,
      quarantine_reason: normalizeNonEmptyString(anchorDecision?.quarantine_reason) || null,
    },
  });
}

function mergeIngredientIntel(existingValue, nextValue) {
  const existing = ensureJsonObject(existingValue);
  const next = ensureJsonObject(nextValue);
  const merged = {
    ...existing,
    ...next,
    external_seed_enrichment: {
      ...ensureJsonObject(existing.external_seed_enrichment),
      ...ensureJsonObject(next.external_seed_enrichment),
    },
  };
  if (next.authoritative || existing.authoritative) {
    return mergeIngredientIntelWithAuthority(merged, next.authoritative || existing.authoritative);
  }
  return merged;
}

function mergeStructuredBlockIntoSeedData(seedDataValue, block) {
  const seedData = ensureJsonObject(seedDataValue);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const nextSeedData = {
    ...seedData,
    snapshot: {
      ...snapshot,
    },
  };
  const fields = ['raw_ingredient_text_clean', 'inci_list', 'ingredient_tokens', 'active_ingredients', 'key_ingredients'];
  for (const field of fields) {
    const nextValue = block[field];
    if (typeof nextValue === 'undefined') continue;
    if (typeof nextValue === 'string' && !normalizeNonEmptyString(nextValue)) continue;
    if (Array.isArray(nextValue) && nextValue.length === 0) continue;
    nextSeedData[field] = nextValue;
    nextSeedData.snapshot[field] = nextValue;
  }
  if (block.ingredient_intel) {
    nextSeedData.ingredient_intel = mergeIngredientIntel(nextSeedData.ingredient_intel, block.ingredient_intel);
    nextSeedData.snapshot.ingredient_intel = mergeIngredientIntel(
      nextSeedData.snapshot.ingredient_intel,
      block.ingredient_intel,
    );
  }
  return nextSeedData;
}

function buildSeedKbSyncStatus({ seedStatus, reviewedKbRows }) {
  const normalizedSeedStatus =
    seedStatus === SEED_STRUCTURED_STATUS.present || seedStatus === SEED_STRUCTURED_STATUS.partial
      ? seedStatus
      : SEED_STRUCTURED_STATUS.missing;
  const hasKbCoverage = Array.isArray(reviewedKbRows) && reviewedKbRows.length > 0;
  if (hasKbCoverage && normalizedSeedStatus === SEED_STRUCTURED_STATUS.present) {
    return SEED_KB_SYNC_STATUS.synced;
  }
  if (hasKbCoverage && normalizedSeedStatus !== SEED_STRUCTURED_STATUS.present) {
    return SEED_KB_SYNC_STATUS.kbOnlyUnsynced;
  }
  if (!hasKbCoverage && normalizedSeedStatus !== SEED_STRUCTURED_STATUS.missing) {
    return SEED_KB_SYNC_STATUS.seedOnly;
  }
  return SEED_KB_SYNC_STATUS.missingBoth;
}

function buildRuntimeIngredientEvidenceSource({ seedStatus, reviewedKbRows }) {
  if (seedStatus === SEED_STRUCTURED_STATUS.present || seedStatus === SEED_STRUCTURED_STATUS.partial) {
    return 'seed_structured_fields';
  }
  if (Array.isArray(reviewedKbRows) && reviewedKbRows.length > 0) return 'kb_reviewed_read_through';
  return 'none';
}

function getEnrichmentSourcePriority(source) {
  const normalized = normalizeNonEmptyString(source) || ENRICHMENT_SOURCE.none;
  return ENRICHMENT_SOURCE_PRIORITY[normalized] || 0;
}

function resolveStrongestStructuredUpgradeSource({ row, reviewedKbRows = [] } = {}) {
  if (Array.isArray(reviewedKbRows) && reviewedKbRows.length > 0) return ENRICHMENT_SOURCE.kbReviewed;
  if (candidatePdpIngredientTexts(row).length > 0) return ENRICHMENT_SOURCE.pdpIngredientFields;
  if (candidateIngredientTexts(row).length > 0) return ENRICHMENT_SOURCE.descriptionParse;
  return ENRICHMENT_SOURCE.none;
}

function shouldUpgradePresentStructuredSeed({
  row,
  reviewedKbRows = [],
  existingEnrichmentMetadata = {},
  structuredView = null,
} = {}) {
  const existingSource = normalizeNonEmptyString(existingEnrichmentMetadata?.source) || ENRICHMENT_SOURCE.none;
  const strongestSource = resolveStrongestStructuredUpgradeSource({ row, reviewedKbRows });
  if (getEnrichmentSourcePriority(strongestSource) <= getEnrichmentSourcePriority(existingSource)) {
    return false;
  }

  if (existingSource === ENRICHMENT_SOURCE.titleUrlAnchor) return true;

  const hasRawStructuredText = Boolean(
    normalizeNonEmptyString(structuredView?.raw_ingredient_text_clean) ||
      normalizeNonEmptyString(structuredView?.inci_list),
  );
  if (!hasRawStructuredText) {
    return (
      existingSource === ENRICHMENT_SOURCE.none ||
      existingSource === ENRICHMENT_SOURCE.descriptionParse
    );
  }
  return false;
}

function externalSeedScopeText(row = {}) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return [
    row?.title,
    row?.canonical_url,
    row?.destination_url,
    row?.domain,
    seedData?.title,
    seedData?.canonical_url,
    seedData?.destination_url,
    snapshot?.title,
    snapshot?.canonical_url,
    snapshot?.destination_url,
    seedData?.product_type,
    snapshot?.product_type,
    seedData?.category,
    snapshot?.category,
    ...(Array.isArray(seedData?.categories) ? seedData.categories : []),
    ...(Array.isArray(snapshot?.categories) ? snapshot.categories : []),
  ]
    .map((value) => normalizeNonEmptyString(value))
    .filter(Boolean)
    .join(' ');
}

function reviewedKbScopeText(reviewedKbRows = []) {
  return (Array.isArray(reviewedKbRows) ? reviewedKbRows : [])
    .flatMap((row) => [
      row?.product_name,
      row?.source_ref,
      row?.brand,
      row?.category,
    ])
    .map((value) => normalizeNonEmptyString(value))
    .filter(Boolean)
    .join(' ');
}

function wave1ScopeText(row = {}, reviewedKbRows = []) {
  return [externalSeedScopeText(row), reviewedKbScopeText(reviewedKbRows)]
    .filter(Boolean)
    .join(' ');
}

function hasObviousNonBeautySignals(row = {}) {
  const haystack = externalSeedScopeText(row);
  if (!haystack) return false;
  return NON_BEAUTY_TITLE_PATTERNS.some((pattern) => pattern.test(haystack));
}

function classifyWave1ManualScopeSignal(row = {}, reviewedKbRows = []) {
  const haystack = wave1ScopeText(row, reviewedKbRows);
  if (!haystack) return null;
  if (WAVE1_BUNDLE_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return 'row_scope_bundle_signal';
  }
  if (WAVE1_OFF_SURFACE_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return 'row_scope_off_surface_signal';
  }
  return null;
}

function hasWave1SafeFaceSkincareSignal(row = {}, reviewedKbRows = []) {
  const haystack = wave1ScopeText(row, reviewedKbRows);
  if (!haystack) return false;
  return WAVE1_SAFE_FACE_SKINCARE_PATTERNS.some((pattern) => pattern.test(haystack));
}

function classifyExternalSeedQuarantine({
  row,
  reviewedKbRows = [],
  seedStatus = SEED_STRUCTURED_STATUS.missing,
  seedKbSyncStatus = SEED_KB_SYNC_STATUS.missingBoth,
  enrichmentSource = ENRICHMENT_SOURCE.none,
  seedEnrichmentMetadata = null,
  includeManualUpstreamRequired = true,
} = {}) {
  const meta = seedEnrichmentMetadata && typeof seedEnrichmentMetadata === 'object'
    ? seedEnrichmentMetadata
    : readExternalSeedEnrichmentMetadata(row?.seed_data);
  const attached = Boolean(normalizeNonEmptyString(row?.attached_product_key));
  const domain = normalizeNonEmptyString(row?.domain).toLowerCase();
  const quarantineReason = normalizeNonEmptyString(meta.quarantine_reason);
  const hasReviewedKbRows = Array.isArray(reviewedKbRows) && reviewedKbRows.length > 0;

  if (attached && ATTACHED_CONTAMINATION_DOMAIN_BLOCKLIST.has(domain)) {
    return {
      seed_quarantine_bucket: SEED_QUARANTINE_BUCKET.attachedContamination,
      quarantined_from_wave1: true,
      contamination_signal_source: 'attached_domain_blocklist',
    };
  }
  if (hasObviousNonBeautySignals(row)) {
    return {
      seed_quarantine_bucket: SEED_QUARANTINE_BUCKET.nonBeautyDomain,
      quarantined_from_wave1: true,
      contamination_signal_source: 'row_scope_non_beauty_signal',
    };
  }
  const manualScopeSignal = classifyWave1ManualScopeSignal(row, reviewedKbRows);
  if (manualScopeSignal) {
    return {
      seed_quarantine_bucket: SEED_QUARANTINE_BUCKET.manualUpstreamRequired,
      quarantined_from_wave1: true,
      contamination_signal_source: manualScopeSignal,
    };
  }
  if (hasReviewedKbRows && !hasWave1SafeFaceSkincareSignal(row, reviewedKbRows)) {
    return {
      seed_quarantine_bucket: SEED_QUARANTINE_BUCKET.manualUpstreamRequired,
      quarantined_from_wave1: true,
      contamination_signal_source: 'row_scope_missing_safe_skincare_signal',
    };
  }
  if (
    quarantineReason === 'url_anchor_conflict' ||
    meta.url_anchor_conflict === true ||
    meta.seed_anchor_conflict_status === SEED_ANCHOR_CONFLICT_STATUS.urlAnchorConflict
  ) {
    return {
      seed_quarantine_bucket: SEED_QUARANTINE_BUCKET.urlAnchorConflict,
      quarantined_from_wave1: true,
      contamination_signal_source: 'anchor_conflict',
    };
  }
  if (quarantineReason === 'row_ingredient_name_only') {
    return {
      seed_quarantine_bucket: SEED_QUARANTINE_BUCKET.rowIngredientNameOnly,
      quarantined_from_wave1: true,
      contamination_signal_source: 'row_ingredient_name_only',
    };
  }
  if (
    includeManualUpstreamRequired &&
    enrichmentSource === ENRICHMENT_SOURCE.none &&
    seedStatus !== SEED_STRUCTURED_STATUS.present &&
    !hasReviewedKbRows &&
    (seedKbSyncStatus === SEED_KB_SYNC_STATUS.missingBoth ||
      seedKbSyncStatus === SEED_KB_SYNC_STATUS.seedOnly ||
      quarantineReason === 'url_only_anchor')
  ) {
    return {
      seed_quarantine_bucket: SEED_QUARANTINE_BUCKET.manualUpstreamRequired,
      quarantined_from_wave1: true,
      contamination_signal_source:
        quarantineReason === 'url_only_anchor' ? 'url_only_anchor' : 'missing_reviewed_kb_source',
    };
  }
  return {
    seed_quarantine_bucket: null,
    quarantined_from_wave1: false,
    contamination_signal_source: null,
  };
}

function applyExternalSeedEnrichmentMetadata(seedDataValue, metadata = {}) {
  const seedData = ensureJsonObject(seedDataValue);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const rootIntel = ensureJsonObject(seedData.ingredient_intel);
  const snapshotIntel = ensureJsonObject(snapshot.ingredient_intel);
  const rootMeta = ensureJsonObject(rootIntel.external_seed_enrichment);
  const nextMeta = {
    ...rootMeta,
    ...metadata,
  };
  return {
    ...seedData,
    ingredient_intel: {
      ...rootIntel,
      external_seed_enrichment: nextMeta,
    },
    snapshot: {
      ...snapshot,
      ingredient_intel: {
        ...snapshotIntel,
        external_seed_enrichment: nextMeta,
      },
    },
  };
}

async function enrichExternalSeedRowIngredients({
  row,
  ingredientId = '',
  ingredientName = '',
  kbRows = null,
} = {}) {
  if (!row || typeof row !== 'object') {
    return {
      changed: false,
      row,
      enrichment_source: ENRICHMENT_SOURCE.none,
      seed_structured_ingredient_status_before: SEED_STRUCTURED_STATUS.missing,
      seed_structured_ingredient_status_after: SEED_STRUCTURED_STATUS.missing,
      seed_kb_sync_status: SEED_KB_SYNC_STATUS.missingBoth,
      runtime_ingredient_evidence_source: 'none',
      reviewed_kb_rows: [],
      seed_quarantine_bucket: null,
      quarantined_from_wave1: false,
      contamination_signal_source: null,
    };
  }

  const reviewedKbRows = Array.isArray(kbRows) ? kbRows.filter(isReviewedKbIngredientRow) : await fetchReviewedKbRowsForSeedRow(row);
  const seedData = ensureJsonObject(row.seed_data);
  const beforeStatus = classifySeedStructuredIngredientStatus(seedData);
  const beforeStructuredView = readStructuredIngredientView(seedData);
  const existingEnrichmentMetadata = readExternalSeedEnrichmentMetadata(seedData);
  const beforeSeedKbSyncStatus = buildSeedKbSyncStatus({ seedStatus: beforeStatus, reviewedKbRows });
  const hasExplicitIngredientAnchor =
    normalizeNonEmptyString(ingredientId) || normalizeNonEmptyString(ingredientName);
  const shouldAttemptStructuredUpgrade =
    beforeStatus === SEED_STRUCTURED_STATUS.present &&
    !hasExplicitIngredientAnchor &&
    shouldUpgradePresentStructuredSeed({
      row,
      reviewedKbRows,
      existingEnrichmentMetadata,
      structuredView: beforeStructuredView,
    });
  if (
    beforeStatus === SEED_STRUCTURED_STATUS.present &&
    reviewedKbRows.length === 0 &&
    !hasExplicitIngredientAnchor &&
    !shouldAttemptStructuredUpgrade
  ) {
    const quarantine = classifyExternalSeedQuarantine({
      row,
      reviewedKbRows,
      seedStatus: beforeStatus,
      seedKbSyncStatus: beforeSeedKbSyncStatus,
      enrichmentSource: ENRICHMENT_SOURCE.none,
      seedEnrichmentMetadata: existingEnrichmentMetadata,
    });
    return {
      changed: false,
      row,
      enrichment_source: ENRICHMENT_SOURCE.none,
      seed_structured_ingredient_status_before: beforeStatus,
      seed_structured_ingredient_status_after: beforeStatus,
      seed_kb_sync_status: beforeSeedKbSyncStatus,
      runtime_ingredient_evidence_source: buildRuntimeIngredientEvidenceSource({
        seedStatus: beforeStatus,
        reviewedKbRows,
      }),
      reviewed_kb_rows: reviewedKbRows,
      seed_anchor_source_kind: existingEnrichmentMetadata.seed_anchor_source_kind,
      seed_anchor_conflict_status: existingEnrichmentMetadata.seed_anchor_conflict_status,
      url_anchor_conflict: existingEnrichmentMetadata.url_anchor_conflict,
      quarantine_reason: existingEnrichmentMetadata.quarantine_reason,
      seed_quarantine_bucket: quarantine.seed_quarantine_bucket,
      quarantined_from_wave1: quarantine.quarantined_from_wave1,
      contamination_signal_source: quarantine.contamination_signal_source,
    };
  }
  const anchorDecision = resolveAnchorProfileDecision({ row, ingredientId, ingredientName });
  const anchorProfile = anchorDecision.anchorProfile;
  const enrichmentBlock =
    buildBlockFromKbRows(reviewedKbRows, { anchorProfile }) ||
    buildBlockFromPdpIngredientFields(row, { anchorProfile }) ||
    buildBlockFromDescriptionParse(row, { anchorProfile }) ||
    buildBlockFromAnchor(anchorDecision);
  const tentativeEnrichmentSource =
    normalizeNonEmptyString(enrichmentBlock?.ingredient_intel?.external_seed_enrichment?.source) || ENRICHMENT_SOURCE.none;
  const noBlockQuarantine = classifyExternalSeedQuarantine({
    row,
    reviewedKbRows,
    seedStatus: beforeStatus,
    seedKbSyncStatus: beforeSeedKbSyncStatus,
    enrichmentSource: tentativeEnrichmentSource,
    seedEnrichmentMetadata: {
      ...existingEnrichmentMetadata,
      seed_anchor_source_kind: anchorDecision.seed_anchor_source_kind,
      seed_anchor_conflict_status: anchorDecision.seed_anchor_conflict_status,
      url_anchor_conflict: anchorDecision.url_anchor_conflict,
      quarantine_reason: anchorDecision.quarantine_reason,
    },
  });

  if (!enrichmentBlock) {
    return {
      changed: false,
      row,
      enrichment_source: ENRICHMENT_SOURCE.none,
      seed_structured_ingredient_status_before: beforeStatus,
      seed_structured_ingredient_status_after: beforeStatus,
      seed_kb_sync_status: buildSeedKbSyncStatus({ seedStatus: beforeStatus, reviewedKbRows }),
      runtime_ingredient_evidence_source: buildRuntimeIngredientEvidenceSource({
        seedStatus: beforeStatus,
        reviewedKbRows,
      }),
      reviewed_kb_rows: reviewedKbRows,
      seed_anchor_source_kind: anchorDecision.seed_anchor_source_kind,
      seed_anchor_conflict_status: anchorDecision.seed_anchor_conflict_status,
      url_anchor_conflict: anchorDecision.url_anchor_conflict,
      quarantine_reason: anchorDecision.quarantine_reason,
      seed_quarantine_bucket: noBlockQuarantine.seed_quarantine_bucket,
      quarantined_from_wave1: noBlockQuarantine.quarantined_from_wave1,
      contamination_signal_source: noBlockQuarantine.contamination_signal_source,
    };
  }

  let nextSeedData = mergeStructuredBlockIntoSeedData(seedData, enrichmentBlock);
  let afterStatus = classifySeedStructuredIngredientStatus(nextSeedData);
  let afterSeedKbSyncStatus = buildSeedKbSyncStatus({ seedStatus: afterStatus, reviewedKbRows });
  const writeQuarantine = classifyExternalSeedQuarantine({
    row: { ...row, seed_data: nextSeedData },
    reviewedKbRows,
    seedStatus: afterStatus,
    seedKbSyncStatus: afterSeedKbSyncStatus,
    enrichmentSource: tentativeEnrichmentSource,
    seedEnrichmentMetadata: {
      ...existingEnrichmentMetadata,
      ...readExternalSeedEnrichmentMetadata(nextSeedData),
    },
  });
  if (HARD_WRITEBACK_QUARANTINE_BUCKETS.has(writeQuarantine.seed_quarantine_bucket)) {
    return {
      changed: false,
      row,
      enrichment_source: ENRICHMENT_SOURCE.none,
      seed_structured_ingredient_status_before: beforeStatus,
      seed_structured_ingredient_status_after: beforeStatus,
      seed_kb_sync_status: beforeSeedKbSyncStatus,
      runtime_ingredient_evidence_source: buildRuntimeIngredientEvidenceSource({
        seedStatus: beforeStatus,
        reviewedKbRows,
      }),
      reviewed_kb_rows: reviewedKbRows,
      seed_anchor_source_kind:
        normalizeNonEmptyString(enrichmentBlock?.ingredient_intel?.external_seed_enrichment?.seed_anchor_source_kind) ||
        SEED_ANCHOR_SOURCE_KIND.none,
      seed_anchor_conflict_status:
        normalizeNonEmptyString(enrichmentBlock?.ingredient_intel?.external_seed_enrichment?.seed_anchor_conflict_status) ||
        SEED_ANCHOR_CONFLICT_STATUS.none,
      url_anchor_conflict: enrichmentBlock?.ingredient_intel?.external_seed_enrichment?.url_anchor_conflict === true,
      quarantine_reason:
        normalizeNonEmptyString(enrichmentBlock?.ingredient_intel?.external_seed_enrichment?.quarantine_reason) || null,
      seed_quarantine_bucket: writeQuarantine.seed_quarantine_bucket,
      quarantined_from_wave1: writeQuarantine.quarantined_from_wave1,
      contamination_signal_source: writeQuarantine.contamination_signal_source,
    };
  }
  nextSeedData = applyExternalSeedEnrichmentMetadata(nextSeedData, {
    seed_quarantine_bucket: writeQuarantine.seed_quarantine_bucket,
    quarantined_from_wave1: writeQuarantine.quarantined_from_wave1,
    contamination_signal_source: writeQuarantine.contamination_signal_source,
  });
  afterStatus = classifySeedStructuredIngredientStatus(nextSeedData);
  afterSeedKbSyncStatus = buildSeedKbSyncStatus({ seedStatus: afterStatus, reviewedKbRows });
  const changed = JSON.stringify(readStructuredIngredientView(seedData)) !== JSON.stringify(readStructuredIngredientView(nextSeedData));
  return {
    changed,
    row: changed ? { ...row, seed_data: nextSeedData } : row,
    enrichment_source:
      normalizeNonEmptyString(enrichmentBlock?.ingredient_intel?.external_seed_enrichment?.source) || ENRICHMENT_SOURCE.none,
    seed_structured_ingredient_status_before: beforeStatus,
    seed_structured_ingredient_status_after: afterStatus,
    seed_kb_sync_status: afterSeedKbSyncStatus,
    runtime_ingredient_evidence_source: buildRuntimeIngredientEvidenceSource({
      seedStatus: afterStatus,
      reviewedKbRows,
    }),
    reviewed_kb_rows: reviewedKbRows,
    seed_anchor_source_kind:
      normalizeNonEmptyString(enrichmentBlock?.ingredient_intel?.external_seed_enrichment?.seed_anchor_source_kind) ||
      SEED_ANCHOR_SOURCE_KIND.none,
    seed_anchor_conflict_status:
      normalizeNonEmptyString(enrichmentBlock?.ingredient_intel?.external_seed_enrichment?.seed_anchor_conflict_status) ||
      SEED_ANCHOR_CONFLICT_STATUS.none,
    url_anchor_conflict: enrichmentBlock?.ingredient_intel?.external_seed_enrichment?.url_anchor_conflict === true,
    quarantine_reason:
      normalizeNonEmptyString(enrichmentBlock?.ingredient_intel?.external_seed_enrichment?.quarantine_reason) || null,
    seed_quarantine_bucket: writeQuarantine.seed_quarantine_bucket,
    quarantined_from_wave1: writeQuarantine.quarantined_from_wave1,
    contamination_signal_source: writeQuarantine.contamination_signal_source,
  };
}

module.exports = {
  SEED_INGREDIENT_WRITEBACK_VERSION,
  ENRICHMENT_SOURCE,
  SEED_ANCHOR_SOURCE_KIND,
  SEED_ANCHOR_CONFLICT_STATUS,
  SEED_STRUCTURED_STATUS,
  SEED_KB_SYNC_STATUS,
  SEED_QUARANTINE_BUCKET,
  PDP_FIELD_STATUS,
  SEED_DESCRIPTION_ORIGIN,
  classifySeedStructuredIngredientStatus,
  classifySeedPdpFieldCoverageStatus,
  hasSeedStructuredIngredientEvidence,
  fetchReviewedKbRowsForSeedRow,
  buildSeedKbSyncStatus,
  buildRuntimeIngredientEvidenceSource,
  buildIngredientSourceQualityStatus,
  readExternalSeedEnrichmentMetadata,
  classifyExternalSeedQuarantine,
  enrichExternalSeedRowIngredients,
  _internals: {
    candidateIngredientTexts,
    candidatePdpIngredientTexts,
    extractRegistryTokensFromText,
    buildBlockFromKbRows,
    buildBlockFromPdpIngredientFields,
    buildBlockFromDescriptionParse,
    buildBlockFromAnchor,
    mergeStructuredBlockIntoSeedData,
    readStructuredIngredientView,
    readSeedPdpContentView,
    profileAnchorTitleTexts,
    profileAnchorUrlTexts,
    resolveAnchorProfileDecision,
    resolveStrongAnchorProfileFromTexts,
    isReviewedKbIngredientRow,
    hasRowIngredientNameOnlySignal,
    hasObviousNonBeautySignals,
    classifyWave1ManualScopeSignal,
    hasWave1SafeFaceSkincareSignal,
    applyExternalSeedEnrichmentMetadata,
    buildIngredientSourceQualityStatus,
    shouldUpgradePresentStructuredSeed,
  },
};
