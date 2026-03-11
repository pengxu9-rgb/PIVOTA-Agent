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
      /\b(sunscreen|sun screen|spf|sunblock)\b/i,
      /防晒/,
      /隔离防晒/,
    ],
  },
  {
    step: 'moisturizer',
    patterns: [
      /\b(moisturizer|moisturiser|cream|lotion|gel cream)\b/i,
      /面霜/,
      /乳液/,
      /保湿霜/,
      /保湿乳/,
    ],
  },
  {
    step: 'cleanser',
    patterns: [
      /\b(cleanser|face wash|facial wash|cleansing gel|cleansing foam)\b/i,
      /洁面/,
      /洗面奶/,
      /清洁/,
    ],
  },
  {
    step: 'serum',
    patterns: [
      /\b(serum|ampoule|booster serum)\b/i,
      /精华/,
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
      /\b(treatment|spot treatment|retinol|retinoid|acid treatment|bha|aha)\b/i,
      /功效/,
      /祛痘/,
      /刷酸/,
      /维A/,
    ],
  },
]);

function normalizeRecoTargetStep(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const aliasMap = {
    cleanser: 'cleanser',
    toner: 'toner',
    essence: 'essence',
    serum: 'serum',
    moisturizer: 'moisturizer',
    moisturiser: 'moisturizer',
    cream: 'moisturizer',
    lotion: 'moisturizer',
    sunscreen: 'sunscreen',
    spf: 'sunscreen',
    mask: 'mask',
    treatment: 'treatment',
    oil: 'oil',
  };
  return aliasMap[raw] || null;
}

function extractRecoTargetStepFromText(text) {
  const input = String(text || '').trim();
  if (!input) return null;

  for (const entry of STEP_PATTERNS) {
    for (const pattern of entry.patterns) {
      if (pattern.test(input)) {
        return entry.step;
      }
    }
  }

  return null;
}

module.exports = {
  normalizeRecoTargetStep,
  extractRecoTargetStepFromText,
};
