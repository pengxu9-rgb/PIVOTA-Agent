function normalizeBannerText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function countMatches(value, pattern) {
  return (String(value || '').match(pattern) || []).length;
}

function isUppercaseDominantBanner(value) {
  const normalized = normalizeBannerText(value);
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

  const tokens = Array.from(normalized.matchAll(/\S+/g));
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
    const leadingPrefix = normalized.slice(0, bodyStartIndex).trim();
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
