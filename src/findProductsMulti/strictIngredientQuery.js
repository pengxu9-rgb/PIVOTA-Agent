'use strict';

// Strict ingredient vocabulary for find_products_multi, and the rules that decide what an ingredient
// mention in a QUERY or on a PRODUCT means.
//
// The alias table is the one the ingredient lane (agent_products_ingredient_recall_direct) has always
// used: src/server.js imports it from here, unchanged. It lives in this module so the routing layer
// (policy.js, the entry normaliser) can ask the same question the lane asks without loading the gateway.
//
// Flag: FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING = off | observe | on (default off), read per call.
//   off      nothing here changes behaviour, and nothing is computed for the log.
//   observe  every decision below is computed and logged on the completion line; the response, the
//            lane and the rows are exactly what `off` produces.
//   on       1. A query that is ONLY a known ingredient ("retinol", "hyaluronic acid") keeps its own
//              words through the context build, so the ingredient lane sees the ingredient.
//            2. An ingredient mention that is negated or a stand-in is not an ingredient intent:
//              "retinol-free", "without retinol", "no added retinol", "0% retinol", "retinol
//              alternative", "better than retinol", "phyto-retinol".
//            3. The ingredient lane admits a row only when the row positively NAMES every queried
//              ingredient (productIngredientMention).
//            4. A query that excludes an ingredient ("niacinamide-free serum", "retinol alternative
//              serum") never gets a row that names it, whichever lane answered.
//
// Pure functions, no dependencies.

const BARE_INGREDIENT_ROUTING_FLAG = 'FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING';

function readMode(env, flag) {
  const raw = String((env && env[flag]) || '').trim().toLowerCase();
  if (/^(1|true|on|yes)$/.test(raw)) return 'on';
  if (/^(observe|shadow)$/.test(raw)) return 'observe';
  return 'off';
}

function bareIngredientRoutingMode(env = process.env) {
  return readMode(env, BARE_INGREDIENT_ROUTING_FLAG);
}

function isBareIngredientRoutingEnabled(env = process.env) {
  return bareIngredientRoutingMode(env) === 'on';
}

// The ingredient lane's table (moved verbatim from src/server.js). Term -> ingredient id.
const STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES = Object.freeze({
  'ascorbic acid': 'ascorbic_acid',
  'azelaic acid': 'azelaic_acid',
  'benzoyl peroxide': 'benzoyl_peroxide',
  ceramide: 'ceramide_np',
  ceramides: 'ceramide_np',
  'ceramide np': 'ceramide_np',
  glycerin: 'glycerin',
  glycerine: 'glycerin',
  'hyaluronic acid': 'hyaluronic_acid',
  niacinamide: 'niacinamide',
  panthenol: 'panthenol',
  retinol: 'retinol',
  'salicylic acid': 'salicylic_acid',
  'vitamin c': 'ascorbic_acid',
  'zinc pca': 'zinc_pca',
});

// INCI names that ARE the ingredient, read only from a product's structured ingredient fields (never
// from a title or a query). Each is a name for the same substance or a direct salt/ester of it.
const STRUCTURED_INCI_SYNONYMS = Object.freeze({
  hyaluronic_acid: ['sodium hyaluronate', 'hydrolyzed sodium hyaluronate', 'sodium acetylated hyaluronate', 'hydrolyzed hyaluronic acid'],
  ascorbic_acid: ['l ascorbic acid', 'ascorbyl glucoside', 'sodium ascorbyl phosphate', 'magnesium ascorbyl phosphate',
    'ethyl ascorbic acid', '3 o ethyl ascorbic acid', 'tetrahexyldecyl ascorbate', 'ascorbyl tetraisopalmitate'],
  niacinamide: ['nicotinamide'],
  panthenol: ['d panthenol', 'dexpanthenol'],
  glycerin: ['glycerol'],
  ceramide_np: ['ceramide ap', 'ceramide eop', 'ceramide ns', 'ceramide as'],
});

