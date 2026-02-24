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

function uniqueStrings(values, maxItems = 6) {
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

  if (home != null && destination != null) {
    const homeText = formatNumber(home, unit === '%' || unit === 'C' ? 0 : 1);
    const destinationText = formatNumber(destination, unit === '%' || unit === 'C' ? 0 : 1);
    const deltaText = formatSignedNumber(delta, unit === '%' || unit === 'C' ? 0 : 1);
    const unitSuffix = unit || '';
    const deltaLabel = t(language, '变化', 'Delta');
    return `${label}: ${homeText}${unitSuffix} -> ${destinationText}${unitSuffix} (${deltaLabel} ${deltaText}${unitSuffix})`;
  }

  if (destination != null) {
    const destinationText = formatNumber(destination, unit === '%' || unit === 'C' ? 0 : 1);
    const unitSuffix = unit || '';
    return `${label}: ${destinationText}${unitSuffix}`;
  }

  return '';
}

const FOCUS_ENUM = Object.freeze({
  GENERAL: 'general',
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  UV: 'uv',
  WIND: 'wind',
  PRECIP: 'precip',
  SLEEP: 'sleep',
  PRODUCTS: 'products',
  BUYING_CHANNELS: 'buying_channels',
});

function detectTravelFocus(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  if (/\b(where to buy|buying channel|buying channels|channel|pharmacy|department store|duty free|ecommerce|shop)\b/i.test(lower) || /(哪里买|在哪买|购买渠道|药房|免税店|百货|电商|渠道)/.test(text)) {
    return FOCUS_ENUM.BUYING_CHANNELS;
  }
  if (/\b(product|products|recommend|recommendation|what to buy|skincare items?)\b/i.test(lower) || /(买什么|产品|护肤品|推荐什么)/.test(text)) {
    return FOCUS_ENUM.PRODUCTS;
  }
  if (/\b(jet\s*lag|timezone|time zone|sleep|sleeping|flight fatigue)\b/i.test(lower) || /(时差|时区|睡眠|飞行疲劳)/.test(text)) {
    return FOCUS_ENUM.SLEEP;
  }
  if (/\b(humidity|humid|moisture)\b/i.test(lower) || /(湿|湿度|潮)/.test(text)) {
    return FOCUS_ENUM.HUMIDITY;
  }
  if (/\b(temperature|temp|cold|hot|warmer|colder)\b/i.test(lower) || /(温度|气温|冷|热)/.test(text)) {
    return FOCUS_ENUM.TEMPERATURE;
  }
  if (/\b(uv|ultraviolet|sun|sunscreen|spf)\b/i.test(lower) || /(紫外线|日晒|防晒|晒)/.test(text)) {
    return FOCUS_ENUM.UV;
  }
  if (/\b(wind|windy)\b/i.test(lower) || /(风|大风)/.test(text)) {
    return FOCUS_ENUM.WIND;
  }
  if (/\b(precip|precipitation|rain|snow)\b/i.test(lower) || /(降水|下雨|雨|雪)/.test(text)) {
    return FOCUS_ENUM.PRECIP;
  }
  return FOCUS_ENUM.GENERAL;
}

function selectPrimaryMetric(deltaVsHome, focus) {
  if (!isPlainObject(deltaVsHome)) return null;
  if (focus === FOCUS_ENUM.TEMPERATURE) return deltaVsHome.temperature;
  if (focus === FOCUS_ENUM.HUMIDITY) return deltaVsHome.humidity;
  if (focus === FOCUS_ENUM.UV) return deltaVsHome.uv;
  if (focus === FOCUS_ENUM.WIND) return deltaVsHome.wind;
  if (focus === FOCUS_ENUM.PRECIP) return deltaVsHome.precip;
  return null;
}

