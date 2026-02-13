#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import { runTimestampKey } from './internal_batch_helpers.mjs';

const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_LIMIT = 200;
const DEFAULT_BUCKET_N = 60;
const DEFAULT_DOUBLE_ANNOTATE_RATIO = 0.1;
const DEFAULT_GUIDE = path.join('docs', 'GOLD_LABELING_GUIDE.md');
const DEFAULT_SEED = 'gold_round1_real_seed_v1';

const HELP_TEXT = `gold_round1_runbook.mjs

Usage:
  node scripts/gold_round1_runbook.mjs --review_jsonl <path> [options]

Options:
  --run_id <id>                    round id (default: infer from review filename or utc timestamp)
  --review_jsonl <path>            review_pack_mixed input used for task pack generation
  --out <dir>                      round1 pack output dir (default: artifacts/gold_round1_real_<run_id>)
  --report_dir <dir>               runbook output dir (default: reports)
  --guide <path>                   labeling guide path (default: docs/GOLD_LABELING_GUIDE.md)
  --limit <n>                      target sample size for pack command (default: 200)
  --bucket_n <n>                   per-bucket external sample count (default: 60)
  --double_annotate_ratio <0-1>    default double-annotation pool ratio (default: 0.1)
  --seed <token>                   seed used in pack command (default: gold_round1_real_seed_v1)
  --help                           show help
`;

function parseNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function parseArgs(argv) {
  const out = {
    help: false,
    run_id: process.env.RUN_ID || '',
    review_jsonl: process.env.REVIEW_JSONL || '',
    out: process.env.OUT || '',
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    guide: process.env.GOLD_LABELING_GUIDE || DEFAULT_GUIDE,
    limit: process.env.LIMIT || DEFAULT_LIMIT,
    bucket_n: process.env.BUCKET_N || DEFAULT_BUCKET_N,
    double_annotate_ratio: process.env.DOUBLE_ANNOTATE_RATIO || DEFAULT_DOUBLE_ANNOTATE_RATIO,
    seed: process.env.GOLD_ROUND1_SEED || DEFAULT_SEED,
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
    if (!next || String(next).startsWith('--')) continue;
    out[key] = String(next);
    i += 1;
  }
  out.run_id = String(out.run_id || '').trim();
  out.review_jsonl = String(out.review_jsonl || '').trim();
  out.out = String(out.out || '').trim();
  out.report_dir = String(out.report_dir || DEFAULT_REPORT_DIR).trim() || DEFAULT_REPORT_DIR;
  out.guide = String(out.guide || DEFAULT_GUIDE).trim() || DEFAULT_GUIDE;
  out.limit = parseNumber(out.limit, DEFAULT_LIMIT, 1, 5000);
  out.bucket_n = parseNumber(out.bucket_n, DEFAULT_BUCKET_N, 1, 2000);
  out.double_annotate_ratio = Math.max(0, Math.min(1, Number(out.double_annotate_ratio) || DEFAULT_DOUBLE_ANNOTATE_RATIO));
  out.seed = String(out.seed || DEFAULT_SEED).trim() || DEFAULT_SEED;
  return out;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  const token = path.basename(String(args.review_jsonl || ''));
  const match = token.match(/review_pack_mixed_(\d{15}|\d{8}_\d{6,9})\.(jsonl|ndjson|csv)$/i);
  if (match) return match[1];
  return runTimestampKey();
}

