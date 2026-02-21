const INTENT_ENUM = Object.freeze({
  RECO_PRODUCTS: 'reco_products',
  ROUTINE: 'routine',
  EVALUATE_PRODUCT: 'evaluate_product',
  DUPE_COMPARE: 'dupe_compare',
  INGREDIENT_SCIENCE: 'ingredient_science',
  TRAVEL_PLANNING: 'travel_planning',
  WEATHER_ENV: 'weather_env',
  CONFLICT_CHECK: 'conflict_check',
  DIAGNOSIS_START: 'diagnosis_start',
  UNKNOWN: 'unknown',
});

const ACTION_MAP = Object.freeze({
  'chip.start.reco_products': INTENT_ENUM.RECO_PRODUCTS,
  'chip_get_recos': INTENT_ENUM.RECO_PRODUCTS,
  'chip.start.routine': INTENT_ENUM.ROUTINE,
  'chip.action.reco_routine': INTENT_ENUM.ROUTINE,
  'chip.action.analyze_product': INTENT_ENUM.EVALUATE_PRODUCT,
  'chip_action_analyze_product': INTENT_ENUM.EVALUATE_PRODUCT,
  'chip.fitcheck.send_link': INTENT_ENUM.EVALUATE_PRODUCT,
  'chip.fitcheck.send_product_name': INTENT_ENUM.EVALUATE_PRODUCT,
  'chip.action.dupe_compare': INTENT_ENUM.DUPE_COMPARE,
  'chip.start.dupes': INTENT_ENUM.DUPE_COMPARE,
  'chip.start.ingredients': INTENT_ENUM.INGREDIENT_SCIENCE,
  'chip_start_ingredients': INTENT_ENUM.INGREDIENT_SCIENCE,
  'chip.start.diagnosis': INTENT_ENUM.DIAGNOSIS_START,
});

const TRAVEL_CUE_RE =
  /(\b(travel|trip|itinerary|destination|flight|flying|hotel|packing|next\s+week|next\s+month|weekend)\b|出差|旅行|旅途|行程|目的地|航班|飞行|酒店|打包|下周|下个月|周末)/i;
