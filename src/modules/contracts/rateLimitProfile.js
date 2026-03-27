function normalizePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

function normalizeCostUnits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, amount]) => [String(key || '').trim(), normalizePositiveInteger(amount, 0)])
      .filter(([key]) => Boolean(key)),
  );
}

function buildRateLimitProfile(input = {}) {
  return {
    profile_id: String(input.profile_id || '').trim() || 'default',
    requests_per_minute: normalizePositiveInteger(input.requests_per_minute, 60),
    burst_limit: normalizePositiveInteger(input.burst_limit, 10),
    max_concurrency: normalizePositiveInteger(input.max_concurrency, 4),
    daily_request_cap:
      input.daily_request_cap == null ? null : normalizePositiveInteger(input.daily_request_cap, 0),
    daily_credit_cap:
      input.daily_credit_cap == null ? null : normalizePositiveInteger(input.daily_credit_cap, 0),
    per_operation_cost_units: normalizeCostUnits(input.per_operation_cost_units),
  };
}

module.exports = {
  buildRateLimitProfile,
};
