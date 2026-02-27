function normalizeText(value) {
  return String(value || '').trim();
}

function looksLikeChineseText(text) {
  return /[\u3400-\u9fff]/.test(normalizeText(text));
}

function detectLanguageFromText(text) {
  return looksLikeChineseText(text) ? 'CN' : 'EN';
}

function hasAny(text, patterns) {
  const raw = normalizeText(text);
  if (!raw) return false;
  return patterns.some((re) => re.test(raw));
}

const RECO_PRODUCT_CUES = [
  /\b(product|products|routine|plan|cleanser|serum|moisturizer|sunscreen|toner|spf)\b/i,
  /(产品|护肤品|方案|流程|精华|面霜|乳液|防晒|洁面|洗面奶|化妆水)/,
];

const INGREDIENT_SCIENCE_CUES = [
  /\b(ingredient|ingredients|active|actives)\b.{0,28}\b(science|evidence|mechanism|clinical|study|paper|research)\b/i,
  /\b(science|evidence|mechanism|clinical|study|paper|research)\b.{0,28}\b(ingredient|ingredients|active|actives)\b/i,
  /\b(mechanism of|how does)\b.{0,28}\b(niacinamide|retinol|retinoid|salicylic|aha|bha|vitamin c|azelaic|peptide)\b/i,
  /(成分(机理|机制|科学|证据|原理)|证据链|循证|临床证据|论文证据|机理是什么|机制是什么)/,
];

const RECOMMENDATION_CUES = [
  /\brecommend(?:ation|ations)?\b/i,
  /\bsuggest(?:ion|ions)?\b/i,
  /\bwhat should i (buy|use)\b/i,
  /\bgive me (a )?(plan|routine)\b/i,
  /\bbuild (me )?(an )?(am\/?pm )?(routine|plan)\b/i,
  /\breview my (current )?routine\b/i,
  /\bi (want|need|would like|wanna) to (buy|use|get)\b.{0,60}\b(cleanser|serum|moisturizer|sunscreen|toner|routine|product|products|plan)\b/i,
  /\bhelp me (choose|pick)\b/i,
  /\bbest\b.{0,20}\b(cleanser|serum|moisturizer|sunscreen|toner)\b/i,
  /推荐/,
  /产品推荐/,
  /给我方案/,
  /评估我现在用的/,
  /(想要|想买|要|求|求推荐|求推).*(精华|面霜|乳液|面膜|防晒|洁面|洗面奶|爽肤水|化妆水|护肤品|产品|平替|替代)/,
  /(怎么买|购买|下单|链接)/,
];

const SUITABILITY_CUES = [
  /\bis (this|it).{0,40}\b(good|okay|safe|suitable|right)\b/i,
  /\bcan i use\b/i,
  /\bdoes this (suit|work for)\b/i,
  /\bwill this (irritate|break me out|suit me)\b/i,
  /\bfit\s*check\b/i,
  /\bsuitable\b/i,
  /(适合吗|适不适合|适合我吗|是否适合|适合不适合|合适吗|适配吗|能用吗|可以用吗|刺激吗|爆痘吗)/,
  /(评估|测评|评价)\s*[:：]\s*[^\s]{3,}/,
];

const ROUTINE_REVIEW_CUES = [
  /\breview my (current )?routine\b/i,
  /\bevaluate my (current )?routine\b/i,
  /\bcheck my (current )?routine\b/i,
  /评估我现在用的/,
  /看看我现在(在)?用的/,
];

const DIAGNOSIS_CUES_EN = [
  /\b(start|begin|run)\b.{0,40}\b(skin\s*)?(diagnos(?:e|is)?|analys(?:e|is)|analyz(?:e)?|assessment|scan|check)\b/i,
  /\b(diagnos(?:e|is)?|analys(?:e|is)|analyz(?:e)?|assessment|scan|check)\b.{0,40}\bmy\s*(skin|face)\b/i,
  /\b(skin|face)\b.{0,40}\b(diagnos(?:e|is)?|analys(?:e|is)|analyz(?:e)?|assessment|scan|check)\b/i,
  /\bskin\s*profile\b/i,
];

function isIngredientScienceLikeText(text) {
  return hasAny(text, INGREDIENT_SCIENCE_CUES);
}

function hasProductCue(text) {
  return hasAny(text, RECO_PRODUCT_CUES);
}

function isRecommendationLikeText(text) {
  const raw = normalizeText(text);
  if (!raw) return false;

  const scienceOnlyIntent = isIngredientScienceLikeText(raw);
  const askingProducts = hasProductCue(raw) || hasAny(raw, RECOMMENDATION_CUES);
  if (scienceOnlyIntent && !askingProducts) return false;

  return (
    hasAny(raw, RECOMMENDATION_CUES) ||
    /\b(anti[-\s]?aging|anti[-\s]?age|wrinkles?|fine lines?|firming|dark spots?|hyperpigmentation|acne|pores?|redness)\b/i.test(raw) ||
    /(抗老|抗衰|抗皱|细纹|淡纹|紧致|提拉|痘痘|闭口|毛孔|泛红|暗沉|色沉|痘印|色斑)/.test(raw) ||
    /\bam\b/i.test(raw) ||
    /\bpm\b/i.test(raw)
  );
}

function isSuitabilityLikeText(text) {
  return hasAny(text, SUITABILITY_CUES);
}

function isRoutineReviewLikeText(text) {
  return hasAny(text, ROUTINE_REVIEW_CUES);
}

function isDiagnosisStartLikeText(text) {
  const raw = normalizeText(text);
  if (!raw) return false;
  if (hasAny(raw, DIAGNOSIS_CUES_EN)) return true;

  const hasSkinCN = /(皮肤|肤质|肤况|面部|脸部|脸)/.test(raw);
  const hasDiagnosisCN = /(诊断|分析|检测|评估|测一测|测试)/.test(raw);
  return hasSkinCN && hasDiagnosisCN;
}

function isExplicitCompatibilityLikeText(text) {
  const raw = normalizeText(text);
  if (!raw) return false;
  return /(\b(conflict|compatible|pair|layer|mix|combine)\b|冲突|相克|兼容|叠加|同晚|一起用|能不能一起|还能和|搭配|同用)/i.test(raw);
}

function isExplicitTextTrigger(text) {
  return (
    isRecommendationLikeText(text) ||
    isSuitabilityLikeText(text) ||
    isRoutineReviewLikeText(text) ||
    isDiagnosisStartLikeText(text) ||
    isExplicitCompatibilityLikeText(text)
  );
}

module.exports = {
  detectLanguageFromText,
  looksLikeChineseText,
  isIngredientScienceLikeText,
  isRecommendationLikeText,
  isSuitabilityLikeText,
  isRoutineReviewLikeText,
  isDiagnosisStartLikeText,
  isExplicitCompatibilityLikeText,
  isExplicitTextTrigger,
};
