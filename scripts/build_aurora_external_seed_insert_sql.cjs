#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = { inputPath: '', outPath: '' };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    if (token === '--input') {
      out.inputPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--out') {
      out.outPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    }
  }
  return out;
}

function normalizePath(value) {
  return String(value || '').trim();
}

function sqlString(value) {
  if (value == null) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
  return value == null || value === '' || Number.isNaN(Number(value)) ? 'NULL' : String(Number(value));
}

function buildInsertStatement(item) {
  const row = item?.seed_row && typeof item.seed_row === 'object' ? item.seed_row : {};
  const id = row.seed_id || row.id || null;
  const externalProductId = row.external_product_id || null;
  const canonicalUrl = row.canonical_url || null;
  const destinationUrl = row.destination_url || null;
  const columns = [
    'id',
    'external_product_id',
    'market',
    'tool',
    'destination_url',
    'canonical_url',
    'domain',
    'title',
    'image_url',
    'price_amount',
    'price_currency',
    'availability',
    'seed_data',
    'status',
    'attached_product_key',
    'created_at',
    'updated_at',
  ];
  const values = [
    sqlString(id),
    sqlString(externalProductId),
    sqlString(row.market || 'US'),
    sqlString(row.tool || 'creator_agents'),
    sqlString(destinationUrl),
    sqlString(canonicalUrl),
    sqlString(row.domain || null),
    sqlString(row.title || null),
    sqlString(row.image_url || null),
    sqlNumber(row.price_amount),
    sqlString(row.price_currency || 'USD'),
    sqlString(row.availability || null),
    `${sqlString(JSON.stringify(row.seed_data || {}))}::jsonb`,
    sqlString(row.status || 'active'),
    'NULL',
    'NOW()',
    'NOW()',
  ];

  return [
    `-- ${item?.ingredient_id || 'unknown'} | ${item?.target_brand || ''} | ${row.title || ''}`,
    `INSERT INTO external_product_seeds (${columns.join(', ')})`,
    `SELECT ${values.join(', ')}`,
    'WHERE NOT EXISTS (',
    '  SELECT 1',
    '  FROM external_product_seeds',
    `  WHERE id = ${sqlString(id)}`,
    `     OR external_product_id = ${sqlString(externalProductId)}`,
    `     OR canonical_url = ${sqlString(canonicalUrl)}`,
    `     OR destination_url = ${sqlString(destinationUrl)}`,
    ');',
    '',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = normalizePath(args.inputPath);
  if (!inputPath) throw new Error('Missing required --input <seed-creation-manifest.json>');
  const resolvedInput = path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);
  const input = JSON.parse(fs.readFileSync(resolvedInput, 'utf8'));
  const items = Array.isArray(input?.items) ? input.items : [];
  const statements = items.map(buildInsertStatement).join('\n');
  const output = [
    '-- Aurora external seed creation handoff',
    `-- Source manifest: ${resolvedInput}`,
    '-- Review JSON/CSV handoff and run inside a DB-enabled PIVOTA-Agent environment.',
    'BEGIN;',
    '',
    statements.trim(),
    '',
    'COMMIT;',
    '',
  ].join('\n');
  process.stdout.write(output);
  if (args.outPath) {
    const resolvedOut = path.isAbsolute(args.outPath) ? args.outPath : path.join(process.cwd(), args.outPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, output, 'utf8');
  }
}

try {
  main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
}
