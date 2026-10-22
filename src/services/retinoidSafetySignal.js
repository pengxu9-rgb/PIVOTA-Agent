'use strict';

// Does a shopping request carry a reason to keep retinoids out of the answer?
//
// The beauty search gate (isBeautyProductContraindicatedForQuery in src/server.js) drops retinoid
// products when the query's intent carries `avoid_retinoids`. Before this module, that flag was set
// by one English regex (pregnan* | ttc | trying to conceive | retinol-free | no retinol) plus a few
// Chinese words. So "retinol serum breastfeeding", "retinol serum for kids", "preggo retinol serum"
// and "retinol serum 임산부" all served retinoids. A serum never reaches the moisturizer /
// cleanser / sunscreen retinoid rule, so nothing else stood behind that regex.
//
// This module answers the question for the query text AND for the rest of the request: earlier
// conversation turns, a user profile, ingredient constraints and safety flags. It never decides
// what a product is. It only says whether retinoids must be kept out, and why.
//
// TIERS. Gating hides retinoids from people who can use them, so the lexicon is split:
//   HARD (always on):
//     - pregnancy / lactation / fertility;
//     - children under 12;
//     - isotretinoin, or being "on" a prescription retinoid (layering context);
//     - the user saying no to retinoids ("don't want retinol", "retinol broke me out").
//   SOFT (BEAUTY_RETINOID_SOFT_SAFETY_TIER=on; default off):
//     - teens 12-17 and students;
//     - skin conditions;
//     - sensitivity.
//     These are judgement calls, not contraindications. The existing sensitive-query rule in the
//     gate keeps gating what it already gated, whatever this flag says. The soft tier only adds.
//
// MATCHING. Words are matched on three views of the text:
//   - script view: NFKC, zero-width characters removed, lowercased. It keeps Hangul, Cyrillic,
//     Thai, CJK and emoji, which the search normaliser deletes.
//   - latin view: the script view with Cyrillic / Greek look-alikes mapped to Latin, accents
//     removed, and every non-letter turned into a space.
//   - compact view: the latin view with every separator removed, so "p r e g n a n t",
//     "pre-gnant" and "#momtobe" are caught for the long, distinctive stems.
// Typos of the core words are caught by a bounded edit-distance check: one edit, words of six or
// more letters, same first letter.
//
// AGES. An age of 11 or under is a child (hard). 12 to 17 is a teen (soft). 18 and over is an adult
// and does not gate: adult retinoid use is ordinary.

const SOFT_TIER_ENV = 'BEAUTY_RETINOID_SOFT_SAFETY_TIER';

function softTierEnabled(env = process.env) {
  return String(env[SOFT_TIER_ENV] || '').trim().toLowerCase() === 'on';
}

// ---------------------------------------------------------------------------------------------
// Retinoid names: used by the negation class and by ingredient constraints. Latin view / script view.
const RETINOID_NAME_LATIN =
  /\b(?:retinol\w*|retinal\w*|retinoid\w*|retinyl\w*|retinoic|tretinoin|isotretinoin|adapalene|tazarotene|trifarotene|retin\s?a|vitamin\s?a|granactive|hydroxypinacolone|hpr|accutane|roaccutane)\b/;
const RETINOID_NAME_SCRIPT = /视黄醇|視黃醇|维a|維a|a醇|维甲酸|維甲酸|レチノール|레티놀|레틴|ретинол|ретиноид|เรตินอล/;

// ---------------------------------------------------------------------------------------------
// HARD tier lists.

