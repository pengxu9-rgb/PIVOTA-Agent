function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value, maxLen = 220) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.slice(0, maxLen);
}

function toNumber(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundTo(value, digits = 1) {
  const n = toNumber(value);
  if (n == null) return null;
  const base = 10 ** digits;
  return Math.round(n * base) / base;
}

function uniqStrings(values, max = 10) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = normalizeText(raw, 120);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeForecastWindowRows(rows) {
  const out = [];
  const list = Array.isArray(rows) ? rows : [];
  for (const item of list) {
    const row = isPlainObject(item) ? item : {};
    const date = normalizeText(row.date, 24);
    if (!date) continue;
    out.push({
      date,
      temp_low_c: toNumber(row.temp_low_c),
      temp_high_c: toNumber(row.temp_high_c),
      humidity_mean: toNumber(row.humidity_mean),
      uv_max: toNumber(row.uv_max),
      precip_mm: toNumber(row.precip_mm),
      wind_kph: toNumber(row.wind_kph),
      condition_text: normalizeText(row.condition_text, 120) || null,
    });
    if (out.length >= 7) break;
  }
  return out;
}

function normalizeTravelAlerts(alerts, language) {
  const out = [];
  const list = Array.isArray(alerts) ? alerts : [];
  for (const item of list) {
    const row = isPlainObject(item) ? item : {};
    const title = normalizeText(row.title, 160);
    const severity = normalizeText(row.severity, 24);
    if (!title && !severity) continue;
    out.push({
      provider: normalizeText(row.provider, 80) || null,
      severity: severity || null,
      title: title || null,
      summary: normalizeText(row.summary, 260) || null,
      start_at: normalizeText(row.start_at, 64) || null,
      end_at: normalizeText(row.end_at, 64) || null,
      region: normalizeText(row.region, 120) || null,
      action_hint:
        normalizeText(row.action_hint, 220) ||
        t(language, '请持续关注官方天气预警并动态调整行程。', 'Please monitor official alerts and adjust plans dynamically.'),
    });
    if (out.length >= 4) break;
  }
  return out;
}

function buildRecoBundle({ language, deltaVsHome, profile } = {}) {
  const out = [];
  const delta = isPlainObject(deltaVsHome) ? deltaVsHome : {};
  const skinType = normalizeText(profile && profile.skinType, 48).toLowerCase();
  const sensitive = normalizeText(profile && profile.sensitivity, 24).toLowerCase();
  const barrier = normalizeText(profile && profile.barrierStatus, 48).toLowerCase();

  const uvDestination = toNumber(delta?.uv?.destination);
  const uvDelta = toNumber(delta?.uv?.delta);
  if ((uvDestination != null && uvDestination >= 6) || (uvDelta != null && uvDelta >= 1.5)) {
    out.push({
      trigger: t(language, 'UV 升高', 'Elevated UV'),
      action: t(
        language,
        '白天使用 SPF50+；户外每 2 小时补涂，出汗或擦拭后立即补涂。',
        'Use SPF50+ in daytime; reapply every 2 hours outdoors, and immediately after sweat/wipe-off.',
      ),
      ingredient_logic: t(language, '优先高 UVA 防护 + 成膜稳定体系。', 'Prioritize high UVA protection and photostable film-formers.'),
      product_types: [
        t(language, '防晒乳 SPF50+', 'SPF50+ sunscreen fluid'),
        t(language, '便携补涂（防晒棒/小支）', 'Portable reapplication format'),
      ],
      reapply_rule: t(language, '户外 >90 分钟：2 小时补涂一次。', 'If outdoors >90 minutes: reapply every 2 hours.'),
    });
  }

  const humidityDelta = toNumber(delta?.humidity?.delta);
  const temperatureDelta = toNumber(delta?.temperature?.delta);
  if ((humidityDelta != null && humidityDelta >= 8) || (temperatureDelta != null && temperatureDelta >= 3)) {
    out.push({
      trigger: t(language, '湿热上升', 'Warmer / more humid'),
      action: t(
        language,
        '早上改轻薄保湿，夜间保留修护霜；活性产品避免同晚叠加。',
        'Switch to lighter AM hydration, keep PM repair cream, and avoid same-night active stacking.',
      ),
      ingredient_logic: t(language, '控油同时维持屏障水分平衡。', 'Balance oil control with barrier hydration.'),
      product_types: [
        t(language, '轻薄凝胶面霜', 'Light gel-cream moisturizer'),
        t(language, '补水修护面膜', 'Hydrating recovery mask'),
      ],
      reapply_rule: t(language, '飞行/长时空调后当晚优先补水修护一次。', 'After flight or long AC exposure, run one recovery hydration session at night.'),
    });
  } else {
    out.push({
      trigger: t(language, '温差/干燥', 'Temperature swing / dryness'),
      action: t(
        language,
        '早晚使用中等修护面霜；风大时在鼻翼/颧骨局部加一层封层。',
        'Use medium barrier cream AM/PM; add a thin occlusive layer on exposed zones when windy.',
      ),
      ingredient_logic: t(language, '优先神经酰胺、泛醇、舒缓修护体系。', 'Prioritize ceramides, panthenol, and soothing repair systems.'),
      product_types: [
        t(language, '修护面霜', 'Barrier repair cream'),
        t(language, '舒缓精华', 'Soothing serum'),
      ],
      reapply_rule: t(language, '白天按干燥紧绷感补涂保湿。', 'Reapply moisturizer in daytime based on tightness/dryness.'),
    });
  }

  out.push({
    trigger: t(language, '飞行与作息变化', 'Flight and schedule shift'),
    action: t(
      language,
      '落地当晚先做补水修护，不建议叠加高强度酸/维A。',
      'On arrival night, prioritize hydration and recovery; avoid stacking strong acids/retinoids.',
    ),
    ingredient_logic: t(language, '降低刺激阈值风险。', 'Reduce irritation-threshold risk during transition.'),
    product_types: [
      t(language, '修护面膜', 'Recovery mask'),
      t(language, '温和洁面', 'Gentle cleanser'),
    ],
    reapply_rule: t(language, '次日晚再恢复常规活性频次。', 'Resume regular active cadence from the second night onward.'),
  });

  if (sensitive === 'high' || barrier.includes('impaired')) {
    out.push({
      trigger: t(language, '敏感/屏障易受损', 'Sensitive / barrier-vulnerable'),
      action: t(
        language,
        '旅行期把主活性降到每晚最多一种，优先稳态。',
        'During travel, keep at most one main active per night and prioritize stability.',
      ),
      ingredient_logic: t(language, '减少刺激叠加，避免屏障波动。', 'Minimize cumulative irritation and barrier instability.'),
      product_types: [
        t(language, '低刺激修护乳', 'Low-irritation repair lotion'),
      ],
      reapply_rule: t(language, '若出现刺痛/泛红，暂停活性 48 小时。', 'If stinging/redness appears, pause actives for 48 hours.'),
    });
  } else if (skinType.includes('oily')) {
    out.push({
      trigger: t(language, '油皮易闷痘', 'Oily skin congestion risk'),
      action: t(
        language,
        '优先轻薄防晒与非封闭型保湿，减少高致痘负担配方。',
        'Prioritize lightweight sunscreen and non-occlusive hydration to reduce congestion load.',
      ),
      ingredient_logic: t(language, '维持清爽肤感并控制毛孔负担。', 'Maintain breathable finish and reduce pore burden.'),
      product_types: [
        t(language, '控油防晒', 'Oil-control sunscreen'),
        t(language, '清爽保湿乳', 'Lightweight moisturizer'),
      ],
      reapply_rule: t(language, '中午按出油情况吸油后补防晒。', 'At midday, blot excess oil then reapply sunscreen.'),
    });
  }

  return out.slice(0, 4);
}

function buildStoreExamples({ language, destination } = {}) {
  const city = normalizeText(destination, 120).toLowerCase();
  if (!city) return [];
  if (!city.includes('paris')) return [];
  return [
    {
      name: 'Citypharma',
      type: t(language, '药妆店', 'Pharmacy'),
      address: '26 Rue du Four, 75006 Paris',
      district: '6th arrondissement',
      source: 'curated_reference',
    },
    {
      name: 'Pharmacie Monge',
      type: t(language, '药妆店', 'Pharmacy'),
      address: '74 Rue Monge, 75005 Paris',
      district: '5th arrondissement',
      source: 'curated_reference',
    },
    {
      name: 'Parapharmacie BHV Marais',
      type: t(language, '百货药妆', 'Department store beauty'),
      address: '52 Rue de Rivoli, 75004 Paris',
      district: '4th arrondissement',
      source: 'curated_reference',
    },
  ];
}

function t(language, cn, en) {
  return String(language || '').toUpperCase() === 'CN' ? cn : en;
}

function buildMetricDelta(homeValue, destinationValue, unit) {
  const h = roundTo(homeValue, 1);
  const d = roundTo(destinationValue, 1);
  const delta = h == null || d == null ? null : roundTo(d - h, 1);
  return { home: h, destination: d, delta, unit };
}

function buildSummaryTags({ temperature, humidity, uv, wind, precip, hasHomeBaseline }) {
  const tags = [];
  const push = (v) => {
    if (!v || tags.includes(v)) return;
    tags.push(v);
  };
  if (!hasHomeBaseline) push('baseline_unavailable');

  const tDelta = toNumber(temperature && temperature.delta);
  if (tDelta != null) {
    if (tDelta <= -3) push('colder');
    if (tDelta >= 3) push('warmer');
  }
  const hDelta = toNumber(humidity && humidity.delta);
  if (hDelta != null) {
    if (hDelta <= -8) push('drier');
    if (hDelta >= 8) push('more_humid');
  }
  const uvDelta = toNumber(uv && uv.delta);
  if (uvDelta != null) {
    if (uvDelta >= 1.5) push('higher_uv');
    if (uvDelta <= -1.5) push('lower_uv');
  }
  const windDelta = toNumber(wind && wind.delta);
  if (windDelta != null && windDelta >= 5) push('windier');
  const precipDelta = toNumber(precip && precip.delta);
  if (precipDelta != null && precipDelta >= 1.5) push('wetter');

  return tags.slice(0, 8);
}

function getTimezoneOffsetHours(timeZone, nowMs) {
  const tz = normalizeText(timeZone, 80);
  if (!tz) return null;
  const now = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();
  const timestamp = now - (now % 1000);
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(timestamp));
    const map = {};
    for (const part of parts) map[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour) || 0,
      Number(map.minute) || 0,
      Number(map.second) || 0,
    );
    if (!Number.isFinite(asUtc)) return null;
    return roundTo((asUtc - timestamp) / 3600000, 1);
  } catch (_err) {
    return null;
  }
}

