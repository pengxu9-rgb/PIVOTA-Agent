#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { withClient } = require('../src/db');

function parseArgs(argv) {
  const out = {
    bundle_manifest_json: '',
    out_json: '',
    fail_on_mismatch: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--bundle-manifest-json' && next) {
      out.bundle_manifest_json = next;
      i += 1;
      continue;
    }
    if (token === '--out-json' && next) {
      out.out_json = next;
      i += 1;
      continue;
    }
    if (token === '--fail-on-mismatch') {
      out.fail_on_mismatch = true;
      continue;
    }
  }
  if (!out.bundle_manifest_json) {
    throw new Error('missing_required_arg:--bundle-manifest-json');
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
    throw new Error(`invalid_target_table:${raw}`);
  }
  return { schema: parts[0], table: parts[1] };
}

function hasCoveringIndex(indexRows, columnName) {
  const needle = `(${String(columnName).toLowerCase()})`;
  return indexRows.some((row) => String(row.indexdef || '').toLowerCase().includes(needle));
}

async function inspectTable(schemaName, tableName) {
  return withClient(async (client) => {
    const existsRes = await client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = $2
        ) AS exists
      `,
      [schemaName, tableName],
    );
    const tableExists = Boolean(existsRes.rows[0] && existsRes.rows[0].exists);
    if (!tableExists) {
      return { table_exists: false, columns: [], indexes: [] };
    }

    const columnsRes = await client.query(
      `
        SELECT
          column_name,
          ordinal_position,
          data_type,
          udt_name,
          is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
        ORDER BY ordinal_position
      `,
      [schemaName, tableName],
    );

    const indexesRes = await client.query(
      `
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = $1
          AND tablename = $2
        ORDER BY indexname
      `,
      [schemaName, tableName],
    );

    return {
      table_exists: true,
      columns: columnsRes.rows,
      indexes: indexesRes.rows,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(args.bundle_manifest_json);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { schema, table } = splitQualifiedTableName(manifest.target_table);

  const payload = {
    bundle_manifest_json: manifestPath,
    target_table: manifest.target_table,
    db_configured: Boolean(process.env.DATABASE_URL),
    table_exists: false,
    copy_ready: false,
    manifest_column_count: Array.isArray(manifest.exported_columns) ? manifest.exported_columns.length : 0,
    db_column_count: 0,
    missing_in_db: [],
    extra_in_db: [],
    recommended_key_checks: {
      primary_key_columns_present: [],
      secondary_indexes_present: [],
    },
    indexes: [],
  };

  if (!process.env.DATABASE_URL) {
    payload.reason = 'DATABASE_URL not configured';
    const rendered = JSON.stringify(payload, null, 2);
    if (args.out_json) fs.writeFileSync(path.resolve(args.out_json), `${rendered}\n`);
    console.log(rendered);
    return;
  }

  let inspection;
  try {
    inspection = await inspectTable(schema, table);
  } catch (err) {
    payload.reason = String(err && err.message ? err.message : err || 'db_inspection_failed');
    const rendered = JSON.stringify(payload, null, 2);
    if (args.out_json) fs.writeFileSync(path.resolve(args.out_json), `${rendered}\n`);
    console.log(rendered);
    if (args.fail_on_mismatch) process.exitCode = 1;
    return;
  }

  payload.table_exists = inspection.table_exists;
  payload.db_column_count = inspection.columns.length;
  payload.indexes = inspection.indexes;

  if (!inspection.table_exists) {
    payload.reason = 'target_table_missing';
    const rendered = JSON.stringify(payload, null, 2);
    if (args.out_json) fs.writeFileSync(path.resolve(args.out_json), `${rendered}\n`);
    console.log(rendered);
    if (args.fail_on_mismatch) process.exitCode = 1;
    return;
  }

  const manifestColumns = Array.isArray(manifest.exported_columns) ? manifest.exported_columns.map(normalizeText) : [];
  const dbColumns = inspection.columns.map((row) => normalizeText(row.column_name));
  const dbColumnSet = new Set(dbColumns);
  const manifestColumnSet = new Set(manifestColumns);

  payload.missing_in_db = manifestColumns.filter((column) => !dbColumnSet.has(column));
  payload.extra_in_db = dbColumns.filter((column) => !manifestColumnSet.has(column));
  payload.recommended_key_checks.primary_key_columns_present = (manifest.recommended_primary_key || []).filter((column) =>
    dbColumnSet.has(column),
  );
  payload.recommended_key_checks.secondary_indexes_present = (manifest.recommended_secondary_indexes || []).filter((column) =>
    hasCoveringIndex(inspection.indexes, column),
  );
  payload.copy_ready = payload.missing_in_db.length === 0;

  const rendered = JSON.stringify(payload, null, 2);
  if (args.out_json) fs.writeFileSync(path.resolve(args.out_json), `${rendered}\n`);
  console.log(rendered);
  if (args.fail_on_mismatch && !payload.copy_ready) process.exitCode = 1;
}

main().catch((err) => {
  const message = String(err && err.message ? err.message : err || 'unknown_error');
  console.error(message);
  process.exit(1);
});
