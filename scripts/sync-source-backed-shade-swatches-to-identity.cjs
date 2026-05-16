#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const {
  isTrustedSourceBackedShadeTextureUrl,
  normalizeHexColor,
  parseCsv,
} = require('./backfill-source-backed-shade-swatches.cjs');

const DEFAULT_INPUT =
  'reports/source_backed_shade_swatch_backfill_20260516_apply/source_backed_shade_swatch_backfill_candidates.csv';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function todayStamp() {
  const now = new Date();
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function asString(value) {
  return String(value || '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeShadeToken(value) {
  return asString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function extractVariantShade(variant) {
  for (const option of asArray(variant?.options)) {
    const name = asString(option?.name).toLowerCase();
    if (['shade', 'color', 'colour', 'tone', 'hue'].includes(name)) return asString(option?.value);
  }
  return asString(variant?.shade_name || variant?.shade || variant?.title || variant?.option_value);
}

function csvEscape(value) {
  const text = value === undefined || value === null
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function parseVisualEntries(row) {
  const entries = [];
  try {
    const parsed = JSON.parse(asString(row.visuals_by_shade) || '[]');
    for (const item of asArray(parsed)) {
      entries.push({
        shade_key: normalizeShadeToken(item.shade_key || item.shade_name),
        shade_name: asString(item.shade_name || item.shade_key),
        swatch_image_url: asString(item.swatch_image_url),
        shade_hex: normalizeHexColor(item.shade_hex),
      });
    }
  } catch {
    // Fall back to flat fields below.
  }

  if (!entries.length && (row.swatch_image_url || row.shade_hex)) {
    const shadeName = asString(row.shade_names).split('|').find(Boolean) || '';
    entries.push({
      shade_key: normalizeShadeToken(shadeName),
      shade_name: shadeName,
      swatch_image_url: asString(row.swatch_image_url),
      shade_hex: normalizeHexColor(row.shade_hex),
    });
  }

  return entries
    .filter((entry) => entry.shade_key && (entry.swatch_image_url || entry.shade_hex))
    .filter((entry) => {
      if (!entry.swatch_image_url) return true;
      return isTrustedSourceBackedShadeTextureUrl(entry.swatch_image_url, entry.shade_name);
    });
}

function loadCandidateMap(inputFile) {
  const rows = parseCsv(fs.readFileSync(inputFile, 'utf8'));
  const byExternalId = new Map();
  for (const row of rows) {
    const externalProductId = asString(row.external_product_id);
    if (!externalProductId) continue;
    const visuals = parseVisualEntries(row);
    if (!visuals.length) continue;
    byExternalId.set(externalProductId, {
      external_product_id: externalProductId,
      seed_id: asString(row.seed_id),
      title: asString(row.title),
      visuals,
    });
  }
  return byExternalId;
}

function visualFieldsFor(target, visual) {
  return {
    ...target,
    ...(visual.swatch_image_url
      ? {
          swatch_image_url: visual.swatch_image_url,
          label_image_url: visual.swatch_image_url,
        }
      : {}),
    ...(visual.shade_hex
      ? {
          swatch_color: visual.shade_hex,
          color_hex: visual.shade_hex,
          shade_hex: visual.shade_hex,
          swatch: { ...asObject(target.swatch), hex: visual.shade_hex },
        }
      : {}),
    source_quality_status: 'captured',
  };
}

function patchVariantVisuals(variants, visuals) {
  const byShade = new Map(visuals.map((visual) => [visual.shade_key, visual]));
  const soleVisual = visuals.length === 1 ? visuals[0] : null;
  return asArray(variants).map((variant) => {
    const source = asObject(variant);
    const shadeKey = normalizeShadeToken(extractVariantShade(source));
    const visual = byShade.get(shadeKey) || (variants.length === 1 ? soleVisual : null);
    return visual ? visualFieldsFor(source, visual) : source;
  });
}

function patchIdentityPayloadVisuals(sourcePayload, visuals, appliedAt = new Date().toISOString()) {
  const payload = JSON.parse(JSON.stringify(asObject(sourcePayload)));
  const soleVisual = visuals.length === 1 ? visuals[0] : null;
  if (soleVisual) Object.assign(payload, visualFieldsFor(payload, soleVisual));
  if (Array.isArray(payload.variants)) payload.variants = patchVariantVisuals(payload.variants, visuals);
  payload.diagnostics = {
    ...asObject(payload.diagnostics),
    shade_swatch_identity_sync: {
      applied: true,
      source: 'source_backed_external_seed_visual_fields',
      applied_at: appliedAt,
      visual_count: visuals.length,
      visuals_by_shade: visuals,
    },
  };
  return payload;
}

async function loadRows(externalProductIds, market) {
  if (!externalProductIds.length) return [];
  const params = [externalProductIds];
  let marketClause = '';
  if (market) {
    params.push(market);
    marketClause = `AND upper(eps.market) = upper($${params.length})`;
  }
  const res = await query(
    `
      SELECT
        eps.external_product_id,
        eps.market,
        eps.title AS seed_title,
        pil.source_listing_ref,
        pil.product_id,
        pil.merchant_id,
        pil.identity_status,
        pil.review_required,
        pil.live_read_enabled,
        pil.source_payload
      FROM external_product_seeds eps
      JOIN pdp_identity_listing pil
        ON pil.source_listing_ref = 'external_seed:' || eps.external_product_id
      WHERE eps.external_product_id = ANY($1::text[])
        ${marketClause}
      ORDER BY eps.external_product_id
    `,
    params,
  );
  return res.rows || [];
}

async function main() {
  const inputFile = argValue('input', DEFAULT_INPUT);
  const outDir = argValue('out-dir', path.join('reports', `source_backed_shade_swatch_identity_sync_${todayStamp()}`));
  const market = asString(argValue('market', 'US')).toUpperCase();
  const apply = hasFlag('apply');
  const appliedAt = new Date().toISOString();

  fs.mkdirSync(outDir, { recursive: true });
  const candidateMap = loadCandidateMap(inputFile);
  const rows = await loadRows(Array.from(candidateMap.keys()), market);
  const candidates = [];
  const blockers = [];
  let updated = 0;

  for (const row of rows) {
    const candidate = candidateMap.get(asString(row.external_product_id));
    const base = {
      external_product_id: row.external_product_id,
      source_listing_ref: row.source_listing_ref,
      sig_product_id: row.product_id,
      merchant_id: row.merchant_id,
      market: row.market,
      title: candidate?.title || row.seed_title || '',
      identity_status: row.identity_status,
      review_required: row.review_required === true ? 'true' : 'false',
      live_read_enabled: row.live_read_enabled === true ? 'true' : 'false',
      visual_count: candidate?.visuals?.length || 0,
    };
    if (!candidate?.visuals?.length) {
      blockers.push({ ...base, blocker_reason: 'missing_reviewed_visual_candidate' });
      continue;
    }
    const nextPayload = patchIdentityPayloadVisuals(row.source_payload, candidate.visuals, appliedAt);
    const changed = JSON.stringify(asObject(row.source_payload)) !== JSON.stringify(nextPayload);
    candidates.push({
      ...base,
      action: apply && changed ? 'updated' : changed ? 'dry_run' : 'unchanged',
      visuals_by_shade: JSON.stringify(candidate.visuals),
    });
    if (apply && changed) {
      const res = await query(
        `
          UPDATE pdp_identity_listing
          SET source_payload = $2::jsonb, updated_at = now()
          WHERE source_listing_ref = $1
            AND source_payload IS DISTINCT FROM $2::jsonb
        `,
        [row.source_listing_ref, JSON.stringify(nextPayload)],
      );
      updated += Number(res.rowCount || 0);
    }
  }

  for (const externalProductId of candidateMap.keys()) {
    if (!rows.some((row) => row.external_product_id === externalProductId)) {
      blockers.push({
        external_product_id: externalProductId,
        blocker_reason: 'missing_identity_listing',
      });
    }
  }

  const candidateColumns = [
    'external_product_id',
    'source_listing_ref',
    'sig_product_id',
    'merchant_id',
    'market',
    'title',
    'identity_status',
    'review_required',
    'live_read_enabled',
    'visual_count',
    'action',
    'visuals_by_shade',
  ];
  const blockerColumns = [
    'external_product_id',
    'source_listing_ref',
    'sig_product_id',
    'merchant_id',
    'market',
    'title',
    'blocker_reason',
  ];
  writeCsv(path.join(outDir, 'identity_swatch_sync_candidates.csv'), candidates, candidateColumns);
  writeCsv(path.join(outDir, 'identity_swatch_sync_blockers.csv'), blockers, blockerColumns);
  const summary = {
    generated_at: appliedAt,
    mode: apply ? 'apply' : 'dry_run',
    market,
    input_file: inputFile,
    reviewed_candidate_count: candidateMap.size,
    loaded_identity_count: rows.length,
    candidate_count: candidates.length,
    blocker_count: blockers.length,
    updated_count: updated,
    report_files: {
      candidates_csv: path.join(outDir, 'identity_swatch_sync_candidates.csv'),
      blockers_csv: path.join(outDir, 'identity_swatch_sync_blockers.csv'),
    },
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => {}));
}

module.exports = {
  loadCandidateMap,
  parseVisualEntries,
  patchIdentityPayloadVisuals,
};