function isValidIanaTimezone(timeZoneRaw) {
  const tz = normalizeText(timeZoneRaw, 80);
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
    return true;
  } catch (_err) {
    return false;
  }
}

const TIMEZONE_ALIAS_MAP = Object.freeze({
  'san francisco': 'America/Los_Angeles',
  'san francisco ca': 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles',
  'new york': 'America/New_York',
  london: 'Europe/London',
  paris: 'Europe/Paris',
  lyon: 'Europe/Paris',
  tokyo: 'Asia/Tokyo',
  beijing: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai',
  'hong kong': 'Asia/Hong_Kong',
  singapore: 'Asia/Singapore',
  sydney: 'Australia/Sydney',
});

function normalizeLocationHint(value) {
  const text = normalizeText(value, 160).toLowerCase();
  if (!text) return '';
  return text
    .replace(/[()]/g, ' ')
    .replace(/[,/\\_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveTimezoneFromHints(hints, fallback = 'UTC') {
  for (const raw of Array.isArray(hints) ? hints : []) {
    const direct = normalizeText(raw, 80);
    if (isValidIanaTimezone(direct)) return direct;

    const hint = normalizeLocationHint(raw);
    if (!hint) continue;
    if (TIMEZONE_ALIAS_MAP[hint]) return TIMEZONE_ALIAS_MAP[hint];

    for (const [token, tz] of Object.entries(TIMEZONE_ALIAS_MAP)) {
      if (!token) continue;
      if (hint.includes(token)) return tz;
    }
  }
  return isValidIanaTimezone(fallback) ? fallback : 'UTC';
}

function normalizePreviewProducts(recommendationCandidates, language) {
  const out = [];
  for (const row of Array.isArray(recommendationCandidates) ? recommendationCandidates : []) {
    if (!isPlainObject(row)) continue;
    const sku = isPlainObject(row.sku) ? row.sku : isPlainObject(row.product) ? row.product : row;
    const name =
      normalizeText(sku.display_name, 140) ||
      normalizeText(sku.displayName, 140) ||
      normalizeText(sku.name, 140) ||
      normalizeText(row.title, 140);
    if (!name) continue;

    const reasons = uniqStrings(
      Array.isArray(row.reasons)
        ? row.reasons
        : Array.isArray(row.warnings)
          ? row.warnings
          : [t(language, '适合当前旅行环境与肤况优先级。', 'Selected for your travel conditions and skin priorities.')],
      3,
    );

    out.push({
      rank: out.length + 1,
      product_id: normalizeText(sku.product_id || sku.productId, 120) || null,
      name,
      brand: normalizeText(sku.brand, 80) || null,
      category: normalizeText(row.step, 80) || null,
      reasons,
      price: null,
      currency: null,
    });
    if (out.length >= 3) break;
  }
  return out;
}

function normalizeFallbackPreviewProductsFromRecoBundle(recoBundle, language) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(recoBundle) ? recoBundle : []) {
    if (!isPlainObject(row)) continue;
    const category = normalizeText(row.trigger, 80) || t(language, '旅行护肤', 'Travel skincare');
    const reasons = uniqStrings(
      [
        normalizeText(row.action, 180),
        normalizeText(row.ingredient_logic, 180),
        t(language, '基于旅行环境差异的规则化建议。', 'Rule-based recommendation from travel condition deltas.'),
      ],
      3,
    );
    const productTypes = Array.isArray(row.product_types) ? row.product_types : [];
    for (const productType of productTypes) {
      const name = normalizeText(productType, 140);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        rank: out.length + 1,
        product_id: null,
        name,
        brand: null,
        category,
        reasons,
        price: null,
        currency: null,
      });
      if (out.length >= 3) return out;
    }
  }
  return out;
}

