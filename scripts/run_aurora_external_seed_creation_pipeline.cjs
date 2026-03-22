#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function parseArgs(argv) {
  const out = {
    manifestPath: '',
    outPath: '',
    pivotaAgentRoot: '/Users/pengchydan/dev/PIVOTA-Agent',
    apply: false,
    runCorrection: false,
    correctionDryRun: false,
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    if (token === '--manifest') {
      out.manifestPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--out') {
      out.outPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--pivota-agent-root') {
      out.pivotaAgentRoot = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--apply') {
      out.apply = true;
    } else if (token === '--run-correction') {
      out.runCorrection = true;
    } else if (token === '--correction-dry-run') {
      out.correctionDryRun = true;
    }
  }
  return out;
}

function normalizePath(value) {
  return String(value || '').trim();
}

function resolvePathMaybeRelative(targetPath) {
  if (!targetPath) return '';
  return path.isAbsolute(targetPath) ? targetPath : path.join(process.cwd(), targetPath);
}

function parseJsonCommandOutput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function runNodeJson(scriptPath, args, cwd) {
  const raw = execFileSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  });
  return parseJsonCommandOutput(raw);
}

function buildCorrectionCommand(correctionScriptPath, seedId, dryRun) {
  const args = [correctionScriptPath, '--market', 'US', '--seed-id', seedId, '--limit', '1', '--no-ledger'];
  if (dryRun) args.push('--dry-run');
  return {
    argv: [process.execPath, ...args],
    cwd: path.dirname(path.dirname(correctionScriptPath)),
  };
}

function buildRuntimeReprobeTargets(manifestDoc) {
  const items = Array.isArray(manifestDoc?.items) ? manifestDoc.items : [];
  return items.map((item) => ({
    ingredient_id: item?.ingredient_id || null,
    ingredient_name: item?.ingredient_name || null,
    expected_lane: 'direct_explicit_supply',
  }));
}

function maybeWriteOutput(outPath, doc) {
  if (!outPath) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = resolvePathMaybeRelative(normalizePath(args.manifestPath));
  if (!manifestPath) throw new Error('Missing required --manifest <seed-creation-manifest.json>');

  const repoRoot = process.cwd();
  const applyScriptPath = path.join(repoRoot, 'scripts', 'apply_aurora_external_seed_creation_manifest.cjs');
  const correctionScriptPath = path.join(resolvePathMaybeRelative(args.pivotaAgentRoot), 'scripts', 'correct-external-product-seeds.js');
  const manifestDoc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mode = args.apply ? 'apply' : 'dry_run';

  const applyResult = runNodeJson(
    applyScriptPath,
    ['--input', manifestPath, args.apply ? '--apply' : '--dry-run'],
    repoRoot,
  );

  const correctionPlans = Array.isArray(applyResult?.correction_followups)
    ? applyResult.correction_followups.map((item) => ({
        ...item,
        runnable: fs.existsSync(correctionScriptPath) && Boolean(process.env.DATABASE_URL),
        dry_run: args.correctionDryRun || !args.apply,
        command: buildCorrectionCommand(correctionScriptPath, item.seed_id, args.correctionDryRun || !args.apply),
      }))
    : [];

  const correctionResults = [];
  if (args.runCorrection && correctionPlans.length) {
    for (const plan of correctionPlans) {
      if (!plan.runnable) {
        correctionResults.push({
          seed_id: plan.seed_id,
          status: 'blocked',
          reason: !fs.existsSync(correctionScriptPath) ? 'missing_correction_script' : 'no_database',
        });
        continue;
      }
      const raw = execFileSync(plan.command.argv[0], plan.command.argv.slice(1), {
        cwd: plan.command.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 20 * 1024 * 1024,
      });
      correctionResults.push({
        seed_id: plan.seed_id,
        status: 'completed',
        summary: parseJsonCommandOutput(raw),
      });
    }
  }

  const output = {
    generated_at: new Date().toISOString(),
    manifest_path: manifestPath,
    mode,
    database_available: Boolean(process.env.DATABASE_URL),
    correction_script_available: fs.existsSync(correctionScriptPath),
    apply_result: applyResult,
    correction_plans: correctionPlans,
    correction_results: correctionResults,
    runtime_reprobe_targets: buildRuntimeReprobeTargets(manifestDoc),
  };

  const outPath = resolvePathMaybeRelative(normalizePath(args.outPath));
  maybeWriteOutput(outPath, output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
