const { TOY_KEYWORDS_STRONG, TOY_KEYWORDS_WEAK } = require('./intent');

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

const TOY_KEYWORDS = [...TOY_KEYWORDS_STRONG, ...TOY_KEYWORDS_WEAK];

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

const PET_ANIMAL_RE = /\b(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets)\b/i;
const PET_ANIMAL_ES_RE = /\b(perro|perros|perrita|cachorro|mascota|mascotas|gato|gatos)\b/i;
const PET_ANIMAL_FR_RE = /\b(chien|chiens|chienne|chiot|animal|animaux|chat|chats)\b/i;

const PET_APPAREL_GEAR_RE = /\b(jacket|coat|sweater|raincoat|overalls|hoodie|parka|shell|vest|boots|booties|harness|leash)\b/i;
const PET_APPAREL_GEAR_ES_RE = /\b(chaqueta|abrigo|su[eé]ter|impermeable|overol|arn[eé]s|correa)\b/i;
const PET_APPAREL_GEAR_FR_RE = /\b(veste|manteau|pull|imperm[eé]able|salopette|harnais|laisse)\b/i;

function hasPetAnimalSignal(text) {
  if (!text) return false;
  // Do not "short-circuit" to CJK-only checks: many Shopify products include CJK
  // option labels (e.g. 尺寸/颜色) even when the title/description is English.
  const cjkHit =
    /[\u4e00-\u9fff\u3040-\u30ff]/.test(text) &&
    ['宠物', '狗', '狗狗', '猫', '犬', 'ペット', '犬服', '猫服', '狗衣服', '宠物衣服'].some((k) =>
      text.includes(k)
    );
  const latinHit = PET_ANIMAL_RE.test(text) || PET_ANIMAL_ES_RE.test(text) || PET_ANIMAL_FR_RE.test(text);
  return cjkHit || latinHit;
}

function hasPetApparelOrGearSignal(text) {
  if (!text) return false;
  const cjkHit =
    /[\u4e00-\u9fff\u3040-\u30ff]/.test(text) &&
    ['衣服', '外套', '雨衣', '背带', '牵引', '项圈', '犬服', '猫服'].some((k) => text.includes(k));
  const latinHit =
    PET_APPAREL_GEAR_RE.test(text) || PET_APPAREL_GEAR_ES_RE.test(text) || PET_APPAREL_GEAR_FR_RE.test(text);
  return cjkHit || latinHit;
}

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

  // Pet apparel must take precedence over "human outerwear" keywords because
  // many pet items use terms like "jacket/coat" in their titles.
  // We intentionally require BOTH an animal signal and an apparel/gear signal.
  const isPetApparel = hasPetAnimalSignal(text) && hasPetApparelOrGearSignal(text);
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

  // If products_cache already stored older pivota tags from our own rule tagger,
  // they might be stale (e.g. pet jackets mis-tagged as human outerwear).
  // We treat tags as "ours" when:
  // - version matches TAG_VERSION, OR
  // - the tag object has source == TAG_SOURCE.
  // In those cases, prefer the freshly inferred tags.
  const existingVersion = String(existingPivota?.version || '').trim();
  const isOurExisting =
    existingVersion === TAG_VERSION ||
    String(existingPivota?.domain?.source || '').toLowerCase() === TAG_SOURCE ||
    String(existingPivota?.target_object?.source || '').toLowerCase() === TAG_SOURCE ||
    String(existingPivota?.category_path?.source || '').toLowerCase() === TAG_SOURCE;

  const pickField = (field) => {
    const existing = existingPivota?.[field];
    if (!existing) return inferred[field];
    const src = String(existing?.source || '').toLowerCase();
    if (isOurExisting || src === TAG_SOURCE) return inferred[field];
    return existing;
  };

  const mergedPivota = {
    ...(existingPivota || {}),
    ...inferred,
    version: isOurExisting ? inferred.version : (existingPivota?.version || inferred.version),
    domain: pickField('domain'),
    target_object: pickField('target_object'),
    category_path: pickField('category_path'),
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