// Pregnancy, lactation and fertility. Latin view, word-bounded.
const HARD_PREGNANCY_LACTATION_FERTILITY_LATIN = [
  'pregnan\\w*', 'preggo', 'preggers', 'preggy', 'mom\\s?to\\s?be', 'mum\\s?to\\s?be', 'mama\\s?to\\s?be', 'moms\\s?to\\s?be',
  'maternity', 'bun\\s+in\\s+the\\s+oven', 'ob\\s?gyn', 'trimesters?', 'ivf', 'fertility', 'infertility', 'conceiv\\w*',
  'conception', 'ttc', 'trying\\s+(?:to\\s+conceive|for\\s+a\\s+baby)', 'expecting', 'expectant', 'new\\s+(?:mom|mum|mother|mama)s?',
  'bf\\s+(?:mom|mum|mama)s?', 'bfing', 'pumping', 'for\\s+(?:moms|mums|mothers|mamas)', 'post\\s?partum', 'postnatal',
  'prenatal', 'antenatal', 'gestational', 'breast\\s?feed\\w*', 'breast\\s?fed', 'nursing', 'lactating', 'lactation',
  // Other Latin-script languages.
  'embarazad\\w*', 'lactancia', 'lactante', 'enceinte', 'allait\\w*', 'grossesse', 'schwanger\\w*', 'stillzeit', 'stillende',
  'gravidanza', 'incinta', 'allattamento', 'gravida', 'gravidez', 'gestante', 'amamenta\\w*', 'hamil', 'menyusui',
  'mang\\s+thai', 'cho\\s+con\\s+bu', 'gebelik', 'hamile', 'emzirme', 'zwanger\\w*', 'borstvoeding',
  'embaraz\\w*', 'gestac\\w*', 'stillen', 'mang\\s+bau', 'co\\s+bau', 'knocked\\s+up', 'eating\\s+for\\s+two',
  'baby\\s+bump', 'with\\s+child',
  // Vietnamese, Spanish, Turkish, Indonesian (accents folded)
  'ba\\s+bau', 'me\\s+bau', 'co\\s+thai', 'sau\\s+sinh', 'posparto', '(?<!ich\\s)gebe', 'bumil', 'busui',
  // English
  '(?:mother|mommy|mummy|mommie|mamma)s?\\s?to\\s?be', 'soon\\s?to\\s?be\\s+(?:mom|mum|mama|mommy|mummy|mother|parents?)s?',
  'pregs?', 'pregnate', 'pregnet', 'pregnent', 'chest\\s?feed\\w*', 'egg\\s+retrieval', 'egg\\s+freezing',
  'in\\s+the\\s+family\\s+way', '(?<!(?:delivery|shipping|order|payment|return|invoice|billing)\\s)due\\s+date',
  '(?:1st|2nd|3rd|first|second|third)\\s+tri',
];
// Script view, substring.
const HARD_PREGNANCY_LACTATION_FERTILITY_SCRIPT = [
  '임산부', '임신', '임부', '수유', '산후', '출산', '모유', 'беремен', 'кормящ', 'грудн', 'грудью', 'лактац',
  'ตั้งครรภ์', 'ให้นมบุตร', 'ตั้งท้อง', 'गर्भवती', 'गर्भावस्था', 'स्तनपान', 'حامل', 'الحمل', 'رضاعة', 'مرضع',
  'マタニティ', '喂奶', '餵奶', '母乳',
  '妊婦', '妊活', '産後', '産婦', '妊娠', '授乳', '孕', '哺乳', '坐月子', '月子', '产后', '產後', '宝妈', '寶媽',
  '🤰', '🤱', '🫃', '🫄',
  '准妈', '准媽', '產婦', '产妇', '孕妇', '산모', 'คนท้อง', 'แม่ท้อง', 'หลังคลอด', 'ให้นมลูก',
];
// Script view, as regexes: words that need a boundary or a following-word check.
const HARD_PREGNANCY_LACTATION_FERTILITY_SCRIPT_RES = [
  // Russian "в положении" (pregnant), but not a body position ("в положении лёжа")
  /(?<![а-яё])в\s+положении(?!\s+(?:лёжа|лежа|сидя|стоя))/,
  // Russian ГВ (breastfeeding), as a word of its own
  /(?<![а-яёa-z])гв(?![а-яёa-z])/,
];
// Compact view, substring. Only long, distinctive stems: these match across separators.
const HARD_PREGNANCY_LACTATION_FERTILITY_COMPACT = [
  'pregnan', 'preggo', 'preggers', 'momtobe', 'mumtobe', 'mamatobe', 'breastfe', 'lactating', 'lactation', 'postpartum',
  'trimester', 'maternity', 'tryingtoconceive', 'embaraz', 'schwanger', 'zwanger', 'gravidanza', 'amamenta',
];
// Typos of these words are caught by the edit-distance check.
const HARD_PREGNANCY_LACTATION_FERTILITY_FUZZY = [
  'pregnant', 'pregnancy', 'breastfeeding', 'breastfeed', 'postpartum', 'lactating', 'lactation', 'trimester',
];

// Children under 12.
const HARD_CHILD_UNDER_12_LATIN = [
  'kids?', 'kiddos?', 'child', 'children', 'childrens', 'infants?', 'toddlers?', 'newborns?', 'bab(?:y|ies)',
  'ninos', 'ninas', 'bebe', 'bebes', 'enfants?', 'kinder', 'crianca', 'criancas', 'elementary\\s+school',
  'primary\\s+school', 'grade\\s?school(?:ers?)?', 'preschool(?:ers?)?', 'kindergarten',
  'kidz', 'pre\\s?teens?', 'pre\\s?tweens?', 'little\\s+ones?',
  'for\\s+my\\s+(?:little\\s+)?(?:son|daughter|boy|girl)s?',
  '(?:1st|2nd|3rd|4th|5th|6th|first|second|third|fourth|fifth|sixth)\\s+grade(?:rs?)?',
  // "under 12" as an age; a bare "under 12" is a price cap
  '(?:kids?|children|child|ages?|aged)\\s+(?:under|below)\\s+(?:1[0-2]|[1-9])',
  '(?:under|below)\\s+(?:age\\s+)?(?:1[0-2]|[1-9])\\s?(?:s|yrs?|years?|yo|y\\s?o)',
  // Vietnamese, Spanish, German, Italian, Dutch, Turkish, Indonesian (accents folded)
  'tre\\s+em', 'em\\s+be', 'infantil', '(?:fur|fuer|mein(?:em)?|unser(?:em)?|kleines?)\\s+kind', 'bambin[oaie]',
  'kinderen', 'cocuk\\w*', 'bebek', 'anak', 'anak\\s+anak', 'bayi',
];
const HARD_CHILD_UNDER_12_SCRIPT = [
  '👶', '🍼', '孩子', '小孩', '宝宝', '寶寶', '婴', '嬰', '儿童', '兒童', '幼儿', '幼兒', '赤ちゃん', '子供', '子ども', 'こども', '幼児',
  '아기', '어린이', '유아', 'ребен', 'ребён', 'детск', 'дети', 'детей', 'малыш',
  'เด็ก', 'ทารก', '小朋友', '孩童', '小学生', '小學生', '키즈', '초등학생', 'キッズ', 'ベビー',
];
const HARD_CHILD_UNDER_12_SCRIPT_RES = [
  // 아이 (child) as a word, with its particles; never 아이크림, 아이섀도 ("eye")
  /(?<![가-힣])아이(?:들|용|가|를|에게|한테|도|의|는)?(?![가-힣])/,
  // niño / niña, with the tilde (folded, "nina" is a name)
  /(?<![\p{L}])niñ[oa]s?(?![\p{L}])/u,
];

