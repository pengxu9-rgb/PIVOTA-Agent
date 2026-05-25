'use strict';

const crypto = require('node:crypto');

const KEY_PREFIX = 'ck_';
const KEY_HEX_LEN = 32;
const BRAND_SUFFIX_TOKENS = new Set([
  'inc',
  'llc',
  'ltd',
  'corp',
  'co',
  'company',
]);

function normalizeBrand(brand) {
  if (typeof brand !== 'string' || !brand) return '';
  let text = brand.trim().toLowerCase();
  if (!text) return '';
  text = text.replace(/[®™]/g, '');
  text = text.replace(/\s*\((r|tm)\)\s*/gi, ' ');
  const tokens = text.split(/\s+/g).filter(Boolean);
  while (tokens.length > 0) {
    const candidate = tokens[tokens.length - 1].replace(/[.,]+$/g, '');
    if (!BRAND_SUFFIX_TOKENS.has(candidate)) break;
    tokens.pop();
  }
  return tokens.join(' ').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(title) {
  if (typeof title !== 'string' || !title) return '';
  let text = title.normalize('NFKD');
  text = text.replace(/\p{Mark}/gu, '');
  text = text.toLowerCase();
  text = text.replace(/[^\p{L}\p{N}_\s-]/gu, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeGtin(gtin) {
  if (typeof gtin !== 'string' || !gtin) return '';
  const digits = gtin.trim().replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 14) return digits.padStart(14, '0');
  return digits;
}

function makeContentKey(brand, title, gtin = null) {
  const brandNorm = normalizeBrand(brand);
  const titleNorm = normalizeTitle(title);
  if (!brandNorm || !titleNorm) return null;
  const gtinNorm = normalizeGtin(gtin);
  const digest = crypto
    .createHash('sha256')
    .update(`${brandNorm}::${titleNorm}::${gtinNorm}`, 'utf8')
    .digest('hex')
    .slice(0, KEY_HEX_LEN);
  return `${KEY_PREFIX}${digest}`;
}

function isContentKey(value) {
  return typeof value === 'string' && /^ck_[0-9a-f]{32}$/.test(value);
}

module.exports = {
  isContentKey,
  makeContentKey,
  normalizeBrand,
  normalizeGtin,
  normalizeTitle,
};
