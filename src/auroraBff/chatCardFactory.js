function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function asStringArray(value, max = 6) {
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const row of source) {
    const text = asString(row);
    if (!text) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function asRecordArray(value, max = 8) {
  const source = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of source) {
    if (!isPlainObject(item)) continue;
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (isPlainObject(value)) {
    const amount = Number(value.amount);
    return Number.isFinite(amount) ? amount : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCardId(value, fallbackPrefix, requestId, idx) {
  const fromRaw = asString(value);
  if (fromRaw) return fromRaw.slice(0, 120);
  return `${fallbackPrefix}_${requestId}_${idx}`;
}

function pickPlainObject(value) {
  return isPlainObject(value) ? value : {};
}

function buildTravelRouteLabel(readiness, language) {
  const destination = pickPlainObject(readiness.destination_context);
  const origin = pickPlainObject(readiness.origin_context);
  const destinationLabel = asString(destination.destination);
  const originLabel = asString(origin.label);
  const startDate = asString(destination.start_date);
  const endDate = asString(destination.end_date);
  const route = [originLabel, destinationLabel].filter(Boolean).join(' -> ');
  const dates = startDate || endDate ? `${startDate || '?'}${endDate ? ` -> ${endDate}` : ''}` : '';
  if (route && dates) return `${route} · ${dates}`;
  if (route) return route;
  if (destinationLabel && dates) return `${destinationLabel} · ${dates}`;
  return destinationLabel || (language === 'CN' ? '旅行护肤方案' : 'Travel skincare plan');
}

function formatTravelDeltaMetric(metric) {
  if (!isPlainObject(metric)) return null;
  const destination = asNumber(metric.destination);
  const home = asNumber(metric.home);
  const delta = asNumber(metric.delta);
  const unit = asString(metric.unit);
  if (destination == null) return null;
  const rounded = (value) => Math.round(Number(value) * 10) / 10;
  const deltaLabel = delta == null ? null : `${delta > 0 ? '+' : ''}${rounded(delta)}${unit}`;
  return {
    home,
    destination,
    delta,
    unit,
    label: home != null && deltaLabel
      ? `${rounded(home)}${unit} -> ${rounded(destination)}${unit} (${deltaLabel})`
      : `${rounded(destination)}${unit}`,
  };
}

function isLegacyTravelProductSource(value) {
  return asString(value).toLowerCase() === 'rule_fallback';
}

function normalizeTravelShoppingProduct(row) {
  if (!isPlainObject(row)) return null;
  const name = asString(row.name);
  if (!name) return null;
  if (isLegacyTravelProductSource(row.product_source || row.productSource)) return null;
  const normalizedProductSource = asString(row.product_source || row.productSource);
  const productId = asString(row.product_id || row.productId) || null;
  const isGrounded =
    row.is_grounded === true ||
    Boolean(productId) ||
    /^(catalog|internal|external_seed)$/i.test(normalizedProductSource) ||
    /^(grounded|catalog_verified|authority|resolved)$/i.test(asString(row.authority_status || row.match_status));
  return {
    rank: asNumber(row.rank),
    product_id: productId,
    merchant_id: asString(row.merchant_id || row.merchantId) || null,
    product_group_id: asString(row.product_group_id || row.productGroupId) || null,
    name,
    brand: asString(row.brand) || null,
    category: asString(row.category) || null,
    reasons: asStringArray(row.reasons, 3),
    product_source: normalizedProductSource || null,
    authority_status: asString(row.authority_status) || (isGrounded ? 'grounded' : 'category_only'),
    match_status: asString(row.match_status) || (isGrounded ? 'catalog_verified' : 'category_guidance'),
    display_mode: asString(row.display_mode) || (isGrounded ? 'product_card' : 'category_only'),
    role_id: asString(row.role_id || row.roleId) || null,
    pdp_open: isPlainObject(row.pdp_open) ? row.pdp_open : row.pdp_open || null,
    price: row.price ?? null,
    currency: asString(row.currency) || null,
    image_url: asString(row.image_url || row.imageUrl) || null,
    canonical_url: asString(row.canonical_url || row.canonicalUrl || row.url) || null,
    is_grounded: isGrounded,
  };
}

function normalizeTravelPhasePlan(value) {
  const rows = asRecordArray(value, 8);
  const out = [];
  for (const row of rows) {
    const id = asString(row.id);
    const title = asString(row.title);
    if (!id || !title) continue;
    out.push({
      id,
      title,
      timing: asString(row.timing) || null,
      why: asString(row.why) || null,
      actions: asStringArray(row.actions, 5),
      product_role_ids: asStringArray(row.product_role_ids || row.productRoleIds, 10),
      product_ids: asStringArray(row.product_ids || row.productIds, 8),
      coverage_status: asString(row.coverage_status || row.coverageStatus) || null,
    });
  }
  return out;
}

function labelTravelBuyingChannel(channel, language = 'EN') {
  const token = asString(channel).toLowerCase();
  const cn = language === 'CN';
  const map = {
    beauty_retail: cn ? '美妆集合店' : 'beauty retailers',
    pharmacy: cn ? '药妆/药房' : 'pharmacies',
    department_store: cn ? '百货美妆专柜' : 'department-store beauty counters',
    duty_free: cn ? '机场/免税店' : 'airport or duty-free shops',
    ecommerce: cn ? '本地电商' : 'local e-commerce',
  };
  return map[token] || asString(channel);
}

function isGroundedTravelProduct(row) {
  const product = normalizeTravelShoppingProduct(row);
  if (!product) return false;
  const source = String(product.product_source || '').toLowerCase();
  const status = String(product.authority_status || product.match_status || '').toLowerCase();
  return product.is_grounded || source === 'catalog' || /grounded|catalog|authority|resolved/.test(status);
}

function isAuthoritativeTravelKitSuggestion(row) {
  if (!isPlainObject(row)) return false;
  const status = asString(row.match_status || row.authority_status).toLowerCase();
  return Boolean(asString(row.brand)) || /catalog|grounded|authority|resolved|internal|external_seed/.test(status);
}

function normalizeTravelKitEntry(row) {
  if (!isPlainObject(row)) return row;
  const brandSuggestions = Array.isArray(row.brand_suggestions) ? row.brand_suggestions.filter(isPlainObject) : [];
  const existingCategorySuggestions = Array.isArray(row.category_suggestions) ? row.category_suggestions.filter(isPlainObject) : [];
  const authoritative = brandSuggestions.filter(isAuthoritativeTravelKitSuggestion);
  return {
    ...row,
    brand_suggestions: authoritative.length ? authoritative : null,
    category_suggestions: existingCategorySuggestions.length
      ? existingCategorySuggestions.slice(0, 4)
      : null,
  };
}

function buildTravelPlannerCardViewModel(envPayload, language = 'EN') {
  const readiness = pickPlainObject(pickPlainObject(envPayload).travel_readiness);
  if (!Object.keys(readiness).length) return null;
  const lang = language === 'CN' ? 'CN' : 'EN';
  const destination = pickPlainObject(readiness.destination_context);
  const origin = pickPlainObject(readiness.origin_context);
  const delta = pickPlainObject(readiness.delta_vs_origin || readiness.delta_vs_home);
  const shopping = pickPlainObject(readiness.shopping_preview);
  const rawProducts = Array.isArray(shopping.products) ? shopping.products : [];
  const legacyDroppedCount = rawProducts.filter((row) => isPlainObject(row) && isLegacyTravelProductSource(row.product_source || row.productSource)).length;
  const products = Array.isArray(shopping.products)
    ? shopping.products.map(normalizeTravelShoppingProduct).filter(Boolean)
    : [];
  const groundedProducts = products.filter((row) => isGroundedTravelProduct(row));
  const categoryGuidance = products.filter((row) => !isGroundedTravelProduct(row));
  const structured = pickPlainObject(readiness.structured_sections);
  return {
    schema_version: 'aurora.ui.travel_planner.v1',
    source_schema_version: asString(envPayload && envPayload.schema_version) || null,
    summary_strip: {
      title: lang === 'CN' ? '旅行护肤方案' : 'Travel skincare plan',
      route_label: buildTravelRouteLabel(readiness, lang),
      source: asString(destination.env_source || envPayload.env_source) || null,
      product_coverage_status: asString(shopping.coverage_status) || (groundedProducts.length ? 'grounded' : 'category_only'),
    },
    route: {
      origin: asString(origin.label) || null,
      destination: asString(destination.destination) || null,
      start_date: asString(destination.start_date) || null,
      end_date: asString(destination.end_date) || null,
    },
    forecast_window: Array.isArray(readiness.forecast_window) ? readiness.forecast_window.slice(0, 7) : [],
    environment_deltas: {
      temperature: formatTravelDeltaMetric(delta.temperature),
      humidity: formatTravelDeltaMetric(delta.humidity),
      uv: formatTravelDeltaMetric(delta.uv),
      precip: formatTravelDeltaMetric(delta.precip),
      wind: formatTravelDeltaMetric(delta.wind),
      summary_tags: asStringArray(delta.summary_tags, 6),
    },
    jetlag_sleep: isPlainObject(readiness.jetlag_sleep) ? readiness.jetlag_sleep : null,
    phase_plan: normalizeTravelPhasePlan(readiness.phase_plan),
    timeline: {
      pre_trip: asStringArray(structured.phased_plan, 6).filter((line) => /pre-trip|t-2|出发前/i.test(line)),
      flight_day: asStringArray(structured.flight_day_plan, 6),
      first_48h: asStringArray(structured.flight_day_plan, 6).filter((line) => /48|arrival|落地|抵达/i.test(line)),
      on_site: asStringArray(structured.phased_plan, 6).filter((line) => /on-site|在地|arrival|落地/i.test(line)),
      active_handling: asStringArray(structured.active_handling, 6),
    },
    travel_kit: Array.isArray(readiness.categorized_kit)
      ? readiness.categorized_kit.slice(0, 8).map(normalizeTravelKitEntry)
      : [],
    shopping: {
      mode: asString(shopping.mode) || (groundedProducts.length ? 'grounded_products' : 'category_guidance'),
      coverage_status: asString(shopping.coverage_status) || (groundedProducts.length ? 'grounded' : 'category_only'),
      grounded_products: groundedProducts.slice(0, 6),
      category_guidance: categoryGuidance.slice(0, 8),
      buying_channels: asStringArray(shopping.buying_channels, 8),
      buying_channel_labels: asStringArray(shopping.buying_channels, 8).map((channel) => labelTravelBuyingChannel(channel, lang)),
      city_hint: asString(shopping.city_hint) || null,
      note: asString(shopping.note) || null,
      legacy_rows_dropped_count: legacyDroppedCount,
    },
  };
}

function formatTravelReminderNote(raw, language = 'EN') {
  const text = asString(raw);
  if (!text) return '';
  const lang = language === 'CN' ? 'CN' : 'EN';
  if (/^missing:\s*recent_logs$/i.test(text)) {
    return lang === 'CN'
      ? '暂无近期皮肤记录，因此节奏保持保守。'
      : 'No recent skin logs, so the plan stays conservative.';
  }
  const barrier = text.match(/^barrier_status\s*=\s*(.+)$/i);
  if (barrier) {
    return lang === 'CN' ? `屏障状态：${barrier[1]}。` : `Barrier status: ${barrier[1]}.`;
  }
  const scenario = text.match(/^scenario:\s*(.+?)(?:\s*\(inferred\))?$/i);
  if (scenario) {
    return lang === 'CN' ? `主要环境关注：${scenario[1]}。` : `Main environment focus: ${scenario[1]}.`;
  }
  return text;
}

function buildTravelCardReminderItems({ payload, envPayload, language = 'EN' }) {
  const readiness = pickPlainObject(pickPlainObject(envPayload).travel_readiness);
  const lang = language === 'CN' ? 'CN' : 'EN';
  if (Object.keys(readiness).length) {
    const items = [];
    const route = buildTravelRouteLabel(readiness, lang);
    if (route) items.push(route);
    const delta = pickPlainObject(readiness.delta_vs_origin || readiness.delta_vs_home);
    const tags = asStringArray(delta.summary_tags, 3);
    if (tags.length) {
      items.push(lang === 'CN' ? `环境变化：${tags.join(' / ')}。` : `Environment shifts: ${tags.join(' / ')}.`);
    }
    const confidence = pickPlainObject(readiness.confidence);
    const missingInputs = asStringArray(confidence.missing_inputs, 3);
    if (missingInputs.includes('recent_logs')) {
      items.push(
        lang === 'CN'
          ? '暂无近期皮肤记录，因此节奏保持保守。'
          : 'No recent skin logs, so the plan stays conservative.',
      );
    }
    const shopping = pickPlainObject(readiness.shopping_preview);
    const coverage = asString(shopping.coverage_status);
    if (coverage === 'category_only') {
      items.push(
        lang === 'CN'
          ? '商品区当前是品类准备清单，不伪装成具体商品推荐。'
          : 'Shopping guidance is category-only until catalog products are grounded.',
      );
    }
    return items.slice(0, 5);
  }
  const notes = asStringArray(payload.notes || payload.summary_tags || payload.actions, 5)
    .map((line) => formatTravelReminderNote(line, lang))
    .filter(Boolean);
  return notes.length
    ? notes
    : [lang === 'CN' ? '优先保湿和防晒。' : 'Prioritize hydration and SPF.'];
}

function inferRoutineCategory(raw) {
  const token = asString(raw).toLowerCase();
  if (!token) return 'treatment';
  if (token.includes('cleanser') || token.includes('洁面')) return 'cleanser';
  if (token.includes('spf') || token.includes('sunscreen') || token.includes('防晒')) return 'sunscreen';
  if (
    token.includes('moistur') ||
    token.includes('cream') ||
    token.includes('lotion') ||
    token.includes('保湿') ||
    token.includes('乳液') ||
    token.includes('面霜')
  ) {
    return 'moisturizer';
  }
  if (token.includes('treatment') || token.includes('serum') || token.includes('active') || token.includes('精华')) {
    return 'treatment';
  }
  return 'treatment';
}

function normalizeRef(value) {
  const row = isPlainObject(value) ? value : {};
  const productId = asString(row.product_id || row.productId);
  const merchantId = asString(row.merchant_id || row.merchantId);
  if (!productId && !merchantId) return null;
  return {
    ...(productId ? { product_id: productId } : {}),
    ...(merchantId ? { merchant_id: merchantId } : {}),
  };
}

function normalizeStringList(value, max = 6) {
  const out = [];
  const seen = new Set();
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  for (const item of source) {
    let text = '';
    if (typeof item === 'string') {
      text = asString(item);
    } else if (isPlainObject(item)) {
      text =
        asString(item.label) ||
        asString(item.name) ||
        asString(item.title) ||
        asString(item.value) ||
        asString(item.tag);
    }
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function neutralizeVisibleRecommendationCardCopy(value) {
  let text = asString(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text
    .replace(/^Best\s+for\b\s*[:：-]?\s*/i, 'Suited for ')
    .replace(/^Best\s+as\s+your\s+(.+?)\s+step\b\.?$/i, 'Works as your $1 step')
    .replace(/^Best\s+as\s+(.+)$/i, 'Works as $1')
    .replace(/\bbest\s+first\s+buy\b/gi, 'starting option')
    .replace(/\bbest\s+available\b/gi, 'available match')
    .replace(/\bbest\s+match\b/gi, 'close match')
    .replace(/\btop\s+pick\b/gi, 'selected option')
    .replace(/\btop\s+choice\b/gi, 'selected option')
    .replace(/\blead\s+pick\b/gi, 'current pick')
    .replace(/\bstrongest\s+(?:choice|option|pick)\b/gi, 'strong option')
    .replace(/\bmost\s+effective\b/gi, 'supportive')
    .replace(/\bmost\s+direct\s+fit\b/gi, 'direct fit')
    .replace(/\bmost\s+practical\s+pick\b/gi, 'practical option')
    .replace(/\bmost\s+(?:useful|relevant|important)\b/gi, (match) => match.replace(/\bmost\s+/i, ''))
    .replace(/\bclearest\s+match\b/gi, 'clear match')
    .replace(/\bcost-effective\b/gi, 'good-value')
    .replace(/\bexperience\s+superior\s+/gi, '')
    .replace(/\bsuperior\s+/gi, '')
    .replace(/\bhighly\s+effective\b/gi, 'supportive')
    .replace(/\beffectively\s+/gi, '')
    .replace(/\beffective\s+/gi, '')
    .replace(/\bstrongest\b/gi, 'strong')
    .replace(/\bideal\b/gi, 'useful')
    .replace(/\bmost\s+/gi, '')
    .replace(/\bbest\s+/gi, '')
    .replace(/\bbest\b/gi, 'suitable')
    .replace(/\bperfect\b/gi, 'good')
    .trim();
  return text;
}

function normalizePrice(value, fallbackCurrency = '') {
  if (isPlainObject(value)) {
    const amount = asNumber(value.amount);
    const currency = asString(value.currency) || fallbackCurrency || 'USD';
    const unknown = value.unknown === true || amount == null;
    if (unknown) {
      return { amount: null, currency, unknown: true };
    }
    return {
      amount,
      currency,
      unknown: false,
    };
  }
  const amount = asNumber(value);
  if (amount == null) return null;
  return {
    amount,
    currency: fallbackCurrency || 'USD',
    unknown: false,
  };
}

function formatPriceLabel(price) {
  if (!isPlainObject(price)) return '';
  if (price.unknown === true || price.amount == null) return 'Price unavailable';
  const amount = Number(price.amount);
  if (!Number.isFinite(amount)) return 'Price unavailable';
  const currency = asString(price.currency).toUpperCase();
  const symbol =
    currency === 'CNY' || currency === 'RMB'
      ? '¥'
      : currency === 'EUR'
        ? '€'
        : currency === 'GBP'
          ? '£'
          : '$';
  const rounded = Math.round(amount * 100) / 100;
  return `${symbol}${rounded}`;
}

function inferPriceTierFromAmount(amount) {
  if (!Number.isFinite(amount)) return 'mid';
  if (amount < 20) return 'budget';
  if (amount >= 45) return 'premium';
  return 'mid';
}

function normalizeSocialProof(raw) {
  const row = isPlainObject(raw) ? raw : {};
  const rating = asNumber(row.rating ?? row.rating_value ?? row.ratingValue);
  const reviewCount = asNumber(row.review_count ?? row.reviewCount ?? row.rating_count ?? row.ratingCount);
  const summary = asString(row.summary);
  if (rating == null && reviewCount == null && !summary) return null;
  return {
    ...(rating != null ? { rating } : {}),
    ...(reviewCount != null ? { review_count: reviewCount } : {}),
    ...(summary ? { summary } : {}),
  };
}

function humanizeRoleId(raw) {
  const token = asString(raw);
  if (!token) return '';
  return token
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildRecommendationComparisonMode({ row, defaultComparisonMode = '', peerCount = 0 }) {
  const explicit =
    asString(row.comparison_mode) ||
    asString(row.comparisonMode) ||
    asString((row.metadata || {}).comparison_mode) ||
    asString((row.metadata || {}).comparisonMode);
  if (explicit) return explicit;
  if (row.comparison_fill === true || asString(row.comparison_fill_reason)) return 'same_role_comparison';
  if (defaultComparisonMode) return defaultComparisonMode;
  if (peerCount > 1) return 'same_role_comparison';
  return 'routine_mix';
}

function normalizeRecommendationSemanticText(value) {
  return asString(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function recommendationNeedsFinishFitTradeoff({ matchedRoleId = '', matchedRoleLabel = '', comparisonMode = '', peerCount = 0 } = {}) {
  const roleText = `${asString(matchedRoleId).replace(/[_-]+/g, ' ')} ${asString(matchedRoleLabel).replace(/[_-]+/g, ' ')}`.trim().toLowerCase();
  if (!roleText) return false;
  const sunscreenRole = /\b(?:sunscreen|spf|uv)\b/.test(roleText);
  const finishFitRole = /\b(?:finish fit|under makeup|makeup|layer(?:ing)?|pilling|smooth finish)\b/.test(roleText);
  return sunscreenRole && (finishFitRole || comparisonMode === 'same_role_comparison' || peerCount > 1);
}

function looksLikeWeakRecommendationFinishFitCopy(value) {
  const text = normalizeRecommendationSemanticText(value);
  if (!text) return false;
  const weakSignal =
    /\b(?:uv filter cues?|modern organic uv filters?|mineral uv filters?|clear filter identity|reapplication expectations explicit|daily spf wear|daily sunscreen step|sun care use|daytime skin comfort)\b/.test(text);
  const strongSignal =
    /\b(?:under makeup|makeup|layer(?:ing)?|pilling|soft focus|soft-focus|blur|primer|weightless|sheer|fluid|watery|invisible|white cast|non greasy|non-greasy|fragrance-free|scentless|sensitive skin|cream format|cream texture|hydrating cream)\b/.test(text);
  return weakSignal && !strongSignal;
}

function looksLikeGenericRecommendationFinishFitCopy(value) {
  const text = normalizeRecommendationSemanticText(value);
  if (!text) return false;
  if (looksLikeWeakRecommendationFinishFitCopy(text)) return true;
  if (/\b(?:soft[-\s]?focus|blur(?:ring)?|primer[-\s]?like|under makeup|makeup|weightless|sheer|sensitive skin|creamier|more moisturizing)\b/.test(text)) {
    return false;
  }
  return /\b(?:lighter smoother daytime layering|lighter smoother layering|smoother daytime layering|daily spf cream with moisturizer style hydration cues|daily sunscreen built around|moisturizer style hydration cues|positioned for smoother daytime layering)\b/.test(text);
}

function looksLikeDescriptiveRecommendationFinishFitCopy(value) {
  const text = normalizeRecommendationSemanticText(value);
  if (!text) return false;
  if (looksLikeWeakRecommendationFinishFitCopy(text) || looksLikeGenericRecommendationFinishFitCopy(text)) return false;
  const hasExplicitTradeoff =
    /\b(?:instead of|rather than|while keeping|while staying|leans more|leans richer|leans lighter|more mineral|more moisturizing|richer cream|cream spf base|lighter smoother|sensitive-skin-oriented|white-cast risk)\b/.test(text)
    || /\b(?:it|this)\s+(?:keeps?|gives?|offers?|leans?|points?|works?|wears?|sits?|feels?|stays?)\b/.test(text);
  if (hasExplicitTradeoff) return false;
  const startsLikeDescriptor = /^(?:a|an|the)?\s*(?:sheer|weightless|scentless|mineral|hydrating|daily|soft[-\s]?focus|invisible|fragrance[-\s]?free|creamy|creamier|rich|richer|lightweight|airy)\b/.test(text);
  const hasFinishFitProductCue = /\b(?:sunscreen|spf|daily cream|cream spf|cream-spf|mineral sunscreen)\b/.test(text);
  return startsLikeDescriptor && hasFinishFitProductCue;
}

function collectRecommendationFinishFitSourceText(row) {
  const item = isPlainObject(row) ? row : {};
  return [
    item.short_description,
    item.shortDescription,
    item.why_this_one,
    item.whyThisOne,
    item.description,
    item.summary,
    item.subtitle,
    item.shopping_card && item.shopping_card.intro,
    item.search_card && item.search_card.intro_candidate,
    item.product_intel && item.product_intel.shopping_card && item.product_intel.shopping_card.intro,
    item.product_intel && item.product_intel.search_card && item.product_intel.search_card.intro_candidate,
    item.product_intel && item.product_intel.product_intel_core && item.product_intel.product_intel_core.what_it_is && item.product_intel.product_intel_core.what_it_is.body,
    item.pivota_insights && item.pivota_insights.what_it_is,
    ...(Array.isArray(item.key_features) ? item.key_features : []),
    ...(Array.isArray(item.keyFeatures) ? item.keyFeatures : []),
    ...(Array.isArray(item.compare_highlights) ? item.compare_highlights : []),
  ]
    .map((value) => asString(value))
    .filter(Boolean)
    .join(' ');
}

function buildRecommendationFinishFitSpecificWhy(row) {
  const texts = collectRecommendationFinishFitSourceText(row);
  if (!texts) return '';

  const hasSoftFocus = /\b(?:soft[-\s]?focus|blur(?:ring)?|primer[-\s]?like)\b/i.test(texts);
  const hasLayering = /\b(?:under makeup|makeup|layer(?:ing)?|non[-\s]?pilling|no pilling|pilling)\b/i.test(texts);
  const hasWeightless = /\b(?:weightless|lightweight|airy|fluid|watery|water[-\s]?fit|invisible|non[-\s]?greasy|sheer)\b/i.test(texts);
  const hasMineralCue = /\b(?:mineral|zinc oxide|titanium dioxide)\b/i.test(texts);
  const hasWhiteCastCue = /\b(?:no white cast|white cast[-\s]?free|lower white[-\s]?cast|invisible)\b/i.test(texts);
  const hasSensitiveCue = /\b(?:sensitive skin|scentless|fragrance[-\s]?free|bisabolol|ectoin)\b/i.test(texts);
  const hasCreamierCue = /\b(?:hydrating daily cream|hydrating cream|cream format|cream texture|moisturizer[-\s]?style hydration|moisturizer[-\s]?format|cream-spf|cream spf)\b/i.test(texts);

  if (hasCreamierCue) {
    return 'it gives a richer cream-SPF base when you want more cushioning under makeup, not just the lightest finish';
  }
  if (hasMineralCue && (hasSensitiveCue || hasWeightless || hasWhiteCastCue)) {
    return 'it gives a more mineral, sensitive-skin-oriented option while keeping the finish sheer and weightless';
  }
  if (hasSoftFocus || (hasLayering && hasWeightless)) {
    return 'it points to lighter, smoother daytime layering instead of a richer cream finish';
  }
  if (hasWeightless && hasSensitiveCue) {
    return 'it gives a more mineral, sensitive-skin-oriented option while keeping the finish sheer and weightless';
  }
  if (hasWhiteCastCue) {
    return 'it points to cleaner daytime wear with lower white-cast risk';
  }
  if (hasLayering) {
    return 'it is positioned for smoother daytime layering';
  }
  return '';
}

function buildRecommendationFinishFitSpecificShortDescription(row) {
  const texts = collectRecommendationFinishFitSourceText(row);
  if (!texts) return '';

  const hasSoftFocus = /\b(?:soft[-\s]?focus|blur(?:ring)?|primer[-\s]?like)\b/i.test(texts);
  const hasLayering = /\b(?:under makeup|makeup|layer(?:ing)?|non[-\s]?pilling|no pilling|pilling)\b/i.test(texts);
  const hasWeightless = /\b(?:weightless|lightweight|airy|fluid|watery|water[-\s]?fit|invisible|non[-\s]?greasy|sheer)\b/i.test(texts);
  const hasMineralCue = /\b(?:mineral|zinc oxide|titanium dioxide)\b/i.test(texts);
  const hasWhiteCastCue = /\b(?:no white cast|white cast[-\s]?free|lower white[-\s]?cast|invisible)\b/i.test(texts);
  const hasSensitiveCue = /\b(?:sensitive skin|scentless|fragrance[-\s]?free|bisabolol|ectoin)\b/i.test(texts);
  const hasCreamierCue = /\b(?:hydrating daily cream|hydrating cream|cream format|cream texture|moisturizer[-\s]?style hydration|moisturizer[-\s]?format|cream-spf|cream spf)\b/i.test(texts);

  if (hasCreamierCue) {
    return 'A richer cream-SPF base when you want more moisture under makeup.';
  }
  if (hasMineralCue && (hasSensitiveCue || hasWeightless || hasWhiteCastCue)) {
    return 'A sheer, weightless mineral sunscreen option for sensitive skin.';
  }
  if (hasSoftFocus || (hasLayering && hasWeightless)) {
    return 'A lighter, smoother sunscreen feel for daytime layering under makeup.';
  }
  if (hasWeightless && hasSensitiveCue) {
    return 'A lighter mineral sunscreen option that stays sheer and simple on sensitive skin.';
  }
  if (hasWhiteCastCue) {
    return 'A lighter sunscreen option with lower white-cast risk for daytime wear.';
  }
  if (hasLayering) {
    return 'A sunscreen option that sits more smoothly under makeup.';
  }
  return '';
}

const RECOMMENDATION_CARD_CONCERN_FAMILY_PATTERNS = Object.freeze([
  ['oil_control', /\b(oil|oily|oiliness|shine|sebum|greasy|mattif|zinc\s*pca|zinc|oil[-\s]?control)\b/i],
  ['tone_brightening', /\b(dull(?:ness)?|uneven\s+tone|dark\s+spots?|hyperpigmentation|post[-\s]?(?:acne|breakout)\s+marks?|brighten(?:ing)?|radiance|radiant|glow(?:ing)?|improv(?:e|es|ing)\s+(?:the\s+look\s+of\s+)?skin\s+tone|even(?:s|ing)?\s+skin\s+tone)\b/i],
  ['acne_pore', /\b(acne|breakouts?|blemish(?:es)?|clog(?:ged)?|pores?)\b/i],
  ['hydration_barrier', /\b(hydrat(?:e|ing|ion)?|moistur(?:e|ize|izer|izing)?|barrier|dry(?:ness)?|dehydrat(?:ed|ion)?|ceramides?|glycerin|hyaluronic)\b/i],
  ['sunscreen_uv', /\b(spf|sunscreen|sun\s*screen|uv|sun\s+protection|white\s+cast|broad\s+spectrum)\b/i],
  ['sensitivity_redness', /\b(redness|sensitive|sensitized|sooth(?:e|ing)?|calm(?:ing)?|irritat(?:e|ion)|stinging?)\b/i],
  ['aging_texture', /\b(wrinkles?|fine[-\s]?lines?|aging|anti[-\s]?aging|texture|roughness|retinol|retinoid)\b/i],
]);
const RECOMMENDATION_CARD_GENERIC_VISIBLE_INGREDIENT_RE =
  /^(?:water|aqua|glycerin|butylene glycol|propylene glycol|caprylic(?:\/capric)?|dimethicone|silica|parfum|fragrance|phenoxyethanol|carbomer|citric acid|sodium hydroxide)$/i;
const RECOMMENDATION_CARD_SHOPPER_EVIDENCE_LANGUAGE_RE =
  /\b(?:best for|helps?|targets?|supports?|protects?|hydrates?|soothes?|calms?|mattif(?:y|ies|ying)|controls?|reduces?|lightweight|non-comedogenic|white cast|uv protection|daily protection|oil-control|shine|sebum|redness|barrier|dark spots?|post-breakout|hyperpigmentation|tone|spf\s*\d+|pa\+|without|for)\b/i;

function looksLikeStandaloneRecommendationCardEvidenceFragment(value) {
  const text = asString(value).replace(/[.!?。！？]+$/g, '').trim();
  if (!text) return false;
  if (RECOMMENDATION_CARD_GENERIC_VISIBLE_INGREDIENT_RE.test(text)) return true;
  if (/^(?:lightweight|gentle|hydrating|soothing|calming|mattifying|oil-control|barrier|daily)?\s*(?:serum|cream|gel cream|moisturizer|moisturiser|sunscreen|spf|treatment|support)$/i.test(text)) {
    return true;
  }
  if (RECOMMENDATION_CARD_SHOPPER_EVIDENCE_LANGUAGE_RE.test(text)) return false;
  const wordCount = text.toLowerCase().split(/[^a-z0-9%+.-]+/i).filter(Boolean).length;
  return wordCount <= 3 && text.length <= 36;
}

function collectRecommendationCardConcernFamilies(value) {
  const text = String(value || '').trim();
  const families = new Set();
  if (!text) return families;
  for (const [family, pattern] of RECOMMENDATION_CARD_CONCERN_FAMILY_PATTERNS) {
    if (pattern.test(text)) families.add(family);
  }
  return families;
}

function scoreRecommendationCardCopyForTarget(value, { targetText = '', originalIndex = 0 } = {}) {
  const text = String(value || '').trim();
  if (!text) return Number.NEGATIVE_INFINITY;
  const targetFamilies = collectRecommendationCardConcernFamilies(targetText);
  const copyFamilies = collectRecommendationCardConcernFamilies(text);
  const postAcneMarkToneEvidence =
    targetFamilies.has('tone_brightening') &&
    /\bpost[-\s]?(?:acne|breakout)\s+marks?\b/i.test(text);
  let score = 100 - (Number.isFinite(Number(originalIndex)) ? Number(originalIndex) * 0.01 : 0);
  if (!targetFamilies.size || !copyFamilies.size) return score;
  for (const family of copyFamilies) {
    if (family === 'acne_pore' && postAcneMarkToneEvidence) {
      score += 12;
      continue;
    }
    score += targetFamilies.has(family) ? 24 : -34;
  }
  if (copyFamilies.has('tone_brightening') && !targetFamilies.has('tone_brightening')) score -= 28;
  return score;
}

function looksLikeRecommendationCardFitOnlyCopy(value) {
  return /^(?:best\s+for|suited\s+for|useful\s+for|good\s+for|works\s+as\s+your)\b/i.test(String(value || '').trim());
}

function pickTargetAlignedRecommendationCardCopy(values = [], { targetText = '' } = {}) {
  const candidates = normalizeStringList(values, 10)
    .filter((value) => !looksLikeStandaloneRecommendationCardEvidenceFragment(value));
  if (!candidates.length) return '';
  const firstCandidate = candidates[0] || '';
  const targetFamilies = collectRecommendationCardConcernFamilies(targetText);
  const firstFamilies = collectRecommendationCardConcernFamilies(firstCandidate);
  const firstSharesTargetFamily =
    !targetFamilies.size
      ? true
      : firstFamilies.size > 0 && Array.from(firstFamilies).some((family) => targetFamilies.has(family));
  const ranked = candidates
    .map((value, index) => ({
      value,
      score: scoreRecommendationCardCopyForTarget(value, { targetText, originalIndex: index }),
      originalIndex: index,
    }))
    .sort((left, right) => {
      const scoreDiff = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return candidates.indexOf(left.value) - candidates.indexOf(right.value);
    });
  const firstNarrative = ranked.find((item) => Number(item.originalIndex) === 0);
  const best = ranked[0];
  if (
    firstNarrative &&
    best &&
    firstSharesTargetFamily &&
    !looksLikeRecommendationCardFitOnlyCopy(firstCandidate) &&
    looksLikeRecommendationCardFitOnlyCopy(best.value)
  ) {
    return firstNarrative.value;
  }
  if (
    firstNarrative &&
    best &&
    String(firstNarrative.value || '').trim() &&
    Number(best.score || 0) - Number(firstNarrative.score || 0) <= 16
  ) {
    return firstNarrative.value;
  }
  return best?.value || candidates[0] || '';
}

function flattenRecommendationProductSource(raw) {
  const row = isPlainObject(raw) ? raw : {};
  const sku = isPlainObject(row.sku) ? row.sku : {};
  const product = isPlainObject(row.product) ? row.product : {};
  const socialProof =
    normalizeSocialProof(row.social_proof) ||
    normalizeSocialProof(product.social_proof) ||
    normalizeSocialProof({
      rating: row.rating_value || product.rating_value,
      review_count: row.rating_count || product.rating_count,
    });
  const canonicalProductRef =
    normalizeRef(row.canonical_product_ref) ||
    normalizeRef(row.canonicalProductRef) ||
    normalizeRef(product.canonical_product_ref) ||
    normalizeRef(product.canonicalProductRef);
  const directProductRef =
    normalizeRef(row.product_ref) ||
    normalizeRef(row.productRef) ||
    normalizeRef(sku.product_ref) ||
    normalizeRef(sku.productRef);
  const subject = isPlainObject(row.subject) ? row.subject : {};
  const pdpOpen = isPlainObject(row.pdp_open)
    ? row.pdp_open
    : isPlainObject(row.pdpOpen)
      ? row.pdpOpen
      : {};
  const productGroupId =
    asString(subject.product_group_id) ||
    asString(subject.productGroupId) ||
    asString(row.product_group_id) ||
    asString(row.productGroupId) ||
    asString(sku.product_group_id) ||
    asString(sku.productGroupId) ||
    '';
  return {
    row,
    sku,
    product,
    socialProof,
    canonicalProductRef,
    directProductRef,
    productGroupId,
    pdpOpen,
  };
}

function recommendationProductIdentityKey(raw) {
  const keys = recommendationProductIdentityKeys(raw);
  return keys.length ? keys[0] : '';
}

function recommendationProductIdentityKeys(raw) {
  const { row, sku, product, canonicalProductRef, directProductRef } = flattenRecommendationProductSource(raw);
  const productId =
    asString(row.product_id) ||
    asString(row.productId) ||
    asString(product.product_id) ||
    asString(product.productId) ||
    asString(sku.product_id) ||
    asString(sku.productId) ||
    asString(canonicalProductRef && canonicalProductRef.product_id) ||
    asString(directProductRef && directProductRef.product_id);
  const merchantId =
    asString(row.merchant_id) ||
    asString(row.merchantId) ||
    asString(product.merchant_id) ||
    asString(product.merchantId) ||
    asString(sku.merchant_id) ||
    asString(sku.merchantId) ||
    asString(canonicalProductRef && canonicalProductRef.merchant_id) ||
    asString(directProductRef && directProductRef.merchant_id);
  const brand = asString(row.brand) || asString(product.brand) || asString(sku.brand);
  const name =
    asString(row.product_name) ||
    asString(row.productName) ||
    asString(row.name) ||
    asString(row.display_name) ||
    asString(row.displayName) ||
    asString(product.product_name) ||
    asString(product.productName) ||
    asString(product.name) ||
    asString(product.display_name) ||
    asString(product.displayName) ||
    asString(sku.product_name) ||
    asString(sku.productName) ||
    asString(sku.name) ||
    asString(sku.display_name) ||
    asString(sku.displayName);
  const label = [brand, name].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean).join('::');
  return [
    productId ? `id:${merchantId}:${productId}`.toLowerCase() : '',
    label ? `name:${label}` : '',
  ].filter(Boolean);
}

function recommendationProductsShareIdentity(left, right) {
  const leftKeys = new Set(recommendationProductIdentityKeys(left));
  if (!leftKeys.size) return false;
  return recommendationProductIdentityKeys(right).some((key) => leftKeys.has(key));
}

function buildRecommendationPeerCandidateIdentityText(raw) {
  const { row, sku, product } = flattenRecommendationProductSource(raw);
  return [
    row.display_name,
    row.displayName,
    row.name,
    row.title,
    row.product_name,
    row.productName,
    product.display_name,
    product.displayName,
    product.name,
    product.title,
    sku.display_name,
    sku.displayName,
    sku.name,
    sku.title,
    row.handle,
    row.slug,
    row.url,
    row.product_url,
    row.productUrl,
    row.canonical_pdp_url,
    row.canonicalPdpUrl,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
}

function isRecommendationSunscreenPeerCandidate(raw) {
  const identityText = buildRecommendationPeerCandidateIdentityText(raw);
  if (!identityText) return false;
  const hasSunscreenIdentity =
    /\b(?:spf\s*\d{1,3}\+?|sunscreen|sun\s*screen|broad\s+spectrum|uv[ab]?|pa\+{1,4})\b/i.test(identityText);
  if (!hasSunscreenIdentity) return false;
  return !/\b(?:targeted wrinkle corrector|wrinkle corrector|dark spot corrector|retinol|retinoid|booster|peel|mask)\b/i.test(identityText);
}

function isRecommendationVisiblePeerCandidateForRole(raw, { roleId = '', roleLabel = '' } = {}) {
  if (!isPlainObject(raw)) return false;
  const role = `${String(roleId || '')} ${String(roleLabel || '')}`.trim().toLowerCase();
  const explicitRole = asString(raw.matched_role_id || raw.matchedRoleId || raw.selected_target_id || raw.selectedTargetId || raw.role_scope);
  if (explicitRole && roleId && explicitRole !== roleId) return false;
  if (raw.framework_semantic_fit === false || raw.framework_role_semantic_fit === false) return false;
  const rejectReason = asString(raw.reason || raw.reject_reason || raw.rejectReason || raw.framework_reject_reason || raw.frameworkRejectReason).toLowerCase();
  if (/\b(?:hard_mismatch|hard_invalid|role_unmatched|primary_semantic_missing|wrong_scope|non_skincare|refill_only|unavailable|bundle)\b/.test(rejectReason)) {
    return false;
  }
  if (/\b(?:sunscreen|spf|sun|uv)\b/.test(role)) {
    return isRecommendationSunscreenPeerCandidate(raw);
  }
  return true;
}

function normalizeRecommendationProductCard(raw, options = {}) {
  const {
    defaultComparisonMode = '',
    peerCountByRoleId = new Map(),
    roleLabelById = new Map(),
    peerCandidatesByRoleId = new Map(),
  } = options;
  const {
    row,
    sku,
    product,
    socialProof,
    canonicalProductRef,
    directProductRef,
    productGroupId,
    pdpOpen,
  } = flattenRecommendationProductSource(raw);
  const name =
    asString(row.product_name) ||
    asString(row.name) ||
    asString(row.display_name) ||
    asString(row.displayName) ||
    asString(product.display_name) ||
    asString(product.displayName) ||
    asString(product.name) ||
    asString(product.title) ||
    asString(sku.display_name) ||
    asString(sku.displayName) ||
    asString(sku.name);
  const brand =
    asString(row.brand) ||
    asString(product.brand) ||
    asString(product.vendor) ||
    asString(sku.brand) ||
    asString(sku.Brand);
  if (!name && !brand) return null;

  const matchedRoleId =
    asString(row.matched_role_id) ||
    asString(row.matchedRoleId) ||
    asString(row.selected_target_id) ||
    asString(row.selectedTargetId) ||
    asString(row.role_scope) ||
    '';
  const peerCount = matchedRoleId ? Number(peerCountByRoleId.get(matchedRoleId) || 0) : 0;
  const price =
    normalizePrice(row.price, asString(row.currency || product.currency || sku.currency)) ||
    normalizePrice(product.price, asString(product.currency || row.currency)) ||
    normalizePrice(sku.price, asString(sku.currency || row.currency));
  const priceTierRaw = asString(row.price_tier) || asString(row.priceTier) || asString(row.item_type);
  const priceTier =
    ['budget', 'mid', 'premium'].includes(priceTierRaw)
      ? priceTierRaw
      : price && price.unknown !== true && Number.isFinite(Number(price.amount))
        ? inferPriceTierFromAmount(Number(price.amount))
        : 'mid';
  const bestFor = normalizeStringList(
    row.best_for || row.bestFor || row.best_for_tags || row.bestForTags || row.use_cases || row.useCases,
    4,
  ).map(neutralizeVisibleRecommendationCardCopy).filter(Boolean);
  const keyFeatures = normalizeStringList(
    row.key_features || row.keyFeatures || row.actives || row.key_ingredients || row.keyIngredients,
    6,
  ).map(neutralizeVisibleRecommendationCardCopy).filter(Boolean);
  const comparisonMode = buildRecommendationComparisonMode({
    row,
    defaultComparisonMode,
    peerCount,
  });
  const matchedRoleLabel =
    asString(row.matched_role_label) ||
    asString(row.matchedRoleLabel) ||
    asString(roleLabelById.get(matchedRoleId)) ||
    humanizeRoleId(matchedRoleId);
  const baseWhyThisOne = neutralizeVisibleRecommendationCardCopy(pickTargetAlignedRecommendationCardCopy(
    [
      row.why_this_one,
      row.whyThisOne,
      row.reason,
      ...bestFor,
      ...keyFeatures,
      row.short_description,
      row.shortDescription,
    ],
    {
      targetText: [
        matchedRoleId,
        matchedRoleLabel,
        ...keyFeatures,
        asString(row.category) || asString(row.step) || asString(row.routine_slot),
      ].join(' '),
    },
  ));
  const finishFitSpecificWhy = recommendationNeedsFinishFitTradeoff({
    matchedRoleId,
    matchedRoleLabel,
    comparisonMode,
    peerCount,
  })
    ? buildRecommendationFinishFitSpecificWhy(row)
    : '';
  const baseShortDescription = neutralizeVisibleRecommendationCardCopy(
    asString(row.short_description) || asString(row.shortDescription) || baseWhyThisOne,
  );
  const finishFitSpecificShortDescription = recommendationNeedsFinishFitTradeoff({
    matchedRoleId,
    matchedRoleLabel,
    comparisonMode,
    peerCount,
  })
    ? buildRecommendationFinishFitSpecificShortDescription(row)
    : '';
  const whyThisOne = finishFitSpecificWhy
    && (
      !baseWhyThisOne
      || looksLikeWeakRecommendationFinishFitCopy(baseWhyThisOne)
      || looksLikeGenericRecommendationFinishFitCopy(baseWhyThisOne)
      || looksLikeDescriptiveRecommendationFinishFitCopy(baseWhyThisOne)
    )
    ? finishFitSpecificWhy
    : baseWhyThisOne;
  const shortDescription = finishFitSpecificShortDescription
    && (
      !baseShortDescription
      || looksLikeWeakRecommendationFinishFitCopy(baseShortDescription)
      || looksLikeGenericRecommendationFinishFitCopy(baseShortDescription)
      || looksLikeDescriptiveRecommendationFinishFitCopy(baseShortDescription)
    )
    ? finishFitSpecificShortDescription
    : baseShortDescription;
  const selfKey = recommendationProductIdentityKey(row);
  const sameRoleCandidates = matchedRoleId
    ? asRecordArray(peerCandidatesByRoleId.get(matchedRoleId), 12).filter((candidate) => {
        const candidateKey = recommendationProductIdentityKey(candidate);
        return !selfKey || !candidateKey || !recommendationProductsShareIdentity(row, candidate);
      })
    : [];
  const normalized = {
    ...row,
    category:
      asString(row.category) ||
      asString(row.routine_slot) ||
      asString(row.step) ||
      inferRoutineCategory(name),
    step:
      asString(row.step) ||
      asString(row.category) ||
      asString(row.routine_slot) ||
      inferRoutineCategory(name),
    routine_slot:
      asString(row.routine_slot) ||
      asString(row.step) ||
      inferRoutineCategory(name),
    name,
    display_name: asString(row.display_name) || asString(row.displayName) || name,
    brand,
    best_for: bestFor,
    key_features: keyFeatures,
    price_tier: priceTier,
    why_this_one: whyThisOne,
    short_description: shortDescription,
    see_more: row.see_more !== false,
    ...(asString(row.image_url) || asString(product.image_url) || asString(sku.image_url)
      ? { image_url: asString(row.image_url) || asString(product.image_url) || asString(sku.image_url) }
      : {}),
    ...(price ? { price } : {}),
    ...(asString(row.price_label) ? { price_label: asString(row.price_label) } : {}),
    ...(!asString(row.price_label) && price ? { price_label: formatPriceLabel(price) } : {}),
    ...(asString(row.price_position) ? { price_position: asString(row.price_position) } : {}),
    ...(socialProof ? { social_proof: socialProof } : {}),
    ...(matchedRoleId ? { matched_role_id: matchedRoleId } : {}),
    ...(matchedRoleLabel ? { matched_role_label: matchedRoleLabel } : {}),
    ...(matchedRoleId ? { role_scope: matchedRoleId } : {}),
    ...(matchedRoleId ? { selected_target_id: matchedRoleId } : {}),
    ...(comparisonMode ? { comparison_mode: comparisonMode } : {}),
    ...(peerCount > 0 ? { same_role_peer_count: peerCount } : {}),
    ...(directProductRef ? { product_ref: directProductRef } : {}),
    ...(canonicalProductRef ? { canonical_product_ref: canonicalProductRef } : {}),
    ...(productGroupId ? { product_group_id: productGroupId } : {}),
    ...(Object.keys(pdpOpen).length > 0 ? { pdp_open: pdpOpen } : {}),
    ...(Array.isArray(row.alternatives) ? { alternatives: asRecordArray(row.alternatives, 9) } : {}),
    ...(sameRoleCandidates.length ? { product_candidates: sameRoleCandidates.slice(0, 8) } : {}),
    ...(sameRoleCandidates.length ? { alternative_candidates: sameRoleCandidates.slice(0, 8) } : {}),
    ...(sameRoleCandidates.length ? { same_role_candidate_count: sameRoleCandidates.length } : {}),
    alternatives_count: Array.isArray(row.alternatives) ? row.alternatives.length : Number(row.alternatives_count || row.alternativesCount || 0),
  };
  return normalized;
}

function buildRecommendationCardContext(payload, recommendations) {
  const roleLabelById = new Map();
  const recommendationMeta = isPlainObject(payload.recommendation_meta) ? payload.recommendation_meta : {};
  const roles = [
    ...(Array.isArray(payload.roles) ? payload.roles : []),
    ...(Array.isArray(payload.framework_summary && payload.framework_summary.prioritized_roles)
      ? payload.framework_summary.prioritized_roles
      : []),
    ...(Array.isArray(recommendationMeta.ranked_targets) ? recommendationMeta.ranked_targets : []),
  ];
  for (const rawRole of roles) {
    if (!isPlainObject(rawRole)) continue;
    const roleId = asString(rawRole.role_id || rawRole.roleId || rawRole.target_id || rawRole.targetId || rawRole.id);
    const label = asString(rawRole.label || rawRole.target_label || rawRole.targetLabel);
    if (!roleId || !label) continue;
    if (!roleLabelById.has(roleId)) roleLabelById.set(roleId, label);
  }

  const selectedTargetIds = Array.isArray(recommendationMeta.selected_target_ids)
    ? recommendationMeta.selected_target_ids.map((item) => asString(item)).filter(Boolean)
    : [];
  const uniqueSelectedTargetIds = Array.from(new Set(selectedTargetIds));
  const defaultComparisonMode =
    uniqueSelectedTargetIds.length > 1
      ? 'routine_mix'
      : recommendations.some((row) => row && (row.comparison_fill === true || asString(row.comparison_fill_reason)))
        ? 'same_role_comparison'
        : '';
  const peerCountByRoleId = new Map();
  const peerCandidatesByRoleId = new Map();
  for (const rawRole of roles) {
    if (!isPlainObject(rawRole)) continue;
    const roleId = asString(rawRole.role_id || rawRole.roleId || rawRole.target_id || rawRole.targetId || rawRole.id);
    if (!roleId || peerCandidatesByRoleId.has(roleId)) continue;
    const roleLabel = asString(rawRole.label || rawRole.target_label || rawRole.targetLabel);
    const candidates = asRecordArray(
      rawRole.product_candidates ||
        rawRole.productCandidates ||
        rawRole.candidates,
      16,
    ).filter((candidate) => isRecommendationVisiblePeerCandidateForRole(candidate, { roleId, roleLabel }));
    if (candidates.length) peerCandidatesByRoleId.set(roleId, candidates);
  }
  for (const raw of recommendations) {
    if (!isPlainObject(raw)) continue;
    const matchedRoleId =
      asString(raw.matched_role_id) ||
      asString(raw.matchedRoleId) ||
      asString(raw.selected_target_id) ||
      asString(raw.selectedTargetId) ||
      asString(raw.role_scope);
    if (!matchedRoleId) continue;
    peerCountByRoleId.set(matchedRoleId, Number(peerCountByRoleId.get(matchedRoleId) || 0) + 1);
  }
  return {
    defaultComparisonMode,
    peerCountByRoleId,
    roleLabelById,
    peerCandidatesByRoleId,
  };
}

function buildProductCardSections(products) {
  return [
    {
      kind: 'product_cards',
      products: products.slice(0, 8),
    },
  ];
}

function buildStructuredRoutineSteps(steps) {
  const list = asStringArray(steps, 8);
  return list.map((name) => ({
    category: inferRoutineCategory(name),
    product_name: name,
    product_brand: '',
    item_type: 'premium',
  }));
}

function buildProductVerdictCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const assessment = isPlainObject(payload.assessment) ? payload.assessment : {};
  const evidence = isPlainObject(payload.evidence) ? payload.evidence : {};
  const science = isPlainObject(evidence.science) ? evidence.science : {};
  const howToUse = isPlainObject(assessment.how_to_use)
    ? assessment.how_to_use
    : isPlainObject(assessment.howToUse)
      ? assessment.howToUse
      : {};
  const dupeRecommendation = isPlainObject(payload.dupe_recommendation)
    ? payload.dupe_recommendation
    : isPlainObject(payload.dupeRecommendation)
      ? payload.dupeRecommendation
      : {};
  const skinProfileMatch = isPlainObject(payload.skin_profile_match)
    ? payload.skin_profile_match
    : isPlainObject(payload.skinProfileMatch)
      ? payload.skinProfileMatch
      : {};
  const verdict = asString(assessment.verdict) || (language === 'CN' ? '谨慎' : 'Caution');
  const reasons = asStringArray(assessment.reasons || science.fit_notes, 4);
  const risks = asStringArray(science.risk_notes, 3);
  const productName =
    asString(assessment.product_name) ||
    asString(assessment.productName) ||
    asString(payload.product_name) ||
    asString(payload.productName) ||
    asString((payload.product || {}).name);
  const brand =
    asString(assessment.brand) ||
    asString(payload.brand) ||
    asString((payload.product || {}).brand);
  const matchScoreRaw =
    Number(assessment.match_score) ||
    Number(assessment.matchScore) ||
    Number(payload.match_score) ||
    Number(payload.matchScore);
  const matchScore = Number.isFinite(matchScoreRaw)
    ? Math.max(0, Math.min(100, Math.trunc(matchScoreRaw)))
    : null;
  const suitability = asString(assessment.suitability || payload.suitability).toLowerCase();
  const mechanisms = asStringArray(
    assessment.formula_intent ||
      assessment.formulaIntent ||
      science.mechanisms ||
      payload.mechanisms,
    8,
  );
  const beneficialIngredients = asStringArray(
    science.key_ingredients ||
      science.keyIngredients ||
      assessment.key_ingredients ||
      assessment.keyIngredients ||
      payload.key_ingredients,
    10,
  );
  const usageTiming = asString(howToUse.timing || howToUse.time);
  const usageNotes = asStringArray(
    [...asStringArray(howToUse.steps, 4), ...asStringArray(howToUse.notes, 4), ...asStringArray(assessment.summary, 2)],
    6,
  );
  const actions = [
    { type: 'compare_products', label: language === 'CN' ? '对比我在用的产品' : 'Compare with my routine' },
    { type: 'add_to_experiment', label: language === 'CN' ? '加入实验追踪' : 'Track as experiment' },
  ];
  return {
    id: normalizeCardId(card && card.card_id, 'product_verdict', requestId, index),
    type: 'product_verdict',
    priority: 1,
    title: language === 'CN' ? `结论：${verdict}` : `Verdict: ${verdict}`,
    tags: asStringArray(payload.tags || [], 4),
    sections: [
      { kind: 'bullets', title: language === 'CN' ? '为什么' : 'Why', items: reasons.length ? reasons : [language === 'CN' ? '基于当前信息做出保守判断。' : 'Conservative call based on available context.'] },
      ...(risks.length ? [{ kind: 'bullets', title: language === 'CN' ? '风险点' : 'Watchouts', items: risks }] : []),
      {
        kind: 'product_verdict_structured',
        verdict,
        ...(productName ? { product_name: productName } : {}),
        ...(brand ? { brand } : {}),
        ...(typeof matchScore === 'number' ? { match_score: matchScore } : {}),
        ...(suitability ? { suitability } : {}),
        mechanisms,
        beneficial_ingredients: beneficialIngredients,
        caution_ingredients: risks,
        usage: {
          ...(usageTiming ? { timing: usageTiming } : {}),
          notes: usageNotes,
        },
        dupe_recommendation: dupeRecommendation,
        skin_profile_match: skinProfileMatch,
      },
    ],
    actions,
  };
}

function buildCompatibilityCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const sourceType = asString(card && card.type).toLowerCase();
  const conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
  const conflictText = conflicts
    .map((row) => (isPlainObject(row) ? asString(row.message) : ''))
    .filter(Boolean)
    .slice(0, 4);
  const summary = asString(payload.summary);
  const routineSimulationPayload =
    sourceType === 'routine_simulation'
      ? payload
      : isPlainObject(payload.routine_simulation)
        ? payload.routine_simulation
        : {};
  const conflictHeatmapPayload =
    sourceType === 'conflict_heatmap'
      ? payload
      : isPlainObject(payload.conflict_heatmap)
        ? payload.conflict_heatmap
        : {};
  return {
    id: normalizeCardId(card && card.card_id, 'compatibility', requestId, index),
    type: 'compatibility',
    priority: 1,
    title: language === 'CN' ? '搭配建议：避免同晚高风险叠加' : 'Compatibility: avoid high-risk same-night stacking',
    tags: conflictText.length ? [language === 'CN' ? '冲突规避' : 'Conflict avoidance'] : [],
    sections: [
      ...(summary ? [{ kind: 'bullets', title: language === 'CN' ? '总结' : 'Summary', items: [summary] }] : []),
      ...(conflictText.length ? [{ kind: 'bullets', title: language === 'CN' ? '冲突点' : 'Conflicts', items: conflictText }] : []),
      {
        kind: 'compatibility_structured',
        source_card_type: sourceType || 'unknown',
        routine_simulation: routineSimulationPayload,
        conflict_heatmap: conflictHeatmapPayload,
      },
    ],
    actions: [{ type: 'save_schedule', label: language === 'CN' ? '保存到 routine' : 'Save schedule' }],
  };
}

function buildRoutineCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const analysis = isPlainObject(payload.analysis) ? payload.analysis : {};
  const expert = isPlainObject(analysis.routine_expert) ? analysis.routine_expert : {};
  const snapshot = isPlainObject(expert.snapshot) ? expert.snapshot : {};
  const amSteps = asStringArray(snapshot.am_steps, 6);
  const pmSteps = asStringArray(snapshot.pm_steps, 6);
  const observe = asStringArray(expert?.plan_7d?.observe_metrics, 4);
  const conflicts = asStringArray(payload.conflicts, 6);
  const structuredAmSteps = buildStructuredRoutineSteps(amSteps);
  const structuredPmSteps = buildStructuredRoutineSteps(pmSteps);
  return {
    id: normalizeCardId(card && card.card_id, 'routine', requestId, index),
    type: 'routine',
    priority: 1,
    title: language === 'CN' ? '你的 AM/PM Routine' : 'Your AM/PM routine',
    tags: [language === 'CN' ? '稳定优先' : 'Stability first'],
    sections: [
      ...(amSteps.length ? [{ kind: 'routine_list', title: 'AM', items: amSteps.map((name, step) => ({ step: step + 1, name })) }] : []),
      ...(pmSteps.length ? [{ kind: 'routine_list', title: 'PM', items: pmSteps.map((name, step) => ({ step: step + 1, name })) }] : []),
      ...(observe.length ? [{ kind: 'bullets', title: language === 'CN' ? '观察指标' : 'What to monitor', items: observe }] : []),
      {
        kind: 'routine_structured',
        am_steps: structuredAmSteps,
        pm_steps: structuredPmSteps,
        conflicts,
      },
    ],
    actions: [
      { type: 'save_routine', label: language === 'CN' ? '保存为我的 routine' : 'Save routine' },
      { type: 'switch_mode', label: language === 'CN' ? '切换到简化版' : 'Switch to simpler mode' },
    ],
  };
}

function buildTriageCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const details = asStringArray(payload.details, 5);
  const actions = asStringArray(payload.actions, 4);
  const redFlags = asStringArray(payload.red_flags || payload.redFlags, 6);
  const riskLevel = asString(payload.risk_level || payload.riskLevel || payload.severity).toLowerCase();
  const recoveryWindowRaw =
    Number(payload.recovery_window_hours) ||
    Number(payload.recoveryWindowHours) ||
    Number(payload.window_hours);
  const recoveryWindowHours = Number.isFinite(recoveryWindowRaw)
    ? Math.max(0, Math.trunc(recoveryWindowRaw))
    : 48;
  return {
    id: normalizeCardId(card && card.card_id, 'triage', requestId, index),
    type: 'triage',
    priority: 1,
    title:
      language === 'CN'
        ? '48小时应急：先停活性、稳住屏障'
        : '48-hour triage: pause strong actives and stabilize barrier',
    tags: [language === 'CN' ? '安全优先' : 'Safety first'],
    sections: [
      {
        kind: 'bullets',
        title: language === 'CN' ? '执行要点' : 'Action points',
        items: details.length ? details : [language === 'CN' ? '先执行保守策略并观察 48 小时。' : 'Use a conservative path and monitor for 48h.'],
      },
      ...(actions.length ? [{ kind: 'bullets', title: language === 'CN' ? '下一步' : 'Next step', items: actions }] : []),
      ...(redFlags.length ? [{ kind: 'bullets', title: language === 'CN' ? '红旗信号' : 'Red flags', items: redFlags }] : []),
      {
        kind: 'triage_structured',
        summary:
          (details && details[0]) ||
          (language === 'CN'
            ? '先停强活性，优先修护并观察变化。'
            : 'Pause strong actives first, prioritize barrier support and monitor changes.'),
        action_points: details,
        next_steps: actions,
        risk_level: riskLevel || 'medium',
        red_flags: redFlags,
        recovery_window_hours: recoveryWindowHours,
      },
    ],
    actions: [
      { type: 'log_symptom', label: language === 'CN' ? '记录症状' : 'Log symptom' },
      { type: 'add_to_experiment', label: language === 'CN' ? '创建恢复实验' : 'Create recovery experiment' },
    ],
  };
}

function buildSkinStatusCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const profile = isPlainObject(payload.profile) ? payload.profile : {};
  const features = Array.isArray(payload.features) ? payload.features : [];
  const observations = features
    .map((row) => (isPlainObject(row) ? asString(row.observation) : ''))
    .filter(Boolean)
    .slice(0, 4);
  const strategy = asString(payload.strategy);
  const skinType =
    asString(payload.skin_type) ||
    asString(payload.skinType) ||
    asString(profile.skinType);
  const barrierStatus =
    asString(payload.barrier_status) ||
    asString(payload.barrierStatus) ||
    asString(profile.barrierStatus);
  const concerns = asStringArray(payload.concerns || profile.concerns || profile.goals, 8);
  return {
    id: normalizeCardId(card && card.card_id, 'skin_status', requestId, index),
    type: 'skin_status',
    priority: 1,
    title: language === 'CN' ? '当前状态：屏障与炎症风险评估' : 'Current status: barrier and inflammation assessment',
    tags: [language === 'CN' ? '优先级判断' : 'Priority assessment'],
    sections: [
      ...(observations.length ? [{ kind: 'bullets', title: language === 'CN' ? '观察结论' : 'Observed signals', items: observations }] : []),
      ...(strategy ? [{ kind: 'bullets', title: language === 'CN' ? '策略' : 'Strategy', items: [strategy] }] : []),
      {
        kind: 'skin_status_structured',
        diagnosis: {
          ...(skinType ? { skin_type: skinType } : {}),
          ...(barrierStatus ? { barrier_status: barrierStatus } : {}),
          concerns,
        },
        observations,
        ...(strategy ? { strategy } : {}),
      },
    ],
    actions: [
      { type: 'confirm_profile', label: language === 'CN' ? '写入我的肤况档案' : 'Save to profile' },
      { type: 'open_question', label: language === 'CN' ? '继续细化建议' : 'Refine recommendation' },
    ],
  };
}

function buildEffectReviewCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const reasons = asStringArray(payload.reasons || payload.details, 4);
  const routineBridge = isPlainObject(payload.routine_bridge)
    ? payload.routine_bridge
    : isPlainObject(payload.routineBridge)
      ? payload.routineBridge
      : {};
  const targetState = asStringArray(payload.target_state || payload.targets, 4);
  const corePrinciples = asStringArray(payload.core_principles || payload.principles, 6);
  const timeline = asStringArray(
    (isPlainObject(payload.timeline) ? payload.timeline.first_4_weeks : payload.timeline) || payload.progress_notes,
    6,
  );
  const safetyNotes = asStringArray(payload.safety_notes || payload.watchouts, 5);
  return {
    id: normalizeCardId(card && card.card_id, 'effect_review', requestId, index),
    type: 'effect_review',
    priority: 2,
    title: language === 'CN' ? '效果复盘：先找变量，再调计划' : 'Effect review: isolate variables, then adjust',
    tags: [language === 'CN' ? '2/4/8周复盘' : '2/4/8 week review'],
    sections: [
      {
        kind: 'bullets',
        title: language === 'CN' ? '可能原因' : 'Possible causes',
        items: reasons.length ? reasons : [language === 'CN' ? '当前证据不足，建议固定执行并记录反馈。' : 'Evidence is limited; keep routine stable and log feedback.'],
      },
      {
        kind: 'effect_review_structured',
        priority_findings: reasons.map((line) => ({ title: line, detail: line })),
        target_state: targetState,
        core_principles: corePrinciples,
        timeline: {
          first_4_weeks: timeline,
          week_8_12_expectation: [],
        },
        safety_notes: safetyNotes,
        routine_bridge: routineBridge,
      },
    ],
    actions: [{ type: 'start_review', label: language === 'CN' ? '开始2周复盘' : 'Start 2-week review' }],
  };
}

function buildTravelCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const envPayload =
    isPlainObject(payload.env_payload) ? payload.env_payload : payload;
  const notes = buildTravelCardReminderItems({ payload, envPayload, language });
  const travelPlanner = buildTravelPlannerCardViewModel(envPayload, language);
  return {
    id: normalizeCardId(card && card.card_id, 'travel', requestId, index),
    type: 'travel',
    priority: 1,
    title: language === 'CN' ? '旅行护肤方案' : 'Travel skincare plan',
    tags: [language === 'CN' ? '场景策略' : 'Scenario strategy'],
    sections: [
      { kind: 'checklist', title: language === 'CN' ? '关键提醒' : 'Key reminders', items: notes.length ? notes : [language === 'CN' ? '优先保湿和防晒。' : 'Prioritize hydration and SPF.'] },
      {
        kind: 'travel_structured',
        env_payload: envPayload,
        ...(travelPlanner ? { travel_planner: travelPlanner } : {}),
      },
    ],
    actions: [{ type: 'generate_packing_list', label: language === 'CN' ? '查看完整装备清单' : 'View full travel kit' }],
  };
}

function buildErrorCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const errorCode = asString(payload.error || payload.code) || 'UNKNOWN';
  const detail = asString(payload.detail || payload.message);
  return {
    id: normalizeCardId(card && card.card_id, 'error', requestId, index),
    type: 'error',
    priority: 1,
    title: language === 'CN' ? '出了点问题' : 'Something went wrong',
    tags: [language === 'CN' ? '错误' : 'Error'],
    sections: [
      {
        kind: 'bullets',
        title: language === 'CN' ? '详情' : 'Details',
        items: [
          detail ||
            (language === 'CN'
              ? '请求未能完成，请稍后重试。'
              : 'The request could not be completed. Please try again shortly.'),
        ],
      },
    ],
    actions: [
      { type: 'retry', label: language === 'CN' ? '重试' : 'Retry' },
    ],
    payload: { error_code: errorCode },
  };
}

function buildNudgeCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const message = asString(payload.message || payload.summary || payload.note);
  const hints = asStringArray(payload.hints || payload.reasons || payload.details, 5);
  const cadenceDaysRaw =
    Number(payload.cadence_days) ||
    Number(payload.cadenceDays) ||
    Number(payload.checkin_days);
  const cadenceDays = Number.isFinite(cadenceDaysRaw)
    ? Math.max(0, Math.trunc(cadenceDaysRaw))
    : 0;
  return {
    id: normalizeCardId(card && card.card_id, 'nudge', requestId, index),
    type: 'nudge',
    priority: 3,
    title: language === 'CN' ? '可选加分项' : 'Optional nudge',
    tags: [language === 'CN' ? '可选' : 'Optional'],
    sections: [
      {
        kind: 'bullets',
        title: language === 'CN' ? '提示' : 'Tip',
        items: [message || (language === 'CN' ? '先把核心步骤做稳定，再加额外动作。' : 'Stabilize core routine first, then add extras.')],
      },
      ...(hints.length ? [{ kind: 'bullets', title: language === 'CN' ? '为什么有帮助' : 'Why this helps', items: hints }] : []),
      {
        kind: 'nudge_structured',
        message:
          message ||
          (language === 'CN'
            ? '先把核心步骤做稳定，再加额外动作。'
            : 'Stabilize core routine first, then add extras.'),
        hints,
        cadence_days: cadenceDays,
      },
    ],
    actions: [
      { type: 'dismiss', label: language === 'CN' ? '暂时不需要' : 'Dismiss' },
      { type: 'save_tip', label: language === 'CN' ? '加入提醒' : 'Save tip' },
    ],
  };
}

