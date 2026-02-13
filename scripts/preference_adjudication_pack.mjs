#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import { runTimestampKey } from './internal_batch_helpers.mjs';
import {
  readJsonlRows,
  toLabelStudioLocalFilesUrl,
  toPosix,
} from './local_image_loader.mjs';

const HELP_TEXT = `preference_adjudication_pack.mjs

Usage:
  node scripts/preference_adjudication_pack.mjs --eval_jsonl <reports/eval_preference_*.jsonl> --manifest <artifacts/preference_round1_<run_id>/manifest.json> [options]

Required:
  --eval_jsonl <path>                    per-sample eval_preference jsonl
  --manifest <path>                      original preference pack manifest json

Options:
  --run_id <id>                          run id (default: infer from input paths)
  --out <dir>                            output dir (default: artifacts/preference_round1_<run_id>/adjudication)
  --limit <n>                            selected adjudication samples (default: 50)
  --help                                 show help
`;

const DEFAULTS = Object.freeze({
  limit: 50,
});

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function parseArgs(argv) {
  const out = {
    help: false,
    run_id: process.env.RUN_ID || '',
    eval_jsonl: process.env.EVAL_JSONL || '',
    manifest: process.env.MANIFEST || process.env.PREFERENCE_MANIFEST || '',
    out: process.env.OUT || '',
    limit: process.env.LIMIT || DEFAULTS.limit,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (!(key in out)) continue;
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = String(next);
    i += 1;
  }

  out.help = parseBool(out.help, false);
  out.run_id = String(out.run_id || '').trim();
  out.eval_jsonl = String(out.eval_jsonl || '').trim();
  out.manifest = String(out.manifest || '').trim();
  out.out = String(out.out || '').trim();
  out.limit = Math.max(1, Math.min(5000, Math.trunc(parseNumber(out.limit, DEFAULTS.limit, 1, 5000))));
  return out;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  for (const input of [args.eval_jsonl, args.manifest]) {
    const base = path.basename(String(input || ''));
    const match = base.match(/(\d{15}|\d{8}_\d{6,9})/);
    if (match) return match[1];
  }
  return runTimestampKey();
}

function resolveOverlayPaths(row) {
  const roleA = String(row.role_a || '').trim().toLowerCase();
  const roleB = String(row.role_b || '').trim().toLowerCase();
  const imageA = row.image_a_path ? path.resolve(String(row.image_a_path)) : null;
  const imageB = row.image_b_path ? path.resolve(String(row.image_b_path)) : null;

  const baseline = row.overlay_baseline_path
    ? path.resolve(String(row.overlay_baseline_path))
    : (roleA === 'baseline' ? imageA : (roleB === 'baseline' ? imageB : null));

  const variant = row.overlay_variant1_path
    ? path.resolve(String(row.overlay_variant1_path))
    : (roleA === 'variant' ? imageA : (roleB === 'variant' ? imageB : null));

  return {
    baseline_path: baseline,
    variant1_path: variant,
  };
}

function buildReasons(evalRow, manifestRow) {
  const reasons = [];
  const risk = manifestRow && typeof manifestRow.risk_features === 'object' && manifestRow.risk_features
    ? manifestRow.risk_features
    : {};
  const disagreement = Number(evalRow.disagreement_overlap_rate || evalRow.disagreement_rate || 0);
  if (Number(evalRow.cannot_tell_rate || 0) > 0) reasons.push('cannot_tell');
  if (disagreement > 0) reasons.push('rater_disagreement');
  if (Number(evalRow.low_confidence_rate || 0) > 0.3) reasons.push('low_confidence');
  if (Number(evalRow.hair_overlap_est || risk.hair_overlap_est || manifestRow.hair_overlap_est || 0) >= 0.2) reasons.push('high_hair_overlap_est');
  if (Number(evalRow.leakage_bg_est_mean || risk.leakage_bg_est_mean || manifestRow.leakage_bg_est_mean || 0) >= 0.2) reasons.push('high_leakage_bg_est');
  if (Number(evalRow.min_module_pixels || risk.min_module_pixels || manifestRow.min_module_pixels || 99999) <= 16) reasons.push('low_min_module_pixels');
  if (!reasons.length) reasons.push('contentious_rank');
  return [...new Set(reasons)];
}

