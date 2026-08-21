const RECOMMENDATION_STEP_RESOLUTION_RULES_V1 = 'recommendation_step_resolution_rules_v1';

const STEP_PATTERNS = Object.freeze([
  {
    step: 'mask',
    patterns: [
      /\b(sheet mask|sleeping mask|overnight mask|wash[- ]?off mask|clay mask|mud mask|facial mask|face mask)\b/i,
      /\bmask\b/i,
      /面膜/,
      /冻膜/,
      /泥膜/,
      /睡眠面膜/,
    ],
  },
  {
    step: 'sunscreen',
    patterns: [
      /\b(sunscreen|sun screen|spf|sunblock|sun fluid|sun lotion)\b/i,
      /防晒/,
      /隔离防晒/,
    ],
  },
  {
    step: 'moisturizer',
    patterns: [
      /\b(moisturizer|moisturiser|face cream|cream|lotion|gel cream|gel-cream|emulsion|water cream|day cream|night cream)\b/i,
      /面霜/,
      /乳液/,
      /保湿霜/,
      /保湿乳/,
      /日霜/,
      /晚霜/,
    ],
  },
  {
    step: 'cleanser',
    patterns: [
      /\b(cleanser|face wash|facial wash|cleansing gel|cleansing foam|cleansing milk)\b/i,
      /洁面/,
      /洗面奶/,
      /清洁/,
    ],
  },
  {
    step: 'serum',
    patterns: [
      /\b(serum|ampoule|booster serum|active serum)\b/i,
      /精华(?!水)/,
      /原液/,
      /安瓶/,
    ],
  },
  {
    step: 'toner',
    patterns: [
      /\b(toner|mist|skin toner)\b/i,
      /爽肤水/,
      /化妆水/,
      /喷雾/,
    ],
  },
  {
    step: 'essence',
    patterns: [
      /\b(essence|first essence)\b/i,
      /精粹/,
      /精华水/,
    ],
  },
  {
    step: 'oil',
    patterns: [
      /\b(face oil|facial oil|oil serum|skin oil)\b/i,
      /护肤油/,
      /面油/,
    ],
  },
  {
    step: 'treatment',
    patterns: [
      /\b(treatment|spot treatment|retinol|retinoid|acid treatment|bha|aha|blemish treatment|acne treatment|exfoliators?|exfoliants?|exfoliating treatment|liquid exfoliant|resurfacing treatment|face scrubs?|facial scrubs?|exfoliating scrubs?|sugar scrubs?|salt scrubs?|scrubs?|gommages?|face polish|facial polish)\b/i,
      /功效/,
      /磨砂膏/,
      /磨砂/,
      /祛痘/,
      /刷酸/,
      /维A/,
      /点涂/,
    ],
  },
]);

const MEDIUM_CONFIDENCE_HINTS = Object.freeze([
  {
    step: 'moisturizer',
    patterns: [
      /\b(barrier cream|barrier lotion|barrier moisturizer)\b/i,
      /\b(hydrating product|night product|night skincare|something for night)\b/i,
      /\b(repair cream|repair lotion)\b/i,
      /修护霜/,
      /修护乳/,
      /晚间护肤/,
      /夜间护肤/,
    ],
  },
  {
    step: 'treatment',
    patterns: [
      /\b(barrier support treatment|blemish care|spot care|retinoid product|retinol product|acid product)\b/i,
      /功效类/,
      /祛痘类/,
      /点涂类/,
    ],
  },
  {
    step: 'serum',
    patterns: [
      /\b(active serum|repair serum|hydrating serum)\b/i,
      /功能精华/,
      /修护精华/,
    ],
  },
]);

