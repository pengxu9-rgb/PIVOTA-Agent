// A marketing banner sits at the head of the text. 1000 characters is far past
// any real one and keeps the scan O(1) in the length of the description.
const BANNER_SCAN_LIMIT = 1000;

function normalizeBannerText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function countMatches(value, pattern) {
  return (String(value || '').match(pattern) || []).length;
}

// The banner test on precomputed numbers, for a string that is already normalised.
function isUppercaseDominantCounts(length, uppercaseMatches, lowercaseMatches) {
  return (
    length >= 24 &&
    uppercaseMatches >= 10 &&
    uppercaseMatches >= Math.max(3, lowercaseMatches * 3)
  );
}

function isUppercaseDominantBanner(value) {
  const raw = String(value || '');
  // Normalising only ever collapses whitespace and trims, so it can only shrink.
  // A raw string already under the bar can never clear it — check before paying
  // for a full-string rewrite that the caller runs once per token.
  if (raw.length < 24) return false;
  const normalized = normalizeBannerText(raw);
  if (normalized.length < 24) return false;
  const uppercaseMatches = countMatches(normalized, /[A-Z]/g);
  const lowercaseMatches = countMatches(normalized, /[a-z]/g);
  return (
    uppercaseMatches >= 10 &&
    uppercaseMatches >= Math.max(3, lowercaseMatches * 3)
  );
}

function stripExternalSeedMarketingBannerPrefix(value) {
  const normalized = normalizeBannerText(value);
  if (!normalized) return '';

  const leadingColonIndex = normalized.indexOf(':');
  if (leadingColonIndex > 0 && leadingColonIndex <= 160) {
    const leadingPrefix = normalized.slice(0, leadingColonIndex).trim();
    const leadingBody = normalized.slice(leadingColonIndex + 1).trim();
    const marketingPrefix =
      /\b(straight up|the lowdown|what else|the #s don't lie)\b/i.test(leadingPrefix) ||
      isUppercaseDominantBanner(leadingPrefix);
    if (marketingPrefix && /^[A-Z0-9][\s\S]{12,}$/.test(leadingBody)) {
      return leadingBody;
    }
  }

  // This function strips a LEADING banner, so only a boundary near the start can
  // ever be returned. Scanning every token was quadratic: each one re-sliced,
  // re-split and re-scanned the prefix, so a 52KB description cost ~2.4s of
  // synchronous work — and these rows average 56KB. Measured 2026-09-09 as the
  // ~5-6s event-loop block behind the aurora recall stalls.
  //
  // The bound alone is not safe: a banner is only a banner if some LOWERCASE
  // token follows it, and a leading all-caps INCI list can run past the limit.
  // Stopping there leaves the text opening with "INGREDIENTS", which the cut
  // patterns in `stripRecallNarrativeNoise` then match at index 0 and drop the
  // WHOLE FIELD -- turning "banner not stripped" into "no recall text at all".
  // 5 of 10,136 active rows have a leading no-lowercase run over the limit.
  //
  // So extend the window just far enough to cover the first lowercase-bearing
  // token. That costs one extra linear scan and stays linear overall: every
  // all-caps token before it is rejected by the cheap `/[a-z]/` test, so only
  // that one token ever pays for the prefix passes.
  const firstLowercaseIndex = normalized.search(/[a-z]/);
  let scanLimit = BANNER_SCAN_LIMIT;
  if (firstLowercaseIndex >= scanLimit) {
    const tokenEnd = normalized.indexOf(' ', firstLowercaseIndex);
    scanLimit = tokenEnd === -1 ? normalized.length : tokenEnd;
  }
  const scanWindow = normalized.length > scanLimit
    ? normalized.slice(0, scanLimit)
    : normalized;
  // A cut final token keeps the real word's start index, so it is still a valid
  // boundary; truncation can only hide a lowercase letter and make us miss a
  // banner, never invent one.
  const tokens = Array.from(scanWindow.matchAll(/\S+/g));
  // Every candidate boundary used to re-slice the prefix before it, re-normalise it, split it, and
  // count its upper- and lowercase letters with two global regexes: quadratic in the window, and run
  // for every recall block of every seed. On a brand page that fetched ~200 seeds it was ~0.9s of
  // synchronous CPU per request (prod CPU profile, 2026-09-17: Fenty Beauty 1,692ms wall, 883ms here).
  //
  // The checks only ever need four numbers about the prefix, and the boundary only moves forward, so
  // they are accumulated in one pass. Each is the old expression, exactly, because `normalized`
  // (and so the window) has no leading or trailing space and exactly one space between tokens:
  //   leadingPrefix            = window.slice(0, b - 1): non-empty whenever b > 0
  //   leadingBody              = normalized.slice(b):    never empty, length normalized.length - b
  //   leadingPrefix split count = the number of tokens that start before b
  //   isUppercaseDominantBanner(leadingPrefix) = the same 24-char floor and letter counts over [0, b)
  let countedTo = 0;
  let uppercaseBefore = 0;
  let lowercaseBefore = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const tokenValue = String(token[0] || '');
    if (!/[a-z]/.test(tokenValue)) continue;
    const tokenIndex = token.index || 0;
    const previousToken = index > 0 ? String(tokens[index - 1][0] || '') : '';
    const startsAtArticle =
      /^(?:A|An)$/i.test(previousToken) && Number.isInteger(tokens[index - 1]?.index);
    const bodyStartIndex = startsAtArticle ? tokens[index - 1].index : tokenIndex;
    // bodyStartIndex never moves backwards: it is this token or the one before, and the previous
    // candidate's was at most the previous token.
    for (; countedTo < bodyStartIndex; countedTo += 1) {
      const code = scanWindow.charCodeAt(countedTo);
      if (code >= 65 && code <= 90) uppercaseBefore += 1;
      else if (code >= 97 && code <= 122) lowercaseBefore += 1;
    }
    if (bodyStartIndex <= 0) continue;
    const tokensBefore = startsAtArticle ? index - 1 : index;
    if (tokensBefore < 6) continue;
    const prefixLength = bodyStartIndex - 1;
    if (!isUppercaseDominantCounts(prefixLength, uppercaseBefore, lowercaseBefore)) continue;
    const bodyLength = normalized.length - bodyStartIndex;
    if (bodyLength < 24) continue;
    return normalized.slice(bodyStartIndex);
  }

  return normalized;
}

function hasExternalSeedMarketingBannerPrefix(value) {
  const normalized = normalizeBannerText(value);
  if (!normalized) return false;
  return stripExternalSeedMarketingBannerPrefix(normalized) !== normalized;
}

module.exports = {
  hasExternalSeedMarketingBannerPrefix,
  isUppercaseDominantBanner,
  normalizeBannerText,
  stripExternalSeedMarketingBannerPrefix,
};
