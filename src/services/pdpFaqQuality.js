function normalizeText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSurface(value) {
  return normalizeText(value).toLowerCase();
}

function hasSiteSupportUrl(value) {
  const text = normalizeText(value);
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return /(?:^|\/)(?:faq|faqs|help|customer-service|customer-care|contact-us|store-locator|shipping|returns?)(?:\/|$)/i.test(
      parsed.pathname,
    );
  } catch {
    return /\b(?:faq|faqs|help|customer service|customer care|contact us|store locator|shipping|returns?)\b/i.test(text);
  }
}

const SUPPORT_NAVIGATION_PATTERN =
  /\b(?:track my order|order status|shipping(?:\s*&\s*returns)?|returns?|exchanges?|refunds?|store locator|contact us|customer service|customer care|services|my account|sign in|privacy policy|terms of (?:use|service)|accessibility|gift cards?|delivery|payment methods?)\b/i;

const PRODUCT_USAGE_PATTERN =
  /\b(?:use|apply|wear|layer|pair|mix|shade|color|tone|finish|coverage|texture|scent|fragrance|formula|ingredient|inci|active|spf|sunscreen|retinol|vitamin|niacinamide|hyaluronic|sensitive|oily|dry|acne|blemish|skin|hair|lash|lip|eye|face|body|waterproof|non[-\s]?comedogenic|vegan|cruelty[-\s]?free|pregnan|breastfeed|morning|night|daily|often|long does it last)\b/i;

function isDisplayablePdpFaqItem(item = {}) {
  const question = normalizeText(item.question);
  const answer = normalizeText(item.answer);
  if (!question || !answer) return false;

  const combined = `${question} ${answer}`;
  const questionSurface = normalizeSurface(question);
  const answerSurface = normalizeSurface(answer);
  const combinedSurface = normalizeSurface(combined);
  const sourceUrl = item.source_url || item.sourceUrl;
  const sourceTitle = item.source_title || item.sourceTitle;

  if (hasSiteSupportUrl(sourceUrl) || hasSiteSupportUrl(sourceTitle)) return false;

  const supportSignals = [
    SUPPORT_NAVIGATION_PATTERN.test(questionSurface),
    SUPPORT_NAVIGATION_PATTERN.test(answerSurface),
    /\b(?:need help|help center|help centre|faq|faqs)\b/i.test(questionSurface),
    /^(?:need help|help|faqs?|questions?)\??(?:\s+need help\?)?$/i.test(questionSurface),
  ].filter(Boolean).length;
  const productSignals = PRODUCT_USAGE_PATTERN.test(combinedSurface);

  if (supportSignals >= 2 && !productSignals) return false;
  if (supportSignals >= 1 && !productSignals && answer.length < 220) return false;
  if (/\b(?:track my order|store locator|contact us)\b/i.test(answerSurface) && !productSignals) return false;

  return true;
}

module.exports = {
  isDisplayablePdpFaqItem,
  normalizeText,
};
