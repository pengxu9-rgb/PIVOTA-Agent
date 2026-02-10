'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const REQUIRED_FIELDS = Object.freeze([
  'name',
  'source_url',
  'retrieved_at',
  'license_summary',
  'legal_approved',
  'allowed_usages',
  'storage_policy',
  'notes',
]);

const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'schema_version',
  'dataset',
  'prepared_at',
  'raw_zip',
  'extract_rel_path',
  'index_rel_path',
  'record_count',
  'splits',
  'class_list',
  'structure',
]);

const REQUIRED_RAW_ZIP_FIELDS = Object.freeze(['file_name', 'size_bytes', 'sha256', 'mtime_ms']);

const SUPPORTED_DATASETS = Object.freeze(['lapa', 'celebamaskhq', 'fasseg', 'acne04']);

function normalizeDatasetName(input) {
  const token = String(input || '').trim().toLowerCase();
  if (!token) return '';
  if (token === 'celebamask-hq' || token === 'celebamask_hq') return 'celebamaskhq';
  return token;
}

function parseRegistryYaml(rawText) {
  const parsed = YAML.parse(String(rawText || '')) || {};
  const datasets = Array.isArray(parsed.datasets) ? parsed.datasets : [];
  return {
    version: parsed.version || 1,
    datasets: datasets.map((entry) => ({
      ...entry,
      name: normalizeDatasetName(entry && entry.name),
    })),
  };
}

function loadRegistry(filePath = path.join('datasets', 'registry.yaml')) {
  const resolved = path.resolve(filePath);
  const rawText = fs.readFileSync(resolved, 'utf8');
  const parsed = parseRegistryYaml(rawText);
  return {
    filePath: resolved,
    ...parsed,
  };
}

function validateRegistryEntries(registry) {
  const issues = [];
  const datasets = Array.isArray(registry && registry.datasets) ? registry.datasets : [];
  const seenNames = new Set();

  for (const entry of datasets) {
    const label = String(entry && entry.name ? entry.name : '<missing>');
    for (const field of REQUIRED_FIELDS) {
      if (!(entry && Object.prototype.hasOwnProperty.call(entry, field))) {
        issues.push(`${label}: missing field "${field}"`);
      }
    }
    if (!entry || !entry.name) continue;
    if (!SUPPORTED_DATASETS.includes(entry.name)) {
      issues.push(`${label}: unsupported dataset name`);
    }
    if (seenNames.has(entry.name)) {
      issues.push(`${label}: duplicated dataset entry`);
    }
    seenNames.add(entry.name);

    if (entry.legal_approved !== true) {
      issues.push(`${label}: legal_approved must be true`);
    }
    if (!Array.isArray(entry.allowed_usages) || !entry.allowed_usages.length) {
      issues.push(`${label}: allowed_usages must be a non-empty list`);
    }
    if (String(entry.storage_policy || '') !== 'no_redistribution_artifacts') {
      issues.push(`${label}: storage_policy must be "no_redistribution_artifacts"`);
    }
  }

  for (const expected of SUPPORTED_DATASETS) {
    if (!seenNames.has(expected)) {
      issues.push(`registry missing required dataset: ${expected}`);
    }
  }

  return issues;
}

function validateManifestObject(manifest, expectedDataset = '') {
  const issues = [];
  const targetDataset = normalizeDatasetName(expectedDataset);
  const payload = manifest && typeof manifest === 'object' ? manifest : null;
  if (!payload) return ['manifest_not_object'];

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      issues.push(`missing field "${field}"`);
    }
  }

  const dataset = normalizeDatasetName(payload.dataset);
  if (!dataset) {
    issues.push('dataset_missing');
  } else if (!SUPPORTED_DATASETS.includes(dataset)) {
    issues.push(`unsupported_dataset:${dataset}`);
  } else if (targetDataset && dataset !== targetDataset) {
    issues.push(`dataset_mismatch:${dataset}!=${targetDataset}`);
  }

  if (!Array.isArray(payload.class_list)) {
    issues.push('class_list_missing');
  }
  if (!payload.splits || typeof payload.splits !== 'object') {
    issues.push('splits_missing');
  }
  if (!payload.structure || typeof payload.structure !== 'object') {
    issues.push('structure_missing');
  }
  if (!Number.isFinite(Number(payload.record_count))) {
    issues.push('record_count_missing_or_invalid');
  }

  const rawZip = payload.raw_zip && typeof payload.raw_zip === 'object' ? payload.raw_zip : null;
  if (!rawZip) {
    issues.push('raw_zip_missing');
  } else {
    for (const field of REQUIRED_RAW_ZIP_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(rawZip, field)) {
        issues.push(`raw_zip missing field "${field}"`);
      }
    }
    const hash = String(rawZip.sha256 || '');
    if (!/^[a-f0-9]{32,}$/i.test(hash)) issues.push('raw_zip.sha256_missing_or_invalid');
    if (!Number.isFinite(Number(rawZip.size_bytes))) issues.push('raw_zip.size_bytes_missing_or_invalid');
    if (!Number.isFinite(Number(rawZip.mtime_ms))) issues.push('raw_zip.mtime_ms_missing_or_invalid');
  }

  return issues;
}

module.exports = {
  REQUIRED_FIELDS,
  REQUIRED_MANIFEST_FIELDS,
  REQUIRED_RAW_ZIP_FIELDS,
  SUPPORTED_DATASETS,
  normalizeDatasetName,
  parseRegistryYaml,
  loadRegistry,
  validateRegistryEntries,
  validateManifestObject,
};
