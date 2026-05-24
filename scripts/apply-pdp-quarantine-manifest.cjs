#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { Client } = require('pg');

const CONFIRM_TOKEN = 'apply-pdp-quarantine-manifest';
const DEFAULT_MANIFEST = 'reports/pdp_serving_baseline_20260524/db/quarantine.json';
const DEFAULT_OUT = 'reports/pdp_serving_baseline_20260524/db/quarantine_apply_report.json';
const ALLOWED_BLOCKERS = new Set(['non_core_product', 'not_live', 'pdp_detail_unavailable']);

function readArg(name, fallback = null) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/apply-pdp-quarantine-manifest.cjs [options]

Exact-manifest quarantine for PDP rows that must stay out of public serving.
Dry-run by default. This never archives or deletes rows.

Options:
  --manifest <path>             JSON manifest, default ${DEFAULT_MANIFEST}
  --out <path>                  JSON report, default ${DEFAULT_OUT}
  --write                       Apply the quarantine metadata updates
  --confirm ${CONFIRM_TOKEN}
                                Required with --write
  --allow-serving-eligible      Allow exact rows that are currently serving_eligible=true
                                to be quarantined. Intended only after live PDP
                                strict probe proves the public PDP cannot render.
  --reason <text>               Audit detail prefix
  --help                        Show this help
`);
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

async function ensureParent(filePath) {
  if (!filePath) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readManifest(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Manifest must be a JSON array: ${filePath}`);
  }

  const grouped = new Map();
  parsed.forEach((row, index) => {
    const lane = text(row.lane);
    const contentKey = text(row.content_key);
    const sigId = text(row.sig_id);
    const blockerCode = text(row.blocker_code);
    const title = text(row.title);
    const actionRationale = text(row.action_rationale);

    if (lane !== 'quarantine') {
      throw new Error(`Manifest row ${index} is not quarantine lane: ${lane || '(empty)'}`);
    }
    if (!/^ck_[a-f0-9]+$/i.test(contentKey)) {
      throw new Error(`Manifest row ${index} has invalid content_key: ${contentKey || '(empty)'}`);
    }
    if (!/^sig_[a-f0-9]+$/i.test(sigId)) {
      throw new Error(`Manifest row ${index} has invalid sig_id: ${sigId || '(empty)'}`);
    }
    if (!ALLOWED_BLOCKERS.has(blockerCode)) {
      throw new Error(`Manifest row ${index} has non-quarantine blocker: ${blockerCode || '(empty)'}`);
    }

    const existing = grouped.get(contentKey);
    if (existing) {
      if (existing.blocker_code !== blockerCode) {
        throw new Error(
          `Duplicate content_key has conflicting blockers: ${contentKey} ` +
            `${existing.blocker_code} vs ${blockerCode}`,
        );
      }
      if (!existing.sig_ids.includes(sigId)) existing.sig_ids.push(sigId);
      existing.source_rows += 1;
      return;
    }

    grouped.set(contentKey, {
      content_key: contentKey,
      sig_ids: [sigId],
      blocker_code: blockerCode,
      title,
      source_product_id: text(row.source_product_id),
      action_rationale: actionRationale,
      source_rows: 1,
    });
  });

  const rows = [...grouped.values()];
  return {
    source_row_count: parsed.length,
    unique_content_keys: rows.length,
    duplicate_groups: rows
      .filter((row) => row.source_rows > 1)
      .map((row) => ({
        content_key: row.content_key,
        sig_ids: row.sig_ids,
        blocker_code: row.blocker_code,
        source_rows: row.source_rows,
        title: row.title,
      })),
    rows,
  };
}

async function installManifest(client, rows) {
  await client.query(`
    CREATE TEMP TABLE tmp_pdp_quarantine_manifest (
      content_key text PRIMARY KEY,
      sig_ids jsonb NOT NULL,
      blocker_code text NOT NULL,
      title text,
      source_product_id text,
      action_rationale text
    ) ON COMMIT DROP
  `);
  await client.query(
    `
      INSERT INTO tmp_pdp_quarantine_manifest (
        content_key,
        sig_ids,
        blocker_code,
        title,
        source_product_id,
        action_rationale
      )
      SELECT
        content_key,
        sig_ids,
        blocker_code,
        title,
        source_product_id,
        action_rationale
      FROM jsonb_to_recordset($1::jsonb) AS x(
        content_key text,
        sig_ids jsonb,
        blocker_code text,
        title text,
        source_product_id text,
        action_rationale text
      )
    `,
    [JSON.stringify(rows)],
  );
}

