const fs = require('node:fs');
const path = require('node:path');

const {
  parseConceptDictionary,
  parseIngredientOntology,
  parseSafetyRules,
  parseInteractionRules,
  parseClimateNormals,
  validateManifestAgainstFiles,
  uniqueStrings,
} = require('./schema');

const DEFAULT_KB_V0_DIR = path.join(__dirname, '..', '..', '..', 'data', 'aurora_chat_v2', 'kb_v0');

const REQUIRED_FILES = Object.freeze([
  'concept_dictionary.v0.json',
  'ingredient_ontology.v0.json',
  'safety_rules.v0.json',
  'interaction_rules.v0.json',
  'climate_normals.v0.json',
]);

const MANIFEST_FILE = 'kb_v0_manifest.json';

const cache = {
  dir: '',
  signature: '',
  payload: null,
  lastError: null,
};

let metricsCache = null;
function getMetrics() {
  if (metricsCache !== null) return metricsCache;
  try {
    metricsCache = require('../visionMetrics');
  } catch {
    metricsCache = {};
  }
  return metricsCache;
}

function recordLoaderError(reason) {
  const metrics = getMetrics();
  if (metrics && typeof metrics.recordAuroraKbV0LoaderError === 'function') {
    metrics.recordAuroraKbV0LoaderError({ reason });
  }
}

function isAuroraKbV0Disabled() {
  const raw = String(process.env.AURORA_KB_V0_DISABLE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on';
}

function getAuroraKbFailMode() {
  const raw = String(process.env.AURORA_KB_FAIL_MODE || '').trim().toLowerCase();
  return raw === 'closed' ? 'closed' : 'open';
}

function buildLoaderFailure(message, reason, diagnostics = {}) {
  const error = new Error(String(message || reason || 'aurora kb v0 loader failed'));
  error.code = 'AURORA_KB_V0_LOAD_FAILED';
  error.reason = String(reason || 'load_failed');
  error.diagnostics = diagnostics && typeof diagnostics === 'object' ? diagnostics : {};
  return error;
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function computeSignature(dirPath) {
  const parts = [];
  for (const filename of [...REQUIRED_FILES, MANIFEST_FILE]) {
    const abs = path.join(dirPath, filename);
    const st = safeStat(abs);
    if (!st) {
      parts.push(`${filename}:missing`);
      continue;
    }
    parts.push(`${filename}:${Number(st.mtimeMs)}:${Number(st.size)}`);
  }
  return parts.join('|');
}

function formatConceptIdAsLabel(conceptId) {
  const text = String(conceptId || '').trim();
  if (!text) return 'Unknown concept';
  return text
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((token) => token.slice(0, 1).toUpperCase() + token.slice(1))
    .join(' ');
}

function mergeConceptRows(rows) {
  const byId = new Map();
  const duplicateConceptIds = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.concept_id || '').trim().toUpperCase();
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, {
        ...row,
        concept_id: id,
        synonyms_en: uniqueStrings(row.synonyms_en),
        synonyms_zh: uniqueStrings(row.synonyms_zh),
        inci_aliases: uniqueStrings(row.inci_aliases),
        regex_hints: {
          en: uniqueStrings(row.regex_hints && row.regex_hints.en),
          zh: uniqueStrings(row.regex_hints && row.regex_hints.zh),
        },
        sources: Array.isArray(row.sources) ? row.sources.slice() : [],
      });
      continue;
    }

    duplicateConceptIds.push(id);
    prev.synonyms_en = uniqueStrings([...(prev.synonyms_en || []), ...(row.synonyms_en || [])]);
    prev.synonyms_zh = uniqueStrings([...(prev.synonyms_zh || []), ...(row.synonyms_zh || [])]);
    prev.inci_aliases = uniqueStrings([...(prev.inci_aliases || []), ...(row.inci_aliases || [])]);
    prev.regex_hints = {
      en: uniqueStrings([...(prev.regex_hints && prev.regex_hints.en ? prev.regex_hints.en : []), ...(row.regex_hints && row.regex_hints.en ? row.regex_hints.en : [])]),
      zh: uniqueStrings([...(prev.regex_hints && prev.regex_hints.zh ? prev.regex_hints.zh : []), ...(row.regex_hints && row.regex_hints.zh ? row.regex_hints.zh : [])]),
    };
    const en = String((prev.labels && prev.labels.en) || '').trim();
    const zh = String((prev.labels && prev.labels.zh) || '').trim();
    const rowEn = String((row.labels && row.labels.en) || '').trim();
    const rowZh = String((row.labels && row.labels.zh) || '').trim();
    prev.labels = {
      en: en || rowEn || formatConceptIdAsLabel(id),
      zh: zh || rowZh || en || rowEn || formatConceptIdAsLabel(id),
    };
    prev.notes = [String(prev.notes || '').trim(), String(row.notes || '').trim()]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 600);
    prev.sources = [...(Array.isArray(prev.sources) ? prev.sources : []), ...(Array.isArray(row.sources) ? row.sources : [])].slice(0, 24);
    byId.set(id, prev);
  }

  return {
    concepts: Array.from(byId.values()),
    duplicate_concept_ids: uniqueStrings(duplicateConceptIds, { upper: true }),
  };
}

