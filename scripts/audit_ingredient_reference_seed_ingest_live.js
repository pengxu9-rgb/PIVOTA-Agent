#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { withClient } = require('../src/db');

const BOOLEAN_FLAG_COLUMNS = [
  'is_humectant',
  'is_barrier_support',
  'is_retinoid',
  'is_exfoliant',
  'is_uv_filter',
  'is_preservative',
  'is_surfactant',
  'is_fragrance_or_eo',
];

const REQUIRED_FIELDS = [
  'record_id',
  'canonical_inci_name',
  'normalized_key',
  'parser_variants',
  'source_urls',
  'source_file',
  'source_sheet',
  'source_row_number',
  'ingested_at',
];

const REVIEW_STATUS_ALLOWED = new Set(['draft', 'reviewed', 'approved', 'deprecated']);
const CONFIDENCE_ALLOWED = new Set(['high', 'medium', 'low']);
const PRIMARY_BUCKET_ALLOWED = new Set([
  'hydration',
  'repair',
  'anti-aging',
  'anti-acne',
  'exfoliant',
  'sunscreen',
  'preservative',
  'surfactant',
  'fragrance/essential oil',
]);
const INGREDIENT_FAMILY_ALLOWED = new Set([
  'humectant',
  'emollient',
  'occlusive',
  'ceramide',
  'peptide',
  'retinoid',
  'acid_exfoliant',
  'uv_filter',
  'preservative',
  'surfactant',
  'fragrance',
  'plant_extract',
  'solvent',
  'vitamin',
  'other',
]);

