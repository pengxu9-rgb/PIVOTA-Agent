const { getAuroraKbV0 } = require('./kbV0/loader');

const ACTION_CODE_ALLOWLIST = new Set([
  'separate_time',
  'reduce_frequency',
  'swap_step',
  'avoid_layering',
  'pause_until_calm',
]);

function normalizeText(value, { maxLen } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return '';
  if (typeof maxLen === 'number' && Number.isFinite(maxLen) && maxLen > 0) return s.slice(0, maxLen);
  return s;
}

function i18n(en, zh) {
  const enText = normalizeText(en, { maxLen: 220 });
  const zhText = normalizeText(zh, { maxLen: 220 });
  return {
    en: enText || zhText || '—',
    zh: zhText || enText || '—',
  };
}

const RULE_REGISTRY = {
  retinoid_x_acids: {
    rule_id: 'retinoid_x_acids',
    headline_i18n: i18n('Retinoid × acids', '维A类 × 酸类'),
    why_i18n: i18n(
      'Using retinoids with AHAs/BHAs in the same routine can significantly increase irritation and barrier stress.',
      '维A类与 AHA/BHA 同晚叠加更容易刺激、爆皮，并加重屏障压力。',
    ),
    recommendations: [
      { action_code: 'separate_time', text_i18n: i18n('Alternate nights (don’t layer on the same night).', '错开晚用（不要同晚叠加）。') },
      { action_code: 'reduce_frequency', text_i18n: i18n('Start 1–2×/week and increase only if tolerated.', '先从每周 1–2 次开始，耐受后再加。') },
      { action_code: 'pause_until_calm', text_i18n: i18n('If stinging/redness: pause strong actives for 5–7 days.', '若刺痛/泛红：暂停强刺激活性 5–7 天。') },
    ],
  },
  retinoid_x_bpo: {
    rule_id: 'retinoid_x_bpo',
    headline_i18n: i18n('Retinoid × benzoyl peroxide', '维A类 × 过氧化苯甲酰'),
    why_i18n: i18n(
      'Layering retinoids with benzoyl peroxide can be very irritating and may reduce efficacy.',
      '维A类与过氧化苯甲酰同用往往更刺激，且可能影响功效。',
    ),
    recommendations: [
      { action_code: 'separate_time', text_i18n: i18n('Use on different nights (or AM/PM separation if advised).', '错开使用（或在指导下分 AM/PM）。') },
      { action_code: 'pause_until_calm', text_i18n: i18n('If barrier is impaired, prioritize calming + repair first.', '若屏障受损，先以舒缓修护为主。') },
    ],
  },
  vitc_x_acids: {
    rule_id: 'vitc_x_acids',
    headline_i18n: i18n('Vitamin C × acids', '维C × 酸类'),
    why_i18n: i18n(
      'Strong vitamin C plus exfoliating acids can be too irritating for some skin; separating them often improves tolerance.',
      '高强度维C与去角质酸叠加可能偏刺激；错开使用通常更稳妥。',
    ),
    recommendations: [
      { action_code: 'separate_time', text_i18n: i18n('Separate AM vs PM (or alternate days).', '分 AM/PM 使用（或隔天用）。') },
      { action_code: 'reduce_frequency', text_i18n: i18n('Lower frequency if tingling or dryness occurs.', '若刺痛/干燥，降低频次。') },
    ],
  },
  multiple_exfoliants: {
    rule_id: 'multiple_exfoliants',
    headline_i18n: i18n('Multiple exfoliants', '多重去角质'),
    why_i18n: i18n(
      'Using multiple exfoliating acids increases the risk of over-exfoliation (dryness, stinging, breakouts).',
      '多种酸类叠加更容易“过度去角质”（干燥、刺痛、爆痘）。',
    ),
    recommendations: [
      { action_code: 'reduce_frequency', text_i18n: i18n('Keep exfoliation to 2–3×/week total.', '整体控制在每周 2–3 次。') },
      { action_code: 'avoid_layering', text_i18n: i18n('Avoid stacking acids in the same routine.', '避免同一流程叠加酸类。') },
    ],
  },
};