function buildAdaptiveActions({ language, summaryTags }) {
  const actions = [];
  const push = (why, whatToDo) => {
    if (!why || !whatToDo) return;
    actions.push({ why, what_to_do: whatToDo });
  };

  if (summaryTags.includes('colder') || summaryTags.includes('drier') || summaryTags.includes('windier')) {
    push(
      t(language, '目的地更冷/更干，屏障水分流失会更快。', 'Destination is colder/drier, so transepidermal water loss can rise.'),
      t(language, '把保湿升级为修护霜，夜间可局部薄封。', 'Upgrade to a richer barrier moisturizer and add a thin occlusive layer at night.'),
    );
  }

  if (summaryTags.includes('higher_uv')) {
    push(
      t(language, '目的地 UV 压力更高，色沉风险增加。', 'Higher UV pressure can increase hyperpigmentation risk.'),
      t(language, '白天固定 SPF30+ 并按户外时长补涂。', 'Keep daily SPF30+ and reapply during outdoor exposure.'),
    );
  }

  if (summaryTags.includes('more_humid') || summaryTags.includes('wetter')) {
    push(
      t(language, '目的地更湿热，闷痘风险上升。', 'Higher humidity can increase congestion risk.'),
      t(language, '改用更轻薄保湿，减少同晚多活性叠加。', 'Switch to lighter hydration and avoid same-night active stacking.'),
    );
  }

  if (actions.length < 3) {
    push(
      t(language, '旅行期优先稳态。', 'Prioritize stability during travel.'),
      t(language, 'AM 保持清洁+保湿+防晒，PM 先修护再逐步加活性。', 'Keep AM cleanse+moisturizer+sunscreen; in PM prioritize recovery before stronger actives.'),
    );
  }

  return actions.slice(0, 5);
}

