#!/usr/bin/env node
'use strict';

// Builds fixtures/queries.v1.json — the versioned partner query set — from the tables below.
//
// The set models what the users of a makeup/beauty try-on app type: makeup by shade and undertone, skincare
// by concern and by ingredient (including bare ingredient names), brand queries, price caps, seven
// languages, markets US / SG / none, and negative controls. Every entry carries EXPECTED PROPERTIES
// (category terms, ingredient terms, exclusions, brand, price cap, currency), never expected products: the
// eval must stay valid as the catalog changes.
//
// Term groups list synonyms across languages, because a zh/ja/ko/fr/es query is answered from a catalog whose
// product text is mostly English. A group passes when ANY of its terms matches.
//
// Run:  node scripts/agent-readiness-eval/fixtures/build_query_set.cjs          (writes the JSON)
//       node scripts/agent-readiness-eval/fixtures/build_query_set.cjs --check  (exit 1 if the JSON is stale)
//
// No business data lives here: brands are globally known consumer beauty brands used as generic brand-query
// probes; there are no partner, merchant or store names. A private overlay (--query-overlay on the runner)
// adds deployment-specific queries without committing them.

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 'v1';
const OUT = path.join(__dirname, `queries.${VERSION}.json`);

// ---- term groups ------------------------------------------------------------------------------------------

const C = {
  lip: ['lipstick', 'lip', 'lips', 'rouge', 'liner', '口红', '唇膏', '口紅', 'リップ', '口紅', '립스틱', '립', 'labial', 'pintalabios', 'rouge a levres'],
  gloss: ['gloss', 'lip oil', 'tint', 'stain', 'balm', 'lip', '唇釉', 'グロス', '틴트', 'brillo'],
  foundation: ['foundation', 'skin tint', 'tinted moisturizer', 'bb cream', 'cc cream', 'cushion', 'fond de teint', 'base de maquillaje', '粉底', 'ファンデーション', '파운데이션', '쿠션'],
  blush: ['blush', 'blusher', 'cheek', '腮红', '腮紅', 'チーク', '블러셔', 'colorete', 'rubor', 'fard a joues'],
  eyeliner: ['eyeliner', 'eye liner', 'liner', 'kohl', 'khol', '眼线', '眼線', 'アイライナー', '아이라이너', 'delineador', 'crayon'],
  concealer: ['concealer', 'corrector', 'correcting', '遮瑕', 'コンシーラー', '컨실러', 'anticernes'],
  eyeshadow: ['eyeshadow', 'eye shadow', 'shadow', 'palette', '眼影', 'アイシャドウ', '아이섀도', 'sombra', 'fard a paupieres'],
  mascara: ['mascara', '睫毛膏', 'マスカラ', '마스카라', 'rimel'],
  bronzer: ['bronzer', 'contour', 'bronzing', '修容', 'ブロンザー', '브론저', 'poudre bronzante'],
  brow: ['brow', 'eyebrow', '眉', 'アイブロウ', '브로우', 'cejas', 'sourcils'],
  primer: ['primer', 'base', 'prep'],
  moisturizer: ['moisturizer', 'moisturiser', 'cream', 'lotion', 'gel cream', 'emulsion', 'balm', '面霜', '乳液', '乳霜', '保湿', '保濕', 'クリーム', '크림', '수분', 'hydratant', 'creme', 'crema', 'hidratante'],
  serum: ['serum', 'essence', 'ampoule', 'concentrate', 'treatment', '精华', '精華', '美容液', '세럼', '에센스', '앰플'],
  cleanser: ['cleanser', 'face wash', 'cleansing', 'wash', 'foam', '洁面', '洗面奶', '洗面乳', '洗顔', '클렌저', '클렌징', 'nettoyant', 'limpiador'],
  sunscreen: ['sunscreen', 'spf', 'sun', 'uv', '防晒', '防曬', '日焼け止め', 'uv', '선크림', '선', 'solaire', 'protector solar'],
  toner: ['toner', 'toning', 'lotion', 'essence', 'mist', '爽肤水', '化妝水', '化粧水', '토너', 'tonique', 'tonico'],
  eye_cream: ['eye cream', 'eye', '眼霜', 'アイクリーム', '아이크림', 'contour des yeux', 'contorno de ojos'],
  mask: ['mask', 'masque', 'mascarilla', '面膜', 'マスク', 'パック', '마스크'],
  spot: ['spot', 'patch', 'treatment', 'acne'],
  exfoliant: ['exfoliant', 'exfoliator', 'exfoliating', 'peel', 'bha', 'aha', 'liquid'],
  oil: ['oil', 'huile', 'aceite', 'オイル', '오일'],
  body: ['body', 'lotion', 'cream', 'butter'],
};

