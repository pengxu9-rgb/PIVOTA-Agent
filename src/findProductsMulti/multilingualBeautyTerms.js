'use strict';

// Term-level normalisation of non-English beauty queries for find_products_multi ROUTING.
//
// Every lane decision in the find_products_multi path (the search-quality contract's category rules,
// the beauty-likeness check, the strict ingredient detector) is written against English vocabulary,
// with Chinese patterns for some categories. A query in another language that names the same thing
// therefore missed every rule and was answered by the safe-empty clarify or the backend text lane:
//   "crème hydratante"  -> clarify          ("moisturizer"  -> beauty mainline)
//   "선크림"             -> backend lane      ("sunscreen"    -> beauty mainline)
//   "洗面奶"             -> clarify          ("洁面" and "cleanser" -> beauty mainline)
//   "レチノール"          -> backend lane      ("retinol"      -> see strictIngredientQuery.js)
// The existing zh->en alias table (zhEnQueryAliases.js) only reaches the backend lane: it is applied
// when that lane builds its upstream request, i.e. AFTER the lane was chosen.
//
// This maps known beauty TERMS (product types and the strict ingredient vocabulary) in Chinese
// (simplified and traditional), Japanese, Korean, French, Spanish and German to the English term the
// router already understands, before any lane is chosen, so the query routes like its English
// equivalent and then passes through exactly the same lane gates. It never translates a query: words
// it does not know are left as typed. Each alias maps to ONE English term; a word with more than one
// product sense (bare "crème", "마스크" (also a face covering), "Sonnenschutz" (also a car sun shade),
// "唇膏" (lip balm or lipstick), bare "base", "チーク" (also teak)) is deliberately absent.
//
// Negation is kept: "sans rétinol", "不含视黄醇", "레티놀 없는", "ohne Retinol", "retinolfrei" become
// "retinol-free", the form the contract already reads as avoid-retinoids. "sans parfum", "无香料", ...
// become "fragrance-free".
//
// Flag: FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING = off | observe | on (default off), read per call.
// off: never called. observe: computed and logged only. on: applied to routing (queryRoutingNormalizer.js).
// An English query is never changed: a Latin alias whose spelling is also English ("serum", "retinol",
// "creme") applies only as typed with its accents, or to carry a non-English negation.
//
// Pure functions, no dependencies.

const MULTILINGUAL_ROUTING_FLAG = 'FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING';


