const UNKNOWN_VERTICAL = 'unknown';

const VERTICAL_KEYWORDS = {
  fragrance: [
    'fragrance',
    'perfume',
    'parfum',
    'eau de parfum',
    'eau de toilette',
    'cologne',
    'scent',
    '香水',
    '香氛',
    '香调',
  ],
  skincare: [
    'skincare',
    'serum',
    'essence',
    'moisturizer',
    'cleanser',
    'sunscreen',
    'spf',
    'toner',
    'face cream',
    '护肤',
    '面霜',
    '精华',
    '防晒',
    '洁面',
  ],
  makeup: [
    'makeup',
    'lipstick',
    'foundation',
    'concealer',
    'blush',
    'mascara',
    'eyeliner',
    'eyeshadow',
    'powder',
    '彩妆',
    '口红',
    '粉底',
    '遮瑕',
  ],
  tools: [
    'brush',
    'makeup brush',
    'blender',
    'applicator',
    'tool',
    'tools',
    'accessory',
    'kit',
    'set of brushes',
    '刷具',
    '化妆刷',
    '工具',
    '配件',
  ],
};

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsKeyword(haystack, keyword) {
  if (!haystack || !keyword) return false;
  const normalizedHaystack = normalizeText(haystack);
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedHaystack || !normalizedKeyword) return false;
  if (/[\u4e00-\u9fff]/.test(normalizedKeyword)) {
    return normalizedHaystack.includes(normalizedKeyword);
  }
  return ` ${normalizedHaystack} `.includes(` ${normalizedKeyword} `);
}

function getCategoryPathText(product) {
  const raw = product?.category_path || product?.categoryPath;
  if (Array.isArray(raw)) return raw.map((v) => String(v || '').trim()).filter(Boolean).join(' ');
  return '';
}

function buildProductSemanticText(product) {
  return [
    product?.title,
    product?.name,
    product?.description,
    product?.category,
    product?.product_type,
    product?.productType,
    product?.vendor,
    product?.brand?.name,
    product?.brand,
    getCategoryPathText(product),
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' ');
}

function inferVerticalFromProduct(product) {
  const text = buildProductSemanticText(product);
  const scores = {
    fragrance: 0,
    skincare: 0,
    makeup: 0,
    tools: 0,
  };
  const matches = {
    fragrance: [],
    skincare: [],
    makeup: [],
    tools: [],
  };

  for (const [vertical, keywords] of Object.entries(VERTICAL_KEYWORDS)) {
    for (const keyword of keywords) {
      if (!containsKeyword(text, keyword)) continue;
      scores[vertical] += 1;
      if (matches[vertical].length < 5) matches[vertical].push(keyword);
    }
  }

  const ordered = Object.entries(scores).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const priority = ['fragrance', 'skincare', 'makeup', 'tools'];
    return priority.indexOf(a[0]) - priority.indexOf(b[0]);
  });
  const [topVertical, topScore] = ordered[0] || [UNKNOWN_VERTICAL, 0];

  if (!topScore) {
    return {
      vertical: UNKNOWN_VERTICAL,
      inferred: true,
      score: 0,
      scores,
      matched_keywords: [],
    };
  }

  return {
    vertical: topVertical,
    inferred: true,
    score: topScore,
    scores,
    matched_keywords: matches[topVertical] || [],
  };
}

function computeSemanticSignalStrength({ brand, leafCategory, vertical }) {
  let strength = 0;
  if (String(brand || '').trim()) strength += 1;
  if (String(leafCategory || '').trim()) strength += 1;
  if (vertical && vertical !== UNKNOWN_VERTICAL) strength += 1;
  return strength;
}

module.exports = {
  UNKNOWN_VERTICAL,
  inferVerticalFromProduct,
  computeSemanticSignalStrength,
};