function getRuleCopy(ruleId) {
  const id = normalizeText(ruleId, { maxLen: 80 });
  if (!id) return null;
  if (RULE_REGISTRY[id]) return RULE_REGISTRY[id];

  const kb = getAuroraKbV0();
  if (!kb || kb.ok === false) return null;
  const interactions = Array.isArray(kb.interaction_rules && kb.interaction_rules.interactions)
    ? kb.interaction_rules.interactions
    : [];
  const interaction = interactions.find((row) => row && String(row.interaction_id || '').trim() === id);
  if (!interaction) return null;

  const conceptA = String(interaction.concept_a || '').trim().toUpperCase();
  const conceptB = String(interaction.concept_b || '').trim().toUpperCase();
  const conceptMap = kb.concepts_by_id && typeof kb.concepts_by_id === 'object' ? kb.concepts_by_id : {};
  const labelA = normalizeText(
    conceptMap[conceptA] && conceptMap[conceptA].labels
      ? (conceptMap[conceptA].labels.en || conceptMap[conceptA].labels.zh || conceptA)
      : conceptA,
    { maxLen: 60 },
  ) || conceptA;
  const labelB = normalizeText(
    conceptMap[conceptB] && conceptMap[conceptB].labels
      ? (conceptMap[conceptB].labels.en || conceptMap[conceptB].labels.zh || conceptB)
      : conceptB,
    { maxLen: 60 },
  ) || conceptB;

  const notes = normalizeText(interaction.notes, { maxLen: 220 });
  const action = normalizeText(interaction.recommended_action, { maxLen: 60 }).toLowerCase();
  const recommendationRows = [];
  if (action === 'avoid_same_night') {
    recommendationRows.push(
      { action_code: 'avoid_layering', text_i18n: i18n('Avoid layering these in the same night.', '避免同晚叠加这两类活性。') },
      { action_code: 'separate_time', text_i18n: i18n('Alternate nights and monitor irritation.', '建议隔天使用并观察刺激反应。') },
    );
  } else if (action === 'separate_days') {
    recommendationRows.push(
      { action_code: 'separate_time', text_i18n: i18n('Use on separate days.', '建议分开到不同天使用。') },
      { action_code: 'reduce_frequency', text_i18n: i18n('Lower frequency if irritation appears.', '如出现刺激，先降低频次。') },
    );
  } else {
    recommendationRows.push(
      { action_code: 'reduce_frequency', text_i18n: i18n('Layer cautiously and start with low frequency.', '谨慎叠加并从低频开始。') },
    );
  }

  return {
    rule_id: id,
    headline_i18n: i18n(`${labelA} × ${labelB}`, `${labelA} × ${labelB}`),
    why_i18n: i18n(
      notes || 'Potential interaction risk detected between these actives.',
      notes || '这两类活性存在潜在叠加风险。',
    ),
    recommendations: recommendationRows,
  };
}

function filterRecommendations(recommendations) {
  const out = [];
  for (const rec of Array.isArray(recommendations) ? recommendations : []) {
    if (!rec || typeof rec !== 'object') continue;
    const code = normalizeText(rec.action_code, { maxLen: 60 });
    if (!code || !ACTION_CODE_ALLOWLIST.has(code)) continue;
    const text = rec.text_i18n && typeof rec.text_i18n === 'object' ? rec.text_i18n : null;
    if (!text || typeof text.en !== 'string' || typeof text.zh !== 'string') continue;
    out.push({ en: normalizeText(text.en, { maxLen: 160 }) || '—', zh: normalizeText(text.zh, { maxLen: 160 }) || '—' });
    if (out.length >= 3) break;
  }
  return out;
}

function getDefaultRuleCopy(ruleId) {
  const id = normalizeText(ruleId, { maxLen: 80 }) || 'unknown_rule';
  return {
    rule_id: id,
    headline_i18n: i18n('Compatibility caution', '兼容性提示'),
    why_i18n: i18n('A routine compatibility rule was triggered, but details are not available.', '触发了流程兼容性规则，但缺少可展示的细节。'),
    recommendations: [
      { action_code: 'reduce_frequency', text_i18n: i18n('Reduce frequency and patch test if you feel irritation.', '若感觉刺激，降低频次并先做局部测试。') },
    ],
  };
}

module.exports = {
  getRuleCopy,
  getDefaultRuleCopy,
  filterRecommendations,
  i18n,
  normalizeText,
};