function normalizeLegacyActionRows(rawActions, language) {
  const rows = asRecordArray(rawActions, 6);
  return rows
    .map((row, idx) => {
      const actionType = asString(row.type) || asString(row.action_id) || asString(row.id) || `action_${idx + 1}`;
      const label = asString(row.label) || actionType || (language === 'CN' ? '继续' : 'Continue');
      if (!actionType || !label) return null;
      return {
        type: actionType.slice(0, 120),
        label: label.slice(0, 160),
        payload: row,
      };
    })
    .filter(Boolean);
}

function buildPassthroughCard({ card, requestId, index, language = 'EN', fallbackTitle = '' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const type = asString(card && card.type).toLowerCase();
  const title =
    asString(card && card.title) ||
    asString(payload.title) ||
    fallbackTitle ||
    (language === 'CN' ? '信息卡片' : 'Information card');
  const subtitle = asString(payload.subtitle) || undefined;
  const priorityRaw = Number(card && card.priority);
  const payloadPriorityRaw = Number(payload.priority);
  const priority = Number.isFinite(priorityRaw)
    ? Math.max(1, Math.min(3, Math.trunc(priorityRaw)))
    : Number.isFinite(payloadPriorityRaw)
      ? Math.max(1, Math.min(3, Math.trunc(payloadPriorityRaw)))
      : 2;
  const tags = asStringArray(payload.tags, 6);
  const sections = asRecordArray(payload.sections, 8);
  const actions = normalizeLegacyActionRows(payload.actions, language);
  return {
    id: normalizeCardId(card && card.card_id, type || 'card', requestId, index),
    type,
    priority,
    title,
    ...(subtitle ? { subtitle } : {}),
    tags,
    sections,
    actions,
    payload,
  };
}

function buildRecommendationsCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  const cardContext = buildRecommendationCardContext(payload, recommendations);
  const products = recommendations
    .map((row) => normalizeRecommendationProductCard(row, cardContext))
    .filter((product) => product && product.name);
  const sections = buildProductCardSections(products);
  const nextPayload = {
    ...payload,
    source_card_type: 'recommendations',
    products,
    sections,
  };

  return {
    id: normalizeCardId(card && card.card_id, 'recommendations', requestId, index),
    type: 'recommendations',
    priority: 1,
    title: language === 'CN' ? '产品推荐' : 'Product Recommendations',
    tags: [],
    sections,
    actions: [
      { type: 'see_more_alternatives', label: language === 'CN' ? '查看更多替代品' : 'See more alternatives' },
      { type: 'optimize_existing_products', label: language === 'CN' ? '优化现有产品' : 'Optimize my current products' },
    ],
    payload: nextPayload,
  };
}

