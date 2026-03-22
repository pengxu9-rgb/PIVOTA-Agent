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

function csvEscape(value) {
  const raw = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return `"${String(raw).replace(/"/g, '""')}"`;
}

function buildRow(item) {
  const seedRow = item?.seed_row && typeof item.seed_row === 'object' ? item.seed_row : {};
  return [
    item?.ingredient_id || '',
    item?.ingredient_name || '',
    item?.target_brand || '',
    item?.target_url || '',
    item?.extract_status || '',
    seedRow.external_product_id || '',
    seedRow.market || '',
    seedRow.tool || '',
    seedRow.status || '',
    seedRow.domain || '',
    seedRow.canonical_url || '',
    seedRow.destination_url || '',
    seedRow.title || '',
    seedRow.image_url || '',
    seedRow.price_amount == null ? '' : String(seedRow.price_amount),
    seedRow.price_currency || '',
    seedRow.availability || '',
    seedRow.requires_seed_correction ? 'true' : 'false',
    seedRow.seed_data || {},
  ];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = normalizePath(args.inputPath);
  if (!inputPath) throw new Error('Missing required --input <seed-creation-manifest.json>');
  const resolvedInput = path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);
  const input = JSON.parse(fs.readFileSync(resolvedInput, 'utf8'));
  const items = Array.isArray(input?.items) ? input.items : [];
  const header = [
    'ingredient_id',
    'ingredient_name',
    'target_brand',
    'target_url',
    'extract_status',
    'external_product_id',
    'market',
    'tool',
    'status',
    'domain',
    'canonical_url',
    'destination_url',
    'title',
    'image_url',
    'price_amount',
    'price_currency',
    'availability',
    'requires_seed_correction',
    'seed_data_json',
  ];
  const lines = [header.map(csvEscape).join(',')];
  for (const item of items) {
    lines.push(buildRow(item).map(csvEscape).join(','));
  }
  const output = `${lines.join('\n')}\n`;
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
