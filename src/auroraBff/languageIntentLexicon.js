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

// `cream`, `lotion`, `balm`, `essence` and the British `moisturiser` were missing here while their Chinese
// equivalents (面霜, 乳液) were already listed, so "barrier cream" carried no product cue at all. `repair` earns
// its place the same way — "barrier repair" is a shelf category, not a verb, in "best barrier repair for
// sensitive skin". The gap only became visible once `barrier` stopped being a bare reco cue on its own.
const RECO_PRODUCT_CUES = [
  /\b(product|products|routine|plan|cleanser|serum|moisturizer|moisturiser|sunscreen|toner|spf|cream|creams|lotion|lotions|balm|essence|repair)\b/i,
  /(产品|护肤品|方案|流程|精华|面霜|乳液|防晒|洁面|洗面奶|化妆水)/,
];

const INGREDIENT_SCIENCE_CUES = [
  /\b(ingredient|ingredients|active|actives)\b.{0,28}\b(science|evidence|mechanism|clinical|study|paper|research)\b/i,
  /\b(science|evidence|mechanism|clinical|study|paper|research)\b.{0,28}\b(ingredient|ingredients|active|actives)\b/i,
  /\b(mechanism of|how does)\b.{0,28}\b(niacinamide|retinol|retinoid|salicylic|aha|bha|vitamin c|azelaic|peptide)\b/i,
  // "what ingredient is best for acne?" — asking WHICH ingredient is an ingredient question, even though the
  // concern it names is also a reco cue. Without this it matched `acne` as a bare concern, entered the product
  // funnel, and answered "I need a bit more context before narrowing products: skin_type" — slot-filling for a
  // question that was never about a product.
  //
  // This cue is deliberately blind to purchase intent, because `isRecommendationLikeText` is what weighs the
  // two: it only honours a science reading when nothing else in the text asks for products, and `askingProducts`
  // there counts the transactional verbs as asking. That matters — "what actives should I BUY for acne?" names
  // an active and a purchase, and it is a product ask.
  /\b(what|which)\b.{0,24}\b(ingredient|ingredients|active|actives)\b/i,
  /(成分(机理|机制|科学|证据|原理)|证据链|循证|临床证据|论文证据|机理是什么|机制是什么)/,
];

const RECOMMENDATION_CUES = [
  /\brecommend(?:ation|ations)?\b/i,
  /\bsuggest(?:ion|ions)?\b/i,
  /\bwhat should i (buy|use)\b/i,
  /\bwhat should i add\b/i,
  /\b(what|which|best)\b.{0,24}\b(cleanser|serum|moisturizer|sunscreen|toner|mask)\b/i,
  /\b(cleanser|serum|moisturizer|sunscreen|toner|mask)\b.{0,24}\bfor\b.{0,24}\b(oily|dry|combination|combo|sensitive|acne|redness|pores|dehydrat|aging|dull|blackheads?|clogged|stinging|peeling|barrier|irritat)/i,
  /\bgive me (a )?(plan|routine)\b/i,
  /\bbuild (me )?(an )?(am\/?pm )?(routine|plan)\b/i,
  /\breview my (current )?routine\b/i,
  /\bi (want|need|would like|wanna) to (buy|use|get)\b.{0,60}\b(cleanser|serum|moisturizer|sunscreen|toner|routine|product|products|plan)\b/i,
  /\bhelp me (choose|pick)\b/i,
  /\bbest\b.{0,20}\b(cleanser|serum|moisturizer|sunscreen|toner)\b/i,
  /推荐/,
  /(什么|哪种|哪款).{0,12}(洁面|洗面奶|精华|面霜|乳液|防晒|面膜|爽肤水|化妆水)/,
  /产品推荐/,
  /给我方案/,
  /评估我现在用的/,
  /(洁面|洗面奶|精华|面霜|乳液|防晒|面膜|爽肤水|化妆水).{0,16}(适合|给|for).{0,16}(油皮|干皮|混合皮|敏感肌|痘肌|泛红)/,
  /(想要|想买|要|求|求推荐|求推).*(精华|面霜|乳液|面膜|防晒|洁面|洗面奶|爽肤水|化妆水|护肤品|产品|平替|替代)/,
  /(怎么买|购买|下单|链接)/,
];

