function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value, maxLen = 220) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.slice(0, maxLen);
}

function isPregnancyOrLactationActive(profile) {
  const pregnancy = normalizeText(profile && profile.pregnancy_status, 20).toLowerCase();
  const lactation = normalizeText(profile && profile.lactation_status, 20).toLowerCase();
  return pregnancy === 'pregnant' || pregnancy === 'trying' || lactation === 'lactating';
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

function uniqReasonStrings(values, max = 3, maxLen = 260) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = normalizeText(raw, maxLen);
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

function routineContainsMakeup(currentRoutine) {
  const text = normalizeText(currentRoutine, 600).toLowerCase();
  if (!text) return false;
  return /\b(makeup|foundation|concealer|powder|blush|eyeshadow|mascara|lip\s*stick)\b/.test(text) ||
    /(彩妆|粉底|遮瑕|散粉|腮红|眼影|睫毛膏|口红|卸妆)/.test(text);
}

function buildRecoBundle({ language, deltaVsHome, profile, startDate, endDate, jetlagSleep } = {}) {
  const out = [];
  const delta = isPlainObject(deltaVsHome) ? deltaVsHome : {};
  const skinType = normalizeText(profile && profile.skinType, 48).toLowerCase();
  const goals = Array.isArray(profile && profile.goals) ? profile.goals.map((g) => normalizeText(g, 60).toLowerCase()).filter(Boolean) : [];
  const currentRoutine = normalizeText(profile && profile.currentRoutine, 600);
  const hasMakeupInRoutine = routineContainsMakeup(currentRoutine);
  const isPregnantOrLactating = isPregnancyOrLactationActive(profile);

  const uvDestination = toNumber(delta?.uv?.destination);
  const uvDelta = toNumber(delta?.uv?.delta);
  const humidityDelta = toNumber(delta?.humidity?.delta);
  const temperatureDelta = toNumber(delta?.temperature?.delta);
  const highUv = (uvDestination != null && uvDestination >= 6) || (uvDelta != null && uvDelta >= 1.5);
  const moderateUv = (uvDestination != null && uvDestination >= 5);

  const tripDays = (function () {
    const s = normalizeText(startDate, 24);
    const e = normalizeText(endDate, 24);
    if (!s || !e) return null;
    const sd = new Date(`${s}T00:00:00Z`);
    const ed = new Date(`${e}T00:00:00Z`);
    if (!Number.isFinite(sd.getTime()) || !Number.isFinite(ed.getTime()) || ed < sd) return null;
    return Math.floor((ed.getTime() - sd.getTime()) / 86400000) + 1;
  })();

  // --- 1. Sun protection (always) ---
  if (highUv) {
    out.push({
      trigger: t(language, 'UV 升高', 'Elevated UV'),
      action: t(language,
        '面部 SPF50+ PA++++，户外每 2h 补涂；身体暴露部位同步涂抹身体防晒。',
        'Face: SPF50+ PA++++, reapply every 2h outdoors. Body: apply body sunscreen on exposed areas.',
      ),
      ingredient_logic: t(language,
        '优先光稳定 UVA 滤光剂（Tinosorb S/M）+ 抗氧化成膜体系；身体用大容量流体质地便于大面积涂抹。',
        'Prioritize photostable UVA filters (Tinosorb S/M) + antioxidant film-formers; body SPF in fluid texture for easy large-area application.',
      ),
      product_types: [
        t(language, '面部防晒 SPF50+ PA++++', 'Face SPF50+ PA++++ sunscreen'),
        t(language, '便携补涂（防晒棒/气垫）', 'Portable reapply format (stick/cushion)'),
        t(language, '身体防晒 SPF30+', 'Body sunscreen SPF30+'),
      ],
      reapply_rule: t(language, '户外 >90min 每 2h 补涂；出汗/擦拭/淋雨后立即补涂。', 'Outdoors >90min: reapply every 2h; immediately after sweat/wipe-off/rain.'),
    });
  } else {
    out.push({
      trigger: t(language, '日常防晒', 'Daily sun protection'),
      action: t(language,
        '面部 SPF30-50 通勤可用；连续户外超 90 分钟升至 SPF50 并补涂。',
        'Face: SPF30-50 for commuting; switch to SPF50+ and reapply if outdoors over 90 minutes continuously.',
      ),
      ingredient_logic: t(language, '轻薄成膜优先，兼顾防护力和肤感。', 'Light film-forming priority, balancing protection and skin feel.'),
      product_types: [
        t(language, '面部防晒 SPF30-50', 'Face SPF30-50 sunscreen'),
      ],
      reapply_rule: t(language, '长户外时每 2h 补涂。', 'Reapply every 2h during extended outdoor exposure.'),
    });
  }

  // --- 2. Moisturization & barrier (always, differentiated by humidity) ---
  if ((humidityDelta != null && humidityDelta >= 8) || (temperatureDelta != null && temperatureDelta >= 3)) {
    out.push({
      trigger: t(language, '湿热上升', 'Warmer / more humid'),
      action: t(language,
        'AM 改凝胶霜/水乳质地，PM 保留中等修护霜；避免同晚叠加多种活性。',
        'AM: switch to gel-cream/lotion texture. PM: keep medium repair cream. Avoid same-night multi-active stacking.',
      ),
      ingredient_logic: t(language, '控油 + 维持屏障水分平衡；避免厚重封层加重闷痘。', 'Oil control + barrier hydration balance; avoid heavy occlusives that risk congestion.'),
      product_types: [
        t(language, '凝胶面霜（AM）', 'Gel-cream moisturizer (AM)'),
        t(language, '中等修护面霜（PM）', 'Medium barrier repair cream (PM)'),
      ],
      reapply_rule: t(language, '白天按出油/紧绷状态动态调整保湿。', 'Adjust daytime hydration dynamically by oiliness/tightness.'),
    });
  } else {
    out.push({
      trigger: t(language, '温差/干燥', 'Temperature swing / dryness'),
      action: t(language,
        'AM/PM 均用修护面霜；干燥/风大时鼻翼和颧骨局部加封层。',
        'Use barrier repair cream AM/PM; add thin occlusive on nose/cheekbones when dry or windy.',
      ),
      ingredient_logic: t(language, '神经酰胺 + 泛醇 + 舒缓修护体系；封层用凡士林或角鲨烷。', 'Ceramides + panthenol + soothing repair; seal with petrolatum or squalane.'),
      product_types: [
        t(language, '修护面霜', 'Barrier repair cream'),
        t(language, '舒缓精华', 'Soothing serum'),
      ],
      reapply_rule: t(language, '白天按紧绷感补涂保湿。', 'Reapply moisturizer in daytime based on tightness.'),
    });
  }

  // --- 3. Masks (scenario-differentiated) ---
  out.push({
    trigger: t(language, '面膜（按场景）', 'Masks (scenario-based)'),
    action: t(language,
      '飞行日：补水舒缓面膜 1 次；高 UV 户外后：晒后修复面膜；干燥环境：深层补水面膜。',
      'Flight day: 1x hydrating-soothing mask. After high-UV outdoor day: post-sun repair mask. Dry climate: deep hydration mask.',
    ),
    ingredient_logic: t(language,
      '飞行修护：透明质酸 + 积雪草。晒后修复：芦荟 + 尿囊素 + 烟酰胺（冷却抗炎）。深层补水：聚谷氨酸 + 神经酰胺。',
      'Flight recovery: hyaluronic acid + centella asiatica. Post-sun: aloe vera + allantoin + niacinamide (cooling anti-inflammatory). Deep hydration: polyglutamic acid + ceramides.',
    ),
    product_types: [
      t(language, '补水舒缓面膜（飞行修护）', 'Hydrating-soothing mask (flight recovery)'),
      ...(highUv ? [t(language, '晒后修复面膜（冷却型）', 'Post-sun repair mask (cooling)')] : []),
      t(language, '深层补水面膜', 'Deep hydration mask'),
    ],
    reapply_rule: t(language, '每场景限 1 次，不叠加使用。', 'Max 1 per scenario, do not stack.'),
  });

  // --- 4. Post-sun repair (UV >= 6) ---
  if (highUv) {
    out.push({
      trigger: t(language, '晒后修复', 'Post-sun repair'),
      action: t(language,
        '户外日晒后当晚使用晒后舒缓凝胶 + 修护精华，替代常规活性步骤。',
        'After outdoor sun exposure, apply post-sun soothing gel + repair serum at night, replacing regular actives.',
      ),
      ingredient_logic: t(language,
        '芦荟凝胶（冷却舒缓）+ 泛醇/积雪草苷修护 + 烟酰胺抗炎；避免叠加酸类。',
        'Aloe vera gel (cooling) + panthenol/madecassoside repair + niacinamide anti-inflammatory; skip acids.',
      ),
      product_types: [
        t(language, '晒后舒缓凝胶', 'After-sun soothing gel'),
        t(language, '修护精华（泛醇/积雪草）', 'Repair serum (panthenol/centella)'),
      ],
      reapply_rule: t(language, '日晒当晚 + 次日早各用一次，直到皮肤恢复。', 'Apply evening of sun day + next morning, until skin recovers.'),
    });
  }

  // --- 5. Cleansing + makeup removal ---
  if (hasMakeupInRoutine) {
    out.push({
      trigger: t(language, '卸妆 + 双重清洁', 'Makeup removal + double cleanse'),
      action: t(language,
        '旅行必带卸妆膏/油（彻底溶解防晒+彩妆）+ 温和洁面二步清洁。不彻底清洁是旅行闷痘首因。',
        'Pack cleansing balm/oil (dissolves SPF+makeup thoroughly) + gentle cleanser for double cleanse. Incomplete removal is the #1 cause of travel breakouts.',
      ),
      ingredient_logic: t(language, '油脂溶解体系 + pH 5.5 弱酸性洁面；避免皂基和高 SLS 配方。', 'Oil-based dissolution + pH 5.5 gentle cleanser; avoid soap-based and high-SLS formulas.'),
      product_types: [
        t(language, '卸妆膏/卸妆油（旅行装）', 'Cleansing balm/oil (travel size)'),
        t(language, '温和洁面', 'Gentle cleanser'),
      ],
      reapply_rule: t(language, '每晚必做双重清洁。', 'Double cleanse every night without exception.'),
    });
  }

  // --- 6. Antioxidant protection ---
  if (moderateUv || goals.includes('dark_spots') || goals.includes('wrinkles')) {
    out.push({
      trigger: t(language, '抗氧化防护', 'Antioxidant protection'),
      action: t(language,
        'AM 防晒前叠加抗氧化精华，增强光防护 + 对抗环境自由基（飞机舱、污染、紫外线）。',
        'Layer antioxidant serum under AM sunscreen to boost photoprotection + combat environmental free radicals (cabin air, pollution, UV).',
      ),
      ingredient_logic: t(language,
        isPregnantOrLactating
          ? '烟酰胺 + 维生素 E + 阿魏酸（孕哺期安全抗氧化组合）。'
          : '维生素 C（旅行期用 10-15% 低浓度减少刺激）+ 维生素 E + 阿魏酸协同。',
        isPregnantOrLactating
          ? 'Niacinamide + vitamin E + ferulic acid (pregnancy-safe antioxidant combo).'
          : 'Vitamin C (use 10-15% lower concentration during travel to reduce irritation) + vitamin E + ferulic acid synergy.',
      ),
      product_types: [
        t(language, '抗氧化精华', 'Antioxidant serum'),
      ],
      reapply_rule: t(language, '每天 AM 使用 1 次，防晒前。', 'Apply once every AM, before sunscreen.'),
    });
  }

  // --- 7. Brightening / dark-spot care (conditional on goals) ---
  if (goals.includes('dark_spots') || goals.includes('brightening')) {
    out.push({
      trigger: t(language, '美白/祛斑护理', 'Brightening / dark-spot care'),
      action: t(language,
        isPregnantOrLactating
          ? '旅行期用烟酰胺 + 熊果苷温和提亮；严格防晒是最有效的旅行祛斑策略。回程后恢复常规美白流程。'
          : '旅行期降级使用低浓度维 C（10%）或传明酸精华；严格防晒是最有效的旅行祛斑策略。回程后恢复高浓度美白流程。',
        isPregnantOrLactating
          ? 'Travel: use niacinamide + arbutin for gentle brightening; strict SPF is the most effective travel anti-spot strategy. Resume regular brightening post-trip.'
          : 'Travel: downgrade to low-concentration vitamin C (10%) or tranexamic acid serum; strict SPF is the most effective travel anti-spot strategy. Resume full brightening post-trip.',
      ),
      ingredient_logic: t(language,
        isPregnantOrLactating
          ? '烟酰胺（安全美白）+ 熊果苷（酪氨酸酶抑制）。避免氢醌和高浓度维 A。'
          : '传明酸（抑制黑色素转运）/ 熊果苷（酪氨酸酶抑制）/ 烟酰胺（抗炎提亮）。',
        isPregnantOrLactating
          ? 'Niacinamide (safe brightening) + arbutin (tyrosinase inhibition). Avoid hydroquinone and high-dose retinoids.'
          : 'Tranexamic acid (melanin transport inhibition) / arbutin (tyrosinase inhibition) / niacinamide (anti-inflammatory brightening).',
      ),
      product_types: [
        t(language, '温和美白精华', 'Gentle brightening serum'),
      ],
      reapply_rule: t(language, 'PM 使用 1 次；旅行期不升浓度。', 'Apply once PM; do not increase concentration during travel.'),
    });
  }

  // --- 8. Body care (outdoor > 2 days) ---
  if (tripDays != null && tripDays > 2 && moderateUv) {
    out.push({
      trigger: t(language, '身体护理', 'Body care'),
      action: t(language,
        '身体暴露部位涂抹身体防晒 SPF30+；户外日结束后使用身体乳或晒后身体凝胶修护。',
        'Apply body SPF30+ on exposed areas; after outdoor days, use body lotion or after-sun body gel for repair.',
      ),
      ingredient_logic: t(language,
        '身体防晒：大容量防水配方。身体乳：乳木果油 + 芦荟 + 维生素 E 修护。',
        'Body SPF: large-volume water-resistant formula. Body lotion: shea butter + aloe + vitamin E repair.',
      ),
      product_types: [
        t(language, '身体防晒 SPF30+', 'Body sunscreen SPF30+'),
        t(language, '身体乳/晒后身体凝胶', 'Body lotion / after-sun body gel'),
      ],
      reapply_rule: t(language, '身体防晒每 2h 补涂一次（游泳后立即补）。', 'Reapply body SPF every 2h (immediately after swimming).'),
    });
  }

  // --- 9. Eye care (jet-lag or long flight) ---
  const jetlagHours = toNumber(jetlagSleep && jetlagSleep.hours_diff);
  if (jetlagHours != null && jetlagHours >= 5) {
    out.push({
      trigger: t(language, '眼部护理', 'Eye care'),
      action: t(language,
        '时差较大时准备眼霜 + 冷敷眼贴，飞行后和落地前 2 晚优先做眼周消肿和保湿。',
        'For larger jet-lag gaps, pack eye cream + cooling eye patches and prioritize depuffing + hydration after the flight and for the first 2 nights.',
      ),
      ingredient_logic: t(language, '咖啡因帮助消肿，透明质酸/神经酰胺帮助补水并减少眼周紧绷。', 'Caffeine helps depuff, while hyaluronic acid / ceramides support hydration and reduce peri-eye tightness.'),
      product_types: [
        t(language, '眼霜（咖啡因/透明质酸）', 'Eye cream (caffeine / hyaluronic acid)'),
        t(language, '冷敷眼贴', 'Cooling eye patches'),
      ],
      reapply_rule: t(language, '飞行后当晚使用 1 次，落地后前 2 晚持续。', 'Use once on flight-arrival night and continue for the first 2 nights after landing.'),
    });
  }

  // --- 10. Emergency kit (always) ---
  out.push({
    trigger: t(language, '应急备用', 'Emergency kit'),
    action: t(language,
      '备齐痘痘贴（旅行突发）、润唇膏（SPF 款优先）、护手霜、止痒药膏。',
      'Pack pimple patches (travel flare-ups), SPF lip balm, hand cream, and anti-itch cream.',
    ),
    ingredient_logic: t(language,
      '痘痘贴含水杨酸或水胶体；润唇膏含 SPF15+ 和角鲨烷。',
      'Pimple patches with salicylic acid or hydrocolloid; lip balm with SPF15+ and squalane.',
    ),
    product_types: [
      t(language, '痘痘贴', 'Pimple patches'),
      t(language, 'SPF 润唇膏', 'SPF lip balm'),
      t(language, '护手霜', 'Hand cream'),
    ],
    reapply_rule: t(language, '按需使用。', 'Use as needed.'),
  });

  return out.slice(0, 10);
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

function buildSummaryTags({
  temperature,
  humidity,
  uv,
  wind,
  precip,
  hasHomeBaseline,
  destinationSummary,
  absoluteTagsEnabled = false,
}) {
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

  if (absoluteTagsEnabled || !hasHomeBaseline) {
    const temperatureMax = toNumber(destinationSummary && destinationSummary.temperature_max_c);
    const humidityMean = toNumber(destinationSummary && destinationSummary.humidity_mean);
    const uvMax = toNumber(destinationSummary && destinationSummary.uv_index_max);
    const windMax = toNumber(destinationSummary && destinationSummary.wind_kph_max);
    const precipMean = toNumber(destinationSummary && destinationSummary.precipitation_mm);

    if (temperatureMax != null) {
      if (temperatureMax >= 30) push('hot');
      else if (temperatureMax <= 10) push('cold');
    }
    if (humidityMean != null) {
      if (humidityMean >= 72) push('humid');
      else if (humidityMean <= 40) push('dry');
    }
    if (uvMax != null && uvMax >= 6) push('high_uv');
    if (windMax != null && windMax >= 28) push('windy');
    if (precipMean != null && precipMean >= 3) push('rainy');
  }

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

function isWeakTravelProductReason(value) {
  const text = normalizeText(value, 220).toLowerCase();
  return !text || /^local catalog authority match\b/i.test(text) || /^category\s*:/i.test(text);
}

function buildTravelProductUseReasons({ language, roleId, category, name } = {}) {
  const role = normalizeText(roleId, 80).toLowerCase();
  const cat = normalizeText(category, 120).toLowerCase();
  const productName = normalizeText(name, 160).toLowerCase();
  const haystack = `${role} ${cat} ${productName}`;
  if (/recovery_mask/.test(role) || (/mask|recovery|soothing|修护|舒缓|面膜/.test(haystack) && !/serum|essence|ampoule|精华|安瓶/.test(role))) {
    return [
      t(language, '仅作为飞行后或高 UV 户外日后的可选夜间恢复；已耐受再用。', 'Use only as optional night recovery after the flight or high-UV outdoor days if already tolerated.'),
      t(language, '不作为每日必需步骤，避免旅行中突然增加刺激。', 'Do not treat it as a daily required step; avoid adding surprise irritation while traveling.'),
    ];
  }
  if (/body_lip_hand|body|lip|hand|身体|唇|手/.test(role) || (/body|lip|hand|身体|唇|手/.test(haystack) && !/sun_protection/.test(role))) {
    if (/lip|唇|립밤|リップ/.test(productName) || /lip|唇/.test(cat)) {
      return [
        t(language, '用于唇部，帮助应对机舱干燥和户外通勤时的唇部紧绷。', 'Use on lips to manage tightness from cabin dryness and outdoor commuting.'),
        t(language, '适合随身携带，不要把润唇产品当作手部或身体护理。', 'Fits carry-on use; do not treat a lip product as hand or body care.'),
      ];
    }
    if (/hand|手|ハンド/.test(productName) || /hand|手/.test(cat)) {
      return [
        t(language, '用于手部，帮助应对频繁清洁、机舱干燥和当地通勤带来的手部干燥。', 'Use on hands to manage dryness from cleansing, cabin air, and local commuting.'),
        t(language, '适合随身携带，在飞行和当地通勤时补充。', 'Fits carry-on use for the flight and local commuting.'),
      ];
    }
    if (/body|身体|ボディ/.test(productName) || /body|身体/.test(cat)) {
      return [
        t(language, '用于暴露身体皮肤，因为 UV 和风干不只影响脸部。', 'Use on exposed body skin because UV and dry air do not only affect the face.'),
        t(language, '适合当地户外通勤或长时间步行时补充。', 'Fits local commuting or longer outdoor walks.'),
      ];
    }
    return [
      t(language, '用于唇部、手部或暴露皮肤，因为机舱干燥和 UV 不只影响脸部。', 'Use for lips, hands, or exposed skin because cabin dryness and UV do not only affect the face.'),
      t(language, '适合随身携带，在飞行和当地通勤时补充。', 'Fits carry-on use for the flight and local commuting.'),
    ];
  }
  if (/sun|spf|uv|sunscreen|防晒/.test(haystack)) {
    return [
      t(language, '用于 AM 和户外通勤防晒；户外时间长时按暴露时长补涂。', 'Use this as the AM/outdoor SPF step; reapply based on outdoor exposure time.'),
      t(language, '适合放在当地日常和当地补买阶段，而不是机舱内新增步骤。', 'Fits the daily-there and local-shopping phases rather than adding a new in-cabin step.'),
    ];
  }
  if (/moistur|barrier|cream|lotion|lightweight|保湿|乳液|面霜/.test(haystack)) {
    return [
      t(language, '用于登机前或洁面后补轻保湿，帮助缓冲机舱干燥和落地初期紧绷。', 'Use before boarding or after cleansing for light moisture against cabin dryness and first-48h tightness.'),
      t(language, '适合需要保湿但不想叠太厚面霜的旅行场景。', 'Fits travel days when you need moisture without a heavy cream layer.'),
    ];
  }
  if (/serum|essence|ampoule|hydrat|补水|精华|安瓶/.test(haystack)) {
    return [
      t(language, '用于保湿层下面，帮助补水但不把白天步骤变厚重。', 'Use under moisturizer to add hydration without making daytime layers heavy.'),
      t(language, '适合机舱后和落地前 48 小时的轻量补水。', 'Fits post-flight and first-48h lightweight hydration.'),
    ];
  }
  if (/cleanser|clean|洁面|卸妆/.test(haystack)) {
    return [
      t(language, '用于晚间清洁防晒、汗和城市污染，避免残留影响第二天肤感。', 'Use at night to remove sunscreen, sweat, and city pollution so residue does not affect the next day.'),
    ];
  }
  return [];
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

    const roleId = normalizeText(row.role_id || row.roleId || sku.role_id || sku.roleId, 80) || null;
    const category = normalizeText(row.step, 80) || normalizeText(sku.category || sku.product_type, 80) || null;
    const rawReasons = Array.isArray(row.reasons)
      ? row.reasons
      : Array.isArray(row.warnings)
        ? row.warnings
        : [];
    const reasons = uniqStrings(
      [
        ...buildTravelProductUseReasons({ language, roleId, category, name }),
        ...rawReasons.filter((reason) => !isWeakTravelProductReason(reason)),
      ],
      3,
    );

    out.push({
      rank: out.length + 1,
      product_id: normalizeText(sku.product_id || sku.productId, 120) || null,
      merchant_id: normalizeText(sku.merchant_id || sku.merchantId || row.merchant_id || row.merchantId, 80) || null,
      product_group_id: normalizeText(sku.product_group_id || sku.productGroupId || row.product_group_id || row.productGroupId, 160) || null,
      name,
      brand: normalizeText(sku.brand, 80) || null,
      category,
      reasons: reasons.length
        ? reasons
        : [t(language, '用于补齐本次旅行护肤步骤，按实际缺口使用。', 'Use this to fill a real travel-routine gap rather than adding an extra step.')],
      product_source: 'catalog',
      authority_status: 'grounded',
      match_status: 'catalog_verified',
      display_mode: 'product_card',
      role_id: roleId,
      pdp_open: isPlainObject(row.pdp_open)
        ? row.pdp_open
        : {
            merchant_id: normalizeText(sku.merchant_id || row.merchant_id, 80) || 'external_seed',
            product_id: normalizeText(sku.product_id || sku.productId || row.product_id || row.productId, 120) || null,
            canonical_url: normalizeText(sku.canonical_url || sku.url || row.canonical_url || row.url, 500) || null,
          },
      is_grounded: true,
      price: toNumber(sku.price || row.price),
      currency: normalizeText(sku.currency || row.currency, 12) || null,
      image_url: normalizeText(sku.image_url || row.image_url, 500) || null,
      canonical_url: normalizeText(sku.canonical_url || sku.url || row.canonical_url || row.url, 500) || null,
    });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeCategoryGuidancePreviewProductsFromRecoBundle(recoBundle, language) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(recoBundle) ? recoBundle : []) {
    if (!isPlainObject(row)) continue;
    const category = normalizeText(row.trigger, 80) || t(language, '旅行护肤', 'Travel skincare');
    const reapplyRule = normalizeText(row.reapply_rule, 180);
    const productTypes = Array.isArray(row.product_types) ? row.product_types : [];
    for (const productType of productTypes) {
      const name = normalizeText(productType, 140);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const reasons = uniqReasonStrings(
        [
          t(language, `类目：${category}`, `Category: ${category}`),
          reapplyRule || null,
          normalizeText(row.ingredient_logic, 260) || null,
        ].filter(Boolean),
        3,
        260,
      );
      out.push({
        rank: out.length + 1,
        product_id: null,
        name,
        brand: null,
        category,
        reasons,
        product_source: 'category_guidance',
        authority_status: 'category_only',
        match_status: 'category_guidance',
        display_mode: 'category_only',
        pdp_open: null,
        is_grounded: false,
        price: null,
        currency: null,
      });
      if (out.length >= 6) return out;
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

  const skinType = normalizeText(profile && profile.skinType, 40).toLowerCase();
  const barrier = normalizeText(profile && profile.barrierStatus, 40).toLowerCase();
  const sensitivity = normalizeText(profile && profile.sensitivity, 40).toLowerCase();
  const goals = Array.isArray(profile && profile.goals) ? profile.goals.map((g) => normalizeText(g, 60).toLowerCase()).filter(Boolean) : [];
  const isPregnantOrLactating = isPregnancyOrLactationActive(profile);

  if (isPregnantOrLactating) {
    push(
      t(language, '孕哺期成分安全', 'Pregnancy/lactation safety'),
      t(language, '孕哺期须避免维A酸、高浓度水杨酸、氢醌等成分。', 'Must avoid retinoids, high-dose salicylic acid (>2%), hydroquinone during pregnancy/lactation.'),
      t(language, '旅行产品检查成分表，优先使用烟酰胺、透明质酸、神经酰胺等安全成分。', 'Check ingredient lists of travel products; prioritize niacinamide, hyaluronic acid, ceramides.'),
    );
  }

  if (barrier.includes('impaired') || barrier.includes('damaged')) {
    push(
      t(language, '屏障优先', 'Barrier first'),
      t(language, '屏障偏弱时环境变化更容易导致泛红刺痛。', 'Compromised barrier makes skin more vulnerable to environmental changes.'),
      t(language, '旅行前 3-5 天开始减少酸/维A频次，专注修护稳定。', 'Start reducing acids/retinoids 3-5 days before departure and focus on repair.'),
    );
  }

  if (sensitivity === 'high' || sensitivity.includes('sensitive')) {
    push(
      t(language, '刺激阈值管理', 'Irritation threshold control'),
      t(language, '旅行中环境切换会进一步降低敏感阈值。', 'Environment shifts during travel further lower the irritation threshold.'),
      t(language, '同晚只保留一种最温和的活性；新产品回程后再试。', 'Keep one mildest active per night; try new products only after returning.'),
    );
  }

  if (goals.includes('dark_spots') || goals.includes('brightening')) {
    push(
      t(language, '旅行美白策略', 'Travel brightening strategy'),
      t(language, '旅行期 UV 暴露增加，高浓度美白品可能引发反弹色沉。', 'Increased UV exposure during travel can cause rebound hyperpigmentation with high-concentration brightening products.'),
      t(language, '降级到低浓度（维C 10%或传明酸），严格防晒；回程后恢复强度。', 'Downgrade to low concentration (vitamin C 10% or tranexamic acid), strict SPF; resume intensity post-trip.'),
    );
  }

  if (goals.includes('acne')) {
    push(
      t(language, '旅行控痘策略', 'Travel acne management'),
      t(language, '旅行中饮食变化和防晒叠加易加重闷痘。', 'Diet changes and heavy SPF layering during travel can worsen congestion.'),
      t(language, '晚间彻底双重清洁移除防晒；备水杨酸点涂和痘痘贴应急。', 'Thorough double cleanse at night to remove SPF; pack salicylic acid spot treatment and pimple patches.'),
    );
  }

  if (skinType.includes('oily')) {
    push(
      t(language, '旅行控油与防闷痘', 'Travel oil-control and congestion management'),
      t(language, '湿热或长时间防晒叠加时，油皮更容易出现闷痘和出油失衡。', 'Heat, humidity, and repeated SPF layers can make oily skin more congestion-prone during travel.'),
      t(language, '优先轻薄防晒 + 非封闭型保湿；如果用了防水防晒或彩妆，晚上务必双重清洁。', 'Prefer lightweight SPF + non-occlusive hydration; if you wore water-resistant SPF or makeup, double cleanse at night.'),
    );
  }

  const uvMax = toNumber(destinationSummary && destinationSummary.uv_index_max);
  if ((uvMax != null && uvMax >= 7) || summaryTags.includes('higher_uv')) {
    if (!out.some((item) => /UV|防晒|SPF|sun/i.test(normalizeText(item.focus, 40)))) {
      push(
        t(language, '高 UV 防护', 'High UV defense'),
        t(language, '目的地 UV 偏高，色沉和光老化风险增加。', 'Destination UV is elevated, increasing hyperpigmentation and photoaging risk.'),
        t(language, '防晒补涂与物理遮挡（帽子、墨镜）并行；避免正午 10-14 时直接暴晒。', 'Combine SPF reapplication with physical cover (hat, sunglasses); avoid direct sun 10am-2pm.'),
      );
    }
  }

  if (!out.length) {
    push(
      t(language, '稳态优先', 'Stability first'),
      t(language, '旅行期环境和作息变化大，皮肤适应力下降。', 'Environment and schedule changes during travel reduce skin adaptability.'),
      t(language, '简化步骤至核心 3-4 步（清洁+保湿+防晒+修护），避免一次新增多件产品。', 'Simplify to core 3-4 steps (cleanse+moisturize+SPF+repair); avoid introducing multiple new products at once.'),
    );
  }

  return out.slice(0, 4);
}

function buildJetlagSleep({ language, profile, destinationWeather, originWeather, homeWeather, destination, originLabel, nowMs }) {
  const baselineWeather = isPlainObject(originWeather) ? originWeather : isPlainObject(homeWeather) ? homeWeather : null;
  const tzHome = resolveTimezoneFromHints(
    [
      baselineWeather && baselineWeather.location && baselineWeather.location.timezone,
      profile && profile.home_timezone,
      baselineWeather && baselineWeather.location && baselineWeather.location.name,
      originLabel,
      profile && profile.departure_region,
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
    tz_origin: tzHome,
    tz_home: tzHome,
    tz_destination: tzDestination,
    hours_diff: hoursDiff,
    risk_level: riskLevel,
    sleep_tips: sleepTips.slice(0, 4),
    mask_tips: maskTips.slice(0, 4),
  };
}

function buildConfidence({ language, profile, recentLogs, destinationWeather, hasOriginBaseline, destination, originLabel }) {
  const missingInputs = [];
  if (!normalizeText(destination, 120)) missingInputs.push('destination');
  if (!isPlainObject(destinationWeather) || !isPlainObject(destinationWeather.summary)) missingInputs.push('destination_weather');
  if (!normalizeText(originLabel, 140)) missingInputs.push('departure_region');
  else if (!hasOriginBaseline) missingInputs.push('origin_baseline_weather');
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
  if (missingInputs.includes('departure_region')) {
    improveBy.push(t(language, '补充本次行程的出发地，可按出发地与目的地比较气候差异。', 'Add the departure location for this trip so I can compare departure vs destination climate.'));
  }
  if (missingInputs.includes('origin_baseline_weather')) {
    improveBy.push(t(language, '补充更明确的出发地可得到更准确的出发地基线。', 'A more precise departure location will produce a clearer origin baseline.'));
  }

  return {
    level,
    missing_inputs: uniqStrings(missingInputs, 12),
    improve_by: uniqStrings(improveBy, 6),
  };
}

const TRIGGER_TO_CATEGORY_ID = Object.freeze({
  'uv 升高': 'sun_protection',
  'elevated uv': 'sun_protection',
  '日常防晒': 'sun_protection',
  'daily sun protection': 'sun_protection',
  '湿热上升': 'moisturization',
  'warmer / more humid': 'moisturization',
  '温差/干燥': 'moisturization',
  'temperature swing / dryness': 'moisturization',
  '面膜（按场景）': 'masks',
  'masks (scenario-based)': 'masks',
  '晒后修复': 'post_sun',
  'post-sun repair': 'post_sun',
  '卸妆 + 双重清洁': 'cleansing',
  'makeup removal + double cleanse': 'cleansing',
  '抗氧化防护': 'antioxidant',
  'antioxidant protection': 'antioxidant',
  '美白/祛斑护理': 'brightening',
  'brightening / dark-spot care': 'brightening',
  '身体护理': 'body_care',
  'body care': 'body_care',
  '眼部护理': 'eye_care',
  'eye care': 'eye_care',
  '应急备用': 'emergency',
  'emergency kit': 'emergency',
});

const CATEGORY_KEYWORDS_BY_ID = Object.freeze({
  sun_protection: ['sunscreen', 'spf', 'uv', '防晒', 'sun protect'],
  moisturization: ['moistur', 'barrier', 'cream', 'hydrat', '保湿', '修护', '面霜', 'ceramide'],
  cleansing: ['cleans', 'oil', 'balm', '洁面', '卸妆'],
  antioxidant: ['antioxid', 'vitamin c', '抗氧化', 'vit c'],
  brightening: ['bright', 'whiten', 'dark spot', '美白', '祛斑', 'tranexamic'],
  masks: ['mask', '面膜'],
  post_sun: ['after-sun', 'post-sun', 'aloe', '晒后', '芦荟'],
  body_care: ['body', '身体'],
  eye_care: ['eye', '眼'],
  emergency: ['patch', 'lip balm', '痘痘贴', '润唇'],
});

const CANONICAL_CATEGORY_IDS = Object.freeze(Object.keys(CATEGORY_KEYWORDS_BY_ID));

function triggerToCategoryId(trigger) {
  const key = normalizeText(trigger, 120).toLowerCase();
  return TRIGGER_TO_CATEGORY_ID[key] || key.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function findCategoryIdByKeywords(values) {
  const haystack = (Array.isArray(values) ? values : [])
    .map((value) => normalizeText(value, 240))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!haystack) return null;
  for (const categoryId of CANONICAL_CATEGORY_IDS) {
    const keywords = CATEGORY_KEYWORDS_BY_ID[categoryId] || [];
    if (keywords.some((keyword) => haystack.includes(keyword))) return categoryId;
  }
  return null;
}

function resolvePreviewProductCategoryId(item) {
  if (!isPlainObject(item)) return null;
  const exactCategoryId = triggerToCategoryId(normalizeText(item.category, 80));
  if (CANONICAL_CATEGORY_IDS.includes(exactCategoryId)) return exactCategoryId;
  return findCategoryIdByKeywords([
    item.category,
    item.name,
    item.brand,
    Array.isArray(item.reasons) ? item.reasons.join(' ') : '',
  ]);
}

function isGroundedPreviewProduct(item) {
  if (!isPlainObject(item)) return false;
  const source = normalizeText(item.product_source || item.productSource || item.source, 80).toLowerCase();
  const authority = normalizeText(item.authority_status || item.authorityStatus || item.match_status || item.matchStatus, 80).toLowerCase();
  const displayMode = normalizeText(item.display_mode || item.displayMode, 80).toLowerCase();
  if (/^(rule_fallback|llm_generated|llm_only|category_guidance)$/.test(source)) return false;
  if (displayMode === 'category_only') return false;
  return Boolean(
    item.is_grounded === true ||
      normalizeText(item.product_id || item.productId, 120) ||
      source === 'catalog' ||
      source === 'internal' ||
      source === 'external_seed' ||
      /^(grounded|catalog_verified|authority|resolved|internal_hit|external_seed_hit)$/.test(authority),
  );
}

function resolvePreviewProductRoleId(item) {
  if (!isPlainObject(item)) return '';
  const direct = normalizeText(item.role_id || item.roleId || item.selected_role_id || item.selectedRoleId, 80).toLowerCase();
  if (direct) return direct;

  const categoryId = resolvePreviewProductCategoryId(item);
  if (categoryId === 'sun_protection') return 'sun_protection';
  if (categoryId === 'masks' || categoryId === 'post_sun') return 'recovery_mask';
  if (categoryId === 'body_care' || categoryId === 'emergency') return 'body_lip_hand';
  if (categoryId === 'eye_care') return 'eye_care';
  if (categoryId === 'cleansing') return 'cleanser';
  if (categoryId === 'moisturization') {
    const signal = [
      item.name,
      item.category,
      Array.isArray(item.reasons) ? item.reasons.join(' ') : '',
    ].map((value) => normalizeText(value, 220).toLowerCase()).join(' ');
    if (/\b(serum|essence|ampoule|hyaluronic|hydration|hydrating)\b|精华|精華|安瓶|补水/.test(signal)) {
      return 'hydration_serum';
    }
    return 'lightweight_moisturizer';
  }
  if (categoryId === 'antioxidant' || categoryId === 'brightening') return 'hydration_serum';
  return categoryId || '';
}

function resolveRecoBundleRoleIds(row) {
  if (!isPlainObject(row)) return [];
  const categoryId = triggerToCategoryId(normalizeText(row.trigger, 120));
  const roles = [];
  const add = (roleId) => {
    if (!roleId || roles.includes(roleId)) return;
    roles.push(roleId);
  };
  if (categoryId === 'sun_protection') add('sun_protection');
  if (categoryId === 'moisturization') {
    add('lightweight_moisturizer');
    add('hydration_serum');
  }
  if (categoryId === 'masks' || categoryId === 'post_sun') add('recovery_mask');
  if (categoryId === 'body_care' || categoryId === 'emergency') add('body_lip_hand');
  if (categoryId === 'eye_care') add('eye_care');
  if (categoryId === 'cleansing') add('cleanser');
  if (categoryId === 'antioxidant' || categoryId === 'brightening') add('hydration_serum');
  return roles;
}

function uniqTravelRoles(values, max = 8) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const role = normalizeText(value, 80).toLowerCase();
    if (!role || seen.has(role)) continue;
    seen.add(role);
    out.push(role);
    if (out.length >= max) break;
  }
  return out;
}

function productIdsForTravelRoles(products, roleIds, max = 6) {
  const wanted = new Set(uniqTravelRoles(roleIds, 12));
  const out = [];
  const seen = new Set();
  for (const product of Array.isArray(products) ? products : []) {
    if (!isPlainObject(product) || !isGroundedPreviewProduct(product)) continue;
    const roleId = resolvePreviewProductRoleId(product);
    if (!wanted.has(roleId)) continue;
    const productId = normalizeText(product.product_id || product.productId, 120);
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    out.push(productId);
    if (out.length >= max) break;
  }
  return out;
}

function buildPhaseActionsFromRecoBundle(recoBundle, roleIds, max = 2) {
  const wanted = new Set(uniqTravelRoles(roleIds, 12));
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(recoBundle) ? recoBundle : []) {
    const rowRoles = resolveRecoBundleRoleIds(row);
    if (!rowRoles.some((role) => wanted.has(role))) continue;
    const action = normalizeText(row.action, 260);
    if (!action) continue;
    const key = action.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
    if (out.length >= max) break;
  }
  return out;
}

function buildTravelPhasePlan({
  language,
  recoBundle,
  previewProducts,
  deltaVsHome,
  jetlagSleep,
} = {}) {
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const products = Array.isArray(previewProducts) ? previewProducts : [];
  const groundedProducts = products.filter(isGroundedPreviewProduct);
  const productRoles = uniqTravelRoles(groundedProducts.map(resolvePreviewProductRoleId).filter(Boolean), 12);
  const summaryTags = Array.isArray(deltaVsHome && deltaVsHome.summary_tags) ? deltaVsHome.summary_tags : [];
  const jetlagHours = toNumber(jetlagSleep && jetlagSleep.hours_diff);
  const hasJetlag = jetlagHours != null && jetlagHours >= 5;
  const hasUv = summaryTags.some((tag) => /uv/i.test(String(tag || '')));
  const hasDryness = summaryTags.some((tag) => /dry|colder|wind/i.test(String(tag || '')));
  const hasHumidity = summaryTags.some((tag) => /humid|wetter|warmer/i.test(String(tag || '')));

  const phaseSpecs = [
    {
      id: 'pre_trip_prepare',
      title: t(lang, '出发前准备', 'Before you leave'),
      timing: t(lang, '出发前 2-3 天', 'T-3 to T-1 before departure'),
      roleIds: ['sun_protection', 'body_lip_hand', 'eye_care', 'cleanser'],
      why: t(
        lang,
        '先把已耐受的核心用品准备好，避免临行前新增刺激性产品。',
        'Pack tolerated core products first so the routine stays stable before a climate and schedule shift.',
      ),
      defaults: [
        t(lang, '准备已耐受的洁面、保湿、防晒和应急小件；临行前不新增强酸/强维A。', 'Pack tolerated cleanser, moisturizer, sunscreen, and small emergency items; avoid starting strong acids or retinoids right before departure.'),
        hasUv
          ? t(lang, '如果目的地 UV 更高，把面部 SPF、身体暴露部位、唇部和手部防护拆开准备。', 'If destination UV is higher, prepare separate face SPF, exposed-body coverage, lip SPF, and hand care.')
          : t(lang, '防晒按日常通勤准备；如果有长时间户外，再准备补涂格式。', 'Prepare daily sunscreen; add a reapply format if outdoor time is long.'),
      ],
    },
    {
      id: 'flight_cabin',
      title: t(lang, '飞行途中', 'On the flight'),
      timing: t(lang, '登机前到抵达前', 'Boarding through arrival'),
      roleIds: ['lightweight_moisturizer', 'hydration_serum', 'recovery_mask', 'body_lip_hand', 'eye_care'],
      why: t(
        lang,
        hasJetlag
          ? '机舱干燥叠加时差，会让屏障紧绷和眼周浮肿更明显。'
          : '机舱干燥会放大紧绷感，护理应保持简单和低刺激。',
        hasJetlag
          ? 'Cabin dryness plus jet lag can make tightness and eye-area puffiness more noticeable.'
          : 'Cabin dryness can amplify tightness, so keep care simple and low-irritation.',
      ),
      defaults: [
        t(lang, '登机前用舒适保湿层；机上不要叠加强活性，重点是补水和屏障舒适度。', 'Before boarding, use a comfortable moisturizing layer; avoid stacking strong actives in-cabin and focus on hydration comfort.'),
        t(lang, '补水/舒缓面膜只作为已耐受的可选恢复项，不作为必需步骤。', 'Use a hydrating or soothing mask only as an already-tolerated optional recovery step, not as a required step.'),
      ],
    },
    {
      id: 'arrival_first_48h',
      title: t(lang, '落地后 48 小时', 'First 48 hours after landing'),
      timing: t(lang, '抵达当天到第 2 晚', 'Arrival day through night 2'),
      roleIds: ['lightweight_moisturizer', 'hydration_serum', 'recovery_mask', 'eye_care'],
      why: t(
        lang,
        '刚落地时皮肤同时适应气候、睡眠和清洁节奏，先稳住屏障比加新活性更重要。',
        'Right after landing, skin is adapting to climate, sleep, and cleansing rhythm, so barrier stability comes before new actives.',
      ),
      defaults: [
        t(lang, '前 48 小时以温和清洁、保湿、防晒为主；强刺激活性先降频。', 'For the first 48 hours, center on gentle cleansing, moisturizer, and sunscreen; keep stronger actives lower-frequency.'),
        hasDryness
          ? t(lang, '如果紧绷或起皮，晚上增加修护霜或已耐受的补水舒缓面膜。', 'If tightness or flaking shows up, add barrier cream or an already-tolerated hydrating-soothing mask at night.')
          : t(lang, '如果湿热出油明显，保湿换轻薄质地，晚上把防晒清洁干净。', 'If heat and humidity increase oiliness, use lighter hydration and cleanse sunscreen thoroughly at night.'),
      ],
    },
    {
      id: 'during_trip_daily',
      title: t(lang, '当地日常', 'Daily while there'),
      timing: t(lang, '行程每天 AM / PM', 'Every trip day, AM / PM'),
      roleIds: ['sun_protection', 'lightweight_moisturizer', 'hydration_serum', 'recovery_mask', 'body_lip_hand', 'cleanser'],
      why: t(
        lang,
        hasHumidity
          ? '当地湿热或降水会改变肤感和出油，日常步骤要轻薄但不能跳过防晒。'
          : '当地日常护理需要同时处理防晒暴露和屏障恢复。',
        hasHumidity
          ? 'Warmer or more humid conditions can change finish and oiliness, so keep layers lighter without skipping SPF.'
          : 'Daily care should balance UV exposure with barrier recovery.',
      ),
      defaults: [
        t(lang, 'AM：保湿层 + 防晒；户外时间长时按暴露时长补涂。', 'AM: moisturizer plus sunscreen; reapply based on outdoor exposure time.'),
        t(lang, 'PM：把防晒/彩妆清洁干净，再根据紧绷、闷痘或日晒感选择修护。', 'PM: cleanse sunscreen or makeup thoroughly, then choose recovery care based on tightness, congestion, or sun exposure.'),
      ],
    },
    {
      id: 'local_shopping',
      title: t(lang, '当地可买商品', 'Shop locally'),
      timing: t(lang, '落地后按缺口补充', 'After landing, fill only real gaps'),
      roleIds: productRoles.length
        ? productRoles
        : ['sun_protection', 'lightweight_moisturizer', 'hydration_serum', 'recovery_mask', 'body_lip_hand', 'eye_care'],
      why: groundedProducts.length
        ? t(lang, '以下只展示已接入商品库或 external seeds 的本地商品，不用通用 fallback 伪装具体单品。', 'Only catalog or external-seed grounded local products are shown here; generic fallback items are not presented as product picks.')
        : t(lang, '当前没有命中具体本地商品，只保留品类准备方向，后续通过 catalog backfill 补库。', 'No specific local product is grounded yet; keep this as category direction until catalog backfill adds authority rows.'),
      defaults: groundedProducts.length
        ? [
            t(lang, '优先看与本次气候和行程相关的角色：防晒、轻保湿、补水修护、身体/唇/手支持。', 'Review roles tied to this climate and trip: sunscreen, lightweight hydration, recovery support, and body/lip/hand support.'),
          ]
        : [
            t(lang, '只按品类购物，不把未验证品牌或商品当成推荐结果。', 'Shop by category only; do not treat unverified brands or products as recommendations.'),
          ],
    },
  ];

  return phaseSpecs.map((phase) => {
    const roleIds = uniqTravelRoles(phase.roleIds, 10);
    const productIds = phase.id === 'local_shopping'
      ? groundedProducts.map((product) => normalizeText(product.product_id || product.productId, 120)).filter(Boolean).slice(0, 6)
      : productIdsForTravelRoles(products, roleIds, 4);
    const phaseActions = uniqStrings([
      ...phase.defaults,
      ...buildPhaseActionsFromRecoBundle(recoBundle, roleIds, 2),
    ], 4);
    return {
      id: phase.id,
      title: phase.title,
      timing: phase.timing,
      why: phase.why,
      actions: phaseActions,
      product_role_ids: roleIds,
      product_ids: productIds,
      coverage_status: productIds.length ? 'grounded' : 'category_only',
    };
  });
}

function isAuthoritativeTravelSuggestion(suggestion) {
  if (!isPlainObject(suggestion)) return false;
  const source = normalizeText(suggestion.product_source || suggestion.source, 80).toLowerCase();
  const matchStatus = normalizeText(suggestion.match_status || suggestion.authority_status, 80).toLowerCase();
  if (source === 'catalog' || source === 'internal' || source === 'external_seed') return true;
  if (/^(catalog_verified|internal_hit|external_seed_hit|authority|grounded|resolved)$/.test(matchStatus)) return true;
  return Boolean(
    normalizeText(suggestion.product_id || suggestion.productId, 120) ||
      normalizeText(suggestion.pdp_open || suggestion.pdpOpen, 240),
  );
}

function pushCategorizedKitSuggestion(out, seenKeys, suggestion) {
  if (!Array.isArray(out) || !seenKeys || out.length >= 4 || !isPlainObject(suggestion)) return;
  const product = normalizeText(suggestion.product, 140) || null;
  const brand = normalizeText(suggestion.brand, 80) || null;
  const reason = normalizeText(suggestion.reason, 320) || null;
  const matchStatus = normalizeText(suggestion.match_status, 40) || null;
  const dedupeKey = product ? product.toLowerCase() : brand ? brand.toLowerCase() : '';
  if (!dedupeKey || seenKeys.has(dedupeKey)) return;
  seenKeys.add(dedupeKey);
  out.push({
    brand,
    product,
    reason,
    match_status: matchStatus,
  });
}

function buildClimateLink(categoryId, deltaVsHome, language) {
  const delta = isPlainObject(deltaVsHome) ? deltaVsHome : {};
  const fmt = (metric) => {
    if (!isPlainObject(metric)) return null;
    const h = toNumber(metric.home);
    const d = toNumber(metric.destination);
    const dd = toNumber(metric.delta);
    const unit = normalizeText(metric.unit, 10);
    if (d == null) return null;
    const signed = dd != null ? (dd > 0 ? `+${roundTo(dd, 1)}` : `${roundTo(dd, 1)}`) : null;
    if (h != null && signed != null) {
      return `${roundTo(h, 1)}${unit} → ${roundTo(d, 1)}${unit} (${signed}${unit})`;
    }
    return `${roundTo(d, 1)}${unit}`;
  };

  const metricMap = {
    sun_protection: { metric: delta.uv, labelCn: 'UV', labelEn: 'UV' },
    post_sun: { metric: delta.uv, labelCn: 'UV', labelEn: 'UV' },
    body_care: { metric: delta.uv, labelCn: 'UV', labelEn: 'UV' },
    antioxidant: { metric: delta.uv, labelCn: 'UV', labelEn: 'UV' },
    moisturization: null,
    masks: null,
    cleansing: null,
    brightening: { metric: delta.uv, labelCn: 'UV', labelEn: 'UV' },
    eye_care: null,
    emergency: null,
  };

  if (categoryId === 'moisturization') {
    const parts = [];
    const hFmt = fmt(delta.humidity);
    const tFmt = fmt(delta.temperature);
    if (hFmt) parts.push(`${t(language, '湿度', 'Humidity')} ${hFmt}`);
    if (tFmt) parts.push(`${t(language, '温度', 'Temp')} ${tFmt}`);
    return parts.length ? parts.join(' · ') : null;
  }

  const entry = metricMap[categoryId];
  if (!entry) return null;
  const formatted = fmt(entry.metric);
  if (!formatted) return null;
  return `${t(language, entry.labelCn, entry.labelEn)} ${formatted}`;
}

function buildCategorizedKit({ language, recoBundle, deltaVsHome, brandCandidates, categoryRecommendations, previewProducts }) {
  const bundle = Array.isArray(recoBundle) ? recoBundle : [];
  const brands = Array.isArray(brandCandidates) ? brandCandidates : [];
  const catRecs = Array.isArray(categoryRecommendations) ? categoryRecommendations : [];
  const previews = Array.isArray(previewProducts) ? previewProducts : [];
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const previewProductsByCategoryId = {};
  for (const preview of previews) {
    const categoryId = resolvePreviewProductCategoryId(preview);
    if (!categoryId) continue;
    if (!Array.isArray(previewProductsByCategoryId[categoryId])) previewProductsByCategoryId[categoryId] = [];
    previewProductsByCategoryId[categoryId].push(preview);
  }

  const kit = [];
  const seenIds = new Set();

  for (const row of bundle) {
    if (!isPlainObject(row)) continue;
    const trigger = normalizeText(row.trigger, 120);
    if (!trigger) continue;
    const id = triggerToCategoryId(trigger);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const productTypes = Array.isArray(row.product_types) ? row.product_types : [];
    const preparations = productTypes
      .map((pt) => normalizeText(pt, 140))
      .filter(Boolean)
      .map((name) => ({ name, detail: normalizeText(row.reapply_rule, 200) || null }));

    const climateLink = buildClimateLink(id, deltaVsHome, lang);

    const suggestions = [];
    const suggestionKeys = new Set();
    const categorySuggestions = [];
    const categorySuggestionKeys = new Set();

    const matchedCatRec = catRecs.find((cr) => {
      if (!isPlainObject(cr)) return false;
      const catId = triggerToCategoryId(normalizeText(cr.category, 40));
      return catId === id;
    });
    if (matchedCatRec && Array.isArray(matchedCatRec.products)) {
      for (const prod of matchedCatRec.products.slice(0, 3)) {
        pushCategorizedKitSuggestion(categorySuggestions, categorySuggestionKeys, {
          reason: normalizeText(prod.usage, 200) || normalizeText(prod.ingredient_logic, 200) || null,
          product: normalizeText(prod.name, 140) || null,
          match_status: 'llm_generated',
        });
        if (categorySuggestions.length >= 4) break;
      }
    }

    const matchedPreviewProducts = Array.isArray(previewProductsByCategoryId[id]) ? previewProductsByCategoryId[id] : [];
    for (const preview of matchedPreviewProducts) {
      const reasons = uniqReasonStrings(Array.isArray(preview && preview.reasons) ? preview.reasons : [], 3, 260);
      const suggestion = {
        brand: normalizeText(preview && preview.brand, 80) || null,
        product: normalizeText(preview && preview.name, 140) || null,
        reason: reasons.length ? reasons.join(' · ') : null,
        match_status: normalizeText(preview && preview.match_status, 40) || null,
        product_source: normalizeText(preview && preview.product_source, 80) || null,
        product_id: normalizeText(preview && (preview.product_id || preview.productId), 120) || null,
        pdp_open: normalizeText(preview && (preview.pdp_open || preview.pdpOpen), 240) || null,
      };
      if (isAuthoritativeTravelSuggestion(preview)) {
        pushCategorizedKitSuggestion(suggestions, suggestionKeys, suggestion);
      } else {
        pushCategorizedKitSuggestion(categorySuggestions, categorySuggestionKeys, suggestion);
      }
      if (suggestions.length >= 4 && categorySuggestions.length >= 4) break;
    }

    for (const b of brands) {
      if (!isPlainObject(b)) continue;
      const matchedCategoryId = findCategoryIdByKeywords([b.reason, b.brand]);
      if (matchedCategoryId !== id) continue;
      const suggestion = {
        brand: normalizeText(b.brand, 80) || null,
        product: null,
        reason: normalizeText(b.reason, 200) || null,
        match_status: normalizeText(b.match_status, 40) || null,
      };
      if (isAuthoritativeTravelSuggestion(b)) {
        pushCategorizedKitSuggestion(suggestions, suggestionKeys, suggestion);
      } else {
        pushCategorizedKitSuggestion(categorySuggestions, categorySuggestionKeys, suggestion);
      }
      if (suggestions.length >= 4 && categorySuggestions.length >= 4) break;
    }

    kit.push({
      id,
      title: trigger,
      climate_link: climateLink,
      why: normalizeText(row.action, 280) || null,
      ingredient_logic: normalizeText(row.ingredient_logic, 260) || null,
      preparations,
      reapply_rule: normalizeText(row.reapply_rule, 200) || null,
      brand_suggestions: suggestions.length ? suggestions : null,
      category_suggestions: categorySuggestions.length ? categorySuggestions : null,
    });
  }

  return kit;
}

function buildTravelReadiness({
  language = 'EN',
  profile = {},
  recentLogs = [],
  destination,
  startDate,
  endDate,
  destinationWeather,
  originWeather,
  homeWeather,
  originContext,
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
  const weatherSource = normalizeText(destinationWeather && destinationWeather.source, 40).toLowerCase();
  const usesLiveWeather = weatherSource === 'weather_api';
  const weatherReason = normalizeText(destinationWeather && destinationWeather.reason, 80) || null;
  const baselineWeather = isPlainObject(originWeather) ? originWeather : isPlainObject(homeWeather) ? homeWeather : null;
  const originSummary = isPlainObject(baselineWeather && baselineWeather.summary) ? baselineWeather.summary : null;
  const hasOriginBaseline = Boolean(originSummary);
  const normalizedOriginContext = isPlainObject(originContext) ? originContext : {};
  const originLabel =
    normalizeText(normalizedOriginContext.label, 140) ||
    normalizeText(baselineWeather && baselineWeather.location && baselineWeather.location.name, 140) ||
    normalizeText(profile && (profile.departure_region || profile.region), 140) ||
    null;
  const forecastWindow = usesLiveWeather
    ? normalizeForecastWindowRows(destinationWeather && destinationWeather.forecast_window)
    : [];
  const alerts = normalizeTravelAlerts(travelAlerts, lang);

  const temperature = buildMetricDelta(originSummary && originSummary.temperature_max_c, destinationSummary && destinationSummary.temperature_max_c, 'C');
  const humidity = buildMetricDelta(originSummary && originSummary.humidity_mean, destinationSummary && destinationSummary.humidity_mean, '%');
  const uv = buildMetricDelta(originSummary && originSummary.uv_index_max, destinationSummary && destinationSummary.uv_index_max, '');
  const wind = buildMetricDelta(originSummary && originSummary.wind_kph_max, destinationSummary && destinationSummary.wind_kph_max, 'kph');
  const precip = buildMetricDelta(originSummary && originSummary.precipitation_mm, destinationSummary && destinationSummary.precipitation_mm, 'mm');

  const summaryTags = buildSummaryTags({
    temperature,
    humidity,
    uv,
    wind,
    precip,
    hasHomeBaseline: hasOriginBaseline,
    destinationSummary,
    absoluteTagsEnabled: weatherSource !== 'weather_api',
  });
  const adaptiveActions = buildAdaptiveActions({ language: lang, summaryTags });
  const personalFocus = buildPersonalFocus({ language: lang, profile, destinationSummary, summaryTags });
  const jetlagSleep = buildJetlagSleep({
    language: lang,
    profile,
    destinationWeather,
    originWeather: baselineWeather,
    homeWeather: baselineWeather,
    destination: destinationText,
    originLabel,
    nowMs,
  });
  const confidence = buildConfidence({
    language: lang,
    profile,
    recentLogs,
    destinationWeather,
    hasOriginBaseline,
    destination: destinationText,
    originLabel,
  });
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
    startDate,
    endDate,
    jetlagSleep,
  });
  const storeExamples = buildStoreExamples({ language: lang, destination: destinationText });
  const previewProductsFromCatalog = normalizePreviewProducts(recommendationCandidates, lang);
  const previewProducts = previewProductsFromCatalog.length
    ? previewProductsFromCatalog
    : normalizeCategoryGuidancePreviewProductsFromRecoBundle(recoBundle, lang);
  const shoppingPreviewMode = previewProductsFromCatalog.length ? 'grounded_products' : 'category_guidance';
  const categorizedKit = buildCategorizedKit({
    language: lang,
    recoBundle,
    deltaVsHome: { temperature, humidity, uv, wind, precip },
    brandCandidates: [],
    categoryRecommendations: [],
    previewProducts,
  });
  const phasePlan = buildTravelPhasePlan({
    language: lang,
    recoBundle,
    previewProducts,
    deltaVsHome: { temperature, humidity, uv, wind, precip, summary_tags: summaryTags },
    jetlagSleep,
  });

  return {
    destination_context: {
      destination: destinationText || null,
      start_date: normalizeText(startDate, 24) || null,
      end_date: normalizeText(endDate, 24) || null,
      env_source:
        normalizeText(epiPayload && epiPayload.env_source, 40) ||
        normalizeText(destinationWeather && destinationWeather.source, 40) ||
        null,
      weather_reason: weatherReason,
      epi: toNumber(epiPayload && epiPayload.epi),
    },
    origin_context: {
      label: originLabel,
      source: normalizeText(normalizedOriginContext.source, 40) || null,
      baseline_status: hasOriginBaseline ? 'ok' : 'baseline_unavailable',
    },
    delta_vs_origin: {
      temperature: usesLiveWeather ? temperature : null,
      humidity: usesLiveWeather ? humidity : null,
      uv: usesLiveWeather ? uv : null,
      wind: usesLiveWeather ? wind : null,
      precip: usesLiveWeather ? precip : null,
      summary_tags: summaryTags,
      baseline_status: hasOriginBaseline ? 'ok' : 'baseline_unavailable',
    },
    delta_vs_home: {
      temperature: usesLiveWeather ? temperature : null,
      humidity: usesLiveWeather ? humidity : null,
      uv: usesLiveWeather ? uv : null,
      wind: usesLiveWeather ? wind : null,
      precip: usesLiveWeather ? precip : null,
      summary_tags: summaryTags,
      baseline_status: hasOriginBaseline ? 'ok' : 'baseline_unavailable',
    },
    forecast_window: forecastWindow,
    alerts,
    adaptive_actions: adaptiveActions,
    personal_focus: personalFocus,
    jetlag_sleep: jetlagSleep,
    reco_bundle: recoBundle,
    phase_plan: phasePlan,
    categorized_kit: categorizedKit,
    store_examples: storeExamples,
    shopping_preview: {
      mode: shoppingPreviewMode,
      coverage_status: previewProductsFromCatalog.length ? 'grounded' : 'category_only',
      grounded_count: previewProductsFromCatalog.length,
      products: previewProducts,
      buying_channels: ['beauty_retail', 'pharmacy', 'department_store', 'duty_free', 'ecommerce'],
      city_hint: destinationText || null,
      note: t(
        lang,
        previewProductsFromCatalog.length
          ? '当前商品来自已接入商品库；附近门店地图检索将在后续版本支持。'
          : '当前仅提供需准备的商品品类；未命中商品库时不会伪装成具体商品推荐。',
        previewProductsFromCatalog.length
          ? 'Products come from connected catalog authority; nearby store map lookup will be added later.'
          : 'This is category guidance only; when catalog authority is missing, it is not presented as a specific product recommendation.',
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
    normalizeCategoryGuidancePreviewProductsFromRecoBundle,
    buildCategorizedKit,
    buildTravelPhasePlan,
    getTimezoneOffsetHours,
    resolveTimezoneFromHints,
  },
};