function parseArgs(argv) {
  const out = {
    table: 'seed_ingest.ingredient_reference_seed',
    out_json: '',
    fail_on_audit: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--table' && next) {
      out.table = next;
      i += 1;
      continue;
    }
    if (token === '--out-json' && next) {
      out.out_json = next;
      i += 1;
      continue;
    }
    if (token === '--fail-on-audit') {
      out.fail_on_audit = true;
      continue;
    }
  }
  return out;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function splitQualifiedTableName(input) {
  const raw = normalizeText(input);
  const parts = raw.split('.');
  if (parts.length !== 2) {
    throw new Error(`invalid_table:${raw}`);
  }
  return { schema: parts[0], table: parts[1] };
}

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function qualifyTable(schemaName, tableName) {
  return `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
}

function missingExpr(columnName) {
  return `NULLIF(BTRIM(COALESCE(${quoteIdent(columnName)}::text, '')), '') IS NULL`;
}

async function scalar(client, sql, params = []) {
  const res = await client.query(sql, params);
  const row = res.rows[0] || {};
  const value = row.count ?? Object.values(row)[0];
  return Number(value || 0);
}

async function groupedCounts(client, tableRef, columnName) {
  const res = await client.query(
    `
      SELECT LOWER(BTRIM(COALESCE(${quoteIdent(columnName)}::text, ''))) AS value, COUNT(*)::int AS count
      FROM ${tableRef}
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC
    `,
  );
  return res.rows.map((row) => ({
    value: normalizeText(row.value),
    count: Number(row.count || 0),
  }));
}

function summarizeAllowed(grouped, allowedValues) {
  const unexpected = grouped.filter((row) => row.value && !allowedValues.has(row.value));
  return {
    allowed_values: Array.from(allowedValues),
    counts: grouped,
    unexpected_count: unexpected.reduce((sum, row) => sum + row.count, 0),
    unexpected_values: unexpected,
  };
}

function summarizeBoolean(grouped) {
  return summarizeAllowed(grouped, new Set(['yes', 'no']));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { schema, table } = splitQualifiedTableName(args.table);
  const tableRef = qualifyTable(schema, table);

  const payload = {
    target_table: `${schema}.${table}`,
    db_configured: Boolean(process.env.DATABASE_URL),
    table_exists: false,
    row_count: 0,
    duplicate_counts: {},
    missing_required_counts: {},
    controlled_value_checks: {},
    consistency_warnings: {},
    audit_ok: false,
    blocking_issues: [],
    warning_issues: [],
  };

  if (!process.env.DATABASE_URL) {
    payload.reason = 'DATABASE_URL not configured';
    const rendered = JSON.stringify(payload, null, 2);
    if (args.out_json) fs.writeFileSync(path.resolve(args.out_json), rendered + '\n');
    console.log(rendered);
    return;
  }

  await withClient(async (client) => {
    const existsRes = await client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = $2
        ) AS exists
      `,
      [schema, table],
    );
    payload.table_exists = Boolean(existsRes.rows[0] && existsRes.rows[0].exists);
    if (!payload.table_exists) {
      payload.reason = 'target_table_missing';
      return;
    }

    payload.row_count = await scalar(client, `SELECT COUNT(*)::int AS count FROM ${tableRef}`);
    payload.duplicate_counts.record_id = await scalar(
      client,
      `SELECT COUNT(*)::int AS count FROM (SELECT record_id FROM ${tableRef} GROUP BY 1 HAVING COUNT(*) > 1) t`,
    );
    payload.duplicate_counts.normalized_key = await scalar(
      client,
      `SELECT COUNT(*)::int AS count FROM (SELECT normalized_key FROM ${tableRef} WHERE NOT ${missingExpr('normalized_key')} GROUP BY 1 HAVING COUNT(*) > 1) t`,
    );
    payload.duplicate_counts.canonical_inci_name = await scalar(
      client,
      `SELECT COUNT(*)::int AS count FROM (SELECT canonical_inci_name FROM ${tableRef} WHERE NOT ${missingExpr('canonical_inci_name')} GROUP BY 1 HAVING COUNT(*) > 1) t`,
    );

    for (const field of REQUIRED_FIELDS) {
      payload.missing_required_counts[field] = await scalar(
        client,
        `SELECT COUNT(*)::int AS count FROM ${tableRef} WHERE ${missingExpr(field)}`,
      );
    }

    payload.controlled_value_checks.review_status = summarizeAllowed(
      await groupedCounts(client, tableRef, 'review_status'),
      REVIEW_STATUS_ALLOWED,
    );
    payload.controlled_value_checks.confidence = summarizeAllowed(
      await groupedCounts(client, tableRef, 'confidence'),
      CONFIDENCE_ALLOWED,
    );
    payload.controlled_value_checks.primary_bucket = summarizeAllowed(
      await groupedCounts(client, tableRef, 'primary_bucket'),
      PRIMARY_BUCKET_ALLOWED,
    );
    payload.controlled_value_checks.ingredient_family = summarizeAllowed(
      await groupedCounts(client, tableRef, 'ingredient_family'),
      INGREDIENT_FAMILY_ALLOWED,
    );

    payload.controlled_value_checks.boolean_flags = {};
    for (const field of BOOLEAN_FLAG_COLUMNS) {
      payload.controlled_value_checks.boolean_flags[field] = summarizeBoolean(
        await groupedCounts(client, tableRef, field),
      );
    }

    payload.consistency_warnings.barrier_support_without_repair_signal_count = await scalar(
      client,
      `
        SELECT COUNT(*)::int AS count
        FROM ${tableRef}
        WHERE LOWER(BTRIM(COALESCE(is_barrier_support::text, ''))) = 'yes'
          AND LOWER(COALESCE(primary_bucket::text, '')) <> 'repair'
          AND LOWER(COALESCE(all_buckets::text, '')) NOT LIKE '%repair%'
          AND LOWER(COALESCE(function_tags::text, '')) NOT LIKE '%barrier%'
          AND LOWER(COALESCE(benefit_tags::text, '')) NOT LIKE '%barrier%'
      `,
    );
    payload.consistency_warnings.uv_filter_without_sunscreen_signal_count = await scalar(
      client,
      `
        SELECT COUNT(*)::int AS count
        FROM ${tableRef}
        WHERE LOWER(BTRIM(COALESCE(is_uv_filter::text, ''))) = 'yes'
          AND LOWER(COALESCE(primary_bucket::text, '')) <> 'sunscreen'
          AND LOWER(COALESCE(all_buckets::text, '')) NOT LIKE '%sunscreen%'
      `,
    );
    payload.consistency_warnings.fragrance_eo_without_fragrance_signal_count = await scalar(
      client,
      `
        SELECT COUNT(*)::int AS count
        FROM ${tableRef}
        WHERE LOWER(BTRIM(COALESCE(is_fragrance_or_eo::text, ''))) = 'yes'
          AND LOWER(COALESCE(primary_bucket::text, '')) <> 'fragrance/essential oil'
          AND LOWER(COALESCE(all_buckets::text, '')) NOT LIKE '%fragrance%'
          AND LOWER(COALESCE(all_buckets::text, '')) NOT LIKE '%essential oil%'
          AND LOWER(COALESCE(risk_flags::text, '')) NOT LIKE '%fragrance%'
          AND LOWER(COALESCE(risk_flags::text, '')) NOT LIKE '%essential oil%'
      `,
    );
  });

  if (!payload.table_exists) {
    payload.blocking_issues.push(payload.reason || 'target_table_missing');
  }

  if (payload.row_count === 0) {
    payload.blocking_issues.push('row_count_zero');
  }

  for (const [field, count] of Object.entries(payload.duplicate_counts)) {
    if (Number(count || 0) > 0) {
      payload.blocking_issues.push(`duplicate_${field}`);
    }
  }

  for (const [field, count] of Object.entries(payload.missing_required_counts)) {
    if (Number(count || 0) > 0) {
      payload.blocking_issues.push(`missing_required_${field}`);
    }
  }

  for (const field of ['review_status', 'confidence', 'primary_bucket', 'ingredient_family']) {
    const unexpectedCount = Number(
      payload.controlled_value_checks[field] && payload.controlled_value_checks[field].unexpected_count,
    );
    if (unexpectedCount > 0) {
      payload.blocking_issues.push(`unexpected_${field}`);
    }
  }

  for (const [field, summary] of Object.entries(payload.controlled_value_checks.boolean_flags || {})) {
    if (Number(summary.unexpected_count || 0) > 0) {
      payload.blocking_issues.push(`unexpected_${field}`);
    }
  }

  for (const [field, count] of Object.entries(payload.consistency_warnings)) {
    if (Number(count || 0) > 0) {
      payload.warning_issues.push(field);
    }
  }

  payload.audit_ok = payload.blocking_issues.length === 0;

  const rendered = JSON.stringify(payload, null, 2);
  if (args.out_json) fs.writeFileSync(path.resolve(args.out_json), rendered + '\n');
  console.log(rendered);
  if (args.fail_on_audit && !payload.audit_ok) process.exitCode = 1;
}

main().catch((err) => {
  const message = String(err && err.message ? err.message : err || 'unknown_error');
  console.error(message);
  process.exit(1);
});