// Concerns a user names when they are shopping for a fix: durable goals, not today's symptoms. Naming one of
// these on its own is a reasonable reco signal — "acne", "dark spots", "blackheads" is how people open a
// product ask.
const CONCERN_GOAL_CUES = [
  /\b(anti[-\s]?aging|anti[-\s]?age|wrinkles?|fine lines?|firming|dark spots?|hyperpigmentation|acne|pores?|blackheads?|clogged pores?|clogged|redness|dull(?:ness)?)\b/i,
  /(抗老|抗衰|抗皱|细纹|淡纹|紧致|提拉|痘痘|闭口|毛孔|泛红|暗沉|色沉|痘印|色斑)/,
];

// Transient skin STATES. These are the words people reach for when describing what is happening to them —
// "my skin feels dry and tight lately", "I started adapalene and now it's peeling" — so a bare mention is a
// description of a problem, not a request to be sold something. They only count as reco intent alongside an
// actual product ask, which is exactly how they were introduced: every prompt that motivated adding them
// ("...looks dull. What should I add?", "...is peeling. What should I use tonight?") carries one.
//
// Listing them as bare cues instead cost real answers. "My skin feels dry and tight lately. What should I do?"
// matched on `tight`, was routed into the reco funnel as a product ask, and came back as a slot-filling stall
// — "I need a bit more context before narrowing products: skin type" — asking for a skin type the request had
// already supplied, instead of answering the question.
const CONCERN_STATE_CUES = [
  /\b(dehydrat(?:ed|ion)?|tight(?:ness)?|stinging|peeling|barrier|irritat(?:ed|ion)?)\b/i,
];

const RECO_TRANSACTIONAL_CUES = [
  /\b(buy|use|get|pick|choose|shop|try)\b/i,
  /\b(i|we)\s*(want|need|would like|wanna|am looking for|are looking for)\b/i,
  // Bare "looking for …", without the pronoun the pattern above requires — "looking for something to fix my
  // damaged barrier" is shopping language whoever the subject is.
  /\b(looking|searching)\s+for\b/i,
  /\bwhat\b.{0,24}\bproducts?\b.{0,24}\b(should i|to)\b.{0,12}\b(buy|use|get)\b/i,
  /\bwhich\b.{0,24}\b(products?|sunscreen|cleanser|serum|moisturizer|toner)\b.{0,24}\b(should i|to)\b.{0,12}\b(buy|use|get)\b/i,
  /(我|我们).{0,12}(想|要|需要).{0,20}(买|用|选).{0,20}(产品|护肤品|防晒|洁面|精华|面霜|乳液)/,
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
  // "Asking for products" has to include the transactional verbs, not just product NOUNS and the recommendation
  // phrasings. Leaving `RECO_TRANSACTIONAL_CUES` out of this made both readers below wrong in the same way:
  // "what actives should I buy for acne?" was read as a pure science question and dropped out of the reco route
  // entirely, and "I need something for my dehydrated skin" failed the state-cue test for want of a product noun.
  // Neither names a cleanser or says "recommend", and both are plainly shopping.
  const askingProducts =
    hasProductCue(raw) || hasAny(raw, RECOMMENDATION_CUES) || hasAny(raw, RECO_TRANSACTIONAL_CUES);
  if (scienceOnlyIntent && !askingProducts) return false;
  const hasTransactionalProductIntent = hasProductCue(raw) && hasAny(raw, RECO_TRANSACTIONAL_CUES);
  if (hasTransactionalProductIntent) return true;

  return (
    hasAny(raw, RECOMMENDATION_CUES) ||
    hasAny(raw, CONCERN_GOAL_CUES) ||
    (hasAny(raw, CONCERN_STATE_CUES) && askingProducts) ||
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
