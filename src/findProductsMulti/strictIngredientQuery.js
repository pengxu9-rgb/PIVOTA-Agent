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
//            5. A stand-in active (bakuchiol, STAND_IN_ACTIVE_ALIASES) is asked for like a table
//              ingredient, and KNOWN_STAND_INS names the stand-in a bare "retinol alternative" asks for.
//
// Pure functions; the only dependency is the shared retinoid family list (src/services/retinoidFamily.js).

const {
  RETINOID_FAMILY_LATIN,
  RETINOID_FAMILY_SCRIPT,
  RETINOID_FAMILY_RUSSIAN,
} = require('../services/retinoidFamily');

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

// Stand-in actives: substances sold AS a substitute for a table ingredient. Routing vocabulary only
// (the lane's table above is unchanged, and the lane reads it directly when the flag is off). With the
// flag on, a query that names one asks for it the way "retinol" asks for retinol: "bakuchiol",
// "bakuchiol instead of retinol".
const STAND_IN_ACTIVE_ALIASES = Object.freeze({ bakuchiol: 'bakuchiol' });
// The stand-in a bare "<ingredient> alternative" asks for, when one is well established. One row, on
// purpose: bakuchiol is the plant-derived active marketed and studied as the retinol alternative
// (randomised, double-blind comparison with retinol: Dhaliwal et al., Br J Dermatol 2019;180:289-296).
// No other table ingredient has a single accepted stand-in, so their bare stand-in queries name
// nothing to serve (see queryRoutingNormalizer.js).
const KNOWN_STAND_INS = Object.freeze({ retinol: Object.freeze(['bakuchiol']) });

const ROUTING_ALIASES = Object.freeze({ ...STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES, ...STAND_IN_ACTIVE_ALIASES });
const TERM_TO_ID = new Map(Object.entries(ROUTING_ALIASES).map(([term, id]) => [normalizeForMatch(term), id]));
// Longest first, so "ceramide np" is consumed before "ceramide".
const STRICT_TERMS_BY_LENGTH = Object.freeze(Array.from(TERM_TO_ID.keys()).sort((a, b) => b.length - a.length));
const STRICT_TERM_ALTERNATION = STRICT_TERMS_BY_LENGTH.map(escapeRegExp).join('|');

// Words around an ingredient that mean "without it" (ABSENCE) or "a stand-in for it" (STAND-IN), on
// normalised text (punctuation is already a space: "retinol-free" is "retinol free"; "0% retinol" is
// "0 retinol", while "1.0% retinol" is "1.0 retinol" and asks FOR retinol). The same words are read on
// queries and on products, with two exceptions:
//   - "phyto" is a stand-in only for an ingredient that HAS a plant analogue (retinol: bakuchiol is sold
//     as "phyto-retinol"). Phyto-ceramides ARE ceramides; "phyto ceramides" asks for ceramides.
//   - "like" after the ingredient is a stand-in only on a product title and only glued with a hyphen
//     ("Retinol-Like Serum"); "Retinol Like Butter Balm" is a retinol balm, and in a query "retinol
//     like <brand>" / "products like retinol" ask for retinol.
// Positive marketing words -- vegan, natural, clean, pro, bio, plant(-based), dupe -- are not
// qualifiers anywhere. Absence words include German / French / Spanish (ohne, sans, sin, frei) and
// Russian (без, не содержит), so a non-English negation never becomes a request FOR the ingredient.
const ABSENCE_BEFORE = [
  'without any', 'without', 'no added', 'no', 'non', 'not', 'zero', '0(?:\\.0+)?', 'avoid', 'avoiding',
  'free of', 'free from', 'sans', 'sin', 'ohne', 'frei von', 'libre de', 'без', 'не содержит',
];
const STAND_IN_BEFORE = [
  'alternatives to', 'alternative to', 'substitutes for', 'substitute for', 'replacements for', 'replacement for',
  'instead of', 'better than', 'gentler than', 'faux', 'pseudo',
];
const PLANT_ANALOGUE_IDS = Object.freeze(['retinol']);
// "free" before shipping / delivery / returns / gift / sample / trial / radical(s) / size is not an
// absence: "retinol free shipping", "Vitamin C Free Radical Defense Serum".
const FREE_NOT_ABSENCE = '(?:shipping|delivery|returns?|gifts?|samples?|trials?|radicals?|sizes?)';
// A trailing "0%" / "0.0%" is an absence ("retinol 0%"); "10%", "1.0%", "0.3%" are not.
const ABSENCE_AFTER = [`free(?!\\s+${FREE_NOT_ABSENCE}(?:\\s|$))`, 'frei(?:e|er|es|en|em)?', '0(?:\\.0+)?'];
const STAND_IN_AFTER = ['alternatives?', 'substitutes?', 'replacements?'];

