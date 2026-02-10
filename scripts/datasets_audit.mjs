#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  loadRegistry,
  validateRegistryEntries,
  validateManifestObject,
  normalizeDatasetName,
  SUPPORTED_DATASETS,
} = require('./datasets_registry.js');

const DEFAULT_CACHE_DIR = path.join('datasets_cache', 'external');
const DEFAULT_REGISTRY = path.join('datasets', 'registry.yaml');
const DEFAULT_REPORT = path.join('reports', 'datasets_audit.md');

function parseArgs(argv) {
  const out = {
    cache_dir: process.env.CACHE_DIR || DEFAULT_CACHE_DIR,
    registry: process.env.REGISTRY_FILE || DEFAULT_REGISTRY,
    report: process.env.REPORT_FILE || DEFAULT_REPORT,
    datasets: process.env.DATASETS || 'all',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--cache_dir' && next) {
      out.cache_dir = next;
      i += 1;
      continue;
    }
    if (token === '--registry' && next) {
      out.registry = next;
      i += 1;
      continue;
    }
    if (token === '--report' && next) {
      out.report = next;
      i += 1;
      continue;
    }
    if (token === '--datasets' && next) {
      out.datasets = next;
      i += 1;
    }
  }

  return out;
}

function parseDatasets(raw) {
  const token = String(raw || 'all').trim().toLowerCase();
  if (!token || token === 'all') return [...SUPPORTED_DATASETS];
  const selected = [...new Set(
    token
      .split(',')
      .map((item) => normalizeDatasetName(item))
      .filter(Boolean),
  )];
  const unsupported = selected.filter((name) => !SUPPORTED_DATASETS.includes(name));
  if (unsupported.length) {
    throw new Error(`unsupported_datasets:${unsupported.join(',')}`);
  }
  return selected;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetsToAudit = parseDatasets(args.datasets);
  const repoRoot = process.cwd();
  const cacheExternalDir = path.resolve(args.cache_dir);
  const cacheRootDir = path.basename(cacheExternalDir) === 'external'
    ? path.dirname(cacheExternalDir)
    : cacheExternalDir;
  const manifestsDir = path.join(cacheRootDir, 'manifests');
  const reportPath = path.resolve(args.report);
  const registryPath = path.resolve(args.registry);

  const reportIssues = [];
  const checks = [];

  const registry = loadRegistry(registryPath);
  const registryIssues = validateRegistryEntries(registry);
  checks.push({
    name: 'registry_schema',
    ok: registryIssues.length === 0,
    detail: registryIssues.length ? registryIssues.join('; ') : `entries=${registry.datasets.length}`,
  });
  reportIssues.push(...registryIssues);

  for (const dataset of datasetsToAudit) {
    const manifestPath = path.join(manifestsDir, `${dataset}.manifest.json`);
    try {
      const manifest = await readJson(manifestPath);
      const issues = validateManifestObject(manifest, dataset);
      checks.push({
        name: `manifest_${dataset}`,
        ok: issues.length === 0,
        detail: issues.length ? issues.join(', ') : `record_count=${manifest.record_count}`,
      });
      reportIssues.push(...issues.map((it) => `${dataset}: ${it}`));
    } catch {
      checks.push({
        name: `manifest_${dataset}`,
        ok: false,
        detail: 'manifest_not_found',
      });
      reportIssues.push(`${dataset}: manifest_not_found`);
    }
  }

  const gitignorePath = path.join(repoRoot, '.gitignore');
  const gitignoreText = await fs.readFile(gitignorePath, 'utf8');
  const gitignoreChecks = [
    'datasets_cache/**',
    'outputs/datasets_debug/**',
  ];
  for (const pattern of gitignoreChecks) {
    const ok = gitignoreText.split(/\r?\n/).some((line) => line.trim() === pattern);
    checks.push({
      name: `gitignore:${pattern}`,
      ok,
      detail: ok ? 'present' : 'missing',
    });
    if (!ok) reportIssues.push(`.gitignore missing pattern: ${pattern}`);
  }

  const passed = checks.every((check) => check.ok);
  await ensureDir(path.dirname(reportPath));

  const lines = [];
  lines.push('# Datasets Audit');
  lines.push('');
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- result: **${passed ? 'PASS' : 'FAIL'}**`);
  lines.push(`- datasets_audited: ${datasetsToAudit.join(', ')}`);
  lines.push(`- registry: ${path.relative(repoRoot, registryPath)}`);
  lines.push(`- manifests_dir: ${path.relative(repoRoot, manifestsDir)}`);
  lines.push('');
  lines.push('| check | status | detail |');
  lines.push('|---|---:|---|');
  for (const check of checks) {
    lines.push(`| ${check.name} | ${check.ok ? 'PASS' : 'FAIL'} | ${check.detail} |`);
  }
  lines.push('');
  if (reportIssues.length) {
    lines.push('## Issues');
    lines.push('');
    for (const issue of reportIssues) lines.push(`- ${issue}`);
    lines.push('');
  }

  await fs.writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${reportPath}`);

  if (!passed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
