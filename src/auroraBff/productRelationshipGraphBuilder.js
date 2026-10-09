const { optionRole } = require('./relationshipPairPolicy');
const { compareProductIdentity, RELATIONS: IDENTITY } = require('./relationshipProductIdentity');
const { classifyComplementPair, routineRole } = require('./relationshipComplementPolicy');
const {
  DUPE_MIN_SCORE_TOTAL,
  coerceRelationshipEdge,
  validateRelationshipEdge,
  __internal: relationshipInternals,
} = require('./productRelationshipGraph');
const {
  familyIdentityKey,
  __internal: {
    createFamilyDedupeIndex,
    rememberFamilyDedupeKey,
    resolveFamilyDedupeKey,
  },
} = require('./productRelationshipGraphSources');
const {
  CANDIDATE_CLAIM_FIELDS,
  ANCHOR_CLAIM_FIELDS,
  hasSupportingSocialSource,
  neutralizeClaimValue,
  neutralizeSnapshotClaims,
} = require('./relationshipClaimPhrases');
const { readPriceWithCurrency, comparablePriceRatio } = require('./relationshipPriceCurrency');

// One candidate may serve at most this many anchors as a dupe / competitive_alternative in ONE
// BUILD. 2026-09-26 JP/AU dry run: ALBION Excia Replant Whitening Cream was the alternative for
// most cream anchors in its shard; nothing bounded a candidate's fan-in, so a single well-described
// SKU crowded every anchor's slot. The cap keeps a candidate's best-scoring anchors and rejects
// the rest with `candidate_fan_in_cap_per_build`.
//
// Scope: per build only. The routine job runs `--limit 200 --anchor-offset N` shards, labels
// upsert per (anchor, candidate) pair and nothing deletes stale edges, so across shards a hub can
// still serve 8 x shards anchors. A global cap needs a write-time count over the labels table;
// that is a follow-up for the owner, not something a dry-run builder can enforce.
const DEFAULT_MAX_ANCHORS_PER_CANDIDATE = 8;
const FAN_IN_CAPPED_RELATION_TYPES = new Set(['dupe', 'competitive_alternative']);

