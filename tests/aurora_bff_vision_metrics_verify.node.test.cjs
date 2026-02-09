const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resetVisionMetrics,
  renderVisionMetricsPrometheus,
  recordVerifyFail,
  recordVerifyBudgetGuard,
  recordVerifyCircuitOpen,
  recordVerifyRetry,
} = require('../src/auroraBff/visionMetrics');

test('vision metrics: verify fail reasons are normalized and budget guard is counted', () => {
  resetVisionMetrics();

  recordVerifyFail({
    reason: 'VERIFY_TIMEOUT',
    provider: 'gemini_provider',
    httpStatusClass: 'timeout',
    timeoutStage: 'total',
    retryCount: 2,
  });
  recordVerifyFail({ reason: 'RATE_LIMITED', provider: 'gemini_provider', httpStatusClass: '4xx' });
  recordVerifyFail({ reason: 'quota_exceeded', provider: 'gemini_provider', httpStatusClass: '4xx' });
  recordVerifyFail({ reason: 'SCHEMA_INVALID', provider: 'gemini_provider', httpStatusClass: '2xx' });
  recordVerifyFail({ reason: 'MISSING_IMAGE_BUFFER', provider: 'gemini_provider', httpStatusClass: '4xx' });
  recordVerifyFail({ reason: 'VISION_NETWORK_ERROR', provider: 'gemini_provider', httpStatusClass: 'unknown' });
  recordVerifyFail({ reason: 'completely_unclassified', provider: 'gemini_provider', httpStatusClass: 'unknown' });
  recordVerifyFail({
    reason: 'VISION_UNKNOWN',
    provider: 'gemini_provider',
    httpStatusClass: '5xx',
    errorClass: 'MISSING_DEP',
  });
  recordVerifyBudgetGuard();
  recordVerifyBudgetGuard();
  recordVerifyCircuitOpen();
  recordVerifyRetry({ attempts: 3 });

  const metrics = renderVisionMetricsPrometheus();

  assert.match(metrics, /verify_fail_total\{reason="TIMEOUT",provider="gemini_provider",http_status_class="timeout"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="RATE_LIMIT",provider="gemini_provider",http_status_class="4xx"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="QUOTA",provider="gemini_provider",http_status_class="4xx"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="SCHEMA_INVALID",provider="gemini_provider",http_status_class="2xx"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="IMAGE_FETCH_FAILED",provider="gemini_provider",http_status_class="4xx"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="NETWORK_ERROR",provider="gemini_provider",http_status_class="unknown"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="UNKNOWN",provider="gemini_provider",http_status_class="unknown"\} 1/);
  assert.match(metrics, /verify_fail_total\{reason="UNKNOWN",provider="gemini_provider",http_status_class="5xx"\} 1/);
  assert.match(
    metrics,
    /verify_fail_unknown_error_class_total\{provider="gemini_provider",http_status_class="unknown",error_class="unknown"\} 1/,
  );
  assert.match(
    metrics,
    /verify_fail_unknown_error_class_total\{provider="gemini_provider",http_status_class="5xx",error_class="missing_dep"\} 1/,
  );
  assert.match(metrics, /verify_budget_guard_total 2/);
  assert.match(metrics, /verify_circuit_open_total 1/);
  assert.match(metrics, /verify_retry_total 2/);
  assert.match(metrics, /verify_timeout_total\{stage="total"\} 1/);
});
