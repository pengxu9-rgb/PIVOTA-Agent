#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { closePool, withClient } = require('../src/db');

const CONFIRM_TOKEN = 'repair-external-seed-mirror-attachments';

function parseArgs(argv) {
  const args = {
    market: 'US',
    domain: '',
    limit: 0,
    write: false,
    confirm: '',
    updateIndex: true,
    qualityThreshold: 60,
    sampleLimit: 15,
    out: '',
    manifest: '',
    manifestRows: [],
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--market') {
      args.market = String(next || '').trim().toUpperCase();
      i += 1;
    } else if (arg === '--all-markets') {
      args.market = '';
    } else if (arg === '--domain') {
      args.domain = String(next || '').trim().toLowerCase();
      i += 1;
    } else if (arg === '--limit') {
      args.limit = Math.max(0, Math.min(50000, Number(next || 0) || 0));
      i += 1;
    } else if (arg === '--write') {
      args.write = true;
    } else if (arg === '--confirm') {
      args.confirm = String(next || '').trim();
      i += 1;
    } else if (arg === '--skip-index') {
      args.updateIndex = false;
    } else if (arg === '--quality-threshold') {
      args.qualityThreshold = Math.max(0, Math.min(100, Number(next || 60) || 60));
      i += 1;
    } else if (arg === '--sample-limit') {
      args.sampleLimit = Math.max(0, Math.min(100, Number(next || 15) || 15));
      i += 1;
    } else if (arg === '--out') {
      args.out = String(next || '').trim();
      i += 1;
    } else if (arg === '--manifest') {
      args.manifest = String(next || '').trim();
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/repair-external-seed-mirror-attachments.cjs [options]

Repairs external_product_seeds.attached_product_key for active external seed
mirror rows that already have a one-to-one catalog_products mirror by
external_product_id. Dry-run by default.

Options:
  --market <market>             Market filter, default US
  --all-markets                 Remove market filter
  --domain <domain>             Optional domain filter
  --limit <n>                   Optional row limit, default all
  --write                       Apply updates
  --confirm ${CONFIRM_TOKEN}
                                Required with --write
  --skip-index                  Do not update stale index_pipeline_state rows
  --quality-threshold <n>       Score threshold for serving eligibility, default 60
  --sample-limit <n>            Sample rows to include in output, default 15
  --out <path>                  Write JSON report
  --manifest <path>             JSON action manifest; only no_seed repair rows
                                from the manifest are eligible for update
`);
}

function candidateLimitSql(limit) {
  const n = Number(limit || 0);
  return n > 0 ? `LIMIT ${Math.trunc(n)}` : '';
}

async function one(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0] || {};
}

async function many(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows || [];
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function loadManifestRows(filePath) {
  if (!filePath) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Manifest must be a JSON array: ${filePath}`);
  }
  const seen = new Set();
  const rows = [];
  for (const [index, row] of parsed.entries()) {
    if (text(row.lane) !== 'repair' || text(row.blocker_code) !== 'no_seed') continue;
    const contentKey = text(row.content_key);
    const externalProductId = text(row.external_product_id) || text(row.source_product_id);
    if (!/^ck_[a-f0-9]+$/i.test(contentKey)) {
      throw new Error(`Manifest row ${index} has invalid content_key: ${contentKey || '(empty)'}`);
    }
    if (!externalProductId) {
      throw new Error(`Manifest row ${index} has no external/source product id`);
    }
    const key = `${contentKey}::${externalProductId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      content_key: contentKey,
      external_product_id: externalProductId,
      sig_id: text(row.sig_id),
      title: text(row.title),
    });
  }
  if (!rows.length) {
    throw new Error(`Manifest has no repair/no_seed rows: ${filePath}`);
  }
  return rows;
}

async function buildCandidateTable(client, args) {
  await client.query('DROP TABLE IF EXISTS tmp_external_seed_mirror_attachment_repair');
  await client.query('DROP TABLE IF EXISTS tmp_external_seed_mirror_attachment_manifest');
  await client.query(`
    CREATE TEMP TABLE tmp_external_seed_mirror_attachment_manifest (
      content_key text NOT NULL,
      external_product_id text NOT NULL,
      sig_id text,
      title text,
      PRIMARY KEY (content_key, external_product_id)
    ) ON COMMIT DROP
  `);
  if (args.manifestRows.length) {
    await client.query(
      `
        INSERT INTO tmp_external_seed_mirror_attachment_manifest (
          content_key,
          external_product_id,
          sig_id,
          title
        )
        SELECT
          content_key,
          external_product_id,
          sig_id,
          title
        FROM jsonb_to_recordset($1::jsonb) AS x(
          content_key text,
          external_product_id text,
          sig_id text,
          title text
        )
      `,
      [JSON.stringify(args.manifestRows)],
    );
  }
  await client.query(
    `
      CREATE TEMP TABLE tmp_external_seed_mirror_attachment_repair ON COMMIT DROP AS
      WITH active_seed_counts AS (
        SELECT
          upper(coalesce(market, '')) AS market_norm,
          external_product_id,
          count(*)::int AS active_seed_rows
        FROM external_product_seeds
        WHERE status = 'active'
          AND coalesce(external_product_id, '') <> ''
          AND ($1::text = '' OR upper(coalesce(market, '')) = $1::text)
        GROUP BY 1, 2
      ),
      catalog_match_counts AS (
        SELECT
          source_product_id,
          count(*)::int AS catalog_rows
        FROM catalog_products
        WHERE source_system = 'external_product_seeds_mirror_v1'
          AND merchant_id = 'external_seed'
          AND platform = 'external_seed'
          AND sync_status = 'live'
          AND coalesce(source_product_id, '') <> ''
        GROUP BY 1
      ),
      joined AS (
        SELECT
          eps.id AS seed_id,
          eps.external_product_id,
          eps.market,
          eps.domain,
          eps.title AS seed_title,
          eps.attached_product_key AS current_attached_product_key,
          cp.product_key AS target_product_key,
          cp.content_key,
          cp.pivota_signature_id,
          cp.title AS catalog_title,
          cp.brand,
          cp.pdp_lifecycle_stage,
          ips.pipeline_stage,
          ips.blocker_code,
          ips.blocker_detail,
          ips.serving_eligible,
          ips.content_quality_score,
          coalesce(ascn.active_seed_rows, 0) AS active_seed_rows,
          coalesce(cmc.catalog_rows, 0) AS catalog_rows
        FROM external_product_seeds eps
        JOIN catalog_products cp
          ON cp.source_product_id = eps.external_product_id
         AND cp.source_system = 'external_product_seeds_mirror_v1'
         AND cp.merchant_id = 'external_seed'
         AND cp.platform = 'external_seed'
         AND cp.sync_status = 'live'
        LEFT JOIN index_pipeline_state ips
          ON ips.content_key = cp.content_key
        LEFT JOIN tmp_external_seed_mirror_attachment_manifest mf
          ON mf.content_key = cp.content_key
         AND mf.external_product_id = eps.external_product_id
        LEFT JOIN active_seed_counts ascn
          ON ascn.market_norm = upper(coalesce(eps.market, ''))
         AND ascn.external_product_id = eps.external_product_id
        LEFT JOIN catalog_match_counts cmc
          ON cmc.source_product_id = cp.source_product_id
        WHERE eps.status = 'active'
          AND coalesce(eps.external_product_id, '') <> ''
          AND coalesce(eps.attached_product_key, '') = ''
          AND ($1::text = '' OR upper(coalesce(eps.market, '')) = $1::text)
          AND ($2::text = '' OR lower(coalesce(eps.domain, '')) = $2::text)
          AND ($4::boolean IS FALSE OR mf.content_key IS NOT NULL)
      )
      SELECT
        *,
        CASE
          WHEN coalesce(seed_id, '') = '' THEN 'missing_seed_id'
          WHEN coalesce(target_product_key, '') = '' THEN 'missing_target_product_key'
          WHEN active_seed_rows <> 1 THEN 'ambiguous_active_seed_external_product_id'
          WHEN catalog_rows <> 1 THEN 'ambiguous_catalog_source_product_id'
          ELSE 'repairable'
        END AS repair_status,
        CASE
          WHEN coalesce(content_quality_score, 0) >= $3::numeric THEN 'eligible'
          ELSE 'low_quality'
        END AS next_index_status
      FROM joined
      ORDER BY
        CASE WHEN blocker_code = 'no_seed' THEN 0 ELSE 1 END,
        lower(coalesce(domain, '')),
        seed_id
      ${candidateLimitSql(args.limit)}
    `,
    [args.market, args.domain, args.qualityThreshold, args.manifestRows.length > 0],
  );
  await client.query('CREATE INDEX ON tmp_external_seed_mirror_attachment_repair(seed_id)');
  await client.query('CREATE INDEX ON tmp_external_seed_mirror_attachment_repair(content_key)');
}

async function summarize(client, args) {
  const totals = await one(client, `
    SELECT
      count(*)::int AS matched_unattached_rows,
      count(*) FILTER (WHERE repair_status = 'repairable')::int AS repairable_rows,
      count(*) FILTER (WHERE repair_status <> 'repairable')::int AS ambiguous_or_blocked_rows,
      count(*) FILTER (
        WHERE repair_status = 'repairable'
          AND blocker_code = 'no_seed'
      )::int AS repairable_stale_no_seed_rows,
      count(DISTINCT content_key) FILTER (
        WHERE repair_status = 'repairable'
          AND blocker_code = 'no_seed'
      )::int AS repairable_stale_no_seed_content_keys,
      count(DISTINCT content_key) FILTER (
        WHERE repair_status = 'repairable'
          AND blocker_code = 'no_seed'
          AND next_index_status = 'eligible'
      )::int AS eligible_content_keys,
      count(DISTINCT content_key) FILTER (
        WHERE repair_status = 'repairable'
          AND blocker_code = 'no_seed'
          AND next_index_status = 'low_quality'
      )::int AS low_quality_content_keys
    FROM tmp_external_seed_mirror_attachment_repair
  `);
  const byRepairStatus = await many(client, `
    SELECT repair_status, count(*)::int AS rows
    FROM tmp_external_seed_mirror_attachment_repair
    GROUP BY 1
    ORDER BY rows DESC, repair_status
  `);
  const byDomain = await many(client, `
    SELECT coalesce(domain, 'unknown') AS domain, count(*)::int AS rows
    FROM tmp_external_seed_mirror_attachment_repair
    WHERE repair_status = 'repairable'
    GROUP BY 1
    ORDER BY rows DESC, domain
    LIMIT 25
  `);
  const byIndexAction = await many(client, `
    SELECT
      coalesce(blocker_code, 'none') AS current_blocker_code,
      next_index_status,
      count(*)::int AS rows,
      count(DISTINCT content_key)::int AS content_keys,
      min(content_quality_score)::float AS min_score,
      max(content_quality_score)::float AS max_score
    FROM tmp_external_seed_mirror_attachment_repair
    WHERE repair_status = 'repairable'
    GROUP BY 1, 2
    ORDER BY rows DESC, current_blocker_code, next_index_status
  `);
  const samples = args.sampleLimit > 0
    ? await many(client, `
        SELECT
          seed_id,
          external_product_id,
          market,
          domain,
          target_product_key,
          content_key,
          pivota_signature_id,
          catalog_title,
          brand,
          blocker_code,
          content_quality_score,
          next_index_status
        FROM tmp_external_seed_mirror_attachment_repair
        WHERE repair_status = 'repairable'
        ORDER BY lower(coalesce(domain, '')), seed_id
        LIMIT $1
      `, [args.sampleLimit])
    : [];
  return {
    requested: {
      market: args.market || null,
      domain: args.domain || null,
      limit: args.limit || null,
      write: args.write === true,
      update_index: args.updateIndex === true,
      quality_threshold: args.qualityThreshold,
      manifest: args.manifest || null,
      manifest_rows: args.manifestRows.length,
    },
    totals,
    by_repair_status: byRepairStatus,
    by_domain: byDomain,
    by_index_action: byIndexAction,
    samples,
  };
}

async function applyRepair(client, args) {
  const seedUpdate = await client.query(`
    UPDATE external_product_seeds eps
    SET
      attached_product_key = repair.target_product_key,
      updated_at = now()
    FROM tmp_external_seed_mirror_attachment_repair repair
    WHERE eps.id = repair.seed_id
      AND repair.repair_status = 'repairable'
      AND coalesce(eps.attached_product_key, '') = ''
    RETURNING eps.id
  `);

  if (args.updateIndex !== true) {
    return {
      seed_rows_attached: Number(seedUpdate.rowCount || 0),
      index_rows_marked_eligible: 0,
      index_rows_marked_low_quality: 0,
    };
  }

  const eligibleUpdate = await client.query(`
    UPDATE index_pipeline_state ips
    SET
      serving_eligible = true,
      pipeline_stage = 'shadow_indexed',
      blocker_code = 'none',
      blocker_detail = NULL,
      quality_scored_at = coalesce(quality_scored_at, now())
    WHERE ips.blocker_code = 'no_seed'
      AND ips.content_key IN (
        SELECT DISTINCT content_key
        FROM tmp_external_seed_mirror_attachment_repair
        WHERE repair_status = 'repairable'
          AND next_index_status = 'eligible'
      )
    RETURNING ips.content_key
  `);

  const lowQualityUpdate = await client.query(`
    UPDATE index_pipeline_state ips
    SET
      serving_eligible = false,
      pipeline_stage = 'extracted',
      blocker_code = 'low_quality',
      blocker_detail = 'content_quality_score below serving threshold after external seed attachment',
      quality_scored_at = coalesce(quality_scored_at, now())
    WHERE ips.blocker_code = 'no_seed'
      AND ips.content_key IN (
        SELECT DISTINCT content_key
        FROM tmp_external_seed_mirror_attachment_repair
        WHERE repair_status = 'repairable'
          AND next_index_status = 'low_quality'
      )
    RETURNING ips.content_key
  `);

  return {
    seed_rows_attached: Number(seedUpdate.rowCount || 0),
    index_rows_marked_eligible: Number(eligibleUpdate.rowCount || 0),
    index_rows_marked_low_quality: Number(lowQualityUpdate.rowCount || 0),
  };
}

async function run(args) {
  if (args.help) {
    printHelp();
    return null;
  }
  if (args.write && args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  }
  args.manifestRows = loadManifestRows(args.manifest);

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`SET LOCAL statement_timeout = '120s'`);
      await buildCandidateTable(client, args);
      const before = await summarize(client, args);
      const writes = args.write ? await applyRepair(client, args) : {
        seed_rows_attached: 0,
        index_rows_marked_eligible: 0,
        index_rows_marked_low_quality: 0,
      };
      if (args.write) {
        await buildCandidateTable(client, args);
      }
      const after = args.write ? await summarize(client, args) : null;
      if (args.write) {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }
      return {
        ok: true,
        dry_run: !args.write,
        before,
        writes,
        after,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const report = await run(args);
  if (!report) return;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text);
  }
  process.stdout.write(text);
}

main()
  .catch((err) => {
    process.stderr.write(`${err.stack || err.message || String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
