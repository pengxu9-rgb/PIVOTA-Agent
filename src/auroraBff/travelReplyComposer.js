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
    const deltaLabel = t(language, '变化', 'Delta');
    return `${label}: ${homeText}${unitSuffix} -> ${destinationText}${unitSuffix} (${deltaLabel} ${deltaText}${unitSuffix})`;
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

function buildForecastLines({ language, travelReadiness, limit = 5 }) {
  const rows = Array.isArray(travelReadiness && travelReadiness.forecast_window)
    ? travelReadiness.forecast_window
    : [];
  const out = [];
  const maxItems = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : 5;
  for (const row of rows.slice(0, maxItems)) {
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
    const timeWindow = [
      normalizeText(row && row.start_at, 40),
      normalizeText(row && row.end_at, 40),
    ]
      .filter(Boolean)
      .join(' -> ');
    const head = [severity, title].filter(Boolean).join(' | ');
    const detail = [summary, timeWindow].filter(Boolean).join(' | ');
    if (!head && !detail) continue;
    lines.push([head, detail].filter(Boolean).join(' - '));
  }

  if (!lines.length) {
    return {
      lines: [t(language, '当前无官方预警。', 'No official weather alert currently.')],
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

function parseFocusTokenSet(focusRaw) {
  const raw = normalizeText(focusRaw, 120).toLowerCase();
  if (!raw) return [];
  return raw
    .split('+')
    .map((token) => normalizeText(token, 40).toLowerCase())
    .filter(Boolean)
    .slice(0, 4);
}

function buildReplySigTail(replySigRaw) {
  const sig = normalizeText(replySigRaw, 320).toLowerCase();
  if (!sig) return '';
  const parts = sig.split('|');
  if (parts.length <= 1) return sig;
  return parts.slice(1).join('|');
}

function asksForecastDetails(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  return (
    /\b(forecast|daily|day[-\s]?by[-\s]?day|this week|next week|week ahead|weather)\b/i.test(text) ||
    /(逐日|每天|本周|下周|天气|预报)/.test(text)
  );
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

function buildPrimaryAnswer({ language, primaryFocus, travelReadiness, destinationLabel, repeated }) {
  const delta = isPlainObject(travelReadiness && travelReadiness.delta_vs_home)
    ? travelReadiness.delta_vs_home
    : {};
  const repeatPrefix = repeated
    ? t(language, '更具体一点，', 'More specifically, ')
    : '';

  if (primaryFocus === FOCUS_ENUM.HUMIDITY) {
    const d = toNumber(delta?.humidity?.delta);
    if (d != null) {
      if (d >= 8) {
        return `${repeatPrefix}${t(language, `${destinationLabel} 会更湿。`, `${destinationLabel} will be more humid than your home baseline.`)}`;
      }
      if (d <= -8) {
        return `${repeatPrefix}${t(language, `${destinationLabel} 不会更湿，反而更干。`, `${destinationLabel} is likely drier than home.`)}`;
      }
      return `${repeatPrefix}${t(language, `${destinationLabel} 湿度和常驻地接近。`, `${destinationLabel} humidity is close to home.`)}`;
    }
    return `${repeatPrefix}${t(language, '湿度对比基线不足，我按目的地给你可执行方案。', 'Home humidity baseline is missing, so I will give destination-first actions.')}`;
  }

  if (primaryFocus === FOCUS_ENUM.TEMPERATURE) {
    const d = toNumber(delta?.temperature?.delta);
    if (d != null) {
      if (d >= 3) return `${repeatPrefix}${t(language, `${destinationLabel} 会更暖。`, `${destinationLabel} will be warmer than home.`)}`;
      if (d <= -3) return `${repeatPrefix}${t(language, `${destinationLabel} 会更冷。`, `${destinationLabel} will be colder than home.`)}`;
      return `${repeatPrefix}${t(language, `${destinationLabel} 温度与常驻地接近。`, `${destinationLabel} temperature is close to home.`)}`;
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

function buildComparisonLines({ language, foci, travelReadiness }) {
  const delta = isPlainObject(travelReadiness && travelReadiness.delta_vs_home)
    ? travelReadiness.delta_vs_home
    : {};
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

function buildActionLines({ language, foci, travelReadiness, concise = false }) {
  const delta = isPlainObject(travelReadiness && travelReadiness.delta_vs_home)
    ? travelReadiness.delta_vs_home
    : {};
  const lines = [];

  if (Array.isArray(foci) && foci.includes(FOCUS_ENUM.UV)) {
    const uvDestination = toNumber(delta?.uv?.destination);
    if (uvDestination != null && uvDestination >= 6) {
      lines.push(
        t(
          language,
          '白天选 SPF50+，户外每 2 小时补涂一次，出汗后立即补涂。',
          'Use SPF50+ in daytime; reapply every 2 hours outdoors and immediately after heavy sweat.',
        ),
      );
    } else {
      lines.push(
        t(
          language,
          '日常可用 SPF30-50，若连续户外超过 90 分钟改为 SPF50 并补涂。',
          'Use SPF30-50 daily; if outdoors over 90 minutes continuously, switch to SPF50 and reapply.',
        ),
      );
    }
  }

  if (Array.isArray(foci) && (foci.includes(FOCUS_ENUM.HUMIDITY) || foci.includes(FOCUS_ENUM.TEMPERATURE))) {
    const humidityDelta = toNumber(delta?.humidity?.delta);
    if (humidityDelta != null && humidityDelta >= 8) {
      lines.push(
        t(
          language,
          '早上改轻薄保湿（凝胶/乳液），晚间用中等修护霜，避免同晚叠加多活性。',
          'Switch AM to lighter hydration (gel/lotion), keep a medium repair cream at night, and avoid active stacking.',
        ),
      );
    } else {
      lines.push(
        t(
          language,
          '温差偏大时，早晚都保留屏障修护霜；夜间可加一层封闭型保湿。',
          'With larger temperature swings, keep barrier cream AM/PM and add a thin occlusive layer at night if needed.',
        ),
      );
    }
  }

  if (Array.isArray(foci) && foci.includes(FOCUS_ENUM.SLEEP)) {
    lines.push(
      t(
        language,
        '飞行当天和落地第一晚优先补水修护面膜 1 次，第二晚按皮肤反应决定是否继续。',
        'Use one hydrating recovery mask on flight day or first night after landing; continue second night only if needed.',
      ),
    );
  }

  const adaptive = Array.isArray(travelReadiness && travelReadiness.adaptive_actions)
    ? travelReadiness.adaptive_actions
    : [];
  const adaptiveLimit = concise ? 1 : 3;
  let adaptiveUsed = 0;
  for (const row of adaptive) {
    const text = normalizeText(row && row.what_to_do, 280);
    if (text) lines.push(text);
    adaptiveUsed += text ? 1 : 0;
    if (adaptiveUsed >= adaptiveLimit) break;
  }

  return uniqueStrings(lines, concise ? 2 : 3);
}

function buildProductLines({ language, foci, travelReadiness, concise = false }) {
  const shopping = isPlainObject(travelReadiness && travelReadiness.shopping_preview)
    ? travelReadiness.shopping_preview
    : {};
  const delta = isPlainObject(travelReadiness && travelReadiness.delta_vs_home)
    ? travelReadiness.delta_vs_home
    : {};
  const lines = [];

  if (Array.isArray(foci) && (foci.includes(FOCUS_ENUM.PRODUCTS) || foci.includes(FOCUS_ENUM.UV) || foci.includes(FOCUS_ENUM.HUMIDITY))) {
    const uvDestination = toNumber(delta?.uv?.destination);
    if (uvDestination != null && uvDestination >= 6) {
      lines.push(t(language, '防晒档位：SPF50+（户外为主）。', 'Sunscreen tier: SPF50+ (for outdoor-heavy days).'));
    } else {
      lines.push(t(language, '防晒档位：SPF30-50（通勤可用 SPF30，长户外升到 SPF50）。', 'Sunscreen tier: SPF30-50 (SPF30 for commuting, SPF50 for long outdoor exposure).'));
    }

    const humidityDelta = toNumber(delta?.humidity?.delta);
    if (humidityDelta != null && humidityDelta >= 8) {
      lines.push(
        t(
          language,
          '面霜类型：白天轻薄凝胶霜，夜间屏障修护霜；面膜优先补水修护型。',
          'Moisturizer type: lighter gel-cream in AM, barrier-repair cream in PM; prioritize hydrating recovery masks.',
        ),
      );
    } else {
      lines.push(
        t(
          language,
          '面霜类型：中等到滋润修护霜；面膜优先补水+舒缓型。',
          'Moisturizer type: medium-to-rich barrier cream; choose hydrating and soothing mask types.',
        ),
      );
    }
  }

  const names = Array.isArray(shopping.products)
    ? shopping.products
        .map((row) => normalizeText(row && row.name, 80))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  if (names.length) {
    lines.push(
      t(language, `主推单品：${names.join(' / ')}。`, `Suggested products: ${names.join(' / ')}.`),
    );
  }

  const channels = Array.isArray(shopping.buying_channels)
    ? shopping.buying_channels.map((v) => normalizeText(v, 48)).filter(Boolean).slice(0, 5)
    : [];
  if (channels.length) {
    lines.push(
      t(language, `购买渠道：${channels.join(' / ')}。`, `Buying channels: ${channels.join(' / ')}.`),
    );
  }

  const recoBundle = Array.isArray(travelReadiness && travelReadiness.reco_bundle)
    ? travelReadiness.reco_bundle
    : [];
  for (const row of recoBundle.slice(0, 2)) {
    const action = normalizeText(row && row.action, 240);
    const reapply = normalizeText(row && row.reapply_rule, 200);
    const trigger = normalizeText(row && row.trigger, 120);
    const parts = [trigger, action, reapply].filter(Boolean);
    if (!parts.length) continue;
    lines.push(parts.join(' · '));
  }

  const storeExamples = Array.isArray(travelReadiness && travelReadiness.store_examples)
    ? travelReadiness.store_examples
    : [];
  if (storeExamples.length) {
    const stores = storeExamples
      .slice(0, 3)
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

  return uniqueStrings(lines, concise ? 3 : 4);
}

function buildReplySignature({ foci, travelReadiness, homeRegion }) {
  const destinationContext = isPlainObject(travelReadiness && travelReadiness.destination_context)
    ? travelReadiness.destination_context
    : {};
  const delta = isPlainObject(travelReadiness && travelReadiness.delta_vs_home)
    ? travelReadiness.delta_vs_home
    : {};

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
  const homeRegionText = normalizeText(homeRegion, 140);

  const startDate = normalizeText(destinationContext.start_date, 24);
  const endDate = normalizeText(destinationContext.end_date, 24);
  const dateText = startDate && endDate
    ? `${startDate} -> ${endDate}`
    : startDate || endDate || '';

  const delta = isPlainObject(readiness.delta_vs_home) ? readiness.delta_vs_home : {};
  const homeBaselineAvailable = normalizeText(delta.baseline_status, 40) !== 'baseline_unavailable';

  const foci = detectTravelFoci(message);
  const focusToken = foci.join('+');
  const replySig = buildReplySignature({ foci, travelReadiness: readiness, homeRegion: homeRegionText });
  const normalizedPrevFocus = normalizeText(previousFocus, 60).toLowerCase();
  const currentReplySigTail = buildReplySigTail(replySig);
  const previousReplySigTail = buildReplySigTail(previousReplySig);
  const previousFocusTokens = parseFocusTokenSet(previousFocus);
  const hasPriorTravelTurn = Boolean(
    normalizedPrevFocus || previousReplySigTail || normalizeText(previousQuestionHash, 40).toLowerCase(),
  );
  const samePrimaryFocus = Boolean(
    foci[0] &&
      (normalizedPrevFocus === foci[0] || previousFocusTokens[0] === foci[0] || previousFocusTokens.includes(foci[0])),
  );
  const normalizedPrevQuestionHash = normalizeText(previousQuestionHash, 40).toLowerCase();
  const normalizedQuestionHash = normalizeText(questionHash, 40).toLowerCase();
  const followupCompact = Boolean(
    hasPriorTravelTurn &&
    samePrimaryFocus &&
      normalizedPrevFocus !== focusToken,
  );
  const repeated = Boolean(
    followupCompact ||
      (hasPriorTravelTurn &&
        samePrimaryFocus &&
        ((previousReplySigTail && previousReplySigTail === currentReplySigTail) ||
          (normalizedPrevQuestionHash && normalizedPrevQuestionHash === normalizedQuestionHash))),
  );
  const includeForecastSection = !followupCompact || asksForecastDetails(message);

  const directAnswer = buildPrimaryAnswer({
    language: lang,
    primaryFocus: foci[0],
    travelReadiness: readiness,
    destinationLabel,
    repeated,
  });

  const contextLine = homeRegionText
    ? t(
      lang,
      `常驻地：${homeRegionText} -> 目的地：${destinationLabel}${dateText ? `（${dateText}）` : ''}`,
      `Home region: ${homeRegionText} -> Destination: ${destinationLabel}${dateText ? ` (${dateText})` : ''}`,
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
  });

  const actionLines = buildActionLines({
    language: lang,
    foci,
    travelReadiness: readiness,
    concise: followupCompact,
  });

  const productLines = buildProductLines({
    language: lang,
    foci,
    travelReadiness: readiness,
    concise: followupCompact,
  });

  const baselineGapLine = homeRegionText && !homeBaselineAvailable
    ? t(
      lang,
      '缺少 home baseline，对比已降级为目的地绝对值建议。',
      'Home baseline is unavailable, so comparison is downgraded to destination-only absolute guidance.',
    )
    : '';

  const envSourceLine = normalizeText(envSource, 60)
    ? t(lang, `数据来源：${normalizeText(envSource, 60)}。`, `Source: ${normalizeText(envSource, 60)}.`)
    : '';
  const forecastLines = includeForecastSection
    ? buildForecastLines({
      language: lang,
      travelReadiness: readiness,
      limit: followupCompact ? 2 : 5,
    })
    : [];
  const alertsSection = buildAlertsSection({ language: lang, travelReadiness: readiness });
  const qualitySections = [];
  if (comparisonLines.length) qualitySections.push('answer_delta');
  if (actionLines.length) qualitySections.push('actions');
  if (productLines.length) qualitySections.push('products');
  if (alertsSection.lines.length) qualitySections.push('alerts');

  const text = [
    directAnswer,
    contextLine,
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
        t(lang, '执行动作：', 'Actions:'),
        ...actionLines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    productLines.length
      ? [
        t(lang, '产品与准备：', 'Products and prep:'),
        ...productLines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    alertsSection.lines.length
      ? [
        t(lang, '官方预警：', 'Official alerts:'),
        ...alertsSection.lines.map((line) => `- ${line}`),
      ].join('\n')
      : '',
    envSourceLine,
  ]
    .filter(Boolean)
    .join('\n\n');

  const mode = comparisonLines.length || actionLines.length || productLines.length ? 'focused' : 'fallback';

  return {
    text,
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
  },
};