function buildRunbook({
  runId,
  reviewRel,
  outRel,
  reportRel,
  guideRel,
  limit,
  bucketN,
  doubleAnnotateRatio,
  seed,
}) {
  const exportName = `label_studio_export_round1_${runId}.json`;
  return `# Gold Round1 Human Labeling Runbook

- run_id: ${runId}
- generated_at: ${new Date().toISOString()}
- review_jsonl: \`${reviewRel || '-'}\`
- out_dir: \`${outRel}\`
- report_path: \`${reportRel}\`
- guide: \`${guideRel}\`

## 1) Build Round1 Real Seed Pack

\`\`\`bash
make gold-round1-real-pack \\
  RUN_ID=${runId} \\
  REVIEW_JSONL=${reviewRel || '<reports/review_pack_mixed_<run_id>.jsonl>'} \\
  OUT=${outRel} \\
  LIMIT=${limit} \\
  BUCKET_N=${bucketN} \\
  DOUBLE_ANNOTATE_RATIO=${doubleAnnotateRatio} \\
  GOLD_ROUND1_SEED=${seed}
\`\`\`

Expected artifacts:
- \`${outRel}/tasks.json\`
- \`${outRel}/manifest.json\`
- \`${outRel}/preview.md\`

## 2) Label Studio Import

1. Open local Label Studio project configured with \`label_studio/project_oval_skin.xml\`.
2. Import \`${outRel}/tasks.json\`.
3. Confirm task metadata includes \`metadata.double_annotate\` and \`data.double_annotate\`.

## 3) Labeling Rules

Use \`${guideRel}\` section "Round1 真实标注规范".

Mandatory reminders:
- Forehead boundary must exclude hair strands/hairline spill.
- Under-eye only draw lower-eye skin band; do not include sclera/lashes/brow shadow.
- Keep strong GT modules consistent: nose / forehead / left_cheek / right_cheek / chin.

## 4) Double-Annotate Subset Workflow (IAA)

1. Filter tasks where \`metadata.double_annotate=true\`.
2. Assign these tasks to annotator B (annotator A already labels full set).
3. Do not expose annotator A polygons to annotator B.
4. Export must retain two annotations under same task id for the double-annotate subset.

## 5) Export Convention (Round1)

Export JSON from Label Studio with annotation metadata included:
- annotator/user field
- annotation id
- created_at / updated_at
- task id

File naming:
- \`${exportName}\`

Recommended path:
- \`artifacts/gold_round1_real_${runId}/${exportName}\`

## 6) Import + Eval + AB + IAA + Gate

\`\`\`bash
make gold-label-import ROUND1_IN=artifacts/gold_round1_real_${runId}/${exportName} OUT=artifacts/gold_round1_real_${runId}/gold_labels.ndjson
make eval-gold-round1 GOLD_LABELS=artifacts/gold_round1_real_${runId}/gold_labels.ndjson PRED_JSONL=${reviewRel || '<review_jsonl>'}
make eval-gold-ab GOLD_LABELS=artifacts/gold_round1_real_${runId}/gold_labels.ndjson PRED_JSONL=${reviewRel || '<review_jsonl>'}
make eval-gold-iaa RUN_ID=${runId} LS_EXPORT=artifacts/gold_round1_real_${runId}/${exportName}
make eval-circle-crossset LIMIT=150
make release-gate-circle RUN_ID=${runId} LS_EXPORT=artifacts/gold_round1_real_${runId}/${exportName} REVIEW_JSONL=${reviewRel || '<review_jsonl>'} LIMIT=150
\`\`\`
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }
  if (!args.review_jsonl) {
    process.stderr.write('gold_round1_runbook: missing --review_jsonl (or REVIEW_JSONL)\n');
    process.exit(2);
    return;
  }
  const runId = inferRunId(args);
  const outDir = path.resolve(args.out || path.join('artifacts', `gold_round1_real_${runId}`));
  const reportDir = path.resolve(args.report_dir);
  const runbookPath = path.join(reportDir, `gold_round1_runbook_${runId}.md`);
  const reviewPath = path.resolve(args.review_jsonl);
  const guidePath = path.resolve(args.guide);

  await fsp.mkdir(path.dirname(runbookPath), { recursive: true });
  const content = buildRunbook({
    runId,
    reviewRel: toPosix(path.relative(process.cwd(), reviewPath)),
    outRel: toPosix(path.relative(process.cwd(), outDir)),
    reportRel: toPosix(path.relative(process.cwd(), runbookPath)),
    guideRel: toPosix(path.relative(process.cwd(), guidePath)),
    limit: args.limit,
    bucketN: args.bucket_n,
    doubleAnnotateRatio: args.double_annotate_ratio,
    seed: args.seed,
  });
  await fsp.writeFile(runbookPath, content, 'utf8');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    runbook_md: toPosix(path.relative(process.cwd(), runbookPath)),
    out_dir: toPosix(path.relative(process.cwd(), outDir)),
    review_jsonl: toPosix(path.relative(process.cwd(), reviewPath)),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`gold_round1_runbook_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});