function normalizeOffersResolvedProduct(raw) {
  const item = isPlainObject(raw) ? raw : {};
  const product = isPlainObject(item.product) ? item.product : {};
  const metadata = isPlainObject(item.metadata) ? item.metadata : {};
  const mapped = normalizeRecommendationProductCard({
    ...item,
    product_id: asString(product.product_id) || asString(item.product_id),
    merchant_id: asString(product.merchant_id) || asString(item.merchant_id),
    brand: asString(product.brand) || asString(product.vendor),
    name: asString(product.display_name) || asString(product.name) || asString(product.title),
    display_name: asString(product.display_name) || asString(product.name) || asString(product.title),
    category: asString(product.product_type) || asString(product.category),
    step: inferRoutineCategory(asString(product.product_type) || asString(product.category) || asString(product.display_name) || asString(product.name)),
    image_url: asString(product.image_url),
    product_ref: normalizeRef(item.product_ref),
    canonical_product_ref: normalizeRef(product.canonical_product_ref),
    pdp_open: isPlainObject(item.pdp_open) ? item.pdp_open : {},
    why_this_one:
      asString(metadata.pdp_open_path) === 'internal'
        ? 'Open product details'
        : 'Open merchant page',
    key_features: asStringArray(product.tags, 4),
    best_for: normalizeStringList([product.product_type, product.category], 2),
    price: normalizePrice(product.price, asString(product.currency)),
    social_proof: normalizeSocialProof(product.social_proof),
    role_scope: 'resolved_offer',
    selected_target_id: 'resolved_offer',
    comparison_mode: 'direct_offer_lookup',
  });
  if (!mapped) return null;
  return mapped;
}