// kind: 'term' (product type / form), 'ingredient' (strict ingredient table; negation applies),
// 'phrase' (already a complete canonical phrase, e.g. fragrance-free).
// standalone: the mapping applies only when the term is the WHOLE query (an adjective that names the
// product only when it stands alone: "hydratant" -> moisturizer, but "sérum hydratant" -> hydrating serum).
// Each row: [lang, en, kind, terms[], options?]
const ROWS = [
  // ---------------------------------------------------------------- Chinese (simplified + traditional)
  ['zh', 'cleanser', 'term', ['洗面奶', '洗面乳', '洁面乳', '潔面乳', '洁面膏', '潔面膏', '洁面', '潔面']],
  ['zh', 'cleansing foam', 'term', ['洁面泡沫', '潔面泡沫', '洗面泡沫']],
  ['zh', 'cleansing oil', 'term', ['卸妆油', '卸妝油']],
  ['zh', 'cleansing balm', 'term', ['卸妆膏', '卸妝膏']],
  ['zh', 'makeup remover', 'term', ['卸妆水', '卸妝水', '卸妆乳', '卸妝乳', '卸妆', '卸妝']],
  ['zh', 'moisturizer', 'term', ['保湿霜', '保濕霜', '保湿乳', '保濕乳', '润肤霜', '潤膚霜']],
  ['zh', 'face cream', 'term', ['面霜']],
  ['zh', 'lotion', 'term', ['乳液']], // also Japanese
  ['zh', 'sunscreen', 'term', ['防晒霜', '防曬霜', '防晒乳', '防曬乳', '防晒', '防曬']],
  ['zh', 'serum', 'term', ['精华液', '精華液', '精华', '精華']],
  ['zh', 'ampoule', 'term', ['安瓶']],
  ['zh', 'toner', 'term', ['爽肤水', '爽膚水', '化妆水', '化妝水', '柔肤水', '柔膚水']],
  ['zh', 'sheet mask', 'term', ['片状面膜', '片狀面膜']],
  ['zh', 'sleeping mask', 'term', ['睡眠面膜']],
  ['zh', 'clay mask', 'term', ['泥膜']],
  ['zh', 'face mask', 'term', ['面膜']],
  ['zh', 'lipstick', 'term', ['口红', '口紅']], // also Japanese
  ['zh', 'lip gloss', 'term', ['唇釉', '唇彩']],
  ['zh', 'lip balm', 'term', ['润唇膏', '潤唇膏']],
  ['zh', 'cushion foundation', 'term', ['气垫粉底', '氣墊粉底']],
  ['zh', 'foundation', 'term', ['粉底液', '粉底']],
  ['zh', 'concealer', 'term', ['遮瑕膏', '遮瑕']],
  ['zh', 'setting powder', 'term', ['散粉', '蜜粉', '定妆粉', '定妝粉']],
  ['zh', 'blush', 'term', ['腮红', '腮紅']],
  ['zh', 'highlighter', 'term', ['高光']],
  ['zh', 'primer', 'term', ['妆前乳', '妝前乳']],
  ['zh', 'mascara', 'term', ['睫毛膏']],
  ['zh', 'eyeshadow palette', 'term', ['眼影盘', '眼影盤']],
  ['zh', 'eyeshadow', 'term', ['眼影']],
  ['zh', 'eyeliner', 'term', ['眼线笔', '眼線筆', '眼线液', '眼線液', '眼线', '眼線']],
  ['zh', 'brow pencil', 'term', ['眉笔', '眉筆']],
  ['zh', 'perfume', 'term', ['香水']], // also Japanese
  ['zh', 'shampoo', 'term', ['洗发水', '洗髮水', '洗发露', '洗髮露', '洗髮精']],
  ['zh', 'conditioner', 'term', ['护发素', '護髮素']],
  ['zh', 'hair mask', 'term', ['发膜', '髮膜']],
  ['zh', 'nail polish', 'term', ['指甲油']],
  ['zh', 'exfoliant', 'term', ['去角质', '去角質']],
  ['zh', 'shower gel', 'term', ['沐浴露', '沐浴乳']],
  ['zh', 'body lotion', 'term', ['身体乳', '身體乳']],
  ['zh', 'fragrance-free', 'phrase', ['无香料', '無香料', '无香精', '無香精']],
  ['zh', 'retinol', 'ingredient', ['视黄醇', '視黃醇', '维a醇', '維a醇', 'a醇']],
  ['zh', 'hyaluronic acid', 'ingredient', ['透明质酸', '透明質酸', '玻尿酸']],
  ['zh', 'niacinamide', 'ingredient', ['烟酰胺', '煙醯胺', '菸鹼醯胺']],
  ['zh', 'vitamin c', 'ingredient', ['维生素c', '維生素c', '维他命c', '維他命c', '维c', '維c']],
  ['zh', 'ascorbic acid', 'ingredient', ['抗坏血酸', '抗壞血酸']],
  ['zh', 'salicylic acid', 'ingredient', ['水杨酸', '水楊酸']],
  ['zh', 'ceramide', 'ingredient', ['神经酰胺', '神經醯胺']],
  ['zh', 'azelaic acid', 'ingredient', ['壬二酸']],
  ['zh', 'benzoyl peroxide', 'ingredient', ['过氧化苯甲酰', '過氧化苯甲醯']],
  ['zh', 'panthenol', 'ingredient', ['泛醇']],
  ['zh', 'glycerin', 'ingredient', ['甘油']],

  // ---------------------------------------------------------------- Japanese
  ['ja', 'cleansing foam', 'term', ['洗顔フォーム']],
  ['ja', 'face cleanser', 'term', ['洗顔料', '洗顔']],
  ['ja', 'cleansing oil', 'term', ['クレンジングオイル']],
  ['ja', 'cleansing balm', 'term', ['クレンジングバーム']],
  ['ja', 'cleansing foam', 'term', ['クレンジングフォーム']],
  ['ja', 'cleansing gel', 'term', ['クレンジングジェル']],
  ['ja', 'cleansing milk', 'term', ['クレンジングミルク']],
  ['ja', 'micellar water', 'term', ['クレンジングウォーター']],
  ['ja', 'makeup remover', 'term', ['クレンジング', 'メイク落とし']],
  ['ja', 'toner', 'term', ['化粧水']],
  ['ja', 'moisturizer', 'term', ['保湿クリーム']],
  ['ja', 'face cream', 'term', ['フェイスクリーム']],
  ['ja', 'cream', 'term', ['クリーム'], { contextual: true }],
  ['ja', 'sunscreen', 'term', ['日焼け止め', 'サンスクリーン']],
  ['ja', 'serum', 'term', ['美容液', 'セラム']],
  ['ja', 'essence', 'term', ['エッセンス']],
  ['ja', 'ampoule', 'term', ['アンプル']],
  ['ja', 'sheet mask', 'term', ['シートマスク']],
  ['ja', 'face mask', 'term', ['フェイスマスク', 'フェイスパック']],
  ['ja', 'lipstick', 'term', ['リップスティック']],
  ['ja', 'lip gloss', 'term', ['リップグロス']],
  ['ja', 'lip balm', 'term', ['リップクリーム']],
  ['ja', 'lip tint', 'term', ['リップティント']],
  ['ja', 'cushion foundation', 'term', ['クッションファンデーション', 'クッションファンデ']],
  ['ja', 'foundation', 'term', ['ファンデーション']],
  ['ja', 'concealer', 'term', ['コンシーラー']],
  ['ja', 'setting powder', 'term', ['フェイスパウダー', 'ルースパウダー']],
  ['ja', 'blush', 'term', ['チークカラー']],
  ['ja', 'highlighter', 'term', ['ハイライター']],
  ['ja', 'primer', 'term', ['化粧下地']],
  ['ja', 'mascara', 'term', ['マスカラ']],
  ['ja', 'eyeshadow', 'term', ['アイシャドウ', 'アイシャドー']],
  ['ja', 'eyeliner', 'term', ['アイライナー']],
  ['ja', 'brow pencil', 'term', ['アイブロウペンシル']],
  ['ja', 'perfume', 'term', ['パフューム']],
  ['ja', 'shampoo', 'term', ['シャンプー']],
  ['ja', 'conditioner', 'term', ['コンディショナー']],
  ['ja', 'hair oil', 'term', ['ヘアオイル']],
  ['ja', 'hair mask', 'term', ['ヘアマスク']],
  ['ja', 'nail polish', 'term', ['マニキュア', 'ネイルポリッシュ']],
  ['ja', 'exfoliant', 'term', ['ピーリング']],
  ['ja', 'deodorant', 'term', ['デオドラント']],
  ['ja', 'shower gel', 'term', ['ボディソープ']],
  ['ja', 'body lotion', 'term', ['ボディローション']],
  ['ja', 'fragrance-free', 'phrase', ['無香料']],
  ['ja', 'retinol', 'ingredient', ['レチノール']],
  ['ja', 'hyaluronic acid', 'ingredient', ['ヒアルロン酸']],
  ['ja', 'niacinamide', 'ingredient', ['ナイアシンアミド']],
  ['ja', 'vitamin c', 'ingredient', ['ビタミンc']],
  ['ja', 'ascorbic acid', 'ingredient', ['アスコルビン酸']],
  ['ja', 'salicylic acid', 'ingredient', ['サリチル酸']],
  ['ja', 'ceramide', 'ingredient', ['セラミド']],
  ['ja', 'azelaic acid', 'ingredient', ['アゼライン酸']],
  ['ja', 'benzoyl peroxide', 'ingredient', ['過酸化ベンゾイル']],
  ['ja', 'panthenol', 'ingredient', ['パンテノール']],
  ['ja', 'glycerin', 'ingredient', ['グリセリン']],

  // ---------------------------------------------------------------- Korean
  ['ko', 'sunscreen', 'term', ['선크림', '썬크림', '자외선 차단제', '자외선차단제', '선블록', '썬블록', '선스크린']],
  ['ko', 'cleanser', 'term', ['클렌저', '세안제']],
  ['ko', 'cleansing foam', 'term', ['폼클렌징', '클렌징폼', '클렌징 폼']],
  ['ko', 'cleansing oil', 'term', ['클렌징오일', '클렌징 오일']],
  ['ko', 'cleansing balm', 'term', ['클렌징밤', '클렌징 밤']],
  ['ko', 'cleansing water', 'term', ['클렌징워터', '클렌징 워터']],
  ['ko', 'makeup remover', 'term', ['메이크업 리무버', '메이크업리무버']],
  // Not a printer toner: "프린터 토너", "토너 카트리지" keep their words.
  ['ko', 'toner', 'term', ['토너'], { exclude: /(?:프린터|레이저|복합기)\s*토너|토너\s*(?:카트리지|가루)/ }],
  ['ko', 'essence', 'term', ['에센스']],
  ['ko', 'serum', 'term', ['세럼']],
  ['ko', 'ampoule', 'term', ['앰플']],
  ['ko', 'moisturizer', 'term', ['수분크림', '수분 크림', '보습크림', '보습 크림']],
  ['ko', 'lotion', 'term', ['로션']],
  ['ko', 'cream', 'term', ['크림'], { contextual: true }],
  ['ko', 'sheet mask', 'term', ['시트마스크', '시트 마스크', '마스크팩']],
  ['ko', 'sleeping mask', 'term', ['수면팩']],
  ['ko', 'lipstick', 'term', ['립스틱']],
  ['ko', 'lip gloss', 'term', ['립글로스']],
  ['ko', 'lip balm', 'term', ['립밤']],
  ['ko', 'lip tint', 'term', ['립틴트']],
  ['ko', 'cushion foundation', 'term', ['쿠션 파운데이션', '쿠션파운데이션', '쿠션팩트']],
  ['ko', 'foundation', 'term', ['파운데이션']],
  ['ko', 'concealer', 'term', ['컨실러']],
  ['ko', 'setting powder', 'term', ['세팅 파우더', '세팅파우더']],
  ['ko', 'blush', 'term', ['블러셔']],
  ['ko', 'highlighter', 'term', ['하이라이터']],
  ['ko', 'primer', 'term', ['프라이머', '메이크업 베이스']],
  ['ko', 'mascara', 'term', ['마스카라']],
  ['ko', 'eyeshadow', 'term', ['아이섀도우', '아이섀도', '아이쉐도우']],
  ['ko', 'eyeliner', 'term', ['아이라이너']],
  ['ko', 'brow pencil', 'term', ['아이브로우 펜슬', '아이브로우펜슬']],
  ['ko', 'perfume', 'term', ['향수']],
  ['ko', 'shampoo', 'term', ['샴푸']],
  ['ko', 'conditioner', 'term', ['컨디셔너', '린스']],
  ['ko', 'hair oil', 'term', ['헤어오일', '헤어 오일']],
  ['ko', 'hair mask', 'term', ['헤어팩', '헤어 마스크', '헤어마스크']],
  ['ko', 'nail polish', 'term', ['매니큐어', '네일 폴리시']],
  ['ko', 'exfoliant', 'term', ['각질제거제']],
  ['ko', 'body wash', 'term', ['바디워시']],
  ['ko', 'body lotion', 'term', ['바디로션']],
  ['ko', 'deodorant', 'term', ['데오드란트']],
  ['ko', 'fragrance-free', 'phrase', ['무향']],
  ['ko', 'retinol', 'ingredient', ['레티놀']],
  ['ko', 'hyaluronic acid', 'ingredient', ['히알루론산']],
  ['ko', 'niacinamide', 'ingredient', ['나이아신아마이드']],
  ['ko', 'vitamin c', 'ingredient', ['비타민c', '비타민 c', '비타민씨']],
  ['ko', 'ascorbic acid', 'ingredient', ['아스코빅애씨드']],
  ['ko', 'salicylic acid', 'ingredient', ['살리실산']],
  ['ko', 'ceramide', 'ingredient', ['세라마이드']],
  ['ko', 'azelaic acid', 'ingredient', ['아젤라산', '아젤라익애씨드']],
  ['ko', 'benzoyl peroxide', 'ingredient', ['벤조일퍼옥사이드']],
  ['ko', 'panthenol', 'ingredient', ['판테놀']],
  ['ko', 'glycerin', 'ingredient', ['글리세린']],

  // ---------------------------------------------------------------- French
  ['fr', 'face cleanser', 'term', ['nettoyant visage', 'nettoyant pour le visage']],
  ['fr', 'cleansing gel', 'term', ['gel nettoyant']],
  ['fr', 'cleansing foam', 'term', ['mousse nettoyante']],
  ['fr', 'cleansing milk', 'term', ['lait nettoyant', 'lait demaquillant']],
  ['fr', 'cleansing oil', 'term', ['huile nettoyante', 'huile demaquillante']],
  ['fr', 'micellar water', 'term', ['eau micellaire']],
  ['fr', 'makeup remover', 'term', ['demaquillant']],
  ['fr', 'moisturizer', 'term', ['creme hydratante', 'soin hydratant']],
  ['fr', 'moisturizer', 'term', ['hydratant', 'hydratante'], { standalone: true }],
  ['fr', 'hydrating', 'term', ['hydratant', 'hydratante']],
  ['fr', 'hydrating face mask', 'term', ['masque hydratant']],
  ['fr', 'face cream', 'term', ['creme visage', 'creme pour le visage']],
  // Context-only: next to an ingredient or another beauty term, "crème" / "creme" / German "Creme"
  // all read as "cream" ("Retinol Creme" -> "retinol cream"); alone, "creme brulee" stays as typed.
  ['fr', 'cream', 'term', ['creme'], { contextual: true }],
  ['fr', 'sunscreen', 'term', ['creme solaire', 'ecran solaire', 'protection solaire', 'lait solaire', 'spray solaire']],
  ['fr', 'serum', 'term', ['serum']],
  ['fr', 'toner', 'term', ['lotion tonique', 'tonique visage']],
  ['fr', 'sheet mask', 'term', ['masque en tissu', 'masque tissu']],
  ['fr', 'clay mask', 'term', ['masque a l argile', 'masque argile']],
  ['fr', 'hair mask', 'term', ['masque capillaire', 'masque cheveux']],
  ['fr', 'face mask', 'term', ['masque visage', 'masque pour le visage']],
  ['fr', 'lipstick', 'term', ['rouge a levres']],
  ['fr', 'lip gloss', 'term', ['brillant a levres']],
  ['fr', 'lip balm', 'term', ['baume a levres', 'baume levres']],
  ['fr', 'foundation', 'term', ['fond de teint']],
  ['fr', 'concealer', 'term', ['anticernes', 'anti cernes']],
  ['fr', 'loose powder', 'term', ['poudre libre']],
  ['fr', 'blush', 'term', ['fard a joues']],
  ['fr', 'highlighter', 'term', ['enlumineur']],
  ['fr', 'primer', 'term', ['base de teint', 'base de maquillage']],
  ['fr', 'eyeshadow palette', 'term', ['palette de fards a paupieres', 'palette yeux']],
  ['fr', 'eyeshadow', 'term', ['fard a paupieres', 'ombre a paupieres']],
  ['fr', 'brow pencil', 'term', ['crayon a sourcils', 'crayon sourcils']],
  ['fr', 'fragrance-free', 'phrase', ['sans parfum']],
  ['fr', 'conditioner', 'term', ['apres shampooing', 'apres shampoing']],
  ['fr', 'shampoo', 'term', ['shampooing', 'shampoing']],
  ['fr', 'hair oil', 'term', ['huile capillaire', 'huile cheveux']],
  ['fr', 'nail polish', 'term', ['vernis a ongles']],
  ['fr', 'exfoliant', 'term', ['gommage']],
  ['fr', 'deodorant', 'term', ['deodorant']],
  ['fr', 'shower gel', 'term', ['gel douche']],
  ['fr', 'body lotion', 'term', ['lait corps', 'lait corporel']],
  ['fr', 'self tanner', 'term', ['autobronzant']],
  ['fr', 'retinol', 'ingredient', ['retinol']],
  ['fr', 'hyaluronic acid', 'ingredient', ['acide hyaluronique']],
  ['fr', 'niacinamide', 'ingredient', ['niacinamide']],
  ['fr', 'vitamin c', 'ingredient', ['vitamine c']],
  ['fr', 'ascorbic acid', 'ingredient', ['acide ascorbique']],
  ['fr', 'salicylic acid', 'ingredient', ['acide salicylique']],
  ['fr', 'ceramide', 'ingredient', ['ceramide', 'ceramides'], { englishSpelling: true }],
  ['fr', 'azelaic acid', 'ingredient', ['acide azelaique']],
  ['fr', 'benzoyl peroxide', 'ingredient', ['peroxyde de benzoyle']],
  ['fr', 'panthenol', 'ingredient', ['panthenol']],
  ['fr', 'glycerin', 'ingredient', ['glycerine', 'glycerin'], { englishSpelling: true }],

  // ---------------------------------------------------------------- Spanish
  ['es', 'face cleanser', 'term', ['limpiador facial']],
  ['es', 'cleansing gel', 'term', ['gel limpiador']],
  ['es', 'cleansing foam', 'term', ['espuma limpiadora']],
  ['es', 'cleansing milk', 'term', ['leche limpiadora']],
  ['es', 'cleansing oil', 'term', ['aceite limpiador', 'aceite desmaquillante']],
  ['es', 'micellar water', 'term', ['agua micelar']],
  ['es', 'makeup remover', 'term', ['desmaquillante']],
  ['es', 'moisturizer', 'term', ['crema hidratante']],
  ['es', 'moisturizer', 'term', ['hidratante'], { standalone: true }],
  ['es', 'hydrating', 'term', ['hidratante']],
  ['es', 'face cream', 'term', ['crema facial']],
  ['es', 'cream', 'term', ['crema'], { contextual: true }],
  ['es', 'sunscreen', 'term', ['protector solar', 'bloqueador solar', 'filtro solar', 'crema solar', 'proteccion solar', 'fotoprotector']],
  ['es', 'face serum', 'term', ['suero facial']],
  ['es', 'toner', 'term', ['tonico facial']],
  ['es', 'sheet mask', 'term', ['mascarilla de tela']],
  ['es', 'hair mask', 'term', ['mascarilla capilar', 'mascarilla para el cabello', 'mascarilla de pelo']],
  ['es', 'face mask', 'term', ['mascarilla facial']],
  ['es', 'lip balm', 'term', ['balsamo labial', 'balsamo de labios']],
  ['es', 'lip gloss', 'term', ['brillo labial', 'brillo de labios']],
  ['es', 'lip tint', 'term', ['tinta labial', 'tinta de labios']],
  ['es', 'lip scrub', 'term', ['exfoliante labial']],
  ['es', 'lip liner', 'term', ['delineador de labios']],
  ['es', 'lipstick', 'term', ['lapiz labial', 'pintalabios', 'barra de labios']], // bare "labial" is also English
  ['es', 'foundation', 'term', ['base de maquillaje']],
  ['es', 'concealer', 'term', ['corrector de ojeras']],
  ['es', 'pressed powder', 'term', ['polvo compacto']],
  ['es', 'loose powder', 'term', ['polvos sueltos', 'polvo suelto']],
  ['es', 'blush', 'term', ['rubor', 'colorete']],
  ['es', 'highlighter', 'term', ['iluminador']],
  ['es', 'primer', 'term', ['prebase']],
  ['es', 'mascara', 'term', ['rimel', 'mascara de pestanas']],
  ['es', 'eyeshadow palette', 'term', ['paleta de sombras']],
  ['es', 'eyeshadow', 'term', ['sombra de ojos', 'sombras de ojos']],
  ['es', 'eyeliner', 'term', ['delineador de ojos', 'delineador']],
  ['es', 'brow pencil', 'term', ['lapiz de cejas']],
  ['es', 'fragrance-free', 'phrase', ['sin perfume', 'sin fragancia']],
  ['es', 'shampoo', 'term', ['champu']],
  ['es', 'hair conditioner', 'term', ['acondicionador para el cabello', 'acondicionador de cabello', 'acondicionador de pelo']],
  ['es', 'hair oil', 'term', ['aceite capilar']],
  ['es', 'nail polish', 'term', ['esmalte de unas', 'pintaunas']],
  ['es', 'exfoliant', 'term', ['exfoliante']],
  ['es', 'deodorant', 'term', ['desodorante']],
  ['es', 'shower gel', 'term', ['gel de ducha']],
  ['es', 'body lotion', 'term', ['locion corporal', 'crema corporal']],
  ['es', 'self tanner', 'term', ['autobronceador']],
  ['es', 'retinol', 'ingredient', ['retinol']],
  ['es', 'hyaluronic acid', 'ingredient', ['acido hialuronico']],
  ['es', 'niacinamide', 'ingredient', ['niacinamida']],
  ['es', 'vitamin c', 'ingredient', ['vitamina c']],
  ['es', 'ascorbic acid', 'ingredient', ['acido ascorbico']],
  ['es', 'salicylic acid', 'ingredient', ['acido salicilico']],
  ['es', 'ceramide', 'ingredient', ['ceramida', 'ceramidas']],
  ['es', 'azelaic acid', 'ingredient', ['acido azelaico']],
  ['es', 'benzoyl peroxide', 'ingredient', ['peroxido de benzoilo']],
  ['es', 'panthenol', 'ingredient', ['pantenol']],
  ['es', 'glycerin', 'ingredient', ['glicerina']],

  // ---------------------------------------------------------------- German (ä/ö/ü folded; ae/oe/ue added)
  ['de', 'face cleanser', 'term', ['gesichtsreinigung']],
  ['de', 'cleansing gel', 'term', ['reinigungsgel']],
  ['de', 'cleansing foam', 'term', ['reinigungsschaum']],
  ['de', 'face wash', 'term', ['waschgel']],
  ['de', 'cleansing milk', 'term', ['reinigungsmilch']],
  ['de', 'cleansing oil', 'term', ['reinigungsöl']],
  ['de', 'micellar water', 'term', ['mizellenwasser']],
  ['de', 'makeup remover', 'term', ['make up entferner', 'makeup entferner', 'abschminkmittel']],
  ['de', 'moisturizer', 'term', ['feuchtigkeitscreme', 'feuchtigkeitspflege']],
  ['de', 'face cream', 'term', ['gesichtscreme']],
  ['de', 'sunscreen', 'term', ['sonnencreme', 'sonnenmilch', 'sonnenspray', 'sonnenschutzcreme', 'sonnenschutzmittel']],
  ['de', 'face serum', 'term', ['gesichtsserum']],
  ['de', 'toner', 'term', ['gesichtswasser', 'gesichtstonikum']],
  ['de', 'sheet mask', 'term', ['tuchmaske']],
  ['de', 'face mask', 'term', ['gesichtsmaske']],
  ['de', 'hair mask', 'term', ['haarmaske', 'haarkur']],
  ['de', 'lipstick', 'term', ['lippenstift']],
  ['de', 'lip balm', 'term', ['lippenbalsam', 'lippenpflegestift']],
  ['de', 'concealer', 'term', ['abdeckstift']],
  ['de', 'mascara', 'term', ['wimperntusche']],
  ['de', 'eyeshadow palette', 'term', ['lidschattenpalette']],
  ['de', 'eyeshadow', 'term', ['lidschatten']],
  ['de', 'brow pencil', 'term', ['augenbrauenstift']],
  ['de', 'fragrance-free', 'phrase', ['parfümfrei', 'parfumfrei', 'ohne parfum', 'ohne parfüm', 'ohne duftstoffe', 'duftstofffrei']],
  ['de', 'perfume', 'term', ['parfüm'], { englishSpelling: true }], // "parfum" as typed is English
  ['de', 'shampoo', 'term', ['haarshampoo']],
  ['de', 'conditioner', 'term', ['haarspülung']],
  ['de', 'hair oil', 'term', ['haaröl']],
  ['de', 'nail polish', 'term', ['nagellack']],
  // Bare "Peeling" is not mapped: it is also an English word ("peeling skin").
  ['de', 'exfoliant', 'term', ['gesichtspeeling']],
  ['de', 'shower gel', 'term', ['duschgel']],
  ['de', 'body lotion', 'term', ['körperlotion', 'bodylotion']],
  ['de', 'self tanner', 'term', ['selbstbräuner']],
  ['de', 'retinol', 'ingredient', ['retinol']],
  ['de', 'hyaluronic acid', 'ingredient', ['hyaluronsäure']],
  ['de', 'niacinamide', 'ingredient', ['niacinamid']],
  ['de', 'vitamin c', 'ingredient', ['vitamin c']],
  ['de', 'ascorbic acid', 'ingredient', ['ascorbinsäure']],
  ['de', 'salicylic acid', 'ingredient', ['salicylsäure']],
  ['de', 'ceramide', 'ingredient', ['ceramide']],
  ['de', 'azelaic acid', 'ingredient', ['azelainsäure']],
  ['de', 'benzoyl peroxide', 'ingredient', ['benzoylperoxid']],
  ['de', 'panthenol', 'ingredient', ['panthenol']],
  ['de', 'glycerin', 'ingredient', ['glycerin']],
];

