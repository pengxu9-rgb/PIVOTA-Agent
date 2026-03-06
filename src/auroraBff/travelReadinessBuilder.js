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
  const isPregnantOrLactating = Boolean(
    normalizeText(profile && profile.pregnancy_status, 20) ||
    normalizeText(profile && profile.lactation_status, 20),
  );

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
      product_source: 'catalog',
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
        product_source: 'rule_fallback',
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
  const isPregnantOrLactating = Boolean(
    normalizeText(profile && profile.pregnancy_status, 20) ||
    normalizeText(profile && profile.lactation_status, 20),
  );

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
    startDate,
    endDate,
    jetlagSleep,
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
