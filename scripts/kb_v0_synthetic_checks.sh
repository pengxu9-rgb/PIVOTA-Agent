#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "missing required command: node" >&2
  exit 2
fi

node <<'NODE'
const { INTENT_ENUM } = require('./src/auroraBff/intentCanonical');
const { BLOCK_LEVEL, evaluateSafety } = require('./src/auroraBff/safetyEngineV1');
const { getTravelWeather } = require('./src/auroraBff/weatherAdapter');

let failures = 0;
let warnings = 0;

function pass(name, detail) {
  console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`);
}

function fail(name, detail) {
  failures += 1;
  console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ''}`);
}

function hasKbRule(result) {
  return Array.isArray(result?.matched_rules)
    && result.matched_rules.some((row) => String(row?.id || '').startsWith('kb_v0:'));
}

function runCase(name, fn) {
  try {
    fn();
  } catch (err) {
    fail(name, err && err.message ? err.message : String(err));
  }
}

async function runAsyncCase(name, fn) {
  try {
    await fn();
  } catch (err) {
    fail(name, err && err.message ? err.message : String(err));
  }
}

runCase('case1_preg_unknown_retinoid_require_info', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'Can I use adapalene for acne?',
    profile: {},
    language: 'EN',
  });

  if (result.block_level !== BLOCK_LEVEL.REQUIRE_INFO) {
    throw new Error(`expected REQUIRE_INFO, got ${result.block_level}`);
  }
  if (!Array.isArray(result.required_fields) || !result.required_fields.includes('pregnancy_status')) {
    throw new Error(`expected required_fields to include pregnancy_status, got ${JSON.stringify(result.required_fields || [])}`);
  }
  pass('case1_preg_unknown_retinoid_require_info', 'REQUIRE_INFO + pregnancy_status');
});

runCase('case2_pregnant_retinoid_block', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'Can I use retinol while pregnant?',
    profile: { pregnancy_status: 'pregnant', age_band: 'adult' },
    language: 'EN',
  });

  if (result.block_level !== BLOCK_LEVEL.BLOCK) {
    throw new Error(`expected BLOCK, got ${result.block_level}`);
  }
  if (!hasKbRule(result)) {
    throw new Error('expected matched_rules to contain kb_v0:*');
  }
  pass('case2_pregnant_retinoid_block', 'BLOCK + kb_v0 rule hit');
});

runCase('case3_isotretinoin_combo_block', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'I use oral isotretinoin and benzoyl peroxide daily.',
    profile: {
      high_risk_medications: ['isotretinoin'],
      pregnancy_status: 'not_pregnant',
      lactation_status: 'not_lactating',
      age_band: 'adult',
    },
    language: 'EN',
  });

  if (result.block_level !== BLOCK_LEVEL.BLOCK) {
    throw new Error(`expected BLOCK, got ${result.block_level}`);
  }
  if (!Array.isArray(result.triggered_by) || !result.triggered_by.includes('medications')) {
    throw new Error(`expected triggered_by to include medications, got ${JSON.stringify(result.triggered_by || [])}`);
  }
  if (String(result.decision_source || '') !== 'kb_v0') {
    throw new Error(`expected decision_source=kb_v0, got ${String(result.decision_source || 'unknown')}`);
  }
  pass('case3_isotretinoin_combo_block', 'BLOCK + medications + decision_source=kb_v0');
});

runCase('case4_age_unknown_strong_active_require_info', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'Need the strongest anti-aging routine with high-strength retinoid and peel.',
    profile: { age_band: 'unknown', pregnancy_status: 'not_pregnant' },
    language: 'EN',
  });

  if (result.block_level !== BLOCK_LEVEL.REQUIRE_INFO) {
    throw new Error(`expected REQUIRE_INFO, got ${result.block_level}`);
  }
  if (!Array.isArray(result.required_fields) || !result.required_fields.includes('age_band')) {
    throw new Error(`expected required_fields to include age_band, got ${JSON.stringify(result.required_fields || [])}`);
  }
  pass('case4_age_unknown_strong_active_require_info', 'REQUIRE_INFO + age_band');
});

runCase('case5_toddler_fragrance_essential_oil_block', () => {
  const result = evaluateSafety({
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
    message: 'Can my toddler use a fragrance essential oil cream?',
    profile: { age_band: 'toddler', pregnancy_status: 'not_pregnant' },
    language: 'EN',
  });

  if (result.block_level !== BLOCK_LEVEL.BLOCK) {
    throw new Error(`expected BLOCK, got ${result.block_level}`);
  }
  if (!hasKbRule(result)) {
    throw new Error('expected matched_rules to contain kb_v0:*');
  }
  pass('case5_toddler_fragrance_essential_oil_block', 'BLOCK + kb_v0 rule hit');
});

runAsyncCase('case6_travel_destination_missing_climate_fallback', async () => {
  const out = await getTravelWeather({
    destination: '',
    startDate: '2026-03-01',
    endDate: '2026-03-05',
  });

  if (out.ok !== true) {
    throw new Error(`expected ok=true, got ${out.ok}`);
  }
  if (String(out.source || '') !== 'climate_fallback') {
    throw new Error(`expected source=climate_fallback, got ${String(out.source || '')}`);
  }
  if (!out.raw || typeof out.raw !== 'object' || !out.raw.climate_profile || typeof out.raw.climate_profile !== 'object') {
    throw new Error('expected raw.climate_profile');
  }
  const selectedBy = String(out.raw.climate_profile.archetype_selected_by || '');
  if (!['user_locale', 'month', 'default'].includes(selectedBy)) {
    throw new Error(`expected archetype_selected_by in user_locale|month|default, got ${selectedBy || 'empty'}`);
  }
  pass('case6_travel_destination_missing_climate_fallback', `source=climate_fallback archetype_selected_by=${selectedBy}`);
}).then(() => {
  console.log(`\nSynthetic checks completed: failures=${failures} warnings=${warnings}`);
  if (failures > 0) process.exit(1);
}).catch((err) => {
  fail('case6_travel_destination_missing_climate_fallback', err && err.message ? err.message : String(err));
  console.log(`\nSynthetic checks completed: failures=${failures} warnings=${warnings}`);
  process.exit(1);
});
NODE