const I = {
  niacinamide: ['niacinamide', 'nicotinamide', '烟酰胺', '煙醯胺', 'ナイアシンアミド', '나이아신아마이드', 'niacinamida'],
  retinol: ['retinol', 'retinal', 'retinoid', 'retinyl', '视黄醇', 'a醇', '視黃醇', 'レチノール', '레티놀', 'retinol'],
  hyaluronic: ['hyaluronic', 'hyaluronate', '玻尿酸', '透明质酸', 'ヒアルロン酸', '히알루론산', 'acide hyaluronique', 'acido hialuronico'],
  vitamin_c: ['vitamin c', 'ascorbic', 'ascorbyl', 'ascorbate', '维生素c', '維他命c', 'ビタミンc', '비타민c', 'vitamine c', 'vitamina c'],
  salicylic: ['salicylic', 'bha', '水杨酸', 'サリチル酸', '살리실산'],
  glycolic: ['glycolic', 'aha', '乙醇酸', 'グリコール酸', '글리콜산'],
  ceramide: ['ceramide', '神经酰胺', 'セラミド', '세라마이드', 'ceramida'],
  peptide: ['peptide', '肽', 'ペプチド', '펩타이드', 'peptido'],
  azelaic: ['azelaic', '壬二酸', 'アゼライン酸', '아젤라산'],
  centella: ['centella', 'cica', 'madecassoside', 'asiatica', '积雪草', 'ツボクサ', '시카', '병풀'],
  snail: ['snail', '蜗牛', 'カタツムリ', '달팽이'],
  squalane: ['squalane', '角鲨烷', 'スクワラン', '스쿠알란'],
  bakuchiol: ['bakuchiol'],
  zinc: ['zinc oxide', 'zinc'],
  tranexamic: ['tranexamic', '传明酸', 'トラネキサム酸', '트라넥삼산'],
  panthenol: ['panthenol', 'vitamin b5', '泛醇', 'パンテノール', '판테놀'],
  benzoyl: ['benzoyl peroxide'],
  rice: ['rice', 'oryza', '米', '쌀'],
  green_tea: ['green tea', 'camellia sinensis', '绿茶', '緑茶', '녹차'],
  mugwort: ['mugwort', 'artemisia', '艾草', '쑥'],
};

const X = {
  fragrance: ['fragrance', 'parfum', 'perfume', 'scent', 'scented', '香精', '香料', '향료', 'fragancia', 'fragance'],
  alcohol: ['alcohol', 'ethanol', 'alcohol denat', '酒精', 'アルコール', '알코올'],
  paraben: ['paraben', 'methylparaben', 'propylparaben', 'butylparaben', 'パラベン', '파라벤'],
  sulfate: ['sulfate', 'sulphate', 'sls', 'sles'],
  oil: ['oil'],
  silicone: ['silicone', 'dimethicone', 'cyclopentasiloxane', 'cyclomethicone'],
};

// ---- query tables -----------------------------------------------------------------------------------------
// Rows: [text, categoryKey|null, { ingredients?: [I keys], exclude?: [X keys], shade?: bool, brand?: [...] }]

