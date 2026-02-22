#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  KB_V0_SCHEMA_VALIDATION_VERSION,
  parseConceptDictionary,
  parseIngredientOntology,
  parseSafetyRules,
  parseInteractionRules,
  parseClimateNormals,
  validateManifestAgainstFiles,
} = require('../src/auroraBff/kbV0/schema');

const DEFAULT_SOURCE_DIR = '/Users/pengchydan/Desktop/aurora/Aurora Chat V2 — KB v0';
const DEFAULT_DEST_DIR = path.join('data', 'aurora_chat_v2', 'kb_v0');
const DEFAULT_REPORT_PATH = path.join('reports', 'aurora_kb_v0_import_report.md');

const REQUIRED_FILES = [
  'concept_dictionary.v0.json',
  'ingredient_ontology.v0.json',
  'safety_rules.v0.json',
  'interaction_rules.v0.json',
  'climate_normals.v0.json',
  'kb_v0_manifest.json',
  'kb_v0_summary.md',
];

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/import_aurora_kb_v0.js [options]',
      '',
      'Options:',
      `  --src <path>         source KB dir (default: ${DEFAULT_SOURCE_DIR})`,
      `  --dest <path>        repo-relative destination dir (default: ${DEFAULT_DEST_DIR})`,
      `  --report <path>      repo-relative report path (default: ${DEFAULT_REPORT_PATH})`,
      '  --allow-manifest-errors',
      '  --help',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const out = {
    sourceDir: DEFAULT_SOURCE_DIR,
    destDir: DEFAULT_DEST_DIR,
    reportPath: DEFAULT_REPORT_PATH,
    allowManifestErrors: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    const next = argv[i + 1];
    const take = () => {
      if (typeof next !== 'string') throw new Error(`Missing value for ${arg}`);
      i += 1;
      return next;
    };
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--src') {
      out.sourceDir = take();
    } else if (arg === '--dest') {
      out.destDir = take();
    } else if (arg === '--report') {
      out.reportPath = take();
    } else if (arg === '--allow-manifest-errors') {
      out.allowManifestErrors = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return out;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(Buffer.from(String(text || ''), 'utf8')).digest('hex');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildReproducibilityFingerprint({ sourceDir, copiedFiles, manifestValidation, diagnostics }) {
  const file_hashes = (Array.isArray(copiedFiles) ? copiedFiles : [])
    .map((filename) => {
      const abs = path.join(sourceDir, filename);
      const stat = fs.statSync(abs);
      return {
        filename,
        bytes: Number(stat.size),
        sha256: sha256File(abs),
      };
    })
    .sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || '')));

  const canonicalPayload = {
    kb_version: String(manifestValidation && manifestValidation.kb_version ? manifestValidation.kb_version : 'unknown'),
    schema_validation_version: KB_V0_SCHEMA_VALIDATION_VERSION,
    manifest_ok: Boolean(manifestValidation && manifestValidation.ok),
    file_hashes,
    counts: diagnostics && diagnostics.counts ? diagnostics.counts : {},
  };
  const canonical_json = JSON.stringify(canonicalPayload);

  return {
    kb_version: canonicalPayload.kb_version,
    schema_validation_version: canonicalPayload.schema_validation_version,
    manifest_generated_utc: String(manifestValidation && manifestValidation.generated_utc ? manifestValidation.generated_utc : 'unknown'),
    fingerprint_sha256: sha256Text(canonical_json),
    canonical_json,
    file_hashes,
  };
}

function collectDiagnostics({ conceptDictionary, ingredientOntology, safetyRules, interactionRules, climateNormals }) {
  const conceptRows = Array.isArray(conceptDictionary.concepts) ? conceptDictionary.concepts : [];
  const conceptById = new Map();
  const duplicateIds = [];
  for (const row of conceptRows) {
    const id = String(row.concept_id || '').trim().toUpperCase();
    if (!id) continue;
    if (conceptById.has(id)) duplicateIds.push(id);
    conceptById.set(id, (conceptById.get(id) || 0) + 1);
  }

  const referenced = new Set();
  for (const ingredient of (ingredientOntology.ingredients || [])) {
    for (const cls of ingredient.classes || []) referenced.add(String(cls || '').trim().toUpperCase());
  }
  for (const rule of (safetyRules.rules || [])) {
    const trigger = rule.trigger || {};
    const decision = rule.decision || {};
    for (const concept of [
      ...(trigger.concepts_any || []),
      ...(trigger.concepts_any_2 || []),
      ...(decision.blocked_concepts || []),
      ...(decision.safe_alternatives_concepts || []),
    ]) {
      referenced.add(String(concept || '').trim().toUpperCase());
    }
  }
  for (const row of interactionRules.interactions || []) {
    referenced.add(String(row.concept_a || '').trim().toUpperCase());
    referenced.add(String(row.concept_b || '').trim().toUpperCase());
  }

  const missingRefs = Array.from(referenced)
    .filter((id) => id && !conceptById.has(id))
    .sort();

  return {
    counts: {
      concepts_rows: conceptRows.length,
      concepts_unique: conceptById.size,
      ingredients: (ingredientOntology.ingredients || []).length,
      safety_rules: (safetyRules.rules || []).length,
      safety_templates: (safetyRules.templates || []).length,
      interactions: (interactionRules.interactions || []).length,
      climate_regions: (climateNormals.regions || []).length,
    },
    duplicate_concept_ids: Array.from(new Set(duplicateIds)).sort(),
    missing_referenced_concepts: missingRefs,
  };
}

