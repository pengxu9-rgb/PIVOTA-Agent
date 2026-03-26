function looksLikeErrorCode(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized || normalized.length > 80) return false;
  return /^[A-Z][A-Z0-9_]+$/.test(normalized);
}

function extractUpstreamErrorCode(err) {
  const data = err && err.response ? err.response.data : null;

  if (data && typeof data === 'object') {
    const pivotaErr = data.error && typeof data.error === 'object' ? data.error : null;
    if (pivotaErr) {
      const details =
        pivotaErr.details && typeof pivotaErr.details === 'object' ? pivotaErr.details : null;
      const underlying =
        details && typeof details.error === 'string' && looksLikeErrorCode(details.error)
          ? details.error
          : typeof pivotaErr.message === 'string' && looksLikeErrorCode(pivotaErr.message)
            ? pivotaErr.message
            : typeof pivotaErr.code === 'string' && looksLikeErrorCode(pivotaErr.code)
              ? pivotaErr.code
              : null;
      const message =
        (details && typeof details.message === 'string' && details.message) ||
        (typeof pivotaErr.message === 'string' && !looksLikeErrorCode(pivotaErr.message)
          ? pivotaErr.message
          : '') ||
        (typeof pivotaErr.code === 'string' && !looksLikeErrorCode(pivotaErr.code)
          ? pivotaErr.code
          : '') ||
        (err && err.message ? err.message : '');
      return { code: underlying, message, data, detail: details || pivotaErr };
    }
  }

  const detail = data && typeof data === 'object' ? (data.detail ?? data) : data;
  const code =
    detail && typeof detail === 'object'
      ? typeof detail.code === 'string'
        ? detail.code
        : typeof detail.error === 'string'
          ? detail.error
          : null
      : null;
  const message =
    detail && typeof detail === 'object' && typeof detail.message === 'string'
      ? detail.message
      : typeof detail === 'string'
        ? detail
        : err && err.message
          ? err.message
          : '';
  return { code, message, data, detail };
}

module.exports = {
  extractUpstreamErrorCode,
};