function buildPersonalFocus({ language, profile, destinationSummary, summaryTags }) {
  const out = [];
  const push = (focus, why, whatToDo) => {
    out.push({ focus, why, what_to_do: whatToDo });
  };

  const barrier = normalizeText(profile && profile.barrierStatus, 40).toLowerCase();
  const sensitivity = normalizeText(profile && profile.sensitivity, 40).toLowerCase();

  if (barrier.includes('impaired') || barrier.includes('damaged')) {
    push(
      t(language, '屏障优先', 'Barrier first'),
      t(language, '屏障偏弱时更容易泛红刺痛。', 'Compromised barrier increases redness/stinging risk.'),
      t(language, '减少高频酸/维A，先稳住修护 3-5 天。', 'Reduce frequent acids/retinoids and stabilize for 3-5 days first.'),
    );
  }

  if (sensitivity === 'high' || sensitivity.includes('sensitive')) {
    push(
      t(language, '刺激阈值管理', 'Irritation threshold control'),
      t(language, '敏感阈值较低，叠加活性风险更高。', 'Lower irritation threshold raises active-stacking risk.'),
      t(language, '同晚只保留一种主活性。', 'Keep one main active per night.'),
    );
  }

  const uvMax = toNumber(destinationSummary && destinationSummary.uv_index_max);
  if ((uvMax != null && uvMax >= 7) || summaryTags.includes('higher_uv')) {
    push(
      t(language, '日晒防护', 'UV defense'),
      t(language, '目的地 UV 偏高。', 'Destination UV is elevated.'),
      t(language, '防晒补涂与物理遮挡并行。', 'Combine reapplication with physical shade/cover.'),
    );
  }

  if (!out.length) {
    push(
      t(language, '稳态优先', 'Stability first'),
      t(language, '旅行期更适合先稳住再进阶。', 'Travel periods are better for stabilization before escalation.'),
      t(language, '简化步骤，避免一次新增多件产品。', 'Simplify steps and avoid introducing many new products at once.'),
    );
  }

  return out.slice(0, 3);
}

