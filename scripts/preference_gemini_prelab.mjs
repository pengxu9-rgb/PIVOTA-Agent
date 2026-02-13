#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { runTimestampKey, sha256Hex } from './internal_batch_helpers.mjs';
import { toPosix } from './local_image_loader.mjs';

const require = createRequire(import.meta.url);
const { generateMultiImageJsonFromGemini } = require('../src/layer1/llm/geminiMultiClient');

const MODULE_IDS = Object.freeze([
  'nose',
  'forehead',
  'left_cheek',
  'right_cheek',
  'chin',
  'under_eye_left',
  'under_eye_right',
]);

const STRONG_MODULES = Object.freeze([
  'nose',
  'forehead',
  'left_cheek',
  'right_cheek',
  'chin',
]);

const ALLOWED_REASONS = Object.freeze([
  'hairline_forehead_ambiguous',
  'occlusion_or_shadow',
  'blur_or_low_res',
  'modules_too_small',
  'overall_similar',
]);

const DEFAULTS = Object.freeze({
  model: 'gemini-2.5-pro',
  concurrency: 2,
  review_ratio: 0.2,
  max_samples: 0,
  seed: 'preference_gemini_prelab_seed_v1',
  report_dir: 'reports',
  confidence_review_max: 2,
  mock: false,
});

const HELP_TEXT = `preference_gemini_prelab.mjs

Usage:
  node scripts/preference_gemini_prelab.mjs --tasks <tasks.json> --manifest <manifest.json> [options]

Required:
  --tasks <path>                          preference tasks json (tasks_all/tasks_batch_*.json)
  --manifest <path>                       preference manifest json

Options:
  --run_id <id>                           run id (default: infer from input path)
  --out <path>                            output ndjson (default: artifacts/preference_round1_<run_id>/preference_labels_gemini.ndjson)
  --review_out <path>                     output review tasks json (default: artifacts/preference_round1_<run_id>/tasks_review_gemini.json)
  --summary_out <path>                    output summary json (default: reports/preference_gemini_prelab_<run_id>.json)
  --report_dir <dir>                      output report dir for summary/md (default: reports)
  --model <name>                          Gemini model (default: gemini-2.5-pro)
  --rater_id <id>                         synthetic rater id (default: gemini_<model>)
  --concurrency <n>                       request concurrency (default: 2)
  --review_ratio <0-1>                    random audit ratio from high-confidence samples (default: 0.2)
  --confidence_review_max <n>             auto-review when confidence <= n (default: 2)
  --max_samples <n>                       max samples to process, 0 means all (default: 0)
  --seed <token>                          deterministic seed for audit subset (default: preference_gemini_prelab_seed_v1)
  --mock <bool>                           deterministic mock mode without API calls (default: false)
  --help                                  show help

Environment:
  GEMINI_API_KEY is required unless --mock=true.
`;

const GeminiChoiceSchema = z.enum(['A', 'B', 'tie', 'cannot_tell']);
const GeminiOutputSchema = z.object({
  overall_choice: GeminiChoiceSchema,
  confidence_int: z.number().int().min(1).max(5),
  reasons: z.array(z.enum(ALLOWED_REASONS)).max(5).optional().default([]),
  notes: z.string().max(280).optional().default(''),
  per_module_choice: z.object({
    nose: GeminiChoiceSchema.optional(),
    forehead: GeminiChoiceSchema.optional(),
    left_cheek: GeminiChoiceSchema.optional(),
    right_cheek: GeminiChoiceSchema.optional(),
    chin: GeminiChoiceSchema.optional(),
    under_eye_left: GeminiChoiceSchema.optional(),
    under_eye_right: GeminiChoiceSchema.optional(),
  }).optional().default({}),
}).strict();

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