function buildOffersResolvedCard({ card, requestId, index, language = 'EN' }) {
  const payload = isPlainObject(card && card.payload) ? card.payload : {};
  const items = asRecordArray(payload.items, 8);
  const products = items.map((item) => normalizeOffersResolvedProduct(item)).filter((item) => item && item.name);
  if (products.length === 0) return null;
  const sections = buildProductCardSections(products);

  return {
    id: normalizeCardId(card && card.card_id, 'offers_resolved', requestId, index),
    type: 'recommendations',
    priority: 1,
    title: language === 'CN' ? '找到的商品' : 'Items Found',
    tags: [],
    sections,
    actions: [],
    payload: {
      source_card_type: 'offers_resolved',
      items,
      products,
      sections,
      ...(asString(payload.market) ? { market: asString(payload.market) } : {}),
      ...(isPlainObject(payload.metadata) ? { metadata: payload.metadata } : {}),
    },
  };
}

function mapLegacyCardToSpecCards(card, { requestId, language = 'EN', index = 0 } = {}) {
  const type = asString(card && card.type).toLowerCase();
  if (!type) return [];

  if (type === 'product_parse') {
    return [];
  }
  if (type === 'product_analysis') {
    return [buildProductVerdictCard({ card, requestId, index, language })];
  }
  if (type === 'recommendations') {
    return [buildRecommendationsCard({ card, requestId, index, language })];
  }
  if (type === 'offers_resolved') {
    const offersCard = buildOffersResolvedCard({ card, requestId, index, language });
    return offersCard ? [offersCard] : [];
  }
  if (type === 'routine_simulation' || type === 'conflict_heatmap') {
    return [buildCompatibilityCard({ card, requestId, index, language })];
  }
  if (type === 'analysis_summary') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '肤况总结' : 'Skin summary' })];
  }
  if (type === 'confidence_notice') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '置信度提示' : 'Confidence notice' })];
  }
  if (type === 'product_parse') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '商品解析' : 'Product parse' })];
  }
  if (type === 'offers_resolved') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '购买信息' : 'Offers resolved' })];
  }
  if (type === 'env_stress' || type === 'travel') {
    return [buildTravelCard({ card, requestId, index, language })];
  }
  if (type === 'analysis_story_v2') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '分析解读' : 'Analysis story' })];
  }
  if (type === 'routine_products_preview') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '当前 routine 预览' : 'Current routine preview' })];
  }
  if (type === 'aurora_debug') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '调试信息' : 'Aurora debug' })];
  }
  if (type === 'aurora_alt_debug') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '调试补充信息' : 'Aurora alt debug' })];
  }
  if (type === 'routine_fit_summary') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? 'Routine 匹配度' : 'Routine fit' })];
  }
  if (type === 'routine_verdict_v1') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? 'Routine 总结结论' : 'Routine verdict' })];
  }
  if (type === 'routine_product_audit_v1') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '产品组合审计' : 'Routine product audit' })];
  }
  if (type === 'routine_user_fit_v1') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '用户适配度' : 'Routine user fit' })];
  }
  if (type === 'routine_adjustment_plan_v1') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '调整计划' : 'Routine adjustment plan' })];
  }
  if (type === 'routine_recommendation_v1') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '补充推荐' : 'Routine recommendations' })];
  }
  if (type === 'returning_triage') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '继续你的诊断' : 'Continue your diagnosis' })];
  }
  if (type === 'skin_progress') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '皮肤进展' : 'Skin progress' })];
  }
  if (type === 'ingredient_hub') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '成分查询入口' : 'Ingredient hub' })];
  }
  if (type === 'ingredient_goal_match') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '按功效找成分' : 'Ingredient goal match' })];
  }
  if (type === 'aurora_ingredient_report') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '成分报告' : 'Ingredient report' })];
  }
  if (type === 'diagnosis_gate') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '先做一个极简肤况确认' : 'Quick skin profile first' })];
  }
  if (type === 'budget_gate') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '预算确认' : 'Budget check' })];
  }
  if (type === 'gate_notice') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '门控提示' : 'Gate notice' })];
  }
  if (type === 'diagnosis_v2_login_prompt') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '登录后诊断更准确' : 'Log in for better diagnosis' })];
  }
  if (type === 'diagnosis_v2_intro') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '选择你的护肤目标' : 'Choose your skincare goals' })];
  }
  if (type === 'diagnosis_v2_photo_prompt') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '拍照提升准确度' : 'Photo for better accuracy' })];
  }
  if (type === 'diagnosis_v2_result') {
    return [buildPassthroughCard({ card, requestId, index, language, fallbackTitle: language === 'CN' ? '你的皮肤诊断报告' : 'Your skin diagnosis report' })];
  }
  if (type === 'ingredient_plan' || type === 'ingredient_plan_v2' || type === 'routine_prompt') {
    return [buildRoutineCard({ card, requestId, index, language })];
  }
  if (type === 'triage') return [buildTriageCard({ card, requestId, index, language })];
  if (type === 'skin_status') return [buildSkinStatusCard({ card, requestId, index, language })];
  if (type === 'effect_review') return [buildEffectReviewCard({ card, requestId, index, language })];
  if (type === 'error') return [buildErrorCard({ card, requestId, index, language })];
  return [buildNudgeCard({ card, requestId, index, language })];
}

