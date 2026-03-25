const DELEGATION_PLANS = Object.freeze([
  'stay_in_layer',
  'call_decisioning',
  'call_execution',
  'call_decisioning_then_execution',
]);

function normalizeDelegationPlan(value, fallback = 'stay_in_layer') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (DELEGATION_PLANS.includes(normalized)) return normalized;
  return fallback;
}

function isDelegationPlan(value) {
  return DELEGATION_PLANS.includes(normalizeDelegationPlan(value, ''));
}

module.exports = {
  DELEGATION_PLANS,
  normalizeDelegationPlan,
  isDelegationPlan,
};
