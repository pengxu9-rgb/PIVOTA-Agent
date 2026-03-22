#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { withClient, getPool } = require('../src/db');
const {
  enrichExternalSeedRowIngredients,
} = require('../src/services/externalSeedIngredientEnrichment');

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function parseArgs(argv) {
  const out = {
    seedId: '',
    externalProductId: '',
    domain: '',
    market: '',
    limit: 25,
    offset: 0,
    apply: false,
    dryRun: false,
    outPath: '',
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = normalizeNonEmptyString(argv[idx]);
    if (token === '--seed-id') {
      out.seedId = normalizeNonEmptyString(argv[idx + 1]);
      idx += 1;
    } else if (token === '--external-product-id') {
      out.externalProductId = normalizeNonEmptyString(argv[idx + 1]);
      idx += 1;
    } else if (token === '--domain') {
      out.domain = normalizeNonEmptyString(argv[idx + 1]);
      idx += 1;
    } else if (token === '--market') {
      out.market = normalizeNonEmptyString(argv[idx + 1]).toUpperCase();
      idx += 1;
    } else if (token === '--limit') {
      out.limit = Math.max(1, Number(argv[idx + 1]) || out.limit);
      idx += 1;
    } else if (token === '--offset') {
      out.offset = Math.max(0, Number(argv[idx + 1]) || 0);
      idx += 1;
    } else if (token === '--apply') {
      out.apply = true;
    } else if (token === '--dry-run' || token === '--dryRun') {
      out.dryRun = true;
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

async function fetchRows(client, args) {
  const where = [`status = 'active'`];
  const params = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (args.seedId) where.push(`id::text = ${push(args.seedId)}`);
  if (args.externalProductId) where.push(`external_product_id = ${push(args.externalProductId)}`);
  if (args.domain) where.push(`domain = ${push(args.domain)}`);
  if (args.market) where.push(`upper(coalesce(market, '')) = ${push(args.market)}`);
  params.push(args.limit);
  const limitBind = `$${params.length}`;
  params.push(args.offset);
  const offsetBind = `$${params.length}`;
  const res = await client.query(
    `
      SELECT
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
      FROM external_product_seeds
      WHERE ${where.join('\n        AND ')}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT ${limitBind}
      OFFSET ${offsetBind}
    `,
    params,
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

function summarize(items, mode) {
  const summary = {
    mode,
    scanned: Array.isArray(items) ? items.length : 0,
    changed: 0,
    unchanged: 0,
    updated: 0,
    seed_kb_sync_status: {},
    ingredient_writeback_source: {},
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (item.changed) summary.changed += 1;
    else summary.unchanged += 1;
    if (item.status === 'updated') summary.updated += 1;
    const syncKey = normalizeNonEmptyString(item.seed_kb_sync_status || 'missing_both');
    const sourceKey = normalizeNonEmptyString(item.ingredient_writeback_source || 'none');
    summary.seed_kb_sync_status[syncKey] = Number(summary.seed_kb_sync_status[syncKey] || 0) + 1;
    summary.ingredient_writeback_source[sourceKey] =
      Number(summary.ingredient_writeback_source[sourceKey] || 0) + 1;
  }
  return summary;
}

async function runWithDb(args, mode) {
  return withClient(async (client) => {
    const rows = await fetchRows(client, args);
    const items = [];
    if (mode === 'apply') await client.query('BEGIN');
    try {
      for (const row of rows) {
        const enrichment = await enrichExternalSeedRowIngredients({ row });
        const nextRow = enrichment?.row && typeof enrichment.row === 'object' ? enrichment.row : row;
        const item = {
          seed_id: normalizeNonEmptyString(row.id),
          external_product_id: normalizeNonEmptyString(row.external_product_id),
          changed: enrichment?.changed === true,
          status: enrichment?.changed === true ? (mode === 'apply' ? 'updated' : 'would_update') : 'unchanged',
          ingredient_writeback_source: enrichment?.enrichment_source || 'none',
          seed_structured_ingredient_status_before:
            enrichment?.seed_structured_ingredient_status_before || 'missing',
          seed_structured_ingredient_status_after:
            enrichment?.seed_structured_ingredient_status_after || 'missing',
          seed_kb_sync_status: enrichment?.seed_kb_sync_status || 'missing_both',
          runtime_ingredient_evidence_source:
            enrichment?.runtime_ingredient_evidence_source || 'none',
        };
        if (mode === 'apply' && enrichment?.changed === true) {
          await client.query(
            `
              UPDATE external_product_seeds
              SET seed_data = $2::jsonb, updated_at = now()
              WHERE id = $1
            `,
            [row.id, JSON.stringify(nextRow.seed_data || {})],
          );
        }
        items.push(item);
      }
      if (mode === 'apply') await client.query('COMMIT');
      return items;
    } catch (error) {
      if (mode === 'apply') await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.apply ? 'apply' : 'dry_run';
  const databaseAvailable = Boolean(getPool());
  if (!databaseAvailable) {
    const error = new Error('DATABASE_URL not configured or pg driver unavailable');
    error.code = 'NO_DATABASE';
    throw error;
  }
  const items = await runWithDb(args, mode);
  const output = {
    generated_at: new Date().toISOString(),
    mode,
    filters: {
      seed_id: args.seedId || null,
      external_product_id: args.externalProductId || null,
      domain: args.domain || null,
      market: args.market || null,
      limit: args.limit,
      offset: args.offset,
    },
    summary: summarize(items, mode),
    items,
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
