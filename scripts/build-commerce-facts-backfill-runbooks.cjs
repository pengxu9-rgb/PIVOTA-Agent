#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildRunbook(entry, outDir) {
  const brandSlug = slugify(entry?.brand);
  const market = String(entry?.market || '').trim().toUpperCase() || 'US';
  const outFile = path.join(
    outDir,
    `${brandSlug}_${market.toLowerCase()}_commerce_facts_seed_backfill_runbook_20260501.json`,
  );
  const targetPages = (Array.isArray(entry?.targets) ? entry.targets : [])
    .slice(0, 4)
    .map((target) => ({
      product_id: target.external_product_id,
      title: target.title,
      expected_currency: target.price_currency || null,
      expected_availability: target.availability || null,
      page: `https://agent.pivota.cc/products/${target.external_product_id}`,
    }));

  const runbook = {
    generated_at: '2026-05-01T17:30:00.000Z',
    status: 'operator_ready',
    purpose: `Apply reviewed ${entry.brand} commerce facts refresh for market ${market} into external_product_seeds using exact target ids only.`,
    target_scope: {
      brand: entry.brand,
      market,
      external_product_ids_file: entry.targets_file,
      item_count: Number(entry?.item_count || 0),
      gate_pass_count: Number(entry?.gate_pass_count || 0),
      would_insert_unverified: Number(entry?.would_insert_unverified || 0),
      matched_preferred_titles: Array.isArray(entry?.matched_preferred_titles)
        ? entry.matched_preferred_titles
        : [],
      targets: Array.isArray(entry?.targets) ? entry.targets : [],
    },
    required_environment: [
      'DATABASE_URL present',
      'Run from /Users/pengchydan/dev/PIVOTA-Agent-similar-hotfix-20260414 or equivalent deployed code with matching backfill script',
    ],
    phase_1_seed_backfill_dry_run: {
      command: entry?.recommended_commands?.dry_run_by_external_ids || null,
      inspect: [
        'summary.failed = 0',
        'summary.commerce_facts_hold = 0',
        `rows are limited to ids from ${entry.targets_file}`,
        `payload.commerce_facts_v2.gate.expected_currency = ${market === 'US' ? 'USD' : 'market_expected_currency'}`,
        'payload.commerce_facts_v2.gate.observed_currency matches expected currency for each row',
      ],
    },
    phase_2_seed_backfill_apply: {
      command: entry?.recommended_commands?.apply_by_external_ids || null,
      inspect: [
        `summary.updated = ${Number(entry?.item_count || 0)}`,
        'summary.failed = 0',
      ],
    },
    phase_3_market_coverage_audit: {
      commands: [
        `DATABASE_URL=<db_url> node scripts/audit-external-seed-market-coverage.cjs --brand "${entry.brand}" --all-markets --limit 1000 --out ${path.join(
          outDir,
          `${brandSlug}_external_seed_market_coverage_20260501.json`,
        )}`,
      ],
      inspect: [
        'summary.multi_market_groups quantifies whether same-seller rows already exist across multiple markets',
        'groups[].by_market shows row_count, currencies, price spans per market',
        'If coverage shows only single-market groups, agent location-aware same-seller pricing is not production-ready',
      ],
    },
    phase_4_live_postcheck: {
      checks: [
        'Re-open representative PDPs and confirm displayed currency/availability match refreshed commerce facts',
        'If the product participates in multi-offer merge, confirm merged offer count remains stable',
      ],
      pages: targetPages,
    },
    notes: [
      'This runbook is seed-level only and does not change runtime code.',
      'Use exact external_product_ids_file first; expand to brand-level only after this exact-id batch is clean.',
      'Do not infer same-seller multi-region pricing readiness from a successful single-market refresh.',
    ],
  };

  fs.writeFileSync(outFile, JSON.stringify(runbook, null, 2));
  return { file: outFile, runbook };
}

function buildRunbooks(backlog, outDir) {
  const entries = Array.isArray(backlog?.entries) ? backlog.entries : [];
  return entries.map((entry) => buildRunbook(entry, outDir));
}

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

async function main() {
  const backlogPath = argValue('backlog');
  const outDir = argValue('out-dir');
  if (!backlogPath || !outDir) {
    throw new Error('Usage: node scripts/build-commerce-facts-backfill-runbooks.cjs --backlog <file> --out-dir <dir>');
  }

  const backlog = loadJson(backlogPath);
  ensureDir(outDir);
  const results = buildRunbooks(backlog, outDir);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        backlog_path: backlogPath,
        out_dir: outDir,
        runbook_count: results.length,
        files: results.map((item) => item.file),
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          error: 'BUILD_COMMERCE_FACTS_BACKFILL_RUNBOOKS_FAILED',
          message: err?.message || String(err),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  buildRunbook,
  buildRunbooks,
  slugify,
};