const alternation = (words) => `(?:${words.map((value) => value.replace(/ /g, '\\s+')).join('|')})`;
const beforeTail = (words) => new RegExp(`(?:^|\\s)${alternation(words)}\\s$`, 'u');
const afterHead = (words) => new RegExp(`^\\s${alternation(words)}(?=\\s|$)`, 'u');
const QUALIFIERS = Object.freeze({
  absenceBefore: beforeTail(ABSENCE_BEFORE),
  absenceAfter: afterHead(ABSENCE_AFTER),
  standInBefore: beforeTail(STAND_IN_BEFORE),
  standInAfter: afterHead(STAND_IN_AFTER),
  phytoBefore: beforeTail(['phyto']),
  likeAfter: afterHead(['like']),
  freeAfter: afterHead(['free']),
});
// German glues "frei" onto the noun: "retinolfrei", "Retinolfreie Creme".
const GLUED_FREI_RE = /^frei(?:e|er|es|en|em)?(?=\s|$)/;

// 'absence', 'standin' or null for the text around one occurrence of ingredient `id`. `hyphenLike`:
// the raw title glued this term to "-like".
// `hyphenFree`: the raw title glued this term to "-free" ("Retinol-Free Sample" is retinol-free, though
// "retinol free sample" typed as words is a free sample).
function qualifierKind(text, start, end, { id = null, hyphenLike = false, hyphenFree = false } = {}) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (QUALIFIERS.absenceBefore.test(before) || QUALIFIERS.absenceAfter.test(after)) return 'absence';
  if (hyphenFree && QUALIFIERS.freeAfter.test(after)) return 'absence';
  if (QUALIFIERS.standInBefore.test(before) || QUALIFIERS.standInAfter.test(after)) return 'standin';
  if (PLANT_ANALOGUE_IDS.includes(id) && QUALIFIERS.phytoBefore.test(before)) return 'standin';
  if (hyphenLike && QUALIFIERS.likeAfter.test(after)) return 'standin';
  return null;
}

// Every whole-word occurrence of `term` in normalised `text`, each with its qualifier kind. Whole words
// on BOTH sides: "bioretinol" and "retinoloid" are not "retinol"; the one glued suffix recognised is
// German "-frei", which is an absence.
// A Latin term followed by a word that makes it a different substance: "retinol palmitate" is a retinyl
// ester, not retinol.
const LATIN_DIFFERENT_COMPOUND_AFTER = Object.freeze({
  retinol: /^\s(?:palmitate|acetate|propionate|linoleate|esters?)(?=\s|$)/,
});