function splitCsv(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    help: false,
    tasks: process.env.TASKS || '',
    manifest: process.env.MANIFEST || process.env.PREFERENCE_MANIFEST || '',
    run_id: process.env.RUN_ID || '',
    out: process.env.OUT || '',
    review_out: process.env.REVIEW_OUT || '',
    summary_out: process.env.SUMMARY_OUT || '',
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULTS.report_dir,
    model: process.env.GEMINI_MODEL || DEFAULTS.model,
    rater_id: process.env.RATER_ID || '',
    concurrency: process.env.CONCURRENCY || DEFAULTS.concurrency,
    review_ratio: process.env.REVIEW_RATIO || DEFAULTS.review_ratio,
    confidence_review_max: process.env.CONFIDENCE_REVIEW_MAX || DEFAULTS.confidence_review_max,
    max_samples: process.env.MAX_SAMPLES || DEFAULTS.max_samples,
    seed: process.env.PREFERENCE_SEED || DEFAULTS.seed,
    mock: process.env.MOCK || DEFAULTS.mock,
  };

  const aliasMap = {
    tasks: 'tasks',
    manifest: 'manifest',
    run_id: 'run_id',
    runid: 'run_id',
    out: 'out',
    review_out: 'review_out',
    summary_out: 'summary_out',
    report_dir: 'report_dir',
    model: 'model',
    rater_id: 'rater_id',
    concurrency: 'concurrency',
    review_ratio: 'review_ratio',
    confidence_review_max: 'confidence_review_max',
    max_samples: 'max_samples',
    seed: 'seed',
    mock: 'mock',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eqIndex = body.indexOf('=');
    let keyRaw = body;
    let value = null;
    if (eqIndex >= 0) {
      keyRaw = body.slice(0, eqIndex);
      value = body.slice(eqIndex + 1);
    }
    const key = aliasMap[String(keyRaw || '').trim().toLowerCase()];
    if (!key) continue;
    if (value == null) {
      const next = argv[i + 1];
      if (!next || String(next).startsWith('--')) {
        out[key] = 'true';
        continue;
      }
      out[key] = String(next);
      i += 1;
    } else {
      out[key] = String(value);
    }
  }

  out.help = parseBool(out.help, false);
  out.tasks = String(out.tasks || '').trim();
  out.manifest = String(out.manifest || '').trim();
  out.run_id = String(out.run_id || '').trim();
  out.out = String(out.out || '').trim();
  out.review_out = String(out.review_out || '').trim();
  out.summary_out = String(out.summary_out || '').trim();
  out.report_dir = String(out.report_dir || DEFAULTS.report_dir).trim() || DEFAULTS.report_dir;
  out.model = String(out.model || DEFAULTS.model).trim() || DEFAULTS.model;
  out.rater_id = String(out.rater_id || '').trim();
  out.concurrency = Math.max(1, Math.min(16, Math.trunc(parseNumber(out.concurrency, DEFAULTS.concurrency, 1, 16))));
  out.review_ratio = parseNumber(out.review_ratio, DEFAULTS.review_ratio, 0, 1);
  out.confidence_review_max = Math.max(1, Math.min(5, Math.trunc(parseNumber(out.confidence_review_max, DEFAULTS.confidence_review_max, 1, 5))));
  out.max_samples = Math.max(0, Math.min(50000, Math.trunc(parseNumber(out.max_samples, DEFAULTS.max_samples, 0, 50000))));
  out.seed = String(out.seed || DEFAULTS.seed).trim() || DEFAULTS.seed;
  out.mock = parseBool(out.mock, DEFAULTS.mock);
  return out;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  for (const token of [args.tasks, args.manifest, args.out]) {
    const base = path.basename(String(token || ''));
    const match = base.match(/(\d{15}|\d{8}_\d{6,9})/);
    if (match) return match[1];
  }
  return runTimestampKey();
}

function toChoice(raw) {
  const token = String(raw || '').trim();
  if (token === 'A' || token === 'B' || token === 'tie' || token === 'cannot_tell') return token;
  return null;
}

