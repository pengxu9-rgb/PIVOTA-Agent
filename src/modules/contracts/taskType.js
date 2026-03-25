const TASK_TYPES = Object.freeze([
  'full_purchase',
  'discovery',
  'exact_product',
]);

const EXACT_PRODUCT_NEAR_EXACT_RESOLUTION_NOTE =
  'exact_product currently covers both fully exact product intent and near_exact_resolution intent where the user is close to execution but merchant, offer, or variant resolution is still required.';

function normalizeTaskType(value, fallback = 'discovery') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (TASK_TYPES.includes(normalized)) return normalized;
  return fallback;
}

function isTaskType(value) {
  return TASK_TYPES.includes(normalizeTaskType(value, ''));
}

function describeTaskType(value) {
  const taskType = normalizeTaskType(value);
  if (taskType === 'exact_product') {
    return {
      task_type: 'exact_product',
      note: EXACT_PRODUCT_NEAR_EXACT_RESOLUTION_NOTE,
    };
  }
  return {
    task_type: taskType,
    note: null,
  };
}

module.exports = {
  TASK_TYPES,
  EXACT_PRODUCT_NEAR_EXACT_RESOLUTION_NOTE,
  normalizeTaskType,
  isTaskType,
  describeTaskType,
};