// Isotretinoin, or being on a prescription retinoid: layering / contraindication context, never an ask.
const HARD_ISOTRETINOIN_LAYERING_LATIN = [
  'accutane', 'roaccutane', 'isotretinoin\\w*', 'isotret', 'absorica', 'claravis', 'amnesteem', 'myorisan', 'zenatane',
  '(?:on|use|uses|using|taking|prescribed|started|starting)\\s+(?:a\\s+|my\\s+)?(?:tretinoin|tret|adapalene|differin|tazarotene|tazorac|arazlo|trifarotene|aklief|epiduo|altreno|atralin|renova|avita|retin\\s?a|prescription\\s+retinoids?)',
];
const HARD_ISOTRETINOIN_LAYERING_COMPACT = ['accutane', 'isotretinoin', 'isotret'];
const HARD_ISOTRETINOIN_LAYERING_FUZZY = ['accutane', 'isotretinoin'];

// The user saying no to retinoids. A negation counts only when it binds to the retinoid term itself:
// "no retinol", "retinol-free", "can't use retinol", "retinol irritates me". A negation of another
// word in the same text is not a "no" to the retinoid: "retinol without irritation", "oil free
// retinol", "non-comedogenic retinol", "retinol not greasy", "strongest retinol no prescription",
// "retinol free shipping", "retinol stopped working" all still ask for one.
// Matched on the latin view, where apostrophes are dropped and punctuation is a space
// ("retinol-free" is "retinol free", "don't" is "dont").
const RETINOID_NAME_FOR_NEGATION =
  '(?:retinol\\w*|retinal\\w*|retinoid\\w*|retinyl\\w*|retinoic|tretinoin|isotretinoin|adapalene|tazarotene|trifarotene|retin\\s?a|vit(?:amin)?\\s?a|granactive|hydroxypinacolone|hpr|differin|accutane)';
// Up to three filler words between the negation and the name: "no added retinol", "avoid any
// retinoids", "nothing with retinol", "avoid using any more retinol". Four are not a negation of the
// name: "what not to use with my retinol" asks how to pair it.
const NEGATION_FILLER = '(?:\\s+(?:any|a|an|the|added|more|my|with|to|use|using|products?\\s+with|anything\\s+with)){0,3}';
const HARD_NEGATION_BEFORE_NAME_LATIN = [
  'no', 'non', 'not', 'without', 'w\\s?o', 'zero', '0\\s?%', 'avoid\\w*', 'skip\\w*', 'minus', 'excluding', 'except', 'sans',
  'sin', 'ohne', 'free\\s+(?:of|from)', 'anything\\s+but', 'other\\s+than', 'instead\\s+of', 'nothing', 'never', 'nope', 'no\\s+thanks',
  'stop(?:ped)?(?:\\s+using)?', 'quit(?:ting)?', 'no\\s+more', 'dont\\s+want', 'do\\s+not\\s+want', 'dont\\s+use',
  'do\\s+not\\s+use', 'cant\\s+use', 'cannot\\s+use', 'can\\s+not\\s+use', 'cant\\s+tolerate', 'cannot\\s+tolerate',
  'cant\\s+handle', 'never\\s+use', 'wont\\s+use', 'hate[sd]?', 'allergic\\s+to', 'allergy\\s+to', 'intolerant\\s+(?:to|of)',
  'sensitive\\s+to', 'react(?:s|ed)?(?:\\s+badly)?\\s+to', 'reaction\\s+to', 'ditch(?:ing|ed)?',
];
const HARD_NEGATION_AFTER_NAME_LATIN = [
  'free(?!\\s+(?:shipping|delivery|gift|gifts|sample|samples|trial|returns?|standard|radicals?|size))',
  'alternatives?', 'substitutes?', 'replacements?', 'irritates?\\s+me', 'irritated\\s+me', 'burns?(?:\\s+my\\s+skin|\\s+me)?',
  'burned\\s+(?:my\\s+skin|me)', 'broke\\s+me\\s+out', 'breaks?\\s+me\\s+out', 'gives?\\s+me\\s+(?:a\\s+)?rash',
  'gave\\s+me\\s+(?:a\\s+)?rash', '(?:(?:is|are|was)\\s+)?not\\s+for\\s+me', '(?:is|are)nt\\s+for\\s+me', 'no\\s+thanks', 'nope', 'allergy', 'allergic',
  'intolerance', 'makes\\s+me\\s+(?:break\\s+out|peel|red)',
];
// A product word may sit between the name and what follows it: "retinol cream gives me a rash",
// "retinol serum, not for me".
const RETINOID_PRODUCT_WORD = '(?:\\s+(?:serums?|creams?|products?|oils?|lotions?|gels?|treatments?|moisturi[sz]ers?))?';
// Same, in other scripts. These count only NEXT TO a retinoid name, the way the strict ingredient
// reader (src/findProductsMulti/strictIngredientQuery.js, CJK_NEGATION_BEFORE_RE / _AFTER_RE) reads
// them, never as a substring anywhere in the text:
//   - 프리 is "free" in 레티놀프리 / 레티놀 프리 / 레티놀프리크림, but the start of 프리미엄 ("premium");
//   - 无 is "without" in 无视黄醇, but part of 无暇 ("flawless");
//   - без is "without" in без ретинола, but the start of безопасный ("safe");
//   - なし is "none" in レチノールなし, but part of はなし ("talk").
const HARD_NEGATION_BEFORE_NAME_SCRIPT = [
  '不含', '无添加', '無添加', '无', '無', '没有', '沒有', '避开', '避開', '避免', '不要', '不加', '不用', '不想用', '不想要',
  '不能用',
];
const HARD_NEGATION_AFTER_NAME_SCRIPT = [
  'フリー', '不使用', '無添加', 'なし', '無し', 'が使えない', 'は使えない', '使えない', '없는', '없이', '무첨가',
  '프리(?!미엄)', '대체', '代替', '替代', '平替', '过敏', '過敏', '안 ?쓰', '못 ?쓰',
];
const RETINOID_NAME_NEXT_TO_NEGATION =
  '(?:视黄醇|視黃醇|维a醇|維a醇|a醇|维甲酸|維甲酸|レチノール|레티놀|레티날|레티노이드|레티닐 ?팔미테이트|retinol|retinal|retinoids?|tretinoin|adapalene)';
