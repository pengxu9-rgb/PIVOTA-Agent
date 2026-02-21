function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function clamp100(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.round(n);
}

function normalizeLanguage(language) {
  return String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function getRiskModifiers(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const barrier = String(p.barrierStatus || '').toLowerCase();
  const sensitivity = String(p.sensitivity || '').toLowerCase();
  const goals = Array.isArray(p.goals) ? p.goals.map((g) => String(g || '').toLowerCase()) : [];
  const oilyOrAcneGoal = goals.some((g) => /(acne|oily|oil|控痘|出油)/i.test(g));
  const pigmentGoal = goals.some((g) => /(dark|spot|pigment|bright|淡斑|提亮|色沉)/i.test(g));

  return {
    barrierSensitive: /(impaired|damaged|unstable|受损|不稳定)/i.test(barrier) || /(high|sensitive|敏感|高)/i.test(sensitivity),
    oilyOrAcneGoal,
    pigmentGoal,
  };
}

function componentFromWeather(summary = {}, reported = {}) {
  const uv = Number(summary.uv_index_max);
  const humidity = Number(summary.humidity_mean);
  const swing = Number(summary.temp_swing_c);
  const wind = Number(summary.wind_kph_max);

  const humidityScore = Number.isFinite(humidity)
    ? humidity >= 80
      ? 0.92
      : humidity >= 70
        ? 0.78
        : humidity >= 60
          ? 0.62
          : humidity >= 45
            ? 0.45
            : humidity >= 35
              ? 0.62
              : 0.82
    : 0.5;

  const uvScore = Number.isFinite(uv)
    ? uv >= 9
      ? 1
      : uv >= 7
        ? 0.86
        : uv >= 5
          ? 0.66
          : uv >= 3
            ? 0.44
            : 0.24
    : 0.4;

  const swingScore = Number.isFinite(swing)
    ? swing >= 14
      ? 0.9
      : swing >= 10
        ? 0.72
        : swing >= 7
          ? 0.56
          : swing >= 4
            ? 0.38
            : 0.24
    : 0.4;

  const windScore = Number.isFinite(wind)
    ? wind >= 35
      ? 0.92
      : wind >= 25
        ? 0.76
        : wind >= 18
          ? 0.58
          : wind >= 12
            ? 0.42
            : 0.24
    : 0.3;

  const pollutionScore = (() => {
    const text = String(reported.condition || '').toLowerCase();
    if (/pollut|smog|雾霾|污染/.test(text)) return 0.82;
    if (/clean|低污染/.test(text)) return 0.34;
    return 0.5;
  })();

  return {
    uv: clamp01(uvScore),
    humidity: clamp01(humidityScore),
    temp_swing: clamp01(swingScore),
    wind: clamp01(windScore),
    pollution: clamp01(pollutionScore),
  };
}

function weightByProfile(components, modifiers) {
  const weights = {
    uv: 0.28,
    humidity: 0.2,
    temp_swing: 0.2,
    wind: 0.16,
    pollution: 0.16,
  };

  if (modifiers.barrierSensitive) {
    weights.temp_swing += 0.06;
    weights.wind += 0.06;
    weights.pollution += 0.04;
    weights.humidity -= 0.06;
    weights.uv -= 0.1;
  }
  if (modifiers.oilyOrAcneGoal) {
    weights.humidity += 0.08;
    weights.pollution += 0.02;
    weights.temp_swing -= 0.04;
    weights.wind -= 0.03;
    weights.uv -= 0.03;
  }
  if (modifiers.pigmentGoal) {
    weights.uv += 0.1;
    weights.temp_swing -= 0.03;
    weights.wind -= 0.03;
    weights.humidity -= 0.02;
    weights.pollution -= 0.02;
  }

  const weightSum = Object.values(weights).reduce((sum, value) => sum + Math.max(0.05, value), 0);
  const normalized = {};
  for (const [key, value] of Object.entries(weights)) {
    normalized[key] = Math.max(0.05, value) / weightSum;
  }

  const score =
    components.uv * normalized.uv +
    components.humidity * normalized.humidity +
    components.temp_swing * normalized.temp_swing +
    components.wind * normalized.wind +
    components.pollution * normalized.pollution;

  return {
    score,
    weights: normalized,
  };
}

function buildStrategy({ epi, components, language }) {
  const lang = normalizeLanguage(language);
  const highUv = components.uv >= 0.75;
  const highHumidity = components.humidity >= 0.75;
  const highBarrierStress = components.temp_swing >= 0.7 || components.wind >= 0.7;
  const highPollution = components.pollution >= 0.7;

  const am = [];
  const pm = [];
  const notes = [];

  if (lang === 'CN') {
    am.push('温和清洁');
    am.push(highUv ? '高倍广谱防晒（优先 SPF50+）' : '广谱防晒（至少 SPF30）');
    am.push(highHumidity ? '轻薄保湿，避免叠加过多封闭型产品' : '保湿修护（神经酰胺/甘油）');
    if (highPollution) am.push('可加抗氧化步骤（耐受前提下）');

    pm.push('彻底卸除防晒后温和清洁');
    pm.push(highBarrierStress ? '屏障修护面霜优先' : '基础保湿');
    pm.push('新活性减量或隔天引入');

    if (epi >= 70) notes.push('环境压力高：本周优先稳态，避免叠加强活性。');
    if (highUv) notes.push('高UV阶段减少刷酸频次，外出记得补涂。');
    if (highBarrierStress) notes.push('温差/风大时增加面部封闭修护。');
  } else {
    am.push('Gentle cleanse');
    am.push(highUv ? 'High-protection broad-spectrum sunscreen (prefer SPF 50+)' : 'Broad-spectrum sunscreen (at least SPF 30)');
    am.push(highHumidity ? 'Lightweight hydration; avoid over-occlusion' : 'Barrier-support hydration (ceramides/glycerin)');
    if (highPollution) am.push('Add an antioxidant step if tolerated');

    pm.push('Cleanse thoroughly after sunscreen');
    pm.push(highBarrierStress ? 'Prioritize barrier-repair moisturizer' : 'Baseline hydration');
    pm.push('Reduce frequency for new strong actives');

    if (epi >= 70) notes.push('High environmental pressure: stabilize first, avoid stacking actives this week.');
    if (highUv) notes.push('Reduce exfoliation around high-UV days and reapply sunscreen outdoors.');
    if (highBarrierStress) notes.push('Increase barrier-protective layers on windy/high-swing days.');
  }

  return { am, pm, notes };
}

function buildRecoWeights(components) {
  const spf = clamp01(0.6 + components.uv * 0.5);
  const barrierRepair = clamp01(0.5 + Math.max(components.wind, components.temp_swing) * 0.5);
  const antiInflammatory = clamp01(0.45 + components.pollution * 0.4 + components.humidity * 0.2);
  const exfoliation = clamp01(0.45 - components.uv * 0.3 - components.temp_swing * 0.2);

  return {
    spf,
    barrier_repair: barrierRepair,
    anti_inflammatory: antiInflammatory,
    exfoliation,
  };
}

function buildEpiPayload({ weather, profile, language, userReportedConditions } = {}) {
  const source = String((weather && weather.source) || 'user_reported');
  const summary = weather && weather.summary && typeof weather.summary === 'object' ? weather.summary : {};
  const components = componentFromWeather(summary, userReportedConditions || {});
  const modifiers = getRiskModifiers(profile);
  const weighted = weightByProfile(components, modifiers);
  const epi = clamp100(weighted.score * 100);
  const strategy = buildStrategy({ epi, components, language });
  const recoWeights = buildRecoWeights(components);

  return {
    env_source: source,
    epi,
    components,
    strategy,
    reco_weights: recoWeights,
    weights: weighted.weights,
  };
}

module.exports = {
  buildEpiPayload,
  __internal: {
    componentFromWeather,
    getRiskModifiers,
    weightByProfile,
    buildStrategy,
    buildRecoWeights,
  },
};
