const { query } = require('../db');
const { auditExternalSeedRow, detectGenericTemplateDescription } = require('./externalSeedContentAudit');
const { lookupExternalSeedImageOverride } = require('./externalSeedImageOverrides');
const { ensureJsonObject, collectSeedImageUrls, canonicalizeExternalSeedSnapshot } = require('./externalSeedProducts');
const { enrichExternalSeedRowIngredients } = require('./externalSeedIngredientEnrichment');
const { buildExternalSeedRecallDoc } = require('./externalSeedRecall');
const {
  pickSeedTargetUrl,
  normalizeTargetUrlForMarket,
  recoverTargetUrlFromDiagnostics,
  processRow,
} = require('../../scripts/backfill-external-product-seeds-catalog');

const SEED_CORRECTION_TYPE = Object.freeze({
  normalizeLocaleByMarket: 'normalize_locale_by_market',
  recoverDirectPdpTarget: 'recover_direct_pdp_target',
  rerunCatalogExtraction: 'rerun_catalog_extraction',
  normalizeBeautyMinorUnitPrice: 'normalize_beauty_minor_unit_price',
  applyManualImageOverride: 'apply_manual_image_override',
  clearGenericTemplateDescription: 'clear_generic_template_description',
  normalizeVariantDisplayContract: 'normalize_variant_display_contract',
  markBlockedNoProductUrls: 'mark_blocked_no_product_urls',
});

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeUrlLike(value) {
  const normalized = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || null));
}

function stripPostgresNulBytes(value) {
  return String(value || '').replace(/\u0000/g, '');
}

function sanitizeJsonForPostgres(value) {
  if (typeof value === 'string') return stripPostgresNulBytes(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonForPostgres(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [stripPostgresNulBytes(key), sanitizeJsonForPostgres(item)]),
  );
}

function stringifyJsonForPostgres(value) {
  return JSON.stringify(sanitizeJsonForPostgres(value)).replace(/\\u0000/gi, '');
}

function refreshDerivedRecall(nextRow) {
  const row = nextRow && typeof nextRow === 'object' ? nextRow : {};
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return {
    ...row,
    seed_data: {
      ...seedData,
      derived: {
        ...ensureJsonObject(seedData.derived),
        recall: buildExternalSeedRecallDoc({ row, seedData, snapshot }),
      },
    },
  };
}

function mergePreviewRow(row, nextRow) {
  if (!nextRow || typeof nextRow !== 'object') return row;
  return refreshDerivedRecall({
    ...row,
    ...nextRow,
    id: row?.id,
    external_product_id: row?.external_product_id,
    market: row?.market,
    tool: row?.tool,
    status: row?.status,
    attached_product_key: row?.attached_product_key,
    created_at: row?.created_at,
    updated_at: row?.updated_at,
    seed_data: ensureJsonObject(nextRow.seed_data),
  });
}

function uniqueStrings(values) {
  const out = [];
  for (const value of values || []) {
    const normalized = normalizeNonEmptyString(value);
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

function normalizeAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = normalizeNonEmptyString(value).replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function looksLikeMinorUnitAmount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 1000 && value / 100 >= 1 && value / 100 <= 1000;
}

function formatMajorUnitPrice(value) {
  return Number(value).toFixed(2);
}

function loadSnapshot(row) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return { seedData, snapshot };
}

