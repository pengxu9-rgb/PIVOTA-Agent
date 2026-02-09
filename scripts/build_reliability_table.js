#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  buildReliabilityTable,
  resolveVoteGateConfig,
} = require('../src/auroraBff/diagReliability');

const DEFAULT_INPUT_DIR = path.join('tmp', 'diag_pseudo_label_factory');
const DEFAULT_OUTPUT_PATH = path.join('reports', 'reliability', 'reliability.json');

function parseArgs(argv) {
  const out = {
    inPath: '',
    outPath: '',
    date: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    const next = argv[index + 1];
    if (token === '--in' && next) {
      out.inPath = String(next);
      index += 1;
      continue;
    }
    if (token === '--out' && next) {
      out.outPath = String(next);
      index += 1;
      continue;
    }
    if (token === '--date' && next) {
      out.date = String(next);
      index += 1;
    }
  }
  return out;
}

function normalizeDatePrefix(raw) {
  const token = String(raw || '').trim();
  if (!token) return '';
  if (/^\d{8}$/.test(token)) return `${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token;
  throw new Error(`invalid --date value: ${raw}`);
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_err) {
    return fallback;
  }
}

async function readNdjsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_err) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_err) {
    return [];
  }
}

function isLikelyDir(targetPath) {
  const base = path.basename(targetPath);
  return !base.includes('.');
}

async function resolvePaths({ repoRoot, inPath, outPath }) {
  const inputDir = path.resolve(repoRoot, inPath || DEFAULT_INPUT_DIR);
  const manifestPath = path.join(inputDir, 'manifest.json');
  const manifest = await readJsonSafe(manifestPath, {});
  const modelOutputsPath = path.resolve(
    inputDir,
    String(manifest?.paths?.model_outputs || manifest?.files?.model_outputs || 'model_outputs.ndjson'),
  );
  const agreementSamplesPath = path.resolve(
    inputDir,
    String(manifest?.paths?.agreement_samples || manifest?.files?.agreement_samples || 'agreement_samples.ndjson'),
  );
  const goldLabelsPath = path.resolve(
    inputDir,
    String(manifest?.paths?.gold_labels || manifest?.files?.gold_labels || 'gold_labels.ndjson'),
  );

  const requestedOut = path.resolve(repoRoot, outPath || DEFAULT_OUTPUT_PATH);
  const outputPath = isLikelyDir(requestedOut) ? path.join(requestedOut, 'reliability.json') : requestedOut;

  return {
    inputDir,
    manifestPath,
    modelOutputsPath,
    agreementSamplesPath,
    goldLabelsPath,
    outputPath,
  };
}

async function runBuildReliability(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const datePrefix = normalizeDatePrefix(options.date);
  const paths = await resolvePaths({
    repoRoot,
    inPath: options.inPath,
    outPath: options.outPath,
  });
  const modelOutputs = await readNdjsonSafe(paths.modelOutputsPath);
  const agreementSamples = await readNdjsonSafe(paths.agreementSamplesPath);
  const goldLabels = await readNdjsonSafe(paths.goldLabelsPath);

  const gateConfig = resolveVoteGateConfig();
  const table = buildReliabilityTable({
    modelOutputs,
    agreementSamples,
    goldLabels,
    datePrefix,
    gateConfig: {
      ...gateConfig,
      // Reliability build should surface potential buckets even when runtime vote stays OFF.
      voteEnabled: true,
    },
  });
  table.inputs = {
    manifest_path: paths.manifestPath,
    model_outputs_path: paths.modelOutputsPath,
    agreement_samples_path: paths.agreementSamplesPath,
    gold_labels_path: paths.goldLabelsPath,
    model_outputs_total: modelOutputs.length,
    agreement_samples_total: agreementSamples.length,
    gold_labels_total: goldLabels.length,
    runtime_vote_enabled: gateConfig.voteEnabled,
  };

  await fs.mkdir(path.dirname(paths.outputPath), { recursive: true });
  await fs.writeFile(paths.outputPath, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
  return { outputPath: paths.outputPath, table };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runBuildReliability({
    inPath: args.inPath,
    outPath: args.outPath,
    date: args.date,
  });
  process.stdout.write(`${result.outputPath}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  runBuildReliability,
};