function buildDirectAnswer({ language, focus, travelReadiness, repeated }) {
  const delta = isPlainObject(travelReadiness && travelReadiness.delta_vs_home)
    ? travelReadiness.delta_vs_home
    : {};
  const destinationContext = isPlainObject(travelReadiness && travelReadiness.destination_context)
    ? travelReadiness.destination_context
    : {};
  const destination = normalizeText(destinationContext.destination, 140) || t(language, '目的地', 'your destination');
  const repeatPrefix = repeated
    ? t(language, '更具体一点，', 'More specifically, ')
    : '';

  if (focus === FOCUS_ENUM.HUMIDITY) {
    const humidity = isPlainObject(delta.humidity) ? delta.humidity : {};
    const humidityDelta = toNumber(humidity.delta);
    const humidityDestination = toNumber(humidity.destination);
    if (humidityDelta != null) {
      if (humidityDelta >= 8) {
        return `${repeatPrefix}${t(language, `会更湿。${destination} 的湿度预计高于常驻地。`, `Yes. ${destination} is likely more humid than your home baseline.`)}`;
      }
      if (humidityDelta <= -8) {
        return `${repeatPrefix}${t(language, `不会更湿，反而更干一些。`, `Not really — it is likely drier than your home baseline.`)}`;
      }
      return `${repeatPrefix}${t(language, `湿度大致接近，但会有小幅波动。`, 'Humidity looks broadly similar, with mild swings.')}`;
    }
    if (humidityDestination != null) {
      return `${repeatPrefix}${t(language, `当前看 ${destination} 湿度约 ${formatNumber(humidityDestination, 0)}%。`, `${destination} humidity is around ${formatNumber(humidityDestination, 0)}%.`)}`;
    }
    return `${repeatPrefix}${t(language, `我先给你按目的地可执行方案。`, 'I will give you a destination-first actionable plan.')}`;
  }

  if (focus === FOCUS_ENUM.TEMPERATURE) {
    const temperature = isPlainObject(delta.temperature) ? delta.temperature : {};
    const tempDelta = toNumber(temperature.delta);
    const tempDestination = toNumber(temperature.destination);
    if (tempDelta != null) {
      if (tempDelta <= -3) {
        return `${repeatPrefix}${t(language, `${destination} 会明显更冷。`, `${destination} will be noticeably colder than home.`)}`;
      }
      if (tempDelta >= 3) {
        return `${repeatPrefix}${t(language, `${destination} 会更暖。`, `${destination} will be warmer than home.`)}`;
      }
      return `${repeatPrefix}${t(language, `${destination} 温度与常驻地接近。`, `${destination} temperature is close to home.`)}`;
    }
    if (tempDestination != null) {
      return `${repeatPrefix}${t(language, `${destination} 预计最高温约 ${formatNumber(tempDestination, 0)}C。`, `${destination} max temperature is around ${formatNumber(tempDestination, 0)}C.`)}`;
    }
    return `${repeatPrefix}${t(language, `温度会有波动，我先给你稳态方案。`, 'Temperature can swing; I will start with a stability-first plan.')}`;
  }

  if (focus === FOCUS_ENUM.UV) {
    const uv = isPlainObject(delta.uv) ? delta.uv : {};
    const uvDelta = toNumber(uv.delta);
    const uvDestination = toNumber(uv.destination);
    if (uvDelta != null && uvDelta >= 1.5) {
      return `${repeatPrefix}${t(language, `${destination} UV 压力更高，需要加强防晒。`, `${destination} has higher UV pressure, so strengthen sun protection.`)}`;
    }
    if (uvDestination != null) {
      return `${repeatPrefix}${t(language, `${destination} UV 峰值约 ${formatNumber(uvDestination, 1)}。`, `${destination} UV peak is around ${formatNumber(uvDestination, 1)}.`)}`;
    }
    return `${repeatPrefix}${t(language, `先按中高 UV 防护执行更稳妥。`, 'A medium-high UV protection setup is safer for now.')}`;
  }

  if (focus === FOCUS_ENUM.WIND) {
    return `${repeatPrefix}${t(language, '风力变化会影响屏障，建议偏修护策略。', 'Wind changes can stress the barrier, so favor recovery-oriented care.')}`;
  }

  if (focus === FOCUS_ENUM.PRECIP) {
    return `${repeatPrefix}${t(language, '降水/潮湿变化会增加闷痘波动，建议控叠加。', 'Precipitation and dampness swings can raise congestion variability, so avoid active stacking.')}`;
  }

  if (focus === FOCUS_ENUM.SLEEP) {
    const jetlag = isPlainObject(travelReadiness && travelReadiness.jetlag_sleep)
      ? travelReadiness.jetlag_sleep
      : {};
    const hoursDiff = toNumber(jetlag.hours_diff);
    const risk = normalizeText(jetlag.risk_level, 20);
    if (hoursDiff != null) {
      return `${repeatPrefix}${t(language, `时差约 ${formatNumber(hoursDiff, 1)} 小时（风险：${risk || 'medium'}）。`, `Timezone gap is about ${formatNumber(hoursDiff, 1)}h (risk: ${risk || 'medium'}).`)}`;
    }
    return `${repeatPrefix}${t(language, '时差风险可控，我会给你简洁的作息建议。', 'Jet lag looks manageable; I will keep sleep guidance simple and practical.')}`;
  }

  if (focus === FOCUS_ENUM.PRODUCTS) {
    const products = Array.isArray(travelReadiness && travelReadiness.shopping_preview && travelReadiness.shopping_preview.products)
      ? travelReadiness.shopping_preview.products
      : [];
    if (products.length) {
      const names = products.slice(0, 3).map((row) => normalizeText(row && row.name, 80)).filter(Boolean);
      if (names.length) {
        return `${repeatPrefix}${t(language, `可以，先从这几类开始：${names.join(' / ')}。`, `Yes. Start with these options: ${names.join(' / ')}.`)}`;
      }
    }
    return `${repeatPrefix}${t(language, '可以，我先给你旅行期的产品类型优先级。', 'Yes. I will give you travel-priority product types first.')}`;
  }

  if (focus === FOCUS_ENUM.BUYING_CHANNELS) {
    const channels = Array.isArray(travelReadiness && travelReadiness.shopping_preview && travelReadiness.shopping_preview.buying_channels)
      ? travelReadiness.shopping_preview.buying_channels
      : [];
    if (channels.length) {
      return `${repeatPrefix}${t(language, `可以买到，优先渠道是：${channels.join(' / ')}。`, `You can buy there. Priority channels: ${channels.join(' / ')}.`)}`;
    }
    return `${repeatPrefix}${t(language, '我先给你渠道级建议，不做门店坐标承诺。', 'I can provide channel-level guidance first (no nearest-store coordinates).')}`;
  }

  const summaryTags = Array.isArray(delta.summary_tags) ? delta.summary_tags : [];
  if (summaryTags.includes('colder') || summaryTags.includes('more_humid') || summaryTags.includes('higher_uv')) {
    return `${repeatPrefix}${t(language, `${destination} 和常驻地有明显环境差异，我给你按差异落地的方案。`, `${destination} differs meaningfully from home, so here is a delta-based plan.`)}`;
  }
  return `${repeatPrefix}${t(language, `我先回答你的重点，再给你可执行动作。`, 'I will answer your key point first, then list concrete actions.')}`;
}

