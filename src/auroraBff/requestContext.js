const { randomUUID } = require('crypto');

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
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;

  // MVP explicit allowlist (conservative): only these phrases count as "text_explicit".
  const patterns = [
    // EN
    /\brecommend\b/,
    /product recommendations?/,
    /build me a routine/,
    /diagnose my skin/,
    /review my routine/,
    // CN
    /推荐/,
    /产品推荐/,
    /给我方案/,
    /诊断/,
    /评估我现在用的/,
  ];
  return patterns.some((re) => re.test(text));
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
  const lang = normalizeLang(getHeader(req, 'X-Lang') || (body && body.language));
  const requestId = getHeader(req, 'X-Request-ID') || randomUUID();
  const triggerSource = inferTriggerSource(body || {});
  const state = (body && body.session && body.session.state) || null;

  return {
    request_id: requestId,
    trace_id: String(traceId || '').trim() || randomUUID(),
    aurora_uid: auroraUid ? String(auroraUid).trim() : null,
    brief_id: briefId ? String(briefId).trim() : null,
    lang,
    trigger_source: triggerSource,
    state,
  };
}

module.exports = {
  normalizeLang,
  detectTextExplicit,
  inferTriggerSource,
  buildRequestContext,
};
