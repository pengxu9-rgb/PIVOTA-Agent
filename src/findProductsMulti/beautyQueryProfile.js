function normalizeBeautyQueryClass(queryClass) {
  return String(queryClass || '').trim().toLowerCase() || null;
}

function classifyBeautyBucketFromText(text) {
  const q = String(text || '');
  if (!q) return 'other';

  const hasSkincareTreatmentSignal =
    /\b(serum|toner|essence|ampoule|moisturi(?:z|s)er|cleanser|sunscreen|spf\b|sunblock|face wash|niacinamide|retinol|vitamin c|peptide|ceramide|cica|hyaluronic|salicylic|azelaic|aha|bha)\b/i.test(
      q,
    ) ||
    /护肤|護膚|精华|精華|化妆水|化妝水|乳液|洁面|潔面|防晒|防曬|日焼け止め|美容液|洗顔料/.test(
      q,
    );

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
  if (
    /\b(lipstick|lip\s*tint|lip\s*gloss|lip\s*balm|lip\s*liner|lip)\b/i.test(q) ||
    /口红|口紅|唇膏|唇彩|唇釉|润唇|潤唇/.test(q)
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
  if (bucket === 'skincare' || bucket === 'tools' || bucket === 'fragrance') return bucket;
  if (
    bucket === 'general' ||
    bucket === 'base_makeup' ||
    bucket === 'eye_makeup' ||
    bucket === 'lip_makeup'
  ) {
    return 'general';
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
  if (query === 'general') {
    return (
      bucket === 'base_makeup' ||
      bucket === 'eye_makeup' ||
      bucket === 'lip_makeup' ||
      bucket === 'skincare' ||
      bucket === 'fragrance'
    );
  }
  return bucket !== 'other';
}

function buildBeautyQueryProfile({ rawQuery, queryClass, intent } = {}) {
  const normalizedQueryClass = normalizeBeautyQueryClass(queryClass || intent?.query_class);
  const primaryDomain = String(intent?.primary_domain || '').trim().toLowerCase();
  const scenario = String(intent?.scenario?.name || '').trim().toLowerCase();
  const bucket = detectBeautyQueryBucket(rawQuery);
  const isBeautyQuery = primaryDomain === 'beauty' || bucket != null;
  const isSpecificBeautyQuery =
    isBeautyQuery && ['skincare', 'tools', 'fragrance'].includes(String(bucket || ''));
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
  };
}

function getBeautyCacheExpansionTerms(profile) {
  const bucket = String(profile?.bucket || '');
  if (bucket === 'skincare') {
    return ['skincare', 'serum', 'toner', 'moisturizer', 'sunscreen', 'cleanser', 'cream'];
  }
  if (bucket === 'tools') {
    return ['makeup', 'cosmetic', 'beauty', 'brush', 'sponge', 'puff', 'applicator'];
  }
  if (bucket === 'fragrance') {
    return ['perfume', 'fragrance', 'parfum', 'cologne', 'body mist', 'eau de parfum'];
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
  getBeautyCacheExpansionTerms,
  isBeautyBucketCompatibleForQuery,
};