function normalizeWinnerFromRole(choiceRaw, roleA, roleB) {
  const choice = toChoice(choiceRaw);
  if (!choice) return null;
  if (choice === 'tie' || choice === 'cannot_tell') return choice;
  const a = String(roleA || '').trim().toLowerCase();
  const b = String(roleB || '').trim().toLowerCase();
  if (choice === 'A') {
    if (a === 'baseline') return 'baseline';
    if (a === 'variant') return 'variant1';
  } else if (choice === 'B') {
    if (b === 'baseline') return 'baseline';
    if (b === 'variant') return 'variant1';
  }
  return null;
}

function deterministicSort(items, seed, keyFn) {
  return [...items].sort((a, b) => {
    const ka = String(keyFn(a));
    const kb = String(keyFn(b));
    const ha = sha256Hex(`${seed}:${ka}`);
    const hb = sha256Hex(`${seed}:${kb}`);
    if (ha === hb) return ka.localeCompare(kb);
    return ha.localeCompare(hb);
  });
}

function mapPool(items, worker, concurrency) {
  const out = new Array(items.length);
  let cursor = 0;
  async function loop() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx], idx);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => loop());
  return Promise.all(runners).then(() => out);
}

function buildPrompt(taskRow) {
  const sampleId = String(taskRow.sample_id || taskRow.sample_hash || '').trim();
  const source = String(taskRow.source || 'unknown').trim();
  const hint = [
    'You are labeling A/B overlay accuracy for Aurora face modules.',
    'Compare Overlay A vs Overlay B on the same face image.',
    'Choose which overlay is more accurate for visible skin module boundaries.',
    'If effectively the same, choose tie. If impossible to judge, choose cannot_tell.',
    'Focus on forehead hairline boundaries and cheek/nose/chin edges.',
    'Return JSON only.',
  ].join(' ');
  const jsonFormat = [
    '{',
    '"overall_choice":"A|B|tie|cannot_tell",',
    '"confidence_int":1-5,',
    `"reasons":[${ALLOWED_REASONS.map((x) => `"${x}"`).join(',')}],`,
    '"notes":"short reason",',
    '"per_module_choice":{',
    '"nose":"A|B|tie|cannot_tell",',
    '"forehead":"A|B|tie|cannot_tell",',
    '"left_cheek":"A|B|tie|cannot_tell",',
    '"right_cheek":"A|B|tie|cannot_tell",',
    '"chin":"A|B|tie|cannot_tell",',
    '"under_eye_left":"A|B|tie|cannot_tell",',
    '"under_eye_right":"A|B|tie|cannot_tell"',
    '}',
    '}',
  ].join('\n');
  return `${hint}\n\nContext: sample_id=${sampleId} source=${source}\n\nJSON schema output:\n${jsonFormat}`;
}

function pickReasons(reasonsRaw) {
  const arr = Array.isArray(reasonsRaw) ? reasonsRaw : [];
  return arr
    .map((item) => String(item || '').trim())
    .filter((item) => ALLOWED_REASONS.includes(item));
}

function deriveMockOutput(taskRow) {
  const diff = Number(taskRow.overlay_diff_ratio || 0);
  const focus = String(taskRow.overlay_focus_module || '').trim().toLowerCase();
  if (!Number.isFinite(diff) || diff < 0.01) {
    return {
      overall_choice: 'tie',
      confidence_int: 2,
      reasons: ['overall_similar'],
      notes: 'low separability in overlay',
      per_module_choice: {
        forehead: 'tie',
        nose: 'tie',
        left_cheek: 'tie',
        right_cheek: 'tie',
        chin: 'tie',
      },
    };
  }

  const pickA = sha256Hex(`${taskRow.sample_id}:mock`).charCodeAt(0) % 2 === 0;
  const prefer = pickA ? 'A' : 'B';
  const reasons = [];
  if (focus === 'forehead') reasons.push('hairline_forehead_ambiguous');
  return {
    overall_choice: prefer,
    confidence_int: 4,
    reasons: reasons.length ? reasons : ['overall_similar'],
    notes: `mock preference via diff=${round3(diff)}`,
    per_module_choice: {
      forehead: prefer,
      nose: 'tie',
      left_cheek: 'tie',
      right_cheek: 'tie',
      chin: 'tie',
    },
  };
}

