#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const {
  buildIdentityListingSourcePayload,
} = require('./backfill-external-product-seeds-catalog');
const {
  buildPayloadDiff,
  classifyIdentityPayloadDrift,
  normalizeString,
} = require('../src/services/pdpIdentityPayloadDrift');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function readIdsFile(filePath) {
  const normalized = normalizeString(filePath);
  if (!normalized) return [];
  return fs
    .readFileSync(normalized, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function uniqueStrings(values, limit = 10000) {
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

function parseCursor(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  const [updatedAt, id] = normalized.split('|');
  if (!normalizeString(updatedAt) || !normalizeString(id)) return null;
  return { updatedAt: normalizeString(updatedAt), id: normalizeString(id) };
}

function buildCursor(row) {
  if (!row?.updated_at || !row?.id) return '';
  const updatedAt =
    row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : normalizeString(row.updated_at);
  return updatedAt && row.id ? `${updatedAt}|${row.id}` : '';
}

function csvEscape(value) {
  if (value == null) return '';
  const text = Array.isArray(value) ? value.join('|') : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows, columns) {
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

async function loadSeedRows({ ids, market, domain, brand, updatedSince, cursor, limit }) {
  const params = [];
  const where = [`status = 'active'`];
  if (ids.length) {
    params.push(ids);
    where.push(`external_product_id = ANY($${params.length}::text[])`);
  }
  if (market) {
    params.push(market);
    where.push(`upper(market) = upper($${params.length})`);
  }
  if (domain) {
    params.push(domain);
    where.push(`lower(domain) = lower($${params.length})`);
  }
  if (brand) {
    params.push(`%${brand}%`);
    where.push(`(
      seed_data->>'brand' ILIKE $${params.length}
      OR seed_data->>'vendor' ILIKE $${params.length}
      OR seed_data->>'brand_name' ILIKE $${params.length}
      OR seed_data->'snapshot'->>'brand' ILIKE $${params.length}
      OR seed_data->'snapshot'->>'vendor' ILIKE $${params.length}
      OR title ILIKE $${params.length}
    )`);
  }
  if (updatedSince) {
    params.push(updatedSince);
    where.push(`updated_at >= $${params.length}::timestamptz`);
  }
  const parsedCursor = parseCursor(cursor);
  if (parsedCursor) {
    params.push(parsedCursor.updatedAt);
    params.push(parsedCursor.id);
    where.push(`(
      updated_at < $${params.length - 1}::timestamptz
      OR (updated_at = $${params.length - 1}::timestamptz AND id < $${params.length})
    )`);
  }
  params.push(limit);
  const result = await query(
    `
      SELECT *
      FROM external_product_seeds
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $${params.length}
    `,
    params,
  );
  return result.rows || [];
}

async function loadIdentityRows(sourceRefs) {
  if (!sourceRefs.length) return new Map();
  const result = await query(
    `
      SELECT *
      FROM pdp_identity_listing
      WHERE source_listing_ref = ANY($1::text[])
    `,
    [sourceRefs],
  );
  return new Map((result.rows || []).map((row) => [row.source_listing_ref, row]));
}

function scoreAuditContent(row, useFresh = false) {
  const prefix = useFresh ? 'seed_' : 'identity_';
  let score = row.source_tier === 'brand' ? 8 : 4;
  if (row[`${prefix}has_active_evidence`] === true) score += 3;
  score += Math.min(3, Number(row[`${prefix}details_count`] || 0));
  if (Number(row[`${prefix}how_to_len`] || 0) > 0) score += 2;
  if (Number(row[`${prefix}ingredients_raw_len`] || 0) > 0) score += 2;
  if (Number(row[`${prefix}content_image_count`] || 0) > 0) score += 1;
  if (row[`${prefix}has_contract`] === true) score += 2;
  score += Number(row.identity_confidence || 0) || 0;
  return score;
}

function buildRowAudit(seedRow, identityRow, freshPayload) {
  const sourceListingRef = `external_seed:${seedRow.external_product_id}`;
  const identityPayload = identityRow?.source_payload || {};
  const diff = buildPayloadDiff(identityPayload, freshPayload, seedRow.title);
  const drift = classifyIdentityPayloadDrift({
    seedPayload: freshPayload,
    identityPayload,
    title: seedRow.title,
    seedUpdatedAt: seedRow.updated_at,
    identityUpdatedAt: identityRow?.updated_at,
  });
  return {
    external_product_id: seedRow.external_product_id,
    source_listing_ref: sourceListingRef,
    domain: seedRow.domain,
    market: seedRow.market,
    title: seedRow.title,
    canonical_url: seedRow.canonical_url,
    pdp_url: '',
    identity_exists: Boolean(identityRow),
    source_tier: identityRow?.source_tier || '',
    live_read_enabled: identityRow?.live_read_enabled === true,
    identity_status: identityRow?.identity_status || '',
    review_required: identityRow?.review_required === true,
    identity_confidence: identityRow?.identity_confidence == null ? '' : Number(identityRow.identity_confidence),
    sellable_item_group_id: identityRow?.sellable_item_group_id || '',
    product_line_id: identityRow?.product_line_id || '',
    seed_updated_at: seedRow.updated_at instanceof Date ? seedRow.updated_at.toISOString() : seedRow.updated_at,
    identity_updated_at: identityRow?.updated_at instanceof Date ? identityRow.updated_at.toISOString() : identityRow?.updated_at || '',
    seed_has_active_evidence: drift.seed_has_active_evidence,
    identity_payload_has_active_evidence: drift.identity_payload_has_active_evidence,
    seed_expects_active_ingredients: drift.seed_expects_active_ingredients,
    identity_expects_active_ingredients: drift.identity_expects_active_ingredients,
    seed_updated_after_identity: drift.seed_updated_after_identity,
    identity_payload_stale: drift.identity_payload_stale,
    canonical_selection_gap: false,
    pdp_shaping_gap: Boolean(drift.seed_has_active_evidence && !drift.identity_payload_has_active_evidence),
    audit_scope_mismatch: drift.audit_scope_mismatch,
    sig_mixed_active_expectation: false,
    sync_candidate: Boolean(identityRow && drift.identity_payload_stale && !drift.identity_summary.strict_blocker),
    changed: diff.changed,
    gained_active_evidence: diff.gained_active_evidence,
    gained_ingredients: diff.gained_ingredients,
    gained_how_to: diff.gained_how_to,
    gained_details: diff.gained_details,
    gained_content_images: diff.gained_content_images,
    contract_changed: diff.contract_changed,
    field_quality_changed: diff.field_quality_changed,
    seed_details_count: drift.seed_summary.details_count,
    identity_details_count: drift.identity_summary.details_count,
    seed_how_to_len: drift.seed_summary.how_to_len,
    identity_how_to_len: drift.identity_summary.how_to_len,
    seed_ingredients_raw_len: drift.seed_summary.ingredients_raw_len,
    identity_ingredients_raw_len: drift.identity_summary.ingredients_raw_len,
    seed_content_image_count: drift.seed_summary.content_image_count,
    identity_content_image_count: drift.identity_summary.content_image_count,
    seed_has_contract: drift.seed_summary.has_contract,
    identity_has_contract: drift.identity_summary.has_contract,
    blocker_reason: drift.identity_summary.strict_blocker ? 'strict_source_blocker' : '',
  };
}

function applySigAudit(rowAudit) {
  const bySig = new Map();
  for (const row of rowAudit) {
    const sig = row.sellable_item_group_id || `missing:${row.source_listing_ref}`;
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(row);
  }
  const sigRows = [];
  for (const [sig, rows] of bySig.entries()) {
    const sortedByIdentity = [...rows].sort((a, b) => scoreAuditContent(b, false) - scoreAuditContent(a, false));
    const sortedByFresh = [...rows].sort((a, b) => scoreAuditContent(b, true) - scoreAuditContent(a, true));
    const identityCanonical = sortedByIdentity[0] || null;
    const freshCanonical = sortedByFresh[0] || null;
    const seedActiveCount = rows.filter((row) => row.seed_has_active_evidence).length;
    const identityActiveCount = rows.filter((row) => row.identity_payload_has_active_evidence).length;
    const seedActiveExpectationCount = rows.filter((row) => row.seed_expects_active_ingredients).length;
    const mixedActive = seedActiveExpectationCount > 0 && seedActiveExpectationCount < rows.length;
    const canonicalSelectionGap = Boolean(
      seedActiveExpectationCount > 0 &&
        identityCanonical &&
        !identityCanonical.identity_payload_has_active_evidence &&
        freshCanonical?.seed_has_active_evidence,
    );
    rows.forEach((row) => {
      row.sig_mixed_active_expectation = mixedActive;
      row.canonical_selection_gap = canonicalSelectionGap;
      row.canonical_content_ref = identityCanonical?.source_listing_ref || '';
      row.selected_commerce_ref = row.source_listing_ref;
      row.pdp_url = row.sellable_item_group_id
        ? `https://agent.pivota.cc/products/${row.sellable_item_group_id}`
        : `https://agent.pivota.cc/products/${row.external_product_id}`;
    });
    sigRows.push({
      sellable_item_group_id: sig,
      product_line_id: rows.find((row) => row.product_line_id)?.product_line_id || '',
      row_count: rows.length,
      live_read_count: rows.filter((row) => row.live_read_enabled).length,
      stale_payload_count: rows.filter((row) => row.identity_payload_stale).length,
      seed_active_count: seedActiveCount,
      seed_active_expectation_count: seedActiveExpectationCount,
      identity_active_count: identityActiveCount,
      sig_mixed_active_expectation: mixedActive,
      canonical_selection_gap: canonicalSelectionGap,
      canonical_content_ref: identityCanonical?.source_listing_ref || '',
      fresh_best_content_ref: freshCanonical?.source_listing_ref || '',
      sync_candidate_count: rows.filter((row) => row.sync_candidate).length,
      sample_titles: uniqueStrings(rows.map((row) => row.title), 6).join('|'),
    });
  }
  return sigRows.sort(
    (a, b) =>
      Number(b.stale_payload_count || 0) - Number(a.stale_payload_count || 0) ||
      Number(b.row_count || 0) - Number(a.row_count || 0),
  );
}

async function main() {
  const ids = uniqueStrings([
    ...readIdsFile(argValue('external-product-ids-file')),
    ...normalizeString(argValue('external-product-ids'))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ]);
  const market = normalizeString(argValue('market')).toUpperCase();
  const domain = normalizeString(argValue('domain'));
  const brand = normalizeString(argValue('brand'));
  const updatedSince = normalizeString(argValue('updated-since') || argValue('updatedSince'));
  const cursor = normalizeString(argValue('cursor'));
  const rawLimit = Number(argValue('limit') || argValue('batch-size') || argValue('batchSize') || ids.length || 500);
  const limit = Math.max(1, Math.min(5000, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 500));
  const outDir =
    normalizeString(argValue('out-dir')) ||
    path.join('reports', `pdp_identity_payload_drift_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);

  const seedRows = await loadSeedRows({ ids, market, domain, brand, updatedSince, cursor, limit });
  const payloads = seedRows
    .map((row) => ({ row, payload: buildIdentityListingSourcePayload(row, row) }))
    .filter((item) => item.payload?.source_listing_ref && item.payload?.product);
  const identityRows = await loadIdentityRows(payloads.map((item) => item.payload.source_listing_ref));
  const rowAudit = payloads.map((item) =>
    buildRowAudit(item.row, identityRows.get(item.payload.source_listing_ref), item.payload.product),
  );
  const sigAudit = applySigAudit(rowAudit);
  const candidates = rowAudit.filter((row) => row.sync_candidate);
  const probes = rowAudit
    .filter((row) => row.identity_payload_stale || row.canonical_selection_gap || row.pdp_shaping_gap)
    .slice(0, 25)
    .map((row) => ({
      external_product_id: row.external_product_id,
      title: row.title,
      pdp_url: row.pdp_url,
      product_id_for_pdp: row.sellable_item_group_id || row.external_product_id,
      source_listing_ref: row.source_listing_ref,
      reasons: [
        row.identity_payload_stale ? 'identity_payload_stale' : '',
        row.canonical_selection_gap ? 'canonical_selection_gap' : '',
        row.audit_scope_mismatch ? 'audit_scope_mismatch' : '',
      ].filter(Boolean),
      options: { no_cache: true, cache_bypass: true },
    }));
  const summary = {
    generated_at: new Date().toISOString(),
    filters: {
      market: market || null,
      domain: domain || null,
      brand: brand || null,
      updated_since: updatedSince || null,
      cursor: cursor || null,
      limit,
    },
    scanned_seed_rows: seedRows.length,
    payloads_built: payloads.length,
    identity_rows_found: rowAudit.filter((row) => row.identity_exists).length,
    sig_groups: sigAudit.length,
    seed_active_expected_rows: rowAudit.filter((row) => row.seed_expects_active_ingredients).length,
    seed_active_evidence_rows: rowAudit.filter((row) => row.seed_has_active_evidence).length,
    identity_payload_active_rows: rowAudit.filter((row) => row.identity_payload_has_active_evidence).length,
    identity_payload_stale_rows: rowAudit.filter((row) => row.identity_payload_stale).length,
    live_read_stale_rows: rowAudit.filter((row) => row.live_read_enabled && row.identity_payload_stale).length,
    sig_mixed_active_expectation_groups: sigAudit.filter((row) => row.sig_mixed_active_expectation).length,
    canonical_selection_gap_groups: sigAudit.filter((row) => row.canonical_selection_gap).length,
    sync_candidate_rows: candidates.length,
    next_cursor: seedRows.length >= limit ? buildCursor(seedRows[seedRows.length - 1]) || null : null,
    report_files: {
      summary: path.join(outDir, 'summary.json'),
      row_audit: path.join(outDir, 'row_audit.csv'),
      sig_audit: path.join(outDir, 'sig_audit.csv'),
      sync_dry_run_candidates: path.join(outDir, 'sync_dry_run_candidates.csv'),
      no_cache_pdp_probe_samples: path.join(outDir, 'no_cache_pdp_probe_samples.json'),
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeCsv(path.join(outDir, 'row_audit.csv'), rowAudit, [
    'external_product_id',
    'source_listing_ref',
    'domain',
    'market',
    'title',
    'canonical_url',
    'pdp_url',
    'identity_exists',
    'source_tier',
    'live_read_enabled',
    'identity_status',
    'review_required',
    'identity_confidence',
    'sellable_item_group_id',
    'product_line_id',
    'seed_updated_at',
    'identity_updated_at',
    'seed_has_active_evidence',
    'identity_payload_has_active_evidence',
    'seed_expects_active_ingredients',
    'identity_expects_active_ingredients',
    'seed_updated_after_identity',
    'identity_payload_stale',
    'canonical_selection_gap',
    'pdp_shaping_gap',
    'audit_scope_mismatch',
    'sig_mixed_active_expectation',
    'canonical_content_ref',
    'selected_commerce_ref',
    'sync_candidate',
    'changed',
    'gained_active_evidence',
    'gained_ingredients',
    'gained_how_to',
    'gained_details',
    'gained_content_images',
    'contract_changed',
    'field_quality_changed',
    'blocker_reason',
  ]);
  writeCsv(path.join(outDir, 'sig_audit.csv'), sigAudit, [
    'sellable_item_group_id',
    'product_line_id',
    'row_count',
    'live_read_count',
    'stale_payload_count',
    'seed_active_count',
    'seed_active_expectation_count',
    'identity_active_count',
    'sig_mixed_active_expectation',
    'canonical_selection_gap',
    'canonical_content_ref',
    'fresh_best_content_ref',
    'sync_candidate_count',
    'sample_titles',
  ]);
  writeCsv(path.join(outDir, 'sync_dry_run_candidates.csv'), candidates, [
    'external_product_id',
    'source_listing_ref',
    'domain',
    'market',
    'title',
    'canonical_url',
    'pdp_url',
    'identity_payload_stale',
    'canonical_selection_gap',
    'audit_scope_mismatch',
    'gained_active_evidence',
    'gained_ingredients',
    'gained_how_to',
    'gained_details',
    'gained_content_images',
    'contract_changed',
    'field_quality_changed',
  ]);
  fs.writeFileSync(path.join(outDir, 'no_cache_pdp_probe_samples.json'), JSON.stringify(probes, null, 2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(
        `${JSON.stringify(
          {
            ok: false,
            error: 'PDP_IDENTITY_SOURCE_PAYLOAD_DRIFT_AUDIT_FAILED',
            message: err?.message || String(err),
          },
          null,
          2,
        )}\n`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
    });
}

module.exports = {
  parseCursor,
  buildCursor,
  loadSeedRows,
  loadIdentityRows,
  buildRowAudit,
  applySigAudit,
  main,
};