const CANONICAL_STEP_FAMILY_MAP = Object.freeze({
  cleanser: Object.freeze({
    same_family: ['cleanser'],
    adjacent_family: ['toner'],
  }),
  toner: Object.freeze({
    same_family: ['toner'],
    adjacent_family: ['essence', 'cleanser'],
  }),
  essence: Object.freeze({
    same_family: ['essence'],
    adjacent_family: ['toner', 'serum'],
  }),
  serum: Object.freeze({
    same_family: ['serum'],
    adjacent_family: ['essence', 'treatment', 'moisturizer'],
  }),
  moisturizer: Object.freeze({
    same_family: ['moisturizer'],
    adjacent_family: ['mask', 'oil', 'treatment', 'serum'],
  }),
  sunscreen: Object.freeze({
    same_family: ['sunscreen'],
    adjacent_family: ['moisturizer'],
  }),
  treatment: Object.freeze({
    same_family: ['treatment'],
    adjacent_family: ['serum', 'moisturizer', 'mask'],
  }),
  mask: Object.freeze({
    same_family: ['mask'],
    adjacent_family: ['moisturizer', 'treatment', 'oil'],
  }),
  oil: Object.freeze({
    same_family: ['oil'],
    adjacent_family: ['moisturizer', 'mask'],
  }),
});

const EXACT_ALIAS_MAP = Object.freeze({
  cleanser: 'cleanser',
  toner: 'toner',
  essence: 'essence',
  serum: 'serum',
  moisturizer: 'moisturizer',
  moisturiser: 'moisturizer',
  'face cream': 'moisturizer',
  cream: 'moisturizer',
  lotion: 'moisturizer',
  'gel cream': 'moisturizer',
  'gel-cream': 'moisturizer',
  emulsion: 'moisturizer',
  sunscreen: 'sunscreen',
  'sun screen': 'sunscreen',
  spf: 'sunscreen',
  sunblock: 'sunscreen',
  mask: 'mask',
  treatment: 'treatment',
  exfoliator: 'treatment',
  exfoliators: 'treatment',
  exfoliant: 'treatment',
  exfoliants: 'treatment',
  'liquid exfoliant': 'treatment',
  oil: 'oil',
  面霜: 'moisturizer',
  保湿霜: 'moisturizer',
  保湿乳: 'moisturizer',
  日霜: 'moisturizer',
  晚霜: 'moisturizer',
  洁面: 'cleanser',
  洗面奶: 'cleanser',
  爽肤水: 'toner',
  化妆水: 'toner',
  精华: 'serum',
  精华水: 'essence',
  防晒: 'sunscreen',
  面膜: 'mask',
  护肤油: 'oil',
  功效产品: 'treatment',
});

function normalizeText(value) {
  return String(value || '').trim();
}

function uniqStrings(items, max = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const value = normalizeText(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeRecoTargetStep(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return null;
  if (EXACT_ALIAS_MAP[raw]) return EXACT_ALIAS_MAP[raw];
  for (const entry of STEP_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(raw))) return entry.step;
  }
  return null;
}

// The SURFACE TOKEN a step pattern matched, normalized for use as a query.
//
// Resolution used to return only the family, discarding what the buyer actually wrote. That is why
// "a gentle exfoliant for sensitive skin under $40" could only ever be queried as "treatment" -- and
// the catalog's "treatment" vocabulary is full of HAIRCARE products ("Lador ACV Treatment",
// "Paul Mitchell Color Depositing Treatment"), so the pool conformed on price and not on meaning.
//
// Deliberately taken from the SAME regex pass that decided the family: a second scan with different
// rules could disagree with the family it is supposed to describe.
function normalizeMatchedStepToken(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 40);
}

function collectStepPatternMatchDetails(input, entries) {
  const text = normalizeText(input);
  if (!text) return [];
  const details = [];
  const seen = new Set();
  for (const entry of entries) {
    for (const pattern of entry.patterns) {
      // exec, not test: `test` throws the matched surface away, which is the whole defect.
      const match = pattern.exec(text);
      if (!match) continue;
      if (seen.has(entry.step)) break;
      seen.add(entry.step);
      details.push({ step: entry.step, token: normalizeMatchedStepToken(match[0]) });
      break;
    }
    if (details.length >= 8) break;
  }
  return details;
}