function buildJetlagSleep({ language, profile, destinationWeather, homeWeather, destination, nowMs }) {
  const tzHome = resolveTimezoneFromHints(
    [
      homeWeather && homeWeather.location && homeWeather.location.timezone,
      profile && profile.home_timezone,
      homeWeather && homeWeather.location && homeWeather.location.name,
      profile && profile.region,
    ],
    'UTC',
  );
  const tzDestination = resolveTimezoneFromHints(
    [
      destinationWeather && destinationWeather.location && destinationWeather.location.timezone,
      destinationWeather && destinationWeather.location && destinationWeather.location.name,
      destination,
      destinationWeather && destinationWeather.destination,
      profile && profile.travel_plan && profile.travel_plan.destination,
    ],
    tzHome,
  );

  const homeOffset = getTimezoneOffsetHours(tzHome, nowMs);
  const destinationOffset = getTimezoneOffsetHours(tzDestination, nowMs);
  const hoursDiffRaw = homeOffset == null || destinationOffset == null ? null : Math.abs(destinationOffset - homeOffset);
  const hoursDiff = roundTo(hoursDiffRaw, 1);

  let riskLevel = 'low';
  if (hoursDiff != null && hoursDiff >= 9) riskLevel = 'high';
  else if (hoursDiff != null && hoursDiff >= 5) riskLevel = 'medium';

  const sleepTips = [];
  if (riskLevel === 'high') {
    sleepTips.push(
      t(language, '出发前 3 天每天平移 30-60 分钟作息。', 'Shift bedtime by 30-60 minutes for 3 days pre-trip.'),
      t(language, '落地当天按当地时区安排进食和见光。', 'Anchor meals/daylight to local time on arrival.'),
    );
  } else if (riskLevel === 'medium') {
    sleepTips.push(
      t(language, '出发前 1-2 天做轻度作息平移。', 'Make a mild schedule shift 1-2 days before departure.'),
      t(language, '减少晚间咖啡因，固定上床时间。', 'Limit late caffeine and keep a stable local bedtime.'),
    );
  } else {
    sleepTips.push(t(language, '时差风险较低，保持稳定作息即可。', 'Jet-lag risk is lower; keep sleep timing stable.'));
  }

  const maskTips = [
    t(language, '长途飞行后优先保湿修护面膜。', 'Prioritize a hydrating recovery mask after long flights.'),
    t(language, '易闷痘时优先轻薄补水面膜。', 'If congestion-prone, choose lighter hydrating masks.'),
  ];

  return {
    tz_home: tzHome,
    tz_destination: tzDestination,
    hours_diff: hoursDiff,
    risk_level: riskLevel,
    sleep_tips: sleepTips.slice(0, 4),
    mask_tips: maskTips.slice(0, 4),
  };
}

