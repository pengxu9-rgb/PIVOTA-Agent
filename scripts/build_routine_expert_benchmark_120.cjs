#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'datasets', 'routine_expert_benchmark_120.json');

const DIMENSIONS = [
  'accuracy',
  'actionability',
  'risk_control',
  'phase_clarity',
  'personalization',
  'evidence_traceability',
];

const scenarios = [
  {
    key: 'oil_tight_dull_pores',
    tags: ['油+紧绷+暗沉毛孔', 'missing_spf', 'over_cleansing'],
    profile: { skinType: 'oily', sensitivity: 'low', barrierStatus: 'impaired', goals: ['pores', 'dullness'] },
    am: { cleanser: 'Biotherm Force Cleanser', moisturizer: 'Aquasource Hydra Barrier Cream' },
    pm: { cleanser: 'Biotherm Force Cleanser', moisturizer: 'Aquasource Hydra Barrier Cream' },
    notes: {
      CN: ['洗完脸紧绷刺痛，毛孔更明显，最近也更暗沉。', '白天不常涂防晒，晚上会觉得脸发干。'],
      EN: ['Face feels tight and stingy after cleansing, pores look more visible and skin looks dull.', 'I usually skip SPF in daytime and feel dry at night.'],
    },
    ask: {
      CN: '请给我一个先稳住再解决暗沉毛孔的计划。',
      EN: 'Give me a plan that stabilizes first, then targets dullness and pores.',
    },
  },
  {
    key: 'sensitive_barrier_flare',
    tags: ['敏感屏障波动', 'barrier_stress', 'safety_first'],
    profile: { skinType: 'combination', sensitivity: 'high', barrierStatus: 'impaired', goals: ['redness', 'hydration'] },
    am: { cleanser: 'Foaming Cleanser', moisturizer: 'Barrier Cream with Fragrance' },
    pm: { cleanser: 'Foaming Cleanser', treatment: 'AHA serum', moisturizer: 'Barrier Cream with Fragrance' },
    notes: {
      CN: ['换季会刺痛泛红，脸颊容易发热。', '最近涂完面霜会刺痛超过 40 秒。'],
      EN: ['Season changes cause stinging and redness with cheek flushing.', 'Moisturizer stings for over 40 seconds lately.'],
    },
    ask: {
      CN: '我需要低翻车率的修复方案。',
      EN: 'I need a low-risk recovery-first routine.',
    },
  },
  {
    key: 'active_stacking',
    tags: ['活性叠加', 'risk_control', 'phase_progression'],
    profile: { skinType: 'combination', sensitivity: 'medium', barrierStatus: 'impaired', goals: ['acne', 'texture'] },
    am: { cleanser: 'Oil Control Cleanser', treatment: 'Vitamin C 15%', moisturizer: 'Gel Cream' },
    pm: { cleanser: 'Oil Control Cleanser', treatment: 'Retinol + AHA + BHA toner', moisturizer: 'Gel Cream' },
    notes: {
      CN: ['我把很多活性叠在一起，最近有刺痛和脱皮。', '想要继续祛痘但不想爆皮。'],
      EN: ['I stacked multiple actives and now have stinging and peeling.', 'I still want acne control without irritation spikes.'],
    },
    ask: {
      CN: '请给我一个分阶段降风险方案。',
      EN: 'Give me a phased de-risking plan.',
    },
  },
  {
    key: 'missing_spf_brightening_goal',
    tags: ['缺防晒', 'goal_mismatch', 'brightening'],
    profile: { skinType: 'normal', sensitivity: 'low', barrierStatus: 'healthy', goals: ['dullness', 'dark_spots'] },
    am: { cleanser: 'Gentle Cleanser', moisturizer: 'Hydrating Lotion' },
    pm: { cleanser: 'Gentle Cleanser', treatment: 'Niacinamide 5%', moisturizer: 'Hydrating Lotion' },
    notes: {
      CN: ['想提亮和淡印，但我白天基本不涂防晒。', '最近肤色看起来发灰。'],
      EN: ['I want brightening and dark-spot improvement but I rarely use SPF.', 'Skin tone looks gray and uneven lately.'],
    },
    ask: {
      CN: '请给可执行的提亮闭环。',
      EN: 'Provide an executable brightening loop.',
    },
  },
  {
    key: 'high_risk_safety_boundary',
    tags: ['高风险安全边界', 'pregnancy_lactation_or_rx', 'safety'],
    profile: {
      skinType: 'combination',
      sensitivity: 'medium',
      barrierStatus: 'impaired',
      goals: ['acne', 'pores'],
      safetyFlags: ['pregnancy'],
    },
    am: { cleanser: 'Foaming Cleanser', moisturizer: 'Light Cream', spf: 'SPF50' },
    pm: { cleanser: 'Foaming Cleanser', treatment: 'Retinol serum', moisturizer: 'Light Cream' },
    notes: {
      CN: ['我在备孕/孕期，担心方案安全性。', '希望既控油又别刺激。'],
      EN: ['I am trying to conceive / pregnant and worried about safety constraints.', 'Need oil control without triggering irritation.'],
    },
    ask: {
      CN: '请按安全边界重排方案。',
      EN: 'Re-sequence my routine with strict safety boundaries.',
    },
  },
  {
    key: 'travel_weather_stress',
    tags: ['travel_weather_stress', 'env_stress', 'personalization'],
    profile: { skinType: 'combination', sensitivity: 'medium', barrierStatus: 'healthy', goals: ['hydration', 'texture'] },
    am: { cleanser: 'Gentle Cleanser', moisturizer: 'Hydrating Gel', spf: 'SPF30' },
    pm: { cleanser: 'Gentle Cleanser', treatment: 'Niacinamide', moisturizer: 'Hydrating Gel' },
    notes: {
      CN: ['这周从潮湿城市到干冷城市出差，皮肤忽油忽干。', '需要可执行的出差版本。'],
      EN: ['I travel from humid to cold-dry climate this week and skin swings between oily and dry.', 'Need a practical travel-safe version.'],
    },
    ask: {
      CN: '请给我环境变化下的分阶段计划。',
      EN: 'Provide a phased routine for weather-transition stress.',
    },
  },
];

