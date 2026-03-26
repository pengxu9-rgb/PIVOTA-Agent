#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { withClient } = require('../src/db');

function parseArgs(argv) {
  const out = {
    bundle_manifest_json: '',
    batch_size: 100,
    out_json: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--bundle-manifest-json' && next) {
      out.bundle_manifest_json = next;
      i += 1;
      continue;
    }
    if (token === '--batch-size' && next) {
      out.batch_size = Number(next);
      i += 1;
      continue;
    }
    if (token === '--out-json' && next) {
      out.out_json = next;
      i += 1;
      continue;
    }
  }
  if (!out.bundle_manifest_json) {
    throw new Error('missing_required_arg:--bundle-manifest-json');
  }
  if (!Number.isFinite(out.batch_size) || out.batch_size < 1) {
    throw new Error(`invalid_batch_size:${out.batch_size}`);
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

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function qualifyTable(schemaName, tableName) {
  return `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let index = 0;
  let inQuotes = false;

  while (index < text.length) {
    const ch = text[index];
    if (inQuotes) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += ch;
      index += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }
    if (ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += text[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    index += 1;
  }

  if (inQuotes) {
    throw new Error('csv_parse_error:unterminated_quote');
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function loadBundle(bundleManifestPath) {
  const manifestPath = path.resolve(bundleManifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const csvPath = path.resolve(manifest.out_csv || '');
  if (!csvPath) {
    throw new Error('bundle_manifest_missing:out_csv');
  }
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsvText(csvText);
  if (!rows.length) {
    throw new Error('bundle_csv_empty');
  }

  const header = rows[0];
  const dataRows = rows.slice(1);
  const expectedHeader = Array.isArray(manifest.exported_columns) ? manifest.exported_columns : [];
  if (header.length !== expectedHeader.length) {
    throw new Error(`bundle_header_length_mismatch:${header.length}:${expectedHeader.length}`);
  }
  for (let i = 0; i < expectedHeader.length; i += 1) {
    if (header[i] !== expectedHeader[i]) {
      throw new Error(`bundle_header_mismatch:${i}:${header[i]}:${expectedHeader[i]}`);
    }
  }
  if (Number(manifest.row_count || 0) !== dataRows.length) {
    throw new Error(`bundle_row_count_mismatch:${dataRows.length}:${manifest.row_count}`);
  }
  for (let i = 0; i < dataRows.length; i += 1) {
    if (dataRows[i].length !== header.length) {
      throw new Error(`bundle_row_width_mismatch:${i + 2}:${dataRows[i].length}:${header.length}`);
    }
  }

  return {
    manifestPath,
    manifest,
    csvPath,
    header,
    dataRows,
  };
}

function buildInsertStatement(schemaName, tableName, columns, rowCount) {
  const qualifiedTable = qualifyTable(schemaName, tableName);
  const columnSql = columns.map((column) => quoteIdent(column)).join(', ');
  const valuesSql = [];
  let paramIndex = 1;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const placeholderSql = columns.map(() => `$${paramIndex++}`).join(', ');
    valuesSql.push(`(${placeholderSql})`);
  }
  return `INSERT INTO ${qualifiedTable} (${columnSql}) VALUES ${valuesSql.join(', ')}`;
}

async function scalar(client, sql, params = []) {
  const res = await client.query(sql, params);
  const row = res.rows[0] || {};
  const value = row.count ?? Object.values(row)[0];
  return Number(value || 0);
}

async function importBundle({ manifestPath, manifest, header, dataRows, batchSize }) {
  const { schema, table } = splitQualifiedTableName(manifest.target_table);
  const qualifiedTable = qualifyTable(schema, table);

  const payload = {
    bundle_manifest_json: manifestPath,
    bundle_csv: path.resolve(manifest.out_csv || ''),
    target_table: manifest.target_table,
    batch_size: batchSize,
    db_configured: Boolean(process.env.DATABASE_URL),
    import_mode: 'truncate_then_insert',
    manifest_row_count: Number(manifest.row_count || 0),
    imported_row_count: 0,
    row_count_before: null,
    row_count_after: null,
    batches_executed: 0,
    import_ok: false,
  };

  if (!process.env.DATABASE_URL) {
    payload.reason = 'DATABASE_URL not configured';
    return payload;
  }

  await withClient(async (client) => {
    payload.row_count_before = await scalar(client, `SELECT COUNT(*)::int AS count FROM ${qualifiedTable}`);
    await client.query('BEGIN');
    try {
      await client.query(`TRUNCATE TABLE ${qualifiedTable}`);
      for (let start = 0; start < dataRows.length; start += batchSize) {
        const batchRows = dataRows.slice(start, start + batchSize);
        const sql = buildInsertStatement(schema, table, header, batchRows.length);
        const params = [];
        for (const row of batchRows) {
          for (const value of row) {
            params.push(value);
          }
        }
        await client.query(sql, params);
        payload.imported_row_count += batchRows.length;
        payload.batches_executed += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    payload.row_count_after = await scalar(client, `SELECT COUNT(*)::int AS count FROM ${qualifiedTable}`);
  });

  payload.import_ok = payload.imported_row_count === dataRows.length && payload.row_count_after === dataRows.length;
  if (!payload.import_ok) {
    payload.reason = 'post_import_row_count_mismatch';
  }
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundle = loadBundle(args.bundle_manifest_json);
  const payload = await importBundle({
    manifestPath: bundle.manifestPath,
    manifest: bundle.manifest,
    header: bundle.header,
    dataRows: bundle.dataRows,
    batchSize: args.batch_size,
  });
  const rendered = JSON.stringify(payload, null, 2);
  if (args.out_json) {
    fs.writeFileSync(path.resolve(args.out_json), rendered + '\n');
  }
  console.log(rendered);
  if (!payload.import_ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    const message = String(err && err.message ? err.message : err || 'unknown_error');
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  buildInsertStatement,
  loadBundle,
  parseCsvText,
  parseArgs,
  splitQualifiedTableName,
};