async function summarize(client, args = {}) {
  const summary = await client.query(`
    WITH matched AS (
      SELECT
        m.content_key,
        m.sig_ids,
        m.blocker_code AS manifest_blocker_code,
        cp.product_key,
        cp.sync_status,
        cp.pdp_lifecycle_stage,
        ips.content_key AS ips_content_key,
        ips.serving_eligible,
        ips.blocker_code AS current_blocker_code
      FROM tmp_pdp_quarantine_manifest m
      LEFT JOIN LATERAL (
        SELECT
          product_key,
          sync_status,
          pdp_lifecycle_stage
        FROM catalog_products cp
        WHERE cp.content_key = m.content_key
          AND cp.pivota_signature_id IN (
            SELECT jsonb_array_elements_text(m.sig_ids)
          )
        ORDER BY product_key ASC
        LIMIT 1
      ) cp ON TRUE
      LEFT JOIN index_pipeline_state ips
        ON ips.content_key = m.content_key
    )
    SELECT
      count(*)::int AS manifest_rows,
      count(*) FILTER (WHERE product_key IS NULL)::int AS catalog_missing_rows,
      count(*) FILTER (WHERE ips_content_key IS NULL)::int AS index_missing_rows,
      count(*) FILTER (WHERE serving_eligible IS TRUE)::int AS currently_serving_eligible_rows,
      count(*) FILTER (
        WHERE ips_content_key IS NOT NULL
          AND current_blocker_code IS DISTINCT FROM manifest_blocker_code
      )::int AS blocker_mismatch_rows,
      count(*) FILTER (
        WHERE ips_content_key IS NOT NULL
          AND serving_eligible IS DISTINCT FROM TRUE
          AND current_blocker_code IS DISTINCT FROM manifest_blocker_code
      )::int AS blocked_blocker_mismatch_rows,
      count(*) FILTER (
        WHERE ips_content_key IS NOT NULL
          AND serving_eligible IS FALSE
          AND current_blocker_code = manifest_blocker_code
      )::int AS already_quarantined_rows,
      count(*) FILTER (WHERE sync_status = 'live')::int AS live_catalog_rows,
      count(*) FILTER (WHERE sync_status IS DISTINCT FROM 'live')::int AS non_live_catalog_rows
    FROM matched
  `);
  const byBlocker = await client.query(`
    SELECT blocker_code, count(*)::int AS rows
    FROM tmp_pdp_quarantine_manifest
    GROUP BY blocker_code
    ORDER BY blocker_code
  `);
  const mismatches = await client.query(`
    SELECT
      m.content_key,
      m.sig_ids,
      m.blocker_code AS manifest_blocker_code,
      ips.serving_eligible,
      ips.blocker_code AS current_blocker_code,
      cp.product_key,
      cp.sync_status,
      cp.pdp_lifecycle_stage,
      m.title
    FROM tmp_pdp_quarantine_manifest m
    LEFT JOIN LATERAL (
      SELECT product_key, sync_status, pdp_lifecycle_stage
      FROM catalog_products cp
      WHERE cp.content_key = m.content_key
        AND cp.pivota_signature_id IN (
          SELECT jsonb_array_elements_text(m.sig_ids)
        )
      ORDER BY product_key ASC
      LIMIT 1
    ) cp ON TRUE
    LEFT JOIN index_pipeline_state ips
      ON ips.content_key = m.content_key
    WHERE cp.product_key IS NULL
       OR ips.content_key IS NULL
       OR ips.serving_eligible IS TRUE
       OR ips.blocker_code IS DISTINCT FROM m.blocker_code
    ORDER BY m.blocker_code, m.content_key
    LIMIT 50
  `);
  const s = summary.rows[0] || {};
  const safeToApply =
    Number(s.catalog_missing_rows || 0) === 0 &&
    Number(s.index_missing_rows || 0) === 0 &&
    (args.allowServingEligible
      ? Number(s.blocked_blocker_mismatch_rows || 0) === 0
      : Number(s.currently_serving_eligible_rows || 0) === 0 &&
        Number(s.blocker_mismatch_rows || 0) === 0);

  return {
    ...s,
    by_blocker: byBlocker.rows,
    safe_to_apply: safeToApply,
    mismatch_samples: mismatches.rows,
  };
}