const SCRIPT_NEGATION_RES = [
  new RegExp(`(?:${HARD_NEGATION_BEFORE_NAME_SCRIPT.join('|')})\\s*${RETINOID_NAME_NEXT_TO_NEGATION}`),
  new RegExp(`${RETINOID_NAME_NEXT_TO_NEGATION}\\s*(?:${HARD_NEGATION_AFTER_NAME_SCRIPT.join('|')})`),
  // Russian: без / не содержит as a word of its own, before the name (ретинола, ретиноидов ...).
  /(?<![а-яё])(?:без|не\s+содержит)\s+(?:[а-яё]+\s+)?ретин[а-яё]*/,
];

// ---------------------------------------------------------------------------------------------
// SOFT tier lists.

const SOFT_TEEN_LATIN = [
  'teens?', 'teenage', 'teenagers?', 'tweens?', 'adolescents?', 'adolescentes?', 'minors?', 'juniors?', 'students?',
  'puberty', 'high\\s?school(?:ers?)?', 'middle\\s+school(?:ers?)?',
];
const SOFT_TEEN_SCRIPT = ['青少年', '学生', '學生', '中学生', '高中生', '青春期', '高校生', '10代', '청소년', '학생', 'подрост'];

const SOFT_SKIN_CONDITION_LATIN = [
  'redness', 'very\\s+dry', 'extremely\\s+dry', 'thin\\s+skin', 'psoriasis', 'sunburn\\w*', 'post\\s?procedure',
  'post\\s?laser', 'post\\s?peel', 'broken\\s+skin', 'inflamed', 'inflammation', 'itch\\w*', 'flak\\w*', 'atopic',
  'stinging', 'peeling', 'dermatitis', 'eczema', 'rosacea', 'reactive', 'allerg\\w*', 'intoleran\\w*', 'irritated',
];
const SOFT_SKIN_CONDITION_SCRIPT = ['过敏', '過敏', '泛红', '泛紅', '皮炎', '湿疹', '濕疹', '玫瑰痤疮', '玫瑰痤瘡', '酒糟', '脱皮', '脫皮', '刺痛', '아토피', '홍조'];

const SOFT_SENSITIVITY_LATIN = ['sensitive', 'sensiti[sz]ed', 'sensitivity'];
const SOFT_SENSITIVITY_SCRIPT = ['敏感', '민감'];

// ---------------------------------------------------------------------------------------------
// Normalisation.

const TAG_CHAR_RE = /[\u{E0000}-\u{E007F}]/gu;
const ZERO_WIDTH_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
const CONFUSABLES = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't',
  'у': 'y', 'х': 'x', 'і': 'i', 'ї': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ɡ': 'g',
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x',
  'ı': 'i', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe',
  // small capitals, which NFKC leaves alone
  'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k',
  'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w',
  'ʏ': 'y', 'ᴢ': 'z',
  'ɑ': 'a', 'ɩ': 'i', 'ɵ': 'o', 'ʋ': 'u',
};
// Cherokee letters that look like Latin capitals (Unicode confusables), in both cases.
for (const [cherokee, latin] of Object.entries({
  'Ꭺ': 'a', 'Ᏼ': 'b', 'Ꮯ': 'c', 'Ꭰ': 'd', 'Ꭼ': 'e', 'Ꮐ': 'g', 'Ꮋ': 'h', 'Ꭻ': 'j', 'Ꮶ': 'k', 'Ꮮ': 'l', 'Ꮇ': 'm',
  'Ꮲ': 'p', 'Ꭱ': 'r', 'Ꮪ': 's', 'Ꭲ': 't', 'Ꮩ': 'v', 'Ꮃ': 'w', 'Ꮓ': 'z', 'Ꭹ': 'y',
})) {
  CONFUSABLES[cherokee] = latin;
  CONFUSABLES[cherokee.toLowerCase()] = latin;
}
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

// Enclosed letters NFKC leaves alone (negative circled / squared, regional indicators): letters.
const ENCLOSED_LETTER_RE = /[\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}\u{1F1E6}-\u{1F1FF}]/gu;
function enclosedLetter(ch) {
  const cp = ch.codePointAt(0);
  const base = cp >= 0x1f1e6 ? 0x1f1e6 : cp >= 0x1f170 ? 0x1f170 : 0x1f150;
  return String.fromCharCode(97 + cp - base);
}

function scriptView(text) {
  return String(text == null ? '' : text)
    .replace(ENCLOSED_LETTER_RE, enclosedLetter)
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(TAG_CHAR_RE, '')
    .toLowerCase();
}

const SYMBOL_LETTERS = { '@': 'a', '€': 'e', $: 's', '!': 'i', '|': 'l' };
function latinView(script) {
  return script
    .replace(CONFUSABLE_RE, (ch) => CONFUSABLES[ch] || ch)
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/[’'`´]/g, '')
    // a symbol standing for a letter inside a word: pregn@nt, pr€gnant, k!ds, $kin
    .replace(/(?<=[a-z])[@€$!|](?=[a-z])/g, (ch) => SYMBOL_LETTERS[ch])
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();
}

// Digits used as letters ("pr3gn4nt"). Only the compact view and the typo check read this;
// ages are read from the latin view, where digits stay digits.
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };
function deLeet(latin) {
  return latin.replace(/[a-z0-9]+/g, (token) => (/[a-z]/.test(token) ? token.replace(/[013457]/g, (d) => LEET[d]) : token));
}

function compactView(latin) {
  return deLeet(latin).replace(/[^a-z]+/g, '');
}

