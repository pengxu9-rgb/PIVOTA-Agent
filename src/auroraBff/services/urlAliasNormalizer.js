'use strict';

const URL_ALIAS_FIELDS = ['original_url', 'anchor_product_url', 'url', 'product_url'];

/**
 * Resolves the canonical product URL from multiple possible alias fields.
 * Returns the first non-empty trimmed string and records which alias was consumed.
 */
function normalizeProductUrlInput(input) {
  const bag = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const field of URL_ALIAS_FIELDS) {
    const raw = bag[field];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed) return { canonical_url: trimmed, source_field: field };
    }
  }
  return { canonical_url: '', source_field: null };
}

/**
 * Builds a guaranteed-non-null original stub when no product object is available.
 * Mirrors the existing `buildOriginalStub` in routes.js but is importable.
 */
function buildOriginalStubPortable(url, inputText) {
  const urlStr = typeof url === 'string' ? url.trim() : '';
  const textStr = typeof inputText === 'string' ? inputText.trim() : '';
  const nameGuess = textStr || (urlStr ? urlStr.split('/').filter(Boolean).pop() || '' : '');
  return {
    _stub: true,
    url: urlStr || null,
    name: nameGuess || null,
    name_guess: nameGuess || null,
    anchor_resolution_status: 'failed',
    anchor_resolution_reason: urlStr ? 'url_resolution_failed' : 'no_product_object',
  };
}

/**
 * Ensures a product-like object is never null.
 * If `obj` is a valid plain object it is returned as-is; otherwise a stub is created.
 */
function ensureOriginalNonNull(obj, url, inputText) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  return buildOriginalStubPortable(url, inputText);
}

module.exports = {
  URL_ALIAS_FIELDS,
  normalizeProductUrlInput,
  buildOriginalStubPortable,
  ensureOriginalNonNull,
};
