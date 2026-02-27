const { randomUUID } = require('crypto');
const {
  detectLanguageFromText,
  looksLikeChineseText,
  isExplicitTextTrigger,
} = require('./languageIntentLexicon');

function normalizeLang(raw) {
  const v = String(raw || '').trim().toUpperCase();
  if (v === 'CN' || v === 'ZH' || v === 'ZH-CN' || v === 'ZH_HANS') return 'CN';
  return 'EN';
}

function getHeader(req, name) {
  const v = req.get(name);
  return v == null ? null : String(v);
}

function detectTextExplicit(message) {
  return isExplicitTextTrigger(message);
}

function resolveMatchingLanguage({
  message = '',
  uiLang = 'EN',
  hasExplicitLanguage = false,
  explicitSource = 'header',
} = {}) {
  const ui = normalizeLang(uiLang);
  const text = String(message || '').trim();

  if (!text) {
    return {
      match_lang: ui,
      language_mismatch: false,
      language_resolution_source: hasExplicitLanguage ? (explicitSource === 'body' ? 'body' : 'header') : 'text_detected',
    };
  }

  const detected = detectLanguageFromText(text);
  if (!hasExplicitLanguage) {
    return {
      match_lang: detected,
      language_mismatch: detected !== ui,
      language_resolution_source: 'text_detected',
    };
  }

  if (detected !== ui) {
    return {
      match_lang: detected,
      language_mismatch: true,
      language_resolution_source: 'mixed_override',
    };
  }

  return {
    match_lang: detected,
    language_mismatch: false,
    language_resolution_source: explicitSource === 'body' ? 'body' : 'header',
  };
}

function inferTriggerSource(body) {
  const rt = body && body.requested_transition;
  if (rt && typeof rt === 'object') {
    const ts = String(rt.trigger_source || '').trim();
    if (ts === 'chip' || ts === 'action' || ts === 'text_explicit') return ts;
  }

  const action = body && body.action;
  if (action) {
    if (typeof action === 'string') {
      const a = action.trim();
      if (/^(chip[:_]|chip\\.|chip-)/i.test(a)) return 'chip';
      if (/^profile\\./i.test(a)) return 'chip';
      return 'action';
    }
    if (typeof action === 'object' && action.action_id) {
      const kind = String(action.kind || '').trim().toLowerCase();
      if (kind === 'chip') return 'chip';
      return 'action';
    }
    return 'action';
  }

  const msg = body && typeof body.message === 'string' ? body.message : '';
  return detectTextExplicit(msg) ? 'text_explicit' : 'text';
}

function buildRequestContext(req, body) {
  const auroraUid = getHeader(req, 'X-Aurora-UID');
  const briefId = getHeader(req, 'X-Brief-ID') || (body && body.session && body.session.brief_id) || null;
  const traceId = getHeader(req, 'X-Trace-ID') || (body && body.session && body.session.trace_id) || randomUUID();
  const headerLang = getHeader(req, 'X-Lang');
  const bodyLang = body && body.language ? String(body.language) : null;
  const explicitLang = headerLang || bodyLang || null;
  const explicitSource = headerLang ? 'header' : bodyLang ? 'body' : 'text_detected';
  const fallbackText =
    (body && typeof body.message === 'string' && body.message) ||
    (body && typeof body.query === 'string' && body.query) ||
    '';
  const uiLang = explicitLang ? normalizeLang(explicitLang) : detectLanguageFromText(fallbackText);
  const languageResolved = resolveMatchingLanguage({
    message: fallbackText,
    uiLang,
    hasExplicitLanguage: Boolean(explicitLang),
    explicitSource,
  });
  const requestId = getHeader(req, 'X-Request-ID') || randomUUID();
  const triggerSource = inferTriggerSource(body || {});
  const state = (body && body.session && body.session.state) || null;

  return {
    request_id: requestId,
    trace_id: String(traceId || '').trim() || randomUUID(),
    aurora_uid: auroraUid ? String(auroraUid).trim() : null,
    brief_id: briefId ? String(briefId).trim() : null,
    lang: uiLang,
    ui_lang: uiLang,
    match_lang: languageResolved.match_lang,
    language_mismatch: languageResolved.language_mismatch,
    language_resolution_source: languageResolved.language_resolution_source,
    trigger_source: triggerSource,
    state,
  };
}

module.exports = {
  normalizeLang,
  looksLikeChineseText,
  detectTextExplicit,
  resolveMatchingLanguage,
  inferTriggerSource,
  buildRequestContext,
};
