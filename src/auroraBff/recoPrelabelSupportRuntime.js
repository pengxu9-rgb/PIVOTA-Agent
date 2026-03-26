function createRecoPrelabelSupportRuntime({
  applyProductAnalysisGapContract = (payload) => payload,
  isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
} = {}) {
  function parseBoolQueryValue(value, fallback = false) {
    if (value == null) return fallback;
    const token = String(value).trim().toLowerCase();
    if (!token) return fallback;
    if (token === '1' || token === 'true' || token === 'yes' || token === 'y' || token === 'on') return true;
    if (token === '0' || token === 'false' || token === 'no' || token === 'n' || token === 'off') return false;
    return fallback;
  }

  function parseIntQueryValue(value, fallback, min, max) {
    const n = Number(value);
    const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
    return Math.max(min, Math.min(max, v));
  }

  function normalizeBlockToken(value) {
    const token = String(value == null ? '' : value).trim().toLowerCase();
    if (token === 'competitors' || token === 'dupes' || token === 'related_products') return token;
    return '';
  }

  function buildSuggestionLookupByBlock(suggestions = []) {
    const out = {
      competitors: new Map(),
      dupes: new Map(),
      related_products: new Map(),
    };
    for (const row of Array.isArray(suggestions) ? suggestions : []) {
      const block = normalizeBlockToken(row?.block);
      if (!block || !out[block]) continue;
      const key = String(row?.candidate_product_id || '').trim().toLowerCase();
      if (!key) continue;
      out[block].set(key, row);
    }
    return out;
  }

  function sanitizeSuggestionForPublic(row) {
    const item = row && typeof row === 'object' && !Array.isArray(row) ? row : null;
    if (!item) return null;
    return {
      id: String(item.id || '').trim(),
      suggested_label: String(item.suggested_label || '').trim(),
      wrong_block_target: item.wrong_block_target ? String(item.wrong_block_target).trim() : null,
      confidence: Number.isFinite(Number(item.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : 0,
      rationale_user_visible: String(item.rationale_user_visible || '').trim(),
      flags: Array.isArray(item.flags) ? item.flags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 10) : [],
      model_name: String(item.model_name || '').trim(),
      prompt_version: String(item.prompt_version || '').trim(),
      updated_at: item.updated_at || null,
    };
  }

  function attachPrelabelSuggestionsToPayload(payload, suggestions = []) {
    const p = isPlainObject(payload) ? { ...payload } : {};
    const lookup = buildSuggestionLookupByBlock(suggestions);
    for (const block of ['competitors', 'dupes', 'related_products']) {
      const blockObj = isPlainObject(p?.[block]) ? { ...p[block] } : null;
      if (!blockObj) continue;
      const rows = Array.isArray(blockObj.candidates) ? blockObj.candidates : [];
      blockObj.candidates = rows.map((row, idx) => {
        const item = isPlainObject(row) ? { ...row } : row;
        if (!isPlainObject(item)) return item;
        const key = String(item.product_id || item.sku_id || item.id || item.name || `idx:${idx + 1}`)
          .trim()
          .toLowerCase();
        const suggestion = lookup[block].get(key);
        if (!suggestion) return item;
        return {
          ...item,
          llm_suggestion: sanitizeSuggestionForPublic(suggestion),
        };
      });
      p[block] = blockObj;
    }
    return p;
  }

  function sanitizeProductAnalysisPayloadForPrelabel(payload) {
    const p = isPlainObject(payload) ? { ...payload } : {};
    const contracted = applyProductAnalysisGapContract(p);
    const nextPayload = isPlainObject(contracted) ? { ...contracted } : p;
    delete nextPayload.missing_info_internal;
    delete nextPayload.internal_debug_codes;
    delete nextPayload.llm_raw_response;
    delete nextPayload.suggestion_debug;
    delete nextPayload.input_hash;
    delete nextPayload.candidate_tracking;
    delete nextPayload.candidate_tracking_internal;
    delete nextPayload.internal_attribution;
    delete nextPayload.tracking;
    for (const block of ['competitors', 'dupes', 'related_products']) {
      const blockObj = isPlainObject(nextPayload?.[block]) ? { ...nextPayload[block] } : null;
      if (!blockObj) continue;
      const rows = Array.isArray(blockObj.candidates) ? blockObj.candidates : [];
      blockObj.candidates = rows.map((row) => {
        const item = isPlainObject(row) ? { ...row } : row;
        if (!isPlainObject(item)) return item;
        delete item.ref_id;
        delete item.internal_reason_codes;
        delete item.input_hash;
        delete item.llm_raw_response;
        delete item.suggestion_debug;
        return item;
      });
      nextPayload[block] = blockObj;
    }
    return nextPayload;
  }

  return {
    parseBoolQueryValue,
    parseIntQueryValue,
    normalizeBlockToken,
    sanitizeSuggestionForPublic,
    attachPrelabelSuggestionsToPayload,
    sanitizeProductAnalysisPayloadForPrelabel,
  };
}

module.exports = {
  createRecoPrelabelSupportRuntime,
};