function normalizeVariantOptionName(value) {
  return normalizeNonEmptyString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeVariantOptionValue(value) {
  return normalizeNonEmptyString(value).replace(/\s+/g, ' ');
}

function variantCollections(row) {
  const { seedData, snapshot } = loadSnapshot(row);
  return [
    snapshot.variants,
    seedData.variants,
    snapshot.product?.variants,
    seedData.product?.variants,
    snapshot.skus,
    seedData.skus,
  ].filter((collection) => Array.isArray(collection));
}

function collectVariantOptionRows(row) {
  const rows = [];
  for (const variants of variantCollections(row)) {
    for (const variant of variants) {
      if (!variant || typeof variant !== 'object') continue;
      const directName = normalizeVariantOptionName(variant.option_name || variant.optionName);
      const directValue = normalizeVariantOptionValue(variant.option_value || variant.optionValue);
      if (directName || directValue) rows.push({ variant, name: directName, value: directValue });
      const options = Array.isArray(variant.options) ? variant.options : [];
      for (const option of options) {
        if (!option || typeof option !== 'object') continue;
        const name = normalizeVariantOptionName(option.name || option.option_name || option.label || option.key);
        const value = normalizeVariantOptionValue(option.value ?? option.option_value ?? option.selected);
        if (name || value) rows.push({ variant, name, value });
      }
    }
  }
  return rows;
}

function isVariantIdentityAxisName(name) {
  return [
    'offer',
    'sku',
    'sku id',
    'variant sku',
    'barcode',
    'upc',
    'ean',
    'gtin',
    'product id',
    'variant id',
    'title',
  ].includes(name);
}

function isLocaleLikeVariantValue(value) {
  return ['us', 'usa', 'uk', 'eu', 'fr', 'de', 'es', 'it', 'ca', 'au', 'jp', 'kr', 'cn'].includes(
    normalizeVariantOptionName(value),
  );
}

function looksLikeGenericSizeOrFormatValue(value) {
  const normalized = normalizeVariantOptionValue(value);
  if (!normalized) return false;
  return (
    /\b\d+(?:\.\d+)?\s*(ml|m l|g|kg|oz|fl oz|l|lb|lbs|mm|cm)\b/i.test(normalized) ||
    /\b(pack of|set of)\s*\d+\b/i.test(normalized) ||
    /\b\d+\s*-?\s*(pack|ct|count|pcs|pieces)\b/i.test(normalized) ||
    /\b(refill|travel size|full size|mini|jumbo|regular|single)\b/i.test(normalized)
  );
}

function isGenericVariantDisplayAxisName(name) {
  return [
    'option',
    'variant',
    'variants',
    'selection',
    'choose a size',
    'choose size',
    'select size',
    'ml',
    'm l',
    'ct',
    'ct.',
    'sachet',
    'unité',
    'unit',
    'voume',
  ].includes(name);
}

function hasVariantVisualEvidence(variant) {
  return Boolean(
    normalizeNonEmptyString(
      variant?.label_image_url ||
        variant?.labelImageUrl ||
        variant?.swatch_image_url ||
        variant?.swatchImageUrl ||
        variant?.image_url ||
        variant?.image ||
        variant?.swatch?.image_url ||
        variant?.swatch?.imageUrl,
    ) ||
      normalizeNonEmptyString(
        variant?.color_hex ||
          variant?.colorHex ||
          variant?.shade_hex ||
          variant?.shadeHex ||
          variant?.swatch_color ||
          variant?.swatchColor ||
          variant?.swatch?.hex,
      )
  );
}

function hasVariantDisplayContractDrift(row) {
  return collectVariantOptionRows(row).some((item) => {
    if (!item.name || !item.value) return false;
    if (isVariantIdentityAxisName(item.name)) return true;
    if (['color', 'colour', 'shade', 'tone', 'hue'].includes(item.name) && isLocaleLikeVariantValue(item.value)) {
      return true;
    }
    if (isGenericVariantDisplayAxisName(item.name)) return true;
    if (['option', 'variant', 'selection'].includes(item.name) && looksLikeGenericSizeOrFormatValue(item.value)) {
      return true;
    }
    if (['color', 'colour', 'shade', 'tone', 'hue'].includes(item.name) && !hasVariantVisualEvidence(item.variant)) {
      return true;
    }
    return false;
  });
}

async function loadExternalSeedRowById(seedId) {
  const res = await query(
    `
      SELECT
        id,
        external_product_id,
        market,
        tool,
        destination_url,
        canonical_url,
        domain,
        title,
        image_url,
        price_amount,
        price_currency,
        availability,
        seed_data,
        status,
        attached_product_key,
        created_at,
        updated_at
      FROM external_product_seeds
      WHERE id = $1
      LIMIT 1
    `,
    [String(seedId || '')],
  );
  return res.rows?.[0] || null;
}

async function persistExternalSeedRow(row, options = {}) {
  const recallRefreshedRow = refreshDerivedRecall(row);
  const enrichment = options.skipIngredientEnrichment
    ? null
    : await enrichExternalSeedRowIngredients({
        row: recallRefreshedRow,
        ingredientId:
          normalizeNonEmptyString(recallRefreshedRow?.ingredient_id) ||
          normalizeNonEmptyString(ensureJsonObject(recallRefreshedRow?.seed_data).ingredient_id),
        ingredientName:
          normalizeNonEmptyString(recallRefreshedRow?.ingredient_name) ||
          normalizeNonEmptyString(ensureJsonObject(recallRefreshedRow?.seed_data).ingredient_name),
      });
  const persistedRow =
    enrichment?.row && typeof enrichment.row === 'object' ? refreshDerivedRecall(enrichment.row) : recallRefreshedRow;
  const sanitizedSeedData = sanitizeJsonForPostgres(ensureJsonObject(persistedRow.seed_data));
  await query(
    `
      UPDATE external_product_seeds
      SET
        title = CASE WHEN $2 <> '' THEN $2 ELSE title END,
        canonical_url = CASE WHEN $3 <> '' THEN $3 ELSE canonical_url END,
        destination_url = CASE WHEN $4 <> '' THEN $4 ELSE destination_url END,
        image_url = CASE WHEN $5 <> '' THEN $5 ELSE image_url END,
        price_amount = COALESCE($6, price_amount),
        price_currency = CASE WHEN $7 <> '' THEN $7 ELSE price_currency END,
        availability = CASE WHEN $8 <> '' THEN $8 ELSE availability END,
        seed_data = $9::jsonb,
        updated_at = now()
      WHERE id = $1
    `,
    [
      persistedRow.id,
      stripPostgresNulBytes(normalizeNonEmptyString(persistedRow.title)),
      stripPostgresNulBytes(normalizeUrlLike(persistedRow.canonical_url)),
      stripPostgresNulBytes(normalizeUrlLike(persistedRow.destination_url)),
      stripPostgresNulBytes(normalizeNonEmptyString(persistedRow.image_url)),
      persistedRow.price_amount ?? null,
      stripPostgresNulBytes(normalizeNonEmptyString(persistedRow.price_currency)),
      stripPostgresNulBytes(normalizeNonEmptyString(persistedRow.availability)),
      stringifyJsonForPostgres(sanitizedSeedData),
    ],
  );
  return loadExternalSeedRowById(persistedRow.id);
}

function updateSeedUrlFields(row, nextUrl) {
  const normalizedUrl = normalizeUrlLike(nextUrl);
  if (!normalizedUrl) return row;

  const nextRow = cloneJson(row);
  const { seedData, snapshot } = loadSnapshot(nextRow);
  const currentUrls = uniqueStrings([
    nextRow.canonical_url,
    nextRow.destination_url,
    seedData.canonical_url,
    seedData.destination_url,
    snapshot.canonical_url,
    snapshot.destination_url,
  ]);
  if (currentUrls.length === 1 && currentUrls[0] === normalizedUrl) return nextRow;

  nextRow.canonical_url = normalizedUrl;
  nextRow.destination_url = normalizedUrl;
  seedData.canonical_url = normalizedUrl;
  seedData.destination_url = normalizedUrl;
  snapshot.canonical_url = normalizedUrl;
  snapshot.destination_url = normalizedUrl;
  seedData.snapshot = snapshot;
  nextRow.seed_data = seedData;
  return nextRow;
}

function applyLocaleNormalization(row) {
  const targetUrl = normalizeTargetUrlForMarket(pickSeedTargetUrl(row), row?.market);
  if (!targetUrl) return { changed: false, row };
  const nextRow = updateSeedUrlFields(row, targetUrl);
  const changed =
    normalizeUrlLike(nextRow.canonical_url) !== normalizeUrlLike(row.canonical_url) ||
    normalizeUrlLike(nextRow.destination_url) !== normalizeUrlLike(row.destination_url);
  return { changed, row: nextRow };
}

function applyRecoveredTarget(row) {
  const recovered = normalizeTargetUrlForMarket(recoverTargetUrlFromDiagnostics(row), row?.market);
  if (!recovered) return { changed: false, row };
  const nextRow = updateSeedUrlFields(row, recovered);
  const changed =
    normalizeUrlLike(nextRow.canonical_url) !== normalizeUrlLike(row.canonical_url) ||
    normalizeUrlLike(nextRow.destination_url) !== normalizeUrlLike(row.destination_url);
  return { changed, row: nextRow };
}

function applyGenericTemplateClear(row) {
  const nextRow = cloneJson(row);
  const { seedData, snapshot } = loadSnapshot(nextRow);
  const title = normalizeNonEmptyString(snapshot.title || nextRow.title || seedData.title);
  const descriptions = [
    normalizeNonEmptyString(snapshot.description),
    normalizeNonEmptyString(seedData.description),
  ];
  const hasTemplate = descriptions.some((description) => detectGenericTemplateDescription(title, description));
  if (!hasTemplate) {
    return { changed: false, row };
  }

  if (detectGenericTemplateDescription(title, snapshot.description)) snapshot.description = '';
  if (detectGenericTemplateDescription(title, seedData.description)) seedData.description = '';
  if (Array.isArray(snapshot.variants)) {
    snapshot.variants = snapshot.variants.map((variant) =>
      detectGenericTemplateDescription(title, variant?.description) ? { ...variant, description: '' } : variant,
    );
  }
  if (Array.isArray(seedData.variants)) {
    seedData.variants = seedData.variants.map((variant) =>
      detectGenericTemplateDescription(title, variant?.description) ? { ...variant, description: '' } : variant,
    );
  }

  seedData.snapshot = snapshot;
  nextRow.seed_data = seedData;
  return { changed: true, row: nextRow };
}

function applyManualImageOverride(row) {
  const currentImageUrls = collectSeedImageUrls(row?.seed_data, row);
  if (currentImageUrls.length > 0) return { changed: false, row };

  const { seedData, snapshot } = loadSnapshot(row);
  const override = lookupExternalSeedImageOverride(
    row?.canonical_url,
    row?.destination_url,
    seedData?.canonical_url,
    seedData?.destination_url,
    snapshot?.canonical_url,
    snapshot?.destination_url,
  );
  if (!override) return { changed: false, row };

  const nextRow = cloneJson(row);
  const nextSeedData = ensureJsonObject(nextRow.seed_data);
  const nextSnapshot = ensureJsonObject(nextSeedData.snapshot);
  const imageUrls = uniqueStrings([...(override.image_urls || []), override.image_url]);
  if (!imageUrls.length) return { changed: false, row };

  nextRow.image_url = imageUrls[0];
  nextSeedData.image_url = imageUrls[0];
  nextSeedData.image_urls = imageUrls;
  nextSeedData.images = imageUrls;
  nextSnapshot.image_url = imageUrls[0];
  nextSnapshot.image_urls = imageUrls;
  nextSnapshot.images = imageUrls;
  nextSnapshot.diagnostics = {
    ...(ensureJsonObject(nextSnapshot.diagnostics)),
    manual_image_override: {
      applied: true,
      source: override.source || 'manual_seed_override',
      note: override.note || 'Manual image override applied by seed correction',
    },
  };
  nextSeedData.snapshot = nextSnapshot;
  nextRow.seed_data = nextSeedData;
  return { changed: true, row: nextRow };
}

function applyBlockedNoProductUrls(row) {
  const nextRow = cloneJson(row);
  const { seedData, snapshot } = loadSnapshot(nextRow);
  snapshot.diagnostics = {
    ...(ensureJsonObject(snapshot.diagnostics)),
    failure_category: 'no_product_urls',
  };
  seedData.snapshot = snapshot;
  nextRow.seed_data = seedData;
  return { changed: true, row: nextRow };
}

function applyBeautyMinorUnitPriceNormalization(row) {
  const audit = auditExternalSeedRow(row);
  const blocker = (audit.findings || []).find(
    (finding) => normalizeNonEmptyString(finding?.anomaly_type) === 'beauty_minor_unit_price_suspected',
  );
  if (!blocker) return { changed: false, row };

  const suspectedMajorUnitAmount = normalizeAmount(blocker?.evidence?.suspected_major_unit_amount);
  const nextRow = cloneJson(row);
  const { seedData, snapshot } = loadSnapshot(nextRow);
  let changed = false;

  if (typeof suspectedMajorUnitAmount === 'number' && Number.isFinite(suspectedMajorUnitAmount)) {
    nextRow.price_amount = suspectedMajorUnitAmount;
    if (looksLikeMinorUnitAmount(normalizeAmount(seedData.price_amount))) {
      seedData.price_amount = suspectedMajorUnitAmount;
      changed = true;
    }
    if (looksLikeMinorUnitAmount(normalizeAmount(snapshot.price_amount))) {
      snapshot.price_amount = suspectedMajorUnitAmount;
      changed = true;
    }
    changed = true;
  }

  const normalizeVariantList = (variants) => {
    if (!Array.isArray(variants)) return variants;
    return variants.map((variant) => {
      if (!variant || typeof variant !== 'object') return variant;
      const price = normalizeAmount(variant.price);
      if (!looksLikeMinorUnitAmount(price)) return variant;
      changed = true;
      return {
        ...variant,
        price: formatMajorUnitPrice(price / 100),
      };
    });
  };

  if (Array.isArray(snapshot.variants)) snapshot.variants = normalizeVariantList(snapshot.variants);
  if (Array.isArray(seedData.variants)) seedData.variants = normalizeVariantList(seedData.variants);

  seedData.snapshot = snapshot;
  nextRow.seed_data = seedData;
  return { changed, row: nextRow };
}

function applyVariantDisplayContractNormalization(row) {
  const nextRow = cloneJson(row);
  const before = JSON.stringify(ensureJsonObject(nextRow.seed_data));
  nextRow.seed_data = canonicalizeExternalSeedSnapshot(nextRow.seed_data, nextRow, { stripLegacy: false });
  const after = JSON.stringify(ensureJsonObject(nextRow.seed_data));
  return {
    changed: before !== after,
    row: before !== after ? nextRow : row,
  };
}

function buildSeedCorrectionPlan(row, auditResult = auditExternalSeedRow(row)) {
  const findings = Array.isArray(auditResult?.findings) ? auditResult.findings : [];
  const anomalyTypes = new Set(findings.map((finding) => normalizeNonEmptyString(finding?.anomaly_type)));
  const actions = [];

  if (anomalyTypes.has('locale_market_mismatch')) {
    actions.push({ correction_type: SEED_CORRECTION_TYPE.normalizeLocaleByMarket, auto_applied: true });
  }
  if (anomalyTypes.has('non_product_fallback_page') && recoverTargetUrlFromDiagnostics(row)) {
    actions.push({ correction_type: SEED_CORRECTION_TYPE.recoverDirectPdpTarget, auto_applied: true });
  }
  if (anomalyTypes.has('generic_template_description')) {
    actions.push({ correction_type: SEED_CORRECTION_TYPE.clearGenericTemplateDescription, auto_applied: true });
  }
  if (anomalyTypes.has('zero_images')) {
    const manualOverride = applyManualImageOverride(row);
    if (manualOverride.changed) {
      actions.push({ correction_type: SEED_CORRECTION_TYPE.applyManualImageOverride, auto_applied: true });
    }
  }

  const rerunTriggers = new Set([
    'locale_market_mismatch',
    'non_product_fallback_page',
    'generic_template_description',
    'non_english_description_for_us_seed',
    'fr_content_in_us_seed',
    'es_content_in_us_seed',
    'zero_images',
    'zero_variants',
    'price_currency_mismatch',
    'beauty_minor_unit_price_suspected',
  ]);
  if (findings.some((finding) => rerunTriggers.has(normalizeNonEmptyString(finding?.anomaly_type)))) {
    actions.push({ correction_type: SEED_CORRECTION_TYPE.rerunCatalogExtraction, auto_applied: true });
  }
  if (anomalyTypes.has('beauty_minor_unit_price_suspected')) {
    actions.push({ correction_type: SEED_CORRECTION_TYPE.normalizeBeautyMinorUnitPrice, auto_applied: true });
  }
  if (hasVariantDisplayContractDrift(row)) {
    actions.push({ correction_type: SEED_CORRECTION_TYPE.normalizeVariantDisplayContract, auto_applied: true });
  }

  return {
    findings,
    actions: actions.filter(
      (action, index, list) => list.findIndex((candidate) => candidate.correction_type === action.correction_type) === index,
    ),
  };
}

async function applySeedCorrectionAction(row, action, options = {}) {
  const correctionType = normalizeNonEmptyString(action?.correction_type);
  if (!correctionType) return { changed: false, row, correction_type: correctionType };
  const beforeRow = cloneJson(row);
  const dryRun = Boolean(options.dryRun);

  if (correctionType === SEED_CORRECTION_TYPE.rerunCatalogExtraction) {
    const result = await processRow(row, {
      baseUrl: options.baseUrl,
      dryRun,
    });
    const previewRow = dryRun ? mergePreviewRow(row, result?.payload?.nextRow) : null;
    const nextRow = dryRun
      ? previewRow
      : result?.row?.id
        ? await loadExternalSeedRowById(result.row.id)
        : await loadExternalSeedRowById(row.id);
    return {
      changed: result?.status === 'updated' || result?.status === 'dry_run',
      row: nextRow || row,
      correction_type: correctionType,
      process_result: result,
      dry_run: dryRun,
      before: beforeRow,
      after: cloneJson(nextRow || row),
    };
  }

  let applied = { changed: false, row };

  if (correctionType === SEED_CORRECTION_TYPE.normalizeLocaleByMarket) {
    applied = applyLocaleNormalization(row);
  } else if (correctionType === SEED_CORRECTION_TYPE.recoverDirectPdpTarget) {
    applied = applyRecoveredTarget(row);
  } else if (correctionType === SEED_CORRECTION_TYPE.clearGenericTemplateDescription) {
    applied = applyGenericTemplateClear(row);
  } else if (correctionType === SEED_CORRECTION_TYPE.normalizeBeautyMinorUnitPrice) {
    applied = applyBeautyMinorUnitPriceNormalization(row);
  } else if (correctionType === SEED_CORRECTION_TYPE.normalizeVariantDisplayContract) {
    applied = applyVariantDisplayContractNormalization(row);
  } else if (correctionType === SEED_CORRECTION_TYPE.applyManualImageOverride) {
    applied = applyManualImageOverride(row);
  } else if (correctionType === SEED_CORRECTION_TYPE.markBlockedNoProductUrls) {
    applied = applyBlockedNoProductUrls(row);
  }

  if (!applied.changed) {
    return { changed: false, row, correction_type: correctionType, before: beforeRow, after: beforeRow };
  }

  if (dryRun) {
    return {
      changed: true,
      row: applied.row,
      correction_type: correctionType,
      before: beforeRow,
      after: cloneJson(applied.row),
      dry_run: true,
    };
  }

  const persistedRow = await persistExternalSeedRow(applied.row, {
    skipIngredientEnrichment: Boolean(options.skipIngredientEnrichment),
  });
  return {
    changed: true,
    row: persistedRow || applied.row,
    correction_type: correctionType,
    before: beforeRow,
    after: cloneJson(persistedRow || applied.row),
  };
}

async function runSeedCorrectionCycle(row, options = {}) {
  const initialAudit = auditExternalSeedRow(row);
  const plan = buildSeedCorrectionPlan(row, initialAudit);
  const allowedCorrectionTypes = Array.isArray(options.correctionTypes)
    ? new Set(options.correctionTypes.map(normalizeNonEmptyString).filter(Boolean))
    : null;
  let workingRow = row;
  const actions = [];

  const plannedActions = allowedCorrectionTypes
    ? plan.actions.filter((action) => allowedCorrectionTypes.has(normalizeNonEmptyString(action?.correction_type)))
    : plan.actions;

  for (const action of plannedActions) {
    const result = await applySeedCorrectionAction(workingRow, action, options);
    workingRow = result.row || workingRow;
    actions.push(result);
  }

  let finalAudit = auditExternalSeedRow(workingRow);
  const canApplyBlockedMarker =
    !allowedCorrectionTypes || allowedCorrectionTypes.has(SEED_CORRECTION_TYPE.markBlockedNoProductUrls);
  if (
    canApplyBlockedMarker &&
    finalAudit.findings.some((finding) => normalizeNonEmptyString(finding?.anomaly_type) === 'zero_variants')
  ) {
    const markResult = await applySeedCorrectionAction(
      workingRow,
      { correction_type: SEED_CORRECTION_TYPE.markBlockedNoProductUrls, auto_applied: true },
      options,
    );
    workingRow = markResult.row || workingRow;
    actions.push(markResult);
    finalAudit = auditExternalSeedRow(workingRow);
  }

  return {
    initialAudit,
    finalAudit,
    actions,
    row: workingRow,
  };
}

module.exports = {
  SEED_CORRECTION_TYPE,
  loadExternalSeedRowById,
  persistExternalSeedRow,
  buildSeedCorrectionPlan,
  mergePreviewRow,
  refreshDerivedRecall,
  applyBeautyMinorUnitPriceNormalization,
  applyVariantDisplayContractNormalization,
  hasVariantDisplayContractDrift,
  applySeedCorrectionAction,
  runSeedCorrectionCycle,
};