function termOccurrences(text, term, { id = TERM_TO_ID.get(term) || null, hyphenLike = false, hyphenFree = false } = {}) {
  const out = [];
  if (!text || !term) return out;
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(term)}(?=\\s|$|frei)`, 'g');
  const differentCompound = LATIN_DIFFERENT_COMPOUND_AFTER[term] || null;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + (match[0].startsWith(' ') ? 1 : 0);
    let end = start + term.length;
    const glued = text.slice(end).match(GLUED_FREI_RE);
    if (!glued && !/^(?:\s|$)/.test(text.slice(end))) continue;
    if (!glued && differentCompound && differentCompound.test(text.slice(end))) continue;
    if (glued) end += glued[0].length;
    const kind = glued ? 'absence' : qualifierKind(text, start, end, { id, hyphenLike, hyphenFree });
    out.push({ start, end, qualified: Boolean(kind), kind });
  }
  return out;
}

// The ingredient's names in the other scripts the routing tables know, used to read PRODUCTS ("레티놀
// 세럼"), never to detect a query intent (the lane's detector is English-only; multilingualBeautyTerms.js
// maps queries). Han / kana / Hangul names match as substrings, because titles in these scripts glue
// words together ("视黄醇精华") -- unless the name is part of a longer compound that is a different
// substance (CJK_COMPOUND_RULES) -- with the CJK negation forms around them.
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
  bakuchiol: ['补骨脂酚', '補骨脂酚', 'バクチオール', '바쿠치올'],
});
// A CJK name inside a longer compound that is a DIFFERENT substance: an ester or ether of it, a
// glycerin derivative, a salicylate. Matched on normalised text around the occurrence.
//   - Any Han name followed (within the same run of Han characters) by 酯 (ester) or 醚 (ether):
//     视黄醇棕榈酸酯 retinyl palmitate, 水杨酸乙基己酯 ethylhexyl salicylate, 水杨酸苄酯 benzyl
//     salicylate, 甘油硬脂酸酯 glyceryl stearate, 甘油聚醚-26 glycereth-26.
//   - Per name, the compounds that put another word before or after it.
// A retinyl ester is not retinol for strict matching (it is a different, weaker retinoid; the
// contract's retinoid safety rules are separate and unchanged).
const HAN_NAME_RE = /[\u3400-\u9fff]$/;
const HAN_ESTER_OR_ETHER_AFTER_RE = /^[\u3400-\u9fff]{0,4}[酯醚]/;
const CJK_COMPOUND_RULES = Object.freeze({
  // (甘油三酯 / 甘油硬脂酸酯 / 甘油聚醚 are caught by the ester / ether rule above)
  甘油: { before: /(?:基|聚|硝酸)$/ },
  グリセリン: { before: /(?:エチルヘキシル|ポリ|ジ|カプリリル|ヘキシル)$/ },
  글리세린: { before: /(?:에틸헥실|헥실|폴리|다이|카프릴릴)$/ },
  // 类视黄醇 is "retinoids" (the family), not retinol
  视黄醇: { before: /[类類]$/ },
  視黃醇: { before: /[类類]$/ },
  レチノール: { before: /(?:パルミチン酸|酢酸|プロピオン酸|リノール酸)$/ },
  레티놀: { after: /^\s*(?:팔미테이트|아세테이트|프로피오네이트)/ },
  サリチル酸: { after: /^(?:エチルヘキシル|ベンジル|メチル|フェニル|ブチルオクチル|ホモメンチル|オクチル)/ },
});

function insideDifferentCompound(text, start, end, alias) {
  const after = text.slice(end);
  if (HAN_NAME_RE.test(alias) && HAN_ESTER_OR_ETHER_AFTER_RE.test(after)) return true;
  const rule = CJK_COMPOUND_RULES[alias];
  if (!rule) return false;
  return Boolean((rule.before && rule.before.test(text.slice(0, start))) || (rule.after && rule.after.test(after)));
}

// Russian names with their inflection endings, bounded: a noun's case endings, an adjective's
// ("гиалуроновой кислотой"), never an open stem -- "гиалуронидаза" (an enzyme), "ретинолоподобный"
// ("retinol-like") are not the ingredient. Vitamin C is "витамин С" in the singular only, and not when
// the "с" is the preposition "with" ("витамин с маслом", a noun in the instrumental after it).
// Endings are written as normalizeForMatch leaves them: it strips the breve, so "й" is "и" ("гиалуроновой"
// is matched as "гиалуроновои").
const RU_NOUN = '(?:|а|у|ом|е|ы|ов|ам|ами|ах)';
const RU_ADJ = '(?:ая|ои|ую|ыи|ое|ого|ому|ым|ом|ые|ых|ыми|еи)';
const RU_INSTRUMENTAL_WORD = '\\s+\\p{L}*(?:ом|ем|ои|еи|ами|ями|ью)(?=\\s|$)';
const RUSSIAN_INGREDIENT_FORMS = Object.freeze({
  retinol: [`ретинол${RU_NOUN}`],
  hyaluronic_acid: [`гиалурон${RU_NOUN}`, `гиалуронов${RU_ADJ}`],
  niacinamide: [`ниацинамид${RU_NOUN}`],
  // ... and in the plural only in a list of vitamin letters ("витамины С и Е", "витаминов С, Е")
  ascorbic_acid: [`аскорбинов${RU_ADJ}`, `витамин(?:|а|у|ом|е)\\s+[cс](?=\\s|$)(?!${RU_INSTRUMENTAL_WORD})`,
    `витамин(?:ы|ов|ами|ах)\\s+[cс](?=\\s*$|\\s+(?:и|[a-zа-я])(?=\\s|$))`],
  salicylic_acid: [`салицилов${RU_ADJ}`],
  ceramide_np: [`церамид${RU_NOUN}`],
  azelaic_acid: [`азелаинов${RU_ADJ}`],
  benzoyl_peroxide: [`бензоилпероксид${RU_NOUN}`, `бензоил(?:а)?\\s+пероксид${RU_NOUN}`],
  panthenol: [`пантенол${RU_NOUN}`],
  glycerin: [`глицерин${RU_NOUN}`],
  bakuchiol: [`бакучиол${RU_NOUN}`],
});
const CJK_NEGATION_BEFORE_RE = /(?:不含|无添加|無添加|无|無|没有|沒有|避开|避開|不要|不加)\s*$/;
// Korean 프리 ("free") wherever it is glued -- 레티놀프리, 레티놀 프리, 레티놀프리크림 -- except as the
// start of 프리미엄 ("premium").
const CJK_NEGATION_AFTER_RE = /^\s*(?:free(?=\s|$)|フリー|不使用|無添加|なし|無し|없는|무첨가|프리(?!미엄)|없이|대체|代替|替代)/;

function cjkOccurrences(text, alias) {
  const out = [];
  if (!text || !alias) return out;
  let from = 0;
  for (;;) {
    const start = text.indexOf(alias, from);
    if (start < 0) break;
    const end = start + alias.length;
    from = start + 1;
    if (insideDifferentCompound(text, start, end, alias)) continue;
    const qualified = CJK_NEGATION_BEFORE_RE.test(text.slice(0, start)) || CJK_NEGATION_AFTER_RE.test(text.slice(end));
    out.push({ start, end, qualified, kind: qualified ? 'absence' : null });
  }
  return out;
}

function russianOccurrences(text, id, forms = RUSSIAN_INGREDIENT_FORMS[id] || []) {
  const out = [];
  for (const form of forms) {
    const pattern = new RegExp(`(?:^|\\s)(${form})(?=\\s|$)`, 'gu');
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index + (match[0].startsWith(' ') ? 1 : 0);
      const end = start + match[1].length;
      const kind = qualifierKind(text, start, end, { id });
      out.push({ start, end, qualified: Boolean(kind), kind });
    }
  }
  return out;
}

// Occurrences of any of an ingredient's names in normalised text, in every script.
function ingredientOccurrences(text, latinTerms, id, { hyphenLikeTerms = [], hyphenFreeTerms = [] } = {}) {
  const out = [];
  for (const term of latinTerms) {
    out.push(...termOccurrences(text, term, { id, hyphenLike: hyphenLikeTerms.includes(term), hyphenFree: hyphenFreeTerms.includes(term) }));
  }
  for (const raw of NON_LATIN_INGREDIENT_NAMES[id] || []) {
    const alias = normalizeForMatch(raw);
    if (alias) out.push(...cjkOccurrences(text, alias));
  }
  out.push(...russianOccurrences(text, id));
  return out;
}

// A qualifier on a LIST of ingredients qualifies every one of them: "alternative to retinol and
// niacinamide", "retinol and niacinamide alternative", "without retinol or vitamin c". Members are
// adjacent occurrences joined only by a list word (and / or / nor, in the languages the absence words
// come from) or by nothing (a comma, which normalisation removed). A group whose qualified members
// disagree (an absence and a stand-in) is left as it is.
// A list needs an EXPLICIT joiner -- a list word, a comma or "&" (the last two are rewritten to "and"
// before normalisation, see normalizeForRouting) -- the same joiners the raw canonicalisation below
// reads (RAW_LIST_JOINER). Two ingredients side by side are not a list: in "niacinamide retinol-free
// serum" only retinol is excluded. Single-letter joiners ("e", "o") are left out: "vitamin e" is an
// ingredient, not a list.
// A stand-in active is never a list member: "bakuchiol and retinol free serum" reads "bakuchiol, and
// retinol-free" -- the stand-in named beside the ingredient it replaces is the ask, as in "retinol free
// bakuchiol"; excluding the very stand-in the shopper typed would be the surprising reading.
const LIST_JOIN_WORDS = Object.freeze(['and', 'or', 'nor', 'und', 'oder', 'et', 'ou', 'y', 'и', 'или']);
const LIST_JOINER_RE = new RegExp(`^\\s+(?:${LIST_JOIN_WORDS.join('|')})\\s+$`, 'u');
function distributeListQualifiers(normalized, occurrences) {
  const standInActiveIds = Object.values(STAND_IN_ACTIVE_ALIASES);
  const sorted = occurrences.filter((occurrence) => !standInActiveIds.includes(occurrence.id)).sort((a, b) => a.start - b.start);
  const standIns = occurrences.filter((occurrence) => standInActiveIds.includes(occurrence.id));
  const groups = [];
  for (const occurrence of sorted) {
    const last = groups[groups.length - 1];
    const previous = last ? last[last.length - 1] : null;
    if (previous && LIST_JOINER_RE.test(normalized.slice(previous.end, occurrence.start))) last.push(occurrence);
    else groups.push([occurrence]);
  }
  return standIns.concat(groups.flatMap((group) => {
    const kinds = Array.from(new Set(group.map((occurrence) => occurrence.kind).filter(Boolean)));
    if (group.length < 2 || kinds.length !== 1) return group;
    return group.map((occurrence) => (occurrence.kind ? occurrence : { ...occurrence, qualified: true, kind: kinds[0] }));
  }));
}

// Every strict-table / stand-in term occurrence in normalised query text (longest terms first, no
// overlaps), with list qualifiers distributed.
// Family names a QUERY may exclude an ingredient by ("retinoid free serum", "no retinal", "Retin-A
// alternative"): read only when qualified away, as an exclusion of that ingredient. A family name asked
// for positively ("retinal serum") is not a request for the ingredient, and is not read.
const FAMILY_QUERY_TERMS = Object.freeze(
  RETINOID_FAMILY_LATIN.map((term) => [normalizeForMatch(term), 'retinol'])
    .filter(([term]) => term && !TERM_TO_ID.has(term))
    .sort((a, b) => b[0].length - a[0].length),
);

function strictIngredientOccurrences(normalized) {
  const consumed = new Array(normalized.length).fill(false);
  const found = [];
  const take = (occurrence, id, familyOnly) => {
    for (let i = occurrence.start; i < occurrence.end; i += 1) if (consumed[i]) return;
    for (let i = occurrence.start; i < occurrence.end; i += 1) consumed[i] = true;
    found.push({ ...occurrence, id, ...(familyOnly ? { familyOnly: true } : {}) });
  };
  for (const term of STRICT_TERMS_BY_LENGTH) {
    const id = TERM_TO_ID.get(term);
    for (const occurrence of termOccurrences(normalized, term)) take(occurrence, id, false);
  }
  for (const [term, id] of FAMILY_QUERY_TERMS) {
    for (const occurrence of termOccurrences(normalized, term, { id })) take(occurrence, id, true);
  }
  return distributeListQualifiers(normalized, found);
}

// Query side: which table ingredients the text asks FOR, which it EXCLUDES (mentions only in a
// qualified form), and which of those it excludes only as a STAND-IN ("retinol alternative"). A
// positive mention anywhere wins. Ids in table order.
// normalizeForMatch, after turning a comma or "&" into the list word "and" (normalisation would
// otherwise delete them, and a comma list would read as two unrelated words).
function normalizeForRouting(raw) {
  return normalizeForMatch(String(raw || '').replace(/\s*[,&]\s*/g, ' and '));
}

function classifyStrictIngredientMentions(text) {
  const normalized = normalizeForRouting(text);
  const states = new Map();
  if (normalized) {
    for (const occurrence of strictIngredientOccurrences(normalized)) {
      if (occurrence.familyOnly && !occurrence.kind) continue;
      const state = states.get(occurrence.id) || { positive: false, absence: false, standin: false };
      if (occurrence.kind === 'absence') state.absence = true;
      else if (occurrence.kind === 'standin') state.standin = true;
      else state.positive = true;
      states.set(occurrence.id, state);
    }
  }
  const wanted = [];
  const excluded = [];
  const standInOnly = [];
  for (const id of Object.values(ROUTING_ALIASES)) {
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
  const qualified = strictIngredientOccurrences(text).filter((occurrence) => occurrence.qualified);
  if (qualified.length === 0) return text;
  let out = text;
  for (const occurrence of qualified.sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, occurrence.start)} ${out.slice(occurrence.end)}`;
  }
  return out.replace(/\s+/g, ' ').trim();
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
  // marketing words, in the scripts a query may mix in ("레티놀 프리미엄" is a premium retinol)
  'premium', '프리미엄', 'プレミアム',
]);

