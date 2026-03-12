function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value, maxLen = 220) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.slice(0, maxLen);
}

function toNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundTo(value, digits = 1) {
  const n = toNumber(value);
  if (n == null) return null;
  const base = 10 ** digits;
  return Math.round(n * base) / base;
}

function t(language, cn, en) {
  return String(language || '').toUpperCase() === 'CN' ? cn : en;
}

function uniqueStrings(values, maxItems = 8) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = normalizeText(raw, 260);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function actionSemanticKey(raw) {
  const text = normalizeText(raw, 320).toLowerCase();
  if (!text) return '';
  if ((text.includes('barrier') || text.includes('修护')) && (text.includes('occlusive') || text.includes('封层'))) {
    return 'barrier_occlusive_night';
  }
  if ((text.includes('spf') || text.includes('防晒')) && (text.includes('reapply') || text.includes('补涂'))) {
    return 'spf_reapply';
  }
  if (
    (text.includes('am') && text.includes('pm') && text.includes('sunscreen')) ||
    (text.includes('早') && text.includes('晚') && text.includes('防晒'))
  ) {
    return 'am_pm_stability';
  }
  if (
    text.includes('avoid') && (text.includes('stack') || text.includes('active')) ||
    (text.includes('避免') && text.includes('活性'))
  ) {
    return 'avoid_active_stacking';
  }
  return text
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pushUniqueAction(lines, seenSemantics, line) {
  const text = normalizeText(line, 320);
  if (!text) return;
  const semantic = actionSemanticKey(text);
  if (!semantic || seenSemantics.has(semantic)) return;
  seenSemantics.add(semantic);
  lines.push(text);
}

function travelKitSemanticKey(raw) {
  const text = normalizeText(raw, 320).toLowerCase();
  if (!text) return '';
  if (
    text.includes('sun_protection') ||
    text.includes('elevated uv') ||
    text.includes('daily sun protection') ||
    text.includes('uv 升高') ||
    text.includes('日常防晒') ||
    text.includes('body sunscreen') ||
    text.includes('身体防晒')
  ) return 'sun_protection';
  if (text.includes('post_sun') || text.includes('post-sun') || text.includes('after-sun') || text.includes('晒后修复')) return 'post_sun';
  if (text.includes('moisturization') || text.includes('warmer / more humid') || text.includes('temperature swing / dryness') || text.includes('湿热上升') || text.includes('温差/干燥')) return 'moisturization';
  if (text.includes('masks') || text.includes('mask') || text.includes('面膜')) return 'masks';
  if (text.includes('cleansing') || text.includes('double cleanse') || text.includes('makeup removal') || text.includes('双重清洁') || text.includes('卸妆')) return 'cleansing';
  if (text.includes('antioxidant') || text.includes('抗氧化')) return 'antioxidant';
  if (text.includes('brightening') || text.includes('dark-spot') || text.includes('dark spot') || text.includes('美白') || text.includes('祛斑')) return 'brightening';
  if (text.includes('eye_care') || text.includes('eye care') || text.includes('眼部护理')) return 'eye_care';
  if (text.includes('body_care') || text.includes('body care') || text.includes('身体护理')) return 'body_care';
  if (text.includes('emergency') || text.includes('应急')) return 'emergency';
  return text
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSignedNumber(value, digits = 1) {
  const n = roundTo(value, digits);
  if (n == null) return null;
  const abs = Math.abs(n);
  const str = Number.isInteger(abs) ? String(abs) : abs.toFixed(digits).replace(/\.0+$/, '');
  if (n > 0) return `+${str}`;
  if (n < 0) return `-${str}`;
  return '0';
}

function formatNumber(value, digits = 1) {
  const n = roundTo(value, digits);
  if (n == null) return null;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(digits).replace(/\.0+$/, '');
}

function pickTravelDelta(travelReadiness) {
  if (isPlainObject(travelReadiness && travelReadiness.delta_vs_origin)) return travelReadiness.delta_vs_origin;
  if (isPlainObject(travelReadiness && travelReadiness.delta_vs_home)) return travelReadiness.delta_vs_home;
  return {};
}

function pickOriginLabel(travelReadiness, fallback) {
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {};
  const originContext = isPlainObject(readiness.origin_context) ? readiness.origin_context : {};
  return normalizeText(originContext.label, 140) || normalizeText(fallback, 140);
}

function normalizeUnit(unitRaw) {
  const unit = String(unitRaw || '').trim();
  if (!unit) return '';
  if (unit === '%') return '%';
  if (unit.toLowerCase() === 'c') return 'C';
  if (unit.toLowerCase() === 'kph') return 'kph';
  if (unit.toLowerCase() === 'mm') return 'mm';
  return unit;
}

function formatMetricPair({ labelCn, labelEn, metric, language }) {
  if (!isPlainObject(metric)) return '';
  const home = toNumber(metric.home);
  const destination = toNumber(metric.destination);
  const delta = toNumber(metric.delta);
  const unit = normalizeUnit(metric.unit);
  const label = t(language, labelCn, labelEn);
  const precision = unit === '%' || unit === 'C' ? 0 : 1;

  if (home != null && destination != null) {
    const homeText = formatNumber(home, precision);
    const destinationText = formatNumber(destination, precision);
    const deltaText = formatSignedNumber(delta, precision);
    const unitSuffix = unit || '';
    if (deltaText != null) {
      const deltaLabel = t(language, '变化', 'Delta');
      return `${label}: ${homeText}${unitSuffix} -> ${destinationText}${unitSuffix} (${deltaLabel} ${deltaText}${unitSuffix})`;
    }
    return `${label}: ${homeText}${unitSuffix} -> ${destinationText}${unitSuffix}`;
  }

  if (destination != null) {
    const destinationText = formatNumber(destination, precision);
    const unitSuffix = unit || '';
    return `${label}: ${destinationText}${unitSuffix}`;
  }

  return '';
}

function formatForecastLine({ language, row }) {
  const item = isPlainObject(row) ? row : {};
  const date = normalizeText(item.date, 24);
  if (!date) return '';
  const low = toNumber(item.temp_low_c);
  const high = toNumber(item.temp_high_c);
  const condition = normalizeText(item.condition_text, 120);
  const rain = toNumber(item.precip_mm);
  const parts = [date];
  if (low != null || high != null) {
    const lowText = low == null ? '-' : formatNumber(low, 0);
    const highText = high == null ? '-' : formatNumber(high, 0);
    parts.push(
      t(language, `${lowText}C ~ ${highText}C`, `${lowText}C to ${highText}C`),
    );
  }
  if (condition) parts.push(condition);
  if (rain != null && rain > 0) parts.push(t(language, `降水 ${formatNumber(rain, 1)}mm`, `precip ${formatNumber(rain, 1)}mm`));
  return parts.join(' · ');
}

function parseIsoDateToken(value) {
  const token = normalizeText(value, 24);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(token)) return null;
  const date = new Date(`${token}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return date;
}

function getTripDaysInclusive(startDate, endDate) {
  const start = parseIsoDateToken(startDate);
  const end = parseIsoDateToken(endDate);
  if (!start || !end) return null;
  if (end < start) return null;
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
}

function buildForecastLines({ language, travelReadiness }) {
  const rows = Array.isArray(travelReadiness && travelReadiness.forecast_window)
    ? travelReadiness.forecast_window
    : [];
  const out = [];
  for (const row of rows.slice(0, 7)) {
    const line = formatForecastLine({ language, row });
    if (!line) continue;
    out.push(line);
  }
  return out;
}

function buildAlertsSection({ language, travelReadiness }) {
  const alerts = Array.isArray(travelReadiness && travelReadiness.alerts)
    ? travelReadiness.alerts
    : [];
  const lines = [];
  for (const row of alerts.slice(0, 2)) {
    const severity = normalizeText(row && row.severity, 24);
    const title = normalizeText(row && row.title, 160);
    const summary = normalizeText(row && row.summary, 180);
    const actionHint = normalizeText(row && row.action_hint, 200);
    const timeWindow = [
      normalizeText(row && row.start_at, 40),
      normalizeText(row && row.end_at, 40),
    ]
      .filter(Boolean)
      .join(' -> ');
    const head = [severity, title].filter(Boolean).join(' | ');
    const detail = [summary, actionHint, timeWindow].filter(Boolean).join(' | ');
    if (!head && !detail) continue;
    lines.push([head, detail].filter(Boolean).join(' - '));
  }

  if (!lines.length) {
    return {
      lines: [],
      hasOfficialAlerts: false,
    };
  }

  return { lines, hasOfficialAlerts: true };
}

const FOCUS_ENUM = Object.freeze({
  GENERAL: 'general',
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  UV: 'uv',
  WIND: 'wind',
  PRECIP: 'precip',
  PRODUCTS: 'products',
  BUYING_CHANNELS: 'buying_channels',
  SLEEP: 'sleep',
});

const FOCUS_PRIORITY = Object.freeze([
  FOCUS_ENUM.TEMPERATURE,
  FOCUS_ENUM.HUMIDITY,
  FOCUS_ENUM.UV,
  FOCUS_ENUM.WIND,
  FOCUS_ENUM.PRECIP,
  FOCUS_ENUM.PRODUCTS,
  FOCUS_ENUM.BUYING_CHANNELS,
  FOCUS_ENUM.SLEEP,
]);

function detectTravelFoci(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  if (!text) return [FOCUS_ENUM.GENERAL];

  const hit = new Set();
  const add = (focus, yes) => {
    if (yes) hit.add(focus);
  };

  add(
    FOCUS_ENUM.TEMPERATURE,
    /\b(temperature|temp|cold|hot|warmer|colder|degree)\b/i.test(lower) || /(温度|气温|冷|热)/.test(text),
  );
  add(
    FOCUS_ENUM.HUMIDITY,
    /\b(humidity|humid|moisture)\b/i.test(lower) || /(湿度|很湿|潮|闷)/.test(text),
  );
  add(
    FOCUS_ENUM.UV,
    /\b(uv|ultraviolet|sun|sunscreen|spf)\b/i.test(lower) || /(紫外线|日晒|防晒|spf)/i.test(text),
  );
  add(
    FOCUS_ENUM.WIND,
    /\b(wind|windy)\b/i.test(lower) || /(风|大风)/.test(text),
  );
  add(
    FOCUS_ENUM.PRECIP,
    /\b(precip|precipitation|rain|snow)\b/i.test(lower) || /(降水|下雨|雨|雪)/.test(text),
  );
  add(
    FOCUS_ENUM.PRODUCTS,
    /\b(product|products|recommend|recommendation|what to buy|cream|mask|serum)\b/i.test(lower) ||
      /(面霜|面膜|产品|护肤品|推荐|买什么)/.test(text),
  );
  add(
    FOCUS_ENUM.BUYING_CHANNELS,
    /\b(where to buy|buying channel|channels|pharmacy|department store|duty free|ecommerce|shop)\b/i.test(lower) ||
      /(哪里买|在哪买|购买渠道|药房|免税店|百货|电商|渠道)/.test(text),
  );
  add(
    FOCUS_ENUM.SLEEP,
    /\b(jet\s*lag|timezone|time zone|sleep|flight fatigue)\b/i.test(lower) ||
      /(时差|时区|睡眠|飞行疲劳)/.test(text),
  );

  const ordered = [];
  for (const focus of FOCUS_PRIORITY) {
    if (!hit.has(focus)) continue;
    ordered.push(focus);
    if (ordered.length >= 2) break;
  }
  return ordered.length ? ordered : [FOCUS_ENUM.GENERAL];
}

function detectTravelFocus(message) {
  return detectTravelFoci(message)[0] || FOCUS_ENUM.GENERAL;
}

function getMetricByFocus(deltaVsHome, focus) {
  if (!isPlainObject(deltaVsHome)) return null;
  if (focus === FOCUS_ENUM.TEMPERATURE) return deltaVsHome.temperature;
  if (focus === FOCUS_ENUM.HUMIDITY) return deltaVsHome.humidity;
  if (focus === FOCUS_ENUM.UV) return deltaVsHome.uv;
  if (focus === FOCUS_ENUM.WIND) return deltaVsHome.wind;
  if (focus === FOCUS_ENUM.PRECIP) return deltaVsHome.precip;
  return null;
}

function getDeltaKeysForDisplay(foci) {
  const keys = [];
  const pushKey = (key) => {
    if (!key || keys.includes(key)) return;
    keys.push(key);
  };

  for (const focus of Array.isArray(foci) ? foci : []) {
    if (focus === FOCUS_ENUM.TEMPERATURE) pushKey('temperature');
    if (focus === FOCUS_ENUM.HUMIDITY) pushKey('humidity');
    if (focus === FOCUS_ENUM.UV) pushKey('uv');
    if (focus === FOCUS_ENUM.WIND) pushKey('wind');
    if (focus === FOCUS_ENUM.PRECIP) pushKey('precip');
  }

  if (!keys.length) {
    pushKey('temperature');
    pushKey('humidity');
    pushKey('uv');
  }
  return keys.slice(0, 3);
}

function buildPrimaryAnswer({ language, primaryFocus, travelReadiness, destinationLabel, repeated }) {
  const delta = pickTravelDelta(travelReadiness);
  const repeatPrefix = repeated
    ? t(language, '更具体一点，', 'More specifically, ')
    : '';

  if (primaryFocus === FOCUS_ENUM.HUMIDITY) {
    const d = toNumber(delta?.humidity?.delta);
    if (d != null) {
      if (d >= 8) {
        return `${repeatPrefix}${t(language, `${destinationLabel} 会更湿。`, `${destinationLabel} will be more humid than your departure baseline.`)}`;
      }
      if (d <= -8) {
        return `${repeatPrefix}${t(language, `${destinationLabel} 不会更湿，反而更干。`, `${destinationLabel} is likely drier than departure.`)}`;
      }
      return `${repeatPrefix}${t(language, `${destinationLabel} 湿度和出发地接近。`, `${destinationLabel} humidity is close to your departure baseline.`)}`;
    }
    return `${repeatPrefix}${t(language, '湿度对比基线不足，我按目的地给你可执行方案。', 'Departure humidity baseline is missing, so I will give destination-first actions.')}`;
  }

  if (primaryFocus === FOCUS_ENUM.TEMPERATURE) {
    const d = toNumber(delta?.temperature?.delta);
    if (d != null) {
      if (d >= 3) return `${repeatPrefix}${t(language, `${destinationLabel} 会更暖。`, `${destinationLabel} will be warmer than departure.`)}`;
      if (d <= -3) return `${repeatPrefix}${t(language, `${destinationLabel} 会更冷。`, `${destinationLabel} will be colder than departure.`)}`;
      return `${repeatPrefix}${t(language, `${destinationLabel} 温度与出发地接近。`, `${destinationLabel} temperature is close to your departure baseline.`)}`;
    }
    return `${repeatPrefix}${t(language, '温度基线不完整，我先给稳态方案。', 'Temperature baseline is incomplete, so I will start with a stability-first plan.')}`;
  }

  if (primaryFocus === FOCUS_ENUM.UV) {
    const uvDelta = toNumber(delta?.uv?.delta);
    if (uvDelta != null && uvDelta >= 1.5) {
      return `${repeatPrefix}${t(language, `${destinationLabel} UV 压力更高，要加强防晒。`, `${destinationLabel} has higher UV pressure, so increase protection.`)}`;
    }
    return `${repeatPrefix}${t(language, `我会给你明确的 SPF 档位和补涂频次。`, 'I will provide a concrete SPF tier and reapplication cadence.')}`;
  }

  if (primaryFocus === FOCUS_ENUM.PRODUCTS || primaryFocus === FOCUS_ENUM.BUYING_CHANNELS) {
    return `${repeatPrefix}${t(language, '可以，我直接给你可执行的产品清单和购买渠道。', 'Yes. I will give a practical product shortlist and buying channels.')}`;
  }

  if (primaryFocus === FOCUS_ENUM.SLEEP) {
    const hoursDiff = toNumber(travelReadiness && travelReadiness.jetlag_sleep && travelReadiness.jetlag_sleep.hours_diff);
    if (hoursDiff != null) {
      return `${repeatPrefix}${t(language, `时差约 ${formatNumber(hoursDiff, 1)} 小时，我会按这个风险给护肤和作息建议。`, `Timezone gap is about ${formatNumber(hoursDiff, 1)}h, so I will tailor sleep and skincare prep.`)}`;
    }
    return `${repeatPrefix}${t(language, '我会按旅行恢复优先级给你睡眠与修护建议。', 'I will prioritize recovery-focused sleep and skincare guidance.')}`;
  }

  if (primaryFocus === FOCUS_ENUM.WIND || primaryFocus === FOCUS_ENUM.PRECIP) {
    return `${repeatPrefix}${t(language, '有明显环境变化，我会给你差异和准备动作。', 'There are meaningful environment shifts, and I will map them into prep actions.')}`;
  }

  return `${repeatPrefix}${t(language, '我先回答你的重点，再给你下一步该做什么。', 'I will answer your key point first, then give concrete next steps.')}`;
}

function buildComparisonLines({ language, foci, travelReadiness, displayedDeltaKeys }) {
  const delta = pickTravelDelta(travelReadiness);
  const keys = Array.isArray(displayedDeltaKeys) && displayedDeltaKeys.length
    ? displayedDeltaKeys.slice(0, 3)
    : getDeltaKeysForDisplay(foci);

  const mapping = {
    temperature: { labelCn: '温度', labelEn: 'Temperature' },
    humidity: { labelCn: '湿度', labelEn: 'Humidity' },
    uv: { labelCn: 'UV', labelEn: 'UV' },
    wind: { labelCn: '风速', labelEn: 'Wind' },
    precip: { labelCn: '降水', labelEn: 'Precip' },
  };

  const lines = [];
  for (const key of keys.slice(0, 3)) {
    const row = mapping[key];
    const line = formatMetricPair({
      labelCn: row.labelCn,
      labelEn: row.labelEn,
      metric: delta[key],
      language,
    });
    if (!line) continue;
    lines.push(line);
  }

  return lines;
}

function buildActionLines({ language, foci, travelReadiness, displayedDeltaKeys }) {
  const delta = pickTravelDelta(travelReadiness);
  const lines = [];
  const seenSemantics = new Set();
  const focusHumidity = Array.isArray(foci) && foci.includes(FOCUS_ENUM.HUMIDITY);
  const focusTemperature = Array.isArray(foci) && foci.includes(FOCUS_ENUM.TEMPERATURE);

  if (focusHumidity || focusTemperature) {
    const humidityDelta = toNumber(delta?.humidity?.delta);
    const temperatureDelta = toNumber(delta?.temperature?.delta);
    if (humidityDelta != null && humidityDelta >= 8) {
      pushUniqueAction(lines, seenSemantics, t(language,
        'AM 切换为轻薄质地保湿，PM 保留中等修护霜；旅行期避免同晚叠加多种活性。',
        'Switch AM to lighter texture hydration, keep PM medium repair cream; avoid same-night multi-active stacking during travel.',
      ));
    } else if (humidityDelta != null && humidityDelta <= -8) {
      pushUniqueAction(lines, seenSemantics, t(language,
        '目的地更干：AM/PM 升级为修护保湿，夜间易干部位薄涂封层。',
        'Destination is drier: upgrade AM/PM to barrier hydration, add thin occlusive on dry-prone areas at night.',
      ));
    } else if (temperatureDelta != null && Math.abs(temperatureDelta) >= 3) {
      pushUniqueAction(lines, seenSemantics, t(language,
        '温差偏大时保持修护霜 AM/PM，夜间可加一层封闭型保湿。',
        'With larger temperature swings, keep barrier cream AM/PM and add a thin occlusive at night if needed.',
      ));
    }
  }

  if (Array.isArray(foci) && foci.includes(FOCUS_ENUM.SLEEP)) {
    pushUniqueAction(lines, seenSemantics, t(language,
      '飞行当天/落地第一晚以补水修护为主，跳过高强度活性。',
      'Flight day / first night: focus on hydration and recovery, skip strong actives.',
    ));
  }

  const adaptive = Array.isArray(travelReadiness && travelReadiness.adaptive_actions)
    ? travelReadiness.adaptive_actions
    : [];
  for (const row of adaptive) {
    const text = normalizeText(row && row.what_to_do, 280);
    if (text) pushUniqueAction(lines, seenSemantics, text);
    if (lines.length >= 3) break;
  }

  return uniqueStrings(lines, 3);
}

function buildPhasedPlanLines({ language, travelReadiness, foci }) {
  const context = isPlainObject(travelReadiness && travelReadiness.destination_context)
    ? travelReadiness.destination_context
    : {};
  const tripDays = getTripDaysInclusive(context.start_date, context.end_date);
  if (!Number.isFinite(tripDays) || tripDays < 3) return [];

  const delta = pickTravelDelta(travelReadiness);
  const uvDestination = toNumber(delta?.uv?.destination);
  const hasUvStress = uvDestination != null && uvDestination >= 6;
  const hasSleepFocus = Array.isArray(foci) && foci.includes(FOCUS_ENUM.SLEEP);

  const lines = [
    t(
      language,
      '行前（T-2~T-1）：维持现有护肤流程不变，不引入新产品或新活性；新产品先做局部耐受测试。',
      'Pre-trip (T-2 to T-1): keep existing routine unchanged, do not introduce new products or actives; patch-test any new product first.',
    ),
    t(
      language,
      '飞行日：简化至核心 3 步（清洁+保湿+修护），跳过所有活性成分；详见装备清单中的飞行修护面膜。',
      'Flight day: simplify to 3 core steps (cleanse+moisturize+repair), skip all actives; see flight recovery mask in kit.',
    ),
    hasSleepFocus
      ? t(
        language,
        '在地日程：按当地时区调整作息，白天按户外时长执行防晒策略（见装备清单），晚间修护优先后逐步恢复活性频次。',
        'On-site days: align schedule to local time, follow sun protection protocol by outdoor hours (see kit), keep PM recovery-first before gradually resuming actives.',
      )
      : hasUvStress
        ? t(
          language,
          '在地日程：执行装备清单中的防晒+晒后修复方案；晚间修护优先，活性从第 2 晚起逐步恢复。',
          'On-site days: follow sun protection + post-sun repair from kit; PM recovery-first, resume actives gradually from night 2.',
        )
        : t(
          language,
          '在地日程：白天按紧绷/出油状态动态调整保湿；晚间修护优先，按耐受度恢复活性。',
          'On-site days: adjust daytime hydration by tightness/oiliness; PM recovery-first, restore actives by tolerance.',
        ),
  ];
  return uniqueStrings(lines, 3);
}

function buildTravelKitLines({ language, foci, travelReadiness, profile }) {
  const recoBundle = Array.isArray(travelReadiness && travelReadiness.reco_bundle)
    ? travelReadiness.reco_bundle
    : [];
  const shopping = isPlainObject(travelReadiness && travelReadiness.shopping_preview)
    ? travelReadiness.shopping_preview
    : {};
  const categoryRecs = Array.isArray(travelReadiness && travelReadiness.category_recommendations)
    ? travelReadiness.category_recommendations
    : [];

  const lines = [];
  const seenCategories = new Set();

  for (const row of recoBundle.slice(0, 10)) {
    const trigger = normalizeText(row && row.trigger, 120);
    const action = normalizeText(row && row.action, 280);
    const ingredientLogic = normalizeText(row && row.ingredient_logic, 260);
    const reapplyRule = normalizeText(row && row.reapply_rule, 200);
    const productTypes = Array.isArray(row && row.product_types)
      ? row.product_types.map((pt) => normalizeText(pt, 120)).filter(Boolean)
      : [];
    if (!trigger && !action) continue;

    const productStr = productTypes.length ? productTypes.join(', ') : '';
    const parts = [];
    if (trigger) parts.push(`【${trigger}】`);
    if (productStr) parts.push(productStr);
    if (action) parts.push(action);
    if (ingredientLogic) parts.push(`[${t(language, '成分', 'Ingredients')}: ${ingredientLogic}]`);
    if (reapplyRule) parts.push(`(${reapplyRule})`);
    const semantic = travelKitSemanticKey([trigger, action, productStr].filter(Boolean).join(' '));
    if (semantic) seenCategories.add(semantic);
    lines.push(parts.join(' '));
  }

  for (const cat of categoryRecs.slice(0, 10)) {
    const category = normalizeText(cat && cat.category, 40);
    const catProducts = Array.isArray(cat && cat.products) ? cat.products : [];
    if (!category || cat.skip_reason) continue;

    const semantic = travelKitSemanticKey(category);
    if (semantic && seenCategories.has(semantic)) continue;
    if (semantic) seenCategories.add(semantic);

    for (const prod of catProducts.slice(0, 3)) {
      const name = normalizeText(prod && prod.name, 140);
      const usage = normalizeText(prod && prod.usage, 200);
      const ingLogic = normalizeText(prod && prod.ingredient_logic, 200);
      if (!name) continue;
      const parts = [`【${category}】`, name];
      if (usage) parts.push(usage);
      if (ingLogic) parts.push(`[${ingLogic}]`);
      lines.push(parts.join(' '));
    }
  }

  const names = Array.isArray(shopping.products)
    ? shopping.products
        .map((row) => normalizeText(row && row.name, 80))
        .filter(Boolean)
        .slice(0, 6)
    : [];
  if (names.length) {
    lines.push(
      t(language, `主推单品：${names.join(' / ')}。`, `Suggested products: ${names.join(' / ')}.`),
    );
  }

  const storeExamples = Array.isArray(travelReadiness && travelReadiness.store_examples)
    ? travelReadiness.store_examples
    : [];
  if (storeExamples.length) {
    const stores = storeExamples
      .slice(0, 2)
      .map((row) => {
        const name = normalizeText(row && row.name, 80);
        const district = normalizeText(row && row.district, 80);
        if (!name) return '';
        return district ? `${name} (${district})` : name;
      })
      .filter(Boolean);
    if (stores.length) {
      lines.push(
        t(language, `示例门店：${stores.join(' / ')}。`, `Example stores: ${stores.join(' / ')}.`),
      );
    }
  }

  const channels = Array.isArray(shopping.buying_channels)
    ? shopping.buying_channels.map((v) => normalizeText(v, 48)).filter(Boolean).slice(0, 5)
    : [];
  if (channels.length) {
    lines.push(
      t(language, `购买渠道：${channels.join(' / ')}。`, `Buying channels: ${channels.join(' / ')}.`),
    );
  }

  return uniqueStrings(lines, 14);
}

function buildProductLines({ language, foci, travelReadiness }) {
  return buildTravelKitLines({ language, foci, travelReadiness, profile: {} });
}

const SEASONAL_ALERTS = Object.freeze([
  { city: 'tokyo', monthStart: 2, monthEnd: 4, cn: '东京/关东 2-4 月为杉树花粉（sugi）季节，皮肤可能更易敏感/发痒。', en: 'Tokyo/Kanto is typically in cedar (sugi) pollen season around Feb-Apr, which can make skin feel itchier/reactive.' },
  { city: 'osaka', monthStart: 2, monthEnd: 4, cn: '大阪 2-4 月为杉树花粉季节，皮肤可能更易敏感。', en: 'Osaka is in cedar pollen season around Feb-Apr; skin may feel more reactive.' },
  { city: 'kyoto', monthStart: 2, monthEnd: 4, cn: '京都 2-4 月为杉树花粉季节，皮肤可能更易敏感。', en: 'Kyoto is in cedar pollen season around Feb-Apr; skin may feel more reactive.' },
  { city: 'bangkok', monthStart: 3, monthEnd: 5, cn: '曼谷 3-5 月为极端高温期（最高可达 40°C），防晒和补水至关重要。', en: 'Bangkok hits extreme heat in Mar-May (up to 40C); sunscreen and hydration are critical.' },
  { city: 'beijing', monthStart: 3, monthEnd: 5, cn: '北京 3-5 月沙尘天气频繁，空气质量可能较差，清洁+屏障修护更重要。', en: 'Beijing sees sandstorms in Mar-May; air quality can worsen, making cleansing + barrier support more important.' },
  { city: 'london', monthStart: 5, monthEnd: 7, cn: '伦敦 5-7 月花粉季，草类花粉可能引发皮肤敏感。', en: 'London grass pollen season runs May-Jul; this can trigger skin sensitivity.' },
  { city: 'paris', monthStart: 5, monthEnd: 7, cn: '巴黎 5-7 月为草类花粉季节。', en: 'Paris grass pollen season peaks May-Jul.' },
  { city: 'seoul', monthStart: 3, monthEnd: 5, cn: '首尔 3-5 月为花粉+黄沙季节，注意敏感和清洁。', en: 'Seoul sees pollen + yellow dust in Mar-May; watch for sensitivity and cleanse thoroughly.' },
]);

function buildSeasonalContextLines({ language, destination, startDate }) {
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const dest = normalizeText(destination, 140).toLowerCase();
  if (!dest) return [];

  const parsed = parseIsoDateToken(startDate);
  const month = parsed ? parsed.getUTCMonth() + 1 : null;

  const lines = [];
  for (const entry of SEASONAL_ALERTS) {
    if (!dest.includes(entry.city)) continue;
    if (month != null && (month < entry.monthStart || month > entry.monthEnd)) continue;
    lines.push(t(lang, entry.cn, entry.en));
    if (lines.length >= 2) break;
  }
  return lines;
}

function buildFlightDayPlanLines({ language, travelReadiness }) {
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const jetlag = isPlainObject(travelReadiness && travelReadiness.jetlag_sleep)
    ? travelReadiness.jetlag_sleep
    : {};
  const hoursDiff = toNumber(jetlag.hours_diff);
  const riskLevel = normalizeText(jetlag.risk_level, 24).toLowerCase();

  const lines = [];
  lines.push(t(lang,
    '登机前：涂保湿+薄封层（唇部/鼻翼），机舱空气极干。',
    'Before boarding: apply moisturizer + a thin occlusive on lips/nostrils (cabin air is brutal).',
  ));
  lines.push(t(lang,
    '机上：跳过酸/维A；可补涂润唇膏+护手霜；喷雾需配合保湿封住水分（单独喷雾反而更干）。',
    'On the plane: skip acids/retinoids; reapply lip balm + hand cream; facial mist only if you seal it with moisturizer (mist alone dries faster).',
  ));

  if (riskLevel === 'high' || (hoursDiff != null && hoursDiff >= 8)) {
    lines.push(t(lang,
      '落地前 48 小时进入"屏障模式"（极简护肤），让皮肤适应新环境后再恢复活性。',
      'First 48 hours after landing: go "barrier mode" (simple routine) while your skin adjusts before resuming actives.',
    ));
  } else {
    lines.push(t(lang,
      '落地当晚以补水修护为主，次日按皮肤反应决定是否恢复活性。',
      'On arrival night: focus on hydration + recovery; resume actives next day based on how skin responds.',
    ));
  }

  const sleepTips = Array.isArray(jetlag.sleep_tips) ? jetlag.sleep_tips : [];
  for (const tip of sleepTips.slice(0, 1)) {
    const tipText = normalizeText(tip, 220);
    if (tipText) lines.push(tipText);
  }

  return uniqueStrings(lines, 4);
}

function buildActiveHandlingLines({ language, travelReadiness }) {
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const personalFocus = Array.isArray(travelReadiness && travelReadiness.personal_focus)
    ? travelReadiness.personal_focus
    : [];
  const delta = pickTravelDelta(travelReadiness);
  const summaryTags = Array.isArray(delta.summary_tags) ? delta.summary_tags : [];
  const isWindy = summaryTags.includes('windier');
  const hasPollen = summaryTags.includes('pollen') || summaryTags.includes('seasonal_allergen');

  const lines = [];
  if (isWindy || hasPollen || personalFocus.some((f) => /barrier|屏障/i.test(normalizeText(f && f.focus, 80)))) {
    lines.push(t(lang,
      '活性频次降低 30-50%（如每晚改隔天）；风大/花粉季刺激阈值更低。',
      'Reduce active frequency 30-50% (e.g. every night to every other night); wind/pollen season lowers irritation threshold.',
    ));
  } else {
    lines.push(t(lang,
      '活性频次降低约 30%（如隔天使用）；旅行中皮肤适应力下降，不要升浓度。',
      'Reduce active frequency ~30% (e.g. every other night); skin adaptability drops during travel, do not increase concentration.',
    ));
  }

  lines.push(t(lang,
    '刺痛/紧绷信号：立即暂停全部活性 2-3 晚，仅做清洁+保湿+修护。',
    'Stinging/tightness signal: immediately pause all actives for 2-3 nights, only cleanse+moisturize+repair.',
  ));

  return uniqueStrings(lines, 2);
}

function buildPackingListLines({ language, travelReadiness }) {
  return [];
}

function buildTroubleshootingLines({ language, travelReadiness }) {
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const delta = pickTravelDelta(travelReadiness);
  const summaryTags = Array.isArray(delta.summary_tags) ? delta.summary_tags : [];

  const lines = [];
  lines.push(t(lang,
    '紧绷、脱皮、刺痛：减少清洁次数，加一层补水层，晚间用更厚的保湿霜封住。',
    'Tight, flaky, stinging: cleanse less, add a hydrating layer, seal with a richer moisturizer at night.',
  ));
  lines.push(t(lang,
    '比平时更多闭口/粉刺：保持防晒但换更轻薄的保湿，确保晚间彻底卸除防晒。',
    'More clogged pores than usual: keep sunscreen but switch to lighter moisturizer + make sure you\'re truly removing SPF at night.',
  ));

  if (summaryTags.includes('windier') || summaryTags.includes('colder')) {
    lines.push(t(lang,
      '泛红/痒（风+寒冷）：精简步骤，暂停活性，专注温和补水+修护屏障。',
      'Red/itchy patches (wind + cold): simplify routine, pause actives, and prioritize bland hydration/barrier steps.',
    ));
  } else {
    lines.push(t(lang,
      '泛红/痒：精简步骤，暂停活性，专注温和补水+修护屏障。',
      'Red/itchy patches: simplify routine, pause actives, and prioritize bland hydration/barrier steps.',
    ));
  }

  return uniqueStrings(lines, 3);
}

function buildReplySignature({ foci, travelReadiness, homeRegion }) {
  const destinationContext = isPlainObject(travelReadiness && travelReadiness.destination_context)
    ? travelReadiness.destination_context
    : {};
  const delta = pickTravelDelta(travelReadiness);

  const signatureParts = [
    Array.isArray(foci) && foci.length ? foci.join('+') : FOCUS_ENUM.GENERAL,
    normalizeText(destinationContext.destination, 120) || '',
    normalizeText(homeRegion, 120) || '',
    formatSignedNumber(delta?.temperature?.delta, 1) || '',
    formatSignedNumber(delta?.humidity?.delta, 1) || '',
    formatSignedNumber(delta?.uv?.delta, 1) || '',
    normalizeText(delta.baseline_status, 48) || '',
  ];
  return signatureParts.join('|').toLowerCase();
}

function buildTravelTextBrief({
  language,
  directAnswer,
  contextLine,
  comparisonLines,
  actionLines,
  climateFallbackLine,
  envSourceLine,
  alertsSection,
} = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const summary = [];
  summary.push(normalizeText(directAnswer, 260));
  summary.push(normalizeText(contextLine, 240));

  const keyDeltaLine = uniqueStrings(comparisonLines, 2).join(' · ');
  if (keyDeltaLine) {
    summary.push(t(lang, `关键差异：${keyDeltaLine}`, `Key deltas: ${keyDeltaLine}`));
  }

  const nextAction = uniqueStrings(actionLines, 1)[0];
  if (nextAction) {
    summary.push(t(lang, `优先动作：${nextAction}`, `Priority action: ${nextAction}`));
  }

  if (alertsSection && Array.isArray(alertsSection.lines) && alertsSection.lines.length) {
    const alert = uniqueStrings(alertsSection.lines, 1)[0];
    if (alert) {
      summary.push(t(lang, `预警提示：${alert}`, `Alert: ${alert}`));
    }
  }

  if (climateFallbackLine) summary.push(normalizeText(climateFallbackLine, 220));
  if (envSourceLine) summary.push(normalizeText(envSourceLine, 140));
  return uniqueStrings(summary, 7).join('\n\n');
}

function composeTravelReply({
  message,
  language = 'EN',
  travelReadiness,
  destination,
  homeRegion,
  envSource,
  previousFocus,
  previousReplySig,
  previousQuestionHash,
  questionHash,
} = {}) {
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : null;
  if (!readiness) {
    return {
      text: t(lang, '我先按当前可得信息给你旅行护肤建议。', 'I will start with a practical travel skincare plan using currently available data.'),
      text_brief: t(lang, '我先按当前可得信息给你旅行护肤建议。', 'I will start with a practical travel skincare plan using currently available data.'),
      structured_sections: {
        seasonal_context: [],
        key_deltas: [],
        routine_adjustments: [],
        flight_day_plan: [],
        active_handling: [],
        phased_plan: [],
        packing_list: [],
        product_guidance: [],
        troubleshooting: [],
      },
      focus: FOCUS_ENUM.GENERAL,
      foci: [FOCUS_ENUM.GENERAL],
      reply_mode: 'fallback',
      reply_sig: 'fallback',
    };
  }

  const destinationContext = isPlainObject(readiness.destination_context)
    ? readiness.destination_context
    : {};
  const destinationLabel =
    normalizeText(destinationContext.destination, 140) ||
    normalizeText(destination, 140) ||
    t(lang, '目的地', 'destination');
  const originRegionText = pickOriginLabel(readiness, homeRegion);

  const startDate = normalizeText(destinationContext.start_date, 24);
  const endDate = normalizeText(destinationContext.end_date, 24);
  const dateText = startDate && endDate
    ? `${startDate} -> ${endDate}`
    : startDate || endDate || '';

  const delta = pickTravelDelta(readiness);
  const homeBaselineAvailable = normalizeText(delta.baseline_status, 40) !== 'baseline_unavailable';

  const foci = detectTravelFoci(message);
  const focusToken = foci.join('+');
  const displayedDeltaKeys = getDeltaKeysForDisplay(foci);
  const replySig = buildReplySignature({ foci, travelReadiness: readiness, homeRegion: originRegionText });
  const normalizedPrevFocus = normalizeText(previousFocus, 60).toLowerCase();
  const normalizedPrevSig = normalizeText(previousReplySig, 260).toLowerCase();
  const normalizedPrevQuestionHash = normalizeText(previousQuestionHash, 40).toLowerCase();
  const normalizedQuestionHash = normalizeText(questionHash, 40).toLowerCase();
  const repeated = Boolean(
    (normalizedPrevFocus === focusToken || normalizedPrevFocus === foci[0]) &&
      (normalizedPrevSig === replySig || (normalizedPrevQuestionHash && normalizedPrevQuestionHash === normalizedQuestionHash)),
  );

  const directAnswer = buildPrimaryAnswer({
    language: lang,
    primaryFocus: foci[0],
    travelReadiness: readiness,
    destinationLabel,
    repeated,
  });

  const contextLine = originRegionText
    ? t(
      lang,
      `出发地：${originRegionText} -> 目的地：${destinationLabel}${dateText ? `（${dateText}）` : ''}`,
      `Departure: ${originRegionText} -> Destination: ${destinationLabel}${dateText ? ` (${dateText})` : ''}`,
    )
    : t(
      lang,
      `目的地：${destinationLabel}${dateText ? `（${dateText}）` : ''}`,
      `Destination: ${destinationLabel}${dateText ? ` (${dateText})` : ''}`,
    );

  const comparisonLines = buildComparisonLines({
    language: lang,
    foci,
    travelReadiness: readiness,
    displayedDeltaKeys,
  });

  const actionLines = buildActionLines({
    language: lang,
    foci,
    travelReadiness: readiness,
    displayedDeltaKeys,
  });
  const phasedPlanLines = buildPhasedPlanLines({
    language: lang,
    travelReadiness: readiness,
    foci,
  });

  const productLines = buildTravelKitLines({
    language: lang,
    foci,
    travelReadiness: readiness,
    profile: {},
  });

  const baselineGapLine = originRegionText && !homeBaselineAvailable
    ? t(
      lang,
      '缺少出发地基线，对比已降级为目的地绝对值建议。',
      'Departure baseline is unavailable, so comparison is downgraded to destination-only absolute guidance.',
    )
    : '';

  const sourceText =
    normalizeText(envSource, 60) ||
    normalizeText(destinationContext.env_source, 60);
  const envSourceLine = sourceText
    ? t(lang, `数据来源：${sourceText}。`, `Source: ${sourceText}.`)
    : '';
  const climateFallbackLine =
    sourceText.toLowerCase() === 'climate_fallback'
      ? t(
        lang,
        '当前为气候基线估计（实时天气不可用）；建议在出发前 48-72 小时复查实时预报。',
        'Live forecast is unavailable; using a climate baseline. Re-check live weather 48-72 hours before departure.',
      )
      : '';
  const forecastLines = buildForecastLines({ language: lang, travelReadiness: readiness });
  const alertsSection = buildAlertsSection({ language: lang, travelReadiness: readiness });

  const seasonalContextLines = buildSeasonalContextLines({
    language: lang,
    destination: destinationLabel,
    startDate: destinationContext.start_date,
  });
  const flightDayPlanLines = buildFlightDayPlanLines({ language: lang, travelReadiness: readiness });
  const activeHandlingLines = buildActiveHandlingLines({ language: lang, travelReadiness: readiness });
  const packingListLines = buildPackingListLines({ language: lang, travelReadiness: readiness });
  const troubleshootingLines = buildTroubleshootingLines({ language: lang, travelReadiness: readiness });

  const qualitySections = [];
  if (comparisonLines.length) qualitySections.push('answer_delta');
  if (actionLines.length) qualitySections.push('actions');
  if (phasedPlanLines.length) qualitySections.push('phased_plan');
  if (productLines.length) qualitySections.push('travel_kit');
  if (flightDayPlanLines.length) qualitySections.push('flight_day');
  if (activeHandlingLines.length) qualitySections.push('active_handling');
  if (troubleshootingLines.length) qualitySections.push('troubleshooting');
  if (alertsSection.lines.length) qualitySections.push('alerts');

  const text = [
    directAnswer,
    contextLine,
    seasonalContextLines.length
      ? [
        t(lang, '季节/环境提醒：', 'Seasonal / environmental notes:'),
        ...seasonalContextLines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    forecastLines.length
      ? [
        t(lang, '逐日天气：', 'Daily forecast:'),
        ...forecastLines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    comparisonLines.length
      ? [
        t(lang, '关键差异：', 'Key deltas:'),
        ...comparisonLines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    baselineGapLine,
    actionLines.length
      ? [
        t(lang, '护肤调整建议：', 'Adjusted routine guidance:'),
        ...actionLines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    flightDayPlanLines.length
      ? [
        t(lang, '飞行日计划：', 'Flight day plan:'),
        ...flightDayPlanLines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    activeHandlingLines.length
      ? [
        t(lang, '活性成分管理：', 'How to handle actives:'),
        ...activeHandlingLines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    phasedPlanLines.length
      ? [
        t(lang, '分阶段安排：', 'Phased plan:'),
        ...phasedPlanLines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    productLines.length
      ? [
        t(lang, '旅行护肤装备清单：', 'Travel skincare kit:'),
        ...productLines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    troubleshootingLines.length
      ? [
        t(lang, '应急处理：', 'Quick troubleshooting:'),
        ...troubleshootingLines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    alertsSection.lines.length
      ? [
        t(lang, '官方预警：', 'Official alerts:'),
        ...alertsSection.lines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    climateFallbackLine,
    envSourceLine,
  ]
    .filter(Boolean)
    .join('\n\n');

  const mode = comparisonLines.length || actionLines.length || productLines.length ? 'focused' : 'fallback';
  const structuredSections = {
    seasonal_context: uniqueStrings(seasonalContextLines, 6),
    key_deltas: uniqueStrings([...comparisonLines, ...(baselineGapLine ? [baselineGapLine] : [])], 6),
    routine_adjustments: uniqueStrings(actionLines, 6),
    flight_day_plan: uniqueStrings(flightDayPlanLines, 6),
    active_handling: uniqueStrings(activeHandlingLines, 6),
    phased_plan: uniqueStrings(phasedPlanLines, 6),
    packing_list: [],
    travel_kit: uniqueStrings(productLines, 14),
    product_guidance: uniqueStrings(productLines, 14),
    troubleshooting: uniqueStrings(troubleshootingLines, 6),
  };
  const textBrief = buildTravelTextBrief({
    language: lang,
    directAnswer,
    contextLine,
    comparisonLines: [...structuredSections.key_deltas],
    actionLines,
    climateFallbackLine,
    envSourceLine,
    alertsSection,
  });

  return {
    text,
    text_brief: textBrief || text,
    structured_sections: structuredSections,
    focus: focusToken || FOCUS_ENUM.GENERAL,
    foci,
    reply_mode: mode,
    reply_sig: replySig,
    home_baseline_available: homeBaselineAvailable,
    quality_sections: uniqueStrings(qualitySections, 4),
    has_official_alerts: alertsSection.hasOfficialAlerts,
  };
}

module.exports = {
  composeTravelReply,
  __internal: {
    detectTravelFocus,
    detectTravelFoci,
    buildReplySignature,
    formatMetricPair,
    buildSeasonalContextLines,
    buildFlightDayPlanLines,
    buildActiveHandlingLines,
    buildPackingListLines,
    buildTroubleshootingLines,
  },
};
