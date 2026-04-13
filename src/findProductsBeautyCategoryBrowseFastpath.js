function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBeautyCategoryBrowseFastpathQuery(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeQueryClass(value = '') {
  return String(value || '').trim().toLowerCase() || null;
}

const RAW_BEAUTY_CATEGORY_BROWSE_FASTPATHS = [
  {
    id: 'lip_balm',
    label: 'Lip Balm',
    bucket: 'lip_care',
    queryAliases: ['lip balm', 'lip balms', 'lip treatment', 'lip treatments'],
    productPattern: /\b(lip balm|lip treatment|lip mask|lip butter|lip conditioner)\b/i,
  },
  {
    id: 'lip_oil',
    label: 'Lip Oil',
    bucket: 'lip_care',
    queryAliases: ['lip oil', 'lip oils'],
    productPattern: /\b(lip oil|lip serum oil|lip gloss oil)\b/i,
  },
  {
    id: 'hair_oil',
    label: 'Hair Oil',
    bucket: 'haircare',
    queryAliases: ['hair oil', 'hair oils', 'scalp oil', 'scalp oils'],
    productPattern: /\b(hair oil|scalp oil|hair serum oil|hair treatment oil|hair elixir)\b/i,
  },
  {
    id: 'shampoo',
    label: 'Shampoo',
    bucket: 'haircare',
    queryAliases: ['shampoo', 'dry shampoo', 'clarifying shampoo'],
    productPattern: /\b(shampoo|dry shampoo|clarifying shampoo)\b/i,
  },
  {
    id: 'conditioner',
    label: 'Conditioner',
    bucket: 'haircare',
    queryAliases: [
      'conditioner',
      'conditioners',
      'leave in conditioner',
      'leave-in conditioner',
      'deep conditioner',
    ],
    productPattern: /\b(conditioner|leave in conditioner|leave-in conditioner|deep conditioner)\b/i,
  },
  {
    id: 'hair_mask',
    label: 'Hair Mask',
    bucket: 'haircare',
    queryAliases: ['hair mask', 'hair masks'],
    productPattern: /\b(hair mask|hair treatment mask|repair mask)\b/i,
  },
  {
    id: 'cleanser',
    label: 'Cleanser',
    bucket: 'skincare',
    queryAliases: [
      'cleanser',
      'cleansers',
      'face wash',
      'facial wash',
      'cleansing balm',
      'cleansing foam',
      'cleansing gel',
      'cleansing milk',
    ],
    productPattern: /\b(cleanser|face wash|facial wash|cleansing balm|cleansing foam|cleansing gel|cleansing milk)\b/i,
  },
  {
    id: 'toner',
    label: 'Toner',
    bucket: 'skincare',
    queryAliases: ['toner', 'toners', 'face mist', 'facial mist', 'toner pad', 'toner pads'],
    productPattern: /\b(toner|face mist|facial mist|toner pad|toner pads|essence toner)\b/i,
  },
  {
    id: 'serum',
    label: 'Serum',
    bucket: 'skincare',
    queryAliases: ['serum', 'serums', 'essence', 'essences', 'ampoule', 'ampoules'],
    productPattern: /\b(serum|essence|ampoule|concentrate)\b/i,
  },
  {
    id: 'moisturizer',
    label: 'Moisturizer',
    bucket: 'skincare',
    queryAliases: [
      'moisturizer',
      'moisturizers',
      'moisturiser',
      'moisturisers',
      'face cream',
      'gel cream',
    ],
    productPattern: /\b(moisturizer|moisturiser|face cream|gel cream|gel-cream|barrier cream|water cream|moisture cream)\b/i,
  },
  {
    id: 'sunscreen',
    label: 'Sunscreen',
    bucket: 'skincare',
    queryAliases: ['sunscreen', 'sunblock', 'spf'],
    productPattern: /\b(sunscreen|sunblock|spf\b|sun fluid|sun cream)\b/i,
  },
  {
    id: 'body_wash',
    label: 'Body Wash',
    bucket: 'bodycare',
    queryAliases: ['body wash', 'body cleanser', 'shower gel'],
    productPattern: /\b(body wash|body cleanser|shower gel|bath gel)\b/i,
  },
];

const BEAUTY_CATEGORY_BROWSE_FASTPATHS = RAW_BEAUTY_CATEGORY_BROWSE_FASTPATHS.map((entry) => {
  const queryAliases = Array.from(
    new Set(
      (Array.isArray(entry.queryAliases) ? entry.queryAliases : [])
        .map((alias) => normalizeBeautyCategoryBrowseFastpathQuery(alias))
        .filter(Boolean),
    ),
  );
  const titlePattern = queryAliases.length > 0
    ? new RegExp(
        `\\b(?:${queryAliases
          .slice()
          .sort((a, b) => b.length - a.length)
          .map((alias) => escapeRegExp(alias))
          .join('|')})\\b`,
        'i',
      )
    : null;
  return Object.freeze({
    ...entry,
    queryAliases,
    titlePattern,
  });
});

const BEAUTY_CATEGORY_BROWSE_FASTPATH_BY_ALIAS = new Map();
for (const entry of BEAUTY_CATEGORY_BROWSE_FASTPATHS) {
  for (const alias of entry.queryAliases) {
    if (!BEAUTY_CATEGORY_BROWSE_FASTPATH_BY_ALIAS.has(alias)) {
      BEAUTY_CATEGORY_BROWSE_FASTPATH_BY_ALIAS.set(alias, entry);
    }
  }
}

function resolveBeautyCategoryBrowseFastpath(queryText = '', { queryClass = null } = {}) {
  const normalizedQueryClass = normalizeQueryClass(queryClass);
  if (
    normalizedQueryClass &&
    !['category', 'exploratory'].includes(normalizedQueryClass)
  ) {
    return null;
  }
  const normalizedQuery = normalizeBeautyCategoryBrowseFastpathQuery(queryText);
  if (!normalizedQuery) return null;
  return BEAUTY_CATEGORY_BROWSE_FASTPATH_BY_ALIAS.get(normalizedQuery) || null;
}

module.exports = {
  BEAUTY_CATEGORY_BROWSE_FASTPATHS,
  normalizeBeautyCategoryBrowseFastpathQuery,
  resolveBeautyCategoryBrowseFastpath,
};