const CURATED_NEED_NODES = [
  {
    need_id: 'need:fragrance-free-barrier-repair',
    label: 'fragrance-free barrier repair',
    category_taxonomy: ['skincare', 'barrier repair', 'moisturizer'],
    evidence_grade_min: 'B',
    tags: ['fragrance-free', 'barrier', 'ceramide', 'sensitive skin'],
  },
  {
    need_id: 'need:budget-peptide-serum',
    label: 'budget peptide serum',
    category_taxonomy: ['skincare', 'serum', 'peptide'],
    evidence_grade_min: 'B',
    tags: ['peptide', 'budget', 'serum'],
  },
  {
    need_id: 'need:acne-prone-sensitive-skin',
    label: 'acne-prone sensitive skin',
    category_taxonomy: ['skincare', 'acne-prone', 'sensitive skin'],
    evidence_grade_min: 'B',
    tags: ['acne-prone', 'sensitive skin', 'low irritation'],
  },
  {
    need_id: 'need:pregnancy-safe-retinoid-alternative',
    label: 'pregnancy-safe retinoid alternative',
    category_taxonomy: ['skincare', 'retinoid alternative', 'pregnancy cautious'],
    evidence_grade_min: 'B',
    tags: ['retinoid alternative', 'bakuchiol', 'pregnancy cautious'],
  },
  {
    need_id: 'need:mineral-sensitive-sunscreen',
    label: 'mineral sunscreen for sensitive skin',
    category_taxonomy: ['skincare', 'sunscreen', 'sensitive skin'],
    evidence_grade_min: 'B',
    match_threshold: 0.18,
    tags: ['mineral sunscreen', 'zinc oxide', 'titanium dioxide', 'spf', 'sensitive skin'],
  },
  {
    need_id: 'need:hydrating-hyaluronic-serum',
    label: 'hydrating hyaluronic serum',
    category_taxonomy: ['skincare', 'serum', 'hydration'],
    evidence_grade_min: 'B',
    match_threshold: 0.18,
    tags: ['hyaluronic acid', 'hydrating', 'hydration', 'serum'],
  },
  {
    need_id: 'need:azelaic-acid-calming',
    label: 'azelaic acid calming treatment',
    category_taxonomy: ['skincare', 'calming', 'sensitive skin'],
    evidence_grade_min: 'B',
    match_threshold: 0.18,
    tags: ['azelaic acid', 'redness', 'calming', 'sensitive skin'],
  },
  {
    need_id: 'need:gentle-cream-cleanser',
    label: 'gentle cream cleanser',
    category_taxonomy: ['skincare', 'cleanser', 'sensitive skin'],
    evidence_grade_min: 'B',
    match_threshold: 0.18,
    tags: ['gentle cleanser', 'cream cleanser', 'sensitive skin'],
  },
  {
    need_id: 'need:ceramide-rich-moisturizer',
    label: 'ceramide-rich moisturizer',
    category_taxonomy: ['skincare', 'moisturizer', 'barrier repair'],
    evidence_grade_min: 'B',
    match_threshold: 0.18,
    tags: ['ceramide', 'barrier', 'repair', 'moisturizer'],
  },
  {
    need_id: 'need:sensitive-bha-exfoliant',
    label: 'sensitive-skin BHA exfoliant',
    category_taxonomy: ['skincare', 'exfoliant', 'acne-prone'],
    evidence_grade_min: 'B',
    match_threshold: 0.18,
    tags: ['bha', 'salicylic acid', 'exfoliant', 'sensitive skin'],
  },
  {
    need_id: 'need:lip-barrier-balm',
    label: 'lip barrier balm',
    category_taxonomy: ['lip care', 'barrier repair', 'balm'],
    evidence_grade_min: 'B',
    match_threshold: 0.18,
    tags: ['lip balm', 'barrier', 'repair', 'ceramide', 'hydrating'],
  },
  {
    need_id: 'need:tubing-mascara-sensitive-eyes',
    label: 'tubing mascara for sensitive eyes',
    category_taxonomy: ['makeup', 'mascara', 'sensitive eyes'],
    evidence_grade_min: 'B',
    match_threshold: 0.18,
    tags: ['tubing mascara', 'sensitive eyes', 'lash'],
  },
  {
    need_id: 'need:non-comedogenic-gel-moisturizer',
    label: 'non-comedogenic gel moisturizer',
    category_taxonomy: ['skincare', 'moisturizer', 'acne-prone'],
    evidence_grade_min: 'B',
    match_threshold: 0.18,
    tags: ['non-comedogenic', 'oil-free', 'gel moisturizer', 'acne-prone'],
  },
  {
    need_id: 'need:fragrance-free-body-lotion',
    label: 'fragrance-free body lotion',
    category_taxonomy: ['body care', 'body lotion', 'sensitive skin'],
    evidence_grade_min: 'B',
    match_threshold: 0.18,
    tags: ['fragrance-free', 'unscented', 'body lotion', 'sensitive skin'],
  },
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeLower(value, max = 512) {
  return normalizeString(value, max).toLowerCase();
}

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return toNumberOrNull(value.amount ?? value.value ?? value.price ?? value.min ?? value.sale_price);
  }
  const n = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeTokens(value) {
  const rawItems = Array.isArray(value) ? value : [value];
  const items = rawItems.flatMap((item) => String(item == null ? '' : item).split(/[>,/|;:_\s-]+/g));
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    const token = normalizeLower(raw, 80).replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

const GENERIC_USE_CASE_TOKENS = new Set([
  'a',
  'an',
  'and',
  'as',
  'beauty',
  'bundle',
  'care',
  'collection',
  'comparison',
  'creates',
  'description',
  'cosmetic',
  'cosmetics',
  'daily',
  'duo',
  'edition',
  'essential',
  'essentials',
  'for',
  'full',
  'gift',
  'identifies',
  'kit',
  'listed',
  'needed',
  'makeup',
  'official',
  'page',
  'product',
  'routine',
  'set',
  'shopper',
  'shoppers',
  'size',
  'skin',
  'skincare',
  'source',
  'that',
  'the',
  'this',
  'tool',
  'use',
  'with',
]);

const BROAD_CATEGORY_VALUES = new Set([
  'accessory',
  'beauty',
  'beauty accessory',
  'body care',
  'cosmetic',
  'cosmetics',
  'makeup',
  'makeup set',
  'set',
  'skin care',
  'skincare',
  'tool',
]);

const STRONG_USE_CASE_TOKENS = new Set([
  'acne',
  'balm',
  'barrier',
  'blush',
  'body',
  'brush',
  'cleanser',
  'cleansing',
  'complexion',
  'concealer',
  'conditioner',
  'cream',
  'deodorant',
  'exfoliant',
  'exfoliating',
  'eyeliner',
  'eyeshadow',
  'foundation',
  'fragrance',
  'gloss',
  'hair',
  'hydrating',
  'lash',
  'lip',
  'loofah',
  'mascara',
  'mirror',
  'moisturizer',
  'peptide',
  'powder',
  'retinoid',
  'serum',
  'shampoo',
  'sponge',
  'sunscreen',
  'tint',
  'toner',
]);

const TOOL_FORM_TOKENS = new Set([
  'applicator',
  'brush',
  'case',
  'headband',
  'loofah',
  'mirror',
  'pouch',
  'sponge',
]);

const TOPICAL_FORM_TOKENS = new Set([
  'balm',
  'cleanser',
  'cleansing',
  'conditioner',
  'cream',
  'deodorant',
  'foundation',
  'fragrance',
  'gel',
  'gloss',
  'lipstick',
  'lotion',
  'mascara',
  'parfum',
  'perfume',
  'serum',
  'shampoo',
  'spray',
  'tint',
  'toner',
  'wash',
]);

const EYE_AREA_TOKENS = new Set(['brow', 'eye', 'eyeliner', 'eyeshadow', 'lash', 'shadow']);

const FACE_BODY_AREA_TOKENS = new Set([
  'blush',
  'body',
  'cheek',
  'complexion',
  'concealer',
  'face',
  'foundation',
  'kabuki',
  'powder',
]);

const SET_MARKER_TOKENS = new Set([
  'bundle',
  'combo',
  'collection',
  'duo',
  'essentials',
  'faves',
  'kit',
  'set',
  'trio',
]);

const BROAD_LOOK_SET_TOKENS = new Set([
  'bof',
  'bronzy',
  'fall',
  'fam',
  'fashion',
  'faves',
  'glam',
  'globes',
  'glowy',
  'golden',
  'look',
  'natural',
  'paris',
  'week',
]);

const SET_COMPONENT_GROUPS = new Set([
  'body_care',
  'cheek_color',
  'cleanse',
  'complexion',
  'eye_makeup',
  'face_color',
  'fragrance',
  'hair_care',
  'lip_care',
  'lip_color',
  'tool',
]);

const COMPLEXION_JOB_TOKENS = {
  concealer: ['conceal', 'concealer'],
  foundation: ['foundation', 'skin tint', 'tint'],
  powder: ['powder', 'setting'],
  highlighter: ['highlighter', 'highlight', 'skinstick', 'shimmer'],
  blush: ['blush', 'cheek'],
};

const LIP_CARE_TOKENS = ['balm', 'butter', 'care', 'hydrating', 'hydration', 'mask', 'oil', 'strengthening', 'treatz'];
const LIP_COLOR_TOKENS = ['color', 'gloss', 'glossy', 'liner', 'lipstick', 'luminizer', 'matte', 'pout', 'shine', 'shiny', 'stain', 'tint'];
const EYE_OR_LASH_AREA_TOKENS = [
  'eye',
  'eyes',
  'eyelash',
  'eyelashes',
  'eyeliner',
  'eyeshadow',
  'lash',
  'lashes',
  'brow',
  'brows',
  'undereye',
  'under eye',
  'mascara',
];

const SKINCARE_JOB_TOKENS = {
  eye: ['eye', 'undereye'],
  face: ['face', 'facial'],
  cleanser: ['cleanser', 'cleansing'],
  moisturizer: ['cream', 'lotion', 'moisturiser', 'moisturizer'],
  serum: ['drops', 'serum'],
  toner: ['toner'],
  sunscreen: ['spf', 'sunscreen'],
  mask: ['mask'],
};

const SKIN_EFFECT_TOKENS = {
  acne_oil: ['acne', 'blemish', 'clear control', 'oil control', 'oily', 'pore', 'salicylic'],
  azelaic: ['azelaic'],
  barrier: ['barrier', 'ceramide', 'repair'],
  brightening: ['bright', 'brightening', 'glow', 'kojic', 'radiance', 'radiant'],
  calming: ['calm', 'calming', 'sensitive', 'soothing'],
  exfoliating: ['aha', 'bha', 'exfoliant', 'exfoliating', 'glycolic', 'lactic'],
  hydration: ['ha', 'hyaluronic', 'hydrate', 'hydrating', 'hydration', 'moisture'],
  peptide: ['peptide', 'peptides'],
  retinoid_alternative: ['bakuchiol', 'bio retinol', 'retinol', 'retinoid'],
};

const BODY_CARE_JOB_TOKENS = {
  body_cream: ['body butter', 'body cream', 'body lotion', 'body milk', 'cream', 'lotion', 'milk'],
  body_oil: ['body oil', 'dry oil', 'oil'],
  body_wash: ['body wash', 'cleanser', 'cleansing', 'shower', 'wash'],
  deodorant: ['deodorant'],
  sunscreen: ['spf', 'sunscreen'],
};

const HAIR_FORM_JOB_TOKENS = {
  shampoo: ['shampoo'],
  conditioner: ['conditioner'],
  rinse: ['acv', 'rinse', 'vinegar'],
  scalp_treatment: ['scalp', 'root'],
  styling: ['styling'],
};

const HAIR_EFFECT_TOKENS = {
  conditioning: ['conditioner', 'conditioning', 'detangle', 'detangling'],
  clarifying: ['clarifying', 'clear thinker'],
  density: ['density', 'growth', 'shedding', 'thinning'],
  hydrating: ['hydrate', 'hydrating', 'hydration', 'mekabu'],
  rinse: ['acv', 'ph', 'rinse', 'vinegar'],
  shine: ['glass', 'shine'],
  treated_hair: ['treated'],
};

const BRUSH_TARGET_TOKENS = {
  eye: ['eye', 'eyeshadow', 'shadow'],
  concealer: ['concealer'],
  foundation: ['foundation', 'kabuki'],
  blush: ['blush', 'cheek'],
  powder: ['powder'],
  highlighter: ['highlighter', 'highlight'],
  contour: ['contour', 'sculpt'],
};

// A brush code names its area where the title does not: Sigma "E50 Large Fluff" is an eye brush,
// "F42 Strobing Fan" a face brush. Only read when both sides are brushes.
function brushCodeArea(snapshot = {}) {
  const match = normalizeLower(snapshotNameText(snapshot), 240).match(/^\s*([ef])\d{2,3}\b/);
  return match ? (match[1] === 'e' ? 'eye' : 'face') : '';
}

// Brush targets, plus a strobing or fan brush named as one: a highlighter brush. The name only; a
// description's "fan favorite" is not a fan brush.
function brushTargets(snapshot = {}, tokens = rawProductTokens(snapshot)) {
  const targets = tokenGroups(tokens, BRUSH_TARGET_TOKENS);
  if (/\bstrobing\b|\bfan\s+brush\b/.test(normalizeLower(snapshotNameText(snapshot), 240).replace(/[\u2122\u00ae]/g, ''))) {
    targets.add('highlighter');
  }
  return targets;
}

// Accessories and spare parts are not the products they serve: a razor stand is not refill blades,
// hair clips are not a bath set, a satin scarf is not a curl routine. Read from the name head only:
// a shade tail after an em dash, an "+ / with / &" add-on and a "( ... )" or ", ..." pack note are
// removed ("Sunscreen + Collector's Case" is a sunscreen, "Body Wash (Case of 12)" a body wash). A
// stand is the head noun only ("Razor Stand", not "Stand Out Mascara"); clip-in hair is not a clip.
// A refill of a cosmetic is that cosmetic.
const ACCESSORY_KINDS = [
  ['blade', /\bblades?\b|\bcartridges?\b|\breplacement\s+heads?\b/],
  ['holder', /\b(?:holder|organi[sz]er|caddy|soap\s+dish)\b|\bstand$/],
  ['hair_accessory', /\bclips?\b(?![- ]?ins?\b)|\bscrunchies?\b|\bheadbands?\b|\bbonnets?\b|\bscarf\b|\bpillow\s?case\b|\bhair\s+ties?\b/],
  ['bag', /\b(?:bag|pouch)\b|\bcase\b(?!\s+of\b)/],
];

function accessoryKind(snapshot = {}) {
  const name = normalizeLower(snapshotNameText(snapshot), 512).replace(/[\u2122\u00ae]/g, '')
    .split(/\s+\u2014\s+|\s+(?:\+|with|&)\s+|\s*[(,]/)[0].trim();
  const hit = ACCESSORY_KINDS.find(([, pattern]) => pattern.test(name));
  return hit ? hit[0] : '';
}

// What a skincare treatment is FOR. Shelf tags and descriptions name every benefit; the product's own
// name names its job. Its lead is the claim words in the name head (before a "with / for / + / dash /
// comma / bracket" tail), else every claim in the name, together with the actives in the head, else
// its first active ("Alpha Arbutin 2% + HA" leads with arbutin, not the HA tail; "Hyalu-Cica" with both).
// Two treatments are one shopper job only when each one's lead is among the other's functions:
// Retinol vs Marine Hyaluronics, HA + B5 vs Alpha Arbutin + HA and a BHA liquid vs a moisture pad are
// different jobs; two salicylic serums, two azelaic serums, or a brightening toner vs a hyalu-cica
// brightening toner are one. Naming order is meaning: "Vitamin C + HA Serum" is a vitamin C serum.
const TREATMENT_CLAIM_FUNCTIONS = [
  [['acne', 'blemish', 'blemishes', 'breakout', 'breakouts', 'pore', 'pores', 'poreless', 'poremizing', 'whitehead',
    'whiteheads', 'blackhead', 'blackheads', 'sebum', 'oil control'], ['acne']],
  // A clear / clarifying pad or toner is an exfoliating blemish step (COSRX Clear Pad is a BHA pad).
  [['clear', 'clarifying'], ['acne', 'exfoliating']],
  [['hydrating', 'hydration', 'hydrate', 'moisture', 'moisturizing', 'moisturising', 'aqua'], ['hydration']],
  [['brightening', 'bright', 'glow', 'radiance', 'radiant', 'dark spot', 'dark spots', 'hyperpigmentation', 'dullness', 'illuminating'],
    ['brightening']],
  [['calming', 'soothing', 'relief', 'redness', 'sensitive'], ['calming']],
  [['barrier', 'repair', 'repairing', 'restore', 'restoring'], ['barrier']],
  // Night repair and recovery treatments are the anti-ageing night step (Advanced Night Repair,
  // Midnight Recovery, Age Recovery).
  [['night repair', 'recovery'], ['barrier', 'firming']],
  [['firming', 'lifting', 'wrinkle', 'wrinkles', 'anti wrinkle', 'anti aging', 'anti ageing', 'age defying', 'elasticity'], ['firming']],
  [['exfoliating', 'exfoliant', 'exfoliation', 'peel', 'peeling', 'resurfacing'], ['exfoliating']],
];
const TREATMENT_ACTIVE_FUNCTIONS = [
  [['retinol', 'retinal', 'retinoid', 'retinoids', 'bakuchiol'], ['retinoid', 'firming']],
  [['peptide', 'peptides', 'collagen', 'matrixyl', 'argireline'], ['peptide', 'firming']],
  [['salicylic', 'bha'], ['exfoliating', 'acne']],
  [['aha', 'pha', 'glycolic', 'lactic', 'mandelic', 'gluconolactone'], ['exfoliating']],
  [['azelaic'], ['azelaic', 'acne']],
  [['hyaluronic', 'hyaluronics', 'hyaluron', 'hyalu', 'ha', 'b5', 'panthenol'], ['hydration']],
  [['vitamin c', 'vita c', 'ascorbic', 'arbutin', 'tranexamic', 'kojic', 'glutathione'], ['brightening']],
  // Niacinamide is sold for tone and for pores.
  [['niacinamide'], ['niacinamide', 'brightening', 'acne']],
  [['centella', 'cica', 'teca', 'madecassoside', 'heartleaf'], ['calming']],
  [['ceramide', 'ceramides', 'pdrn'], ['barrier']],
  [['tea tree', 'zinc', 'succinic'], ['acne']],
];
// Skincare treatment forms. The weak forms also name makeup and nail products ("Liquid Blush",
// "Peel Off Polish", "Self-Tan Drops") and count only on a skincare shelf; makeup shelves say "face"
// too ("makeup/face/blush"), so face is not a skincare shelf word.
const TREATMENT_FORM_PATTERN = /\b(?:serum|essence|ampoule|toner|tonic|pads?|exfoliant)\b/;
const TREATMENT_WEAK_FORM_PATTERN = /\b(?:peel|solution|liquid|booster|concentrate|drops)\b/;
const TREATMENT_SKINCARE_SHELF = /\b(?:skin|skincare|serum|serums|toner|toners|treat|treatment|essence|ampoule)\b/;
// Products named with a strong treatment form that are not skincare treatments, each seen in served
// titles ("Sun Serum", "Serum Body Wash", "Lip Serum", "Serum Foundation", "Tinted Serum", "Lash and Brow
// Serum", "Ampoule Highlighter", "Essence Setting Powder", "Self-tanning Serum") or named the same way
// ("Primer Serum", "Nail Serum", "Self Tan Serum").
const TREATMENT_EXCLUDED_PATTERN = new RegExp(`\\b(?:${[
  'sun', 'spf', 'uv', 'sunscreen', 'body', 'cleanser', 'cleansing', 'wash', 'lip', 'foundation', 'concealer', 'cc', 'tinted',
  'primer', 'powder', 'highlighter', 'brow', 'lash', 'nail', 'tan', 'tanning',
].join('|')})\\b`);

const TREATMENT_NAME_TAIL = /\s+(?:with|for|featuring)\s+|\s*\+\s*|\s+[-\u2013\u2014]\s+|[,(:|]/;

function treatmentFunctionProfile(snapshot = {}) {
  // The bracketed brand prefix and a shade tail after an em dash ("Eyeliner \u2014 Bachelor Pad") are not the product.
  const raw = normalizeLower(snapshotNameText(snapshot), 512).replace(/^\s*\[[^\]]*\]\s*/, '').split(/\s+\u2014\s+/)[0];
  const spaced = (text) => ` ${normalizeTokens(text).join(' ')} `;
  const name = spaced(raw); const head = spaced(raw.split(TREATMENT_NAME_TAIL)[0]);
  const leaf = normalizeCategoryValue(leafCategoryValue(snapshot));
  const shelf = normalizeTokens([snapshot.category, ...(Array.isArray(snapshot.category_taxonomy) ? snapshot.category_taxonomy : [])]).join(' ');
  // A hair or scalp serum is out of scope; a squalane "for skin and hair" is still a skin treatment.
  const hairOnly = /\b(?:hair|scalp)\b/.test(name) && !/\b(?:skin|face|facial)\b/.test(name);
  const form = TREATMENT_FORM_PATTERN.test(name) || /^(?:serum|toner|essence|ampoule)s?$/.test(leaf) ||
    (TREATMENT_WEAK_FORM_PATTERN.test(name) && TREATMENT_SKINCARE_SHELF.test(` ${shelf} `));
  if (!form || TREATMENT_EXCLUDED_PATTERN.test(name) || hairOnly) return null;
  // An eye treatment names the eye area and not the face ("Face & Eye Serum" is a face serum); no
  // toner or pad is an eye treatment ("Bright Eyes Toner" is a line name).
  const eye = hasEyeOrLashArea({ name: snapshotNameText(snapshot) }) && !/\b(?:face|facial|toner|tonic|pads?)\b/.test(name);
  const ordered = (table, text = name) => table.flatMap(([words, groups]) => words.map((word) => [text.indexOf(` ${word} `), groups]))
    .filter(([at]) => at !== -1).sort((x, y) => x[0] - y[0]).map(([, groups]) => groups);
  const claims = ordered(TREATMENT_CLAIM_FUNCTIONS); const actives = ordered(TREATMENT_ACTIVE_FUNCTIONS);
  const headClaims = ordered(TREATMENT_CLAIM_FUNCTIONS, head); const headActives = ordered(TREATMENT_ACTIVE_FUNCTIONS, head);
  const leadClaims = (headClaims.length ? headClaims : claims).flat();
  const leadActives = headActives.length ? headActives.flat() : actives[0] || [];
  return { eye, lead: [...leadClaims, ...leadActives], functions: new Set([...claims, ...actives].flat()) };
}

function treatmentFunctionCompatibility(anchorSnapshot = {}, candidateSnapshot = {}) {
  const anchor = treatmentFunctionProfile(anchorSnapshot);
  const candidate = treatmentFunctionProfile(candidateSnapshot);
  if (!anchor || !candidate) return { compatible: true, reason: '' };
  // An eye serum is not a face serum, whatever both claim.
  if (anchor.eye !== candidate.eye) return { compatible: false, reason: 'treatment_area_mismatch', shared_groups: [] };
  // A name with no function word fails open.
  if (!anchor.functions.size || !candidate.functions.size) return { compatible: true, reason: '' };
  const leadIn = (lead, functions) => lead.some((group) => functions.has(group));
  if (leadIn(anchor.lead, candidate.functions) && leadIn(candidate.lead, anchor.functions)) return { compatible: true, reason: '' };
  return { compatible: false, reason: 'treatment_function_mismatch', shared_groups: [] };
}

const OUT_OF_SCOPE_MERCH_TOKENS = new Set([
  'apparel',
  'bag',
  'cap',
  'clothing',
  'crewneck',
  'hat',
  'hoodie',
  'keychain',
  'merch',
  'shirt',
  'socks',
  'sweatshirt',
  'tee',
  'tote',
]);

function rawProductTokens(snapshot = {}) {
  const rawValues = [
    snapshot.category,
    snapshot.use_case,
    snapshot.useCase,
    snapshot.name,
    snapshot.title,
    snapshot.display_name,
    snapshot.displayName,
    snapshot.product_name,
    snapshot.description,
    snapshot.short_description,
    snapshot.shortDescription,
  ];
  if (Array.isArray(snapshot.category_taxonomy)) rawValues.push(...snapshot.category_taxonomy);
  if (Array.isArray(snapshot.tags)) rawValues.push(...snapshot.tags);
  return new Set(normalizeTokens(rawValues).filter((token) => token.length > 1));
}

function tokenSetHasPhrase(tokens, phrase) {
  const words = normalizeTokens(phrase);
  if (!words.length) return false;
  if (words.length === 1) return tokens.has(words[0]);
  return words.every((word) => tokens.has(word));
}

function tokenSetHasAny(tokens, values) {
  for (const value of values) {
    if (tokenSetHasPhrase(tokens, value)) return true;
  }
  return false;
}

function eyeAreaSignalValues(snapshot = {}) {
  return [
    snapshot.category,
    snapshot.use_case,
    snapshot.useCase,
    snapshot.name,
    snapshot.title,
    snapshot.display_name,
    snapshot.displayName,
    snapshot.product_name,
    snapshot.short_description,
    snapshot.shortDescription,
    ...(Array.isArray(snapshot.category_taxonomy) ? snapshot.category_taxonomy : []),
    ...(Array.isArray(snapshot.tags) ? snapshot.tags : []),
  ].filter(Boolean);
}

function hasEyeOrLashArea(snapshot = {}) {
  const signalValues = eyeAreaSignalValues(snapshot);
  const signalTokens = new Set(normalizeTokens(signalValues).filter((token) => token.length > 1));
  if (tokenSetHasAny(signalTokens, EYE_OR_LASH_AREA_TOKENS)) return true;

  const signalText = normalizeLower(signalValues.join(' '), 2048);
  if (/\b(?:under[-\s]?eye|eye|eyes|eyelash(?:es)?|eyeliner|eyeshadow|lash(?:es)?|brow(?:s)?|mascara)\b/.test(signalText) ||
    /\b(?:antioxifeye|beautifeye)\b/.test(signalText)) {
    return true;
  }

  const descriptionText = normalizeLower([
    snapshot.description,
    snapshot.short_description,
    snapshot.shortDescription,
  ].filter(Boolean).join(' '), 2048);

  return /\b(?:under[-\s]?eye|eye[-\s]?(?:area|serum|cream|treatment|gel|mask|balm)|lash(?:es)?[-\s]?(?:serum|growth|treatment|gel)|brow(?:s)?[-\s]?(?:serum|growth|treatment|gel)|mascara)\b/.test(descriptionText);
}

function tokenGroups(tokens, groupMap) {
  const groups = new Set();
  for (const [group, values] of Object.entries(groupMap)) {
    if (tokenSetHasAny(tokens, values)) groups.add(group);
  }
  return groups;
}

function isOutOfScopeBeautyProduct(snapshot = {}) {
  const tokens = rawProductTokens(snapshot);
  if (!hasAnyToken(tokens, OUT_OF_SCOPE_MERCH_TOKENS)) return false;
  return !tokenSetHasAny(tokens, ['beauty bag', 'beauty pouch', 'cosmetic bag', 'makeup bag', 'makeup pouch']);
}

function sharedGroups(left, right) {
  const shared = [];
  for (const group of left) {
    if (right.has(group)) shared.push(group);
  }
  return shared;
}

function filteredGroups(groups, allowedGroups) {
  return new Set([...groups].filter((group) => allowedGroups.has(group)));
}

function symmetricDifference(left, right) {
  const out = [];
  for (const group of left) {
    if (!right.has(group)) out.push(group);
  }
  for (const group of right) {
    if (!left.has(group)) out.push(group);
  }
  return out;
}

// "3-Piece Routine" is a set; read from the name before any shade tail, never from a description
// ("one-piece applicator") or a shade ("Piece of Cake").
function namesPieceCount(snapshot = {}) {
  return /\b\d+\s*-?\s*pieces?\b/.test(normalizeLower(snapshotNameText(snapshot), 512).split(/\s+\u2014\s+/)[0]);
}

function isSetLikeProduct(snapshot = {}) {
  const category = normalizeCategoryValue(snapshot.category);
  if (category === 'set' || category === 'makeup set') return true;
  return tokenSetHasAny(rawProductTokens(snapshot), SET_MARKER_TOKENS) || namesPieceCount(snapshot);
}

function isHighSignalSetLikeProduct(snapshot = {}) {
  const category = normalizeCategoryValue(snapshot.category);
  if (category === 'set' || category === 'makeup set') return true;
  const tokens = new Set(normalizeTokens(eyeAreaSignalValues(snapshot)).filter((token) => token.length > 1));
  return tokenSetHasAny(tokens, SET_MARKER_TOKENS);
}

function setCompositionGroups(snapshot = {}) {
  const tokens = rawProductTokens(snapshot);
  const groups = new Set();

  const hasLip = tokens.has('lip') || tokens.has('lips');
  if (hasLip && tokenSetHasAny(tokens, ['balm', 'butter', 'care', 'hydrating', 'hydration', 'mask', 'oil', 'savrs'])) {
    groups.add('lip_care');
  }
  if (hasLip && tokenSetHasAny(tokens, ['color', 'gloss', 'glossy', 'liner', 'luminizer', 'matte', 'pout', 'stain', 'tint'])) {
    groups.add('lip_color');
  }
  const hasCheekColor = tokenSetHasAny(tokens, ['blush', 'cheek']);
  const hasEyeMakeup = tokenSetHasAny(tokens, ['eye', 'eyeliner', 'eyeshadow', 'lash', 'mascara', 'shadow']);
  if (hasCheekColor) groups.add('cheek_color');
  if (tokenSetHasAny(tokens, ['bronzer', 'highlighter'])) groups.add('face_color');
  if (tokenSetHasAny(tokens, ['concealer', 'complexion', 'foundation']) ||
    tokenSetHasAny(tokens, ['powder']) && !hasCheekColor && !hasEyeMakeup ||
    tokens.has('skin') && tokens.has('tint')) {
    groups.add('complexion');
  }
  if (hasEyeMakeup) {
    groups.add('eye_makeup');
  }
  if (tokenSetHasAny(tokens, ['brush', 'loofah', 'sponge'])) groups.add('tool');
  if (tokenSetHasAny(tokens, ['cleanser', 'cleansing', 'gel', 'shower', 'wash'])) groups.add('cleanse');
  if (tokenSetHasAny(tokens, ['body']) && tokenSetHasAny(tokens, ['cream', 'lotion', 'oil', 'serum'])) {
    groups.add('body_care');
  }
  if (tokenSetHasAny(tokens, ['conditioner', 'hair', 'shampoo', 'styling'])) groups.add('hair_care');
  if (tokenSetHasAny(tokens, ['cream', 'lotion', 'moisturiser', 'moisturizer'])) groups.add('moisturize');
  if (tokenSetHasAny(tokens, ['drops', 'peptide', 'serum'])) groups.add('serum');
  if (tokenSetHasAny(tokens, ['fragrance', 'parfum', 'perfume', 'scent'])) groups.add('fragrance');

  return {
    groups,
    broadLookSet: tokenSetHasAny(tokens, BROAD_LOOK_SET_TOKENS),
    tokens,
  };
}

function setCompositionCompatibility(anchorSnapshot = {}, candidateSnapshot = {}) {
  const anchorSetLike = isSetLikeProduct(anchorSnapshot);
  const candidateSetLike = isSetLikeProduct(candidateSnapshot);
  if (!anchorSetLike && !candidateSetLike) return { compatible: true, reason: '', shared_groups: [] };

  const anchorProfile = setCompositionGroups(anchorSnapshot);
  const candidateProfile = setCompositionGroups(candidateSnapshot);

  if (anchorProfile.broadLookSet || candidateProfile.broadLookSet) {
    return { compatible: false, reason: 'broad_set_composition', shared_groups: [] };
  }
  if (anchorSetLike !== candidateSetLike) {
    return { compatible: false, reason: 'single_product_set_mismatch', shared_groups: [] };
  }

  const shared = [];
  for (const group of anchorProfile.groups) {
    if (candidateProfile.groups.has(group)) shared.push(group);
  }
  if (!shared.length) {
    return { compatible: false, reason: 'set_composition_mismatch', shared_groups: [] };
  }
  const anchorComponents = filteredGroups(anchorProfile.groups, SET_COMPONENT_GROUPS);
  const candidateComponents = filteredGroups(candidateProfile.groups, SET_COMPONENT_GROUPS);
  const componentDiff = symmetricDifference(anchorComponents, candidateComponents);
  if (componentDiff.length) {
    return {
      compatible: false,
      reason: 'set_composition_partial_mismatch',
      shared_groups: shared,
      component_diff: componentDiff,
    };
  }
  if (shared.length === 1 && shared[0] === 'fragrance') {
    return { compatible: false, reason: 'fragrance_set_needs_specific_scent_overlap', shared_groups: shared };
  }
  return { compatible: true, reason: '', shared_groups: shared };
}

function hasAnyToken(tokens, tokenSet) {
  for (const token of tokens) {
    if (tokenSet.has(token)) return true;
  }
  return false;
}

function productFormCompatibility(anchorSnapshot = {}, candidateSnapshot = {}) {
  const anchorTokens = new Set(collectUseCaseTokens(anchorSnapshot));
  const candidateTokens = new Set(collectUseCaseTokens(candidateSnapshot));
  const anchorHasTool = hasAnyToken(anchorTokens, TOOL_FORM_TOKENS);
  const candidateHasTool = hasAnyToken(candidateTokens, TOOL_FORM_TOKENS);
  const anchorHasTopical = hasAnyToken(anchorTokens, TOPICAL_FORM_TOKENS);
  const candidateHasTopical = hasAnyToken(candidateTokens, TOPICAL_FORM_TOKENS);

  if (anchorHasTool !== candidateHasTool) {
    if ((anchorHasTool && candidateHasTopical) || (candidateHasTool && anchorHasTopical)) {
      return { compatible: false, reason: 'tool_topical_form_mismatch' };
    }
  }
  const anchorAccessory = accessoryKind(anchorSnapshot);
  const candidateAccessory = accessoryKind(candidateSnapshot);
  if ((anchorAccessory || candidateAccessory) && anchorAccessory !== candidateAccessory) {
    return { compatible: false, reason: 'accessory_product_mismatch' };
  }

  const bothBrushes = anchorTokens.has('brush') && candidateTokens.has('brush');
  if (bothBrushes) {
    const anchorCode = brushCodeArea(anchorSnapshot);
    const candidateCode = brushCodeArea(candidateSnapshot);
    const anchorEye = hasAnyToken(anchorTokens, EYE_AREA_TOKENS) || anchorCode === 'eye';
    const candidateEye = hasAnyToken(candidateTokens, EYE_AREA_TOKENS) || candidateCode === 'eye';
    const anchorFaceBody = hasAnyToken(anchorTokens, FACE_BODY_AREA_TOKENS) || anchorCode === 'face';
    const candidateFaceBody = hasAnyToken(candidateTokens, FACE_BODY_AREA_TOKENS) || candidateCode === 'face';
    if ((anchorEye && candidateFaceBody && !candidateEye) || (candidateEye && anchorFaceBody && !anchorEye)) {
      return { compatible: false, reason: 'brush_application_area_mismatch' };
    }
  }

  return { compatible: true, reason: '' };
}

function productJobCompatibility(anchorSnapshot = {}, candidateSnapshot = {}) {
  const anchorTokens = rawProductTokens(anchorSnapshot);
  const candidateTokens = rawProductTokens(candidateSnapshot);
  const anchorCategory = normalizeCategoryValue(anchorSnapshot.category);
  const candidateCategory = normalizeCategoryValue(candidateSnapshot.category);
  const anchorBodyArea = anchorTokens.has('body');
  const candidateBodyArea = candidateTokens.has('body');
  const anchorFaceArea = tokenSetHasAny(anchorTokens, ['face', 'facial']);
  const candidateFaceArea = tokenSetHasAny(candidateTokens, ['face', 'facial']);
  const anchorScalpArea = anchorTokens.has('scalp');
  const candidateScalpArea = candidateTokens.has('scalp');

  const anchorComplexion = tokenGroups(anchorTokens, COMPLEXION_JOB_TOKENS);
  const candidateComplexion = tokenGroups(candidateTokens, COMPLEXION_JOB_TOKENS);
  if ((anchorCategory === 'complexion' || candidateCategory === 'complexion') && anchorComplexion.size && candidateComplexion.size) {
    const shared = sharedGroups(anchorComplexion, candidateComplexion);
    if (!shared.length) {
      return { compatible: false, reason: 'complexion_job_mismatch', shared_groups: [] };
    }
    const anchorCoverage = anchorComplexion.has('foundation') || anchorComplexion.has('concealer');
    const candidateCoverage = candidateComplexion.has('foundation') || candidateComplexion.has('concealer');
    if (shared.length === 1 && shared[0] === 'powder' && anchorCoverage !== candidateCoverage) {
      return { compatible: false, reason: 'complexion_coverage_setting_mismatch', shared_groups: shared };
    }
  }

  const anchorHasLip = anchorTokens.has('lip') || anchorTokens.has('lips') || anchorCategory.startsWith('lip');
  const candidateHasLip = candidateTokens.has('lip') || candidateTokens.has('lips') || candidateCategory.startsWith('lip');
  if (anchorHasLip || candidateHasLip) {
    const anchorCare = anchorHasLip && tokenSetHasAny(anchorTokens, LIP_CARE_TOKENS);
    const candidateCare = candidateHasLip && tokenSetHasAny(candidateTokens, LIP_CARE_TOKENS);
    const anchorColor = anchorHasLip && tokenSetHasAny(anchorTokens, LIP_COLOR_TOKENS);
    const candidateColor = candidateHasLip && tokenSetHasAny(candidateTokens, LIP_COLOR_TOKENS);
    if (anchorHasLip !== candidateHasLip) {
      return { compatible: false, reason: 'lip_area_mismatch', shared_groups: [] };
    }
    if ((anchorCare && candidateColor && !candidateCare) ||
      (candidateCare && anchorColor && !anchorCare)) {
      return { compatible: false, reason: 'lip_care_color_mismatch', shared_groups: [] };
    }
  }

  const anchorSkinCare = anchorCategory === 'skin care' || anchorCategory === 'skincare' || anchorCategory === 'skin_care';
  const candidateSkinCare = candidateCategory === 'skin care' || candidateCategory === 'skincare' || candidateCategory === 'skin_care';
  if (anchorSkinCare || candidateSkinCare) {
    const anchorHair = anchorTokens.has('hair');
    const candidateHair = candidateTokens.has('hair');
    if (anchorHair !== candidateHair) {
      return { compatible: false, reason: 'hair_skin_job_mismatch', shared_groups: [] };
    }

    const anchorSkinJobs = tokenGroups(anchorTokens, SKINCARE_JOB_TOKENS);
    const candidateSkinJobs = tokenGroups(candidateTokens, SKINCARE_JOB_TOKENS);
    if (anchorSkinJobs.has('eye') !== candidateSkinJobs.has('eye')) {
      return { compatible: false, reason: 'eye_face_skin_job_mismatch', shared_groups: [] };
    }
    if (anchorSkinJobs.has('sunscreen') !== candidateSkinJobs.has('sunscreen')) {
      return { compatible: false, reason: 'sunscreen_skin_job_mismatch', shared_groups: [] };
    }
    if ((anchorBodyArea && candidateFaceArea && !candidateBodyArea) ||
      (candidateBodyArea && anchorFaceArea && !anchorBodyArea)) {
      return { compatible: false, reason: 'face_body_skin_job_mismatch', shared_groups: [] };
    }
    if (anchorSkinJobs.size && candidateSkinJobs.size) {
      const shared = sharedGroups(anchorSkinJobs, candidateSkinJobs);
      if (!shared.length) {
        return { compatible: false, reason: 'skin_care_job_mismatch', shared_groups: [] };
      }
    }

    const anchorSkinEffects = tokenGroups(anchorTokens, SKIN_EFFECT_TOKENS);
    const candidateSkinEffects = tokenGroups(candidateTokens, SKIN_EFFECT_TOKENS);
    if (anchorSkinEffects.size && candidateSkinEffects.size) {
      const sharedEffects = sharedGroups(anchorSkinEffects, candidateSkinEffects);
      if (!sharedEffects.length) {
        return { compatible: false, reason: 'skin_effect_job_mismatch', shared_groups: [] };
      }
    }
  }

  const anchorBodyCare = anchorCategory === 'body care' || anchorCategory === 'body_care' || anchorCategory === 'body_cleanse' || anchorBodyArea;
  const candidateBodyCare = candidateCategory === 'body care' || candidateCategory === 'body_care' || candidateCategory === 'body_cleanse' || candidateBodyArea;
  if (anchorBodyCare || candidateBodyCare) {
    if (anchorBodyCare !== candidateBodyCare && (anchorBodyArea || candidateBodyArea)) {
      return { compatible: false, reason: 'body_nonbody_job_mismatch', shared_groups: [] };
    }
    const anchorBodyJobs = tokenGroups(anchorTokens, BODY_CARE_JOB_TOKENS);
    const candidateBodyJobs = tokenGroups(candidateTokens, BODY_CARE_JOB_TOKENS);
    if (anchorBodyJobs.has('sunscreen') !== candidateBodyJobs.has('sunscreen')) {
      return { compatible: false, reason: 'body_sunscreen_job_mismatch', shared_groups: [] };
    }
    if (anchorBodyJobs.has('deodorant') !== candidateBodyJobs.has('deodorant')) {
      return { compatible: false, reason: 'body_deodorant_job_mismatch', shared_groups: [] };
    }
    if (anchorBodyJobs.size && candidateBodyJobs.size) {
      const shared = sharedGroups(anchorBodyJobs, candidateBodyJobs);
      if (!shared.length) {
        return { compatible: false, reason: 'body_care_job_mismatch', shared_groups: [] };
      }
    }
  }

  if ((anchorScalpArea || candidateScalpArea) && anchorScalpArea !== candidateScalpArea) {
    return { compatible: false, reason: 'scalp_area_job_mismatch', shared_groups: [] };
  }

  const bothBrushes = anchorTokens.has('brush') && candidateTokens.has('brush');
  if (bothBrushes) {
    const anchorTargets = brushTargets(anchorSnapshot, anchorTokens);
    const candidateTargets = brushTargets(candidateSnapshot, candidateTokens);
    if (anchorTargets.size && candidateTargets.size) {
      const shared = sharedGroups(anchorTargets, candidateTargets);
      if (!shared.length) {
        return { compatible: false, reason: 'brush_target_mismatch', shared_groups: [] };
      }
    }
  }

  const anchorHairCleanse = anchorCategory === 'hair_cleanse' || anchorTokens.has('shampoo');
  const candidateHairCleanse = candidateCategory === 'hair_cleanse' || candidateTokens.has('shampoo');
  if (anchorHairCleanse && candidateHairCleanse) {
    const anchorEffects = tokenGroups(anchorTokens, HAIR_EFFECT_TOKENS);
    const candidateEffects = tokenGroups(candidateTokens, HAIR_EFFECT_TOKENS);
    if (anchorEffects.size && candidateEffects.size) {
      const shared = sharedGroups(anchorEffects, candidateEffects);
      if (!shared.length) {
        return { compatible: false, reason: 'hair_cleanse_effect_mismatch', shared_groups: [] };
      }
    }
  }

  const anchorHairCare = anchorCategory === 'hair_care' || anchorTokens.has('hair');
  const candidateHairCare = candidateCategory === 'hair_care' || candidateTokens.has('hair');
  if (anchorHairCare && candidateHairCare) {
    // A leave-in is not the rinse-out step it is named after ("Leave-In Conditioner" vs a conditioner).
    if (/\bleave[\s-]*in\b/.test(normalizeLower(snapshotNameText(anchorSnapshot), 240)) !==
      /\bleave[\s-]*in\b/.test(normalizeLower(snapshotNameText(candidateSnapshot), 240))) {
      return { compatible: false, reason: 'hair_leave_in_mismatch', shared_groups: [] };
    }
    const anchorHairForms = tokenGroups(anchorTokens, HAIR_FORM_JOB_TOKENS);
    const candidateHairForms = tokenGroups(candidateTokens, HAIR_FORM_JOB_TOKENS);
    if (anchorHairForms.size && candidateHairForms.size) {
      const sharedForms = sharedGroups(anchorHairForms, candidateHairForms);
      if (!sharedForms.length) {
        return { compatible: false, reason: 'hair_form_job_mismatch', shared_groups: [] };
      }
    }
    const anchorEffects = tokenGroups(anchorTokens, HAIR_EFFECT_TOKENS);
    const candidateEffects = tokenGroups(candidateTokens, HAIR_EFFECT_TOKENS);
    if (anchorEffects.has('density') !== candidateEffects.has('density')) {
      return { compatible: false, reason: 'hair_density_claim_mismatch', shared_groups: [] };
    }
    if (anchorEffects.size && candidateEffects.size) {
      const shared = sharedGroups(anchorEffects, candidateEffects);
      if (!shared.length) {
        return { compatible: false, reason: 'hair_care_effect_mismatch', shared_groups: [] };
      }
    }
  }

  // Runs whatever the category says: the served serums and toners carry leaf categories ("serum",
  // "beauty/skincare/treat/toner"), never the literal "skincare" the effect rule above needs.
  const treatment = treatmentFunctionCompatibility(anchorSnapshot, candidateSnapshot);
  if (!treatment.compatible) return treatment;

  return { compatible: true, reason: '', shared_groups: [] };
}

// Leaf-category agreement for dupe / competitive_alternative.
//
// 2026-09-26 JP/AU dry run: a jelly lip gloss got a lip balm as an alternative; a hand cream got a
// hair oil; a face cream got an eye emulsion; a sunscreen gel got a face wash filed under
// "sunscreen". The job gates above read description copy, where every product mentions every
// area, and their skincare rules only run when `category` is literally "skincare" while the JP/AU
// catalogs carry leaf categories ("cream", "Eye Cream", "Hand Cream").
//
// This rule reads only the leaf category and the product name, and FAILS OPEN on anything it
// does not recognise:
//   1. Area: reject only when BOTH sides name a known body area (eye, lip, body, hand, nail, foot,
//      hair, face) and the areas do not intersect. There is no default area: "Shampoo" vs "Hair
//      Shampoo", "Lipstick" vs "Rouge", "Body Wash" vs "Shower Gel" all pass. A hand cream against
//      a multi-purpose oil that names no area also passes; the old face default rejected it.
//   2. Form: forms are canonicalised through synonym groups (JP "lotion" is its own form and is
//      never incompatible with toner; BB / CC cream, cushion, skin tint and tinted moisturizer are
//      foundation; sun cream / UV gel / SPF are sunscreen; essence, ampoule, booster are serum;
//      rouge is lipstick; cheek tint is blush). A pair is rejected only when its primary forms are
//      on the curated incompatibility list below — the pairs the dry run actually measured — never
//      because two forms merely differ. Night cream vs face oil, blush vs cheek tint and toner vs
//      lotion all pass. The primary form is the head noun of the name (the last form word before a
//      "with / for / &" clause), else the leaf category's form.
//   3. Japanese-script names and categories yield no tokens (normalizeTokens keeps [a-z0-9] only),
//      so they carry no area and no form and fail open. That is intended.
const LEAF_AREA_GROUPS = {
  eye: [...EYE_AREA_TOKENS, 'brows', 'eyes', 'lashes', 'mascara', 'undereye'],
  lip: ['lip', 'lips', 'lipstick', 'lipgloss', 'rouge'],
  body: ['body'],
  hand: ['hand', 'hands'],
  nail: ['nail', 'nails'],
  foot: ['foot', 'feet'],
  hair: ['hair', 'scalp', 'shampoo', 'conditioner'],
  face: ['face', 'facial', 'cheek', 'cheeks'],
};

// Multi-word forms are matched first and consume their words, so "sun cream" is a sunscreen, not a
// moisturizer, and "cleansing balm" is a cleanser, not a balm.
const LEAF_FORM_PHRASES = [
  ['tinted moisturizer', 'foundation'], ['tinted moisturiser', 'foundation'], ['skin tint', 'foundation'],
  ['bb cream', 'foundation'], ['cc cream', 'foundation'], ['cushion foundation', 'foundation'],
  ['sun cream', 'sunscreen'], ['sun gel', 'sunscreen'], ['sun milk', 'sunscreen'], ['sun stick', 'sunscreen'],
  ['sun fluid', 'sunscreen'], ['sun serum', 'sunscreen'], ['sun essence', 'sunscreen'], ['sun screen', 'sunscreen'],
  ['uv gel', 'sunscreen'], ['uv milk', 'sunscreen'], ['uv cream', 'sunscreen'], ['uv essence', 'sunscreen'],
  ['uv lotion', 'sunscreen'], ['uv fluid', 'sunscreen'], ['uv stick', 'sunscreen'], ['uv protection', 'sunscreen'],
  ['cleansing oil', 'cleanser'], ['cleansing balm', 'cleanser'], ['cleansing milk', 'cleanser'],
  ['cleansing gel', 'cleanser'], ['cleansing foam', 'cleanser'], ['cleansing powder', 'cleanser'],
  ['cleansing water', 'cleanser'], ['micellar water', 'cleanser'], ['shower gel', 'cleanser'],
  ['cheek tint', 'blush'], ['cheek stain', 'blush'], ['lip tint', 'lipstick'], ['lip stain', 'lipstick'],
  ['lip oil', 'balm'], ['lip mask', 'balm'], ['setting spray', 'mist'],
];

const LEAF_FORM_SYNONYMS = {
  toner: 'toner', mist: 'mist',
  lotion: 'lotion',
  moisturizer: 'moisturizer', moisturiser: 'moisturizer', cream: 'moisturizer', creme: 'moisturizer',
  emulsion: 'moisturizer',
  serum: 'serum', essence: 'serum', ampoule: 'serum', booster: 'serum', concentrate: 'serum', drops: 'serum',
  sunscreen: 'sunscreen', sunblock: 'sunscreen', spf: 'sunscreen',
  cleanser: 'cleanser', cleansing: 'cleanser', wash: 'cleanser', soap: 'cleanser', micellar: 'cleanser',
  mask: 'mask', masque: 'mask', patch: 'mask', patches: 'mask',
  oil: 'oil',
  powder: 'powder', primer: 'primer', concealer: 'concealer', corrector: 'concealer',
  foundation: 'foundation', cushion: 'foundation', bb: 'foundation', cc: 'foundation',
  blush: 'blush', bronzer: 'bronzer', highlighter: 'highlighter',
  lipstick: 'lipstick', rouge: 'lipstick', gloss: 'gloss', balm: 'balm',
  liner: 'liner', eyeliner: 'liner', mascara: 'mascara', eyeshadow: 'eyeshadow', shadow: 'eyeshadow',
  shampoo: 'shampoo', conditioner: 'conditioner',
  deodorant: 'deodorant', perfume: 'fragrance', parfum: 'fragrance', fragrance: 'fragrance', cologne: 'fragrance',
  brush: 'tool', sponge: 'tool', applicator: 'tool',
};

// Curated incompatible primary-form pairs: the leaf_form_mismatch reasons the 2026-09-26 shard
// runs measured, plus the two wrong-form pairs the audit found by hand (gloss / balm, tint / balm).
// Anything not listed is compatible; a form the vocabulary does not know is compatible with all.
const LEAF_INCOMPATIBLE_FORM_PAIRS = [
  ['cleanser', 'powder'], ['cleanser', 'serum'], ['cleanser', 'moisturizer'], ['cleanser', 'sunscreen'],
  ['cleanser', 'mask'], ['cleanser', 'foundation'], ['cleanser', 'concealer'], ['cleanser', 'primer'],
  ['cleanser', 'toner'],
  ['powder', 'serum'], ['powder', 'moisturizer'], ['powder', 'sunscreen'], ['powder', 'mask'], ['powder', 'toner'],
  ['serum', 'primer'], ['serum', 'concealer'], ['serum', 'mask'], ['serum', 'sunscreen'], ['serum', 'foundation'],
  ['moisturizer', 'mask'], ['moisturizer', 'concealer'], ['moisturizer', 'primer'], ['moisturizer', 'foundation'],
  ['moisturizer', 'shampoo'], ['moisturizer', 'conditioner'], ['serum', 'shampoo'], ['serum', 'conditioner'],
  ['gloss', 'balm'], ['lipstick', 'balm'], ['liner', 'lipstick'], ['liner', 'gloss'],
  ['tool', 'cleanser'], ['tool', 'moisturizer'], ['tool', 'serum'],
];
const LEAF_INCOMPATIBLE_FORM_KEYS = new Set(LEAF_INCOMPATIBLE_FORM_PAIRS.map(([a, b]) => [a, b].sort().join('|')));

function leafCategoryValue(snapshot = {}) {
  const candidates = [snapshot.category];
  if (Array.isArray(snapshot.category_taxonomy)) candidates.push(...[...snapshot.category_taxonomy].reverse());
  for (const raw of candidates) {
    const segments = normalizeCategoryValue(raw).split(/\s*[/>|›]\s*/).map((item) => item.trim()).filter(Boolean);
    const leaf = segments.length ? segments[segments.length - 1] : '';
    if (!leaf || isBroadCategoryValue(leaf) || SHELF_PLACEHOLDER_TOKENS.has(leaf)) continue;
    return leaf;
  }
  return '';
}

function snapshotNameText(snapshot = {}) {
  return pickFirstString(
    snapshot.name,
    snapshot.title,
    snapshot.display_name,
    snapshot.displayName,
    snapshot.product_name,
    snapshot.productName,
  );
}

// Forms named in `text`, phrases first (their words consumed), then single words. Returns the
// canonical forms in order of appearance so the caller can pick the head form.
function leafFormsInText(text) {
  let working = ` ${normalizeTokens(text).join(' ')} `;
  const found = [];
  for (const [phrase, form] of LEAF_FORM_PHRASES) {
    const needle = ` ${phrase} `;
    const at = working.indexOf(needle);
    if (at === -1) continue;
    found.push({ at, form });
    working = working.replace(needle, ' ');
  }
  const words = working.trim().split(/\s+/).filter(Boolean);
  const consumed = found.map((item) => item.form);
  const ordered = [];
  for (const word of words) {
    const form = LEAF_FORM_SYNONYMS[word];
    if (form) ordered.push(form);
  }
  return { phraseForms: consumed, wordForms: ordered };
}

// The head form of a product name: a multi-word synonym phrase when the name carries one ("Tinted
// Moisturizer Cream" -> foundation, not moisturizer), else the last form word before a modifier
// clause ("Lip Balm with Hemp Seed Oil" -> balm, "Cream-to-Foam Face Cleanser" -> cleanser).
function leafHeadForm(name) {
  const head = normalizeLower(name, 512).split(/\s+(?:with|for|and|&|\+|featuring|infused|enriched)\s+|\s+[—–]\s+|\s*\|\s*/)[0] || '';
  const { phraseForms, wordForms } = leafFormsInText(head);
  if (phraseForms.length) return phraseForms[phraseForms.length - 1];
  if (wordForms.length) return wordForms[wordForms.length - 1];
  return '';
}

function leafAreas(tokens) {
  const areas = new Set();
  for (const [area, words] of Object.entries(LEAF_AREA_GROUPS)) {
    if (words.some((word) => tokens.has(word))) areas.add(area);
  }
  return areas;
}

function snapshotLeafProfile(snapshot = {}) {
  const leaf = leafCategoryValue(snapshot);
  const name = snapshotNameText(snapshot);
  const leafTokens = new Set(normalizeTokens(leaf));
  const nameTokens = new Set(normalizeTokens(name));
  const headForm = leafHeadForm(name);
  const leafForms = leafFormsInText(leaf);
  const categoryForms = new Set([...leafForms.phraseForms, ...leafForms.wordForms]);
  const forms = headForm ? new Set([headForm]) : categoryForms;
  return {
    leaf,
    head_form: headForm,
    forms,
    areas: leafAreas(new Set([...leafTokens, ...nameTokens])),
  };
}

function setsIntersect(left, right) {
  for (const item of left) {
    if (right.has(item)) return true;
  }
  return false;
}

function formsIncompatible(left, right) {
  if (!left.size || !right.size) return false;
  for (const a of left) {
    for (const b of right) {
      if (a === b || !LEAF_INCOMPATIBLE_FORM_KEYS.has([a, b].sort().join('|'))) return false;
    }
  }
  return true;
}

function leafCategoryCompatibility(anchorSnapshot = {}, candidateSnapshot = {}) {
  const anchor = snapshotLeafProfile(anchorSnapshot);
  const candidate = snapshotLeafProfile(candidateSnapshot);
  const label = (set) => [...set].sort().join('+') || 'none';
  if (anchor.areas.size && candidate.areas.size && !setsIntersect(anchor.areas, candidate.areas)) {
    return { compatible: false, reason: `leaf_area_mismatch:${label(anchor.areas)}_vs_${label(candidate.areas)}`, evaluated: true };
  }
  if (formsIncompatible(anchor.forms, candidate.forms)) {
    return { compatible: false, reason: `leaf_form_mismatch:${label(anchor.forms)}_vs_${label(candidate.forms)}`, evaluated: true };
  }
  return {
    compatible: true,
    reason: '',
    evaluated: Boolean((anchor.areas.size && candidate.areas.size) || (anchor.forms.size && candidate.forms.size)),
  };
}

function collectUseCaseTokens(snapshot = {}) {
  const rawValues = [
    snapshot.category,
    snapshot.use_case,
    snapshot.useCase,
    snapshot.name,
    snapshot.title,
    snapshot.display_name,
    snapshot.displayName,
    snapshot.product_name,
    snapshot.description,
    snapshot.short_description,
    snapshot.shortDescription,
  ];
  if (Array.isArray(snapshot.category_taxonomy)) rawValues.push(...snapshot.category_taxonomy);
  if (Array.isArray(snapshot.tags)) rawValues.push(...snapshot.tags);
  return normalizeTokens(rawValues)
    .filter((token) => token.length > 2)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !GENERIC_USE_CASE_TOKENS.has(token));
}

function specificUseCaseOverlap(anchorSnapshot = {}, candidateSnapshot = {}) {
  const anchorTokens = new Set(collectUseCaseTokens(anchorSnapshot));
  const candidateTokens = new Set(collectUseCaseTokens(candidateSnapshot));
  const overlap = [];
  const strongOverlap = [];
  for (const token of anchorTokens) {
    if (candidateTokens.has(token)) {
      overlap.push(token);
      if (STRONG_USE_CASE_TOKENS.has(token)) strongOverlap.push(token);
    }
  }
  const denominator = Math.max(1, Math.min(anchorTokens.size, candidateTokens.size));
  return {
    count: overlap.length,
    score: overlap.length / denominator,
    overlap,
    strong_overlap: strongOverlap,
    strong_count: strongOverlap.length,
  };
}

function normalizeCategoryValue(value) {
  return normalizeLower(value, 120).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isBroadCategoryValue(value) {
  const text = normalizeCategoryValue(value);
  if (!text) return true;
  return BROAD_CATEGORY_VALUES.has(text);
}

function hasSpecificUseCaseAlignment(anchorSnapshot = {}, candidateSnapshot = {}, { ingredientScore = 0 } = {}) {
  const anchorCategory = normalizeCategoryValue(anchorSnapshot.category);
  const candidateCategory = normalizeCategoryValue(candidateSnapshot.category);
  const exactSpecificCategory = Boolean(
    anchorCategory &&
      candidateCategory &&
      anchorCategory === candidateCategory &&
      !isBroadCategoryValue(anchorCategory),
  );
  const overlap = specificUseCaseOverlap(anchorSnapshot, candidateSnapshot);
  const bothPressOnNails = optionRole(anchorSnapshot) === 'nails' && optionRole(candidateSnapshot) === 'nails' &&
    /\bpress[ -]?on\b/i.test(snapshotNameText(anchorSnapshot)) && /\bpress[ -]?on\b/i.test(snapshotNameText(candidateSnapshot));
  const hasStrongOverlap = overlap.strong_count >= 1 || bothPressOnNails;
  return {
    aligned: Boolean(
      hasStrongOverlap &&
        (overlap.count >= 2 || exactSpecificCategory || ingredientScore >= 0.6),
    ),
    exactSpecificCategory,
    overlap,
  };
}

// A dupe claims the candidate does the anchor's job for less. Category agreement cannot carry that
// claim: it saturates the similarity score, and in the 2026-09-25 JP/AU dry run 697 of 1,299 dupes
// shared no name word at all (a sunscreen gel "duped" by eye patches). The claim needs words both
// products are named or formulated with. A name/category match retrieves alternatives,
// but dupe inference requires a VERIFIED current-anchor dupe pair from curated KB,
// or two substantial, overlapping INCI lists plus shared product evidence. Curated
// comparables and a product appearing elsewhere in the KB do not prove this pair.
// Conflicting INCI still refutes the inference. Matching ingredients does not
// establish equivalent performance; human approval remains required for serving.
// Score/category/form/job and same-currency price gates also remain mandatory.
const DUPE_MIN_SHARED_PRODUCT_TOKENS = 2;
const DUPE_MIN_INCI_OVERLAP = 0.35;
// A "key ingredients" blurb of a few ENTRIES is not an INCI list; comparing it against a full list
// (hits / max size) would refute every genuine dupe. Entries are the comma / semicolon-separated
// items, not words: "Niacinamide, Sodium Hyaluronate, Zinc PCA, Glycerin" is 4 entries (6 words).
// Below this many entries on either side the refutation abstains.
const DUPE_MIN_INCI_ENTRIES = 5;
const PRODUCT_AREA_TOKENS = new Set(['body', 'eye', 'eyes', 'face', 'facial', 'hair', 'lip', 'lips', 'scalp', 'skin']);
const SHELF_PLACEHOLDER_TOKENS = new Set(['general', 'misc', 'other', 'others', 'uncategorized', 'unknown']);

function productEvidenceTokens(snapshot = {}, excluded = new Set()) {
  return new Set(
    normalizeTokens([snapshot.name, snapshot.ingredient_text])
      .filter((token) => token.length > 2)
      .filter((token) => !/^\d/.test(token))
      .filter((token) => !GENERIC_USE_CASE_TOKENS.has(token))
      .filter((token) => !PRODUCT_AREA_TOKENS.has(token))
      .filter((token) => !excluded.has(token)),
  );
}

function sharedProductEvidence(anchorSnapshot = {}, candidateSnapshot = {}) {
  const excluded = new Set([
    ...SHELF_PLACEHOLDER_TOKENS,
    ...normalizeTokens([anchorSnapshot.brand, candidateSnapshot.brand]),
  ]);
  const candidateTokens = productEvidenceTokens(candidateSnapshot, excluded);
  const shared = Array.from(productEvidenceTokens(anchorSnapshot, excluded)).filter((token) => candidateTokens.has(token));
  return { count: shared.length, tokens: shared };
}

function inciEntryCount(value) {
  return String(value == null ? '' : value).split(/[,;]/).map((item) => item.trim()).filter(Boolean).length;
}

function ingredientOverlap(anchorSnapshot = {}, candidateSnapshot = {}) {
  if (inciEntryCount(anchorSnapshot.ingredient_text) < DUPE_MIN_INCI_ENTRIES) return null;
  if (inciEntryCount(candidateSnapshot.ingredient_text) < DUPE_MIN_INCI_ENTRIES) return null;
  const left = new Set(normalizeTokens(anchorSnapshot.ingredient_text).filter((token) => token.length > 2));
  const right = new Set(normalizeTokens(candidateSnapshot.ingredient_text).filter((token) => token.length > 2));
  if (!left.size || !right.size) return null;
  let hits = 0;
  for (const token of left) if (right.has(token)) hits += 1;
  return hits / Math.max(left.size, right.size);
}

function hasCuratedDupeEvidence(candidate = {}, anchorSnapshot = {}, candidateSnapshot = {}) {
  const pair = candidate.curated_pair_evidence;
  const ref = (snapshot) => normalizeLower(snapshot.product_ref || snapshot.product_id || snapshot.id, 512).replace(/^product:/, '');
  return Boolean(pair && pair.verified === true && pair.relation_type === 'dupe' &&
    ref(anchorSnapshot) && ref(candidateSnapshot) &&
    normalizeLower(pair.anchor_ref, 512).replace(/^product:/, '') === ref(anchorSnapshot) &&
    normalizeLower(pair.candidate_ref, 512).replace(/^product:/, '') === ref(candidateSnapshot));
}

function jaccard(left, right) {
  const l = new Set(normalizeTokens(left));
  const r = new Set(normalizeTokens(right));
  if (!l.size || !r.size) return 0;
  let intersect = 0;
  for (const token of l) {
    if (r.has(token)) intersect += 1;
  }
  return intersect / (l.size + r.size - intersect);
}

function pickFirstString(...values) {
  for (const value of values) {
    const text = normalizeString(value);
    if (text) return text;
  }
  return '';
}

function normalizeProductSnapshot(input = {}) {
  const src = isPlainObject(input) ? input : {};
  const product = isPlainObject(src.product) ? src.product : src;
  const ref = pickFirstString(
    src.product_ref,
    src.productRef,
    product.product_ref,
    product.productRef,
    product.product_id,
    product.productId,
    product.sku_id,
    product.skuId,
    product.id,
    product.url,
  );
  const brand = pickFirstString(product.brand_id, product.brandId, product.brand, product.brand_name, product.vendor);
  const name = pickFirstString(product.name, product.display_name, product.displayName, product.title, product.product_name);
  return {
    product_ref: ref ? (ref.includes(':') ? ref : `product:${ref}`) : '',
    snapshot: {
      ...product,
      ...(brand ? { brand } : {}),
      ...(name ? { name } : {}),
    },
  };
}

// { amount, currency } of each side, each read from the record that holds the amount.
function anchorPriceOf(anchorSnapshot) {
  return readPriceWithCurrency([[anchorSnapshot, 'price'], [anchorSnapshot, 'price_amount']], toNumberOrNull);
}

function candidatePriceOf(candidateSnapshot, candidate) {
  return readPriceWithCurrency(
    [[candidateSnapshot, 'price'], [candidateSnapshot, 'price_amount'], [candidate, 'price']],
    toNumberOrNull,
  );
}

function extractScore(candidate, names, fallback = 0) {
  const src = isPlainObject(candidate) ? candidate : {};
  const breakdown = isPlainObject(src.score_breakdown || src.scoreBreakdown)
    ? (src.score_breakdown || src.scoreBreakdown)
    : {};
  for (const name of names) {
    const value = src[name] ?? breakdown[name];
    if (value != null && value !== '') return clamp01(value, fallback);
  }
  return fallback;
}

function buildSourceRefs(candidate) {
  const src = isPlainObject(candidate) ? candidate : {};
  const refs = [];
  if (Array.isArray(src.source_refs || src.sourceRefs)) {
    refs.push(...(src.source_refs || src.sourceRefs));
  }
  if (src.source || src.source_type || src.sourceType) {
    refs.push(src.source || src.source_type || src.sourceType);
  }
  if (!refs.length) refs.push({ type: 'products_cache', authoritative: true });
  return refs;
}

function needCandidateCompatibility(need = {}, candidateSnapshot = {}, candidate = {}) {
  const needId = normalizeLower(need.need_id || need.id || need.label, 160);
  const needTokens = rawProductTokens({
    ...need,
    name: need.label || need.name,
    category: Array.isArray(need.category_taxonomy) ? need.category_taxonomy.join(' ') : need.category,
  });
  const candidateTokens = rawProductTokens(candidateSnapshot);
  const candidateCategory = normalizeCategoryValue(candidateSnapshot.category);
  const candidatePrice = toNumberOrNull(candidateSnapshot.price ?? candidateSnapshot.price_amount ?? candidate.price);
  const candidateEyeOrLashArea = hasEyeOrLashArea(candidateSnapshot);
  const isBodyOrHair = candidateTokens.has('body') || candidateTokens.has('hair') || candidateTokens.has('scalp') ||
    candidateCategory.startsWith('body') || candidateCategory.startsWith('hair') || candidateCategory === 'scalp care';

  if (isHighSignalSetLikeProduct(candidateSnapshot)) {
    return { compatible: false, reason: 'need_candidate_set_like_mismatch' };
  }

  if (needId.includes('budget-peptide-serum')) {
    if (candidatePrice == null) return { compatible: false, reason: 'budget_need_missing_price' };
    if (candidateEyeOrLashArea) return { compatible: false, reason: 'budget_peptide_need_eye_area_mismatch' };
    if (!tokenSetHasAny(candidateTokens, ['peptide', 'peptides'])) return { compatible: false, reason: 'budget_peptide_need_missing_peptide' };
    if (!tokenSetHasAny(candidateTokens, ['serum', 'drops'])) return { compatible: false, reason: 'budget_peptide_need_missing_serum_form' };
  }

  if (needId.includes('fragrance-free-barrier-repair')) {
    if (candidateEyeOrLashArea) return { compatible: false, reason: 'barrier_need_eye_area_mismatch' };
    if (isBodyOrHair) return { compatible: false, reason: 'barrier_need_body_or_hair_mismatch' };
    if (!tokenSetHasAny(candidateTokens, ['barrier', 'ceramide', 'repair'])) return { compatible: false, reason: 'barrier_need_missing_barrier_evidence' };
    if (!tokenSetHasAny(candidateTokens, ['fragrance free', 'fragrance-free', 'unscented', 'sensitive'])) {
      return { compatible: false, reason: 'barrier_need_missing_fragrance_free_evidence' };
    }
  }

  if (needId.includes('acne-prone-sensitive-skin')) {
    if (isBodyOrHair) return { compatible: false, reason: 'acne_sensitive_need_body_or_hair_mismatch' };
    if (!tokenSetHasAny(candidateTokens, ['acne', 'blemish', 'sensitive', 'salicylic'])) {
      return { compatible: false, reason: 'acne_sensitive_need_missing_need_evidence' };
    }
  }

  if (needId.includes('pregnancy-safe-retinoid-alternative')) {
    if (isBodyOrHair) return { compatible: false, reason: 'retinoid_alt_need_body_or_hair_mismatch' };
    if (!tokenSetHasAny(candidateTokens, ['bakuchiol', 'bio retinol', 'retinoid alternative'])) {
      return { compatible: false, reason: 'retinoid_alt_need_missing_alternative_evidence' };
    }
    if (!tokenSetHasAny(candidateTokens, ['pregnancy', 'pregnancy cautious', 'pregnancy safe'])) {
      return { compatible: false, reason: 'retinoid_alt_need_missing_pregnancy_evidence' };
    }
  }

  if (needId.includes('mineral-sensitive-sunscreen')) {
    if (candidateTokens.has('hair') || candidateTokens.has('scalp') || candidateCategory.startsWith('hair')) {
      return { compatible: false, reason: 'mineral_sunscreen_need_hair_mismatch' };
    }
    if (!tokenSetHasAny(candidateTokens, ['spf', 'sunscreen'])) {
      return { compatible: false, reason: 'mineral_sunscreen_need_missing_spf' };
    }
    if (!tokenSetHasAny(candidateTokens, ['mineral', 'zinc oxide', 'titanium dioxide'])) {
      return { compatible: false, reason: 'mineral_sunscreen_need_missing_mineral_evidence' };
    }
    if (!tokenSetHasAny(candidateTokens, ['sensitive', 'gentle', 'fragrance free', 'fragrance-free', 'unscented'])) {
      return { compatible: false, reason: 'mineral_sunscreen_need_missing_sensitive_evidence' };
    }
  }

  if (needId.includes('hydrating-hyaluronic-serum')) {
    if (isBodyOrHair) return { compatible: false, reason: 'hyaluronic_serum_need_body_or_hair_mismatch' };
    if (candidateEyeOrLashArea) return { compatible: false, reason: 'hyaluronic_serum_need_eye_area_mismatch' };
    if (!tokenSetHasAny(candidateTokens, ['serum', 'drops'])) {
      return { compatible: false, reason: 'hyaluronic_serum_need_missing_serum_form' };
    }
    if (!tokenSetHasAny(candidateTokens, ['hyaluronic', 'hyaluronic acid', 'sodium hyaluronate', 'ha'])) {
      return { compatible: false, reason: 'hyaluronic_serum_need_missing_hyaluronic_evidence' };
    }
  }

  if (needId.includes('azelaic-acid-calming')) {
    if (isBodyOrHair) return { compatible: false, reason: 'azelaic_calming_need_body_or_hair_mismatch' };
    if (!tokenSetHasAny(candidateTokens, ['azelaic', 'azelaic acid'])) {
      return { compatible: false, reason: 'azelaic_calming_need_missing_azelaic_evidence' };
    }
    if (!tokenSetHasAny(candidateTokens, ['calm', 'calming', 'redness', 'sensitive', 'soothing'])) {
      return { compatible: false, reason: 'azelaic_calming_need_missing_calming_evidence' };
    }
  }

  if (needId.includes('gentle-cream-cleanser')) {
    if (isBodyOrHair) return { compatible: false, reason: 'gentle_cleanser_need_body_or_hair_mismatch' };
    if (!tokenSetHasAny(candidateTokens, ['cleanser', 'cleansing', 'wash'])) {
      return { compatible: false, reason: 'gentle_cleanser_need_missing_cleanser_form' };
    }
    if (!tokenSetHasAny(candidateTokens, ['gentle', 'sensitive', 'cream', 'milky', 'milk'])) {
      return { compatible: false, reason: 'gentle_cleanser_need_missing_gentle_evidence' };
    }
  }

  if (needId.includes('ceramide-rich-moisturizer')) {
    if (candidateEyeOrLashArea) return { compatible: false, reason: 'ceramide_moisturizer_need_eye_area_mismatch' };
    if (candidateTokens.has('hair') || candidateTokens.has('scalp') || candidateCategory.startsWith('hair')) {
      return { compatible: false, reason: 'ceramide_moisturizer_need_hair_mismatch' };
    }
    if (!tokenSetHasAny(candidateTokens, ['moisturizer', 'moisturiser', 'cream', 'lotion'])) {
      return { compatible: false, reason: 'ceramide_moisturizer_need_missing_moisturizer_form' };
    }
    if (!tokenSetHasAny(candidateTokens, ['ceramide', 'barrier', 'repair'])) {
      return { compatible: false, reason: 'ceramide_moisturizer_need_missing_ceramide_evidence' };
    }
  }

  if (needId.includes('sensitive-bha-exfoliant')) {
    if (isBodyOrHair) return { compatible: false, reason: 'sensitive_bha_need_body_or_hair_mismatch' };
    if (!tokenSetHasAny(candidateTokens, ['bha', 'salicylic', 'salicylic acid', 'exfoliant', 'exfoliating'])) {
      return { compatible: false, reason: 'sensitive_bha_need_missing_bha_evidence' };
    }
    if (!tokenSetHasAny(candidateTokens, ['sensitive', 'gentle', 'acne', 'blemish'])) {
      return { compatible: false, reason: 'sensitive_bha_need_missing_sensitive_evidence' };
    }
  }

  if (needId.includes('lip-barrier-balm')) {
    if (!tokenSetHasAny(candidateTokens, ['lip', 'lips'])) {
      return { compatible: false, reason: 'lip_barrier_need_missing_lip_area' };
    }
    if (!tokenSetHasAny(candidateTokens, ['balm', 'butter', 'mask', 'oil'])) {
      return { compatible: false, reason: 'lip_barrier_need_missing_balm_form' };
    }
    if (!tokenSetHasAny(candidateTokens, ['barrier', 'repair', 'ceramide', 'hydrating', 'hydration'])) {
      return { compatible: false, reason: 'lip_barrier_need_missing_barrier_evidence' };
    }
  }

  if (needId.includes('tubing-mascara-sensitive-eyes')) {
    if (!tokenSetHasAny(candidateTokens, ['mascara', 'lash'])) {
      return { compatible: false, reason: 'tubing_mascara_need_missing_mascara_form' };
    }
    if (!tokenSetHasAny(candidateTokens, ['tubing', 'sensitive', 'gentle'])) {
      return { compatible: false, reason: 'tubing_mascara_need_missing_tubing_or_sensitive_evidence' };
    }
  }

  if (needId.includes('non-comedogenic-gel-moisturizer')) {
    if (isBodyOrHair) return { compatible: false, reason: 'noncomedogenic_gel_need_body_or_hair_mismatch' };
    const hasMoisturizerForm = tokenSetHasAny(candidateTokens, ['moisturizer', 'moisturiser', 'cream', 'water cream', 'gel cream', 'gel-cream']);
    const hasGelOrLightweightModifier = tokenSetHasAny(candidateTokens, ['gel', 'water cream', 'gel cream', 'gel-cream', 'lightweight', 'oil control', 'oil-control', 'mattifying']);
    if (!hasMoisturizerForm || !hasGelOrLightweightModifier) {
      return { compatible: false, reason: 'noncomedogenic_gel_need_missing_gel_moisturizer_form' };
    }
    if (!tokenSetHasAny(candidateTokens, ['non comedogenic', 'non-comedogenic', 'oil free', 'oil-free', 'acne', 'oily'])) {
      return { compatible: false, reason: 'noncomedogenic_gel_need_missing_noncomedogenic_evidence' };
    }
  }

  if (needId.includes('fragrance-free-body-lotion')) {
    if (!candidateTokens.has('body') && !candidateCategory.startsWith('body')) {
      return { compatible: false, reason: 'body_lotion_need_missing_body_area' };
    }
    if (!tokenSetHasAny(candidateTokens, ['lotion', 'cream', 'butter', 'milk'])) {
      return { compatible: false, reason: 'body_lotion_need_missing_lotion_form' };
    }
    if (!tokenSetHasAny(candidateTokens, ['fragrance free', 'fragrance-free', 'unscented', 'sensitive'])) {
      return { compatible: false, reason: 'body_lotion_need_missing_fragrance_free_evidence' };
    }
  }

  const sharedStrongTokens = sharedGroups(
    filteredGroups(needTokens, STRONG_USE_CASE_TOKENS),
    filteredGroups(candidateTokens, STRONG_USE_CASE_TOKENS),
  );
  if (!sharedStrongTokens.length && Number(candidate.score_total || candidate.similarity_score || 0) < 0.85) {
    return { compatible: false, reason: 'need_candidate_weak_overlap' };
  }
  return { compatible: true, reason: '' };
}

function inferRelationship(anchorSnapshot, candidateSnapshot, candidate = {}) {
  const anchorBrand = relationshipInternals.extractBrand(anchorSnapshot);
  const candidateBrand = relationshipInternals.extractBrand(candidateSnapshot);
  const sameBrand = Boolean(anchorBrand && candidateBrand && anchorBrand === candidateBrand);
  const categoryScore = extractScore(
    candidate,
    ['category_use_case_match', 'category_match', 'categoryMatch'],
    jaccard(anchorSnapshot.category_taxonomy || anchorSnapshot.category, candidateSnapshot.category_taxonomy || candidateSnapshot.category),
  );
  const ingredientScore = extractScore(candidate, ['ingredient_functional_similarity', 'ingredient_similarity'], 0);
  const explicitSim = extractScore(candidate, ['similarity_score', 'similarityScore', 'score_total'], 0);
  // The sources scorer already folds ingredient / category evidence into similarity_score; taking
  // the max over its components again let an identical tag list (ingredient 1.0) saturate the edge.
  const scoreTotal = explicitSim > 0 ? explicitSim : Math.max(ingredientScore, categoryScore * 0.75);
  // No ratio across two currencies, or with either currency unknown: without it no edge is a dupe
  // ("lower-priced") and price_advantage is 0.
  const priceRatio = comparablePriceRatio(anchorPriceOf(anchorSnapshot), candidatePriceOf(candidateSnapshot, candidate));
  const setCompatibility = setCompositionCompatibility(anchorSnapshot, candidateSnapshot);
  const formCompatibility = productFormCompatibility(anchorSnapshot, candidateSnapshot);
  const jobCompatibility = productJobCompatibility(anchorSnapshot, candidateSnapshot);
  const leafCompatibility = leafCategoryCompatibility(anchorSnapshot, candidateSnapshot);
  const useCaseAlignment = hasSpecificUseCaseAlignment(anchorSnapshot, candidateSnapshot, { ingredientScore });

  if (isOutOfScopeBeautyProduct(anchorSnapshot) || isOutOfScopeBeautyProduct(candidateSnapshot)) {
    return {
      relation_type: 'rejected',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      scopeCompatibility: { compatible: false, reason: 'non_beauty_merch_scope' },
      setCompatibility,
      formCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  // Identity has one owner. Any brand may list the same product; a variant is never a recommendation.
  const identity = compareProductIdentity(anchorSnapshot, candidateSnapshot);
  if (identity.relation === IDENTITY.SAME_PRODUCT) {
    return {relation_type: 'rejected', categoryScore, ingredientScore, scoreTotal, priceRatio, identity,
      utilityCompatibility: {compatible: false, reason: 'same_product_listing_or_size'}};
  }
  if (identity.relation === IDENTITY.SAME_FAMILY_VARIANT) {
    return { relation_type: 'rejected', categoryScore, ingredientScore, scoreTotal, priceRatio, identity,
      utilityCompatibility: { compatible: false, reason: 'same_family_variant' } };
  }
  if (sameBrand) {
    // related_product means complement, and the reviewer judges it with the same policy:
    // a same-brand pair for one shopper job is a competitive_alternative; known, different
    // routine roles make a related_product candidate; anything else claims no relation.
    const aRole = routineRole(anchorSnapshot); const bRole = routineRole(candidateSnapshot);
    const sameRole = !aRole || !bRole || aRole === bRole;
    const substitutable = sameRole && setCompatibility.compatible && formCompatibility.compatible &&
      jobCompatibility.compatible && leafCompatibility.compatible && useCaseAlignment.aligned && categoryScore >= 0.55;
    const routineRelation = classifyComplementPair(anchorSnapshot, candidateSnapshot, { substitutable });
    const metrics = { categoryScore, ingredientScore, scoreTotal, priceRatio, identity, setCompatibility,
      formCompatibility, jobCompatibility, leafCompatibility, useCaseAlignment, routineRelation };
    // An alternative needs the builder's own substitution evidence, not only a shared role word.
    if (substitutable) return { relation_type: 'competitive_alternative', ...metrics };
    if (routineRelation.kind === 'same_job') {
      return { relation_type: 'rejected', ...metrics, utilityCompatibility: { compatible: false, reason: 'same_job_not_substitutable' } };
    }
    if (routineRelation.kind === 'complement') return { relation_type: 'related_product', ...metrics };
    return { relation_type: 'rejected', ...metrics,
      utilityCompatibility: { compatible: false, reason: 'related_product_without_complement_roles' } };
  }
  if (!setCompatibility.compatible) {
    return {
      relation_type: 'rejected',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      formCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  if (!jobCompatibility.compatible) {
    return {
      relation_type: 'rejected',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      formCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  if (!formCompatibility.compatible) {
    return {
      relation_type: 'rejected',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      formCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  if (!leafCompatibility.compatible) {
    return {
      relation_type: 'rejected',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      formCompatibility,
      jobCompatibility,
      leafCompatibility,
      useCaseAlignment,
    };
  }
  if (!useCaseAlignment.aligned) {
    return {
      relation_type: 'rejected',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      jobCompatibility,
      useCaseAlignment,
    };
  }
  const productEvidence = sharedProductEvidence(anchorSnapshot, candidateSnapshot);
  const inciOverlap = ingredientOverlap(anchorSnapshot, candidateSnapshot);
  const inciRefutes = inciOverlap != null && inciOverlap < DUPE_MIN_INCI_OVERLAP;
  // Names/category can retrieve an alternative; they cannot establish a dupe.
  // A curated pair or two substantial INCI lists are required even for inference.
  const dupeEvidence = hasCuratedDupeEvidence(candidate, anchorSnapshot, candidateSnapshot) ||
    (inciOverlap != null && inciOverlap >= DUPE_MIN_INCI_OVERLAP && productEvidence.count >= DUPE_MIN_SHARED_PRODUCT_TOKENS);
  if (dupeEvidence && !inciRefutes && categoryScore >= 0.55 && scoreTotal >= DUPE_MIN_SCORE_TOTAL && priceRatio != null && priceRatio <= 1.0) {
    return {
      relation_type: 'dupe',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      jobCompatibility,
      leafCompatibility,
      useCaseAlignment,
      productEvidence,
      inciOverlap,
    };
  }
  if (categoryScore >= 0.55) {
    return {
      relation_type: 'competitive_alternative',
      categoryScore,
      ingredientScore,
      scoreTotal,
      priceRatio,
      setCompatibility,
      jobCompatibility,
      leafCompatibility,
      useCaseAlignment,
    };
  }
  return {
    relation_type: 'rejected',
    categoryScore,
    ingredientScore,
    scoreTotal,
    priceRatio,
    setCompatibility,
    jobCompatibility,
    useCaseAlignment,
  };
}

const stripClaims = {
  snapshot: (snapshot, fields) => neutralizeSnapshotClaims(snapshot, fields),
  value: (value) => neutralizeClaimValue(value),
};
const keepClaims = {
  snapshot: (snapshot) => snapshot,
  value: (value) => value,
};

// why_candidate is user-visible; stripping must never leave its summary empty or its reasons list
// empty.
const DEFAULT_REASONS_USER_VISIBLE = ['Category/use-case evidence is aligned.', 'Source provenance is available.'];

function withSummaryFallback(why, fallbackSummary, fallbackReasons = DEFAULT_REASONS_USER_VISIBLE) {
  if (!isPlainObject(why)) return { summary: fallbackSummary, reasons_user_visible: fallbackReasons };
  const out = { ...why };
  if (!normalizeString(out.summary, 2000)) out.summary = fallbackSummary;
  if (Array.isArray(why.reasons_user_visible) && !why.reasons_user_visible.some((item) => normalizeString(item, 2000))) {
    out.reasons_user_visible = fallbackReasons;
  }
  return out;
}

function buildEdgeForCandidate({ anchor, candidate, market = 'US', nowIso, reviewStatus = 'pending' } = {}) {
  const anchorNorm = normalizeProductSnapshot(anchor);
  const candidateNorm = normalizeProductSnapshot(candidate);
  if (!anchorNorm.product_ref || !candidateNorm.product_ref) {
    return {
      edge: null,
      errors: ['missing_anchor_or_candidate_ref'],
    };
  }
  const inferred = inferRelationship(anchorNorm.snapshot, candidateNorm.snapshot, candidate);
  if (inferred.relation_type === 'rejected') {
    return {
      edge: null,
      errors: ['candidate_below_relationship_threshold'],
      metrics: inferred,
    };
  }
  const anchorPrice = anchorPriceOf(anchorNorm.snapshot);
  const candidatePrice = candidatePriceOf(candidateNorm.snapshot, candidate);
  const observedAt = normalizeString(candidate.price_observed_at || candidate.priceObservedAt || candidate.observed_at || nowIso);
  const sourceRefs = buildSourceRefs(candidate);
  // Social proof a social / review source_ref supports is a sourced claim; the audit accepts it and
  // the builder keeps it. Only unsourced social proof is stripped from the stored text.
  const claims = hasSupportingSocialSource(sourceRefs) ? keepClaims : stripClaims;
  const defaultSummary = inferred.relation_type === 'dupe'
    ? 'Lower-priced alternative with similar category and function signals.'
    : inferred.relation_type === 'related_product'
      ? 'Possible routine companion; complementary usage requires review.'
      : 'Possible alternative with matching product job; differences require review.';
  const edge = coerceRelationshipEdge({
    anchor_type: 'product',
    anchor_ref: anchorNorm.product_ref,
    anchor_snapshot: claims.snapshot(anchorNorm.snapshot, ANCHOR_CLAIM_FIELDS),
    candidate_product_ref: candidateNorm.product_ref,
    candidate_snapshot: claims.snapshot(candidateNorm.snapshot, CANDIDATE_CLAIM_FIELDS),
    relation_type: inferred.relation_type,
    market,
    category_taxonomy: candidate.category_taxonomy || candidate.categoryTaxonomy || candidateNorm.snapshot.category_taxonomy || candidateNorm.snapshot.category,
    use_case: normalizeString(candidate.use_case || candidate.useCase || candidateNorm.snapshot.use_case || candidateNorm.snapshot.category, 240),
    score_total: inferred.scoreTotal,
    score_breakdown: {
      category_use_case_match: inferred.categoryScore,
      ingredient_functional_similarity: inferred.ingredientScore,
      price_advantage: inferred.priceRatio == null ? 0 : clamp01(1 - Math.min(inferred.priceRatio, 1)),
      evidence_quality: extractScore(candidate, ['evidence_quality'], 0.65),
      availability_confidence: extractScore(candidate, ['availability_confidence'], 0.7),
      social_reference_strength: extractScore(candidate, ['social_reference_strength'], 0),
      score_total: inferred.scoreTotal,
    },
    // Each amount carries its own currency (null = unknown). The currency keys also mark the
    // evidence as currency-aware: validation never rebuilds a price_ratio the builder refused.
    price_evidence: {
      anchor_price_amount: anchorPrice.amount,
      anchor_price_currency: anchorPrice.currency,
      candidate_price_amount: candidatePrice.amount,
      candidate_price_currency: candidatePrice.currency,
      price_ratio: inferred.priceRatio,
      observed_at: observedAt,
    },
    source_refs: sourceRefs,
    evidence_grade: candidate.evidence_grade || candidate.evidenceGrade || 'B',
    review_status: reviewStatus,
    why_candidate: isPlainObject(candidate.why_candidate || candidate.whyCandidate)
      ? withSummaryFallback(claims.value(candidate.why_candidate || candidate.whyCandidate), defaultSummary)
      : {
        summary: defaultSummary,
        reasons_user_visible: ['Category/use-case evidence is aligned.', 'Source provenance is available.'],
      },
    tradeoffs: Array.isArray(candidate.tradeoffs) ? claims.value(candidate.tradeoffs) : [],
    watchouts: Array.isArray(candidate.watchouts) ? claims.value(candidate.watchouts) : [],
    provenance: {
      pipeline: 'product_relationship_graph_builder.v1',
      generated_at: nowIso,
      ...(hasCuratedDupeEvidence(candidate, anchorNorm.snapshot, candidateNorm.snapshot)
        ? {curated_pair_evidence: candidate.curated_pair_evidence} : {}),
    },
    last_verified_at: candidate.last_verified_at || candidate.lastVerifiedAt || null,
    expires_at: candidate.expires_at || candidate.expiresAt || null,
  });
  const validation = validateRelationshipEdge(edge, { nowMs: new Date(nowIso).getTime() });
  return {
    edge: validation.value,
    errors: validation.errors,
    metrics: inferred,
  };
}

function buildNicheSpecialistEdge({ need, candidate, market = 'US', nowIso, reviewStatus = 'pending' } = {}) {
  const needObj = isPlainObject(need) ? need : {};
  const candidateNorm = normalizeProductSnapshot(candidate);
  const needCompatibility = needCandidateCompatibility(needObj, candidateNorm.snapshot, candidate);
  if (!needCompatibility.compatible) {
    return {
      edge: null,
      errors: ['candidate_below_relationship_threshold'],
      metrics: { needCompatibility },
    };
  }
  const nicheSourceRefs = buildSourceRefs(candidate);
  const nicheClaims = hasSupportingSocialSource(nicheSourceRefs) ? keepClaims : stripClaims;
  const nicheSummary = `Specialist candidate for ${normalizeString(needObj.label || needObj.need_id)}.`;
  const nichePrice = readPriceWithCurrency([[candidateNorm.snapshot, 'price'], [candidate, 'price']], toNumberOrNull);
  const edge = coerceRelationshipEdge({
    anchor_type: 'need',
    anchor_ref: normalizeString(needObj.need_id || needObj.id || needObj.label, 260),
    anchor_snapshot: needObj,
    candidate_product_ref: candidateNorm.product_ref,
    candidate_snapshot: nicheClaims.snapshot(candidateNorm.snapshot, CANDIDATE_CLAIM_FIELDS),
    relation_type: 'niche_specialist',
    market,
    category_taxonomy: needObj.category_taxonomy || needObj.categoryTaxonomy,
    use_case: normalizeString(needObj.label || needObj.use_case || needObj.useCase, 240),
    score_total: extractScore(candidate, ['score_total', 'similarity_score'], 0.72),
    score_breakdown: {
      category_use_case_match: extractScore(candidate, ['category_use_case_match', 'category_match'], 0.65),
      ingredient_functional_similarity: extractScore(candidate, ['ingredient_functional_similarity', 'ingredient_similarity'], 0.6),
      evidence_quality: extractScore(candidate, ['evidence_quality'], 0.7),
      availability_confidence: extractScore(candidate, ['availability_confidence'], 0.7),
      score_total: extractScore(candidate, ['score_total', 'similarity_score'], 0.72),
    },
    price_evidence: {
      candidate_price_amount: nichePrice.amount,
      candidate_price_currency: nichePrice.currency,
      observed_at: normalizeString(candidate.price_observed_at || candidate.priceObservedAt || candidate.observed_at || nowIso),
    },
    source_refs: nicheSourceRefs,
    evidence_grade: candidate.evidence_grade || candidate.evidenceGrade || needObj.evidence_grade_min || 'B',
    review_status: reviewStatus,
    why_candidate: isPlainObject(candidate.why_candidate || candidate.whyCandidate)
      ? withSummaryFallback(nicheClaims.value(candidate.why_candidate || candidate.whyCandidate), nicheSummary, ['Need-specific tags and source evidence are available.'])
      : {
        summary: nicheSummary,
        reasons_user_visible: ['Need-specific tags and source evidence are available.'],
      },
    tradeoffs: Array.isArray(candidate.tradeoffs) ? candidate.tradeoffs : [],
    watchouts: Array.isArray(candidate.watchouts) ? candidate.watchouts : [],
    provenance: {
      pipeline: 'product_relationship_graph_builder.v1',
      generated_at: nowIso,
    },
    last_verified_at: candidate.last_verified_at || candidate.lastVerifiedAt || null,
    expires_at: candidate.expires_at || candidate.expiresAt || null,
  });
  const validation = validateRelationshipEdge(edge, { nowMs: new Date(nowIso).getTime() });
  return {
    edge: validation.value,
    errors: validation.errors,
    metrics: { needCompatibility },
  };
}

function edgeIdentity(edge) {
  return [
    normalizeLower(edge.market),
    normalizeLower(edge.anchor_type),
    normalizeLower(edge.anchor_ref),
    normalizeLower(edge.candidate_product_ref),
    normalizeLower(edge.relation_type),
  ].join('|');
}

function dedupeEdgesByIdentity(edges) {
  const byKey = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge) continue;
    const key = edgeIdentity(edge);
    const previous = byKey.get(key);
    if (!previous || Number(edge.score_total || 0) > Number(previous.score_total || 0)) {
      byKey.set(key, edge);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => Number(b.score_total || 0) - Number(a.score_total || 0));
}

// Bound how many anchors one candidate may serve as a dupe / competitive_alternative IN THIS BUILD
// (see DEFAULT_MAX_ANCHORS_PER_CANDIDATE for why this is not a global cap). Input edges
// arrive score-sorted from dedupeEdgesByIdentity; within one candidate the best-scoring anchors are
// kept, ties broken by anchor_ref so a rerun over the same input keeps the same edges. Other
// relation types (related_product, niche_specialist) are never capped: a same-brand sibling or a
// need node is expected to fan in.
function capCandidateFanIn(edges, { maxAnchorsPerCandidate = DEFAULT_MAX_ANCHORS_PER_CANDIDATE } = {}) {
  const cap = Math.max(1, Math.floor(Number(maxAnchorsPerCandidate) || DEFAULT_MAX_ANCHORS_PER_CANDIDATE));
  const list = Array.isArray(edges) ? edges : [];
  const ranked = list
    .map((edge, index) => ({ edge, index }))
    .sort((a, b) =>
      Number(b.edge.score_total || 0) - Number(a.edge.score_total || 0) ||
      normalizeLower(a.edge.anchor_ref).localeCompare(normalizeLower(b.edge.anchor_ref)) ||
      a.index - b.index);
  const served = new Map();
  const dropIndexes = new Set();
  const dropped = [];
  for (const { edge, index } of ranked) {
    if (!FAN_IN_CAPPED_RELATION_TYPES.has(edge.relation_type)) continue;
    const key = normalizeLower(edge.candidate_product_ref);
    const count = Number(served.get(key) || 0) + 1;
    served.set(key, count);
    if (count <= cap) continue;
    dropIndexes.add(index);
    dropped.push({
      anchor_ref: edge.anchor_ref,
      candidate_ref: edge.candidate_product_ref,
      errors: ['candidate_fan_in_cap_per_build'],
      metrics: { relation_type: edge.relation_type, score_total: edge.score_total, fan_in_rank: count, cap },
    });
  }
  let maxFanIn = 0;
  for (const count of served.values()) maxFanIn = Math.max(maxFanIn, count);
  return {
    kept: list.filter((edge, index) => !dropIndexes.has(index)),
    dropped,
    max_fan_in_before_cap: maxFanIn,
    cap,
  };
}

function buildProductRelationshipGraphDryRun({
  anchors = [],
  candidatesByAnchor = {},
  needCandidatesById = {},
  needs = CURATED_NEED_NODES,
  market = 'US',
  now = new Date(),
  reviewStatus = 'pending',
  limit = 200,
  maxAnchorsPerCandidate = DEFAULT_MAX_ANCHORS_PER_CANDIDATE,
} = {}) {
  const nowIso = new Date(now).toISOString();
  const edges = [];
  const rejected_edges = [];
  const anchorRows = (Array.isArray(anchors) ? anchors : []).slice(0, Math.max(1, Number(limit) || 200));
  for (const anchor of anchorRows) {
    const anchorNorm = normalizeProductSnapshot(anchor);
    const lookupKeys = [
      anchorNorm.product_ref,
      anchorNorm.product_ref.replace(/^product:/, ''),
      normalizeString(anchor.id || anchor.product_id || anchor.productId || anchor.url),
    ].filter(Boolean);
    const candidates = lookupKeys.flatMap((key) => (Array.isArray(candidatesByAnchor[key]) ? candidatesByAnchor[key] : []));
    const seenCandidate = new Set();
    const familyDedupeIndex = createFamilyDedupeIndex();
    for (const candidate of candidates) {
      const candidateNorm = normalizeProductSnapshot(candidate);
      const familyKey = familyIdentityKey(candidate);
      const dedupeKey = resolveFamilyDedupeKey(familyDedupeIndex, familyKey);
      if (dedupeKey && seenCandidate.has(dedupeKey)) {
        rememberFamilyDedupeKey(familyDedupeIndex, dedupeKey, familyKey);
        continue;
      }
      if (dedupeKey) {
        seenCandidate.add(dedupeKey);
        rememberFamilyDedupeKey(familyDedupeIndex, dedupeKey, familyKey);
      }
      const built = buildEdgeForCandidate({ anchor, candidate, market, nowIso, reviewStatus });
      if (built.edge && !built.errors.length) {
        edges.push(built.edge);
      } else {
        rejected_edges.push({
          anchor_ref: anchorNorm.product_ref,
          candidate_ref: candidateNorm.product_ref,
          errors: built.errors,
          metrics: built.metrics || null,
        });
      }
    }
  }

  for (const need of Array.isArray(needs) ? needs : []) {
    const needId = normalizeString(need.need_id || need.id || need.label);
    const candidates = Array.isArray(needCandidatesById[needId]) ? needCandidatesById[needId] : [];
    for (const candidate of candidates) {
      const built = buildNicheSpecialistEdge({ need, candidate, market, nowIso, reviewStatus });
      if (built.edge && !built.errors.length) {
        edges.push(built.edge);
      } else {
        rejected_edges.push({
          anchor_ref: needId,
          candidate_ref: normalizeProductSnapshot(candidate).product_ref,
          errors: built.errors,
        });
      }
    }
  }

  const fanIn = capCandidateFanIn(dedupeEdgesByIdentity(edges), { maxAnchorsPerCandidate });
  rejected_edges.push(...fanIn.dropped);
  const deduped = fanIn.kept;
  const anchorsWithApprovedAlternative = new Set(
    deduped
      .filter((edge) => ['dupe', 'competitive_alternative'].includes(edge.relation_type))
      .map((edge) => edge.anchor_ref),
  );
  const review_packets = deduped.map((edge) => ({
    edge_id: edge.id,
    anchor_ref: edge.anchor_ref,
    candidate_product_ref: edge.candidate_product_ref,
    relation_type: edge.relation_type,
    display_label: edge.display_label,
    score_total: edge.score_total,
    evidence_grade: edge.evidence_grade,
    source_refs: edge.source_refs,
    why_candidate: edge.why_candidate,
    review_status: edge.review_status,
  }));

  return {
    summary: {
      market,
      anchor_count: anchorRows.length,
      edge_count: deduped.length,
      rejected_count: rejected_edges.length,
      anchors_with_alternative_count: anchorsWithApprovedAlternative.size,
      proposed_candidate_brand_distribution: deduped.reduce((out, edge) => {
        const brand = relationshipInternals.extractBrand(edge.candidate_snapshot) || 'unknown';
        out[brand] = (out[brand] || 0) + 1; return out;
      }, {}),
      variant_rejected_count: rejected_edges.filter((row) => row.metrics?.utilityCompatibility?.reason === 'same_family_variant').length,
      niche_specialist_count: deduped.filter((edge) => edge.relation_type === 'niche_specialist').length,
      max_anchors_per_candidate_per_build: fanIn.cap,
      max_fan_in_before_cap_per_build: fanIn.max_fan_in_before_cap,
      fan_in_capped_count_per_build: fanIn.dropped.length,
      relation_counts: deduped.reduce((acc, edge) => {
        acc[edge.relation_type] = Number(acc[edge.relation_type] || 0) + 1;
        return acc;
      }, {}),
      generated_at: nowIso,
    },
    edges: deduped,
    rejected_edges,
    review_packets,
  };
}

module.exports = {
  CURATED_NEED_NODES,
  DEFAULT_MAX_ANCHORS_PER_CANDIDATE,
  normalizeProductSnapshot,
  buildEdgeForCandidate,
  buildNicheSpecialistEdge,
  dedupeEdgesByIdentity,
  capCandidateFanIn,
  buildProductRelationshipGraphDryRun,
  __internal: {
    inferRelationship,
    jaccard,
    normalizeTokens,
    hasSpecificUseCaseAlignment,
    productFormCompatibility,
    setCompositionCompatibility,
    productJobCompatibility,
    leafCategoryCompatibility,
    snapshotLeafProfile,
    needCandidateCompatibility,
    isOutOfScopeBeautyProduct,
    treatmentFunctionCompatibility,
    accessoryKind,
    isSetLikeProduct,
    brushTargets,
  },
};
