const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KB_V0_SCHEMA_VALIDATION_VERSION = 'aurora_kb_v0_schema_v1';

function asString(value, fallback = '') {
  if (value == null) return fallback;
  return String(value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values, { upper = false, lower = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const base = asString(raw);
    if (!base) continue;
    const value = upper ? base.toUpperCase() : lower ? base.toLowerCase() : base;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeLabels(input, fallbackEn, fallbackZh) {
  const labels = safeObject(input);
  const en = asString(labels.en || fallbackEn || '');
  const zh = asString(labels.zh || fallbackZh || '');
  return {
    en: en || zh || 'Unknown concept',
    zh: zh || en || '未知概念',
  };
}

function normalizeRegexHints(input) {
  const regexHints = safeObject(input);
  return {
    en: uniqueStrings(regexHints.en),
    zh: uniqueStrings(regexHints.zh),
  };
}

function normalizeConceptRow(raw) {
  const row = safeObject(raw);
  const conceptId = asString(row.concept_id).toUpperCase();
  if (!conceptId) return null;
  const labels = normalizeLabels(row.labels, conceptId, conceptId);
  return {
    concept_id: conceptId,
    labels,
    synonyms_en: uniqueStrings(row.synonyms_en),
    synonyms_zh: uniqueStrings(row.synonyms_zh),
    inci_aliases: uniqueStrings(row.inci_aliases),
    regex_hints: normalizeRegexHints(row.regex_hints),
    notes: asString(row.notes),
    sources: asArray(row.sources).filter((item) => item && typeof item === 'object'),
    synthetic_missing_concept: false,
  };
}

function normalizeIngredientRow(raw) {
  const row = safeObject(raw);
  const ingredientId = asString(row.ingredient_id).toLowerCase();
  if (!ingredientId) return null;
  const commonNames = safeObject(row.common_names);
  return {
    ingredient_id: ingredientId,
    inci: asString(row.inci),
    common_names: {
      en: uniqueStrings(commonNames.en),
      zh: uniqueStrings(commonNames.zh),
    },
    classes: uniqueStrings(row.classes, { upper: true }),
    attributes: uniqueStrings(row.attributes, { lower: true }),
    contraindication_tags: uniqueStrings(row.contraindication_tags, { lower: true }),
    evidence_level: asString(row.evidence_level, 'unknown').toLowerCase(),
    notes: asString(row.notes),
    sources: asArray(row.sources).filter((item) => item && typeof item === 'object'),
  };
}

function normalizeTemplateRow(raw) {
  const row = safeObject(raw);
  const templateId = asString(row.template_id);
  if (!templateId) return null;
  return {
    template_id: templateId,
    text_en: asString(row.text_en),
    text_zh: asString(row.text_zh),
  };
}

function normalizeSafetyRuleRow(raw) {
  const row = safeObject(raw);
  const ruleId = asString(row.rule_id);
  if (!ruleId) return null;
  const trigger = safeObject(row.trigger);
  const decision = safeObject(row.decision);
  const lifeStage = safeObject(trigger.life_stage);
  return {
    rule_id: ruleId,
    category: asString(row.category, 'unknown'),
    trigger: {
      life_stage: {
        pregnancy_status: uniqueStrings(lifeStage.pregnancy_status, { lower: true }),
        lactation_status: uniqueStrings(lifeStage.lactation_status, { lower: true }),
        age_band: uniqueStrings(lifeStage.age_band, { lower: true }),
        medications_any: uniqueStrings(lifeStage.medications_any, { lower: true }),
      },
      concepts_any: uniqueStrings(trigger.concepts_any, { upper: true }),
      concepts_any_2: uniqueStrings(trigger.concepts_any_2, { upper: true }),
      required_context_missing: uniqueStrings(trigger.required_context_missing, { lower: true }),
    },
    decision: {
      block_level: asString(decision.block_level, 'INFO').toUpperCase(),
      required_fields: uniqueStrings(decision.required_fields, { lower: true }),
      blocked_concepts: uniqueStrings(decision.blocked_concepts, { upper: true }),
      safe_alternatives_concepts: uniqueStrings(decision.safe_alternatives_concepts, { upper: true }),
      template_id: asString(decision.template_id),
    },
    rationale: asString(row.rationale),
    sources: asArray(row.sources).filter((item) => item && typeof item === 'object'),
    uncertainty: asString(row.uncertainty),
  };
}

function normalizeInteractionRow(raw) {
  const row = safeObject(raw);
  const interactionId = asString(row.interaction_id);
  if (!interactionId) return null;
  return {
    interaction_id: interactionId,
    concept_a: asString(row.concept_a).toUpperCase(),
    concept_b: asString(row.concept_b).toUpperCase(),
    risk_level: asString(row.risk_level, 'medium').toLowerCase(),
    recommended_action: asString(row.recommended_action, 'ok_with_caution').toLowerCase(),
    notes: asString(row.notes),
    sources: asArray(row.sources).filter((item) => item && typeof item === 'object'),
    uncertainty: asString(row.uncertainty),
  };
}

function normalizeClimateRegionRow(raw) {
  const row = safeObject(raw);
  const regionId = asString(row.region_id);
  if (!regionId) return null;
  const labels = normalizeLabels(row.labels, regionId, regionId);
  const monthProfiles = asArray(row.month_profiles)
    .map((profile) => {
      const p = safeObject(profile);
      const month = Number(p.month);
      if (!Number.isFinite(month)) return null;
      return {
        month: Math.max(1, Math.min(12, Math.trunc(month))),
        uv_level: asString(p.uv_level, 'medium').toLowerCase(),
        humidity: asString(p.humidity, 'balanced').toLowerCase(),
        temp_swing: asString(p.temp_swing, 'medium').toLowerCase(),
        wind: asString(p.wind, 'medium').toLowerCase(),
        pollution: asString(p.pollution, 'medium').toLowerCase(),
        sources: asArray(p.sources).filter((item) => item && typeof item === 'object'),
      };
    })
    .filter(Boolean);

  return {
    region_id: regionId,
    labels,
    hemisphere: asString(row.hemisphere, 'mixed').toLowerCase(),
    archetype: asString(row.archetype, 'temperate_continental').toLowerCase(),
    month_profiles: monthProfiles,
  };
}

function parseConceptDictionary(raw) {
  const input = safeObject(raw);
  return {
    kb_version: asString(input.kb_version, 'unknown'),
    concepts: asArray(input.concepts).map(normalizeConceptRow).filter(Boolean),
  };
}

function parseIngredientOntology(raw) {
  const input = safeObject(raw);
  return {
    kb_version: asString(input.kb_version, 'unknown'),
    ingredients: asArray(input.ingredients).map(normalizeIngredientRow).filter(Boolean),
  };
}

function parseSafetyRules(raw) {
  const input = safeObject(raw);
  return {
    kb_version: asString(input.kb_version, 'unknown'),
    rules: asArray(input.rules).map(normalizeSafetyRuleRow).filter(Boolean),
    templates: asArray(input.templates).map(normalizeTemplateRow).filter(Boolean),
  };
}

function parseInteractionRules(raw) {
  const input = safeObject(raw);
  return {
    kb_version: asString(input.kb_version, 'unknown'),
    interactions: asArray(input.interactions).map(normalizeInteractionRow).filter(Boolean),
  };
}

function parseClimateNormals(raw) {
  const input = safeObject(raw);
  return {
    kb_version: asString(input.kb_version, 'unknown'),
    regions: asArray(input.regions).map(normalizeClimateRegionRow).filter(Boolean),
  };
}

function sha256File(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function validateManifestAgainstFiles(manifestRaw, baseDir) {
  const manifest = safeObject(manifestRaw);
  const files = asArray(manifest.files).filter((item) => item && typeof item === 'object');
  const errors = [];
  for (const item of files) {
    const filename = asString(item.filename);
    if (!filename) continue;
    const expectedSha = asString(item.sha256).toLowerCase();
    const expectedBytes = Number(item.bytes);
    const abs = path.join(baseDir, filename);
    if (!fs.existsSync(abs)) {
      errors.push(`missing file in manifest: ${filename}`);
      continue;
    }
    const stat = fs.statSync(abs);
    if (Number.isFinite(expectedBytes) && Number(expectedBytes) !== Number(stat.size)) {
      errors.push(`byte mismatch for ${filename}: expected ${expectedBytes}, got ${stat.size}`);
    }
    if (expectedSha) {
      const actualSha = sha256File(abs);
      if (actualSha !== expectedSha) {
        errors.push(`sha mismatch for ${filename}: expected ${expectedSha}, got ${actualSha}`);
      }
    }
  }
  return {
    kb_version: asString(manifest.kb_version, 'unknown'),
    generated_utc: asString(manifest.generated_utc, 'unknown'),
    files,
    errors,
    ok: errors.length === 0,
  };
}

module.exports = {
  KB_V0_SCHEMA_VALIDATION_VERSION,
  parseConceptDictionary,
  parseIngredientOntology,
  parseSafetyRules,
  parseInteractionRules,
  parseClimateNormals,
  validateManifestAgainstFiles,
  uniqueStrings,
  normalizeLabels,
  normalizeRegexHints,
};
