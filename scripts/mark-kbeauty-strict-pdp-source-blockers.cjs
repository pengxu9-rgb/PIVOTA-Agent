#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
const QUARANTINE_VERSION = 'external_seed.snapshot_quarantine.v1';
const MARKER_VERSION = 'external_seed.strict_pdp_source_blocker.v1';

const DEFAULT_BLOCKERS_REPORT =
  'reports/kbeauty-continuation-20260505/content/three_brand_gap_audit_v2/db_gap_audit_after_medicube_patch.json';
const DEFAULT_CANONICAL_REPAIR_REPORT =
  'reports/kbeauty-continuation-20260505/content/skin1004_canonical_url_repair_v2/dry-run.json';
const DEFAULT_SAFE_SKIN1004_IDS_FILE =
  'reports/kbeauty-continuation-20260505/content/skin1004_after_canonical_official_html_v2/safe_available_public_ids.txt';
const DEFAULT_OFFICIAL_REPORTS = [
  'reports/kbeauty-continuation-20260505/content/three_brand_official_html_gap_patch_v2/dry-run.json',
  'reports/kbeauty-continuation-20260505/content/tirtir_official_html_gap_patch_v2/dry-run.json',
  'reports/kbeauty-continuation-20260505/content/skin1004_after_canonical_official_html_v2/dry-run.json',
  'reports/kbeauty-continuation-20260505/content/medicube_howto_active_patch_v2/dry-run.json',
];

const QUALITY_FIELD_TO_SEED_FIELDS = {
  description_raw: ['pdp_description_raw'],
  ingredients_raw: ['pdp_ingredients_raw', 'raw_ingredient_text_clean', 'ingredient_text'],
  active_ingredients_raw: ['pdp_active_ingredients_raw', 'active_ingredients'],
  how_to_use_raw: ['pdp_how_to_use_raw'],
  details_sections: ['pdp_details_sections'],
  faq_items: ['pdp_faq_items'],
};

const UNSAFE_CONTENT_FIELDS = [
  'pdp_description_raw',
  'pdp_ingredients_raw',
  'raw_ingredient_text_clean',
  'ingredient_text',
  'pdp_active_ingredients_raw',
  'active_ingredients',
  'pdp_how_to_use_raw',
  'pdp_details_sections',
  'pdp_faq_items',
  'pdp_content_asset_v1',
  'official_html_pdp_fields_v1',
  'official_manual_pdp_fields_v1',
  'ingredient_source_note',
  'official_ingredient_sheet_url',
  'official_ingredient_variant_name',
  'ingredient_intel',
  'ingredients_inci',
  'ingredientsInci',
  'inci_list',
  'inci_normalized',
  'key_ingredients',
  'keyIngredients',
  'hero_ingredients',
  'ingredient_tokens',
  'ingredient_names',
  'ingredientNames',
  'likely_key_ingredients_or_signals',
  'reviewed_ingredient_ids',
  'canonical_ingredient_ids',
  'ingredient_ids',
  'how_to_use',
  'how_to',
  'usage',
  'directions',
];

