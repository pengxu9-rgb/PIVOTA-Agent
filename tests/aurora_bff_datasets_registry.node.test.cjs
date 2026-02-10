const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadRegistry,
  validateRegistryEntries,
  validateManifestObject,
  SUPPORTED_DATASETS,
} = require('../scripts/datasets_registry.js');

test('datasets registry includes required datasets and passes schema checks', () => {
  const registryPath = path.join(__dirname, '..', 'datasets', 'registry.yaml');
  const registry = loadRegistry(registryPath);
  const issues = validateRegistryEntries(registry);

  assert.equal(Array.isArray(registry.datasets), true);
  assert.equal(issues.length, 0, `registry issues: ${issues.join('; ')}`);

  const names = new Set(registry.datasets.map((entry) => entry.name));
  for (const dataset of SUPPORTED_DATASETS) {
    assert.equal(names.has(dataset), true, `missing dataset entry: ${dataset}`);
  }
});

test('.gitignore protects dataset cache and debug outputs', () => {
  const gitignorePath = path.join(__dirname, '..', '.gitignore');
  const text = fs.readFileSync(gitignorePath, 'utf8');
  const lines = new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );

  assert.equal(lines.has('datasets_cache/**'), true);
  assert.equal(lines.has('outputs/**'), true);
  assert.equal(lines.has('outputs/datasets_debug/**'), true);
});

test('manifest validator accepts minimal valid manifest payload', () => {
  const sampleManifest = {
    schema_version: 'aurora.external_dataset_manifest.v1',
    dataset: 'lapa',
    prepared_at: '2026-02-10T00:00:00.000Z',
    raw_zip: {
      file_name: 'lapa.zip',
      size_bytes: 123456,
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mtime_ms: 1739145600000,
    },
    extract_rel_path: 'datasets_cache/external/lapa/lapa_01234567',
    index_rel_path: 'datasets_cache/external/lapa/lapa_01234567/dataset_index.jsonl',
    record_count: 100,
    splits: { train: 80, val: 10, test: 10 },
    class_list: ['background', 'skin'],
    structure: { images: 100, masks: 100, annotations: 0 },
  };

  const issues = validateManifestObject(sampleManifest, 'lapa');
  assert.equal(issues.length, 0, `manifest issues: ${issues.join('; ')}`);
});
