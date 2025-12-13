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

module.exports = {
  detectAllowOOS,
};