const UNSAFE_REVIEW_FIELDS = ['review_summary'];

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return fallback;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function ensureObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJsonIfExists(filePath, fallback = null) {
  const resolved = normalizeString(filePath);
  if (!resolved || !fs.existsSync(resolved)) return fallback;
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function readLinesIfExists(filePath) {
  const resolved = normalizeString(filePath);
  if (!resolved || !fs.existsSync(resolved)) return [];
  return fs
    .readFileSync(resolved, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function uniqueStrings(values, limit = 5000) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = normalizeString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function textLength(value) {
  return typeof value === 'string' ? value.trim().length : 0;
}

function hasMeaningfulValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function summarizeFieldLengths(seedData) {
  const snapshot = ensureObject(seedData.snapshot);
  const pick = (field) => seedData[field] ?? snapshot[field];
  const review = ensureObject(seedData.review_summary || snapshot.review_summary);
  return {
    description_len: textLength(pick('pdp_description_raw')),
    ingredients_len: textLength(pick('pdp_ingredients_raw')) || textLength(pick('raw_ingredient_text_clean')),
    active_len:
      textLength(pick('pdp_active_ingredients_raw')) ||
      (Array.isArray(pick('active_ingredients')) ? pick('active_ingredients').length : 0),
    how_to_len: textLength(pick('pdp_how_to_use_raw')),
    details_count: asArray(pick('pdp_details_sections')).length,
    faq_count: asArray(pick('pdp_faq_items')).length,
    review_count: Number(review.count ?? review.review_count ?? review.reviews_count) || 0,
  };
}

function addReason(reasons, reason) {
  const normalized = normalizeString(reason);
  if (normalized && !reasons.includes(normalized)) reasons.push(normalized);
}

function buildReportMaps() {
  const blockersReport = readJsonIfExists(argValue('blockers-report', DEFAULT_BLOCKERS_REPORT), {});
  const canonicalReport = readJsonIfExists(argValue('canonical-repair-report', DEFAULT_CANONICAL_REPAIR_REPORT), {});
  const safeSkin1004Ids = new Set(readLinesIfExists(argValue('safe-skin1004-ids-file', DEFAULT_SAFE_SKIN1004_IDS_FILE)));
  const forceUnsafeIds = new Set(readLinesIfExists(argValue('force-unsafe-ids-file')));
  const officialReportsArg = argValue('official-reports');
  const officialReportPaths = officialReportsArg ? officialReportsArg.split(',').map((item) => item.trim()) : DEFAULT_OFFICIAL_REPORTS;

  const blockerById = new Map();
  for (const blocker of asArray(blockersReport.blockers)) {
    const id = normalizeString(blocker.external_product_id || blocker.id);
    if (id) blockerById.set(id, blocker);
  }

  const canonicalById = new Map();
  for (const result of asArray(canonicalReport.results)) {
    const id = normalizeString(result.external_product_id);
    if (!id) continue;
    canonicalById.set(id, result);
  }

  const officialById = new Map();
  for (const reportPath of officialReportPaths) {
    const report = readJsonIfExists(reportPath, null);
    if (!report) continue;
    for (const result of asArray(report.results)) {
      const id = normalizeString(result.external_product_id);
      if (!id) continue;
      const existing = officialById.get(id) || [];
      existing.push({ ...result, report_path: reportPath });
      officialById.set(id, existing);
    }
  }

  return { blockersReport, blockerById, canonicalById, officialById, safeSkin1004Ids, forceUnsafeIds };
}

function isFinalUrlRootOrNonProduct(result) {
  const finalUrl = normalizeString(result?.final_url);
  if (!finalUrl) return false;
  try {
    const parsed = new URL(finalUrl);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return pathname === '/' || !pathname.includes('/products/');
  } catch {
    return false;
  }
}

function classifyRow(row, maps) {
  const reasons = [];
  const id = normalizeString(row.external_product_id);
  const title = normalizeLower(row.title);
  const canonicalUrl = normalizeLower(row.canonical_url);
  const destinationUrl = normalizeLower(row.destination_url);
  const domain = normalizeLower(row.domain);

  const canonical = maps.canonicalById.get(id);
  if (canonical?.status === 'skipped') {
    addReason(reasons, canonical.reason);
    if (Number(canonical.candidate_http_status) === 404) addReason(reasons, 'public_pdp_404');
  }
  if (title.includes('coming soon') || canonicalUrl.includes('coming-soon') || destinationUrl.includes('coming-soon')) {
    addReason(reasons, 'source_title_or_url_coming_soon');
  }

  const officialResults = maps.officialById.get(id) || [];
  if (maps.forceUnsafeIds?.has(id)) {
    addReason(reasons, 'identity_group_canonical_content_base_for_unsafe_row');
  }
  for (const result of officialResults) {
    if (result.status === 'skipped' && Number(result.http_status) === 404) addReason(reasons, 'official_pdp_http_404');
    if (result.status === 'skipped' && isFinalUrlRootOrNonProduct(result)) {
      addReason(reasons, 'official_pdp_redirected_to_non_product');
    }
    if (result.status === 'skipped' && result.reason === 'no_official_html_fields') {
      addReason(reasons, 'no_official_html_fields_after_backfill');
    }
  }

  if (domain.includes('skin1004.com') && !maps.safeSkin1004Ids.has(id)) {
    const anyOfficialPatch = officialResults.some((result) => result.status === 'dry_run' || result.status === 'updated');
    const anyUnsafeCanonical = canonical?.status === 'skipped';
    if (anyOfficialPatch && !anyUnsafeCanonical) addReason(reasons, 'skin1004_official_candidate_not_in_safe_available_public_set');
  }

  const unsafeSource = reasons.some((reason) =>
    [
      'candidate_product_url_not_public_200',
      'candidate_not_active_sellable_public_pdp',
      'public_pdp_404',
      'official_pdp_http_404',
      'official_pdp_redirected_to_non_product',
      'source_title_or_url_coming_soon',
      'skin1004_official_candidate_not_in_safe_available_public_set',
      'identity_group_canonical_content_base_for_unsafe_row',
    ].includes(reason),
  );

  return { reasons, unsafeSource };
}

function markQuality(quality, key, status, origin, reasonCodes, now) {
  const previous = ensureObject(quality[key]);
  quality[key] = {
    ...previous,
    source_quality_status: status,
    source_origin: origin,
    reason_codes: uniqueStrings([...(asArray(previous.reason_codes)), ...(reasonCodes || [])], 30),
    updated_at: now,
  };
}

function ensureSnapshotContract(seedData, now) {
  const snapshot = ensureObject(seedData.snapshot);
  const contract = {
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    updated_at: now,
  };
  seedData.external_seed_snapshot_contract = {
    ...ensureObject(seedData.external_seed_snapshot_contract),
    ...contract,
  };
  snapshot.external_seed_snapshot_contract = {
    ...ensureObject(snapshot.external_seed_snapshot_contract),
    ...contract,
  };
}

function addQuarantineField(seedData, field, value, reasonCodes, now, sourceOrigin = 'official_pdp') {
  if (!hasMeaningfulValue(value)) return false;
  const quarantine = ensureObject(seedData.snapshot_quarantine);
  const fields = ensureObject(quarantine.fields);
  fields[field] = {
    rejected_value: value,
    reason_codes: uniqueStrings(reasonCodes, 30),
    source_quality_status: 'quarantined',
    source_origin: sourceOrigin,
    quarantined_at: now,
  };
  seedData.snapshot_quarantine = {
    ...quarantine,
    contract_version: QUARANTINE_VERSION,
    updated_at: now,
    fields,
  };
  return true;
}

function deleteFieldFromRootAndSnapshot(seedData, field) {
  const snapshot = ensureObject(seedData.snapshot);
  let deleted = false;
  if (Object.prototype.hasOwnProperty.call(seedData, field)) {
    delete seedData[field];
    deleted = true;
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, field)) {
    delete snapshot[field];
    deleted = true;
  }
  return deleted;
}

function fieldValue(seedData, field) {
  const snapshot = ensureObject(seedData.snapshot);
  return seedData[field] ?? snapshot[field];
}

function buildMissingQualityUpdates(blocker, seedData) {
  const lengths = summarizeFieldLengths(seedData);
  const updates = [];
  if ((Number(blocker?.ingredients_len) || lengths.ingredients_len) === 0) updates.push('ingredients_raw');
  if ((Number(blocker?.active_len) || lengths.active_len) === 0) updates.push('active_ingredients_raw');
  if ((Number(blocker?.how_to_len) || lengths.how_to_len) === 0) updates.push('how_to_use_raw');
  return updates;
}

function applyStrictBlockerPatch(row, maps, now, options) {
  const seedData = cloneJson(ensureObject(row.seed_data));
  const snapshot = ensureObject(seedData.snapshot);
  seedData.snapshot = snapshot;

  const id = normalizeString(row.external_product_id);
  const blocker = maps.blockerById.get(id);
  const classification = classifyRow(row, maps);
  const before = summarizeFieldLengths(seedData);
  const fieldsDeleted = [];
  const fieldsQuarantined = [];
  const qualityUpdated = [];
  let reviewDeleted = false;

  const quality = {
    ...ensureObject(seedData.pdp_field_quality_summary || snapshot.pdp_field_quality_summary),
  };

  if (classification.unsafeSource) {
    for (const field of UNSAFE_CONTENT_FIELDS) {
      const value = fieldValue(seedData, field);
      if (addQuarantineField(seedData, field, value, classification.reasons, now, 'unsafe_source_pdp')) {
        fieldsQuarantined.push(field);
      }
      if (deleteFieldFromRootAndSnapshot(seedData, field)) fieldsDeleted.push(field);
    }
    for (const field of UNSAFE_REVIEW_FIELDS) {
      const value = fieldValue(seedData, field);
      if (addQuarantineField(seedData, field, value, classification.reasons, now, 'unsafe_source_pdp_review')) {
        fieldsQuarantined.push(field);
      }
      if (deleteFieldFromRootAndSnapshot(seedData, field)) {
        fieldsDeleted.push(field);
        reviewDeleted = true;
      }
    }
    for (const qualityKey of Object.keys(QUALITY_FIELD_TO_SEED_FIELDS)) {
      markQuality(quality, qualityKey, 'quarantined', 'unsafe_source_pdp', classification.reasons, now);
      qualityUpdated.push(qualityKey);
    }
  } else {
    const missingQualityKeys = buildMissingQualityUpdates(blocker, seedData);
    for (const qualityKey of missingQualityKeys) {
      markQuality(quality, qualityKey, 'blocked', 'official_pdp', ['official_source_field_missing_after_strict_backfill'], now);
      qualityUpdated.push(qualityKey);
    }
  }

  if (qualityUpdated.length > 0) {
    seedData.pdp_field_quality_summary = quality;
    snapshot.pdp_field_quality_summary = quality;
  }

  if (classification.unsafeSource || qualityUpdated.length > 0) {
    const marker = {
      contract_version: MARKER_VERSION,
      updated_at: now,
      unsafe_source: classification.unsafeSource,
      reason_codes: classification.reasons,
      fields_quarantined: uniqueStrings(fieldsQuarantined, 100),
      fields_deleted: uniqueStrings(fieldsDeleted, 100),
      quality_keys_updated: uniqueStrings(qualityUpdated, 30),
      review_deleted: reviewDeleted,
    };
    seedData.strict_pdp_source_blocker_v1 = marker;
    snapshot.strict_pdp_source_blocker_v1 = marker;
    seedData.snapshot = snapshot;
    ensureSnapshotContract(seedData, now);
  }

  const after = summarizeFieldLengths(seedData);
  const changed =
    classification.unsafeSource ||
    fieldsDeleted.length > 0 ||
    fieldsQuarantined.length > 0 ||
    qualityUpdated.length > 0;
  return {
    seedData,
    result: {
      external_product_id: id,
      brand: normalizeString(seedData.brand || snapshot.brand),
      title: row.title,
      domain: row.domain,
      canonical_url: row.canonical_url,
      status: changed ? (options.write ? 'updated' : 'dry_run') : 'unchanged',
      unsafe_source: classification.unsafeSource,
      reason_codes: classification.reasons,
      fields_quarantined: uniqueStrings(fieldsQuarantined, 100),
      fields_deleted: uniqueStrings(fieldsDeleted, 100),
      quality_keys_updated: uniqueStrings(qualityUpdated, 30),
      before,
      after,
    },
  };
}

async function fetchRows(ids, market) {
  const rowsById = new Map();
  const chunkSize = Math.max(1, Number(argValue('fetch-chunk-size', '5')) || 5);
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    const startedAt = Date.now();
    const res = await query(
      `
        SELECT id, external_product_id, title, domain, market, canonical_url, destination_url, seed_data
        FROM external_product_seeds
        WHERE external_product_id = ANY($1::text[])
          AND ($2::text = '' OR market = $2::text)
      `,
      [chunk, market],
    );
    for (const row of res.rows) rowsById.set(normalizeString(row.external_product_id), row);
    console.error(
      JSON.stringify({
        phase: 'fetch_rows',
        fetched: Math.min(offset + chunk.length, ids.length),
        total: ids.length,
        rows: res.rows.length,
        ms: Date.now() - startedAt,
      }),
    );
  }
  return ids.map((id) => rowsById.get(id)).filter(Boolean);
}

async function main() {
  const write = hasFlag('write');
  const market = normalizeString(argValue('market', 'US'));
  const out = normalizeString(argValue('out'));
  const now = new Date().toISOString();
  const maps = buildReportMaps();
  const explicitIds = readLinesIfExists(argValue('ids-file'));
  const ids = uniqueStrings(explicitIds.length ? explicitIds : Array.from(maps.blockerById.keys()));
  const rows = await fetchRows(ids, market);
  const foundIds = new Set(rows.map((row) => normalizeString(row.external_product_id)));
  const missingIds = ids.filter((id) => !foundIds.has(id));

  const results = [];
  for (const row of rows) {
    const patched = applyStrictBlockerPatch(row, maps, now, { write });
    results.push(patched.result);
    if (!write || patched.result.status === 'unchanged') continue;
    await query(
      `
        UPDATE external_product_seeds
        SET seed_data = $1::jsonb,
            updated_at = NOW()
        WHERE id = $2
      `,
      [JSON.stringify(patched.seedData), row.id],
    );
  }

  const summary = {
    scanned: rows.length,
    missing_ids: missingIds.length,
    dry_run: write ? 0 : results.filter((row) => row.status === 'dry_run').length,
    updated: write ? results.filter((row) => row.status === 'updated').length : 0,
    unchanged: results.filter((row) => row.status === 'unchanged').length,
    unsafe_source: results.filter((row) => row.unsafe_source).length,
    fields_deleted_total: results.reduce((sum, row) => sum + row.fields_deleted.length, 0),
    fields_quarantined_total: results.reduce((sum, row) => sum + row.fields_quarantined.length, 0),
    quality_updates_total: results.reduce((sum, row) => sum + row.quality_keys_updated.length, 0),
    by_reason: results.reduce((acc, row) => {
      for (const reason of row.reason_codes) acc[reason] = (acc[reason] || 0) + 1;
      return acc;
    }, {}),
  };
  const report = {
    generated_at: now,
    dry_run: !write,
    market,
    summary,
    missing_ids: missingIds,
    results,
  };

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
