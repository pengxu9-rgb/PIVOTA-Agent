const fs = require('fs');
const path = require('path');
const {
  listAcceptanceFamilyAliases,
  normalizeAcceptanceFamily,
} = require('./commerce_acceptance_family');
const { buildAcceptanceTargetDefaults } = require('./commerce_acceptance_contracts');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const MERGED_ARRAY_KEYS = new Set([
  'family_aliases',
  'must_have_metadata',
  'must_be_positive_metadata',
  'must_not_match_fallback_sources',
  'must_have_reason_codes',
  'must_return_one_of_titles',
  'must_have_paths',
  'must_be_positive_paths',
]);

function mergeUniqueArray(base = [], override = []) {
  return Array.from(new Set([...base, ...override].map((item) => JSON.stringify(item)))).map((item) =>
    JSON.parse(item),
  );
}

function deepMerge(base, override) {
  if (override === undefined) return deepClone(base);
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return deepClone(override);
  }

  const out = { ...deepClone(base) };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = out[key];
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      out[key] = deepMerge(baseValue, value);
    } else if (Array.isArray(baseValue) && Array.isArray(value) && MERGED_ARRAY_KEYS.has(key)) {
      out[key] = mergeUniqueArray(baseValue, value);
    } else {
      out[key] = deepClone(value);
    }
  }
  return out;
}

function readAcceptanceCorpus(inputPath) {
  const fullPath = path.resolve(inputPath);
  return {
    fullPath,
    payload: JSON.parse(fs.readFileSync(fullPath, 'utf8')),
  };
}

function isSharedAcceptanceCorpus(payload) {
  return (
    isPlainObject(payload) &&
    String(payload.schema_version || '').trim() ===
      'celestial.commerce_core.acceptance_corpus.v1' &&
    Array.isArray(payload.cases)
  );
}

function applyTargetDefaults(testCase, target) {
  const normalized = normalizeLoadedCase(testCase);
  if (!isPlainObject(normalized)) return normalized;
  const defaults = buildAcceptanceTargetDefaults(target, normalized);
  return isPlainObject(defaults) ? deepMerge(defaults, normalized) : normalized;
}

function materializeSharedTargetCase(entry, target) {
  const targetSpec =
    entry?.targets && isPlainObject(entry.targets) && isPlainObject(entry.targets[target])
      ? entry.targets[target]
      : null;
  if (!targetSpec) return null;

  const base = Object.fromEntries(
    Object.entries(entry || {}).filter(([key]) => !['schema_version', 'targets'].includes(key)),
  );
  return applyTargetDefaults(deepMerge(base, targetSpec), target);
}

function loadSharedTargetCases(inputPath, target) {
  const { payload } = readAcceptanceCorpus(inputPath);
  if (isSharedAcceptanceCorpus(payload)) {
    return payload.cases
      .map((entry) => materializeSharedTargetCase(entry, target))
      .filter(Boolean);
  }
  if (Array.isArray(payload)) return payload.map((item) => applyTargetDefaults(item, target));
  if (Array.isArray(payload?.cases)) {
    return payload.cases.map((item) => applyTargetDefaults(item, target));
  }
  return [];
}

function normalizeLoadedCase(testCase) {
  if (!isPlainObject(testCase)) return testCase;

  const out = deepClone(testCase);
  const originalFamily = String(out.family || '').trim();
  const normalizedFamily = normalizeAcceptanceFamily(originalFamily);
  if (normalizedFamily) {
    out.family = normalizedFamily;
    const aliases = listAcceptanceFamilyAliases(normalizedFamily).filter(
      (item) => item !== normalizedFamily,
    );
    if (aliases.length > 0 || (originalFamily && originalFamily !== normalizedFamily)) {
      out.family_aliases = Array.from(
        new Set(
          [normalizedFamily, originalFamily, ...aliases]
            .map((item) => String(item || '').trim())
            .filter(Boolean),
        ),
      );
    }
  }
  return out;
}

function loadProdGateCases(inputPath) {
  return loadSharedTargetCases(inputPath, 'prod_gate');
}

function splitStagingCases(cases = []) {
  const semanticCases = [];
  const governanceCases = [];
  for (const testCase of cases) {
    if (!isPlainObject(testCase)) continue;
    if (String(testCase.kind || '').trim() === 'governance') governanceCases.push(testCase);
    else semanticCases.push(testCase);
  }
  return {
    semantic_cases: semanticCases,
    governance_cases: governanceCases,
  };
}

function loadStagingMatrixPayload(inputPath) {
  const { fullPath, payload } = readAcceptanceCorpus(inputPath);
  if (isSharedAcceptanceCorpus(payload)) {
    const cases = payload.cases
      .map((entry) => materializeSharedTargetCase(entry, 'staging_matrix'))
      .filter(Boolean);
    return {
      matrixPath: fullPath,
      ...splitStagingCases(cases),
    };
  }

  return {
    matrixPath: fullPath,
    semantic_cases: Array.isArray(payload?.semantic_cases)
      ? payload.semantic_cases.map((item) => applyTargetDefaults(item, 'staging_matrix'))
      : [],
    governance_cases: Array.isArray(payload?.governance_cases)
      ? payload.governance_cases.map((item) => applyTargetDefaults(item, 'staging_matrix'))
      : [],
  };
}

function loadAuroraManualReviewCases(inputPath) {
  const payload = loadStagingMatrixPayload(inputPath);
  return (Array.isArray(payload.semantic_cases) ? payload.semantic_cases : []).filter(
    (item) => isPlainObject(item) && item.execution_mode === 'manual',
  );
}

function loadPromptLiveSmokeCases(inputPath) {
  const { payload } = readAcceptanceCorpus(inputPath);
  if (isSharedAcceptanceCorpus(payload)) {
    return loadSharedTargetCases(inputPath, 'prompt_live_smoke');
  }

  if (Array.isArray(payload)) return payload.map((item) => applyTargetDefaults(item, 'prompt_live_smoke'));
  const promptCases = Array.isArray(payload?.prompt_cases) ? payload.prompt_cases : [];
  return promptCases.map((item) => applyTargetDefaults(item, 'prompt_live_smoke'));
}

function loadBeautyCrossAgentCases(inputPath) {
  return loadSharedTargetCases(inputPath, 'beauty_cross_agent');
}

module.exports = {
  isSharedAcceptanceCorpus,
  loadSharedTargetCases,
  loadProdGateCases,
  loadStagingMatrixPayload,
  loadAuroraManualReviewCases,
  loadPromptLiveSmokeCases,
  loadBeautyCrossAgentCases,
};
