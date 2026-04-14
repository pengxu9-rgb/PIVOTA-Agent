#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const out = {
    gatewayUrl: process.env.PIVOTA_GATEWAY_URL || 'https://agent.pivota.cc/api/gateway',
    productIds: [],
    queries: [],
    surface: '',
    pages: 0,
    frontendBaseUrl: 'https://agent.pivota.cc',
    frontendPaths: ['/products'],
    coveredReport: '',
    coveredReviewMode: 'strict_human',
    manualOverrides: 'scripts/fixtures/product_intel_manual_overrides.json',
    limit: 50,
    perQuery: 24,
    seed: String(process.env.PRODUCT_INTEL_PILOT_SEED || new Date().toISOString().slice(0, 10).replace(/-/g, '')),
    outDir: '',
    excludeCovered: true,
    requireBadgeEvidence: false,
    skipGemini: false,
    model: String(process.env.PIVOTA_PRODUCT_INTEL_MODEL || 'gemini-3-pro-preview'),
    maxPerBrand: 3,
    maxPerCategory: 4,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--gateway-url' && next) {
      out.gatewayUrl = next;
      i += 1;
    } else if (token === '--product-ids' && next) {
      out.productIds = String(next)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === '--queries' && next) {
      out.queries = String(next)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === '--surface' && next) {
      out.surface = String(next).trim();
      i += 1;
    } else if (token === '--pages' && next) {
      out.pages = Math.max(0, Number(next) || 0);
      i += 1;
    } else if (token === '--frontend-base-url' && next) {
      out.frontendBaseUrl = String(next).trim().replace(/\/+$/, '');
      i += 1;
    } else if (token === '--frontend-paths' && next) {
      out.frontendPaths = String(next)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === '--covered-report' && next) {
      out.coveredReport = next;
      i += 1;
    } else if (token === '--covered-review-mode' && next) {
      out.coveredReviewMode = String(next).trim() || 'strict_human';
      i += 1;
    } else if (token === '--manual-overrides' && next) {
      out.manualOverrides = next;
      i += 1;
    } else if (token === '--limit' && next) {
      out.limit = Math.max(1, Number(next) || 50);
      i += 1;
    } else if (token === '--per-query' && next) {
      out.perQuery = Math.max(1, Number(next) || 24);
      i += 1;
    } else if (token === '--seed' && next) {
      out.seed = String(next);
      i += 1;
    } else if (token === '--out-dir' && next) {
      out.outDir = next;
      i += 1;
    } else if (token === '--exclude-covered') {
      out.excludeCovered = true;
    } else if (token === '--include-covered') {
      out.excludeCovered = false;
    } else if (token === '--require-badge-evidence') {
      out.requireBadgeEvidence = true;
    } else if (token === '--skip-gemini') {
      out.skipGemini = true;
    } else if (token === '--model' && next) {
      out.model = String(next);
      i += 1;
    } else if (token === '--max-per-brand' && next) {
      out.maxPerBrand = Math.max(0, Number(next) || 0);
      i += 1;
    } else if (token === '--max-per-category' && next) {
      out.maxPerCategory = Math.max(0, Number(next) || 0);
      i += 1;
    }
  }

  return out;
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function toList(value) {
  return Array.isArray(value) ? value : [];
}

function runNodeScript(scriptPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = Number(options.timeoutMs || 0) || 0;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`script_timeout:${path.basename(scriptPath)}`));
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(asString(stderr || stdout || `script_failed:${path.basename(scriptPath)}`)));
        return;
      }
      resolve(asString(stdout));
    });
  });
}

function buildReviewPacket(compareReport) {
  const rows = toList(compareReport?.rows);
  const packetRows = rows.map((row) => {
    const bundle = row?.selected?.bundle || {};
    const product = bundle?.canonical_product_ref || row?.baseline?.canonical_product_ref || {};
    const core = bundle?.product_intel_core || {};
    const shoppingCard = bundle?.shopping_card || {};
    return {
      case_id: asString(row?.case_id),
      product_ref: {
        merchant_id: asString(product.merchant_id),
        product_id: asString(product.product_id),
      },
      review_status: 'pending',
      reviewer: '',
      reviewer_kind: '',
      reviewed_at: '',
      decision: 'pending',
      review_decision: 'pending',
      rejection_reason: '',
      notes: '',
      selected_mode: asString(row?.selected?.selected_mode),
      field_sources: row?.selected?.field_sources || {},
      evidence_profile: asString(bundle?.evidence_profile),
      quality_state: asString(bundle?.quality_state),
      shopping_card: {
        title: asString(shoppingCard.title),
        subtitle: asString(shoppingCard.subtitle),
        highlight: asString(shoppingCard.highlight),
        proof_badge: asString(shoppingCard.proof_badge),
      },
      search_card: {
        compact_candidate: asString(bundle?.search_card?.compact_candidate),
        highlight_candidate: asString(bundle?.search_card?.highlight_candidate),
        proof_badge_candidate: asString(bundle?.search_card?.proof_badge_candidate),
        intro_candidate: asString(bundle?.search_card?.intro_candidate),
      },
      external_highlight_preview: toList(bundle?.external_highlight_signals).map((item) => ({
        signal_id: asString(item?.signal_id),
        source_type: asString(item?.source_type),
        claim_type: asString(item?.claim_type),
        claim_text: asString(item?.claim_text),
        stance: asString(item?.stance),
        evidence_strength: asString(item?.evidence_strength),
        surfaceable: item?.surfaceable === true,
        surface_targets: toList(item?.surface_targets).map((target) => asString(target)),
      })),
      highlight_sources_summary: toList(bundle?.external_highlight_signals).map((item) => ({
        signal_id: asString(item?.signal_id),
        source_type: asString(item?.source_type),
        claim_type: asString(item?.claim_type),
        evidence_strength: asString(item?.evidence_strength),
        independence_count: Number(item?.independence_count || 0) || 0,
        sponsorship_status: asString(item?.sponsorship_status),
      })),
      pivota_insights: {
        what_it_is: asString(core?.what_it_is?.body),
        why_it_stands_out: toList(core?.why_it_stands_out).map((item) => ({
          headline: asString(item?.headline),
          body: asString(item?.body),
        })),
      },
    };
  });

  return {
    meta: {
      generated_at: new Date().toISOString(),
      report_cases: packetRows.length,
      pending: packetRows.length,
    },
    rows: packetRows,
  };
}

