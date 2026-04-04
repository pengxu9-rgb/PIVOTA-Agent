const ABSOLUTE_HTTP_URL_RE = /^https?:\/\//i;
const SHOPIFY_FILE_HASH_SUFFIX_RE =
  /^(.*?_[0-9]+)_(?:[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}|[0-9a-f-]{16,})\.(avif|gif|jpe?g|png|webp)$/i;

function isAbsoluteHttpUrl(value) {
  return ABSOLUTE_HTTP_URL_RE.test(String(value || '').trim());
}

function isKnownHost(hostname, candidates) {
  const normalizedHost = String(hostname || '').trim().toLowerCase();
  if (!normalizedHost) return false;
  return candidates.some((host) => normalizedHost === host || normalizedHost.endsWith(`.${host}`));
}

function isShopifyLikeAsset(parsed) {
  const pathname = String(parsed?.pathname || '').toLowerCase();
  return (
    isKnownHost(parsed?.hostname, ['cdn.shopify.com', 'shopifycdn.com', 'sdcdn.io']) ||
    pathname.includes('/cdn/shop/files/') ||
    pathname.includes('/s/files/')
  );
}

function normalizeShopifyLikeFilename(filename) {
  const trimmed = String(filename || '').trim();
  if (!trimmed) return trimmed;
  const matched = trimmed.match(SHOPIFY_FILE_HASH_SUFFIX_RE);
  if (matched) {
    return `${matched[1]}.${matched[2]}`;
  }
  return trimmed;
}

function normalizePdpImageUrl(value) {
  const raw = String(value || '').trim();
  if (!isAbsoluteHttpUrl(raw)) return '';

  try {
    const parsed = new URL(raw);
    if (isShopifyLikeAsset(parsed)) {
      parsed.searchParams.delete('v');
      const segments = parsed.pathname.split('/');
      const lastIndex = segments.length - 1;
      segments[lastIndex] = normalizeShopifyLikeFilename(segments[lastIndex] || '');
      parsed.pathname = segments.join('/');
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizePdpImageUrls(values) {
  const seen = new Set();
  const out = [];

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizePdpImageUrl(
      typeof value === 'string' ? value : value?.url || value?.src || value?.image_url,
    );
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

module.exports = {
  normalizePdpImageUrl,
  normalizePdpImageUrls,
};