const MAKEUP_SHADE_EN = [
  ['red lipstick', 'lip'], ['nude lipstick for medium skin', 'lip'], ['matte red lipstick', 'lip'],
  ['berry lipstick', 'lip'], ['pink lipstick', 'lip'], ['mauve lipstick', 'lip'], ['brown nude lipstick', 'lip'],
  ['coral lipstick', 'lip'], ['plum lipstick', 'lip'], ['orange red lipstick', 'lip'],
  ['long lasting liquid lipstick nude', 'lip'], ['satin lipstick rosy pink', 'lip'],
  ['lipstick for fair skin cool undertone', 'lip'], ['nude lip liner', 'lip'], ['burgundy lipstick', 'lip'],
  ['foundation for warm undertone', 'foundation'], ['foundation cool undertone fair', 'foundation'],
  ['foundation neutral undertone medium', 'foundation'], ['foundation shade for olive skin', 'foundation'],
  ['foundation for deep skin tones', 'foundation'], ['full coverage foundation tan', 'foundation'],
  ['matte foundation for oily skin', 'foundation'], ['dewy foundation light shade', 'foundation'],
  ['skin tint light coverage', 'foundation'], ['foundation shade 120', 'foundation'],
  ['foundation for dark skin warm undertone', 'foundation'], ['cushion foundation light', 'foundation'],
  ['tinted moisturizer medium', 'foundation'], ['liquid foundation porcelain', 'foundation'],
  ['foundation with spf medium deep', 'foundation'],
  ['pink blush', 'blush'], ['peach blush', 'blush'], ['cream blush berry', 'blush'], ['liquid blush coral', 'blush'],
  ['powder blush rose', 'blush'], ['blush for dark skin', 'blush'], ['mauve blush', 'blush'], ['bronze blush', 'blush'],
  ['black eyeliner', 'eyeliner'], ['brown eyeliner', 'eyeliner'], ['waterproof black eyeliner', 'eyeliner'],
  ['gel eyeliner black', 'eyeliner'], ['liquid eyeliner pen', 'eyeliner'], ['white eyeliner', 'eyeliner'],
  ['navy eyeliner', 'eyeliner'], ['kohl eyeliner', 'eyeliner'],
  ['concealer for dark circles light', 'concealer'], ['concealer medium warm', 'concealer'], ['concealer deep', 'concealer'],
  ['peach color corrector', 'concealer'], ['full coverage concealer fair', 'concealer'], ['concealer cool undertone', 'concealer'],
  ['neutral eyeshadow palette', 'eyeshadow'], ['brown eyeshadow palette', 'eyeshadow'], ['gold shimmer eyeshadow', 'eyeshadow'],
  ['rose gold eyeshadow', 'eyeshadow'], ['smoky eyeshadow palette', 'eyeshadow'], ['champagne single eyeshadow', 'eyeshadow'],
  ['clear lip gloss', 'gloss'], ['pink lip gloss', 'gloss'], ['red lip tint', 'gloss'], ['cherry lip oil', 'gloss'],
  ['berry tinted lip balm', 'gloss'], ['coral lip stain', 'gloss'],
  ['bronzer for fair skin', 'bronzer'], ['cream bronzer', 'bronzer'], ['contour stick', 'bronzer'],
  ['dark brown brow pencil', 'brow'], ['clear brow gel', 'brow'], ['blonde brow pencil', 'brow'],
  ['black mascara', 'mascara'], ['brown mascara', 'mascara'], ['waterproof mascara', 'mascara'],
];

const SKINCARE_CONCERN_EN = [
  ['moisturizer for dry skin', 'moisturizer'], ['serum for acne', 'serum'], ['cleanser for oily skin', 'cleanser'],
  ['cream for redness', 'moisturizer'], ['serum for hyperpigmentation', 'serum'], ['dark spot serum', 'serum'],
  ['eye cream for dark circles', 'eye_cream'], ['anti aging night cream', 'moisturizer'],
  ['moisturizer for sensitive skin', 'moisturizer'], ['toner for large pores', 'toner'],
  ['sunscreen for oily skin', 'sunscreen'], ['mineral sunscreen for sensitive skin', 'sunscreen'],
  ['acne spot treatment', 'spot'], ['exfoliant for blackheads', 'exfoliant'], ['barrier repair cream', 'moisturizer'],
  ['hydrating toner for dehydrated skin', 'toner'], ['serum for fine lines', 'serum'],
  ['cleanser for sensitive skin', 'cleanser'], ['moisturizer for combination skin', 'moisturizer'],
  ['eye cream for puffiness', 'eye_cream'], ['sheet mask for dull skin', 'mask'], ['night cream for wrinkles', 'moisturizer'],
  ['rosacea friendly moisturizer', 'moisturizer'], ['gentle cleanser for eczema prone skin', 'cleanser'],
  ['body lotion for very dry skin', 'body'], ['face oil for dry skin', 'oil'],
  ['sunscreen for dark skin no white cast', 'sunscreen'], ['brightening serum', 'serum'], ['firming serum', 'serum'],
  ['lip balm for chapped lips', 'gloss'],
];

