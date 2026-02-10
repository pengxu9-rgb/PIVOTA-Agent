const BANNED_PATTERNS = Object.freeze([
  /\b(treat|treated|treating|cure|cured|heals?|healed|diagnos(?:e|is)|prescription|rx[-\s]?only)\b/i,
  /\b(therapeutic|medical[-\s]?grade|clinical treatment)\b/i,
  /(治疗|治愈|诊断|处方|药用|药效|医药)/,
  /(診断|治療|治癒|処方|処方薬|医薬)/,
]);

const DEFAULT_DISALLOWED_CLAIMS = Object.freeze([
  'treat',
  'cure',
  'diagnose',
  'prescription',
  '治疗',
  '治愈',
  '诊断',
  '处方',
  '診断',
  '治療',
  '治癒',
  '処方',
]);

const GENERIC_SAFE_BY_MARKET = Object.freeze({
  EU: 'Supports cosmetic skin comfort and visible balance.',
  CN: '帮助维持肌肤外观稳定与舒适。',
  JP: '肌のうるおいと見た目のコンディション維持をサポート。',
  US: 'Supports cosmetic skin comfort and visible appearance balance.',
});

function normalizeMarket(input) {
  const token = String(input || '').trim().toUpperCase();
  if (token === 'CN' || token === 'JP' || token === 'EU' || token === 'US') return token;
  return 'US';
}

function detectBannedClaimTerms(text) {
  const value = String(text || '').trim();
  if (!value) return [];
  const hits = [];
  for (const pattern of BANNED_PATTERNS) {
    if (!pattern.test(value)) continue;
    hits.push(pattern.toString());
  }
  return hits;
}

function hasBannedClaimTerms(text) {
  return detectBannedClaimTerms(text).length > 0;
}

function genericSafeClaim({ market } = {}) {
  const normalized = normalizeMarket(market);
  return GENERIC_SAFE_BY_MARKET[normalized] || GENERIC_SAFE_BY_MARKET.US;
}

function sanitizeClaimText(text, { market, evidenceGrade } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return genericSafeClaim({ market });
  if (String(evidenceGrade || '').toUpperCase() === 'C') return genericSafeClaim({ market });
  if (hasBannedClaimTerms(raw)) return genericSafeClaim({ market });
  return raw.slice(0, 240);
}

function ensureCosmeticSafeClaims(claims, { market, evidenceGrade } = {}) {
  const input = Array.isArray(claims) ? claims : [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const value = sanitizeClaimText(item, { market, evidenceGrade });
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  if (!out.length) out.push(genericSafeClaim({ market }));
  return out.slice(0, 6);
}

module.exports = {
  BANNED_PATTERNS,
  DEFAULT_DISALLOWED_CLAIMS,
  detectBannedClaimTerms,
  hasBannedClaimTerms,
  sanitizeClaimText,
  ensureCosmeticSafeClaims,
  genericSafeClaim,
  normalizeMarket,
};
