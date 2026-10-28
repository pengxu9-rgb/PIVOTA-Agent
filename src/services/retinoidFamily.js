'use strict';

// The retinoid family: every name, in every script we read, under which a product or a query can mean
// "a retinoid". ONE list, shared by:
//   - the retinoid safety rules: the request signal (src/services/retinoidSafetySignal.js, its
//     negation and avoid-list names) and the product check (beautyProductIsRetinoidForSafety in
//     src/server.js), which reads these on top of its own patterns;
//   - the search routing door (src/findProductsMulti/strictIngredientQuery.js): a query that excludes
//     retinol, or asks for a stand-in for it, excludes every row naming any of these.
//
// Pure data, no dependencies. Latin names are written as normalised text reads them (lowercase,
// diacritics stripped, punctuation as a space: "Retin-A" is "retin a", "rétinoïde" is "retinoide") and
// are matched as whole words. Script names (Han, kana, Hangul, Thai) are matched as substrings, with the
// caller's own compound and negation rules. Russian forms are regex sources with bounded inflection
// endings, written for normalised text (the breve is stripped, so "й" is "и").
//
// Brand names are kept apart from the family. A prescription-only brand (Tazorac, Epiduo, Accutane ...)
// names a retinoid product, except in an accessory phrase ("Lip Repair Balm for Accutane Users",
// "Accutane-safe"). Differin is also sold as a benzoyl peroxide cleanser and an SPF moisturizer, so the
// product reader decides it by what the product is (src/server.js). A REQUEST naming any brand
// ("differin free", an avoid list with Accutane) means the retinoid. The routing door reads the family
// alone.
//
// Stand-ins are not in the family: "Bio-Retinol", "Phyto-Retinol", "plant retinol" are bakuchiol-type
// actives. A reader that sees one strips the stand-in phrase first, and the product is a retinoid only
// when a family name is left outside it.

// Retinol itself is not in these lists: it is a strict-table ingredient with its own name rules.
const RETINOID_FAMILY_LATIN = Object.freeze([
  // aldehyde and acids
  'retinal', 'retinaldehyde', 'retinoic acid', 'tretinoin', 'isotretinoin',
  // esters
  'retinyl palmitate', 'retinyl acetate', 'retinyl propionate', 'retinyl linoleate', 'retinyl retinoate',
  'retinyl ester', 'retinyl esters', 'retinol palmitate', 'retinol acetate',
  'vitamin a palmitate', 'vitamin a acetate',
  // vitamin A as an ingredient name
  'vitamin a', 'vitamins a', 'vit a', 'vitamine a', 'vitamina a',
  // HPR
  'hydroxypinacolone retinoate', 'hpr', 'granactive retinoid',
  // prescription retinoids by their active (and Retin-A, which every product so named is: tretinoin)
  'adapalene', 'tazarotene', 'trifarotene', 'retin a',
  // the family word, English / French / German / Spanish (rétinoïde, Retinoide, retinoide, retinoides)
  'retinoid', 'retinoids', 'retinoide', 'retinoides',
]);

const RETINOID_FAMILY_SCRIPT = Object.freeze([
  // Chinese (simplified / traditional). "A醛" / "维A醛" are retinal.
  '视黄醛', '視黃醛', 'a醛', '维a醛', '維a醛', '视黄醇棕榈酸酯', '視黃醇棕櫚酸酯', '视黄醇醋酸酯', '視黃醇醋酸酯',
  '视黄醇丙酸酯', '羟基频哪酮视黄酸酯', '羥基頻哪酮視黃酸酯', '视黄酸', '視黃酸', '维a酸', '維a酸', '维甲酸', '維甲酸',
  '阿达帕林', '阿達帕林', '他扎罗汀', '曲法罗汀', '类视黄醇', '類視黃醇',
  // Japanese
  'レチナール', 'パルミチン酸レチノール', '酢酸レチノール', 'レチノイン酸', 'トレチノイン', 'アダパレン',
  'ヒドロキシピナコロンレチノアート', 'レチノイド', 'トリファロテン',
  // Korean
  '레티날', '레티날데하이드', '레티닐팔미테이트', '레티닐 팔미테이트', '레티놀팔미테이트', '레티놀 팔미테이트',
  '하이드록시피나코론레티노에이트', '아다팔렌', '트레티노인', '레티노이드', '트리파로텐',
  // Thai
  'เรตินอล',
]);

// Prescription-only brand names, and the over-the-counter one.
const RETINOID_PRESCRIPTION_BRANDS = Object.freeze([
  'tazorac', 'aklief', 'epiduo', 'altreno', 'atralin', 'accutane', 'roaccutane', 'absorica', 'claravis', 'amnesteem',
  'zenatane', 'myorisan',
]);
const RETINOID_OTC_BRANDS = Object.freeze(['differin']);

const RU_NOUN = '(?:|а|у|ом|е|ы|ов|ам|ами|ах)';
const RETINOID_FAMILY_RUSSIAN = Object.freeze([
  'ретинал(?:|ь|я|ю|ем|е)', `ретинальдегид${RU_NOUN}`, `ретинилпальмитат${RU_NOUN}`, `ретинил\\s+пальмитат${RU_NOUN}`,
  `адапален${RU_NOUN}`, `третиноин${RU_NOUN}`, `ретиноид${RU_NOUN}`, `трифаротен${RU_NOUN}`,
]);

// The safety rules read a request more widely than the door: any word starting with a retinoid stem
// ("retinols", "retinyl", "retinoate"), "granactive" on its own, and the short script stems ("维a",
// "레틴"). Regex sources for the latin view, matched as whole words; script stems as substrings. Only
// the request side reads these: a product is named by the family above plus its own patterns.
const RETINOID_SAFETY_LATIN_STEMS = Object.freeze([
  'retinol\\w*', 'retinal\\w*', 'retinoid\\w*', 'retinyl\\w*', 'retinoic', 'retinoate', 'tretinoin', 'isotretinoin',
  'adapalene', 'tazarotene', 'trifarotene', 'retin\\s?a', 'vit(?:amin)?\\s+a', 'granactive', 'hydroxypinacolone', 'hpr',
]);
const RETINOID_SAFETY_SCRIPT_STEMS = Object.freeze([
  '视黄醇', '視黃醇', '维a', '維a', 'a醇', '维a醇', '維a醇', '维甲酸', '維甲酸', 'レチノール', '레티놀', '레틴', 'ретинол',
  'ретиноид', 'เรตินอล',
]);

module.exports = {
  RETINOID_FAMILY_LATIN,
  RETINOID_FAMILY_SCRIPT,
  RETINOID_FAMILY_RUSSIAN,
  RETINOID_PRESCRIPTION_BRANDS,
  RETINOID_OTC_BRANDS,
  RETINOID_SAFETY_LATIN_STEMS,
  RETINOID_SAFETY_SCRIPT_STEMS,
};
