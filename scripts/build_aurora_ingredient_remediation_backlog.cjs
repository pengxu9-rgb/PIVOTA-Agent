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

function classifyBacklogLane(row) {
  const bucket = String(row?.root_cause_bucket || '').trim();
  if (bucket === 'explicit_supply_present_but_filtered') return 'code_filtering';
  if (bucket === 'explicit_supply_present_but_misranked') return 'code_ranking';
  if (bucket === 'only_family_supply_present') return 'data_supply';
  if (bucket === 'no_explicit_supply_in_any_source') return 'data_supply';
  if (bucket === 'registry_not_resolved') return 'registry';
  return 'none';
}

function summarizeStage(row, key) {
  const stage = row?.direct_source_stage_counts?.[key];
  if (!stage || typeof stage !== 'object') return null;
  const fetched = Math.max(0, Number(stage.fetched || 0));
  const admitted = Math.max(0, Number(stage.admitted || 0));
  const rejected = Math.max(0, Number(stage.rejected || 0));
  const final = Math.max(0, Number(stage.final || 0));
  if (fetched + admitted + rejected + final <= 0) return null;
  return { fetched, admitted, rejected, final };
}

function buildBacklogItem(row) {
  const lane = classifyBacklogLane(row);
  if (lane === 'none') return null;
  return {
    ingredient_id: row.ingredient_id || null,
    ingredient_name: row.ingredient_name || null,
    query: row.query || null,
    lane,
    root_cause_bucket: row.root_cause_bucket || null,
    recommended_action: row.recommended_action || null,
    miss_reason: row.miss_reason || null,
    query_source: row.query_source || null,
    registry_source: row.registry_source || null,
    profile_source: row.profile_source || null,
    active_stages: {
      kb_attached_seed: summarizeStage(row, 'kb_attached_seed'),
      attached_seed: summarizeStage(row, 'attached_seed'),
      products_cache: summarizeStage(row, 'products_cache'),
      unattached_seed: summarizeStage(row, 'unattached_seed'),
      family_fallback: summarizeStage(row, 'family_fallback'),
    },
    top_ranked_samples: Array.isArray(row.ranked_samples) ? row.ranked_samples.slice(0, 3) : [],
    top_rejected_samples: Array.isArray(row.rejected_samples) ? row.rejected_samples.slice(0, 3) : [],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = normalizePath(args.inputPath);
  if (!inputPath) {
    throw new Error('Missing required --input <matrix.json>');
  }
  const resolvedInput = path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);
  const input = JSON.parse(fs.readFileSync(resolvedInput, 'utf8'));
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  const backlogItems = rows.map(buildBacklogItem).filter(Boolean);
  const summary = {
    generated_at: new Date().toISOString(),
    source_matrix: resolvedInput,
    x_service_commit: input?.x_service_commit || null,
    backlog_count: backlogItems.length,
    lanes: backlogItems.reduce((acc, row) => {
      const key = String(row.lane || 'unknown').trim() || 'unknown';
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {}),
    items: backlogItems,
  };
  const output = `${JSON.stringify(summary, null, 2)}\n`;
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