function chooseReviewSubset(labelRows, taskMap, args) {
  const autoReview = [];
  const highConfidence = [];
  for (const row of labelRows) {
    const winner = String(row.winner || '');
    const confidenceInt = Number(row.confidence_int || 0);
    const reasons = Array.isArray(row.reasons) ? row.reasons : [];
    const diff = Number(row.risk_features && row.risk_features.overlay_diff_ratio);
    const needsReview = (
      winner === 'cannot_tell'
      || winner === 'tie'
      || confidenceInt <= args.confidence_review_max
      || reasons.includes('overall_similar')
      || (Number.isFinite(diff) && diff < 0.01)
    );
    if (needsReview) {
      autoReview.push(row);
    } else {
      highConfidence.push(row);
    }
  }

  const targetAudit = Math.max(0, Math.round(highConfidence.length * args.review_ratio));
  const sortedAudit = deterministicSort(highConfidence, `${args.seed}:audit`, (row) => row.sample_id).slice(0, targetAudit);
  const selected = new Map();
  for (const row of [...autoReview, ...sortedAudit]) selected.set(row.sample_id, row);

  const tasks = [...selected.keys()]
    .map((sampleId) => taskMap.get(sampleId))
    .filter(Boolean);

  return {
    tasks,
    sample_ids: tasks.map((task) => String(task && task.data && task.data.sample_id || '')).filter(Boolean),
    auto_review_count: autoReview.length,
    audit_count: sortedAudit.length,
  };
}

function sanitizeRaterId(model, explicit) {
  const direct = String(explicit || '').trim();
  if (direct) return direct;
  const token = String(model || 'gemini').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `gemini_${token || 'auto'}`;
}

