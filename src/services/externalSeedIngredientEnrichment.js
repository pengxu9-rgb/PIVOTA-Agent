const { query } = require('../db');
const { kbQuery } = require('./pciKbClient');
const { ensureJsonObject } = require('./externalSeedProducts');
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
  descriptionParse: 'description_parse',
  titleUrlAnchor: 'title_url_anchor',
  none: 'none',
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
const REVIEW_STATUS_BLOCKLIST = new Set(['blocked', 'rejected', 'fail', 'failed']);

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

function candidateIngredientTexts(row = {}) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const variants = Array.isArray(snapshot.variants)
    ? snapshot.variants
    : Array.isArray(seedData.variants)
      ? seedData.variants
      : [];
  return uniqStrings([
    ...variants.map((variant) => extractRawIngredientText(variant?.description)).filter(Boolean),
    extractRawIngredientText(snapshot.description),
    extractRawIngredientText(seedData.description),
    extractRawIngredientText(row.description),
  ], 16);
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

function resolveAnchorProfile({ row, ingredientId = '', ingredientName = '' } = {}) {
  const hasExplicitIngredientAnchor =
    Boolean(normalizeNonEmptyString(ingredientId)) || Boolean(normalizeNonEmptyString(ingredientName));
  const anchorTexts = [
    ...profileAnchorTitleTexts(row, ingredientName),
    ...(hasExplicitIngredientAnchor ? profileAnchorUrlTexts(row) : []),
  ];
  const directProfile = resolveIngredientRecallProfile({
    ingredientId,
    query: ingredientName,
    target: row?.title || '',
  });
  return resolveStrongAnchorProfileFromTexts(anchorTexts, directProfile ? [directProfile] : []);
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
  const intel = {
    ...(normalizedIngredientTokens.length
      ? { inci_normalized: normalizedIngredientTokens, key_ingredients: normalizedKeyIngredients }
      : {}),
    ...(normalizedActiveIngredients.length ? { active_ingredients: normalizedActiveIngredients } : {}),
    ...(rawText ? { raw_ingredient_text_clean: rawText } : {}),
    ...(normalizedInciList ? { inci_list: normalizedInciList, inci_raw: rawText || normalizedInciList } : {}),
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
    },
  });
}

function buildBlockFromAnchor(anchorProfile) {
  if (!anchorProfile) return null;
  const displayName = normalizeNonEmptyString(anchorProfile.display_name || anchorProfile.ingredient_name);
  if (!displayName) return null;
  return buildIngredientBlock({
    ingredientTokens: [displayName],
    keyIngredients: [displayName],
    source: ENRICHMENT_SOURCE.titleUrlAnchor,
    metadata: {
      anchored_ingredient_id: normalizeNonEmptyString(anchorProfile.ingredient_id) || null,
    },
  });
}

function mergeIngredientIntel(existingValue, nextValue) {
  const existing = ensureJsonObject(existingValue);
  const next = ensureJsonObject(nextValue);
  return {
    ...existing,
    ...next,
    external_seed_enrichment: {
      ...ensureJsonObject(existing.external_seed_enrichment),
      ...ensureJsonObject(next.external_seed_enrichment),
    },
  };
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
    };
  }

  const reviewedKbRows = Array.isArray(kbRows) ? kbRows.filter(isReviewedKbIngredientRow) : await fetchReviewedKbRowsForSeedRow(row);
  const seedData = ensureJsonObject(row.seed_data);
  const beforeStatus = classifySeedStructuredIngredientStatus(seedData);
  const hasExplicitIngredientAnchor =
    normalizeNonEmptyString(ingredientId) || normalizeNonEmptyString(ingredientName);
  if (beforeStatus === SEED_STRUCTURED_STATUS.present && reviewedKbRows.length === 0 && !hasExplicitIngredientAnchor) {
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
    };
  }
  const anchorProfile = resolveAnchorProfile({ row, ingredientId, ingredientName });
  const enrichmentBlock =
    buildBlockFromKbRows(reviewedKbRows, { anchorProfile }) ||
    buildBlockFromDescriptionParse(row, { anchorProfile }) ||
    buildBlockFromAnchor(anchorProfile);

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
    };
  }

  const nextSeedData = mergeStructuredBlockIntoSeedData(seedData, enrichmentBlock);
  const afterStatus = classifySeedStructuredIngredientStatus(nextSeedData);
  const changed = JSON.stringify(readStructuredIngredientView(seedData)) !== JSON.stringify(readStructuredIngredientView(nextSeedData));
  return {
    changed,
    row: changed ? { ...row, seed_data: nextSeedData } : row,
    enrichment_source:
      normalizeNonEmptyString(enrichmentBlock?.ingredient_intel?.external_seed_enrichment?.source) || ENRICHMENT_SOURCE.none,
    seed_structured_ingredient_status_before: beforeStatus,
    seed_structured_ingredient_status_after: afterStatus,
    seed_kb_sync_status: buildSeedKbSyncStatus({ seedStatus: afterStatus, reviewedKbRows }),
    runtime_ingredient_evidence_source: buildRuntimeIngredientEvidenceSource({
      seedStatus: afterStatus,
      reviewedKbRows,
    }),
    reviewed_kb_rows: reviewedKbRows,
  };
}

module.exports = {
  SEED_INGREDIENT_WRITEBACK_VERSION,
  ENRICHMENT_SOURCE,
  SEED_STRUCTURED_STATUS,
  SEED_KB_SYNC_STATUS,
  classifySeedStructuredIngredientStatus,
  hasSeedStructuredIngredientEvidence,
  fetchReviewedKbRowsForSeedRow,
  buildSeedKbSyncStatus,
  buildRuntimeIngredientEvidenceSource,
  enrichExternalSeedRowIngredients,
  _internals: {
    candidateIngredientTexts,
    extractRegistryTokensFromText,
    buildBlockFromKbRows,
    buildBlockFromDescriptionParse,
    buildBlockFromAnchor,
    mergeStructuredBlockIntoSeedData,
    readStructuredIngredientView,
    profileAnchorTitleTexts,
    profileAnchorUrlTexts,
    resolveAnchorProfile,
    resolveStrongAnchorProfileFromTexts,
    isReviewedKbIngredientRow,
  },
};
