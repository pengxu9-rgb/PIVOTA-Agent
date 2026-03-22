#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { withClient, getPool } = require('../src/db');
const {
  classifySeedStructuredIngredientStatus,
} = require('../src/services/externalSeedIngredientEnrichment');

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function parseArgs(argv) {
  const out = {
    sampleLimit: 25,
    outPath: '',
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = normalizeNonEmptyString(argv[idx]);
    if (token === '--sample-limit') {
      out.sampleLimit = Math.max(1, Number.parseInt(argv[idx + 1], 10) || 25);
      idx += 1;
    } else if (token === '--out') {
      out.outPath = normalizeNonEmptyString(argv[idx + 1]);
      idx += 1;
    }
  }
  return out;
}

function resolvePathMaybeRelative(targetPath) {
  if (!targetPath) return '';
  return path.isAbsolute(targetPath) ? targetPath : path.join(process.cwd(), targetPath);
}

function attachedStateForRow(row) {
  return normalizeNonEmptyString(row?.attached_product_key) ? 'attached' : 'unattached';
}

function summarizeBuckets(rows, valueSelector, sampleLimit = 25) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = normalizeNonEmptyString(valueSelector(row) || 'unknown') || 'unknown';
    const bucket = counts.get(key) || { key, count: 0, attached_count: 0, unattached_count: 0 };
    bucket.count += 1;
    const attachedState = attachedStateForRow(row);
    if (attachedState === 'attached') bucket.attached_count += 1;
    else bucket.unattached_count += 1;
    counts.set(key, bucket);
  }
  return Array.from(counts.values())
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, Math.max(1, sampleLimit));
}

function summarizeRows(rows, sampleLimit = 25) {
  return (Array.isArray(rows) ? rows : []).slice(0, Math.max(1, sampleLimit)).map((row) => ({
    seed_id: normalizeNonEmptyString(row?.id) || null,
    external_product_id: normalizeNonEmptyString(row?.external_product_id) || null,
    domain: normalizeNonEmptyString(row?.domain) || null,
    tool: normalizeNonEmptyString(row?.tool) || null,
    market: normalizeNonEmptyString(row?.market) || null,
    title: normalizeNonEmptyString(row?.title) || null,
    attached_state: attachedStateForRow(row),
    canonical_url: normalizeNonEmptyString(row?.canonical_url) || null,
    destination_url: normalizeNonEmptyString(row?.destination_url) || null,
    updated_at: normalizeNonEmptyString(row?.updated_at) || null,
  }));
}

async function fetchActiveRows() {
  return withClient(async (client) => {
    const res = await client.query(
      `
        SELECT
          id,
          external_product_id,
          market,
          tool,
          domain,
          title,
          canonical_url,
          destination_url,
          attached_product_key,
          seed_data,
          updated_at,
          created_at
        FROM external_product_seeds
        WHERE status = 'active'
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      `,
    );
    return Array.isArray(res?.rows) ? res.rows : [];
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!getPool()) throw new Error('DATABASE_URL not configured or pg driver unavailable');
  const rows = await fetchActiveRows();
  const classifiedRows = rows.map((row) => ({
    ...row,
    seed_structured_ingredient_status: classifySeedStructuredIngredientStatus(row.seed_data),
  }));
  const blankRows = classifiedRows.filter((row) => row.seed_structured_ingredient_status === 'missing');
  const partialRows = classifiedRows.filter((row) => row.seed_structured_ingredient_status === 'partial');
  const presentRows = classifiedRows.filter((row) => row.seed_structured_ingredient_status === 'present');
  const attachedRows = classifiedRows.filter((row) => attachedStateForRow(row) === 'attached');
  const unattachedRows = classifiedRows.filter((row) => attachedStateForRow(row) === 'unattached');
  const attachedBlankRows = blankRows.filter((row) => attachedStateForRow(row) === 'attached');
  const unattachedBlankRows = blankRows.filter((row) => attachedStateForRow(row) === 'unattached');

  const output = {
    generated_at: new Date().toISOString(),
    summary: {
      active_total: classifiedRows.length,
      active_blank_total: blankRows.length,
      active_partial_total: partialRows.length,
      active_present_total: presentRows.length,
      attached_active_total: attachedRows.length,
      attached_active_blank_total: attachedBlankRows.length,
      unattached_active_total: unattachedRows.length,
      unattached_active_blank_total: unattachedBlankRows.length,
    },
    distributions: {
      blank_by_domain: summarizeBuckets(blankRows, (row) => row.domain, args.sampleLimit),
      blank_by_tool: summarizeBuckets(blankRows, (row) => row.tool, args.sampleLimit),
      blank_by_domain_attachedness: summarizeBuckets(
        blankRows,
        (row) => `${normalizeNonEmptyString(row.domain) || 'unknown'}::${attachedStateForRow(row)}`,
        args.sampleLimit,
      ),
    },
    samples: {
      attached_blank_rows: summarizeRows(attachedBlankRows, args.sampleLimit),
      unattached_blank_rows: summarizeRows(unattachedBlankRows, args.sampleLimit),
    },
  };

  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  process.stdout.write(serialized);
  if (args.outPath) {
    const outPath = resolvePathMaybeRelative(args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serialized, 'utf8');
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
