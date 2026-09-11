const RECOMMENDATION_STEP_RESOLUTION_RULES_V1 = 'recommendation_step_resolution_rules_v1';

const STEP_PATTERNS = Object.freeze([
  // MAKEUP AND FRAGRANCE ARE STEPS, not gaps. This vocabulary was nine skincare steps, and every
  // consumer of it treated "no step" as "nothing to look for": normalizeRecoTargetStep('bronzer')
  // returned null, so buildSameFamilyQueryLevels returned [] and the grounding pass ran ZERO queries
  // for a makeup archetype -- it was never failing to find bronzers, it was never searching. Worse,
  // 'cream blush' fell through to the moisturizer patterns and was grounded against moisturizers.
  //
  // The widened prompt (reco_main_v1_3) recommends makeup and fragrance, so the taxonomy the answer
  // is resolved against has to know they exist. Ordered before the skincare entries that would
  // otherwise capture them: 'cream blush' and 'powder foundation' both contain skincare tokens.
  {
    step: 'blush',
    patterns: [/\b(cream blush|powder blush|liquid blush|blush stick|cheek tint|cheek colou?r|blush)\b/i, /腮红/, /胭脂/],
  },
  {
    step: 'bronzer',
    // `bronzing` ALONE IS A FINISH, NOT A CATEGORY. "Firming-Lifting Cream ... cues around bronzing
    // or contour definition" is a moisturiser, and bare `bronzing` cost it its step.
    patterns: [/\b(bronzer|bronzing (?:powder|drops|cream|balm|milk|lotion|stick|serum)|contour powder|contour stick|contouring powder)\b/i, /修容/, /古铜/],
  },
  {
    step: 'highlighter',
    patterns: [/\b(highlighter|illuminator|luminizer|strobe cream)\b/i, /高光/],
  },
  {
    step: 'foundation',
    patterns: [/\b(foundation|skin tint|bb cream|cc cream|tinted moisturi[sz]er|base makeup)\b/i, /粉底/, /气垫/, /隔离/],
  },
  {
    step: 'concealer',
    patterns: [/\b(concealer|colou?r correct(or|ing)|under[- ]?eye corrector)\b/i, /遮瑕/],
  },
  {
    step: 'face_powder',
    patterns: [/\b(setting powder|finishing powder|loose powder|pressed powder|translucent powder|face powder)\b/i, /散粉/, /定妆粉/, /蜜粉/],
  },
  {
    step: 'primer',
    patterns: [/\b(makeup primer|face primer|pore primer|primer)\b/i, /妆前乳/],
  },
  {
    step: 'lip_colour',
    patterns: [/\b(lipstick|lip gloss|lip liner|lip tint|lip stain|lip lacquer|liquid lip)\b/i, /口红/, /唇釉/, /唇彩/, /唇线/],
  },
  {
    step: 'eye_colour',
    // NOT bare `eyebrow`: "Moon Boost Eyebrow and Lash Serum" is a growth serum, not eye colour.
    patterns: [/\b(eyeshadow|eye shadow|eyeshadow palette|eyeliner|eye liner|mascara|brow pencil|brow gel)\b/i, /眼影/, /眼线/, /睫毛膏/, /眉笔/],
  },
  {
    step: 'fragrance',
    patterns: [/\b(fragrance|perfume|parfum|eau de parfum|eau de toilette|cologne|body mist|body spray|edp|edt)\b/i, /香水/, /淡香/],
  },
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
      // BARE `cream` AND `lotion` ARE MODIFIERS AS OFTEN AS THEY ARE PRODUCTS. 'cream blush' and
      // 'cream bronzer' name a makeup texture, not a moisturizer; before makeup existed in this
      // taxonomy 'cream blush' resolved to `moisturizer` and was grounded against moisturizers.
      // Matching both now makes it ambiguous, and extractRecoTargetStepFromText returns null on
      // ambiguity -- safe, but it loses a step the buyer named. The noun wins.
      /\b(moisturizer|moisturiser|face cream|gel cream|gel-cream|emulsion|water cream|day cream|night cream)\b/i,
      /\b(cream|lotion)\b(?!\s*(blush|bronzer|highlighter|shadow|eyeshadow|foundation|concealer|liner|lipstick|lip))/i,
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
      // MICELLAR WATER AND CLEANSING BALMS ARE CLEANSERS. Their absence was invisible while nothing
      // else in the sentence resolved; once `mascara` became a step, "micellar water that takes off
      // waterproof mascara" had exactly one match and it was the makeup the buyer wants REMOVED.
      /\b(cleanser|face wash|facial wash|cleansing gel|cleansing foam|cleansing milk|cleansing balm|cleansing oil|cleansing water|micellar water|makeup remover|cleansing cream)\b/i,
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
  // Makeup families are grouped by what a buyer would accept as a near-substitute, the same test the
  // skincare families use. A bronzer and a blush are adjacent; a bronzer and a mascara are not.
  blush: Object.freeze({ same_family: ['blush'], adjacent_family: ['bronzer', 'highlighter'] }),
  bronzer: Object.freeze({ same_family: ['bronzer'], adjacent_family: ['blush', 'face_powder', 'highlighter'] }),
  highlighter: Object.freeze({ same_family: ['highlighter'], adjacent_family: ['blush', 'bronzer'] }),
  foundation: Object.freeze({ same_family: ['foundation'], adjacent_family: ['concealer', 'face_powder', 'primer'] }),
  concealer: Object.freeze({ same_family: ['concealer'], adjacent_family: ['foundation', 'face_powder'] }),
  face_powder: Object.freeze({ same_family: ['face_powder'], adjacent_family: ['foundation', 'bronzer'] }),
  primer: Object.freeze({ same_family: ['primer'], adjacent_family: ['foundation'] }),
  // No adjacent family: a lip colour is not an acceptable substitute for anything else, and nothing
  // is an acceptable substitute for it. Same for the eye and fragrance groups.
  lip_colour: Object.freeze({ same_family: ['lip_colour'], adjacent_family: [] }),
  eye_colour: Object.freeze({ same_family: ['eye_colour'], adjacent_family: [] }),
  fragrance: Object.freeze({ same_family: ['fragrance'], adjacent_family: [] }),
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

// WHICH DOMAIN A STEP BELONGS TO. One table, because the alternative is every consumer re-deciding
// "is bronzer makeup?" from its own word list -- and this vocabulary already exists in six places.
const STEP_DOMAIN_MAP = Object.freeze({
  blush: 'makeup', bronzer: 'makeup', highlighter: 'makeup', foundation: 'makeup',
  concealer: 'makeup', face_powder: 'makeup', primer: 'makeup',
  lip_colour: 'makeup', eye_colour: 'makeup',
  fragrance: 'fragrance',
});

function resolveRecoStepDomain(step) {
  const normalized = normalizeRecoTargetStep(step);
  if (!normalized) return '';
  return STEP_DOMAIN_MAP[normalized] || 'skincare';
}

const EXACT_ALIAS_MAP = Object.freeze({
  // EVERY CANONICAL STEP MUST NORMALISE TO ITSELF. The skincare steps get this for free -- each is a
  // single word its own pattern matches -- but a multi-word canonical name does not: before these
  // three lines normalizeRecoTargetStep('lip_colour') returned null, so a resolved lip step built an
  // EMPTY grounding ladder, which is the exact defect this taxonomy exists to remove, reintroduced
  // one layer up. Pinned by a test over CANONICAL_STEP_FAMILY_MAP rather than by these lines alone.
  lip_colour: 'lip_colour',
  eye_colour: 'eye_colour',
  face_powder: 'face_powder',
  blush: 'blush',
  'cream blush': 'blush',
  'powder blush': 'blush',
  'cheek tint': 'blush',
  bronzer: 'bronzer',
  'bronzing powder': 'bronzer',
  'contour powder': 'bronzer',
  contour: 'bronzer',
  highlighter: 'highlighter',
  illuminator: 'highlighter',
  foundation: 'foundation',
  'skin tint': 'foundation',
  'bb cream': 'foundation',
  'cc cream': 'foundation',
  concealer: 'concealer',
  'setting powder': 'face_powder',
  'loose powder': 'face_powder',
  'pressed powder': 'face_powder',
  'face powder': 'face_powder',
  primer: 'primer',
  'makeup primer': 'primer',
  lipstick: 'lip_colour',
  'lip gloss': 'lip_colour',
  'lip liner': 'lip_colour',
  'lip tint': 'lip_colour',
  mascara: 'eye_colour',
  eyeliner: 'eye_colour',
  eyeshadow: 'eye_colour',
  'eye shadow': 'eye_colour',
  'brow pencil': 'eye_colour',
  fragrance: 'fragrance',
  perfume: 'fragrance',
  'eau de parfum': 'fragrance',
  'eau de toilette': 'fragrance',
  cologne: 'fragrance',
  cleanser: 'cleanser',
  'micellar water': 'cleanser',
  'cleansing balm': 'cleanser',
  'cleansing oil': 'cleanser',
  'makeup remover': 'cleanser',
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
  // The canonical-name lookup runs on the RAW string, so an explicit step of 'fragrance' still
  // normalises to itself -- the mask below only ever sees free text that failed to be a step name.
  if (EXACT_ALIAS_MAP[raw]) return EXACT_ALIAS_MAP[raw];
  // A SECOND RESOLVER THAT DID NOT SHARE THE MASK IS A SECOND SET OF ANSWERS. This one takes the
  // first pattern that matches and the makeup entries are listed first, so
  // 'CeraVe Daily Moisturizing Lotion, Fragrance-Free' resolved `fragrance` here while the intent
  // resolver said `moisturizer` -- and ingredientSkuEvidence.resolveRecallCandidateStep calls THIS
  // one, on a bare title, before the intent resolver ever runs. 74 of the 91 skincare strings that
  // flipped to `fragrance` were denial phrasings.
  // THROUGH THE SAME COLLECTOR THE INTENT RESOLVER USES, not a private first-match loop. Sharing
  // only the MASK was half a fix: this function still took the first pattern in listing order while
  // extractRecoTargetStepFromText applied overlap, format and weak-surface resolution, so the two
  // disagreed on 24 corpus strings where main disagreed on none — 'PLAY Antioxidant Body Mist SPF
  // 30' was a `fragrance` here and a `sunscreen` there, and beautyRecoCoarseClassifier calls THIS
  // one. Two resolvers that disagree are two answers to a question that has one.
  // The ORIGINAL case, not `raw`. Lowercasing is right for the alias lookup above and wrong here:
  // the CJK patterns include /维A/, and a lowercased 维a does not match it.
  const details = collectHighConfidenceMatchDetails(normalizeText(value));
  return details.length === 1 ? details[0].step : null;
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

// PHRASES THAT NAME A CATEGORY IN ORDER TO DENY IT. "fragrance-free" is not a fragrance request, and
// "with alcohol and fragrance" is an ingredient list, not a category. Before `fragrance` was a step
// these read as nothing; now they read as a SECOND category, every such string goes ambiguous, and
// ambiguity resolves to no step at all. Measured over 12,818 strings drawn from this repo, that cost
// 61 strings their step -- and product titles reach this resolver too (beautyRecoCoarseClassifier's
// candidate salvage, ingredientSkuEvidence), so a fragrance-free moisturiser stopped being a
// moisturiser to the ranker. Masked with spaces rather than deleted so every match offset below
// still points at the original text.
const NON_CATEGORY_QUALIFIER_PATTERNS = Object.freeze([
  /\b(?:fragrance|perfume|parfum|scent)[-\s]?free\b/gi,
  /\bfree\s+of\s+(?:added\s+)?(?:fragrance|perfume|parfum)s?\b/gi,
  /\bwithout\s+(?:added\s+)?(?:fragrance|perfume|parfum)s?\b/gi,
  /\bno\s+(?:added\s+)?(?:fragrance|perfume|parfum)s?\b/gi,
  /\bnon[-\s]?fragranced?\b/gi,
  /\b(?:contains?|with|and)\s+(?:added\s+)?fragrances?\b/gi,
  // "fragrance oil" / "fragrance essential oil" is an ingredient, and the only reason it is here is
  // that it is the ingredient a buyer asks to AVOID.
  /\bfragrance\s+(?:essential\s+)?oils?\b/gi,
  /(?:不含|无添加|无)香精/g,
  // NAMING AN INGREDIENT YOU REACT TO IS NOT ORDERING IT. "fragrance usually stings" is a
  // sensitivity, and it made a Phoenix dry-heat sunscreen ask resolve to `fragrance` and go out on
  // the makeup supply lane. That string is a fixture in two suites here, both of which kept passing.
  /\bfragrances?\s+(?:usually\s+|often\s+|sometimes\s+|always\s+|really\s+)?(?:stings?|irritates?|bothers?|burns?|breaks? me out)/gi,
  /\b(?:sensitive|allergic|reactive)\s+to\s+(?:added\s+)?fragrances?\b/gi,
  /\bfragrance\s+(?:sensitivity|sensitive|allergy|allergies)\b/gi,
]);

// A CATEGORY NAMED AS WEAR CONTEXT IS NOT A REQUEST FOR IT. "a sunscreen that won't pill under my
// foundation" is a sunscreen ask; before this it matched both `sunscreen` and `foundation`, went
// ambiguous, and lost its step -- on /v1/chat, the highest-traffic lane, which derives step-aware
// intent from exactly this resolver. Measured: 16 of 28 realistic chat phrasings that mention the
// buyer's existing makeup lost their step. The tell is grammatical, not lexical: the category sits
// inside a prepositional or relative clause about wearing, layering or removing something else.
const MAKEUP_CONTEXT_NOUNS = 'foundation|concealer|mascara|eyeliner|eye liner|eyeshadow|eye shadow|lipstick|lip gloss|blush|bronzer|highlighter|primer|setting powder|face powder|brow pencil|makeup|make-up';
const CATEGORY_AS_CONTEXT_PATTERNS = Object.freeze([
  new RegExp(`\\b(?:under|underneath|beneath|over|on top of|before|after|with|without|alongside)\\s+(?:my |the |any |your )?(?:${MAKEUP_CONTEXT_NOUNS})\\b`, 'gi'),
  // A COORDINATED LIST IS STILL ONE CLAUSE. "removes mascara and eyeliner" names two categories and
  // requests neither; matching only the first left the second to make the ask ambiguous again.
  // UP TO TWO WORDS MAY SIT BETWEEN THE VERB AND THE NOUN. "takes off waterproof mascara" is a
  // cleanser ask, and matching only the adjacent form let `mascara` name a second category — the
  // shortlist for it was a mascara-boosting lash primer.
  new RegExp(`\\b(?:removes?|removing|remove|takes? off|breaks? down|dissolves?|creases?|crease|pills? under|wears? under)\\s+(?:my |the |any |your )?(?:\\w+\\s+){0,2}(?:${MAKEUP_CONTEXT_NOUNS})\\b(?:\\s*,?\\s*(?:and |or )?(?:my |the |your )?(?:${MAKEUP_CONTEXT_NOUNS})\\b)*`, 'gi'),
  new RegExp(`\\b(?:doubles?|works?|acts?)\\s+as\\s+an?\\s+(?:${MAKEUP_CONTEXT_NOUNS})\\b`, 'gi'),
  new RegExp(`\\b(?:i |we )?(?:use|uses|used|using|wear|wears|wearing)\\s+(?:my |the |any |your )?(?:${MAKEUP_CONTEXT_NOUNS})\\b`, 'gi'),
]);

// THE TWO MASKS ARE NOT INTERCHANGEABLE, and the difference decides whether a fallback is safe.
// A DENIAL ("fragrance-free") means the buyer does not want that category -- re-reading it is the
// original bug. A CONTEXT clause ("I wear blush") means the category is real but is describing what
// the buyer already owns, and if nothing else was named it IS the request.
function maskCategoryDenials(input) {
  let text = String(input || '');
  for (const pattern of NON_CATEGORY_QUALIFIER_PATTERNS) {
    text = text.replace(pattern, (match) => ' '.repeat(match.length));
  }
  return text;
}

function maskCategoryAsContext(input) {
  let text = String(input || '');
  for (const pattern of CATEGORY_AS_CONTEXT_PATTERNS) {
    text = text.replace(pattern, (match) => ' '.repeat(match.length));
  }
  return text;
}

function maskNonCategoryQualifiers(input) {
  return maskCategoryAsContext(maskCategoryDenials(input));
}

// TWO PATTERNS THAT MATCHED THE SAME WORDS HAVE NOT NAMED TWO CATEGORIES. 'tinted moisturizer' is
// matched by the foundation pattern over the whole phrase and by the moisturizer pattern over its
// last word; '隔离防晒' by sunscreen over all four characters and by foundation over the first two.
// Counting those as ambiguous discards a step the buyer plainly named. Overlap is the test, because
// it is the thing that distinguishes one head noun described twice from two nouns listed side by
// side -- 'cleanser, serum and moisturizer' still has no single step, and must not acquire one.
// A CLAIM PRINTED ON A COMPLEXION PRODUCT IS NOT A SUNSCREEN REQUEST. "SPF 50" appears on skin
// tints, foundations and primers; read as a category it turned "Hydrating Foundation Broad Spectrum
// SPF 50+" into a sunscreen on main, and into no step at all once `foundation` became a step it
// could disagree with.
//
// NARROW BY MEASUREMENT, NOT BY TASTE. Demoting `spf` against every step moved 70 SKINCARE strings
// in this repo's own corpus -- "Daily Moisturizer SPF 30" stopped being ambiguous and became a
// moisturizer, on a lane this change has no business touching. Against a MAKEUP step it moves six,
// all of them complexion products that main mislabelled. A moisturiser with SPF is genuinely both
// and keeps saying so by resolving to nothing.
const WEAK_STEP_SURFACES = new Set(['spf']);
// A DELIVERY FORMAT IS NOT A CATEGORY. Sunscreen, haircare and fragrance all ship as a body mist or
// a body spray, so when anything else matched, the format loses. Without this, Supergoop's "PLAY
// Antioxidant Body Mist SPF 30" and its "non-aerosol sunscreen body spray" — both sunscreens — read
// as a sunscreen AND a fragrance and resolved to nothing at all.
const FORMAT_ONLY_SURFACES = new Set(['body mist', 'body spray']);
// AN ACTIVE IS NOT A CATEGORY. `retinol`, `bha` and `acid` are on the `treatment` pattern because a
// product called "Retinol" is a treatment -- but they are ALSO the ingredient every serum, cream and
// toner prints on its front label. Competing with the formulation noun, they cancelled it: "Strong
// Retinol Serum", "2% BHA Serum" and "Pore Clearing BHA Serum" resolved to NOTHING.
//
// That landed on candidate rows, not asks. `normalizeRecoTargetStep` used to take the first pattern
// in listing order, where `serum` precedes `treatment`, so it answered `serum` and the row kept a
// step; unifying the two resolvers (one question, one answer) made it strict and the step went away.
// Measured through finalizeRecommendationCandidatePools on an identical corpus: the ask "serum for
// acne" lost 73 of 850 viable candidates, 69 of them BHA and retinol serums -- the acne-relevant
// ones. Rows with a clean structured product_type were unaffected; the loss was on rows whose only
// evidence is the title, which is exactly what an external seed is.
//
// The formulation noun wins, and a product whose ONLY step evidence is the active still resolves to
// `treatment` -- the weak rules below need two matches to do anything.
// Exactly the actives that are TOKENS of the treatment pattern. `acid`, `niacinamide` and
// `azelaic` are not on it at all -- listing them here would read as protection that does nothing.
const INGREDIENT_ONLY_SURFACES = new Set(['retinol', 'retinoid', 'bha', 'aha']);

function dropIngredientOnlySurfaceMatches(details) {
  if (details.length < 2) return details;
  const withoutActives = details.filter((detail) => !INGREDIENT_ONLY_SURFACES.has(detail.token));
  return withoutActives.length && withoutActives.length !== details.length ? withoutActives : details;
}
// PRIMER IS THE ONE MAKEUP CATEGORY WHERE SPF IS THE PRIMARY CLAIM. Supergoop's Unseen, Dewscreen
// and Glowscreen are sold as sun care that primes; letting `primer` beat an SPF surface moved them
// out of the sunscreen pipeline entirely — on a `sunscreen` query the row went from `same_family` to
// `incompatible_family`, and the query "spf primer" collapsed its result set from 75 to 2.
const STEPS_SPF_OUTRANKS = new Set(['primer']);

// SEPARATE FROM dropWeakSurfaceMatches BECAUSE IT HAS TO RUN FIRST. `body mist` overlaps toner's
// `mist`, so overlap resolution absorbs the very match the format was supposed to yield to, and by
// the time the format rule ran nothing else had matched — "Bulgarian Rose Water Face, Hair & Body
// Mist Spray" became a fragrance where main called it a toner.
function dropFormatOnlySurfaceMatches(details) {
  if (details.length < 2) return details;
  const withoutFormat = details.filter((detail) => !FORMAT_ONLY_SURFACES.has(detail.token));
  return withoutFormat.length && withoutFormat.length !== details.length ? withoutFormat : details;
}

function dropWeakSurfaceMatches(details) {
  if (details.length < 2) return details;
  const working = details;
  const weak = working.filter((detail) => WEAK_STEP_SURFACES.has(detail.token));
  const strong = working.filter((detail) => !WEAK_STEP_SURFACES.has(detail.token));
  if (!weak.length || !strong.length) return working;
  // `spf` YIELDS to a complexion-colour category: a foundation with SPF is sold on coverage.
  //
  // NARROW BY MEASUREMENT, NOT BY TASTE. Demoting `spf` against every step moved 70 SKINCARE strings
  // in this repo's corpus — "Daily Moisturizer SPF 30" stopped being ambiguous and became a
  // moisturizer, on a lane this change has no business touching. A moisturiser with SPF is genuinely
  // both and keeps saying so by resolving to nothing.
  if (strong.some(
    (detail) => STEP_DOMAIN_MAP[detail.step] === 'makeup' && !STEPS_SPF_OUTRANKS.has(detail.step),
  )) return strong;
  const survivors = strong.filter((detail) => !STEPS_SPF_OUTRANKS.has(detail.step));
  if (survivors.length !== strong.length) return survivors.length ? [...survivors, ...weak] : weak;
  return working;
}

// A SKINCARE STEP AND A MAKEUP STEP IN ONE ASK: THE SKINCARE ONE IS THE REQUEST. This lane's
// mainline is skincare, and a buyer who names both is describing the makeup they already wear --
// "what serum will make my foundation sit better", "a moisturizer that keeps my blush from sliding
// off", "loose powder sunscreen for touch ups". Before this they named two categories, went
// ambiguous, and lost their step on /v1/chat, the highest-traffic lane.
//
// The clause masks above catch the frames they were written for and no more; this is the general
// rule behind them, and it resolves TOWARDS main's answer -- main had no makeup steps at all, so a
// mixed ask resolved to its skincare step there too. Runs last, so an ask whose makeup category is
// the only thing named is untouched.
// AN SPF CLAIM BEATS A SKINCARE FORM NOUN, and this is main's answer restored rather than a new
// rule. main's normalizeRecoTargetStep took the first pattern in listing order, where `sunscreen`
// precedes `moisturizer`, `cleanser`, `serum`, `toner`, `essence`, `oil` and `treatment` -- so
// "Daily Moisturizer SPF 30" and "Anthelios Antioxidant Serum SPF 50" were sunscreens to the ranker
// and matched same_family on a sunscreen request. Leaving them ambiguous instead cost 79 of 422
// same-family sunscreen candidates over 3,841 real title-shaped rows, on the request they answer.
//
// `mask` is the exception, as it was on main: it is listed BEFORE sunscreen there, so a sheet mask
// with SPF stayed a mask. Complexion COLOUR still wins over `spf` -- that is the one place this
// differs from main, and it is measured: a skin tint is makeup.
const SKINCARE_STEPS_SUNSCREEN_OUTRANKS = new Set([
  'moisturizer', 'cleanser', 'serum', 'toner', 'essence', 'oil', 'treatment',
]);

function preferSunscreenOverOtherSkincare(details) {
  if (details.length < 2) return details;
  if (!details.some((detail) => detail.step === 'sunscreen')) return details;
  // `mask` OUTRANKS sunscreen, not the other way round — it is listed before it on main, so a sheet
  // mask with SPF stayed a mask there.
  if (details.some((detail) => detail.step === 'mask')) {
    const withoutSunscreen = details.filter((detail) => detail.step !== 'sunscreen');
    return withoutSunscreen.length ? withoutSunscreen : details;
  }
  const survivors = details.filter(
    (detail) => !SKINCARE_STEPS_SUNSCREEN_OUTRANKS.has(detail.step),
  );
  return survivors.length && survivors.length !== details.length ? survivors : details;
}

function preferSkincareStepOnMixedMatch(details) {
  if (details.length < 2) return details;
  const skincare = details.filter((detail) => !STEP_DOMAIN_MAP[detail.step]);
  if (!skincare.length || skincare.length === details.length) return details;
  return skincare;
}

function resolveOverlappingStepMatches(details) {
  const kept = [];
  const byLongest = details
    .slice()
    .sort((a, b) => b.length - a.length || a.index - b.index);
  for (const detail of byLongest) {
    const overlaps = kept.some(
      (chosen) => detail.index < chosen.index + chosen.length && chosen.index < detail.index + detail.length,
    );
    if (!overlaps) kept.push(detail);
  }
  return kept.sort((a, b) => a.index - b.index);
}

function collectStepPatternMatchDetails(input, entries) {
  // A CONTEXT MASK MAY NEVER DELETE THE ONLY CATEGORY NAMED. The clause patterns drop a category
  // mentioned as context, which presumes another one is left. "I wear blush and want a new shade"
  // and "what should I use with blush" name ONE category and nothing else, and masking took it --
  // leaving a ladder of ["cleanser"] for a blush ask.
  //
  // The fallback is to the DENIAL-masked text only, never to the raw text: a denial stays denied.
  // Falling back to raw made "something gentle and fragrance-free, nothing too rich" a fragrance
  // request, which is the defect the denial mask exists to remove.
  const denied = maskCategoryDenials(normalizeText(input));
  const contexted = maskCategoryAsContext(denied);
  const contextedDetails = contexted.trim() ? collectStepPatternMatchDetailsFrom(contexted, entries) : [];
  if (contextedDetails.length) return contextedDetails;
  return collectStepPatternMatchDetailsFrom(denied, entries);
}

function collectStepPatternMatchDetailsFrom(text, entries) {
  if (!text.trim()) return [];
  const details = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.step)) continue;
    // THE LONGEST OF THIS STEP'S OWN PATTERNS, not the first one listed. `sunscreen` carries both
    // /防晒/ and /隔离防晒/; taking the first left it holding the two-character match, which no
    // longer overlapped `foundation`'s /隔离/, so '隔离防晒' read as two categories and resolved to
    // none. Pattern order inside a step is a listing detail and must not decide a match.
    let best = null;
    for (const pattern of entry.patterns) {
      // exec, not test: `test` throws the matched surface away, which is the whole defect.
      const match = pattern.exec(text);
      if (!match) continue;
      if (!best || match[0].length > best[0].length) best = match;
    }
    if (!best) continue;
    seen.add(entry.step);
    details.push({
      step: entry.step,
      token: normalizeMatchedStepToken(best[0]),
      index: best.index,
      length: best[0].length,
    });
    if (details.length >= 8) break;
  }
  // ORDER IS LOAD-BEARING: formats yield first (before overlap can absorb what they yield to), then
  // overlap collapses two patterns over one span, then the weak-surface rules judge what survived.
  return preferSkincareStepOnMixedMatch(
    preferSunscreenOverOtherSkincare(
      dropWeakSurfaceMatches(
        resolveOverlappingStepMatches(dropIngredientOnlySurfaceMatches(dropFormatOnlySurfaceMatches(details))),
      ),
    ),
  );
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
  STEP_DOMAIN_MAP,
  maskNonCategoryQualifiers,
  resolveRecoStepDomain,
  RECOMMENDATION_STEP_RESOLUTION_RULES_V1,
  CANONICAL_STEP_FAMILY_MAP,
  normalizeRecoTargetStep,
  normalizeMatchedStepToken,
  collectHighConfidenceMatchDetails,
  extractRecoTargetStepFromText,
  getRecoTargetFamilyRelation,
  resolveRecoTargetStepIntent,
};