const cleanserVariants = [
  'Biotherm Force Cleanser',
  'Deep Clean Foaming Cleanser',
  'Foaming Cleanser',
  'Gel Cleanser',
];
const moisturizerVariants = [
  'Aquasource Hydra Barrier Cream',
  'Hydra Barrier Cream',
  'Barrier Lotion',
  'Light Gel Cream',
];

function deepClone(input) {
  return JSON.parse(JSON.stringify(input));
}

function buildCase({ language, idx, scenario, variant }) {
  const localizedNotes = scenario.notes[language];
  const notes = localizedNotes[variant % localizedNotes.length];
  const prompt = scenario.ask[language];
  const profile = deepClone(scenario.profile);
  const currentRoutine = {
    schema_version: 'aurora.routine_intake.v1',
    am: [
      { step: 'cleanser', product: cleanserVariants[(idx + variant) % cleanserVariants.length] || scenario.am.cleanser },
      ...(scenario.am.treatment ? [{ step: 'treatment', product: scenario.am.treatment }] : []),
      ...(scenario.am.moisturizer ? [{ step: 'moisturizer', product: moisturizerVariants[(idx + variant) % moisturizerVariants.length] || scenario.am.moisturizer }] : []),
      ...(scenario.am.spf ? [{ step: 'spf', product: scenario.am.spf }] : []),
    ],
    pm: [
      { step: 'cleanser', product: cleanserVariants[(idx + variant + 1) % cleanserVariants.length] || scenario.pm.cleanser },
      ...(scenario.pm.treatment ? [{ step: 'treatment', product: scenario.pm.treatment }] : []),
      ...(scenario.pm.moisturizer ? [{ step: 'moisturizer', product: moisturizerVariants[(idx + variant + 1) % moisturizerVariants.length] || scenario.pm.moisturizer }] : []),
    ],
    notes,
  };

  return {
    id: `routine_bm_${String(idx + 1).padStart(3, '0')}`,
    language,
    scenario_key: scenario.key,
    tags: scenario.tags,
    prompt,
    profile,
    currentRoutine,
    expected_modules: ['key_issues', 'plan_7d', 'phase_plan', 'primary_question'],
    rubric_dimensions: DIMENSIONS,
  };
}

function buildDataset({ cnCount = 80, enCount = 40 } = {}) {
  const cases = [];
  let idx = 0;
  for (let i = 0; i < cnCount; i += 1) {
    const scenario = scenarios[i % scenarios.length];
    const variant = Math.floor(i / scenarios.length);
    cases.push(buildCase({ language: 'CN', idx, scenario, variant }));
    idx += 1;
  }
  for (let i = 0; i < enCount; i += 1) {
    const scenario = scenarios[i % scenarios.length];
    const variant = Math.floor(i / scenarios.length);
    cases.push(buildCase({ language: 'EN', idx, scenario, variant }));
    idx += 1;
  }
  return cases;
}

function main() {
  const cases = buildDataset({ cnCount: 80, enCount: 40 });
  const payload = {
    schema_version: 'routine_expert_benchmark.v1',
    generated_at: new Date().toISOString(),
    totals: { total: cases.length, CN: 80, EN: 40 },
    rubric_dimensions: DIMENSIONS,
    cases,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote benchmark dataset: ${OUT_PATH}`);
  console.log(`Total=${cases.length} CN=80 EN=40`);
}

main();