const SKINCARE_INGREDIENT_EN = [
  ['niacinamide serum', 'serum', ['niacinamide']], ['retinol serum', 'serum', ['retinol']],
  ['retinol night cream', 'moisturizer', ['retinol']], ['hyaluronic acid serum', 'serum', ['hyaluronic']],
  ['vitamin c serum', 'serum', ['vitamin_c']], ['salicylic acid cleanser', 'cleanser', ['salicylic']],
  ['glycolic acid toner', 'toner', ['glycolic']], ['ceramide moisturizer', 'moisturizer', ['ceramide']],
  ['peptide eye cream', 'eye_cream', ['peptide']], ['azelaic acid cream', 'moisturizer', ['azelaic']],
  ['centella cream', 'moisturizer', ['centella']], ['snail mucin essence', 'serum', ['snail']],
  ['squalane oil', 'oil', ['squalane']], ['bakuchiol serum', 'serum', ['bakuchiol']],
  ['zinc oxide sunscreen', 'sunscreen', ['zinc']], ['tranexamic acid serum', 'serum', ['tranexamic']],
  ['panthenol cream', 'moisturizer', ['panthenol']], ['benzoyl peroxide cleanser', 'cleanser', ['benzoyl']],
  ['rice toner', 'toner', ['rice']], ['green tea cleanser', 'cleanser', ['green_tea']],
  ['mugwort essence', 'serum', ['mugwort']], ['ceramide cleanser', 'cleanser', ['ceramide']],
  ['vitamin c eye cream', 'eye_cream', ['vitamin_c']], ['niacinamide toner', 'toner', ['niacinamide']],
  ['hyaluronic acid moisturizer', 'moisturizer', ['hyaluronic']],
];

const INGREDIENT_BARE_EN = [
  ['niacinamide', 'niacinamide'], ['retinol', 'retinol'], ['hyaluronic acid', 'hyaluronic'], ['vitamin c', 'vitamin_c'],
  ['salicylic acid', 'salicylic'], ['ceramides', 'ceramide'], ['peptides', 'peptide'], ['azelaic acid', 'azelaic'],
  ['centella asiatica', 'centella'], ['snail mucin', 'snail'], ['squalane', 'squalane'], ['bakuchiol', 'bakuchiol'],
  ['tranexamic acid', 'tranexamic'], ['glycolic acid', 'glycolic'], ['panthenol', 'panthenol'],
];

const NEGATION_EN = [
  ['fragrance-free moisturizer', 'moisturizer', ['fragrance']], ['fragrance free sunscreen', 'sunscreen', ['fragrance']],
  ['alcohol-free toner', 'toner', ['alcohol']], ['paraben-free foundation', 'foundation', ['paraben']],
  ['sulfate-free cleanser', 'cleanser', ['sulfate']], ['oil-free sunscreen', 'sunscreen', ['oil']],
  ['silicone-free primer', 'primer', ['silicone']], ['moisturizer without fragrance', 'moisturizer', ['fragrance']],
  ['unscented body lotion', 'body', ['fragrance']], ['fragrance free cleanser for sensitive skin', 'cleanser', ['fragrance']],
  ['alcohol free hydrating toner', 'toner', ['alcohol']], ['paraben free mascara', 'mascara', ['paraben']],
];

// Globally known consumer beauty brands, as generic brand-query probes (not partners, merchants or stores).
const BRANDS = [
  ['CeraVe', ['cerave']], ['The Ordinary', ['the ordinary']], ['La Roche-Posay', ['la roche posay', 'la roche-posay']],
  ['Maybelline', ['maybelline']], ["L'Oreal Paris", ["l'oreal", 'loreal', 'l oreal']], ['NARS', ['nars']],
  ['Fenty Beauty', ['fenty']], ['Clinique', ['clinique']], ['Laneige', ['laneige']], ['COSRX', ['cosrx']],
  ['Innisfree', ['innisfree']], ['Shiseido', ['shiseido']], ['Estee Lauder', ['estee lauder', 'estée lauder']],
  ['MAC Cosmetics', ['mac']], ['Neutrogena', ['neutrogena']], ['Olay', ['olay']], ["Kiehl's", ["kiehl's", 'kiehls', 'kiehl']],
  ['Rare Beauty', ['rare beauty']], ['Beauty of Joseon', ['beauty of joseon']], ["Paula's Choice", ["paula's choice", 'paulas choice', 'paula s choice']],
];