function buildConfidence({ language, profile, recentLogs, destinationWeather, hasHomeBaseline, destination }) {
  const missingInputs = [];
  if (!normalizeText(destination, 120)) missingInputs.push('destination');
  if (!isPlainObject(destinationWeather) || !isPlainObject(destinationWeather.summary)) missingInputs.push('destination_weather');
  if (!hasHomeBaseline) missingInputs.push('home_baseline_weather');
  if (!Array.isArray(recentLogs) || recentLogs.length === 0) missingInputs.push('recent_logs');
  if (!profile || profile.currentRoutine == null) missingInputs.push('current_routine');

  for (const key of ['skinType', 'sensitivity', 'barrierStatus']) {
    if (!normalizeText(profile && profile[key], 60)) missingInputs.push(`profile.${key}`);
  }

  let level = 'high';
  const envSource = normalizeText(destinationWeather && destinationWeather.source, 40);
  if (!envSource || envSource === 'climate_fallback') level = 'medium';
  if (missingInputs.includes('destination') || missingInputs.includes('destination_weather')) level = 'low';
  if (missingInputs.length >= 5 && level !== 'low') level = 'medium';

  const improveBy = [];
  if (missingInputs.includes('current_routine')) {
    improveBy.push(t(language, '补充 AM/PM routine（可选）可细化产品与频率。', 'Add optional AM/PM routine to refine products and frequency.'));
  }
  if (missingInputs.includes('recent_logs')) {
    improveBy.push(t(language, '补 2-3 条近期打卡可优化节奏。', 'Add 2-3 recent check-ins to tune cadence.'));
  }
  if (missingInputs.includes('home_baseline_weather')) {
    improveBy.push(t(language, '设置常驻地 region 可得到更准确 delta。', 'Set home region for clearer destination-vs-home deltas.'));
  }

  return {
    level,
    missing_inputs: uniqStrings(missingInputs, 12),
    improve_by: uniqStrings(improveBy, 6),
  };
}