function renderSummaryMarkdown({
  runId,
  args,
  tasksPathRel,
  manifestPathRel,
  outPathRel,
  reviewOutRel,
  summary,
}) {
  const lines = [];
  lines.push('# Preference Gemini Prelabel');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- tasks: \`${tasksPathRel}\``);
  lines.push(`- manifest: \`${manifestPathRel}\``);
  lines.push(`- out_labels: \`${outPathRel}\``);
  lines.push(`- review_tasks: \`${reviewOutRel}\``);
  lines.push(`- model: ${args.model}`);
  lines.push(`- mock: ${args.mock ? 'true' : 'false'}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---:|');
  lines.push(`| samples_total | ${summary.samples_total} |`);
  lines.push(`| success_count | ${summary.success_count} |`);
  lines.push(`| error_count | ${summary.error_count} |`);
  lines.push(`| baseline_votes | ${summary.baseline_votes} |`);
  lines.push(`| variant1_votes | ${summary.variant1_votes} |`);
  lines.push(`| tie_votes | ${summary.tie_votes} |`);
  lines.push(`| cannot_tell_votes | ${summary.cannot_tell_votes} |`);
  lines.push(`| avg_confidence_int | ${summary.avg_confidence_int ?? '-'} |`);
  lines.push(`| review_samples | ${summary.review_samples} |`);
  lines.push(`| review_auto | ${summary.review_auto} |`);
  lines.push(`| review_audit | ${summary.review_audit} |`);
  lines.push('');
  lines.push('## Errors (Top 20)');
  lines.push('');
  lines.push('| rank | sample_id | error_code | error_message |');
  lines.push('|---:|---|---|---|');
  if (!summary.errors.length) {
    lines.push('| 1 | - | - | - |');
  } else {
    summary.errors.slice(0, 20).forEach((row, idx) => {
      lines.push(`| ${idx + 1} | ${row.sample_id} | ${row.error_code || '-'} | ${String(row.error_message || '').replace(/\|/g, '/').slice(0, 120) || '-'} |`);
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
  if (!args.tasks) {
    process.stderr.write('preference_gemini_prelab: missing --tasks\n');
    process.exit(2);
    return;
  }
  if (!args.manifest) {
    process.stderr.write('preference_gemini_prelab: missing --manifest\n');
    process.exit(2);
    return;
  }
  if (!args.mock && !String(process.env.GEMINI_API_KEY || '').trim()) {
    process.stderr.write('preference_gemini_prelab: GEMINI_API_KEY is required unless --mock=true\n');
    process.exit(2);
    return;
  }

  const runId = inferRunId(args);
  const tasksPath = path.resolve(args.tasks);
  const manifestPath = path.resolve(args.manifest);
  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });

  const outPath = path.resolve(
    args.out
    || path.join('artifacts', `preference_round1_${runId}`, 'preference_labels_gemini.ndjson'),
  );
  const reviewOutPath = path.resolve(
    args.review_out
    || path.join('artifacts', `preference_round1_${runId}`, 'tasks_review_gemini.json'),
  );
  const summaryJsonPath = path.resolve(
    args.summary_out
    || path.join(reportDir, `preference_gemini_prelab_${runId}.json`),
  );
  const summaryMdPath = path.resolve(path.join(reportDir, `preference_gemini_prelab_${runId}.md`));

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.mkdir(path.dirname(reviewOutPath), { recursive: true });
  await fsp.mkdir(path.dirname(summaryJsonPath), { recursive: true });

  const [tasksRaw, manifestRaw] = await Promise.all([
    fsp.readFile(tasksPath, 'utf8'),
    fsp.readFile(manifestPath, 'utf8'),
  ]);
  const tasks = Array.isArray(JSON.parse(tasksRaw)) ? JSON.parse(tasksRaw) : [];
  const manifest = JSON.parse(manifestRaw);
  const manifestRows = Array.isArray(manifest && manifest.rows) ? manifest.rows : [];
  const manifestBySample = new Map();
  for (const row of manifestRows) {
    const sampleId = String(row && (row.sample_id || row.sample_hash) ? (row.sample_id || row.sample_hash) : '').trim();
    if (!sampleId) continue;
    manifestBySample.set(sampleId, row);
  }

  const sortedTasks = deterministicSort(tasks, `${args.seed}:tasks`, (task) => {
    const sampleId = String(task && task.data && (task.data.sample_id || task.data.sample_hash) ? (task.data.sample_id || task.data.sample_hash) : '').trim();
    return sampleId || String(task && task.id || '');
  });

  const selectedTasks = args.max_samples > 0 ? sortedTasks.slice(0, args.max_samples) : sortedTasks;
  const raterId = sanitizeRaterId(args.model, args.rater_id);
  const nowIso = new Date().toISOString();

  const taskMap = new Map();
  for (const task of selectedTasks) {
    const sampleId = String(task && task.data && (task.data.sample_id || task.data.sample_hash) ? (task.data.sample_id || task.data.sample_hash) : '').trim();
    if (!sampleId) continue;
    taskMap.set(sampleId, task);
  }

  const results = await mapPool(selectedTasks, async (task, idx) => {
    const data = task && task.data && typeof task.data === 'object' ? task.data : {};
    const sampleId = String(data.sample_id || data.sample_hash || '').trim();
    if (!sampleId) {
      return {
        ok: false,
        sample_id: `unknown_${idx}`,
        error_code: 'MISSING_SAMPLE_ID',
        error_message: 'missing sample_id/sample_hash in task data',
      };
    }

    const imageAPath = path.resolve(String(data.image_a_path || ''));
    const imageBPath = path.resolve(String(data.image_b_path || ''));
    if (!fs.existsSync(imageAPath) || !fs.existsSync(imageBPath)) {
      return {
        ok: false,
        sample_id: sampleId,
        error_code: 'MISSING_IMAGE_PATH',
        error_message: 'image_a_path/image_b_path not found',
      };
    }

    const roleA = String(data.role_a || 'baseline').trim().toLowerCase();
    const roleB = String(data.role_b || 'variant').trim().toLowerCase();
    const manifestRow = manifestBySample.get(sampleId) || {};
    const riskFeatures = data && typeof data.risk_features === 'object' && data.risk_features
      ? data.risk_features
      : (manifestRow && typeof manifestRow.risk_features === 'object' ? manifestRow.risk_features : {});
    const overlayFocusModule = String(data.overlay_focus_module || manifestRow.overlay_focus_module || '').trim() || null;
    const overlayDiffRatio = Number(
      data.overlay_diff_ratio != null
        ? data.overlay_diff_ratio
        : (riskFeatures && (riskFeatures.overlay_diff_ratio ?? riskFeatures.diff_ratio ?? riskFeatures.overlayDiffRatio)),
    );

    let parsed;
    if (args.mock) {
      parsed = deriveMockOutput({
        sample_id: sampleId,
        overlay_diff_ratio: Number.isFinite(overlayDiffRatio) ? overlayDiffRatio : 0,
        overlay_focus_module: overlayFocusModule || '',
      });
    } else {
      const promptText = buildPrompt({
        sample_id: sampleId,
        sample_hash: data.sample_hash || sampleId,
        source: data.source || manifestRow.source || 'unknown',
      });
      const resp = await generateMultiImageJsonFromGemini({
        promptText,
        images: [
          { label: 'Overlay A', imagePath: imageAPath },
          { label: 'Overlay B', imagePath: imageBPath },
        ],
        schema: GeminiOutputSchema,
      });
      if (!resp || !resp.ok) {
        return {
          ok: false,
          sample_id: sampleId,
          error_code: String(resp && resp.error && resp.error.code ? resp.error.code : 'GEMINI_REQUEST_FAILED'),
          error_message: String(resp && resp.error && resp.error.message ? resp.error.message : 'gemini request failed'),
        };
      }
      parsed = resp.value;
    }

    const winner = normalizeWinnerFromRole(parsed.overall_choice, roleA, roleB);
    if (!winner) {
      return {
        ok: false,
        sample_id: sampleId,
        error_code: 'INVALID_OVERALL_CHOICE',
        error_message: `cannot map overall_choice=${parsed.overall_choice} via roles role_a=${roleA} role_b=${roleB}`,
      };
    }

    const perModule = {};
    for (const moduleId of MODULE_IDS) {
      const rawChoice = parsed && parsed.per_module_choice ? parsed.per_module_choice[moduleId] : null;
      const mapped = rawChoice ? normalizeWinnerFromRole(rawChoice, roleA, roleB) : null;
      perModule[moduleId] = mapped;
    }

    const confidenceInt = Math.max(1, Math.min(5, Math.trunc(Number(parsed.confidence_int) || 1)));
    const annotationId = `gemini_${sha256Hex(`${sampleId}:${args.model}:${idx}`).slice(0, 16)}`;

    const row = {
      schema_version: 'aurora.preference_labels.v1',
      run_id: runId,
      sample_id: sampleId,
      sample_hash: sampleId,
      source: String(data.source || manifestRow.source || 'unknown').trim().toLowerCase() || 'unknown',
      winner,
      overall_choice: winner,
      overall_choice_raw: parsed.overall_choice,
      confidence: round3(confidenceInt / 5),
      confidence_int: confidenceInt,
      reasons: pickReasons(parsed.reasons),
      notes: String(parsed.notes || '').trim() || null,
      per_module_choice: perModule,
      rater_id: raterId,
      annotator_id: raterId,
      annotation_id: annotationId,
      created_at: nowIso,
      updated_at: nowIso,
      task_batch: String(data.task_batch || manifestRow.task_batch || '').trim().toUpperCase() || null,
      source_export_file: `gemini://${args.model}`,
      decision_source: 'gemini',
      is_model_label: true,
      model_provider: 'gemini',
      model_name: args.model,
      has_required_fields: Boolean(sampleId && winner && raterId),
      invalid_choice_count: 0,
      risk_features: {
        hair_overlap_est: Number(riskFeatures && (riskFeatures.hair_overlap_est ?? riskFeatures.forehead_hair_overlap_rate)),
        leakage_bg_est_mean: Number(riskFeatures && riskFeatures.leakage_bg_est_mean),
        min_module_pixels: Number(riskFeatures && riskFeatures.min_module_pixels),
        overlay_diff_pixels: Number(riskFeatures && (riskFeatures.overlay_diff_pixels ?? riskFeatures.diff_pixels ?? riskFeatures.overlayDiffPixels)),
        overlay_diff_ratio: Number.isFinite(overlayDiffRatio) ? round3(overlayDiffRatio) : null,
        overlay_focus_module: overlayFocusModule,
      },
      module_id: 'overall',
    };

    for (const key of ['hair_overlap_est', 'leakage_bg_est_mean', 'min_module_pixels', 'overlay_diff_pixels']) {
      if (!Number.isFinite(row.risk_features[key])) row.risk_features[key] = null;
      else if (key === 'min_module_pixels' || key === 'overlay_diff_pixels') row.risk_features[key] = Math.max(0, Math.trunc(row.risk_features[key]));
      else row.risk_features[key] = round3(row.risk_features[key]);
    }

    return { ok: true, row };
  }, args.concurrency);

  const labelRows = [];
  const errors = [];
  for (const item of results) {
    if (item && item.ok && item.row) labelRows.push(item.row);
    else if (item) errors.push(item);
  }

  const orderedRows = deterministicSort(labelRows, `${args.seed}:labels`, (row) => row.sample_id);
  const review = chooseReviewSubset(orderedRows, taskMap, args);

  const counts = {
    baseline_votes: orderedRows.filter((row) => row.winner === 'baseline').length,
    variant1_votes: orderedRows.filter((row) => row.winner === 'variant1').length,
    tie_votes: orderedRows.filter((row) => row.winner === 'tie').length,
    cannot_tell_votes: orderedRows.filter((row) => row.winner === 'cannot_tell').length,
  };
  const avgConfidenceInt = orderedRows.length
    ? round3(orderedRows.reduce((acc, row) => acc + Number(row.confidence_int || 0), 0) / orderedRows.length)
    : null;

  const summary = {
    ok: true,
    run_id: runId,
    generated_at: new Date().toISOString(),
    model: args.model,
    mock: args.mock,
    samples_total: selectedTasks.length,
    success_count: orderedRows.length,
    error_count: errors.length,
    baseline_votes: counts.baseline_votes,
    variant1_votes: counts.variant1_votes,
    tie_votes: counts.tie_votes,
    cannot_tell_votes: counts.cannot_tell_votes,
    avg_confidence_int: avgConfidenceInt,
    review_samples: review.sample_ids.length,
    review_auto: review.auto_review_count,
    review_audit: review.audit_count,
    errors: errors.map((row) => ({
      sample_id: row.sample_id || null,
      error_code: row.error_code || 'UNKNOWN',
      error_message: row.error_message || null,
    })),
    artifacts: {
      tasks: toPosix(path.relative(process.cwd(), tasksPath)),
      manifest: toPosix(path.relative(process.cwd(), manifestPath)),
      labels_ndjson: toPosix(path.relative(process.cwd(), outPath)),
      review_tasks_json: toPosix(path.relative(process.cwd(), reviewOutPath)),
      summary_json: toPosix(path.relative(process.cwd(), summaryJsonPath)),
      summary_md: toPosix(path.relative(process.cwd(), summaryMdPath)),
    },
  };

  const summaryMd = renderSummaryMarkdown({
    runId,
    args,
    tasksPathRel: summary.artifacts.tasks,
    manifestPathRel: summary.artifacts.manifest,
    outPathRel: summary.artifacts.labels_ndjson,
    reviewOutRel: summary.artifacts.review_tasks_json,
    summary,
  });

  const ndjson = orderedRows.length
    ? `${orderedRows.map((row) => JSON.stringify(row)).join('\n')}\n`
    : '';

  await Promise.all([
    fsp.writeFile(outPath, ndjson, 'utf8'),
    fsp.writeFile(reviewOutPath, `${JSON.stringify(review.tasks, null, 2)}\n`, 'utf8'),
    fsp.writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
    fsp.writeFile(summaryMdPath, summaryMd, 'utf8'),
  ]);

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`preference_gemini_prelab_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});

