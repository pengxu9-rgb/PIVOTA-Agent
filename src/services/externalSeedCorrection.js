const { query } = require('../db');
const { auditExternalSeedRow, detectGenericTemplateDescription } = require('./externalSeedContentAudit');
const { lookupExternalSeedImageOverride } = require('./externalSeedImageOverrides');
const { ensureJsonObject, collectSeedImageUrls, normalizeSeedVariants } = require('./externalSeedProducts');
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
  applyManualImageOverride: 'apply_manual_image_override',
  clearGenericTemplateDescription: 'clear_generic_template_description',
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

function uniqueStrings(values) {
  const out = [];
  for (const value of values || []) {
    const normalized = normalizeNonEmptyString(value);
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

function loadSnapshot(row) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return { seedData, snapshot };
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

async function persistExternalSeedRow(row) {
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
      row.id,
      normalizeNonEmptyString(row.title),
      normalizeUrlLike(row.canonical_url),
      normalizeUrlLike(row.destination_url),
      normalizeNonEmptyString(row.image_url),
      row.price_amount ?? null,
      normalizeNonEmptyString(row.price_currency),
      normalizeNonEmptyString(row.availability),
      JSON.stringify(ensureJsonObject(row.seed_data)),
    ],
  );
  return loadExternalSeedRowById(row.id);
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
  ]);
  if (findings.some((finding) => rerunTriggers.has(normalizeNonEmptyString(finding?.anomaly_type)))) {
    actions.push({ correction_type: SEED_CORRECTION_TYPE.rerunCatalogExtraction, auto_applied: true });
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

  if (correctionType === SEED_CORRECTION_TYPE.rerunCatalogExtraction) {
    const result = await processRow(row, {
      baseUrl: options.baseUrl,
      dryRun: false,
    });
    const nextRow =
      result?.row?.id ? await loadExternalSeedRowById(result.row.id) : await loadExternalSeedRowById(row.id);
    return {
      changed: result?.status === 'updated',
      row: nextRow || row,
      correction_type: correctionType,
      process_result: result,
    };
  }

  const beforeRow = cloneJson(row);
  let applied = { changed: false, row };

  if (correctionType === SEED_CORRECTION_TYPE.normalizeLocaleByMarket) {
    applied = applyLocaleNormalization(row);
  } else if (correctionType === SEED_CORRECTION_TYPE.recoverDirectPdpTarget) {
    applied = applyRecoveredTarget(row);
  } else if (correctionType === SEED_CORRECTION_TYPE.clearGenericTemplateDescription) {
    applied = applyGenericTemplateClear(row);
  } else if (correctionType === SEED_CORRECTION_TYPE.applyManualImageOverride) {
    applied = applyManualImageOverride(row);
  } else if (correctionType === SEED_CORRECTION_TYPE.markBlockedNoProductUrls) {
    applied = applyBlockedNoProductUrls(row);
  }

  if (!applied.changed) {
    return { changed: false, row, correction_type: correctionType, before: beforeRow, after: beforeRow };
  }

  const persistedRow = await persistExternalSeedRow(applied.row);
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
  let workingRow = row;
  const actions = [];

  for (const action of plan.actions) {
    const result = await applySeedCorrectionAction(workingRow, action, options);
    workingRow = result.row || workingRow;
    actions.push(result);
  }

  let finalAudit = auditExternalSeedRow(workingRow);
  if (finalAudit.findings.some((finding) => normalizeNonEmptyString(finding?.anomaly_type) === 'zero_variants')) {
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
  applySeedCorrectionAction,
  runSeedCorrectionCycle,
};