function collectReferencedConceptIds({ ingredientOntology, safetyRules, interactionRules }) {
  const referenced = new Set();

  for (const ingredient of (ingredientOntology && ingredientOntology.ingredients) || []) {
    for (const conceptId of Array.isArray(ingredient.classes) ? ingredient.classes : []) {
      const id = String(conceptId || '').trim().toUpperCase();
      if (id) referenced.add(id);
    }
  }

  for (const rule of (safetyRules && safetyRules.rules) || []) {
    const trigger = safeObject(rule.trigger);
    const decision = safeObject(rule.decision);
    for (const conceptId of [
      ...(Array.isArray(trigger.concepts_any) ? trigger.concepts_any : []),
      ...(Array.isArray(trigger.concepts_any_2) ? trigger.concepts_any_2 : []),
      ...(Array.isArray(decision.blocked_concepts) ? decision.blocked_concepts : []),
      ...(Array.isArray(decision.safe_alternatives_concepts) ? decision.safe_alternatives_concepts : []),
    ]) {
      const id = String(conceptId || '').trim().toUpperCase();
      if (id) referenced.add(id);
    }
  }

  for (const row of (interactionRules && interactionRules.interactions) || []) {
    const a = String(row.concept_a || '').trim().toUpperCase();
    const b = String(row.concept_b || '').trim().toUpperCase();
    if (a) referenced.add(a);
    if (b) referenced.add(b);
  }

  return referenced;
}

function enrichConceptsWithSynthetic(concepts, referencedSet) {
  const conceptMap = new Map();
  for (const concept of Array.isArray(concepts) ? concepts : []) {
    const id = String(concept && concept.concept_id ? concept.concept_id : '').trim().toUpperCase();
    if (!id) continue;
    conceptMap.set(id, concept);
  }

  const missingIds = [];
  for (const id of referencedSet) {
    if (conceptMap.has(id)) continue;
    missingIds.push(id);
    conceptMap.set(id, {
      concept_id: id,
      labels: {
        en: formatConceptIdAsLabel(id),
        zh: formatConceptIdAsLabel(id),
      },
      synonyms_en: [],
      synonyms_zh: [],
      inci_aliases: [],
      regex_hints: { en: [], zh: [] },
      notes: 'synthetic concept generated from rule reference',
      sources: [],
      synthetic_missing_concept: true,
    });
  }

  return {
    concepts: Array.from(conceptMap.values()),
    missing_concept_ids: uniqueStrings(missingIds, { upper: true }),
  };
}

function buildTemplateIndex(templates) {
  const out = {};
  for (const row of Array.isArray(templates) ? templates : []) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.template_id || '').trim();
    if (!id) continue;
    out[id] = {
      template_id: id,
      text_en: String(row.text_en || '').trim(),
      text_zh: String(row.text_zh || '').trim(),
    };
  }
  return out;
}

