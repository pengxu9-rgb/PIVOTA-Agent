function normalizeBeautyQueryClass(queryClass) {
  return String(queryClass || '').trim().toLowerCase() || null;
}

function inferBeautyConcernClass(queryText, bucket = null) {
  const q = String(queryText || '').trim().toLowerCase();
  if (!q) return null;

  if (
    /\b(sunscreen|spf\b|sunblock|sun protection|broad spectrum|uv|uva|uvb|pa\+{1,4})\b/.test(q) ||
    /防晒|防曬|日焼け止め/.test(q)
  ) {
    return 'sunscreen';
  }

  if (
    /\b(spot treatment|spot gel|acne spot|acne patch|pimple patch|clearing pads?|pads?|benzoyl peroxide)\b/.test(
      q,
    ) ||
    (
      /\b(acne|blemish|breakout|pimple|congestion)\b/.test(q) &&
      /\b(urgent|overnight|fast|quick|rapid|rescue|relief|spot|patch|pad)\b/.test(q)
    )
  ) {
    return 'acne_urgent';
  }

  if (
    /\b(oily skin|oil control|shine control|anti-shine|mattify|mattifying|sebum|pore|minimizing|niacinamide|salicylic(?:\s+acid)?|zinc)\b/.test(
      q,
    ) ||
    /控油|出油|毛孔|水杨酸|水楊酸|烟酰胺|煙酰胺/.test(q)
  ) {
    return 'oil_control';
  }

  if (
    /\b(dark spots?|hyperpigmentation|brighten|brightening|radiance|vitamin c|tranexamic|kojic|alpha arbutin)\b/.test(
      q,
    ) ||
    /提亮|淡斑|暗沉|维他命c|維他命c|传明酸|傳明酸|熊果苷/.test(q)
  ) {
    return 'brightening';
  }

  if (
    /\b(barrier|repair|ceramide|panthenol|b5|cica|centella|redness|sensitive|soothing|calming)\b/.test(
      q,
    ) ||
    /屏障|修护|修護|神经酰胺|神經醯胺|泛醇|积雪草|積雪草|敏感|泛红|泛紅|舒缓|舒緩/.test(q)
  ) {
    return 'barrier_repair';
  }

  if (
    /\b(hydrat\w*|dehydrat\w*|plump\w*|hyalur\w*|hyaluronate|glycerin)\b/.test(q) ||
    /保湿|保濕|补水|補水|透明质酸|透明質酸|玻尿酸|甘油/.test(q)
  ) {
    return 'hydration';
  }

  if (bucket === 'skincare') {
    return 'generic_skincare';
  }

  return null;
}

function hasFragranceFreeSkincareSignal(text) {
  return /\b(fragrance(?:\s|-)?free|fragranceless|unscented|without fragrance|no fragrance|sans parfum)\b/i.test(
    String(text || ''),
  );
}