// Tokens, with runs of single letters joined ("p r e g n a n t" -> "pregnant").
function latinTokens(latin) {
  const raw = latin.split(' ').filter(Boolean);
  const out = [];
  let run = '';
  for (const token of raw) {
    if (/^[a-z]$/.test(token)) {
      run += token;
      continue;
    }
    if (run) {
      out.push(run);
      run = '';
    }
    out.push(token);
  }
  if (run) out.push(run);
  return out;
}

function wordRegex(list) {
  return new RegExp(`(?:^|\\s)(?:${list.join('|')})(?=\\s|$)`);
}

// Damerau-Levenshtein distance, stopped early once it exceeds 1.
function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i += 1;
  // One string is a prefix of the other: within one edit only if it is one letter longer.
  if (i === la || i === lb) return Math.abs(la - lb) === 1;
  // substitution
  if (la === lb && a.slice(i + 1) === b.slice(i + 1)) return true;
  // transposition
  if (la === lb && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return true;
  // insertion / deletion
  if (la + 1 === lb && a.slice(i) === b.slice(i + 1)) return true;
  if (la === lb + 1 && a.slice(i + 1) === b.slice(i)) return true;
  return false;
}

function fuzzyHit(tokens, targets) {
  for (const token of tokens) {
    if (token.length < 6 || token.length > 24) continue;
    for (const target of targets) {
      if (token[0] === target[0] && withinOneEdit(token, target)) return target;
    }
  }
  return null;
}

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const AGE_NUMBER = `(\\d{1,3}|${Object.keys(WORD_NUMBERS).join('|')})`;
const AGE_PATTERNS = [
  new RegExp(`(?:^|\\s)${AGE_NUMBER}\\s?(?:yo|y\\s?o|yr\\s?old|yrs?\\s+old|years?\\s+old|year\\s?olds?)(?=\\s|$)`, 'g'),
  new RegExp(`(?:^|\\s)aged?\\s+${AGE_NUMBER}(?=\\s|$)`, 'g'),
  new RegExp(`(?:^|\\s)(?:son|daughter|kid|child|boy|girl|niece|nephew)\\s+(?:is|who\\s+is|turning|turned)\\s+${AGE_NUMBER}(?=\\s|$)`, 'g'),
];
// "8yrs", "8yr" written as one word (spaced, "8 years" is as often a duration)
AGE_PATTERNS.push(new RegExp(`(?:^|\\s)(\\d{1,2})yrs?(?=\\s|$)`, 'g'));
const INFANT_AGE_PATTERN = /(?:^|\s)\d{1,2}\s?(?:months?|mos?|weeks?|wks?)\s+old(?=\s|$)/;
const SCRIPT_AGE_PATTERN = /(\d{1,3})\s?(?:岁|歲|歳|살|세)/g;

function ageNumber(value) {
  const n = Object.prototype.hasOwnProperty.call(WORD_NUMBERS, value) ? WORD_NUMBERS[value] : Number(value);
  return Number.isFinite(n) ? n : null;
}

function agesIn(latin, script) {
  const ages = [];
  for (const re of AGE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(latin))) {
      const n = ageNumber(m[1]);
      if (n != null) ages.push(n);
    }
  }
  SCRIPT_AGE_PATTERN.lastIndex = 0;
  let m;
  while ((m = SCRIPT_AGE_PATTERN.exec(script))) ages.push(Number(m[1]));
  if (INFANT_AGE_PATTERN.test(latin)) ages.push(0);
  return ages;
}

const RE = {
  pregnancyLatin: wordRegex(HARD_PREGNANCY_LACTATION_FERTILITY_LATIN),
  childLatin: wordRegex(HARD_CHILD_UNDER_12_LATIN),
  isotretinoinLatin: wordRegex(HARD_ISOTRETINOIN_LAYERING_LATIN),
  negationBeforeLatin: new RegExp(`(?:^|\\s)(?:${HARD_NEGATION_BEFORE_NAME_LATIN.join('|')})${NEGATION_FILLER}\\s+${RETINOID_NAME_FOR_NEGATION}(?=\\s|$)`),
  negationAfterLatin: new RegExp(
    `(?:^|\\s)${RETINOID_NAME_FOR_NEGATION}${RETINOID_PRODUCT_WORD}\\s+(?:${HARD_NEGATION_AFTER_NAME_LATIN.join('|')})(?=\\s|$)`,
  ),
  // A negation that ends the text, after the name, has the name as its object: "retinol serum, don't
  // want", "retinol, never". Followed by anything else it is not ("retinol stopped working").
  negationTailLatin: new RegExp(
    `(?:^|\\s)${RETINOID_NAME_FOR_NEGATION}${RETINOID_PRODUCT_WORD}\\s+(?:i\\s+)?(?:${HARD_NEGATION_BEFORE_NAME_LATIN.join('|')})\\s*$`,
  ),
  teenLatin: wordRegex(SOFT_TEEN_LATIN),
  skinConditionLatin: wordRegex(SOFT_SKIN_CONDITION_LATIN),
  sensitivityLatin: wordRegex(SOFT_SENSITIVITY_LATIN),
};

const scriptHas = (script, list) => list.find((term) => script.includes(term)) || null;