function loadAuroraKbV0({ kbDir, forceReload = false } = {}) {
  const dirPath = path.resolve(kbDir || process.env.AURORA_KB_V0_DIR || DEFAULT_KB_V0_DIR);
  const failMode = getAuroraKbFailMode();
  const failClosed = failMode === 'closed';

  if (isAuroraKbV0Disabled()) {
    return {
      ok: false,
      disabled: true,
      source_dir: dirPath,
      fail_mode: failMode,
      reason: 'disabled_by_env',
      diagnostics: { duplicate_concept_ids: [], missing_concept_ids: [], manifest_errors: [] },
    };
  }

  for (const filename of REQUIRED_FILES) {
    const abs = path.join(dirPath, filename);
    if (!fs.existsSync(abs)) {
      recordLoaderError('missing_required_file');
      const diagnostics = {
        duplicate_concept_ids: [],
        missing_concept_ids: [],
        manifest_errors: [`missing required kb file: ${filename}`],
      };
      if (failClosed) {
        throw buildLoaderFailure(
          `AURORA_KB_FAIL_MODE=closed: missing required kb file: ${filename}`,
          `missing_file:${filename}`,
          diagnostics,
        );
      }
      return {
        ok: false,
        disabled: false,
        source_dir: dirPath,
        fail_mode: failMode,
        reason: `missing_file:${filename}`,
        diagnostics,
      };
    }
  }

  const signature = computeSignature(dirPath);
  if (!forceReload && cache.payload && cache.dir === dirPath && cache.signature === signature) {
    return cache.payload;
  }

  try {
    const conceptDictionary = parseConceptDictionary(readJson(path.join(dirPath, 'concept_dictionary.v0.json')));
    const ingredientOntology = parseIngredientOntology(readJson(path.join(dirPath, 'ingredient_ontology.v0.json')));
    const safetyRules = parseSafetyRules(readJson(path.join(dirPath, 'safety_rules.v0.json')));
    const interactionRules = parseInteractionRules(readJson(path.join(dirPath, 'interaction_rules.v0.json')));
    const climateNormals = parseClimateNormals(readJson(path.join(dirPath, 'climate_normals.v0.json')));

    const merged = mergeConceptRows(conceptDictionary.concepts || []);
    const referenced = collectReferencedConceptIds({
      ingredientOntology,
      safetyRules,
      interactionRules,
    });
    const withSynthetic = enrichConceptsWithSynthetic(merged.concepts || [], referenced);
    const conceptsById = {};
    for (const concept of withSynthetic.concepts) {
      conceptsById[concept.concept_id] = concept;
    }

    let manifestValidation = {
      kb_version: 'unknown',
      generated_utc: 'unknown',
      files: [],
      errors: [],
      ok: false,
    };
    const manifestPath = path.join(dirPath, MANIFEST_FILE);
    if (fs.existsSync(manifestPath)) {
      try {
        manifestValidation = validateManifestAgainstFiles(readJson(manifestPath), dirPath);
      } catch (err) {
        manifestValidation = {
          kb_version: 'unknown',
          generated_utc: 'unknown',
          files: [],
          errors: [`manifest parse failed: ${String(err && err.message ? err.message : err)}`],
          ok: false,
        };
      }
      if (!manifestValidation.ok) {
        recordLoaderError('manifest_validation_failed');
        if (failClosed) {
          throw buildLoaderFailure(
            `AURORA_KB_FAIL_MODE=closed: manifest validation failed (${manifestValidation.errors.length} errors)`,
            'manifest_validation_failed',
            { manifest_errors: manifestValidation.errors || [] },
          );
        }
      }
    } else {
      manifestValidation.errors.push(`manifest missing: ${MANIFEST_FILE}`);
      if (failClosed) {
        throw buildLoaderFailure(
          `AURORA_KB_FAIL_MODE=closed: manifest missing: ${MANIFEST_FILE}`,
          'manifest_missing',
          { manifest_errors: manifestValidation.errors || [] },
        );
      }
    }

    const payload = {
      ok: true,
      disabled: false,
      source_dir: dirPath,
      fail_mode: failMode,
      loaded_at: new Date().toISOString(),
      kb_version:
        conceptDictionary.kb_version ||
        ingredientOntology.kb_version ||
        safetyRules.kb_version ||
        interactionRules.kb_version ||
        climateNormals.kb_version ||
        'unknown',
      concept_dictionary: {
        kb_version: conceptDictionary.kb_version,
        concepts: withSynthetic.concepts,
      },
      ingredient_ontology: ingredientOntology,
      safety_rules: safetyRules,
      interaction_rules: interactionRules,
      climate_normals: climateNormals,
      templates_by_id: buildTemplateIndex(safetyRules.templates),
      concepts_by_id: conceptsById,
      diagnostics: {
        duplicate_concept_ids: merged.duplicate_concept_ids || [],
        missing_concept_ids: withSynthetic.missing_concept_ids || [],
        synthetic_concepts_count: (withSynthetic.missing_concept_ids || []).length,
        manifest_errors: manifestValidation.errors || [],
      },
      manifest: manifestValidation,
    };

    cache.dir = dirPath;
    cache.signature = signature;
    cache.payload = payload;
    cache.lastError = null;
    return payload;
  } catch (error) {
    recordLoaderError('parse_failed');
    if (failClosed) {
      if (error && typeof error === 'object' && !error.code) {
        error.code = 'AURORA_KB_V0_LOAD_FAILED';
      }
      throw error;
    }
    cache.dir = dirPath;
    cache.signature = signature;
    cache.payload = null;
    cache.lastError = error;
    return {
      ok: false,
      disabled: false,
      source_dir: dirPath,
      fail_mode: failMode,
      reason: 'parse_failed',
      diagnostics: {
        duplicate_concept_ids: [],
        missing_concept_ids: [],
        manifest_errors: [String(error && error.message ? error.message : error)],
      },
    };
  }
}

function clearAuroraKbV0Cache() {
  cache.dir = '';
  cache.signature = '';
  cache.payload = null;
  cache.lastError = null;
}

module.exports = {
  DEFAULT_KB_V0_DIR,
  loadAuroraKbV0,
  getAuroraKbV0: loadAuroraKbV0,
  clearAuroraKbV0Cache,
  isAuroraKbV0Disabled,
  getAuroraKbFailMode,
  __internal: {
    computeSignature,
    mergeConceptRows,
    collectReferencedConceptIds,
    enrichConceptsWithSynthetic,
    formatConceptIdAsLabel,
  },
};