const ANCHOR_LINK_CUE_RE =
  /(^\s*(send\s*(a)?\s*link|paste\s*(the)?\s*link|here('s| is)\s*(the)?\s*link|link)\s*$|发链接|贴链接|发送链接|这是链接|给你链接|粘贴链接)/i;

const KNOWN_OPTION_TEXT = [
  {
    re: /(recommend (a few )?products|give me products|产品推荐|推荐一些产品|给我推荐产品)/i,
    intent: INTENT_ENUM.RECO_PRODUCTS,
  },
  {
    re: /(build (an )?am\s*\/\s*pm routine|早晚护肤|护肤 routine|生成.*routine)/i,
    intent: INTENT_ENUM.ROUTINE,
  },
  {
    re: /(evaluate (a )?(specific )?product|assess (this )?product|analy[sz]e (this )?product|check (this )?product|评估.*产品|分析.*产品|测评.*产品)/i,
    intent: INTENT_ENUM.EVALUATE_PRODUCT,
  },
  {
    re: /(send\s*(a)?\s*link|paste\s*(the)?\s*link|here('s| is)\s*(the)?\s*link|发链接|贴链接|发送链接|这是链接|粘贴链接)/i,
    intent: INTENT_ENUM.EVALUATE_PRODUCT,
  },
  {
    re: /(dupe|alternatives?|平替|替代品|更便宜替代)/i,
    intent: INTENT_ENUM.DUPE_COMPARE,
  },
  {
    re: /(ingredient science|ask ingredient science|成分机理|成分科学|证据链|机制|机理)/i,
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
  },
  {
    re: /(\b(travel|trip|itinerary|destination)\b|出差|旅行|目的地|行程)/i,
    intent: INTENT_ENUM.TRAVEL_PLANNING,
  },
  {
    re: /(weather|humidity|uv|climate|temperature|天气|湿度|紫外线|气候|温度|风)/i,
    intent: INTENT_ENUM.WEATHER_ENV,
  },
  {
    re: /(conflict|compatible|pair|layer|mix|combine|冲突|兼容|叠加|一起用|同晚)/i,
    intent: INTENT_ENUM.CONFLICT_CHECK,
  },
];

const HEURISTICS = [
  {
    re: /(pregnan|lactat|breastfeed|怀孕|备孕|哺乳)/i,
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
  },
  {
    re: /(retinol|retinoid|tretinoin|adapalene|hydroquinone|isotretinoin|A醇|维A|阿达帕林|氢醌|异维A酸)/i,
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
  },
  {
    re: /(analy[sz]e ingredient|ingredient analysis|成分分析|watchouts?|benefits?|证据|机制|机理)/i,
    intent: INTENT_ENUM.INGREDIENT_SCIENCE,
  },
  {
    re: /(evaluate|evaluation|assess|assessment|analy[sz]e this product|check this product|评估|测评|评价|适合吗)/i,
    intent: INTENT_ENUM.EVALUATE_PRODUCT,
  },
  {
    re: /(is this .{0,40}(good|right|suitable).{0,12}for me|will this .{0,30}suit me|fit\s*check|这(个|款).{0,20}(产品|面霜|精华|乳液|防晒|爽肤水).{0,10}适合我吗)/i,
    intent: INTENT_ENUM.EVALUATE_PRODUCT,
  },
  {
    re: /(recommend|suggest|推荐|求推荐)/i,
    intent: INTENT_ENUM.RECO_PRODUCTS,
  },
  {
    re: /(routine|am\/?pm|早晚护肤|流程)/i,
    intent: INTENT_ENUM.ROUTINE,
  },
];

function normalizeActionId(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  return value;
}

function inferFromActionId(actionId) {
  const norm = normalizeActionId(actionId);
  if (!norm) return null;
  if (ACTION_MAP[norm]) return ACTION_MAP[norm];

  if (norm.includes('dupe')) return INTENT_ENUM.DUPE_COMPARE;
  if (norm.includes('routine')) return INTENT_ENUM.ROUTINE;
  if (norm.includes('ingredient') || norm.includes('science')) return INTENT_ENUM.INGREDIENT_SCIENCE;
  if (norm.includes('evaluate') || norm.includes('fit_check') || norm.includes('fit-check') || norm.includes('analyze_product')) {
    return INTENT_ENUM.EVALUATE_PRODUCT;
  }
  if (norm.includes('reco') || norm.includes('recommend')) return INTENT_ENUM.RECO_PRODUCTS;
  if (norm.includes('travel') || norm.includes('weather') || norm.includes('env')) return INTENT_ENUM.TRAVEL_PLANNING;
  if (norm.includes('conflict') || norm.includes('compat')) return INTENT_ENUM.CONFLICT_CHECK;
  if (norm.includes('diagnosis') || norm.includes('diag')) return INTENT_ENUM.DIAGNOSIS_START;
  return null;
}

function inferFromKnownText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  for (const rule of KNOWN_OPTION_TEXT) {
    if (rule.re.test(raw)) return rule.intent;
  }
  return null;
}

function inferFromRegex(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  for (const rule of HEURISTICS) {
    if (rule.re.test(raw)) return rule.intent;
  }
  return null;
}

function hasTravelCue(text) {
  return TRAVEL_CUE_RE.test(String(text || '').trim());
}

function hasAnchorLinkCue(text) {
  return ANCHOR_LINK_CUE_RE.test(String(text || '').trim());
}

function extractTravelEntities(message) {
  const text = String(message || '').trim();
  if (!text) return {};
  const entities = {};

  const dateMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b(?:\s*(?:to|-|~|—)\s*\b(20\d{2}-\d{2}-\d{2})\b)?/);
  if (dateMatch && dateMatch[1]) {
    entities.date_range = {
      start: dateMatch[1],
      end: dateMatch[2] || dateMatch[1],
    };
  }

  const destinationEn = text.match(/\b(?:to|in|at|destination)\s+([A-Za-z][A-Za-z\s\-]{1,40})/i);
  const destinationCn = text.match(/(?:去|到|目的地|在)\s*([\u4e00-\u9fffA-Za-z\-]{2,30})/);
  const destination = destinationCn?.[1] || destinationEn?.[1];
  if (destination) {
    entities.destination = String(destination).trim();
  }

  return entities;
}

function inferCanonicalIntent({ message, actionId, actionLabel } = {}) {
  const text = String(message || '').trim();
  const optionText = String(actionLabel || '').trim() || text;

  const fromAction = inferFromActionId(actionId);
  if (fromAction) {
    return {
      intent: fromAction,
      source: 'action_id',
      confidence: 0.98,
      entities: fromAction === INTENT_ENUM.TRAVEL_PLANNING || fromAction === INTENT_ENUM.WEATHER_ENV ? extractTravelEntities(text) : {},
    };
  }

  if (hasAnchorLinkCue(optionText)) {
    return {
      intent: INTENT_ENUM.EVALUATE_PRODUCT,
      source: 'known_option_text',
      confidence: 0.94,
      entities: { anchor_collect: 'link' },
    };
  }

  if (hasTravelCue(optionText)) {
    return {
      intent: INTENT_ENUM.TRAVEL_PLANNING,
      source: 'known_option_text',
      confidence: 0.93,
      entities: extractTravelEntities(text),
    };
  }

  const fromKnownText = inferFromKnownText(optionText);
  if (fromKnownText) {
    const intent = fromKnownText === INTENT_ENUM.WEATHER_ENV && hasTravelCue(text)
      ? INTENT_ENUM.TRAVEL_PLANNING
      : fromKnownText;
    return {
      intent,
      source: 'known_option_text',
      confidence: 0.92,
      entities: intent === INTENT_ENUM.TRAVEL_PLANNING || intent === INTENT_ENUM.WEATHER_ENV ? extractTravelEntities(text) : {},
    };
  }

  const fromRegex = inferFromRegex(text);
  if (fromRegex) {
    const intent = fromRegex === INTENT_ENUM.WEATHER_ENV && hasTravelCue(text)
      ? INTENT_ENUM.TRAVEL_PLANNING
      : fromRegex;
    return {
      intent,
      source: 'heuristic_regex',
      confidence: 0.8,
      entities: intent === INTENT_ENUM.TRAVEL_PLANNING || intent === INTENT_ENUM.WEATHER_ENV ? extractTravelEntities(text) : {},
    };
  }

  return {
    intent: INTENT_ENUM.UNKNOWN,
    source: 'none',
    confidence: 0,
    entities: {},
  };
}

module.exports = {
  INTENT_ENUM,
  inferCanonicalIntent,
  extractTravelEntities,
  __internal: {
    inferFromActionId,
    inferFromKnownText,
    inferFromRegex,
    hasTravelCue,
    hasAnchorLinkCue,
  },
};