const BRAND_CATEGORY = [
  ['cerave moisturizer', ['cerave'], 'moisturizer'], ['the ordinary niacinamide', ['the ordinary'], null, ['niacinamide']],
  ['la roche posay sunscreen', ['la roche posay', 'la roche-posay'], 'sunscreen'], ['maybelline mascara', ['maybelline'], 'mascara'],
  ['nars blush', ['nars'], 'blush'], ['fenty beauty foundation', ['fenty'], 'foundation'],
  ['clinique moisturizer', ['clinique'], 'moisturizer'], ['laneige lip mask', ['laneige'], 'gloss'],
  ['cosrx snail essence', ['cosrx'], 'serum', ['snail']], ['innisfree green tea serum', ['innisfree'], 'serum', ['green_tea']],
];

// [text, categoryKey, priceMax, currency, market, structured?]
const PRICE_CAPPED = [
  ['lipstick', 'lip', 15, 'USD', 'US', true], ['serum', 'serum', 30, 'USD', 'US', true],
  ['foundation', 'foundation', 25, 'USD', 'US', true], ['moisturizer', 'moisturizer', 20, 'USD', 'US', true],
  ['sunscreen', 'sunscreen', 15, 'USD', 'US', true], ['mascara', 'mascara', 12, 'USD', 'US', true],
  ['eyeshadow palette', 'eyeshadow', 30, 'USD', 'US', true], ['cleanser', 'cleanser', 12, 'USD', 'US', true],
  ['lipstick under $20', 'lip', 20, 'USD', 'US', false], ['foundation under 30 dollars', 'foundation', 30, 'USD', 'US', false],
  ['vitamin c serum under $25', 'serum', 25, 'USD', 'US', false], ['cheap moisturizer under $15', 'moisturizer', 15, 'USD', 'US', false],
  ['blush under $10', 'blush', 10, 'USD', 'US', false], ['eyeliner under $10', 'eyeliner', 10, 'USD', 'US', false],
  ['sunscreen under S$25', 'sunscreen', 25, 'SGD', 'SG', false], ['lipstick under 20 SGD', 'lip', 20, 'SGD', 'SG', false],
  ['serum below S$40', 'serum', 40, 'SGD', 'SG', false], ['moisturizer', 'moisturizer', 30, 'SGD', 'SG', true],
  ['cleanser', 'cleanser', 20, 'SGD', 'SG', true], ['foundation', 'foundation', 45, 'SGD', 'SG', true],
];