// Lower-case, diacritics stripped, every run of non-letters/digits (in ANY script) -> one space, except
// a decimal point, which stays inside its number ("1.0%" is "1.0", never "1 0"). Script-preserving on
// purpose: Hangul, kana, Han and Cyrillic survive, so "retinol 크림" is not the bare query "retinol".
function normalizeForMatch(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TERM_TO_ID = new Map(
  Object.entries(STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES).map(([term, id]) => [normalizeForMatch(term), id]),
);
// Longest first, so "ceramide np" is consumed before "ceramide".
const STRICT_TERMS_BY_LENGTH = Object.freeze(Array.from(TERM_TO_ID.keys()).sort((a, b) => b.length - a.length));
const STRICT_TERM_ALTERNATION = STRICT_TERMS_BY_LENGTH.map(escapeRegExp).join('|');

// Words around an ingredient that mean "without it" (ABSENCE) or "a stand-in for it" (STAND-IN), on
// normalised text (punctuation is already a space: "retinol-free" is "retinol free"; "0% retinol" is
// "0 retinol", while "1.0% retinol" is "1.0 retinol" and asks FOR retinol).
// Positive marketing words -- vegan, natural, clean, pro, bio, plant(-based), dupe, "like X" -- are not
// qualifiers anywhere. Absence words include German / French / Spanish (ohne, sans, sin, frei) and
// Russian (без, не содержит), so a non-English negation never becomes a request FOR the ingredient.
// Three stand-in forms are read on PRODUCTS only, where they are marketing for a substitute:
// "Phyto-Retinol", "Faux Retinol", "Pseudo-Retinol", "Retinol-Like". In a QUERY "phyto ceramides" and
// "products like retinol" ask for the ingredient.
const ABSENCE_BEFORE = [
  'without any', 'without', 'no added', 'no', 'non', 'not', 'zero', '0(?:\\.0+)?', 'avoid', 'avoiding',
  'free of', 'free from', 'sans', 'sin', 'ohne', 'frei von', 'libre de', 'без', 'не содержит',
];
const STAND_IN_BEFORE = [
  'alternatives to', 'alternative to', 'substitutes for', 'substitute for', 'replacements for', 'replacement for',
  'instead of', 'better than', 'gentler than',
];
const PRODUCT_ONLY_STAND_IN_BEFORE = ['phyto', 'faux', 'pseudo'];
// "free" before shipping / delivery / returns / gift / sample / trial / radical(s) / size is not an
// absence: "retinol free shipping", "Vitamin C Free Radical Defense Serum".
const FREE_NOT_ABSENCE = '(?:shipping|delivery|returns?|gifts?|samples?|trials?|radicals?|sizes?)';
const ABSENCE_AFTER = [`free(?!\\s+${FREE_NOT_ABSENCE}(?:\\s|$))`, 'frei(?:e|er|es|en|em)?'];
const STAND_IN_AFTER = ['alternatives?', 'substitutes?', 'replacements?'];
const PRODUCT_ONLY_STAND_IN_AFTER = ['like'];

const alternation = (words) => `(?:${words.map((value) => value.replace(/ /g, '\\s+')).join('|')})`;
const beforeTail = (words) => new RegExp(`(?:^|\\s)${alternation(words)}\\s$`, 'u');
const afterHead = (words) => new RegExp(`^\\s${alternation(words)}(?=\\s|$)`, 'u');
const QUALIFIERS = Object.freeze({
  query: {
    absenceBefore: beforeTail(ABSENCE_BEFORE),
    absenceAfter: afterHead(ABSENCE_AFTER),
    standInBefore: beforeTail(STAND_IN_BEFORE),
    standInAfter: afterHead(STAND_IN_AFTER),
  },
  product: {
    absenceBefore: beforeTail(ABSENCE_BEFORE),
    absenceAfter: afterHead(ABSENCE_AFTER),
    standInBefore: beforeTail([...STAND_IN_BEFORE, ...PRODUCT_ONLY_STAND_IN_BEFORE]),
    standInAfter: afterHead([...STAND_IN_AFTER, ...PRODUCT_ONLY_STAND_IN_AFTER]),
  },
});
// German glues "frei" onto the noun: "retinolfrei", "Retinolfreie Creme".
const GLUED_FREI_RE = /^frei(?:e|er|es|en|em)?(?=\s|$)/;

// 'absence', 'standin' or null for the text around one occurrence.
function qualifierKind(text, start, end, context) {
  const q = QUALIFIERS[context] || QUALIFIERS.product;
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (q.absenceBefore.test(before) || q.absenceAfter.test(after)) return 'absence';
  if (q.standInBefore.test(before) || q.standInAfter.test(after)) return 'standin';
  return null;
}

// Every whole-word occurrence of `term` in normalised `text`, each with its qualifier kind. Whole words
// on BOTH sides: "bioretinol" and "retinoloid" are not "retinol"; the one glued suffix recognised is
// German "-frei", which is an absence.
function termOccurrences(text, term, context = 'product') {
  const out = [];
  if (!text || !term) return out;
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(term)}(?=\\s|$|frei)`, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + (match[0].startsWith(' ') ? 1 : 0);
    let end = start + term.length;
    const glued = text.slice(end).match(GLUED_FREI_RE);
    if (!glued && !/^(?:\s|$)/.test(text.slice(end))) continue;
    if (glued) end += glued[0].length;
    const kind = glued ? 'absence' : qualifierKind(text, start, end, context);
    out.push({ start, end, qualified: Boolean(kind), kind });
  }
  return out;
}

// The ingredient's names in the other scripts the routing tables know, used to read PRODUCTS ("레티놀
// 세럼"), never to detect a query intent (the lane's detector is English-only; multilingualBeautyTerms.js
// maps queries). Han / kana / Hangul names match as substrings -- unless they sit inside a longer known
// compound ("甘油三酯" is a triglyceride, not glycerin) -- with the CJK negation forms around them.
const NON_LATIN_INGREDIENT_NAMES = Object.freeze({
  retinol: ['视黄醇', '視黃醇', '维a醇', '維a醇', 'a醇', 'レチノール', '레티놀'],
  hyaluronic_acid: ['透明质酸', '透明質酸', '玻尿酸', 'ヒアルロン酸', '히알루론산'],
  niacinamide: ['烟酰胺', '煙醯胺', '菸鹼醯胺', 'ナイアシンアミド', '나이아신아마이드'],
  ascorbic_acid: ['维生素c', '維生素c', '维他命c', '維他命c', '维c', '維c', 'ビタミンc', '비타민c', '비타민 c', '비타민씨',
    '抗坏血酸', '抗壞血酸', 'アスコルビン酸', '아스코빅애씨드'],
  salicylic_acid: ['水杨酸', '水楊酸', 'サリチル酸', '살리실산'],
  ceramide_np: ['神经酰胺', '神經醯胺', 'セラミド', '세라마이드'],
  azelaic_acid: ['壬二酸', 'アゼライン酸', '아젤라산', '아젤라익애씨드'],
  benzoyl_peroxide: ['过氧化苯甲酰', '過氧化苯甲醯', '過酸化ベンゾイル', '벤조일퍼옥사이드'],
  panthenol: ['泛醇', 'パンテノール', '판테놀'],
  glycerin: ['甘油', 'グリセリン', '글리세린'],
});
// Longer CJK compounds that contain a name above but are a different substance.
const CJK_LONGER_COMPOUNDS = Object.freeze({
  甘油: ['甘油三酯', '甘油二酯', '甘油单酯', '甘油酯', '聚甘油', '甘油醚', '硝酸甘油'],
});
// Russian names are matched by STEM, so every inflection counts ("ретинол", "ретинолом", "ретинола",
// "гиалуроновой кислотой"), for presence and for absence ("без ретинола").
const RUSSIAN_INGREDIENT_STEMS = Object.freeze({
  retinol: ['ретинол'],
  hyaluronic_acid: ['гиалурон'],
  niacinamide: ['ниацинамид'],
  ascorbic_acid: ['аскорбинов', 'витамин\\p{L}*\\s+[cс]'],
  salicylic_acid: ['салицилов'],
  ceramide_np: ['церамид'],
  azelaic_acid: ['азелаинов'],
  benzoyl_peroxide: ['бензоилпероксид', 'бензоил\\p{L}*\\s+пероксид'],
  panthenol: ['пантенол'],
  glycerin: ['глицерин'],
});
const CJK_SCRIPT_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
const CJK_NEGATION_BEFORE_RE = /(?:不含|无添加|無添加|无|無|没有|沒有|避开|避開|不要|不加)\s*$/;
// Korean 프리 ("free") only as its own word or a word-final suffix (레티놀프리, 레티놀 프리): never the
// start of a longer Hangul word ("프리미엄", premium).
const CJK_NEGATION_AFTER_RE = /^\s*(?:free(?=\s|$)|フリー|不使用|無添加|なし|無し|없는|무첨가|프리(?![\uac00-\ud7af])|없이|대체|代替|替代)/;

function insideLongerCompound(text, start, alias) {
  for (const compound of CJK_LONGER_COMPOUNDS[alias] || []) {
    let offset = compound.indexOf(alias);
    while (offset >= 0) {
      if (start - offset >= 0 && text.slice(start - offset, start - offset + compound.length) === compound) return true;
      offset = compound.indexOf(alias, offset + 1);
    }
  }
  return false;
}

function cjkOccurrences(text, alias) {
  const out = [];
  if (!text || !alias) return out;
  let from = 0;
  for (;;) {
    const start = text.indexOf(alias, from);
    if (start < 0) break;
    const end = start + alias.length;
    from = start + 1;
    if (insideLongerCompound(text, start, alias)) continue;
    const qualified = CJK_NEGATION_BEFORE_RE.test(text.slice(0, start)) || CJK_NEGATION_AFTER_RE.test(text.slice(end));
    out.push({ start, end, qualified, kind: qualified ? 'absence' : null });
  }
  return out;
}

function russianOccurrences(text, id, context) {
  const out = [];
  for (const stem of RUSSIAN_INGREDIENT_STEMS[id] || []) {
    const pattern = new RegExp(`(?:^|\\s)(${stem}\\p{L}*)(?=\\s|$)`, 'gu');
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index + (match[0].startsWith(' ') ? 1 : 0);
      const end = start + match[1].length;
      const kind = qualifierKind(text, start, end, context);
      out.push({ start, end, qualified: Boolean(kind), kind });
    }
  }
  return out;
}

// Occurrences of any of an ingredient's names in normalised text, in every script.
function ingredientOccurrences(text, latinTerms, id, context = 'product') {
  const out = [];
  for (const term of latinTerms) out.push(...termOccurrences(text, term, context));
  for (const raw of NON_LATIN_INGREDIENT_NAMES[id] || []) {
    const alias = normalizeForMatch(raw);
    if (alias) out.push(...cjkOccurrences(text, alias));
  }
  out.push(...russianOccurrences(text, id, context));
  return out;
}

// Query side: which table ingredients the text asks FOR, which it EXCLUDES (mentions only in a
// qualified form), and which of those it excludes only as a STAND-IN ("retinol alternative"). A
// positive mention anywhere wins. Ids in table order.
function classifyStrictIngredientMentions(text) {
  const normalized = normalizeForMatch(text);
  const states = new Map();
  if (normalized) {
    const consumed = new Array(normalized.length).fill(false);
    for (const term of STRICT_TERMS_BY_LENGTH) {
      const id = TERM_TO_ID.get(term);
      for (const occurrence of termOccurrences(normalized, term, 'query')) {
        let overlaps = false;
        for (let i = occurrence.start; i < occurrence.end; i += 1) if (consumed[i]) overlaps = true;
        if (overlaps) continue;
        for (let i = occurrence.start; i < occurrence.end; i += 1) consumed[i] = true;
        const state = states.get(id) || { positive: false, absence: false, standin: false };
        if (occurrence.kind === 'absence') state.absence = true;
        else if (occurrence.kind === 'standin') state.standin = true;
        else state.positive = true;
        states.set(id, state);
      }
    }
  }
  const wanted = [];
  const excluded = [];
  const standInOnly = [];
  for (const id of Object.values(STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES)) {
    const state = states.get(id);
    if (!state) continue;
    if (state.positive && !wanted.includes(id)) wanted.push(id);
    if (!state.positive && (state.absence || state.standin) && !excluded.includes(id)) {
      excluded.push(id);
      if (!state.absence && !standInOnly.includes(id)) standInOnly.push(id);
    }
  }
  return { wanted, excluded, standInOnly };
}

// Removes every qualified strict-ingredient mention (query reading) from normalised text. Text
// without one is returned unchanged.
function stripNegatedStrictIngredientMentions(normalizedText) {
  const text = String(normalizedText || '');
  if (!text) return text;
  let out = text;
  for (const term of STRICT_TERMS_BY_LENGTH) {
    const occurrences = termOccurrences(out, term, 'query').filter((occurrence) => occurrence.qualified);
    for (let i = occurrences.length - 1; i >= 0; i -= 1) {
      out = `${out.slice(0, occurrences[i].start)} ${out.slice(occurrences[i].end)}`;
    }
  }
  return out === text ? text : out.replace(/\s+/g, ' ').trim();
}

function extractPositiveStrictIngredientIds(text) {
  return classifyStrictIngredientMentions(text).wanted;
}

function extractExcludedStrictIngredientIds(text) {
  return classifyStrictIngredientMentions(text).excluded;
}

function extractStandInOnlyStrictIngredientIds(text) {
  return classifyStrictIngredientMentions(text).standInOnly;
}

// Words that do not change what a bare ingredient query asks for. Deliberately short: anything that
// names a product form, a concern, a brand, a body area -- or is in another script -- makes the query
// something other than "just the ingredient", and it keeps its existing route.
const BARE_QUERY_FILLER_WORDS = new Set([
  'a', 'an', 'the', 'any', 'some', 'me', 'i', 'my',
  'best', 'top', 'good', 'great', 'popular', 'pure',
  'product', 'products', 'item', 'items',
  'shop', 'buy', 'find', 'show', 'search', 'get', 'want', 'need', 'looking', 'recommend',
  'recommendation', 'recommendations', 'please',
  'with', 'containing', 'contains', 'for',
  // "retinol dupe", "products like retinol", "retinol like results" ask for retinol(-similar) products
  'dupe', 'dupes', 'like', 'similar', 'results', 'result', 'effect', 'effects',
]);

// True when the query is ONLY one or more strict-table ingredients (plus filler words, including
// "dupe" / "like" / "similar"), each asked for positively. "retinol", "Hyaluronic Acid", "best niacinamide products" -> true;
// "retinol serum", "retinol 크림", "retinol-free", "0% retinol", "hyaluronic" (not a table term) -> false.
function isBareStrictIngredientQuery(text) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return false;
  const { wanted, excluded } = classifyStrictIngredientMentions(normalized);
  if (wanted.length === 0 || excluded.length > 0) return false;
  let remainder = ` ${normalized} `;
  for (const term of STRICT_TERMS_BY_LENGTH) {
    remainder = remainder.replace(new RegExp(`\\s${escapeRegExp(term)}(?=\\s)`, 'g'), ' ');
  }
  return remainder
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => BARE_QUERY_FILLER_WORDS.has(token));
}

// Terms a TITLE may use to name an ingredient: the id and its table aliases. No loose extras: a bare
// "vitamin" names vitamin E as readily as vitamin C.
function strictIngredientNamingTerms(ingredientId) {
  const id = String(ingredientId || '').trim().toLowerCase();
  if (!id) return [];
  const out = [normalizeForMatch(id.replace(/_/g, ' '))];
  for (const [term, mappedId] of TERM_TO_ID.entries()) {
    if (mappedId === id && !out.includes(term)) out.push(term);
  }
  return out.filter(Boolean);
}

function structuredNamingTerms(ingredientId) {
  const id = String(ingredientId || '').trim().toLowerCase();
  const synonyms = (STRUCTURED_INCI_SYNONYMS[id] || []).map((value) => normalizeForMatch(value));
  return Array.from(new Set([...strictIngredientNamingTerms(id), ...synonyms]));
}

function productIngredientIds(product) {
  return Array.isArray(product?.ingredient_ids)
    ? product.ingredient_ids.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
}

// A structured ingredient field as a list of entries: an array, or an INCI string split on its
// separators. Each entry is matched on its own, so a qualifier ending one entry never reaches the next.
function structuredEntries(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === 'string' ? structuredEntries(entry) : []));
  }
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(/[,;|\n\u3001\uff0c]+/)
    .map((entry) => normalizeForMatch(entry))
    .filter(Boolean);
}

// The product's STRUCTURED ingredient fields: actives, key ingredients and the INCI list, wherever the
// row carries them (top level, ingredient_intel, the seed payload). Deliberately NOT:
//   - the description, which mentions ingredients loosely ("free of retinol", "pairs well with");
//   - ingredient_tokens / external_seed_recall.ingredient_tokens, which are DERIVED, partly from the
//     description, with no negation handling (deriveBeautyRecallActives: "free of retinol" -> "retinol").
function productStructuredFields(product) {
  if (!product || typeof product !== 'object') return { actives: [], inci: [] };
  const seedData = product.product_payload?.seed_data || product.seed_data || null;
  const intel = product.ingredient_intel && typeof product.ingredient_intel === 'object' ? product.ingredient_intel : null;
  const seedIntel = seedData?.ingredient_intel && typeof seedData.ingredient_intel === 'object' ? seedData.ingredient_intel : null;
  return {
    // Partial lists: they can show an ingredient is there, never that it is not.
    actives: [
      product.active_ingredients,
      product.key_ingredients,
      product.pdp_active_ingredients_raw,
      intel?.active_ingredients,
      seedData?.active_ingredients,
      seedData?.key_ingredients,
      seedIntel?.active_ingredients,
    ].flatMap(structuredEntries),
    // The full INCI list: what it does not contain, the product does not contain.
    inci: [
      product.ingredients_inci,
      product.inci_list,
      intel?.inci_list,
      seedData?.ingredients_inci,
      seedData?.inci_list,
      seedIntel?.inci_list,
    ].flatMap(structuredEntries),
  };
}

function productStructuredIngredientEntries(product) {
  const { actives, inci } = productStructuredFields(product);
  return [...actives, ...inci];
}

function productTitleText(product) {
  if (!product || typeof product !== 'object') return '';
  return normalizeForMatch(
    [product.title, product.name, product.product_title].filter((value) => typeof value === 'string' && value.trim()).join(' | '),
  );
}

// How the product mentions one ingredient, STRUCTURED EVIDENCE FIRST:
//   'named'         its ingredient_ids carry it, or a structured ingredient entry names it (not
//                   qualified away), or -- failing structured evidence -- its title names it outright;
//                   in any script the routing tables know;
//   'negated_only'  no positive evidence, and some mention is qualified away ("Retinol-Free",
//                   "Phyto-Retinol", "Retinol-Like", "Retinol Alternative", "Better Than Retinol",
//                   "0% Retinol", "No Added Retinol", "Not Retinol", "레티놀 프리");
//   'absent'        no mention.
// A title never overrides structured evidence, either way: an INCI list that contains retinol
// contains retinol, and a full INCI list WITHOUT retinol (or any of its INCI names) means the product
// has none, whatever the title says ("Bio-Retinol Bakuchiol Serum" with a bakuchiol INCI is not retinol).
function productIngredientMention(product, ingredientId) {
  const id = String(ingredientId || '').trim().toLowerCase();
  if (!id || !product || typeof product !== 'object') return 'absent';
  if (productIngredientIds(product).includes(id)) return 'named';
  let qualifiedSeen = false;
  const structuredTerms = structuredNamingTerms(id);
  const { actives, inci } = productStructuredFields(product);
  for (const entry of [...actives, ...inci]) {
    for (const occurrence of ingredientOccurrences(entry, structuredTerms, id)) {
      if (!occurrence.qualified) return 'named';
      qualifiedSeen = true;
    }
  }
  if (inci.length > 0) return qualifiedSeen ? 'negated_only' : 'absent';
  for (const occurrence of ingredientOccurrences(productTitleText(product), strictIngredientNamingTerms(id), id)) {
    if (!occurrence.qualified) return 'named';
    qualifiedSeen = true;
  }
  return qualifiedSeen ? 'negated_only' : 'absent';
}

function productNamesStrictIngredientsPositively(product, ingredientIds = []) {
  const ids = (Array.isArray(ingredientIds) ? ingredientIds : []).filter(Boolean);
  if (ids.length === 0) return false;
  return ids.every((id) => productIngredientMention(product, id) === 'named');
}

function cleanIds(ingredientIds) {
  return (Array.isArray(ingredientIds) ? ingredientIds : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

// The ingredient lane's admission rule: every row must NAME every queried ingredient. The lane's recall
// does not guarantee this on its own: the canonical leg matches query text against title / recall_doc /
// SKU ingredient ids (a recall_doc LIKE '%retinol%' admits "Retinol-Free ..."), and the seed prefetch
// substring-matches derived ingredient tokens (where "vitamin" names vitamin E and a description's
// "free of retinol" yields the token "retinol"). Order is preserved and nothing is added.
function admitIngredientLaneProducts(products = [], { ingredientIds = [] } = {}) {
  const list = Array.isArray(products) ? products : [];
  const ids = cleanIds(ingredientIds);
  if (ids.length === 0) return { products: list, dropped_count: 0 };
  const kept = list.filter((product) => productNamesStrictIngredientsPositively(product, ids));
  return { products: kept, dropped_count: list.length - kept.length };
}

// The exclusion a query like "niacinamide-free serum" or "retinol alternative serum" asks for: no row
// that names the excluded ingredient. Order is preserved and nothing is added.
function excludeProductsNamingIngredients(products = [], { ingredientIds = [] } = {}) {
  const list = Array.isArray(products) ? products : [];
  const ids = cleanIds(ingredientIds);
  if (ids.length === 0) return { products: list, dropped_count: 0 };
  const kept = list.filter((product) => !ids.some((id) => productIngredientMention(product, id) === 'named'));
  return { products: kept, dropped_count: list.length - kept.length };
}

// The same exclusion on a whole response page: rows, page_size and total stay consistent (the dropped
// rows leave the total too, as the serving-currency guard does). Returns { body, dropped_count };
// `body` is the input object itself when nothing was dropped.
function productCategoryPath(product) {
  const path = product?.catalog_category_path || product?.category_path;
  if (Array.isArray(path)) return path.join('/').toLowerCase();
  return typeof path === 'string' ? path.toLowerCase() : '';
}

// `scopePrefix` (optional): rows outside this category path are dropped too (a row with no path
// fails closed).
function excludeIngredientsFromPage(body, { ingredientIds = [], scopePrefix = null } = {}) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.products)) return { body, dropped_count: 0 };
  const exclusion = excludeProductsNamingIngredients(body.products, { ingredientIds });
  const scope = scopePrefix ? String(scopePrefix).toLowerCase().replace(/\/+$/, '') : '';
  const kept = scope
    ? exclusion.products.filter((product) => {
        const path = productCategoryPath(product);
        return path === scope || path.startsWith(`${scope}/`);
      })
    : exclusion.products;
  const droppedCount = body.products.length - kept.length;
  if (droppedCount === 0) return { body, dropped_count: 0 };
  return {
    dropped_count: droppedCount,
    body: {
      ...body,
      products: kept,
      ...(Number.isFinite(Number(body.page_size)) && body.page_size !== null ? { page_size: kept.length } : {}),
      ...(Number.isFinite(Number(body.total)) && body.total !== null
        ? { total: Math.max(kept.length, Number(body.total) - droppedCount) }
        : {}),
      metadata: {
        ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
        excluded_ingredient_dropped_count: droppedCount,
      },
    },
  };
}

// Negation phrasing -- English, and the German / French / Spanish absence words the strict detector
// also reads (ohne, sans, sin, frei von, libre de, "-frei") -- canonicalised to the form the rest of
// the pipeline already understands
// ("<ingredient>-free": the search-quality contract reads "retinol-free" as avoid-retinoids). Absence
// forms only -- a stand-in ("retinol alternative") is not "free of" anything. Strict-table terms only.
const RAW_TERM = `(${STRICT_TERM_ALTERNATION.replace(/ /g, '[\\s-]+')})`;
// "0%" / "0.0%" only as its own number: never the tail of "1.0%" or "10%".
const RAW_NEGATED_TERM_RE = new RegExp(
  `(?<![\\w.-])(?:without(?:\\s+any)?|no(?:\\s+added)?|non|not|avoid(?:ing)?|free\\s+(?:of|from)|zero|0(?:\\.0+)?\\s*%|sans|sin|ohne|frei\\s+von|libre\\s+de)[\\s-]+${RAW_TERM}\\b`,
  'gi',
);
// German glues it on: "retinolfrei", "Retinol-frei", "Retinolfreie Creme".
const RAW_TERM_FREI_RE = new RegExp(`\\b${RAW_TERM}-?frei(?:e|er|es|en|em)?\\b`, 'gi');
const RAW_TERM_FREE_RE = new RegExp(
  `\\b${RAW_TERM}[\\s-]+free\\b(?![\\s-]+${FREE_NOT_ABSENCE}\\b)`,
  'gi',
);
// A form noun in another language right next to a strict ingredient reads as "cream", as the
// multilingual table maps it ("Retinolfreie Creme" keeps its form with only this flag on).
const RAW_CREAM_NOUN_RE = /(?<![\p{L}])(?:cr[eè]me|crema)(?![\p{L}])|크림(?![\uac00-\ud7af])|クリーム/giu;
const RAW_TERM_ANY_RE = new RegExp(`\\b(?:${STRICT_TERM_ALTERNATION.replace(/ /g, '[\\s-]+')})`, 'i');

function canonicalizeEnglishIngredientNegations(rawQuery) {
  const text = String(rawQuery || '');
  if (!text.trim()) return { query: text, changed: false };
  const toFree = (_match, term) => `${term.toLowerCase().replace(/[\s-]+/g, ' ')}-free`;
  let out = text
    .replace(RAW_NEGATED_TERM_RE, toFree)
    .replace(RAW_TERM_FREI_RE, toFree)
    .replace(RAW_TERM_FREE_RE, toFree);
  if (out !== text && RAW_TERM_ANY_RE.test(out)) out = out.replace(RAW_CREAM_NOUN_RE, 'cream');
  if (out === text) return { query: text, changed: false };
  return { query: out.replace(/\s+/g, ' ').trim(), changed: true };
}

module.exports = {
  NON_LATIN_INGREDIENT_NAMES,
  BARE_INGREDIENT_ROUTING_FLAG,
  STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES,
  bareIngredientRoutingMode,
  isBareIngredientRoutingEnabled,
  readMode,
  normalizeForMatch,
  stripNegatedStrictIngredientMentions,
  extractPositiveStrictIngredientIds,
  extractExcludedStrictIngredientIds,
  extractStandInOnlyStrictIngredientIds,
  isBareStrictIngredientQuery,
  strictIngredientNamingTerms,
  productIngredientMention,
  productNamesStrictIngredientsPositively,
  admitIngredientLaneProducts,
  excludeProductsNamingIngredients,
  excludeIngredientsFromPage,
  canonicalizeEnglishIngredientNegations,
};
