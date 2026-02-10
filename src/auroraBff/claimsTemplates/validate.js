const { detectBannedClaimTerms, normalizeMarket } = require('../ingredientKbV2/claimGuard');
const { TEMPLATES_EN, ISSUE_LABELS_EN } = require('./templates.en');
const { TEMPLATES_ZH, ISSUE_LABELS_ZH } = require('./templates.zh');

function normalizeLang(lang) {
  const token = String(lang || '').trim().toLowerCase();
  if (token === 'zh' || token === 'cn' || token === 'zh-cn') return 'zh';
  return 'en';
}

function getTemplateBundle(lang) {
  return normalizeLang(lang) === 'zh'
    ? { templates: TEMPLATES_ZH, issueLabels: ISSUE_LABELS_ZH }
    : { templates: TEMPLATES_EN, issueLabels: ISSUE_LABELS_EN };
}

function normalizeIssueType(issueType) {
  const token = String(issueType || '').trim().toLowerCase();
  if (token === 'pores') return 'texture';
  if (token === 'dark_spots') return 'tone';
  if (token === 'redness' || token === 'shine' || token === 'texture' || token === 'tone' || token === 'acne') return token;
  return 'redness';
}

function getIssueLabel(issueType, lang) {
  const { issueLabels } = getTemplateBundle(lang);
  return issueLabels[normalizeIssueType(issueType)] || issueLabels.redness;
}

function getTemplateEntry({ templateType, issueType, lang } = {}) {
  const { templates } = getTemplateBundle(lang);
  const safeType = String(templateType || '').trim();
  if (!safeType || !templates[safeType]) return null;
  if (safeType === 'generic_safe') return templates.generic_safe.default;
  if (safeType === 'how_to_use') return templates.how_to_use.conservative;
  return templates[safeType][normalizeIssueType(issueType)] || null;
}

function collectTemplateKeysFromNode(node, out) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.key === 'string' && node.key.trim()) out.add(node.key.trim());
  for (const value of Object.values(node)) collectTemplateKeysFromNode(value, out);
}

function allowedTemplateKeys() {
  const out = new Set();
  collectTemplateKeysFromNode(TEMPLATES_EN, out);
  collectTemplateKeysFromNode(TEMPLATES_ZH, out);
  return out;
}

const ALLOWED_TEMPLATE_KEYS = allowedTemplateKeys();

function validateRenderedText({ text, templateKey } = {}) {
  const value = String(text || '').trim();
  const key = String(templateKey || '').trim();
  if (!value) return { ok: false, reason: 'empty_text', violations: [] };
  if (!key || !ALLOWED_TEMPLATE_KEYS.has(key)) {
    return { ok: false, reason: 'template_key_not_allowlisted', violations: [] };
  }
  const violations = detectBannedClaimTerms(value);
  if (violations.length) return { ok: false, reason: 'banned_terms', violations };
  return { ok: true, reason: 'ok', violations: [] };
}

function genericSafeTemplateEntry(lang) {
  const entry = getTemplateEntry({ templateType: 'generic_safe', lang });
  return entry || { key: 'generic_safe_fallback_v1', text: 'Based on highlighted areas, this step supports visible balance.' };
}

module.exports = {
  normalizeLang,
  normalizeIssueType,
  normalizeMarket,
  getIssueLabel,
  getTemplateEntry,
  validateRenderedText,
  ALLOWED_TEMPLATE_KEYS,
  genericSafeTemplateEntry,
};
