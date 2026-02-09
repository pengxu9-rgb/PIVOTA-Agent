const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resetVisionMetrics,
  renderVisionMetricsPrometheus,
  recordVerifyFail,
  recordVerifyBudgetGuard,
} = require('../src/auroraBff/visionMetrics');

test('vision metrics: verify fail reasons are normalized and budget guard is counted', () => {
  resetVisionMetrics();

  recordVerifyFail({ reason: 'VERIFY_TIMEOUT' });
  recordVerifyFail({ reason: 'RATE_LIMITED' });
  recordVerifyFail({ reason: 'quota_exceeded' });
  recordVerifyFail({ reason: 'SCHEMA_INVALID' });
  recordVerifyFail({ reason: 'MISSING_IMAGE_BUFFER' });
  recordVerifyFail({ reason: 'completely_unclassified' });
  recordVerifyBudgetGuard();
  recordVerifyBudgetGuard();

  const metrics = renderVisionMetricsPrometheus();

  assert.match(metrics, /verify_fail_total\{reason="TIMEOUT"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="RATE_LIMIT"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="QUOTA"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="SCHEMA_INVALID"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="IMAGE_FETCH_FAILED"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="UNKNOWN"\} 1/);
  assert.match(metrics, /verify_budget_guard_total 2/);
});