function buildTravelReadiness({
  language = 'EN',
  profile = {},
  recentLogs = [],
  destination,
  startDate,
  endDate,
  destinationWeather,
  homeWeather,
  travelAlerts = [],
  epiPayload,
  recommendationCandidates = [],
  nowMs = Date.now(),
} = {}) {
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const destinationText = normalizeText(destination, 120);

  const destinationSummary = isPlainObject(destinationWeather && destinationWeather.summary)
    ? destinationWeather.summary
    : null;
  const homeSummary = isPlainObject(homeWeather && homeWeather.summary) ? homeWeather.summary : null;
  const hasHomeBaseline = Boolean(homeSummary);
  const forecastWindow = normalizeForecastWindowRows(destinationWeather && destinationWeather.forecast_window);
  const alerts = normalizeTravelAlerts(travelAlerts, lang);

  const temperature = buildMetricDelta(homeSummary && homeSummary.temperature_max_c, destinationSummary && destinationSummary.temperature_max_c, 'C');
  const humidity = buildMetricDelta(homeSummary && homeSummary.humidity_mean, destinationSummary && destinationSummary.humidity_mean, '%');
  const uv = buildMetricDelta(homeSummary && homeSummary.uv_index_max, destinationSummary && destinationSummary.uv_index_max, '');
  const wind = buildMetricDelta(homeSummary && homeSummary.wind_kph_max, destinationSummary && destinationSummary.wind_kph_max, 'kph');
  const precip = buildMetricDelta(homeSummary && homeSummary.precipitation_mm, destinationSummary && destinationSummary.precipitation_mm, 'mm');

  const summaryTags = buildSummaryTags({ temperature, humidity, uv, wind, precip, hasHomeBaseline });
  const adaptiveActions = buildAdaptiveActions({ language: lang, summaryTags });
  const personalFocus = buildPersonalFocus({ language: lang, profile, destinationSummary, summaryTags });
  const jetlagSleep = buildJetlagSleep({
    language: lang,
    profile,
    destinationWeather,
    homeWeather,
    destination: destinationText,
    nowMs,
  });
  const confidence = buildConfidence({ language: lang, profile, recentLogs, destinationWeather, hasHomeBaseline, destination: destinationText });
  const recoBundle = buildRecoBundle({
    language: lang,
    deltaVsHome: {
      temperature,
      humidity,
      uv,
      wind,
      precip,
    },
    profile,
  });
  const storeExamples = buildStoreExamples({ language: lang, destination: destinationText });
  const previewProductsFromCatalog = normalizePreviewProducts(recommendationCandidates, lang);
  const previewProducts = previewProductsFromCatalog.length
    ? previewProductsFromCatalog
    : normalizeFallbackPreviewProductsFromRecoBundle(recoBundle, lang);

  return {
    destination_context: {
      destination: destinationText || null,
      start_date: normalizeText(startDate, 24) || null,
      end_date: normalizeText(endDate, 24) || null,
      env_source:
        normalizeText(epiPayload && epiPayload.env_source, 40) ||
        normalizeText(destinationWeather && destinationWeather.source, 40) ||
        null,
      epi: toNumber(epiPayload && epiPayload.epi),
    },
    delta_vs_home: {
      temperature,
      humidity,
      uv,
      wind,
      precip,
      summary_tags: summaryTags,
      baseline_status: hasHomeBaseline ? 'ok' : 'baseline_unavailable',
    },
    forecast_window: forecastWindow,
    alerts,
    adaptive_actions: adaptiveActions,
    personal_focus: personalFocus,
    jetlag_sleep: jetlagSleep,
    reco_bundle: recoBundle,
    store_examples: storeExamples,
    shopping_preview: {
      products: previewProducts,
      buying_channels: ['beauty_retail', 'pharmacy', 'department_store', 'duty_free', 'ecommerce'],
      city_hint: destinationText || null,
      note: t(
        lang,
        '当前提供渠道级建议；附近门店地图检索将在后续版本支持。',
        'Channels are provided in v1; nearby store map lookup will be added later.',
      ),
    },
    confidence,
  };
}

module.exports = {
  buildTravelReadiness,
  __internal: {
    buildMetricDelta,
    buildSummaryTags,
    buildJetlagSleep,
    buildConfidence,
    normalizePreviewProducts,
    normalizeFallbackPreviewProductsFromRecoBundle,
    getTimezoneOffsetHours,
    resolveTimezoneFromHints,
  },
};
