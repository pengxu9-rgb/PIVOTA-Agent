function buildQueryString(params) {
  const sp = new URLSearchParams();
  const entries = params && typeof params === 'object' ? Object.entries(params) : [];
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        sp.append(key, String(item));
      }
      continue;
    }
    sp.append(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

module.exports = {
  buildQueryString,
};