function collectHighConfidenceMatchDetails(input) {
  return collectStepPatternMatchDetails(input, STEP_PATTERNS);
}

function collectMediumConfidenceMatchDetails(input) {
  return collectStepPatternMatchDetails(input, MEDIUM_CONFIDENCE_HINTS);
}

function collectHighConfidenceMatches(input) {
  return uniqStrings(collectHighConfidenceMatchDetails(input).map((row) => row.step), 8);
}

function collectMediumConfidenceMatches(input) {
  return uniqStrings(collectMediumConfidenceMatchDetails(input).map((row) => row.step), 8);
}

function extractRecoTargetStepFromText(text) {
  const matches = collectHighConfidenceMatches(text);
  return matches.length === 1 ? matches[0] : null;
}

function getRecoTargetFamilyRelation(targetStep, candidateStep) {
  const target = normalizeRecoTargetStep(targetStep);
  const candidate = normalizeRecoTargetStep(candidateStep);
  if (!target || !candidate) return 'incompatible_family';
  if (target === candidate) return 'same_family';
  const family = CANONICAL_STEP_FAMILY_MAP[target];
  if (family && Array.isArray(family.same_family) && family.same_family.includes(candidate)) return 'same_family';
  if (family && Array.isArray(family.adjacent_family) && family.adjacent_family.includes(candidate)) return 'adjacent_family';
  return 'incompatible_family';
}

function resolveRecoTargetStepIntent({ explicitStep = '', focus = '', text = '' } = {}) {
  const explicit = normalizeRecoTargetStep(explicitStep);
  if (explicit) {
    return {
      resolved_target_step: explicit,
      resolved_target_step_confidence: 'high',
      resolved_target_step_source: 'explicit_target_step',
      // An EXPLICIT step is already a family, not something the buyer wrote. There is no surface
      // token to preserve, and inventing one from the family label would just re-emit the family.
      resolved_target_step_token: null,
      step_resolution_version: RECOMMENDATION_STEP_RESOLUTION_RULES_V1,
    };
  }

  const focusText = normalizeText(focus);
  const textBody = normalizeText(text);
  const resolveFromDetails = (details, confidence, source) => ({
    resolved_target_step: details[0].step,
    resolved_target_step_confidence: confidence,
    resolved_target_step_source: source,
    resolved_target_step_token: details[0].token || null,
    step_resolution_version: RECOMMENDATION_STEP_RESOLUTION_RULES_V1,
  });

  const focusHigh = collectHighConfidenceMatchDetails(focusText);
  if (focusHigh.length === 1) return resolveFromDetails(focusHigh, 'high', 'focus_alias');
  const textHigh = collectHighConfidenceMatchDetails(textBody);
  if (textHigh.length === 1) return resolveFromDetails(textHigh, 'high', 'message_alias');

  const focusMedium = collectMediumConfidenceMatchDetails(focusText);
  if (focusMedium.length === 1) return resolveFromDetails(focusMedium, 'medium', 'focus_concept');
  const textMedium = collectMediumConfidenceMatchDetails(textBody);
  if (textMedium.length === 1) return resolveFromDetails(textMedium, 'medium', 'message_concept');

  return {
    resolved_target_step: null,
    resolved_target_step_confidence: 'none',
    resolved_target_step_source: 'none',
    resolved_target_step_token: null,
    step_resolution_version: RECOMMENDATION_STEP_RESOLUTION_RULES_V1,
  };
}

module.exports = {
  RECOMMENDATION_STEP_RESOLUTION_RULES_V1,
  CANONICAL_STEP_FAMILY_MAP,
  normalizeRecoTargetStep,
  normalizeMatchedStepToken,
  collectHighConfidenceMatchDetails,
  extractRecoTargetStepFromText,
  getRecoTargetFamilyRelation,
  resolveRecoTargetStepIntent,
};