function buildComparisonLines({ language, focus, travelReadiness, repeated }) {
  const delta = isPlainObject(travelReadiness && travelReadiness.delta_vs_home)
    ? travelReadiness.delta_vs_home
    : {};

  const orderedKeys = (() => {
    if (focus === FOCUS_ENUM.TEMPERATURE) return ['temperature', 'humidity', 'uv'];
    if (focus === FOCUS_ENUM.HUMIDITY) return ['humidity', 'temperature', 'uv'];
    if (focus === FOCUS_ENUM.UV) return ['uv', 'humidity', 'temperature'];
    if (focus === FOCUS_ENUM.WIND) return ['wind', 'humidity', 'temperature'];
    if (focus === FOCUS_ENUM.PRECIP) return ['precip', 'humidity', 'temperature'];
    return ['temperature', 'humidity', 'uv'];
  })();

  const mapping = {
    temperature: { labelCn: '温度', labelEn: 'Temperature' },
    humidity: { labelCn: '湿度', labelEn: 'Humidity' },
    uv: { labelCn: 'UV', labelEn: 'UV' },
    wind: { labelCn: '风速', labelEn: 'Wind' },
    precip: { labelCn: '降水', labelEn: 'Precip' },
  };

  const limit = repeated ? 3 : 2;
  const lines = [];
  for (const key of orderedKeys) {
    const row = mapping[key];
    const line = formatMetricPair({
      labelCn: row.labelCn,
      labelEn: row.labelEn,
      metric: delta[key],
      language,
    });
    if (!line) continue;
    lines.push(line);
    if (lines.length >= limit) break;
  }

  if (!lines.length) {
    const primaryMetric = selectPrimaryMetric(delta, focus);
    const genericLine = formatMetricPair({
      labelCn: t(language, '目的地指标', 'Destination metric'),
      labelEn: t(language, '目的地指标', 'Destination metric'),
      metric: primaryMetric,
      language,
    });
    if (genericLine) lines.push(genericLine);
  }

  return lines;
}

