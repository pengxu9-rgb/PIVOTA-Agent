const { TOY_KEYWORDS } = require('./intent');

const TAG_VERSION = 'ann_v1';
const TAG_SOURCE = 'rule_v1';

const TOY_STRONG_KEYWORDS = [
  'labubu',
  'pop mart',
  'blind box',
  'vinyl face doll',
  'doll clothes',
  'doll outfit',
  'for doll',
  'doll',
  'figure',
  'plush',
  'plushie',
  '盲盒',
  '公仔',
  '娃娃',
  '娃衣',
  '玩具',
];

const HUMAN_OUTERWEAR_KEYWORDS = [
  '外套',
  '大衣',
  '羽绒服',
  '冲锋衣',
  '风衣',
  '棉服',
  '夹克',
  '滑雪服',
  'coat',
  'jacket',
  'parka',
  'puffer',
  'down jacket',
  'outerwear',
  'shell',
  'windbreaker',
  'ski jacket',
];

const PET_APPAREL_KEYWORDS = [
  'dog',
  "dog's",
  'puppy',
  'cat',
  "cat's",
  'pet',
  'pets',
  'for dogs',
  'for cats',
  'pet jacket',
  'dog jacket',
  'dog coat',
  'dog sweater',
  'pet sweater',
  'harness',
  'leash',
  'raincoat',
  '宠物',
  '狗',
  '狗狗',
  '猫',
  '宠物衣服',
  '狗衣服',
  '狗外套',
  '狗雨衣',
];

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function buildProductText(product) {
  const title = product?.title || product?.name || '';
  const desc = product?.description || '';
  const attrs = safeStringify(product?.attributes);
  const options = safeStringify(product?.options || product?.product_options);
  const variants = safeStringify(product?.variants);
  return `${title}\n${desc}\n${attrs}\n${options}\n${variants}`.toLowerCase();
}

function includesAny(loweredText, keywords) {
  if (!loweredText) return false;
  return keywords.some((k) => loweredText.includes(String(k).toLowerCase()));
}

function inferPivotaTags(product) {
  const text = buildProductText(product);

  const isToyStrong =
    includesAny(text, TOY_STRONG_KEYWORDS) ||
    // some upstream data includes "compatible with ..." phrases
    /(?:compatible|for)\s+(?:labubu|doll|toy)/i.test(text);

  if (isToyStrong) {
    return {
      version: TAG_VERSION,
      domain: { value: 'toy_accessory', confidence: 0.96, source: TAG_SOURCE },
      target_object: { value: 'toy', confidence: 0.99, source: TAG_SOURCE },
      category_path: {
        value: ['toy_accessory', 'doll_clothing'],
        confidence: 0.85,
        source: TAG_SOURCE,
      },
    };
  }

  const isHumanOuterwear = includesAny(text, HUMAN_OUTERWEAR_KEYWORDS);
  if (isHumanOuterwear) {
    return {
      version: TAG_VERSION,
      domain: { value: 'human_apparel', confidence: 0.9, source: TAG_SOURCE },
      target_object: { value: 'human', confidence: 0.95, source: TAG_SOURCE },
      category_path: {
        value: ['human_apparel', 'outerwear'],
        confidence: 0.75,
        source: TAG_SOURCE,
      },
    };
  }

  const isPetApparel = includesAny(text, PET_APPAREL_KEYWORDS);
  if (isPetApparel) {
    return {
      version: TAG_VERSION,
      domain: { value: 'sports_outdoor', confidence: 0.7, source: TAG_SOURCE },
      target_object: { value: 'pet', confidence: 0.9, source: TAG_SOURCE },
      category_path: {
        value: ['pet_apparel'],
        confidence: 0.65,
        source: TAG_SOURCE,
      },
    };
  }

  // Unknown: keep minimal tag structure for observability
  return {
    version: TAG_VERSION,
    domain: { value: 'other', confidence: 0.4, source: TAG_SOURCE },
    target_object: { value: 'unknown', confidence: 0.4, source: TAG_SOURCE },
    category_path: { value: ['other'], confidence: 0.4, source: TAG_SOURCE },
  };
}

function ensureAttributesObject(product) {
  if (!product) return {};
  const attrs = product.attributes;
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) return attrs;
  if (attrs == null) return {};
  // Preserve non-object attributes in a nested field.
  return { pivota_original_attributes: attrs };
}

function injectPivotaAttributes(product) {
  if (!product || typeof product !== 'object') return product;

  const attributes = ensureAttributesObject(product);
  const existingPivota = attributes.pivota && typeof attributes.pivota === 'object' ? attributes.pivota : null;
  const inferred = inferPivotaTags(product);

  const mergedPivota = {
    ...inferred,
    ...(existingPivota || {}),
    // preserve inferred structure but allow upstream override if present
    version: existingPivota?.version || inferred.version,
    domain: existingPivota?.domain || inferred.domain,
    target_object: existingPivota?.target_object || inferred.target_object,
    category_path: existingPivota?.category_path || inferred.category_path,
  };

  return {
    ...product,
    attributes: {
      ...attributes,
      pivota: mergedPivota,
    },
  };
}

function isToyLikeText(text) {
  return includesAny(String(text || '').toLowerCase(), TOY_KEYWORDS);
}

module.exports = {
  injectPivotaAttributes,
  buildProductText,
  isToyLikeText,
};
