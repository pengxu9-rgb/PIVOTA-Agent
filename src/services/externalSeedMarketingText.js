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
  const scanWindow = normalized.length > BANNER_SCAN_LIMIT
    ? normalized.slice(0, BANNER_SCAN_LIMIT)
    : normalized;
  // A cut final token keeps the real word's start index, so it is still a valid
  // boundary; truncation can only hide a lowercase letter and make us miss a
  // banner, never invent one.
  const tokens = Array.from(scanWindow.matchAll(/\S+/g));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const tokenValue = String(token[0] || '');
    if (!/[a-z]/.test(tokenValue)) continue;
    const tokenIndex = token.index || 0;
    const previousToken = index > 0 ? String(tokens[index - 1][0] || '') : '';
    const bodyStartIndex =
      /^(?:A|An)$/i.test(previousToken) && Number.isInteger(tokens[index - 1]?.index)
        ? tokens[index - 1].index
        : tokenIndex;
    // Prefix from the bounded window (identical bytes, bounded cost); body from
    // the full text, because the body is what gets returned.
    const leadingPrefix = scanWindow.slice(0, bodyStartIndex).trim();
    const leadingBody = normalized.slice(bodyStartIndex).trim();
    if (!leadingPrefix || !leadingBody) continue;
    if (leadingPrefix.split(/\s+/).length < 6) continue;
    if (!isUppercaseDominantBanner(leadingPrefix)) continue;
    if (leadingBody.length < 24) continue;
    return leadingBody;
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