// The classes a piece of text carries. Every class is reported, whatever the soft-tier flag says;
// tiering is applied by the callers below.
function classifyText(text) {
  const script = scriptView(text);
  const classes = new Set();
  if (!script.trim()) return classes;
  const latin = latinView(script);
  const padded = ` ${latin} `;
  const compact = compactView(latin);
  const tokens = latinTokens(deLeet(latin));
  const joined = ` ${tokens.join(' ')} `;

  if (
    RE.pregnancyLatin.test(joined) ||
    // digits as written ("3rd tri"); the joined view is de-leeted
    RE.pregnancyLatin.test(padded) ||
    scriptHas(script, HARD_PREGNANCY_LACTATION_FERTILITY_SCRIPT) ||
    HARD_PREGNANCY_LACTATION_FERTILITY_SCRIPT_RES.some((re) => re.test(script)) ||
    HARD_PREGNANCY_LACTATION_FERTILITY_COMPACT.some((stem) => compact.includes(stem)) ||
    fuzzyHit(tokens, HARD_PREGNANCY_LACTATION_FERTILITY_FUZZY)
  ) {
    classes.add('pregnancy_lactation_fertility');
  }
  if (
    RE.isotretinoinLatin.test(padded) ||
    HARD_ISOTRETINOIN_LAYERING_COMPACT.some((stem) => compact.includes(stem)) ||
    fuzzyHit(tokens, HARD_ISOTRETINOIN_LAYERING_FUZZY)
  ) {
    classes.add('isotretinoin_layering');
  }
  const ages = agesIn(padded, script);
  if (
    RE.childLatin.test(padded) ||
    // de-leeted, single letters joined: k1ds, ch1ld, "c h i l d"
    RE.childLatin.test(joined) ||
    scriptHas(script, HARD_CHILD_UNDER_12_SCRIPT) ||
    HARD_CHILD_UNDER_12_SCRIPT_RES.some((re) => re.test(script)) ||
    ages.some((n) => n <= 11)
  ) {
    classes.add('child_under_12');
  }
  if (
    RE.negationBeforeLatin.test(joined) ||
    RE.negationAfterLatin.test(joined) ||
    RE.negationTailLatin.test(joined) ||
    SCRIPT_NEGATION_RES.some((re) => re.test(script))
  ) {
    classes.add('retinoid_negation');
  }
  if (RE.teenLatin.test(padded) || scriptHas(script, SOFT_TEEN_SCRIPT) || ages.some((n) => n >= 12 && n <= 17)) {
    classes.add('teen_12_17');
  }
  if (RE.skinConditionLatin.test(padded) || scriptHas(script, SOFT_SKIN_CONDITION_SCRIPT)) classes.add('skin_condition');
  if (RE.sensitivityLatin.test(padded) || scriptHas(script, SOFT_SENSITIVITY_SCRIPT)) classes.add('sensitivity');
  return classes;
}

const HARD_CLASSES = new Set(['pregnancy_lactation_fertility', 'child_under_12', 'isotretinoin_layering', 'retinoid_negation']);
const SOFT_CLASSES = new Set(['teen_12_17', 'skin_condition', 'sensitivity']);

// BUDGETS. Request bodies can be large (the JSON limit is 10 MB), so the reader is bounded in what
// it scans and what it keeps. Going over a limit never drops a signal silently: the request is
// treated as carrying one ('context_over_limit', HARD), so retinoids are kept out.
const MAX_SCAN_STRING_CHARS = 4000; // one message, profile value or query text
const MAX_SCAN_TOTAL_CHARS = 40000; // everything one request's context reader reads
const MAX_SCAN_STRINGS = 200; // strings one request's context reader reads
const MAX_SCAN_ARRAY_ITEMS = 100; // turns in one message list, entries in one list or object
const MAX_SCAN_NODES = 2000; // values (lists, objects, strings) one request's context reader visits
const CLASSIFY_CACHE_MAX = 2000;
const CLASSIFY_CACHE_MAX_KEY_CHARS = 256; // longer texts are classified, never cached
const OVER_LIMIT_CLASS = 'context_over_limit';
const EMPTY_CLASSES = new Set();

const CLASSIFY_CACHE = new Map();
function classifyTextCached(text) {
  const key = String(text == null ? '' : text);
  if (key.length > CLASSIFY_CACHE_MAX_KEY_CHARS) return classifyText(key);
  const hit = CLASSIFY_CACHE.get(key);
  if (hit) return hit;
  const classes = classifyText(key);
  if (CLASSIFY_CACHE.size >= CLASSIFY_CACHE_MAX) CLASSIFY_CACHE.delete(CLASSIFY_CACHE.keys().next().value);
  CLASSIFY_CACHE.set(key, classes);
  return classes;
}

// More keys than the reader will look at? Counted with an early exit, so a huge object costs at most
// MAX_SCAN_ARRAY_ITEMS steps here.
function tooManyKeys(obj) {
  let n = 0;
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    n += 1;
    if (n > MAX_SCAN_ARRAY_ITEMS) return true;
  }
  return false;
}

// The scan budget of the request context being read. The reader is synchronous, so one at a time;
// every function below runs only inside retinoidSafetyClassesForRequestContext, which sets it.
let SCAN = null;
function overLimit() {
  SCAN.overflow = true;
  return EMPTY_CLASSES;
}
// Counts one visited value. False once the request is over its node budget (or any other limit):
// the caller stops walking. A deep or wide body therefore costs at most MAX_SCAN_NODES steps.
function visit() {
  SCAN.nodes += 1;
  if (SCAN.nodes > MAX_SCAN_NODES) {
    overLimit();
    return false;
  }
  return true;
}
// The values of a list or object (or an object's [key, value] entries), or null when it holds more
// than MAX_SCAN_ARRAY_ITEMS: the request is then over its limit. Keys are counted with an early exit,
// so a huge object is never copied.
function childrenOf(value, entries = false) {
  if (Array.isArray(value)) return value.length > MAX_SCAN_ARRAY_ITEMS ? null : value;
  if (tooManyKeys(value)) return null;
  return entries ? Object.entries(value) : Object.values(value);
}

function scanClasses(text) {
  const s = String(text == null ? '' : text);
  if (SCAN.overflow) return EMPTY_CLASSES;
  SCAN.strings += 1;
  SCAN.chars += s.length;
  if (s.length > MAX_SCAN_STRING_CHARS || SCAN.strings > MAX_SCAN_STRINGS || SCAN.chars > MAX_SCAN_TOTAL_CHARS) return overLimit();
  return classifyTextCached(s);
}