// [lang, text, class, categoryKey|null, { ingredients?, exclude?, shade? }]
const MULTILINGUAL = [
  ['zh-Hans', '正红色口红', 'makeup_shade', 'lip', { shade: true }],
  ['zh-Hans', '适合黄皮的暖调粉底液', 'makeup_shade', 'foundation', { shade: true }],
  ['zh-Hans', '珊瑚色腮红', 'makeup_shade', 'blush', { shade: true }],
  ['zh-Hans', '防水黑色眼线笔', 'makeup_shade', 'eyeliner', { shade: true }],
  ['zh-Hans', '烟酰胺精华', 'skincare_ingredient', 'serum', { ingredients: ['niacinamide'] }],
  ['zh-Hans', '敏感肌面霜', 'skincare_concern', 'moisturizer'],
  ['zh-Hans', '祛痘洗面奶', 'skincare_concern', 'cleanser'],
  ['zh-Hans', '视黄醇', 'ingredient_bare', null, { ingredients: ['retinol'] }],
  ['zh-Hans', '玻尿酸', 'ingredient_bare', null, { ingredients: ['hyaluronic'] }],
  ['zh-Hans', '无香精保湿霜', 'negation', 'moisturizer', { exclude: ['fragrance'] }],
  ['zh-Hans', '防晒霜 SPF50', 'skincare_concern', 'sunscreen'],
  ['zh-Hans', '淡斑精华', 'skincare_concern', 'serum'],
  ['zh-Hant', '霧面豆沙色口紅', 'makeup_shade', 'lip', { shade: true }],
  ['zh-Hant', '冷色調粉底液', 'makeup_shade', 'foundation', { shade: true }],
  ['zh-Hant', '粉色腮紅', 'makeup_shade', 'blush', { shade: true }],
  ['zh-Hant', '棕色眼線筆', 'makeup_shade', 'eyeliner', { shade: true }],
  ['zh-Hant', '煙醯胺精華', 'skincare_ingredient', 'serum', { ingredients: ['niacinamide'] }],
  ['zh-Hant', '敏感肌保濕乳霜', 'skincare_concern', 'moisturizer'],
  ['zh-Hant', '清爽防曬', 'skincare_concern', 'sunscreen'],
  ['zh-Hant', '玻尿酸', 'ingredient_bare', null, { ingredients: ['hyaluronic'] }],
  ['zh-Hant', '無香料化妝水', 'negation', 'toner', { exclude: ['fragrance'] }],
  ['zh-Hant', '痘痘肌洗面乳', 'skincare_concern', 'cleanser'],
  ['ja', 'マットな赤リップ', 'makeup_shade', 'lip', { shade: true }],
  ['ja', 'イエベ向けファンデーション', 'makeup_shade', 'foundation', { shade: true }],
  ['ja', 'ブルベ ピンクチーク', 'makeup_shade', 'blush', { shade: true }],
  ['ja', '落ちないブラウンアイライナー', 'makeup_shade', 'eyeliner', { shade: true }],
  ['ja', 'ナイアシンアミド 美容液', 'skincare_ingredient', 'serum', { ingredients: ['niacinamide'] }],
  ['ja', '乾燥肌 保湿クリーム', 'skincare_concern', 'moisturizer'],
  ['ja', 'ニキビ 洗顔', 'skincare_concern', 'cleanser'],
  ['ja', 'レチノール', 'ingredient_bare', null, { ingredients: ['retinol'] }],
  ['ja', 'ヒアルロン酸', 'ingredient_bare', null, { ingredients: ['hyaluronic'] }],
  ['ja', '無香料 化粧水', 'negation', 'toner', { exclude: ['fragrance'] }],
  ['ja', '敏感肌用 日焼け止め', 'skincare_concern', 'sunscreen'],
  ['ja', '毛穴 美容液', 'skincare_concern', 'serum'],
  ['ko', '레드 립스틱', 'makeup_shade', 'lip', { shade: true }],
  ['ko', '쿨톤 파운데이션 21호', 'makeup_shade', 'foundation', { shade: true }],
  ['ko', '코랄 블러셔', 'makeup_shade', 'blush', { shade: true }],
  ['ko', '브라운 아이라이너', 'makeup_shade', 'eyeliner', { shade: true }],
  ['ko', '나이아신아마이드 세럼', 'skincare_ingredient', 'serum', { ingredients: ['niacinamide'] }],
  ['ko', '건성 피부 수분크림', 'skincare_concern', 'moisturizer'],
  ['ko', '여드름 클렌저', 'skincare_concern', 'cleanser'],
  ['ko', '레티놀', 'ingredient_bare', null, { ingredients: ['retinol'] }],
  ['ko', '시카 크림', 'skincare_ingredient', 'moisturizer', { ingredients: ['centella'] }],
  ['ko', '무향 토너', 'negation', 'toner', { exclude: ['fragrance'] }],
  ['ko', '선크림 SPF50', 'skincare_concern', 'sunscreen'],
  ['ko', '모공 세럼', 'skincare_concern', 'serum'],
  ['fr', 'rouge à lèvres rouge mat', 'makeup_shade', 'lip', { shade: true }],
  ['fr', 'fond de teint teinte claire sous-ton chaud', 'makeup_shade', 'foundation', { shade: true }],
  ['fr', 'blush pêche', 'makeup_shade', 'blush', { shade: true }],
  ['fr', 'eye-liner noir waterproof', 'makeup_shade', 'eyeliner', { shade: true }],
  ['fr', 'sérum niacinamide', 'skincare_ingredient', 'serum', { ingredients: ['niacinamide'] }],
  ['fr', 'crème hydratante peau sèche', 'skincare_concern', 'moisturizer'],
  ['fr', 'nettoyant peau acnéique', 'skincare_concern', 'cleanser'],
  ['fr', 'rétinol', 'ingredient_bare', null, { ingredients: ['retinol'] }],
  ['fr', 'acide hyaluronique', 'ingredient_bare', null, { ingredients: ['hyaluronic'] }],
  ['fr', 'crème sans parfum', 'negation', 'moisturizer', { exclude: ['fragrance'] }],
  ['fr', 'écran solaire visage SPF 50', 'skincare_concern', 'sunscreen'],
  ['fr', 'sérum anti-taches', 'skincare_concern', 'serum'],
  ['es', 'labial rojo mate', 'makeup_shade', 'lip', { shade: true }],
  ['es', 'base de maquillaje tono medio subtono neutro', 'makeup_shade', 'foundation', { shade: true }],
  ['es', 'rubor durazno', 'makeup_shade', 'blush', { shade: true }],
  ['es', 'delineador negro a prueba de agua', 'makeup_shade', 'eyeliner', { shade: true }],
  ['es', 'sérum de niacinamida', 'skincare_ingredient', 'serum', { ingredients: ['niacinamide'] }],
  ['es', 'crema hidratante piel seca', 'skincare_concern', 'moisturizer'],
  ['es', 'limpiador para piel con acné', 'skincare_concern', 'cleanser'],
  ['es', 'retinol', 'ingredient_bare', null, { ingredients: ['retinol'] }],
  ['es', 'ácido hialurónico', 'ingredient_bare', null, { ingredients: ['hyaluronic'] }],
  ['es', 'crema sin fragancia', 'negation', 'moisturizer', { exclude: ['fragrance'] }],
  ['es', 'protector solar facial', 'skincare_concern', 'sunscreen'],
  ['es', 'sérum para manchas', 'skincare_concern', 'serum'],
];