function tokenOverlap(a, b) {
  const tokA = new Set(String(a || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean));
  const tokB = new Set(String(b || '').toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean));
  if (!tokA.size || !tokB.size) return 0;
  let overlap = 0;
  for (const t of tokA) { if (tokB.has(t)) overlap++; }
  return overlap / Math.min(tokA.size, tokB.size);
}

function dedupeStrings(items, threshold = 0.7) {
  const out = [];
  for (const item of items) {
    const text = String(item || '').trim();
    if (!text) continue;
    const truncated = /\w+-$/.test(text);
    const cleaned = truncated ? text.replace(/-$/, '') : text;
    if (out.some((existing) => tokenOverlap(existing, cleaned) >= threshold)) continue;
    out.push(cleaned);
  }
  return out;
}

function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const key = `${String(f.cue || '').toLowerCase()}:${String(f.where || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

const OUTPUT_CAPS = Object.freeze({
  findings: 5,
  guidance_brief: 3,
  am_steps: 5,
  pm_steps: 6,
  top_concerns: 3,
  features: 5,
  reasoning: 4,
});

function dedupeAndCapOutput(analysis) {
  const a = analysis && typeof analysis === 'object' ? analysis : null;
  if (!a) return analysis;

  const findings = dedupeFindings(Array.isArray(a.findings) ? a.findings : []).slice(0, OUTPUT_CAPS.findings);
  const guidanceBrief = dedupeStrings(Array.isArray(a.guidance_brief) ? a.guidance_brief : []).slice(0, OUTPUT_CAPS.guidance_brief);
  const features = Array.isArray(a.features)
    ? dedupeStrings(a.features.map((f) => f && typeof f === 'object' ? f.observation : '')).slice(0, OUTPUT_CAPS.features).map((obs) => ({ observation: obs, confidence: 'somewhat_sure' }))
    : a.features;
  const reasoning = Array.isArray(a.reasoning)
    ? dedupeStrings(a.reasoning).slice(0, OUTPUT_CAPS.reasoning)
    : a.reasoning;

  const expert = a.routine_expert && typeof a.routine_expert === 'object' ? { ...a.routine_expert } : a.routine_expert;
  if (expert && expert.snapshot && typeof expert.snapshot === 'object') {
    const snap = { ...expert.snapshot };
    if (Array.isArray(snap.am_steps)) snap.am_steps = snap.am_steps.slice(0, OUTPUT_CAPS.am_steps);
    if (Array.isArray(snap.pm_steps)) snap.pm_steps = snap.pm_steps.slice(0, OUTPUT_CAPS.pm_steps);
    expert.snapshot = snap;
  }

  return {
    ...a,
    findings,
    guidance_brief: guidanceBrief,
    features: Array.isArray(features) ? features : a.features,
    reasoning,
    routine_expert: expert,
  };
}

module.exports = {
  mapLegacyCardToSpecCards,
  dedupeAndCapOutput,
  OUTPUT_CAPS,
};