function tierFilter(classes, { softTier = softTierEnabled() } = {}) {
  return Array.from(classes)
    .filter((c) => HARD_CLASSES.has(c) || (softTier && SOFT_CLASSES.has(c)))
    .sort();
}

// The gating classes of one text (a query or one message). [] means no reason to gate. A text longer
// than the scan limit is not read: it gates ('context_over_limit').
function retinoidSafetyClassesForText(text, options = {}) {
  const s = String(text == null ? '' : text);
  if (s.length > MAX_SCAN_STRING_CHARS) return [OVER_LIMIT_CLASS];
  return tierFilter(classifyTextCached(s), options);
}

// ---------------------------------------------------------------------------------------------
// Request context: earlier turns, profiles, constraints and safety flags.

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

const NEUTRAL_VALUE_RE =
  /^(?:|no|n|none|false|0|null|undefined|unknown|n\/a|na|not[\s_-]?applicable|prefer[\s_-]?not[\s_-]?to[\s_-]?say|not[\s_-].*|non[\s_-].*|never)$/;

function valueIsAffirmative(value) {
  // Over the node budget: treated as affirmative (fail closed; the request gates as over the limit).
  if (!visit()) return true;
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (Array.isArray(value) || isObj(value)) {
    // Too big to read is treated as affirmative: fail closed.
    const children = childrenOf(value);
    if (!children) {
      overLimit();
      return true;
    }
    return children.some(valueIsAffirmative);
  }
  return !NEUTRAL_VALUE_RE.test(String(value).trim().toLowerCase());
}

const PROFILE_STATUS_KEY_RE = /pregnan|breast|lactat|nursing|ttc|fertility|conceiv|postpartum|trimester|expecting|maternity/i;
const PROFILE_AGE_KEY_RE = /^(?:age|age_years|ageyears|user_age|years_old|age_range|age_group|age_bracket|agerange|agegroup)$/i;
const AVOID_KEY_RE = /avoid|allerg|exclu|contraindicat|sensitiv\w*_ingredients|intoleran|blacklist|block/i;

function collectStrings(value, out) {
  if (!visit()) return;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value) || isObj(value)) {
    const children = childrenOf(value);
    if (!children) overLimit();
    else children.forEach((v) => collectStrings(v, out));
  }
}

function ageClass(value) {
  const nums = String(value).match(/\d{1,3}/g);
  if (!nums) return null;
  const upper = Math.max(...nums.map(Number));
  if (upper <= 11) return 'child_under_12';
  if (upper <= 17) return 'teen_12_17';
  return null;
}

// A profile gates on what it SAYS, never on existing: neutral fields (skin_type=oily, age=30,
// pregnancy_status=not_pregnant) add nothing.
function classesForProfile(profile, sink) {
  if (!isObj(profile) || !visit()) return;
  const entries = childrenOf(profile, true);
  if (!entries) {
    overLimit();
    return;
  }
  for (const [key, value] of entries) {
    if (PROFILE_STATUS_KEY_RE.test(key)) {
      if (valueIsAffirmative(value)) sink.add('pregnancy_lactation_fertility');
      continue;
    }
    if (PROFILE_AGE_KEY_RE.test(key)) {
      const c = ageClass(value);
      if (c) sink.add(c);
      continue;
    }
    if (AVOID_KEY_RE.test(key)) {
      classesForAvoidList(value, sink);
      continue;
    }
    if (isObj(value)) {
      classesForProfile(value, sink);
      continue;
    }
    const strings = [];
    collectStrings(value, strings);
    for (const s of strings) scanClasses(s).forEach((c) => sink.add(c));
  }
}

function classesForAvoidList(value, sink) {
  const strings = [];
  collectStrings(value, strings);
  for (const s of strings) {
    // Budgeted first: a string over the limit is never viewed.
    const classes = scanClasses(s);
    if (SCAN.overflow) return;
    classes.forEach((c) => sink.add(c));
    const script = scriptView(s);
    if (RETINOID_NAME_LATIN.test(` ${latinView(script)} `) || RETINOID_NAME_SCRIPT.test(script)) {
      sink.add('retinoid_negation');
    }
  }
}

function classesForConstraints(constraints, sink) {
  if (constraints == null || !visit()) return;
  if (isObj(constraints)) {
    const entries = childrenOf(constraints, true);
    if (!entries) {
      overLimit();
      return;
    }
    for (const [key, value] of entries) {
      if (AVOID_KEY_RE.test(key)) classesForAvoidList(value, sink);
      else if (PROFILE_STATUS_KEY_RE.test(key)) {
        if (valueIsAffirmative(value)) sink.add('pregnancy_lactation_fertility');
      } else classesForConstraints(value, sink);
    }
    return;
  }
  const strings = [];
  collectStrings(constraints, strings);
  for (const s of strings) {
    scanClasses(s).forEach((c) => sink.add(c));
  }
}

// Any safety flag that is set is a safety signal. A flag object's false values are not set.
function classesForSafetyFlags(flags, sink) {
  if (flags == null || flags === false) return;
  const named = [];
  if ((Array.isArray(flags) && flags.length > MAX_SCAN_ARRAY_ITEMS) || (isObj(flags) && tooManyKeys(flags))) {
    overLimit();
    return;
  }
  if (typeof flags === 'string') named.push(flags);
  else if (Array.isArray(flags)) flags.forEach((f) => (typeof f === 'string' ? named.push(f) : isObj(f) && classesForSafetyFlags(f, sink)));
  else if (isObj(flags)) {
    for (const [key, value] of Object.entries(flags)) if (valueIsAffirmative(value)) named.push(key);
  } else if (flags === true) named.push('safety_flag');
  for (const name of named) {
    if (NEUTRAL_VALUE_RE.test(String(name).trim().toLowerCase())) continue;
    const classes = scanClasses(String(name).replace(/[_-]+/g, ' '));
    if (classes.size > 0) classes.forEach((c) => sink.add(c));
    else if (!SCAN.overflow) sink.add('safety_flag');
  }
}

