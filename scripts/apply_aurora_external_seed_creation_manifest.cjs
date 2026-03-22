#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { withClient, getPool } = require('../src/db');

function parseArgs(argv) {
  const out = { inputPath: '', outPath: '', dryRun: false, apply: false };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    if (token === '--input') {
      out.inputPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--out') {
      out.outPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--dry-run' || token === '--dryRun') {
      out.dryRun = true;
    } else if (token === '--apply') {
      out.apply = true;
    }
  }
  return out;
}

function normalizePath(value) {
  return String(value || '').trim();
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function resolvePathMaybeRelative(targetPath) {
  if (!targetPath) return '';
  return path.isAbsolute(targetPath) ? targetPath : path.join(process.cwd(), targetPath);
}

function buildRow(item) {
  const row = ensureObject(item?.seed_row);
  return {
    ingredient_id: normalizeNonEmptyString(item?.ingredient_id),
    ingredient_name: normalizeNonEmptyString(item?.ingredient_name),
    target_brand: normalizeNonEmptyString(item?.target_brand),
    target_url: normalizeNonEmptyString(item?.target_url),
    extract_status: normalizeNonEmptyString(item?.extract_status),
    seed_id: normalizeNonEmptyString(row.seed_id || row.id),
    external_product_id: normalizeNonEmptyString(row.external_product_id),
    market: normalizeNonEmptyString(row.market || 'US') || 'US',
    tool: normalizeNonEmptyString(row.tool || 'creator_agents') || 'creator_agents',
    destination_url: normalizeNonEmptyString(row.destination_url),
    canonical_url: normalizeNonEmptyString(row.canonical_url),
    domain: normalizeNonEmptyString(row.domain),
    title: normalizeNonEmptyString(row.title),
    image_url: normalizeNonEmptyString(row.image_url),
    price_amount: row.price_amount == null ? null : Number(row.price_amount),
    price_currency: normalizeNonEmptyString(row.price_currency || 'USD') || 'USD',
    availability: normalizeNonEmptyString(row.availability || 'in_stock') || 'in_stock',
    status: normalizeNonEmptyString(row.status || 'active') || 'active',
    attached_product_key: row.attached_product_key ?? null,
    requires_seed_correction: Boolean(row.requires_seed_correction),
    seed_data: ensureObject(row.seed_data),
  };
}

function validateRow(row) {
  const problems = [];
  if (!row.seed_id) problems.push('missing_seed_id');
  if (!row.external_product_id) problems.push('missing_external_product_id');
  if (!row.destination_url) problems.push('missing_destination_url');
  if (!row.canonical_url) problems.push('missing_canonical_url');
  if (!row.title) problems.push('missing_title');
  if (!row.seed_data || !Object.keys(row.seed_data).length) problems.push('missing_seed_data');
  return problems;
}

async function findExistingRows(client, row) {
  const res = await client.query(
    `
      SELECT
        id,
        external_product_id,
        canonical_url,
        destination_url,
        title,
        updated_at
      FROM external_product_seeds
      WHERE id = $1
         OR external_product_id = $2
         OR canonical_url = $3
         OR destination_url = $4
      ORDER BY updated_at DESC NULLS LAST
    `,
    [row.seed_id, row.external_product_id, row.canonical_url, row.destination_url],
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

async function insertRow(client, row) {
  await client.query(
    `
      INSERT INTO external_product_seeds (
        id,
        external_product_id,
        market,
        tool,
        destination_url,
        canonical_url,
        domain,
        title,
        image_url,
        price_amount,
        price_currency,
        availability,
        seed_data,
        status,
        attached_product_key,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, NOW(), NOW()
      )
    `,
    [
      row.seed_id,
      row.external_product_id,
      row.market,
      row.tool,
      row.destination_url,
      row.canonical_url,
      row.domain || null,
      row.title || null,
      row.image_url || null,
      Number.isFinite(row.price_amount) ? row.price_amount : null,
      row.price_currency || null,
      row.availability || null,
      JSON.stringify(row.seed_data || {}),
      row.status,
      row.attached_product_key,
    ],
  );
}

async function processManifestWithDb(manifest, mode) {
  return withClient(async (client) => {
    const results = [];
    if (mode === 'apply') {
      await client.query('BEGIN');
    }
    try {
      for (const item of manifest.items || []) {
        const row = buildRow(item);
        const validationProblems = validateRow(row);
        if (validationProblems.length) {
          results.push({
            ingredient_id: row.ingredient_id || null,
            ingredient_name: row.ingredient_name || null,
            seed_id: row.seed_id || null,
            external_product_id: row.external_product_id || null,
            status: 'invalid',
            validation_problems: validationProblems,
            requires_seed_correction: row.requires_seed_correction,
          });
          continue;
        }

        const existing = await findExistingRows(client, row);
        if (existing.length) {
          results.push({
            ingredient_id: row.ingredient_id,
            ingredient_name: row.ingredient_name,
            seed_id: row.seed_id,
            external_product_id: row.external_product_id,
            status: 'skipped_existing',
            existing_matches: existing.map((match) => ({
              id: normalizeNonEmptyString(match.id),
              external_product_id: normalizeNonEmptyString(match.external_product_id),
              canonical_url: normalizeNonEmptyString(match.canonical_url),
              destination_url: normalizeNonEmptyString(match.destination_url),
              title: normalizeNonEmptyString(match.title),
            })),
            requires_seed_correction: row.requires_seed_correction,
          });
          continue;
        }

        if (mode === 'dry_run') {
          results.push({
            ingredient_id: row.ingredient_id,
            ingredient_name: row.ingredient_name,
            seed_id: row.seed_id,
            external_product_id: row.external_product_id,
            status: 'would_insert',
            requires_seed_correction: row.requires_seed_correction,
          });
          continue;
        }

        await insertRow(client, row);
        results.push({
          ingredient_id: row.ingredient_id,
          ingredient_name: row.ingredient_name,
          seed_id: row.seed_id,
          external_product_id: row.external_product_id,
          status: 'inserted',
          requires_seed_correction: row.requires_seed_correction,
        });
      }

      if (mode === 'apply') {
        await client.query('COMMIT');
      }
      return results;
    } catch (error) {
      if (mode === 'apply') {
        await client.query('ROLLBACK');
      }
      throw error;
    }
  });
}

function processManifestWithoutDb(manifest) {
  const results = [];
  for (const item of manifest.items || []) {
    const row = buildRow(item);
    const validationProblems = validateRow(row);
    if (validationProblems.length) {
      results.push({
        ingredient_id: row.ingredient_id || null,
        ingredient_name: row.ingredient_name || null,
        seed_id: row.seed_id || null,
        external_product_id: row.external_product_id || null,
        status: 'invalid',
        validation_problems: validationProblems,
        requires_seed_correction: row.requires_seed_correction,
      });
      continue;
    }
    results.push({
      ingredient_id: row.ingredient_id,
      ingredient_name: row.ingredient_name,
      seed_id: row.seed_id,
      external_product_id: row.external_product_id,
      status: 'would_insert_unverified',
      requires_seed_correction: row.requires_seed_correction,
    });
  }
  return results;
}

function summarizeResults(results, mode, databaseAvailable) {
  const summary = {
    mode,
    database_available: databaseAvailable,
    scanned: results.length,
    inserted: 0,
    skipped_existing: 0,
    would_insert: 0,
    would_insert_unverified: 0,
    invalid: 0,
    requires_seed_correction_count: 0,
  };
  for (const result of results) {
    if (result.status && Object.prototype.hasOwnProperty.call(summary, result.status)) {
      summary[result.status] += 1;
    }
    if (result.requires_seed_correction) {
      summary.requires_seed_correction_count += 1;
    }
  }
  return summary;
}

function buildCorrectionFollowups(results) {
  return results
    .filter(
      (result) =>
        result.requires_seed_correction &&
        ['inserted', 'skipped_existing', 'would_insert', 'would_insert_unverified'].includes(result.status),
    )
    .map((result) => ({
      ingredient_id: result.ingredient_id || null,
      ingredient_name: result.ingredient_name || null,
      seed_id: result.seed_id || null,
      external_product_id: result.external_product_id || null,
      post_insert_action: 'run_seed_audit_and_correction',
    }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolvePathMaybeRelative(normalizePath(args.inputPath));
  if (!inputPath) throw new Error('Missing required --input <seed-creation-manifest.json>');

  const manifest = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const mode = args.apply ? 'apply' : 'dry_run';
  const databaseAvailable = Boolean(getPool());

  if (mode === 'apply' && !databaseAvailable) {
    const error = new Error('DATABASE_URL not configured or pg driver unavailable');
    error.code = 'NO_DATABASE';
    throw error;
  }

  const results = databaseAvailable
    ? await processManifestWithDb(manifest, mode)
    : processManifestWithoutDb(manifest);
  const output = {
    generated_at: new Date().toISOString(),
    input_path: inputPath,
    summary: summarizeResults(results, mode, databaseAvailable),
    correction_followups: buildCorrectionFollowups(results),
    items: results,
  };

  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  process.stdout.write(serialized);
  if (args.outPath) {
    const outPath = resolvePathMaybeRelative(normalizePath(args.outPath));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serialized, 'utf8');
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