function classifyBeautyBucketFromText(text) {
  const q = String(text || '');
  if (!q) return 'other';

  const hasHaircareSignal =
    /\b(haircare|hair care|shampoo|conditioner|leave[-\s]?in conditioner|hair oil|scalp oil|hair mask|hair serum|scalp serum|hair treatment|dry shampoo)\b/i.test(
      q,
    ) ||
    /护发|護髮|護发|洗发水|洗髮水|护发素|護髮素|发油|髮油|发膜|髮膜|头皮|頭皮|シャンプー|コンディショナー|ヘアオイル/.test(
      q,
    );
  const hasLipCareSignal =
    /\b(lip balm|lip balms|lip oil|lip oils|lip treatment|lip treatments|lip mask|lip butter|lip conditioner|spf lip)\b/i.test(
      q,
    ) ||
    /润唇|潤唇|唇膜|护唇|護唇|唇部护理|唇部護理|リップバーム|リップオイル/.test(q);
  const hasBodycareSignal =
    /\b(body wash|body cleanser|shower gel|bath gel|body lotion|body cream|body oil|body butter)\b/i.test(
      q,
    ) ||
    /沐浴露|身体乳|身體乳|ボディウォッシュ|ボディローション/.test(q);

  const hasSkincareTreatmentSignal =
    /\b(serum|toner|essence|ampoule|moisturi(?:z|s)er|cleanser|sunscreen|spf\b|sunblock|face wash|niacinamide|retinol|vitamin c|peptide|ceramide|cica|hyaluronic|salicylic|azelaic|aha|bha|oil control|shine control|congestion|blemish|acne treatment|spot treatment|clarifying|pore care)\b/i.test(
      q,
    ) ||
    /护肤|護膚|精华|精華|化妆水|化妝水|乳液|洁面|潔面|防晒|防曬|日焼け止め|美容液|洗顔料/.test(
      q,
    );

  if (hasFragranceFreeSkincareSignal(q) && hasSkincareTreatmentSignal) {
    return 'skincare';
  }
  if (
    /\b(perfume|fragrance|parfum|cologne|body mist|eau de parfum|eau de toilette)\b/i.test(q) ||
    /香水|香氛|古龙|古龍|フレグランス|コロン/.test(q)
  ) {
    return 'fragrance';
  }
  if (
    /\b(brush|brushes|blender|sponge|puff|applicator|tool|tools|brush\s*set|powder puff|eyelash curler)\b/i.test(
      q,
    ) ||
    /化妆刷|化妝刷|刷具|粉扑|粉撲|美妆蛋|美妝蛋|工具|刷子|パフ|ブラシ|ビューラー/.test(q)
  ) {
    return 'tools';
  }
  if (hasHaircareSignal) {
    return 'haircare';
  }
  if (hasBodycareSignal) {
    return 'bodycare';
  }
  if (hasSkincareTreatmentSignal) {
    return 'skincare';
  }
  if (
    /\b(foundation|concealer|primer|powder|cushion|bb\s*cream|cc\s*cream|setting\s*powder)\b/i.test(
      q,
    ) ||
    /粉底|遮瑕|妆前|妝前|散粉|蜜粉|气垫|氣墊/.test(q)
  ) {
    return 'base_makeup';
  }
  if (
    /\b(eyeshadow|eye\s*shadow|mascara|eyeliner|brow|eyebrow)\b/i.test(q) ||
    /眼影|睫毛膏|眼线|眼線|眉笔|眉筆|眉粉/.test(q)
  ) {
    return 'eye_makeup';
  }
  if (hasLipCareSignal) {
    return 'lip_care';
  }
  if (
    /\b(lipstick|lip\s*tint|lip\s*gloss|lip\s*liner|lip)\b/i.test(q) ||
    /口红|口紅|唇膏|唇彩|唇釉/.test(q)
  ) {
    return 'lip_makeup';
  }
  if (
    /\b(skincare|skin care|serum|toner|essence|ampoule|moisturi(?:z|s)er|cream|cleanser|sunscreen|spf\b|sunblock|face wash|mask)\b/i.test(
      q,
    ) ||
    /护肤|護膚|精华|精華|化妆水|化妝水|乳液|面霜|洁面|潔面|防晒|防曬|日焼け止め|美容液|洗顔料|クリーム/.test(
      q,
    )
  ) {
    return 'skincare';
  }
  if (
    /\b(makeup|cosmetic|cosmetics|beauty)\b/i.test(q) ||
    /化妆|化妝|美妆|美妝|彩妆|彩妝|约会妆|約會妝/.test(q)
  ) {
    return 'general';
  }
  return 'other';
}

function detectBeautyQueryBucket(queryText) {
  const bucket = classifyBeautyBucketFromText(queryText);
  if (
    bucket === 'skincare' ||
    bucket === 'tools' ||
    bucket === 'fragrance' ||
    bucket === 'haircare' ||
    bucket === 'lip_care' ||
    bucket === 'bodycare'
  ) {
    return bucket;
  }
  if (
    bucket === 'general' ||
    bucket === 'base_makeup' ||
    bucket === 'eye_makeup' ||
    bucket === 'lip_makeup'
  ) {
    return bucket;
  }
  return null;
}

function isBeautyBucketCompatibleForQuery(candidateBucket, queryBucket) {
  const bucket = String(candidateBucket || 'other');
  const query = String(queryBucket || '');
  if (!query) return bucket !== 'other';
  if (query === 'skincare') return bucket === 'skincare';
  if (query === 'tools') return bucket === 'tools';
  if (query === 'fragrance') return bucket === 'fragrance';
  if (query === 'haircare') return bucket === 'haircare';
  if (query === 'lip_care') return bucket === 'lip_care';
  if (query === 'bodycare') return bucket === 'bodycare';
  if (query === 'base_makeup') return bucket === 'base_makeup';
  if (query === 'eye_makeup') return bucket === 'eye_makeup';
  if (query === 'lip_makeup') return bucket === 'lip_makeup' || bucket === 'lip_care';
  if (query === 'general') {
    return (
      bucket === 'base_makeup' ||
      bucket === 'eye_makeup' ||
      bucket === 'lip_makeup' ||
      bucket === 'lip_care' ||
      bucket === 'skincare' ||
      bucket === 'fragrance' ||
      bucket === 'haircare' ||
      bucket === 'bodycare'
    );
  }
  return bucket !== 'other';
}