function messageText(message) {
  if (typeof message === 'string') return message;
  if (!isObj(message)) return '';
  const role = String(message.role || '').toLowerCase();
  if (role === 'system') return '';
  const content = message.content != null ? message.content : message.text;
  if (typeof content === 'string') return content;
  const parts = [];
  collectStrings(content, parts);
  return parts.join(' ');
}

const MESSAGE_KEYS = ['messages', 'conversation', 'history', 'chat_history', 'conversation_messages', 'session_recent_queries', 'recent_queries'];
const GOAL_KEYS = ['raw_user_goal', 'user_goal'];
const PROFILE_KEYS = ['user_profile', 'userProfile', 'profile', 'skin_profile', 'skinProfile'];
const CONSTRAINT_KEYS = ['constraints', 'avoid_ingredients', 'avoidIngredients'];
const FLAG_KEYS = ['safety_flags', 'safetyFlags'];

function requestContainers(body) {
  const b = isObj(body) ? body : {};
  const payload = isObj(b.payload) ? b.payload : {};
  const out = [b, payload, b.metadata, b.context, b.user, payload.search, payload.context, payload.metadata, payload.user];
  for (const c of [b.context, payload.context]) {
    if (isObj(c) && isObj(c.normalized_need)) {
      out.push(c.normalized_need);
      if (isObj(c.normalized_need.beauty_request)) out.push(c.normalized_need.beauty_request);
    }
  }
  return out.filter(isObj);
}

// The gating classes carried by the request OUTSIDE its query text: earlier turns, profiles,
// constraints and safety flags. Returns { classes, sources }.
function retinoidSafetyClassesForRequestContext(body, options = {}) {
  SCAN = { strings: 0, chars: 0, nodes: 0, overflow: false };
  return readRequestContext(body, options);
}

function readRequestContext(body, options) {
  const softTier = options.softTier ?? softTierEnabled();
  const keep = (c) => c === 'safety_flag' || HARD_CLASSES.has(c) || (softTier && SOFT_CLASSES.has(c));
  const all = new Set();
  const sources = new Set();
  const record = (source, collect) => {
    const local = new Set();
    collect(local);
    const kept = Array.from(local).filter(keep);
    if (kept.length === 0) return;
    sources.add(source);
    kept.forEach((c) => all.add(c));
  };
  for (const container of requestContainers(body)) {
    for (const key of MESSAGE_KEYS) {
      const value = container[key];
      if (!Array.isArray(value)) continue;
      record('messages', (sink) => {
        if (value.length > MAX_SCAN_ARRAY_ITEMS) {
          overLimit();
          return;
        }
        value.forEach((m) => scanClasses(messageText(m)).forEach((c) => sink.add(c)));
      });
    }
    for (const key of GOAL_KEYS) {
      if (typeof container[key] !== 'string') continue;
      record('goal', (sink) => scanClasses(container[key]).forEach((c) => sink.add(c)));
    }
    for (const key of PROFILE_KEYS) record('profile', (sink) => classesForProfile(container[key], sink));
    for (const key of CONSTRAINT_KEYS) {
      if (container[key] == null) continue;
      record('constraints', (sink) =>
        key === 'constraints' ? classesForConstraints(container[key], sink) : classesForAvoidList(container[key], sink),
      );
    }
    for (const key of FLAG_KEYS) record('safety_flags', (sink) => classesForSafetyFlags(container[key], sink));
  }
  if (SCAN.overflow) {
    all.add(OVER_LIMIT_CLASS);
    sources.add('over_limit');
  }
  return { classes: Array.from(all).sort(), sources: Array.from(sources).sort() };
}

module.exports = {
  SOFT_TIER_ENV,
  OVER_LIMIT_CLASS,
  MAX_SCAN_STRING_CHARS,
  MAX_SCAN_TOTAL_CHARS,
  MAX_SCAN_STRINGS,
  MAX_SCAN_ARRAY_ITEMS,
  MAX_SCAN_NODES,
  softTierEnabled,
  HARD_PREGNANCY_LACTATION_FERTILITY_LATIN,
  HARD_PREGNANCY_LACTATION_FERTILITY_SCRIPT,
  HARD_PREGNANCY_LACTATION_FERTILITY_COMPACT,
  HARD_PREGNANCY_LACTATION_FERTILITY_FUZZY,
  HARD_CHILD_UNDER_12_LATIN,
  HARD_CHILD_UNDER_12_SCRIPT,
  HARD_ISOTRETINOIN_LAYERING_LATIN,
  HARD_NEGATION_BEFORE_NAME_LATIN,
  HARD_NEGATION_AFTER_NAME_LATIN,
  HARD_NEGATION_BEFORE_NAME_SCRIPT,
  HARD_NEGATION_AFTER_NAME_SCRIPT,
  SOFT_TEEN_LATIN,
  SOFT_TEEN_SCRIPT,
  SOFT_SKIN_CONDITION_LATIN,
  SOFT_SKIN_CONDITION_SCRIPT,
  SOFT_SENSITIVITY_LATIN,
  SOFT_SENSITIVITY_SCRIPT,
  HARD_CLASSES,
  SOFT_CLASSES,
  classifyText,
  retinoidSafetyClassesForText,
  retinoidSafetyClassesForRequestContext,
  _internal: { scriptView, latinView, compactView, latinTokens, withinOneEdit, agesIn, classifyCacheSize: () => CLASSIFY_CACHE.size, classifyCacheKeys: () => Array.from(CLASSIFY_CACHE.keys()) },
};
