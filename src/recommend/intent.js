const { normalizeText } = require('./textUtils');

const OOS_PATTERNS = [
  /\bout of stock\b/,
  /\bout-of-stock\b/,
  /\boos\b/,
  /\bback in stock\b/,
  /\bbackinstock\b/,
  /\brestock\b/,
  /\brestocking\b/,
  /\bnotify\b/,
  /\bnotify me\b/,
  /\balert me\b/,
  /\bwhen (it'?s )?back\b/,
  /\bbackorder\b/,
  /\bpreorder\b/,
  /\bwaitlist\b/,
  /\bshow me (oos|out of stock)\b/,
  /\bany availability\b/,
  /\bincluding oos\b/,
  /\boos is fine\b/,
  /\ballow oos\b/,
  /\bshow oos\b/,
];

function detectAllowOOS(message, answered_slots = {}) {
  if (answered_slots && answered_slots.allow_oos === true) return true;
  const m = normalizeText(message);
  if (!m) return false;
  return OOS_PATTERNS.some((re) => re.test(m));
}

const BEAUTY_PATTERNS = [
  // English
  /\bmakeup\b/,
  /\bcosmetic(s)?\b/,
  /\bskincare\b/,
  /\bfoundation\b/,
  /\bconcealer\b/,
  /\bpowder\b/,
  /\bblush\b/,
  /\bbronzer\b/,
  /\bhighlighter\b/,
  /\bcontour\b/,
  /\beyeshadow\b/,
  /\beyeliner\b/,
  /\bmascara\b/,
  /\blip(stick|gloss)?\b/,
  /\bbrush(es)?\b/,
  // Japanese
  /メイク/,
  /化粧/,
  /コスメ/,
  /ファンデ/,
  /パウダー/,
  /チーク/,
  /アイシャドウ/,
  /アイライン/,
  /マスカラ/,
  /リップ/,
  /ハイライト/,
  /シェーディング/,
  /ブラシ/,
  // Chinese
  /化妆/,
  /彩妆/,
  /美妆/,
  /粉底/,
  /遮瑕/,
  /散粉/,
  /粉饼/,
  /腮红/,
  /眼影/,
  /眼线/,
  /睫毛膏/,
  /口红/,
  /高光/,
  /修容/,
  /化妆刷/,
  /刷子/,
  /刷/,
  // Spanish
  /\bmaquillaje\b/,
  /\bcosm[eé]tica(s)?\b/,
  /\bcuidado de la piel\b/,
  /\bbrocha(s)?\b/,
  /\bpincel(es)?\b/,
  // French
  /\bmaquillage\b/,
  /\bcosm[eé]tique(s)?\b/,
  /\bsoin(s)? de la peau\b/,
  /\bpinceau(x)?\b/,
];

function detectBeautyIntent(message) {
  const m = normalizeText(message);
  if (!m) return false;
  return BEAUTY_PATTERNS.some((re) => re.test(m));
}

module.exports = {
  detectAllowOOS,
  detectBeautyIntent,
};