const LATIN_WORD_CHAR = /[a-z0-9]/;
const NON_LATIN_SCRIPT = /[぀-ヿ㐀-鿿가-힯ᄀ-ᇿ㄰-㆏]/;
const ASCII_ONLY = /^[\x00-\x7f]*$/;

// Folds one character for matching: lowercase, diacritics stripped (é->e, ä->a), ß->s, full-width
// forms to ASCII, and the separators people type inside a term ('-', '_', '’', "'", '.') to a space.
// Always exactly ONE output character per input code unit, so positions in the folded text are
// positions in the original.
function foldChar(ch) {
  if (ch === 'ß') return 's'; // sharp s
  if (/[-_'’.·]/.test(ch)) return ' ';
  const code = ch.charCodeAt(0);
  // Only Latin letters and full-width ASCII are decomposed: NFKD would split a Hangul syllable into
  // jamo and a kana into base + voicing mark, and neither is a diacritic to strip.
  if (!(code <= 0x024f || (code >= 0xff00 && code <= 0xffef))) return ch.toLowerCase();
  const decomposed = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const lower = (decomposed || ch).toLowerCase();
  return lower.length === 1 ? lower : lower.charAt(0) || ch;
}

function foldText(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) out += foldChar(text[i]);
  return out;
}

function foldTerm(term) {
  return foldText(String(term || '')).replace(/\s+/g, ' ').trim();
}

// German umlaut spellings people type without the key: ä->ae, ö->oe, ü->ue.
function germanTranscriptions(term) {
  if (!/[äöü]/.test(term)) return [];
  return [term.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')];
}

// A Latin entry whose folded spelling is also an English word ("serum", "retinol", "ceramides",
// "deodorant", "creme") must leave an English query alone. It applies only when the user typed it with
// its accents ("sérum", "rétinol", "déodorant", "crème") -- or, for an ingredient, only to carry a
// non-English negation ("sin retinol", "ohne Retinol", "retinolfrei").
function isEnglishSpelling(key, en, options) {
  return Boolean(options.englishSpelling) || key === en;
}

function buildEntries() {
  const byKey = new Map();
  const standaloneByKey = new Map();
  for (const [lang, en, kind, terms, options = {}] of ROWS) {
    for (const rawTerm of terms) {
      const variants = [rawTerm, ...(lang === 'de' ? germanTranscriptions(rawTerm) : [])];
      for (const variant of variants) {
        const key = foldTerm(variant);
        if (!key) continue;
        const script = NON_LATIN_SCRIPT.test(key) ? 'cjk' : 'latin';
        const entry = {
          key,
          en,
          kind,
          lang,
          script,
          exclude: options.exclude || null,
          contextual: Boolean(options.contextual),
          englishSpelling: script === 'latin' && isEnglishSpelling(key, en, options),
        };
        const target = options.standalone ? standaloneByKey : byKey;
        const existing = target.get(key);
        if (existing && existing.en !== en) {
          // One alias, one canonical term: two rows disagreeing is a table bug, caught at load.
          throw new Error(`multilingualBeautyTerms: "${variant}" maps to both "${existing.en}" and "${en}"`);
        }
        if (!existing) target.set(key, entry);
      }
    }
  }
  const entries = Array.from(byKey.values()).sort((a, b) => b.key.length - a.key.length);
  return { entries, standaloneByKey };
}

const { entries: ENTRIES, standaloneByKey: STANDALONE_BY_KEY } = buildEntries();

// Negators around an ingredient term, on FOLDED text. All non-English: an English query's own
// negation ("retinol free") is FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING's business, not this table's.
const NEGATION_PREFIX_LATIN = /(?:^|\s)(?:sans|sin|ohne|frei von|libre de|exento de)\s+(?:(?:de|d|du|des|le|la|l|el|los|las)\s+)?$/;
const NEGATION_PREFIX_CJK = /(?:不含|无添加|無添加|无|無|没有|沒有|避开|避開|不要|不加)\s*$/;
const NEGATION_SUFFIX_LATIN = /^\s*frei(?![a-z0-9])/;
const NEGATION_SUFFIX_CJK = /^(?:\s*free(?![a-z0-9])|\s*(?:フリー|不使用|無添加|なし|無し|없는|무첨가|프리|없이))/;
// Korean particles attached to a matched noun ("선크림을"): dropped with the match so they do not
// linger as a stray token.
const KOREAN_PARTICLE_SUFFIX = /^(?:을|를|은|는|이|가|도|의)(?=\s|$)/;
// The strict ingredient terms in English: a contextual entry ("크림", "crème") also applies next to one
// of these ("retinol 크림" reads like "retinol cream").
const ENGLISH_INGREDIENT_RE = /(?:^|[^a-z0-9])(?:retinol|niacinamide|panthenol|glycerine?|ceramides?|hyaluronic acid|salicylic acid|azelaic acid|ascorbic acid|benzoyl peroxide|vitamin c|zinc pca)(?![a-z0-9])/;

function isLatinBoundary(folded, index) {
  if (index < 0 || index >= folded.length) return true;
  return !LATIN_WORD_CHAR.test(folded[index]);
}

function isCjkChar(ch) {
  return typeof ch === 'string' && NON_LATIN_SCRIPT.test(ch);
}

function collectMatches(original, folded, { includeContextual }) {
  const consumed = new Array(folded.length).fill(false);
  const matches = [];
  for (const entry of ENTRIES) {
    if (entry.contextual && !includeContextual) continue;
    if (entry.exclude && entry.exclude.test(folded)) continue;
    let from = 0;
    while (from <= folded.length - entry.key.length) {
      const index = folded.indexOf(entry.key, from);
      if (index < 0) break;
      const end = index + entry.key.length;
      from = index + 1;
      if (entry.script === 'latin') {
        const leftOk = isLatinBoundary(folded, index - 1);
        const rightOk =
          isLatinBoundary(folded, end) ||
          (entry.kind === 'ingredient' && NEGATION_SUFFIX_LATIN.test(folded.slice(end)));
        if (!leftOk || !rightOk) continue;
      }
      let overlaps = false;
      for (let i = index; i < end; i += 1) {
        if (consumed[i]) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      let start = index;
      let stop = end;
      let negated = false;
      if (entry.kind === 'ingredient') {
        const before = folded.slice(0, index);
        const prefix = before.match(NEGATION_PREFIX_LATIN) || before.match(NEGATION_PREFIX_CJK);
        if (prefix) {
          negated = true;
          start = index - prefix[0].replace(/^\s/, '').length;
        }
        const suffix = folded.slice(end).match(entry.script === 'latin' ? NEGATION_SUFFIX_LATIN : NEGATION_SUFFIX_CJK);
        if (suffix) {
          negated = true;
          stop = end + suffix[0].length;
        }
      }
      // An English spelling as typed stays English unless it carries a non-English negation.
      if (entry.englishSpelling && !negated && ASCII_ONLY.test(original.slice(index, end))) continue;
      if (entry.script === 'cjk') {
        const particle = folded.slice(stop).match(KOREAN_PARTICLE_SUFFIX);
        if (particle) stop += particle[0].length;
      }
      let blocked = false;
      for (let i = start; i < stop; i += 1) {
        if (consumed[i]) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      for (let i = start; i < stop; i += 1) consumed[i] = true;
      matches.push({ start, stop, entry, negated });
    }
  }
  return matches;
}

// Connectors that sit between a term and the next word without making a new compound: "formulated
// with" (配合, 배합, 함유, 含有, 含, 入り) and possessive / linking particles (の, 的, と, や). Next to a
// mapped term they do not block it, and they are dropped from the rewritten query.
const CJK_CONNECTORS = Object.freeze(['配合', '배합', '함유', '含有', '含', '入り', 'の', '的', 'と', 'や']);

function connectorSpans(folded) {
  const spans = [];
  for (const connector of CJK_CONNECTORS) {
    let from = 0;
    for (;;) {
      const index = folded.indexOf(connector, from);
      if (index < 0) break;
      spans.push({ start: index, stop: index + connector.length });
      from = index + connector.length;
    }
  }
  return spans;
}

// Connector spans that touch a kept match, directly or through another such connector.
function touchingConnectors(spans, matches) {
  const touching = [];
  let grew = true;
  const touches = (a, b) => a.start === b.stop || a.stop === b.start;
  while (grew) {
    grew = false;
    for (const span of spans) {
      if (touching.includes(span)) continue;
      if (matches.some((match) => touches(span, match)) || touching.some((other) => touches(span, other))) {
        touching.push(span);
        grew = true;
      }
    }
  }
  return touching;
}

// A CJK term is mapped only as a WHOLE term: if the character right before or after it is another
// Han / kana / Hangul character that no other mapped term (or a connector next to one) covers, the
// match is part of a longer compound this table does not know ("精华水", "补水精华", "아이크림") and
// is dropped. Repeated until stable, because dropping one match can expose its neighbour.
function dropPartialCompoundMatches(folded, matches) {
  let kept = matches.slice();
  const spans = connectorSpans(folded);
  for (;;) {
    const covered = new Array(folded.length).fill(false);
    for (const match of kept) for (let i = match.start; i < match.stop; i += 1) covered[i] = true;
    for (const span of touchingConnectors(spans, kept)) for (let i = span.start; i < span.stop; i += 1) covered[i] = true;
    const next = kept.filter((match) => {
      if (match.entry.script !== 'cjk') return true;
      const left = match.start - 1;
      const right = match.stop;
      const leftBad = left >= 0 && isCjkChar(folded[left]) && !covered[left];
      const rightBad = right < folded.length && isCjkChar(folded[right]) && !covered[right];
      return !leftBad && !rightBad;
    });
    if (next.length === kept.length) return kept;
    kept = next;
  }
}

// Returns { query, applied, terms: [{ lang, kind, en }] }. `query` is the input with every known term
// replaced by its English term (negated ingredients as "<en>-free"); unchanged input when nothing
// matched or every match was already the English word as typed.
function normalizeMultilingualBeautyTerms(rawQuery, { contextAvailable = false } = {}) {
  const original = String(rawQuery == null ? '' : rawQuery);
  const none = { query: original, applied: false, terms: [] };
  if (!original.trim()) return none;
  const folded = foldText(original);

  const wholeKey = folded.replace(/\s+/g, ' ').trim();
  const standalone = STANDALONE_BY_KEY.get(wholeKey);
  if (standalone) {
    return {
      query: standalone.en,
      applied: standalone.en !== original.trim(),
      terms: [{ lang: standalone.lang, kind: standalone.kind, en: standalone.en }],
    };
  }

  // Contextual entries ("크림", "crème", "crema") name a product form only next to another beauty
  // term: alone they are as likely to be whipped cream or coffee crema.
  // The context is what SURVIVES the whole-term rule: a term that was only part of an unknown compound
  // is no context for its neighbour. (Before, "레티놀배합 크림" kept 크림 -> cream on the strength of a
  // 레티놀 that was then dropped, and browsed every cream.)
  const withContextual = dropPartialCompoundMatches(folded, collectMatches(original, folded, { includeContextual: true }));
  const contextSurvives =
    contextAvailable || ENGLISH_INGREDIENT_RE.test(folded) || withContextual.some((match) => !match.entry.contextual);
  const matches = contextSurvives
    ? withContextual
    : dropPartialCompoundMatches(folded, collectMatches(original, folded, { includeContextual: false }));
  if (matches.length === 0) return none;
  const droppedConnectors = touchingConnectors(connectorSpans(folded), matches);

  matches.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  let changed = false;
  const terms = [];
  // Connectors next to a mapped term go with it ("레티놀배합" -> "retinol", "配合の" -> "").
  const withoutConnectors = (from, to) => {
    let text = '';
    for (let i = from; i < to; i += 1) {
      text += droppedConnectors.some((span) => i >= span.start && i < span.stop) ? ' ' : original[i];
    }
    return text;
  };
  if (droppedConnectors.length > 0) changed = true;
  for (const match of matches) {
    const replacement = match.negated ? `${match.entry.en}-free` : match.entry.en;
    const source = original.slice(match.start, match.stop);
    out += withoutConnectors(cursor, match.start);
    if (!match.negated && source.toLowerCase().replace(/\s+/g, ' ') === replacement) {
      out += source;
    } else {
      out += ` ${replacement} `;
      changed = true;
      terms.push({ lang: match.entry.lang, kind: match.negated ? 'negated_ingredient' : match.entry.kind, en: replacement });
    }
    cursor = match.stop;
  }
  out += withoutConnectors(cursor, original.length);
  if (!changed) return none;
  return { query: out.replace(/\s+/g, ' ').trim(), applied: true, terms };
}

function multilingualRoutingMode(env = process.env) {
  const raw = String((env && env[MULTILINGUAL_ROUTING_FLAG]) || '').trim().toLowerCase();
  if (/^(1|true|on|yes)$/.test(raw)) return 'on';
  if (/^(observe|shadow)$/.test(raw)) return 'observe';
  return 'off';
}

function isMultilingualRoutingEnabled(env = process.env) {
  return multilingualRoutingMode(env) === 'on';
}

module.exports = {
  MULTILINGUAL_ROUTING_FLAG,
  multilingualRoutingMode,
  isMultilingualRoutingEnabled,
  normalizeMultilingualBeautyTerms,
  // Exposed for tests: the folded alias table.
  _entries: ENTRIES,
  _standaloneEntries: STANDALONE_BY_KEY,
};