function buildBeautyQueryProfile({ rawQuery, queryClass, intent } = {}) {
  const normalizedQueryClass = normalizeBeautyQueryClass(queryClass || intent?.query_class);
  const primaryDomain = String(intent?.primary_domain || '').trim().toLowerCase();
  const scenario = String(intent?.scenario?.name || '').trim().toLowerCase();
  const bucket = detectBeautyQueryBucket(rawQuery);
  const concernClass = inferBeautyConcernClass(rawQuery, bucket);
  const isBeautyQuery = primaryDomain === 'beauty' || bucket != null;
  const isSpecificBeautyQuery =
    isBeautyQuery &&
    [
      'skincare',
      'tools',
      'fragrance',
      'haircare',
      'lip_care',
      'bodycare',
      'base_makeup',
      'eye_makeup',
      'lip_makeup',
    ].includes(String(bucket || ''));
  const allowBroadBeautyExpansion = Boolean(isBeautyQuery && bucket === 'general');
  const allowBeautyDiversity = Boolean(
    isBeautyQuery &&
      bucket === 'general' &&
      !['lookup', 'attribute'].includes(String(normalizedQueryClass || '')) &&
      scenario !== 'beauty_tools' &&
      scenario !== 'eye_shadow_brush'
  );

  return {
    bucket,
    isBeautyQuery,
    isSpecificBeautyQuery,
    allowBroadBeautyExpansion,
    allowBeautyDiversity,
    queryClass: normalizedQueryClass,
    scenario: scenario || null,
    concernClass,
    rawQuery,
  };
}

function getBeautyCacheExpansionTerms(profile) {
  const bucket = String(profile?.bucket || '');
  if (bucket === 'skincare') {
    const rawQuery = String(profile?.rawQuery || '').trim().toLowerCase();
    const genericSerumQuery =
      /\bserum\b/.test(rawQuery) &&
      !/\b(toner|mist|cleanser|wash|sunscreen|spf|cream|moisturi[sz]er|lotion)\b/.test(rawQuery);
    return genericSerumQuery
      ? [
          'serum',
          'niacinamide',
          'vitamin c',
          'hyaluronic',
          'hyaluronate',
          'retinol',
          'peptide',
          'dark spot',
        ]
      : ['skincare', 'serum', 'toner', 'moisturizer', 'sunscreen', 'cleanser', 'cream'];
  }
  if (bucket === 'tools') {
    return ['makeup', 'cosmetic', 'beauty', 'brush', 'sponge', 'puff', 'applicator'];
  }
  if (bucket === 'fragrance') {
    return ['perfume', 'fragrance', 'parfum', 'cologne', 'body mist', 'eau de parfum'];
  }
  if (bucket === 'haircare') {
    return ['haircare', 'hair care', 'shampoo', 'conditioner', 'hair oil', 'hair mask', 'scalp'];
  }
  if (bucket === 'lip_care') {
    return ['lip balm', 'lip oil', 'lip treatment', 'lip mask', 'lip care'];
  }
  if (bucket === 'bodycare') {
    return ['body wash', 'body cleanser', 'shower gel', 'body lotion', 'body cream'];
  }
  if (bucket === 'base_makeup') {
    return ['foundation', 'concealer', 'primer', 'powder', 'skin tint', 'bb cream', 'cc cream'];
  }
  if (bucket === 'eye_makeup') {
    return ['mascara', 'eyeliner', 'eyeshadow', 'eye shadow', 'brow', 'eyebrow'];
  }
  if (bucket === 'lip_makeup') {
    return ['lipstick', 'lip tint', 'lip gloss', 'lip liner', 'lip'];
  }
  if (profile?.allowBroadBeautyExpansion) {
    return [
      'makeup',
      'cosmetic',
      'beauty',
      'foundation',
      'concealer',
      'lipstick',
      'blush',
      'mascara',
      'eyeshadow',
      'brush',
      'palette',
      'fenty',
      'tom ford',
    ];
  }
  return [];
}

module.exports = {
  buildBeautyQueryProfile,
  classifyBeautyBucketFromText,
  detectBeautyQueryBucket,
  inferBeautyConcernClass,
  getBeautyCacheExpansionTerms,
  isBeautyBucketCompatibleForQuery,
};
