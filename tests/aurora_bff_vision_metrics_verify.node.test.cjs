const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resetVisionMetrics,
  renderVisionMetricsPrometheus,
  recordVerifyFail,
  recordVerifyBudgetGuard,
  recordVerifyCircuitOpen,
  recordVerifyRetry,
  recordProductRecSuppressed,
  recordSkinmaskEnabled,
  recordSkinmaskFallback,
  observeSkinmaskInferLatency,
  recordUiBehaviorEvent,
  recordTemplateApplied,
  recordTemplateFallback,
  recordChipsTruncated,
  recordFieldMissingAdded,
  recordAntiTemplateViolation,
  recordActionableReply,
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

test('vision metrics: product rec suppression reason normalizes to NO_MATCH', () => {
  resetVisionMetrics();
  recordProductRecSuppressed({ reason: 'NO_CATALOG_MATCH', delta: 2 });
  const metrics = renderVisionMetricsPrometheus();
  assert.match(metrics, /product_rec_suppressed_total\{reason="NO_MATCH"\} 2/);
});

test('vision metrics: ui behavior rates are exported for internal tracking', () => {
  resetVisionMetrics();
  recordUiBehaviorEvent({ eventName: 'aurora_photo_modules_module_tap' });
  recordUiBehaviorEvent({ eventName: 'aurora_photo_modules_action_tap' });
  recordUiBehaviorEvent({ eventName: 'aurora_photo_modules_action_tap' });
  recordUiBehaviorEvent({ eventName: 'aurora_photo_modules_action_copy' });
  recordUiBehaviorEvent({ eventName: 'aurora_retake_after_modules' });

  const metrics = renderVisionMetricsPrometheus();
  assert.match(metrics, /modules_interaction_total 4/);
  assert.match(metrics, /action_click_total 2/);
  assert.match(metrics, /action_copy_total 1/);
  assert.match(metrics, /retake_after_modules_total 1/);
  assert.match(metrics, /action_click_rate 0\.5\b/);
  assert.match(metrics, /action_copy_rate 0\.5\b/);
  assert.match(metrics, /retake_rate_after_modules 0\.25\b/);
});

test('vision metrics: skinmask counters and latency histogram are exported', () => {
  resetVisionMetrics();
  recordSkinmaskEnabled();
  recordSkinmaskEnabled({ delta: 2 });
  recordSkinmaskFallback({ reason: 'MODEL_MISSING' });
  recordSkinmaskFallback({ reason: 'timeout' });
  recordSkinmaskFallback({ reason: 'runtime_crash' });
  observeSkinmaskInferLatency({ latencyMs: 40 });
  observeSkinmaskInferLatency({ latencyMs: 240 });
  observeSkinmaskInferLatency({ latencyMs: 1400 });

  const metrics = renderVisionMetricsPrometheus();
  assert.match(metrics, /skinmask_enabled_total 3/);
  assert.match(metrics, /skinmask_fallback_total\{reason="MODEL_MISSING"\} 1/);
  assert.match(metrics, /skinmask_fallback_total\{reason="TIMEOUT"\} 1/);
  assert.match(metrics, /skinmask_fallback_total\{reason="ONNX_FAIL"\} 1/);
  assert.match(metrics, /skinmask_infer_ms_bucket\{le="100"\} 1/);
  assert.match(metrics, /skinmask_infer_ms_bucket\{le="250"\} 2/);
  assert.match(metrics, /skinmask_infer_ms_bucket\{le="2000"\} 3/);
  assert.match(metrics, /skinmask_infer_ms_count 3/);
});

test('vision metrics: template-system counters and rates are exported', () => {
  resetVisionMetrics();
  recordTemplateApplied({
    templateId: 'recommendations_output.standard',
    moduleName: 'recommendations_output',
    variant: 'standard',
    source: 'chat',
  });
  recordTemplateApplied({
    templateId: 'diagnosis_clarification.standard',
    moduleName: 'diagnosis_clarification',
    variant: 'standard',
    source: 'chat',
  });
  recordTemplateFallback({ reason: 'keep_existing', moduleName: 'product_evaluation' });
  recordChipsTruncated({ delta: 3 });
  recordFieldMissingAdded({ delta: 2 });
  recordAntiTemplateViolation({ rule: 'missing_action', delta: 2 });
  recordActionableReply({ actionable: true });
  recordActionableReply({ actionable: false });

  const metrics = renderVisionMetricsPrometheus();
  assert.match(metrics, /template_applied_total\{template_id="recommendations_output.standard",module="recommendations_output",variant="standard",source="chat"\} 1/);
  assert.match(metrics, /template_fallback_total\{reason="keep_existing",module="product_evaluation"\} 1/);
  assert.match(metrics, /chips_truncated_count 3/);
  assert.match(metrics, /field_missing_added_count 2/);
  assert.match(metrics, /anti_template_violation_count\{rule="missing_action"\} 2/);
  assert.match(metrics, /actionable_reply_total\{actionable="true"\} 1/);
  assert.match(metrics, /actionable_reply_total\{actionable="false"\} 1/);
  assert.match(metrics, /template_applied_rate 0\.6666666666666666/);
  assert.match(metrics, /template_fallback_rate 0\.3333333333333333/);
  assert.match(metrics, /actionable_reply_rate 0\.5/);
});