async function applyQuarantine(client, args) {
  const result = await client.query(
    `
      WITH target AS (
        SELECT
          m.content_key,
          m.sig_ids,
          m.blocker_code AS manifest_blocker_code,
          m.action_rationale,
          cp.product_key
        FROM tmp_pdp_quarantine_manifest m
        JOIN LATERAL (
          SELECT product_key
          FROM catalog_products cp
          WHERE cp.content_key = m.content_key
            AND cp.pivota_signature_id IN (
              SELECT jsonb_array_elements_text(m.sig_ids)
            )
          ORDER BY product_key ASC
          LIMIT 1
        ) cp ON TRUE
        JOIN index_pipeline_state ips_check
          ON ips_check.content_key = m.content_key
         AND (
           (
             $3::boolean IS TRUE
             AND ips_check.serving_eligible IS TRUE
           )
           OR (
             $3::boolean IS NOT TRUE
             AND ips_check.serving_eligible IS FALSE
             AND ips_check.blocker_code = m.blocker_code
           )
         )
      )
      UPDATE index_pipeline_state ips
      SET
        serving_eligible = FALSE,
        blocker_code = target.manifest_blocker_code,
        blocker_detail = CASE
          WHEN nullif(btrim(coalesce(ips.blocker_detail, '')), '') IS NULL THEN
            left($1::text || ': ' || coalesce(nullif(target.action_rationale, ''), target.manifest_blocker_code), 2048)
          ELSE ips.blocker_detail
        END,
        consolidation_version = $2::text,
        last_consolidated_at = now()
      FROM target
      WHERE ips.content_key = target.content_key
      RETURNING
        ips.content_key,
        ips.pivota_signature_id,
        ips.serving_eligible,
        ips.blocker_code,
        ips.consolidation_version
    `,
    [args.reason, args.version, args.allowServingEligible === true],
  );
  return {
    updated_rows: result.rowCount,
    samples: result.rows.slice(0, 20),
  };
}

async function main() {
  if (hasFlag('help') || hasFlag('h')) {
    printHelp();
    return;
  }

  const args = {
    manifest: readArg('manifest', DEFAULT_MANIFEST),
    out: readArg('out', DEFAULT_OUT),
    write: hasFlag('write'),
    confirm: readArg('confirm', ''),
    allowServingEligible: hasFlag('allow-serving-eligible'),
    reason: readArg('reason', 'pdp_serving_quarantine_20260524'),
    version: readArg('version', 'pdp_quarantine_20260524'),
  };

  if (args.write && args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  }
  if (args.version.length > 32) {
    throw new Error('--version must be 32 characters or fewer');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const manifest = await readManifest(args.manifest);
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
  });

  const report = {
    generated_at: new Date().toISOString(),
    manifest: args.manifest,
    dry_run: !args.write,
    write_requested: args.write,
    allow_serving_eligible: args.allowServingEligible,
    manifest_source_rows: manifest.source_row_count,
    manifest_unique_content_keys: manifest.unique_content_keys,
    duplicate_groups: manifest.duplicate_groups,
    before: null,
    writes: {
      updated_rows: 0,
      samples: [],
    },
    after: null,
  };

  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    await installManifest(client, manifest.rows);
    report.before = await summarize(client, args);

    if (args.write && !report.before.safe_to_apply) {
      throw new Error('Unsafe quarantine manifest: current DB no longer matches the dry-run manifest');
    }

    if (args.write) {
      report.writes = await applyQuarantine(client, args);
      report.after = await summarize(client, args);
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Ignore rollback failures.
    }
    report.error = String(err && err.stack ? err.stack : err);
    report.ok = false;
    await ensureParent(args.out);
    await fs.writeFile(args.out, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = 1;
    return;
  } finally {
    await client.end().catch(() => {});
  }

  report.ok = true;
  await ensureParent(args.out);
  await fs.writeFile(args.out, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch(async (err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