async function runCoverageBatch(rawArgs = {}) {
  const args = {
    ...parseArgs([process.execPath, __filename]),
    ...(rawArgs && typeof rawArgs === 'object' ? rawArgs : {}),
  };
  const rootDir = path.resolve(__dirname, '..');
  const childTimeoutMs = Math.max(
    30 * 1000,
    Number(process.env.PIVOTA_INSIGHTS_COVERAGE_CHILD_TIMEOUT_MS || 10 * 60 * 1000) || 10 * 60 * 1000,
  );
  if (!args.productIds.length && !args.queries.length && !(args.surface && args.pages > 0) && !args.frontendPaths.length) {
    throw new Error('missing_product_ids_queries_surface_or_frontend_paths');
  }

  const outDir = resolvePath(rootDir, args.outDir || `reports/pivota-insights-coverage/${args.seed}`);
  const casesPath = path.join(outDir, 'cases.json');
  const compareJsonPath = path.join(outDir, 'compare.json');
  const compareMdPath = path.join(outDir, 'compare.md');
  const reviewPath = path.join(outDir, 'review.json');

  const buildArgs = [
    '--gateway-url',
    args.gatewayUrl,
    '--limit',
    String(args.limit),
    '--per-query',
    String(args.perQuery),
    '--seed',
    args.seed,
    '--out',
    casesPath,
    '--max-per-brand',
    String(args.maxPerBrand),
    '--max-per-category',
    String(args.maxPerCategory),
  ];
  if (args.productIds.length) {
    buildArgs.push('--product-ids', args.productIds.join(','));
  }
  if (args.queries.length) {
    buildArgs.push('--queries', args.queries.join(','));
  }
  if (args.surface && args.pages > 0) {
    buildArgs.push('--surface', args.surface, '--pages', String(args.pages));
  }
  if (args.frontendBaseUrl && args.frontendPaths.length) {
    buildArgs.push('--frontend-base-url', args.frontendBaseUrl, '--frontend-paths', args.frontendPaths.join(','));
  }
  if (args.coveredReport) {
    buildArgs.push('--covered-report', args.coveredReport);
  }
  if (args.coveredReviewMode) {
    buildArgs.push('--covered-review-mode', args.coveredReviewMode);
  }
  if (args.manualOverrides) {
    buildArgs.push('--manual-overrides', args.manualOverrides);
  }
  if (args.excludeCovered) buildArgs.push('--exclude-covered');
  if (args.requireBadgeEvidence) buildArgs.push('--require-badge-evidence');
  await runNodeScript(path.join(rootDir, 'scripts/build_product_intel_live_pilot_cases.js'), buildArgs, {
    cwd: rootDir,
    timeoutMs: childTimeoutMs,
  });

  const compareArgs = [
    '--cases',
    casesPath,
    '--out',
    compareJsonPath,
    '--markdown',
    compareMdPath,
    '--model',
    args.model,
  ];
  if (args.skipGemini) compareArgs.push('--skip-gemini');
  await runNodeScript(path.join(rootDir, 'scripts/product_intel_pilot_compare.js'), compareArgs, {
    cwd: rootDir,
    timeoutMs: childTimeoutMs,
  });

  const compareReport = readJson(compareJsonPath);
  const reviewPacket = buildReviewPacket(compareReport);
  writeJson(reviewPath, reviewPacket);

  return {
    status: 'ok',
    out_dir: outDir,
    cases: casesPath,
    compare_json: compareJsonPath,
    compare_markdown: compareMdPath,
    review: reviewPath,
    count: toList(compareReport.rows).length,
    covered_review_mode: args.coveredReviewMode,
  };
}

async function main() {
  const result = await runCoverageBatch(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildReviewPacket,
  parseArgs,
  runCoverageBatch,
};