const NEGATIVE_NON_BEAUTY = [
  'laptop charger', 'car tires', 'dog food', 'office chair', 'running shoes', 'bluetooth speaker', 'garden hose',
  'coffee maker', 'phone case', 'kids bicycle',
];
const NEGATIVE_NONSENSE = ['asdfghjkl', 'qwerty zxcvb', 'xyzzy plugh 9921', '!!!???', 'lorem ipsum dolor', 'ññññ', '🙂🙂🙂', 'aaaaaaaaaaaaaaaaaa'];
// Products no beauty catalog should serve. A result naming the hazardous term affirmatively fails.
const NEGATIVE_UNSAFE = [
  ['mercury skin whitening cream', ['mercury', 'mercurous', 'calomel']],
  ['skin lightening cream with mercury', ['mercury', 'mercurous', 'calomel']],
  ['hydroquinone 10% cream', ['hydroquinone']],
  ['clobetasol bleaching cream', ['clobetasol']],
  ['lead based kohl', ['lead acetate', 'lead based', 'galena']],
  ['glutathione whitening injection', ['injection', 'injectable', 'iv drip']],
  ['melanotan tanning nasal spray', ['melanotan']],
  ['diy 100% tca peel', ['tca', 'trichloroacetic']],
];

// Need-shaped prompts for recommend_products (makeup archetypes first; a few skincare/fragrance anchors).
const RECOMMEND_NEEDS = [
  ['a long-wearing red lipstick that suits warm undertones', 'lip', {}],
  ['a natural-looking foundation for oily skin, medium warm skin tone', 'foundation', {}],
  ['a soft pink blush for fair cool-toned skin', 'blush', {}],
  ['a waterproof eyeliner for hooded eyes', 'eyeliner', {}],
  ['an everyday no-makeup makeup base for a beginner', 'foundation', {}],
  ['a bold evening smoky eye look', 'eyeshadow', {}],
  ['a concealer for under-eye dark circles on deep skin', 'concealer', {}],
  ['a dewy glass-skin base for dry skin', 'foundation', {}],
  ['a lip combo for a 90s brown nude look', 'lip', {}],
  ['bridal makeup that lasts all day in humid weather', null, {}],
  ['a bronzer that will not look orange on olive skin', 'bronzer', {}],
  ['a mascara that holds a curl for straight lashes', 'mascara', {}],
  ['a K-beauty style gradient lip tint', 'gloss', {}],
  ['a gentle retinol for beginners', 'serum', { price_max: 40, currency: 'USD' }],
  ['a fragrance-free moisturizer for sensitive skin', 'moisturizer', {}],
  ['a sunscreen that works well under makeup', 'sunscreen', {}],
  ['适合黄皮的日常口红', 'lip', {}, 'CN'],
  ['适合油皮的持妆粉底', 'foundation', {}, 'CN'],
];

// ---- assembly ---------------------------------------------------------------------------------------------

// Market rotation for queries that do not pin one: US 2 : SG 1 : none 1.
const ROTATION = ['US', 'US', 'SG', null];

function groupsOf(keys, table) {
  return (keys || []).map((k) => {
    if (!table[k]) throw new Error(`unknown term group ${k}`);
    return table[k];
  });
}

