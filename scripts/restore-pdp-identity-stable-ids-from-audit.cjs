#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
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

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let idx = 0; idx < line.length; idx += 1) {
    const char = line[idx];
    const next = line[idx + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        idx += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((header) => normalizeString(header));
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] == null ? '' : values[idx];
    });
    return row;
  });
}

function reviewFamilyFromProductLine(productLineId) {
  const normalized = normalizeString(productLineId);
  if (!/^pl_[a-f0-9]{8,}$/i.test(normalized)) return '';
  return `rf_${normalized.slice(3)}`;
}

async function loadCurrentRows(sourceRefs) {
  if (!sourceRefs.length) return new Map();
  const result = await query(
    `
      SELECT
        source_listing_ref,
        sellable_item_group_id,
        product_line_id,
        review_family_id,
        live_read_enabled,
        identity_status,
        review_required,
        updated_at
      FROM pdp_identity_listing
      WHERE source_listing_ref = ANY($1::text[])
    `,
    [sourceRefs],
  );
  return new Map((result.rows || []).map((row) => [row.source_listing_ref, row]));
}

async function applyRestores(candidates) {
  let updatedRows = 0;
  const errors = [];
  for (const candidate of candidates) {
    try {
      const result = await query(
        `
          UPDATE pdp_identity_listing
          SET
            sellable_item_group_id = $2,
            product_line_id = $3,
            review_family_id = $4,
            updated_at = now()
          WHERE source_listing_ref = $1
            AND (
              sellable_item_group_id IS DISTINCT FROM $2
              OR product_line_id IS DISTINCT FROM $3
              OR review_family_id IS DISTINCT FROM $4
            )
        `,
        [
          candidate.source_listing_ref,
          candidate.previous_sellable_item_group_id,
          candidate.previous_product_line_id,
          candidate.previous_review_family_id,
        ],
      );
      updatedRows += Number(result.rowCount || 0);
    } catch (error) {
      errors.push({
        source_listing_ref: candidate.source_listing_ref,
        error: error?.message || String(error),
      });
    }
  }
  return { updated_rows: updatedRows, failed_rows: errors.length, errors };
}

async function main() {
  const auditCsv = normalizeString(argValue('audit-csv') || argValue('auditCsv'));
  const out = normalizeString(argValue('out'));
  const domain = normalizeString(argValue('domain')).toLowerCase();
  const refsFilter = new Set(
    uniqueStrings(
      normalizeString(argValue('source-listing-refs') || argValue('sourceListingRefs'))
        .split(',')
        .map((item) => item.trim()),
    ),
  );
  const dryRun = !hasFlag('write');
  if (!auditCsv) throw new Error('Missing --audit-csv');

  const auditRows = readCsv(auditCsv)
    .filter((row) => normalizeString(row.identity_exists).toLowerCase() === 'true')
    .filter((row) => !domain || normalizeString(row.domain).toLowerCase() === domain)
    .filter((row) => {
      const ref = normalizeString(row.source_listing_ref);
      return !refsFilter.size || refsFilter.has(ref);
    })
    .map((row) => ({
      source_listing_ref: normalizeString(row.source_listing_ref),
      external_product_id: normalizeString(row.external_product_id),
      title: normalizeString(row.title),
      previous_sellable_item_group_id: normalizeString(row.sellable_item_group_id),
      previous_product_line_id: normalizeString(row.product_line_id),
      previous_review_family_id: reviewFamilyFromProductLine(row.product_line_id),
    }))
    .filter(
      (row) =>
        row.source_listing_ref &&
        /^sig_[a-f0-9]+$/i.test(row.previous_sellable_item_group_id) &&
        /^pl_[a-f0-9]+$/i.test(row.previous_product_line_id) &&
        /^rf_[a-f0-9]+$/i.test(row.previous_review_family_id),
    );

  const currentRows = await loadCurrentRows(auditRows.map((row) => row.source_listing_ref));
  const candidates = auditRows
    .map((row) => {
      const current = currentRows.get(row.source_listing_ref);
      return {
        ...row,
        current_exists: Boolean(current),
        current_sellable_item_group_id: normalizeString(current?.sellable_item_group_id),
        current_product_line_id: normalizeString(current?.product_line_id),
        current_review_family_id: normalizeString(current?.review_family_id),
        current_live_read_enabled: current?.live_read_enabled === true,
        current_identity_status: normalizeString(current?.identity_status),
        current_review_required: current?.review_required === true,
      };
    })
    .filter(
      (row) =>
        row.current_exists &&
        (row.current_sellable_item_group_id !== row.previous_sellable_item_group_id ||
          row.current_product_line_id !== row.previous_product_line_id ||
          row.current_review_family_id !== row.previous_review_family_id),
    );

  const applyResult = dryRun ? { updated_rows: 0, failed_rows: 0, errors: [] } : await applyRestores(candidates);
  const report = {
    ok: true,
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    audit_csv: auditCsv,
    filters: {
      domain: domain || null,
      source_listing_refs: refsFilter.size ? Array.from(refsFilter) : null,
    },
    audit_rows_considered: auditRows.length,
    candidates_count: candidates.length,
    updated_rows: applyResult.updated_rows,
    failed_rows: applyResult.failed_rows,
    errors: applyResult.errors,
    candidates,
  };

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dry_run: dryRun,
    audit_rows_considered: auditRows.length,
    candidates_count: candidates.length,
    updated_rows: applyResult.updated_rows,
    failed_rows: applyResult.failed_rows,
    out: out || null,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify(
          {
            ok: false,
            error: 'RESTORE_PDP_IDENTITY_STABLE_IDS_FAILED',
            message: error?.message || String(error),
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