function collectActionLines({ language, focus, travelReadiness, repeated }) {
  const out = [];

  if (focus === FOCUS_ENUM.SLEEP) {
    const sleepTips = Array.isArray(travelReadiness && travelReadiness.jetlag_sleep && travelReadiness.jetlag_sleep.sleep_tips)
      ? travelReadiness.jetlag_sleep.sleep_tips
      : [];
    for (const row of sleepTips.slice(0, 2)) {
      const text = normalizeText(row, 240);
      if (text) out.push(text);
    }
  }

  const adaptive = Array.isArray(travelReadiness && travelReadiness.adaptive_actions)
    ? travelReadiness.adaptive_actions
    : [];
  for (const row of adaptive) {
    const text = normalizeText(row && row.what_to_do, 280);
    if (text) out.push(text);
    if (out.length >= (repeated ? 4 : 3)) break;
  }

  if (out.length < 2) {
    const focusRows = Array.isArray(travelReadiness && travelReadiness.personal_focus)
      ? travelReadiness.personal_focus
      : [];
    for (const row of focusRows) {
      const text = normalizeText(row && row.what_to_do, 280);
      if (text) out.push(text);
      if (out.length >= 3) break;
    }
  }

  if (out.length < 2 && focus === FOCUS_ENUM.BUYING_CHANNELS) {
    const channels = Array.isArray(travelReadiness && travelReadiness.shopping_preview && travelReadiness.shopping_preview.buying_channels)
      ? travelReadiness.shopping_preview.buying_channels
      : [];
    if (channels.length) {
      out.push(
        t(
          language,
          `优先渠道：${channels.join(' / ')}。`,
          `Prioritize channels: ${channels.join(' / ')}.`,
        ),
      );
    }
  }

  if (!out.length) {
    out.push(
      t(
        language,
        '先稳住清洁-保湿-防晒三件事，再按反应微调活性频率。',
        'Stabilize cleanse-moisturize-sunscreen first, then tune active frequency by skin response.',
      ),
    );
  }

  return uniqueStrings(out, repeated ? 4 : 3);
}

function buildReplySignature({ focus, travelReadiness, homeRegion }) {
  const destinationContext = isPlainObject(travelReadiness && travelReadiness.destination_context)
    ? travelReadiness.destination_context
    : {};
  const delta = isPlainObject(travelReadiness && travelReadiness.delta_vs_home)
    ? travelReadiness.delta_vs_home
    : {};

  const primary = selectPrimaryMetric(delta, focus);
  const signatureParts = [
    focus || FOCUS_ENUM.GENERAL,
    normalizeText(destinationContext.destination, 120) || '',
    normalizeText(homeRegion, 120) || '',
    formatSignedNumber(primary && primary.delta, 1) || '',
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
} = {}) {
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : null;
  if (!readiness) {
    return {
      text: t(lang, '我先按当前可得信息给你旅行护肤建议。', 'I will start with a practical travel skincare plan using currently available data.'),
      focus: FOCUS_ENUM.GENERAL,
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

  const focus = detectTravelFocus(message);
  const replySig = buildReplySignature({ focus, travelReadiness: readiness, homeRegion: homeRegionText });
  const repeated =
    normalizeText(previousFocus, 40) === focus &&
    normalizeText(previousReplySig, 260).toLowerCase() === replySig;

  const directAnswer = buildDirectAnswer({
    language: lang,
    focus,
    travelReadiness: readiness,
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
    focus,
    travelReadiness: readiness,
    repeated,
  });

  const actionLines = collectActionLines({
    language: lang,
    focus,
    travelReadiness: readiness,
    repeated,
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

  const actionHeader = t(lang, '建议动作：', 'What to do:');
  const bulletActions = actionLines.map((line) => `- ${line}`);

  const text = [
    directAnswer,
    contextLine,
    ...comparisonLines,
    baselineGapLine,
    actionHeader,
    ...bulletActions,
    envSourceLine,
  ]
    .filter(Boolean)
    .join('\n');

  const mode = comparisonLines.length || actionLines.length ? 'focused' : 'fallback';

  return {
    text,
    focus,
    reply_mode: mode,
    reply_sig: replySig,
    home_baseline_available: homeBaselineAvailable,
  };
}

module.exports = {
  composeTravelReply,
  __internal: {
    detectTravelFocus,
    buildReplySignature,
    formatMetricPair,
  },
};