// True when the query is ONLY one or more strict-table ingredients (plus filler words, including
// "dupe" / "like" / "similar"), each asked for positively. "retinol", "Hyaluronic Acid", "best niacinamide products" -> true;
// "retinol serum", "retinol 크림", "retinol-free", "0% retinol", "hyaluronic" (not a table term) -> false.
function isBareStrictIngredientQuery(text) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return false;
  // A qualified mention leaves its qualifier word behind ("free", "without", "alternative"), and no
  // qualifier word is a filler word, so a query with one is never bare: no separate check needed.
  const { wanted } = classifyStrictIngredientMentions(normalized);
  if (wanted.length === 0) return false;
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

function productTitleRaw(product) {
  if (!product || typeof product !== 'object') return '';
  return [product.title, product.name, product.product_title].filter((value) => typeof value === 'string' && value.trim()).join(' | ');
}

// The naming terms a raw title glues to "-like" ("Retinol-Like Serum", "Retinol‑like"): normalisation
// turns the hyphen into a space, so this is read before it.
function hyphenGluedTerms(rawTitle, terms, word) {
  const raw = String(rawTitle || '').toLowerCase();
  if (!raw.includes(word)) return [];
  return terms.filter((term) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term).replace(/ /g, '[\\s-]+')}\\s*[-\u2010\u2011\u2013]\\s*${word}(?![\\p{L}\\p{N}])`, 'u').test(raw),
  );
}
const hyphenLikeTerms = (rawTitle, terms) => hyphenGluedTerms(rawTitle, terms, 'like');
const hyphenFreeTerms = (rawTitle, terms) => hyphenGluedTerms(rawTitle, terms, 'free');

// How the product mentions one ingredient, STRUCTURED EVIDENCE FIRST:
//   'named'         its ingredient_ids carry it, or a structured ingredient entry names it (not
//                   qualified away), or -- failing structured evidence -- its title names it outright;
//                   in any script the routing tables know;
//   'negated_only'  no positive evidence, and some mention is qualified away ("Retinol-Free",
//                   "Phyto-Retinol", "Retinol-Like", "Retinol Alternative", "Better Than Retinol",
//                   "0% Retinol", "Retinol 0%", "No Added Retinol", "Not Retinol", "레티놀 프리",
//                   "레티놀프리크림");
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
  const titleRaw = productTitleRaw(product);
  const titleTerms = strictIngredientNamingTerms(id);
  const titleOccurrences = ingredientOccurrences(normalizeForMatch(titleRaw), titleTerms, id, {
    hyphenLikeTerms: hyphenLikeTerms(titleRaw, titleTerms),
    hyphenFreeTerms: hyphenFreeTerms(titleRaw, titleTerms),
  });
  for (const occurrence of titleOccurrences) {
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
// An EXCLUSION excludes the ingredient's whole family, not just its name: "retinol alternative serum"
// must not serve a retinal or a Granactive Retinoid serum. A family member is read like the ingredient
// (whole words, qualifiers, CJK compound and negation rules, bounded Russian endings), in titles and
// structured fields, and any positive mention excludes the row (no INCI veto: an exclusion fails
// toward excluding). Asking FOR an ingredient (lane admission) is unchanged: only its own name counts.
//   retinol: the retinoids, from the shared list in src/services/retinoidFamily.js (retinal, retinyl
//            esters, vitamin A, HPR / Granactive Retinoid, tretinoin, adapalene, tazarotene,
//            trifarotene, Retin-A, "retinoid" in four languages, in every script the tables know).
//   others:  their structured INCI synonyms (salts, esters, derivatives), now read in titles too.
// The tables have no AHA (glycolic / lactic / mandelic) or other acid family: none is a table ingredient.
const INGREDIENT_FAMILY = Object.freeze({
  retinol: { latin: RETINOID_FAMILY_LATIN, nonLatin: RETINOID_FAMILY_SCRIPT, russian: RETINOID_FAMILY_RUSSIAN },
});

function familyLatinTerms(id) {
  const extra = INGREDIENT_FAMILY[id]?.latin || [];
  const synonyms = STRUCTURED_INCI_SYNONYMS[id] || [];
  return Array.from(new Set([...extra, ...synonyms].map((term) => normalizeForMatch(term)).filter(Boolean)));
}

// True when the product names the ingredient or any member of its family, positively, anywhere.
function productNamesIngredientFamily(product, ingredientId) {
  const id = String(ingredientId || '').trim().toLowerCase();
  if (!id || !product || typeof product !== 'object') return false;
  if (productIngredientMention(product, id) === 'named') return true;
  const latin = familyLatinTerms(id);
  const nonLatin = (INGREDIENT_FAMILY[id]?.nonLatin || []).map((raw) => normalizeForMatch(raw)).filter(Boolean);
  const russian = INGREDIENT_FAMILY[id]?.russian || [];
  if (latin.length === 0 && nonLatin.length === 0 && russian.length === 0) return false;
  const titleRaw = productTitleRaw(product);
  const { actives, inci } = productStructuredFields(product);
  const texts = [
    { text: normalizeForMatch(titleRaw), hyphenLike: hyphenLikeTerms(titleRaw, latin), hyphenFree: hyphenFreeTerms(titleRaw, latin) },
    ...[...actives, ...inci].map((text) => ({ text, hyphenLike: [], hyphenFree: [] })),
  ];
  for (const { text, hyphenLike, hyphenFree } of texts) {
    for (const term of latin) {
      const found = termOccurrences(text, term, { id, hyphenLike: hyphenLike.includes(term), hyphenFree: hyphenFree.includes(term) });
      if (found.some((occurrence) => !occurrence.qualified)) return true;
    }
    for (const alias of nonLatin) if (cjkOccurrences(text, alias).some((occurrence) => !occurrence.qualified)) return true;
    if (russianOccurrences(text, id, russian).some((occurrence) => !occurrence.qualified)) return true;
  }
  return false;
}

function excludeProductsNamingIngredients(products = [], { ingredientIds = [] } = {}) {
  const list = Array.isArray(products) ? products : [];
  const ids = cleanIds(ingredientIds);
  if (ids.length === 0) return { products: list, dropped_count: 0 };
  const kept = list.filter((product) => !ids.some((id) => productNamesIngredientFamily(product, id)));
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

// `requiredIds` (optional): rows must also NAME each of these (the stand-in a query asked for:
// "bakuchiol instead of retinol"). `scopePrefix` (optional): rows outside this category path are
// dropped too. A row with NO category path (typical of backend-lane rows) is judged by the path
// `inferCategoryPath(row)` reads from its own title / product type; when that names nothing, the row is
// KEPT (fail safe): the scope only stops cross-area padding (a shampoo for a skincare query), the
// exclusion above has already been applied to it, and dropping every unfiled row would empty whole
// lanes ("glycerin-free hair gel" served by the backend lane).
function excludeIngredientsFromPage(body, { ingredientIds = [], requiredIds = [], scopePrefix = null, inferCategoryPath = null } = {}) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.products)) return { body, dropped_count: 0 };
  const exclusion = excludeProductsNamingIngredients(body.products, { ingredientIds });
  const required = admitIngredientLaneProducts(exclusion.products, { ingredientIds: requiredIds });
  const scope = scopePrefix ? String(scopePrefix).toLowerCase().replace(/\/+$/, '') : '';
  const kept = scope
    ? required.products.filter((product) => {
        let path = productCategoryPath(product);
        if (!path && typeof inferCategoryPath === 'function') path = String(inferCategoryPath(product) || '').toLowerCase().replace(/\/+$/, '');
        if (!path) return true;
        return path === scope || path.startsWith(`${scope}/`);
      })
    : required.products;
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
// A list of terms ("retinol and niacinamide", "retinol, niacinamide or vitamin c"), one capture.
// List members are table ingredients only (a stand-in active is never a member, as above); a stand-in
// active is still negated on its own ("bakuchiol-free").
const TABLE_TERM_ALTERNATION = Object.keys(STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES)
  .map((term) => normalizeForMatch(term))
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join('|');
const RAW_TABLE_TERM_NC = `(?:${TABLE_TERM_ALTERNATION.replace(/ /g, '[\\s-]+')})`;
const RAW_STAND_IN_TERM_NC = `(?:${Object.keys(STAND_IN_ACTIVE_ALIASES).map(escapeRegExp).join('|')})`;
const RAW_LIST_JOINER = `(?:\\s*[,&]\\s*(?:(?:${LIST_JOIN_WORDS.join('|')})\\s+)?|\\s+(?:${LIST_JOIN_WORDS.join('|')})\\s+)`;
const RAW_TERM_LIST = `((?:${RAW_TABLE_TERM_NC}(?:${RAW_LIST_JOINER}${RAW_TABLE_TERM_NC})*)|${RAW_STAND_IN_TERM_NC})`;
const RAW_LIST_SPLIT_RE = new RegExp(RAW_LIST_JOINER, 'i');
// "0%" / "0.0%" only as its own number: never the tail of "1.0%" or "10%".
const RAW_NEGATED_TERM_RE = new RegExp(
  `(?<![\\w.-])(?:without(?:\\s+any)?|no(?:\\s+added)?|non|not|avoid(?:ing)?|free\\s+(?:of|from)|zero|0(?:\\.0+)?\\s*%|sans|sin|ohne|frei\\s+von|libre\\s+de)[\\s-]+${RAW_TERM_LIST}\\b`,
  'gi',
);
// German glues it on: "retinolfrei", "Retinol-frei", "Retinolfreie Creme".
const RAW_TERM_FREI_RE = new RegExp(`\\b${RAW_TERM}-?frei(?:e|er|es|en|em)?\\b`, 'gi');
const RAW_TERM_FREE_RE = new RegExp(
  `\\b${RAW_TERM_LIST}[\\s-]+free\\b(?![\\s-]+${FREE_NOT_ABSENCE}\\b)`,
  'gi',
);
// A trailing zero: "retinol 0%", "Retinol-0.0%". Not "retinol 10%", "retinol 1.0%", "retinol 0.3%".
const RAW_TERM_ZERO_RE = new RegExp(`\\b${RAW_TERM}[\\s-]*0(?:\\.0+)?\\s*%(?![\\d.%])`, 'gi');
// A form noun in another language right next to a strict ingredient reads as "cream", as the
// multilingual table maps it ("Retinolfreie Creme" keeps its form with only this flag on).
const RAW_CREAM_NOUN_RE = /(?<![\p{L}])(?:cr[eè]me|crema)(?![\p{L}])|크림(?![\uac00-\ud7af])|クリーム/giu;
const RAW_TERM_ANY_RE = new RegExp(`\\b(?:${STRICT_TERM_ALTERNATION.replace(/ /g, '[\\s-]+')})`, 'i');

function canonicalizeEnglishIngredientNegations(rawQuery) {
  const text = String(rawQuery || '');
  if (!text.trim()) return { query: text, changed: false };
  const toFree = (_match, term) => `${term.toLowerCase().replace(/[\s-]+/g, ' ')}-free`;
  // A list keeps every member: "without retinol and niacinamide" -> "retinol-free niacinamide-free".
  const listToFree = (_match, list) => list.split(RAW_LIST_SPLIT_RE).map((term) => toFree(null, term)).join(' ');
  let out = text
    .replace(RAW_NEGATED_TERM_RE, listToFree)
    .replace(RAW_TERM_FREI_RE, toFree)
    .replace(RAW_TERM_FREE_RE, listToFree)
    .replace(RAW_TERM_ZERO_RE, toFree);
  if (out !== text && RAW_TERM_ANY_RE.test(out)) out = out.replace(RAW_CREAM_NOUN_RE, 'cream');
  if (out === text) return { query: text, changed: false };
  return { query: out.replace(/\s+/g, ' ').trim(), changed: true };
}

module.exports = {
  KNOWN_STAND_INS,
  STAND_IN_ACTIVE_ALIASES,
  NON_LATIN_INGREDIENT_NAMES,
  BARE_INGREDIENT_ROUTING_FLAG,
  STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES,
  bareIngredientRoutingMode,
  isBareIngredientRoutingEnabled,
  readMode,
  normalizeForMatch,
  normalizeForRouting,
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
  productNamesIngredientFamily,
  excludeIngredientsFromPage,
  canonicalizeEnglishIngredientNegations,
};