function buildContentiousScore(evalRow) {
  return round3(
    (Number(evalRow.cannot_tell_rate) || 0) * 0.45
    + (Number(evalRow.disagreement_overlap_rate || evalRow.disagreement_rate) || 0) * 0.35
    + (Number(evalRow.low_confidence_rate) || 0) * 0.2,
  ) || 0;
}

function toTask(sampleRow, manifestRow, overlays, labelStudioDocumentRoot) {
  const sampleId = String(sampleRow.sample_id || sampleRow.sample_hash || '').trim();
  const reasons = buildReasons(sampleRow, manifestRow);
  const contentiousScore = buildContentiousScore(sampleRow);
  const baselineId = String(manifestRow.baseline_id || 'baseline_default').trim() || 'baseline_default';
  const variantId = String(manifestRow.variant_id || 'variant1_forehead_hair_clip').trim() || 'variant1_forehead_hair_clip';

  const metadata = {
    ...manifestRow,
    ...sampleRow,
    sample_id: sampleId,
    adjudication: true,
    adjudication_reasons: reasons,
    adjudication_score: contentiousScore,
  };

  return {
    id: `adj_${sampleId}`,
    data: {
      sample_id: sampleId,
      sample_hash: sampleId,
      source: sampleRow.source || manifestRow.source || 'unknown',
      baseline_id: baselineId,
      variant_id: variantId,
      image_baseline: overlays.baseline_path
        ? toLabelStudioLocalFilesUrl(overlays.baseline_path, { documentRoot: labelStudioDocumentRoot })
        : null,
      image_variant1: overlays.variant1_path
        ? toLabelStudioLocalFilesUrl(overlays.variant1_path, { documentRoot: labelStudioDocumentRoot })
        : null,
      image_baseline_path: overlays.baseline_path || null,
      image_variant1_path: overlays.variant1_path || null,
      baseline_label: baselineId,
      variant1_label: variantId,
      adjudication: true,
      adjudication_reasons: reasons,
      adjudication_score: contentiousScore,
      contentious_inputs: {
        cannot_tell_rate: sampleRow.cannot_tell_rate,
        disagreement_rate: sampleRow.disagreement_rate,
        low_confidence_rate: sampleRow.low_confidence_rate,
      },
    },
    meta: metadata,
    metadata,
  };
}

