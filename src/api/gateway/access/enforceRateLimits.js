function asPositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

function enforceRateLimits(input = {}) {
  const profile = input.rate_limit_profile || {};
  const usageSnapshot =
    input.usage_snapshot && typeof input.usage_snapshot === 'object' ? input.usage_snapshot : {};
  const requestCostUnits = asPositiveInteger(input.request_cost_units, 1);

  const reasons = [];
  if ((profile.requests_per_minute || 0) <= 0) {
    reasons.push('requests_per_minute_exhausted');
  }
  if (asPositiveInteger(usageSnapshot.requests_in_last_minute, 0) >= (profile.requests_per_minute || 0)) {
    reasons.push('rpm_exceeded');
  }
  if (asPositiveInteger(usageSnapshot.concurrent_requests, 0) >= (profile.max_concurrency || 0) && (profile.max_concurrency || 0) > 0) {
    reasons.push('concurrency_exceeded');
  }
  if (
    profile.daily_request_cap != null &&
    asPositiveInteger(usageSnapshot.daily_requests, 0) >= profile.daily_request_cap
  ) {
    reasons.push('daily_request_cap_exceeded');
  }
  if (
    profile.daily_credit_cap != null &&
    asPositiveInteger(usageSnapshot.daily_cost_units, 0) + requestCostUnits > profile.daily_credit_cap
  ) {
    reasons.push('daily_credit_cap_exceeded');
  }

  return {
    allowed: reasons.length === 0,
    action: reasons.length === 0 ? 'allow' : 'throttle',
    reason_codes: reasons,
    request_cost_units: requestCostUnits,
    profile_id: profile.profile_id || 'default',
  };
}

module.exports = {
  enforceRateLimits,
};