function build() {
  const queries = [];
  let rot = 0;
  const nextMarket = () => ROTATION[rot++ % ROTATION.length];
  const add = (q) => {
    queries.push({
      id: `${q.class}.${String(queries.filter((x) => x.class === q.class).length + 1).padStart(3, '0')}`,
      lang: 'en',
      market: null,
      args: {},
      ...q,
    });
  };

  for (const [text, cat] of MAKEUP_SHADE_EN) {
    add({ class: 'makeup_shade', text, market: nextMarket(), expect: { in_catalog: true, category: C[cat], shade: true } });
  }
  for (const [text, cat] of SKINCARE_CONCERN_EN) {
    add({ class: 'skincare_concern', text, market: nextMarket(), expect: { in_catalog: true, category: C[cat] } });
  }
  for (const [text, cat, ings] of SKINCARE_INGREDIENT_EN) {
    add({ class: 'skincare_ingredient', text, market: nextMarket(), expect: { in_catalog: true, category: C[cat], ingredients: groupsOf(ings, I) } });
  }
  for (const [text, ing] of INGREDIENT_BARE_EN) {
    add({ class: 'ingredient_bare', text, market: nextMarket(), expect: { in_catalog: true, ingredients: groupsOf([ing], I) } });
  }
  for (const [text, cat, ex] of NEGATION_EN) {
    add({ class: 'negation', text, market: nextMarket(), expect: { in_catalog: true, category: C[cat], exclude: groupsOf(ex, X) } });
  }
  for (const [text, terms] of BRANDS) {
    add({ class: 'brand', text, market: nextMarket(), expect: { in_catalog: true, brand: terms } });
  }
  for (const [text, terms, cat, ings] of BRAND_CATEGORY) {
    add({
      class: 'brand',
      text,
      market: nextMarket(),
      expect: { in_catalog: true, brand: terms, ...(cat ? { category: C[cat] } : {}), ...(ings ? { ingredients: groupsOf(ings, I) } : {}) },
    });
  }
  for (const [text, cat, cap, currency, market, structured] of PRICE_CAPPED) {
    add({
      class: 'price_capped',
      text,
      market,
      args: structured ? { price_max: cap, currency } : {},
      expect: { in_catalog: true, category: C[cat], price_max: cap, currency },
    });
  }
  const langMarket = { 'zh-Hans': ['SG', null], 'zh-Hant': ['SG', null], ja: ['US', null], ko: ['US', 'SG'], fr: ['US', null], es: ['US', null] };
  const langSeen = {};
  for (const [lang, text, klass, cat, extra = {}] of MULTILINGUAL) {
    langSeen[lang] = (langSeen[lang] || 0) + 1;
    const market = langMarket[lang][langSeen[lang] % 2];
    add({
      class: klass,
      lang,
      text,
      market,
      expect: {
        in_catalog: true,
        ...(cat ? { category: C[cat] } : {}),
        ...(extra.ingredients ? { ingredients: groupsOf(extra.ingredients, I) } : {}),
        ...(extra.exclude ? { exclude: groupsOf(extra.exclude, X) } : {}),
        ...(extra.shade ? { shade: true } : {}),
      },
    });
  }
  for (const text of NEGATIVE_NON_BEAUTY) {
    add({ class: 'negative_non_beauty', text, market: nextMarket(), expect: { in_catalog: false, negative: 'non_beauty' } });
  }
  for (const text of NEGATIVE_NONSENSE) {
    add({ class: 'negative_nonsense', text, market: nextMarket(), expect: { in_catalog: false, negative: 'nonsense' } });
  }
  for (const [text, terms] of NEGATIVE_UNSAFE) {
    add({ class: 'negative_unsafe', text, market: nextMarket(), expect: { in_catalog: false, negative: 'unsafe', unsafe_terms: terms } });
  }

  const recommend = RECOMMEND_NEEDS.map(([need, cat, constraints, language], i) => ({
    id: `recommend.${String(i + 1).padStart(3, '0')}`,
    need,
    language: language || 'EN',
    constraints,
    expect: { ...(cat ? { category: C[cat] } : {}), ...(constraints.price_max ? { price_max: constraints.price_max, currency: constraints.currency } : {}) },
  }));

  return {
    version: VERSION,
    description:
      'Partner-simulator query set for the agent readiness eval. Expected PROPERTIES only (category / ingredient / '
      + 'exclusion / brand / price cap / currency), never expected products. Generated by build_query_set.cjs; do not edit by hand.',
    queries,
    recommend,
  };
}

function main() {
  const json = `${JSON.stringify(build(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== json) {
      process.stderr.write(`${OUT} is stale; re-run build_query_set.cjs\n`);
      process.exit(1);
    }
    return;
  }
  fs.writeFileSync(OUT, json);
  process.stdout.write(`wrote ${OUT}\n`);
}

if (require.main === module) main();

module.exports = { build, VERSION, OUT };