function renderPreview({ runId, selected, excluded }) {
  const lines = [];
  lines.push('# Preference Adjudication Pack');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- selected: ${selected.length}`);
  lines.push(`- excluded: ${excluded.length}`);
  lines.push('');

  lines.push('## Selected Top Contentious');
  lines.push('');
  lines.push('| rank | sample_id | source | score | reasons | baseline_overlay | variant1_overlay |');
  lines.push('|---:|---|---|---:|---|---|---|');
  if (!selected.length) {
    lines.push('| 1 | - | - | - | - | - | - |');
  } else {
    selected.forEach((row, idx) => {
      const taskData = row.task.data || {};
      lines.push(`| ${idx + 1} | ${row.sample_id} | ${row.source} | ${row.score ?? '-'} | ${(row.reasons || []).join('+')} | ${toPosix(taskData.image_baseline_path || '-')} | ${toPosix(taskData.image_variant1_path || '-')} |`);
    });
  }
  lines.push('');

  lines.push('## Excluded');
  lines.push('');
  lines.push('| sample_id | source | reason |');
  lines.push('|---|---|---|');
  if (!excluded.length) {
    lines.push('| - | - | - |');
  } else {
    excluded.slice(0, 50).forEach((row) => {
      lines.push(`| ${row.sample_id || '-'} | ${row.source || '-'} | ${row.reason || '-'} |`);
    });
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }
  if (!args.eval_jsonl) {
    process.stderr.write('preference_adjudication_pack: missing --eval_jsonl\n');
    process.exit(2);
    return;
  }
  if (!args.manifest) {
    process.stderr.write('preference_adjudication_pack: missing --manifest\n');
    process.exit(2);
    return;
  }

  const evalJsonlPath = path.resolve(args.eval_jsonl);
  const manifestPath = path.resolve(args.manifest);
  const runId = inferRunId(args);
  const outDir = path.resolve(args.out || path.join('artifacts', `preference_round1_${runId}`, 'adjudication'));
  const labelStudioDocumentRoot = path.resolve(
    String(process.env.LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT || path.dirname(manifestPath)),
  );
  await fsp.mkdir(outDir, { recursive: true });

  const evalRows = await readJsonlRows(evalJsonlPath);
  const manifestRaw = await fsp.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const manifestRows = Array.isArray(manifest && manifest.rows) ? manifest.rows : [];
  const manifestMap = new Map();
  for (const row of manifestRows) {
    const sampleId = String(row && (row.sample_id || row.sample_hash) ? (row.sample_id || row.sample_hash) : '').trim();
    if (!sampleId) continue;
    manifestMap.set(sampleId, row);
  }

  const ranked = [...evalRows]
    .map((row) => {
      const sampleId = String(row && (row.sample_id || row.sample_hash) ? (row.sample_id || row.sample_hash) : '').trim();
      return {
        ...row,
        sample_id: sampleId,
        score: buildContentiousScore(row),
      };
    })
    .filter((row) => row.sample_id)
    .sort((a, b) => {
      const scoreDelta = Number(b.score || 0) - Number(a.score || 0);
      if (Math.abs(scoreDelta) > 1e-9) return scoreDelta;
      const cannotDelta = Number(b.cannot_tell_rate || 0) - Number(a.cannot_tell_rate || 0);
      if (Math.abs(cannotDelta) > 1e-9) return cannotDelta;
      const disagreementDelta = Number(b.disagreement_rate || 0) - Number(a.disagreement_rate || 0);
      if (Math.abs(disagreementDelta) > 1e-9) return disagreementDelta;
      return String(a.sample_id).localeCompare(String(b.sample_id));
    });

  const selected = [];
  const excluded = [];

  for (const row of ranked) {
    if (selected.length >= args.limit) break;
    const manifestRow = manifestMap.get(row.sample_id);
    if (!manifestRow) {
      excluded.push({ sample_id: row.sample_id, source: row.source || 'unknown', reason: 'missing_manifest_row' });
      continue;
    }

    const overlays = resolveOverlayPaths(manifestRow);
    if (!overlays.baseline_path || !overlays.variant1_path) {
      excluded.push({ sample_id: row.sample_id, source: row.source || manifestRow.source || 'unknown', reason: 'missing_overlay_paths' });
      continue;
    }

    const task = toTask(row, manifestRow, overlays, labelStudioDocumentRoot);
    selected.push({
      sample_id: row.sample_id,
      source: row.source || manifestRow.source || 'unknown',
      score: row.score,
      reasons: task.data.adjudication_reasons,
      task,
    });
  }

  const tasks = selected.map((row) => row.task);
  const tasksPath = path.join(outDir, 'tasks.json');
  const manifestOutPath = path.join(outDir, 'manifest.json');
  const previewPath = path.join(outDir, 'preview.md');

  await fsp.writeFile(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  await fsp.writeFile(manifestOutPath, `${JSON.stringify({
    schema_version: 'aurora.preference_adjudication.v1',
    run_id: runId,
    generated_at: new Date().toISOString(),
    inputs: {
      eval_jsonl: toPosix(path.relative(process.cwd(), evalJsonlPath)),
      manifest: toPosix(path.relative(process.cwd(), manifestPath)),
    },
    selected_total: selected.length,
    excluded_total: excluded.length,
    rows: selected.map((row) => row.task.meta),
    excluded,
    artifacts: {
      tasks_json: toPosix(path.relative(process.cwd(), tasksPath)),
      preview_md: toPosix(path.relative(process.cwd(), previewPath)),
    },
  }, null, 2)}\n`, 'utf8');
  await fsp.writeFile(previewPath, renderPreview({ runId, selected, excluded }), 'utf8');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    selected_total: selected.length,
    excluded_total: excluded.length,
    artifacts: {
      tasks_json: toPosix(path.relative(process.cwd(), tasksPath)),
      manifest_json: toPosix(path.relative(process.cwd(), manifestOutPath)),
      preview_md: toPosix(path.relative(process.cwd(), previewPath)),
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`preference_adjudication_pack_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