function buildReport({
  sourceDir,
  destDir,
  manifestValidation,
  diagnostics,
  copiedFiles,
  reproducibilityFingerprint,
}) {
  const lines = [];
  lines.push('# Aurora KB v0 Import Report');
  lines.push('');
  lines.push(`- generated_at: ${nowIso()}`);
  lines.push(`- source_dir: \`${sourceDir}\``);
  lines.push(`- dest_dir: \`${destDir}\``);
  lines.push(`- manifest_ok: ${manifestValidation.ok}`);
  lines.push(`- manifest_errors: ${manifestValidation.errors.length}`);
  lines.push('');
  lines.push('## Reproducibility Fingerprint');
  lines.push(`- kb_version: ${reproducibilityFingerprint.kb_version}`);
  lines.push(`- schema_validation_version: ${reproducibilityFingerprint.schema_validation_version}`);
  lines.push(`- manifest_generated_utc: ${reproducibilityFingerprint.manifest_generated_utc}`);
  lines.push(`- fingerprint_sha256: ${reproducibilityFingerprint.fingerprint_sha256}`);
  lines.push(`- counts_signature: ${JSON.stringify(diagnostics.counts)}`);
  lines.push('- file_hashes:');
  for (const row of reproducibilityFingerprint.file_hashes || []) {
    lines.push(`  - ${row.filename}: sha256=${row.sha256} bytes=${row.bytes}`);
  }
  lines.push('');
  lines.push('## Copied files');
  for (const file of copiedFiles) lines.push(`- ${file}`);
  lines.push('');
  lines.push('## Counts');
  for (const [key, value] of Object.entries(diagnostics.counts)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('');
  lines.push('## Duplicate concept_ids');
  if (diagnostics.duplicate_concept_ids.length === 0) lines.push('- none');
  else diagnostics.duplicate_concept_ids.forEach((id) => lines.push(`- ${id}`));
  lines.push('');
  lines.push('## Missing referenced concepts');
  if (diagnostics.missing_referenced_concepts.length === 0) lines.push('- none');
  else diagnostics.missing_referenced_concepts.forEach((id) => lines.push(`- ${id}`));
  lines.push('');
  lines.push('## Manifest validation errors');
  if (manifestValidation.errors.length === 0) lines.push('- none');
  else manifestValidation.errors.forEach((err) => lines.push(`- ${err}`));
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const sourceDir = path.resolve(args.sourceDir);
  const destDir = path.resolve(args.destDir);
  const reportPath = path.resolve(args.reportPath);

  for (const filename of REQUIRED_FILES) {
    const abs = path.join(sourceDir, filename);
    if (!fs.existsSync(abs)) {
      throw new Error(`Source file missing: ${abs}`);
    }
  }

  const manifest = readJson(path.join(sourceDir, 'kb_v0_manifest.json'));
  const manifestValidation = validateManifestAgainstFiles(manifest, sourceDir);
  if (!manifestValidation.ok && !args.allowManifestErrors) {
    throw new Error(`Manifest validation failed (${manifestValidation.errors.length} errors). Use --allow-manifest-errors to continue.`);
  }

  const conceptDictionary = parseConceptDictionary(readJson(path.join(sourceDir, 'concept_dictionary.v0.json')));
  const ingredientOntology = parseIngredientOntology(readJson(path.join(sourceDir, 'ingredient_ontology.v0.json')));
  const safetyRules = parseSafetyRules(readJson(path.join(sourceDir, 'safety_rules.v0.json')));
  const interactionRules = parseInteractionRules(readJson(path.join(sourceDir, 'interaction_rules.v0.json')));
  const climateNormals = parseClimateNormals(readJson(path.join(sourceDir, 'climate_normals.v0.json')));

  const diagnostics = collectDiagnostics({
    conceptDictionary,
    ingredientOntology,
    safetyRules,
    interactionRules,
    climateNormals,
  });

  ensureDir(destDir);
  const copiedFiles = [];
  for (const filename of REQUIRED_FILES) {
    fs.copyFileSync(path.join(sourceDir, filename), path.join(destDir, filename));
    copiedFiles.push(filename);
  }

  const report = buildReport({
    sourceDir,
    destDir,
    manifestValidation,
    diagnostics,
    copiedFiles,
    reproducibilityFingerprint: buildReproducibilityFingerprint({
      sourceDir,
      copiedFiles,
      manifestValidation,
      diagnostics,
    }),
  });
  writeText(reportPath, report);

  console.log(`Imported KB v0 to ${destDir}`);
  console.log(`Report: ${reportPath}`);
}

try {
  main();
} catch (error) {
  console.error(`[import_aurora_kb_v0] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
}
