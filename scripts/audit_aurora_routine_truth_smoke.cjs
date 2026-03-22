#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE_URL = process.env.AURORA_AUDIT_BASE_URL || 'https://pivota-agent-production.up.railway.app';
const DEFAULT_TIMEOUT_MS = Math.max(10_000, Number.parseInt(process.env.AURORA_AUDIT_TIMEOUT_MS, 10) || 60_000);

const CASES = Object.freeze([
  {
    case_id: 'structured_basic',
    body: {
      use_photo: false,
      currentRoutine: {
        am: {
          cleanser: 'Gentle cleanser',
          serum: 'Vitamin C serum',
          moisturizer: 'Barrier cream',
          spf: 'SPF 50 sunscreen',
        },
        pm: {
          cleanser: 'Gentle cleanser',
          treatment: 'Retinol serum',
          moisturizer: 'Barrier cream',
        },
      },
    },
  },
  {
    case_id: 'shared_am_pm_products',
    body: {
      use_photo: false,
      currentRoutine: {
        am: {
          cleanser: 'Gentle cleanser',
          serum: 'Niacinamide serum',
          moisturizer: 'Barrier cream',
          spf: 'SPF 50 sunscreen',
        },
        pm: {
          cleanser: 'Gentle cleanser',
          treatment: 'Niacinamide serum',
          moisturizer: 'Barrier cream',
        },
      },
    },
  },
]);

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function parseArgs(argv) {
  const out = {
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outPath: '',
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = normalizeNonEmptyString(argv[idx]);
    if (token === '--base-url') {
      out.baseUrl = normalizeNonEmptyString(argv[idx + 1]) || DEFAULT_BASE_URL;
      idx += 1;
    } else if (token === '--timeout-ms') {
      out.timeoutMs = Math.max(5_000, Number.parseInt(argv[idx + 1], 10) || DEFAULT_TIMEOUT_MS);
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

function findCard(body, type) {
  const cards = Array.isArray(body?.cards) ? body.cards : [];
  return cards.find((card) => normalizeNonEmptyString(card?.type) === type) || null;
}

async function runCase(baseUrl, timeoutMs, spec) {
  const response = await fetch(new URL('/v1/analysis/skin', baseUrl), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'X-Aurora-UID': `aurora_routine_truth_${spec.case_id}`,
      'X-Trace-ID': `trace_${spec.case_id}_${Date.now()}`,
      'X-Brief-ID': `brief_${spec.case_id}_${Date.now()}`,
      'X-Lang': 'EN',
    },
    body: JSON.stringify(spec.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  const analysisMeta = body?.analysis_meta && typeof body.analysis_meta === 'object' ? body.analysis_meta : {};
  return {
    case_id: spec.case_id,
    status: response.status,
    x_service_commit: normalizeNonEmptyString(response.headers.get('x-service-commit')) || null,
    analysis_mode: normalizeNonEmptyString(analysisMeta.analysis_mode) || null,
    ingredient_plan_empty_target_count: Math.max(0, Number(analysisMeta.ingredient_plan_empty_target_count || 0)),
    ingredient_direct_hit_target_count: Math.max(0, Number(analysisMeta.ingredient_direct_hit_target_count || 0)),
    ingredient_direct_empty_masked_target_count: Math.max(
      0,
      Number(analysisMeta.ingredient_direct_empty_masked_target_count || 0),
    ),
    ingredient_direct_empty_unrecovered_target_count: Math.max(
      0,
      Number(analysisMeta.ingredient_direct_empty_unrecovered_target_count || 0),
    ),
    ingredient_target_source_breakdown:
      analysisMeta.ingredient_target_source_breakdown &&
      typeof analysisMeta.ingredient_target_source_breakdown === 'object'
        ? analysisMeta.ingredient_target_source_breakdown
        : {},
    analysis_story_v2_present: Boolean(findCard(body, 'analysis_story_v2')),
    ingredient_plan_v2_present: Boolean(findCard(body, 'ingredient_plan_v2')),
    routine_products_preview_present: Boolean(findCard(body, 'routine_products_preview')),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeNonEmptyString(args.baseUrl).replace(/\/+$/, '');
  const rows = [];
  let serviceCommit = '';
  for (const spec of CASES) {
    const row = await runCase(baseUrl, args.timeoutMs, spec);
    if (!serviceCommit && row.x_service_commit) serviceCommit = row.x_service_commit;
    rows.push(row);
  }
  const output = {
    generated_at: new Date().toISOString(),
    base_url: baseUrl,
    timeout_ms: args.timeoutMs,
    x_service_commit: serviceCommit || null,
    case_count: rows.length,
    rows,
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
