const {
  normalizeLang,
  normalizeIssueType,
  normalizeMarket,
  getIssueLabel,
  getTemplateEntry,
  validateRenderedText,
  genericSafeTemplateEntry,
} = require('./validate');

function sanitizeToken(value, fallback = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return String(fallback || '').trim();
  return text.slice(0, 80);
}

function renderTemplateText(templateText, tokens) {
  return String(templateText || '').replace(/\{([a-z_]+)\}/g, (_m, key) => sanitizeToken(tokens[key], ''));
}

function buildFallback({ market, lang, reason } = {}) {
  const entry = genericSafeTemplateEntry(lang);
  const text = renderTemplateText(entry.text, {
    market: normalizeMarket(market),
  });
  return {
    text,
    template_key: entry.key,
    market: normalizeMarket(market),
    lang: normalizeLang(lang),
    issue_type: null,
    fallback: true,
    reason: reason || 'generic_safe',
    violations: [],
  };
}

function renderAllowedTemplate({
  templateType,
  issueType,
  ingredientName,
  moduleLabel,
  market,
  lang,
  tone,
} = {}) {
  const normalizedLang = normalizeLang(lang);
  const normalizedMarket = normalizeMarket(market);
  const normalizedIssueType = normalizeIssueType(issueType);
  const normalizedTone = String(tone || 'conservative').trim().toLowerCase();

  const entry = getTemplateEntry({
    templateType,
    issueType: normalizedIssueType,
    lang: normalizedLang,
  });
  if (!entry || !entry.key || !entry.text) {
    return buildFallback({ market: normalizedMarket, lang: normalizedLang, reason: 'template_missing' });
  }

  const text = renderTemplateText(entry.text, {
    ingredient_name: sanitizeToken(ingredientName, normalizedLang === 'zh' ? '该成分' : 'this ingredient'),
    issue_label: getIssueLabel(normalizedIssueType, normalizedLang),
    module_label: sanitizeToken(moduleLabel, normalizedLang === 'zh' ? '该区域' : 'this area'),
    tone: normalizedTone,
    market: normalizedMarket,
  }).slice(0, 240);

  const validation = validateRenderedText({
    text,
    templateKey: entry.key,
  });
  if (!validation.ok) {
    const fallback = buildFallback({
      market: normalizedMarket,
      lang: normalizedLang,
      reason: validation.reason,
    });
    fallback.violations = Array.isArray(validation.violations) ? validation.violations : [];
    return fallback;
  }

  return {
    text,
    template_key: entry.key,
    market: normalizedMarket,
    lang: normalizedLang,
    issue_type: normalizedIssueType,
    fallback: false,
    reason: 'ok',
    violations: [],
  };
}

function validateOrFallbackFreeText({ text, templateKey, market, lang } = {}) {
  const validation = validateRenderedText({ text, templateKey });
  if (validation.ok) {
    return {
      text: String(text || '').trim().slice(0, 240),
      template_key: templateKey,
      market: normalizeMarket(market),
      lang: normalizeLang(lang),
      fallback: false,
      reason: 'ok',
      violations: [],
    };
  }
  const fallback = buildFallback({ market, lang, reason: validation.reason });
  fallback.violations = Array.isArray(validation.violations) ? validation.violations : [];
  return fallback;
}

module.exports = {
  renderAllowedTemplate,
  validateOrFallbackFreeText,
  renderTemplateText,
};
