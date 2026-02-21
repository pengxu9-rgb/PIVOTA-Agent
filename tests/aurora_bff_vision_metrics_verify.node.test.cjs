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
  recordRecoGuardrailViolation,
  recordRecoCandidate,
  recordRecoExplanationAlignment,
  recordRecoGuardrailCircuitOpen,
  recordRecoEmployeeFeedback,
  recordRecoInterleaveClick,
  recordRecoInterleaveWin,
  recordRecoExplorationSlot,
  recordRecoAsyncUpdate,
  setRecoGuardrailRates,
  recordPrelabelRequest,
  recordPrelabelSuccess,
  recordPrelabelInvalidJson,
  recordPrelabelCacheHit,
  observePrelabelGeminiLatency,
  recordSuggestionsGeneratedPerBlock,
  recordQueueItemsServed,
  setPrelabelCacheHitRate,
  setLlmSuggestionOverturnedRate,
  recordSocialFetchRequest,
  recordSocialFetchSuccess,
  recordSocialFetchTimeout,
  recordSocialKbBackfill,
  setSocialCacheHitRate,
  setSocialChannelsCoverage,
  recordAuroraSkinFlowMetric,
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

test('vision metrics: reco guardrail counters and gauges are exported with block labels', () => {
  resetVisionMetrics();
  recordRecoGuardrailViolation({
    block: 'competitors',
    violationType: 'same_brand',
    mode: 'main_path',
    action: 'sanitize',
  });
  recordRecoGuardrailViolation({
    block: 'competitors',
    violationType: 'on_page_source',
    mode: 'sync_repair',
    action: 'sanitize',
  });
  recordRecoCandidate({
    block: 'competitors',
    sourceType: 'catalog_search',
    brandRelation: 'cross_brand',
    mode: 'main_path',
  });
  recordRecoCandidate({
    block: 'related_products',
    sourceType: 'on_page_related',
    brandRelation: 'same_brand',
    mode: 'main_path',
    delta: 2,
  });
  recordRecoExplanationAlignment({
    block: 'competitors',
    aligned: true,
    mode: 'main_path',
  });
  recordRecoExplanationAlignment({
    block: 'dupes',
    aligned: false,
    mode: 'async_backfill',
  });
  recordRecoGuardrailCircuitOpen({ mode: 'main_path' });
  setRecoGuardrailRates({
    competitorsSameBrandRate: 0.5,
    competitorsOnPageSourceRate: 0.25,
    explanationAlignmentAt3: 0.8,
  });

  const metrics = renderVisionMetricsPrometheus();
  assert.match(
    metrics,
    /reco_guardrail_violation_total\{block="competitors",violation_type="same_brand",mode="main_path",action="sanitize"\} 1/,
  );
  assert.match(
    metrics,
    /reco_candidate_total\{block="related_products",source_type="on_page_related",brand_relation="same_brand",mode="main_path"\} 2/,
  );
  assert.match(
    metrics,
    /reco_explanation_alignment_total\{block="dupes",aligned="false",mode="async_backfill"\} 1/,
  );
  assert.match(metrics, /reco_guardrail_circuit_open_total\{mode="main_path"\} 1/);
  assert.match(metrics, /reco_competitors_same_brand_rate 0\.5\b/);
  assert.match(metrics, /reco_competitors_on_page_source_rate 0\.25\b/);
  assert.match(metrics, /reco_explanation_alignment_at3 0\.8\b/);
});

test('vision metrics: dogfood reco feedback/interleave/exploration/async counters are exported', () => {
  resetVisionMetrics();
  recordRecoEmployeeFeedback({
    block: 'competitors',
    feedbackType: 'relevant',
    mode: 'main_path',
  });
  recordRecoInterleaveClick({
    block: 'dupes',
    attribution: 'A',
    mode: 'main_path',
  });
  recordRecoInterleaveWin({
    block: 'dupes',
    ranker: 'ranker_v1',
    categoryBucket: 'serum',
    priceBand: 'mid',
    mode: 'main_path',
  });
  recordRecoExplorationSlot({
    block: 'related_products',
    mode: 'main_path',
    delta: 2,
  });
  recordRecoAsyncUpdate({
    block: 'competitors',
    result: 'applied',
    mode: 'main_path',
    changedCount: 3,
  });

  const metrics = renderVisionMetricsPrometheus();
  assert.match(
    metrics,
    /reco_employee_feedback_total\{block="competitors",feedback_type="relevant",mode="main_path"\} 1/,
  );
  assert.match(
    metrics,
    /reco_interleave_click_total\{block="dupes",attribution="a",mode="main_path"\} 1/,
  );
  assert.match(
    metrics,
    /reco_interleave_win_total\{block="dupes",ranker="ranker_v1",category_bucket="serum",price_band="mid",mode="main_path"\} 1/,
  );
  assert.match(
    metrics,
    /reco_exploration_slot_total\{block="related_products",mode="main_path"\} 2/,
  );
  assert.match(
    metrics,
    /reco_async_update_total\{block="competitors",result="applied",mode="main_path"\} 1/,
  );
  assert.match(
    metrics,
    /reco_async_update_items_changed_count\{block="competitors",mode="main_path"\} 3/,
  );
});

test('vision metrics: social fetch counters and gauges are exported', () => {
  resetVisionMetrics();
  recordSocialFetchRequest({ mode: 'main_path' });
  recordSocialFetchRequest({ mode: 'sync_repair', delta: 2 });
  recordSocialFetchSuccess({ mode: 'main_path' });
  recordSocialFetchTimeout({ mode: 'sync_repair' });
  recordSocialKbBackfill({ mode: 'main_path' });
  setSocialCacheHitRate(0.66);
  setSocialChannelsCoverage(0.4);

  const metrics = renderVisionMetricsPrometheus();
  assert.match(metrics, /social_fetch_requests_total\{mode="main_path"\} 1/);
  assert.match(metrics, /social_fetch_requests_total\{mode="sync_repair"\} 2/);
  assert.match(metrics, /social_fetch_success_total\{mode="main_path"\} 1/);
  assert.match(metrics, /social_fetch_timeout_total\{mode="sync_repair"\} 1/);
  assert.match(metrics, /social_kb_backfill_total\{mode="main_path"\} 1/);
  assert.match(metrics, /social_cache_hit_rate 0\.66\b/);
  assert.match(metrics, /social_channels_coverage_gauge 0\.4\b/);
});

test('vision metrics: prelabel counters/gauges/histogram are exported', () => {
  resetVisionMetrics();
  recordPrelabelRequest({ block: 'competitors', mode: 'main_path', delta: 2 });
  recordPrelabelSuccess({ block: 'competitors', mode: 'main_path', delta: 1 });
  recordPrelabelInvalidJson({ block: 'competitors', mode: 'main_path', delta: 1 });
  recordPrelabelCacheHit({ block: 'competitors', mode: 'main_path', delta: 1 });
  recordSuggestionsGeneratedPerBlock({ block: 'competitors', mode: 'main_path', delta: 2 });
  recordQueueItemsServed({ block: 'competitors', delta: 3 });
  observePrelabelGeminiLatency({ latencyMs: 120 });
  observePrelabelGeminiLatency({ latencyMs: 640 });
  setPrelabelCacheHitRate(0.5);
  setLlmSuggestionOverturnedRate(0.25);

  const metrics = renderVisionMetricsPrometheus();
  assert.match(metrics, /prelabel_requests_total\{block="competitors",mode="main_path"\} 2/);
  assert.match(metrics, /prelabel_success_total\{block="competitors",mode="main_path"\} 1/);
  assert.match(metrics, /prelabel_invalid_json_total\{block="competitors",mode="main_path"\} 1/);
  assert.match(metrics, /prelabel_cache_hit_total\{block="competitors",mode="main_path"\} 1/);
  assert.match(metrics, /suggestions_generated_per_block\{block="competitors",mode="main_path"\} 2/);
  assert.match(metrics, /queue_items_served\{block="competitors"\} 3/);
  assert.match(metrics, /prelabel_cache_hit_rate 0\.5\b/);
  assert.match(metrics, /llm_suggestion_overturned_rate 0\.25\b/);
  assert.match(metrics, /prelabel_gemini_latency_ms_count 2/);
});

test('vision metrics: aurora skin flow counters and rates are exported', () => {
  resetVisionMetrics();
  recordAuroraSkinFlowMetric({ stage: 'analysis_request', hit: true, delta: 2 });
  recordAuroraSkinFlowMetric({ stage: 'artifact_created', hit: true, delta: 1 });
  recordAuroraSkinFlowMetric({ stage: 'ingredient_plan', hit: true, delta: 1 });
  recordAuroraSkinFlowMetric({ stage: 'reco_request', hit: true, delta: 4 });
  recordAuroraSkinFlowMetric({ stage: 'reco_generated', hit: true, delta: 3 });
  recordAuroraSkinFlowMetric({ stage: 'reco_low_confidence', hit: true, delta: 1 });
  recordAuroraSkinFlowMetric({ stage: 'reco_safety_block', hit: true, delta: 1 });
  recordAuroraSkinFlowMetric({ stage: 'reco_timeout_degraded', hit: true, delta: 1 });
  recordAuroraSkinFlowMetric({ stage: 'analysis_timeout_degraded', hit: true, delta: 1 });

  const metrics = renderVisionMetricsPrometheus();
  assert.match(metrics, /aurora_skin_flow_total\{stage="analysis_request",outcome="hit"\} 2/);
  assert.match(metrics, /aurora_skin_flow_total\{stage="artifact_created",outcome="hit"\} 1/);
  assert.match(metrics, /aurora_skin_flow_total\{stage="reco_request",outcome="hit"\} 4/);
  assert.match(metrics, /aurora_skin_flow_total\{stage="reco_generated",outcome="hit"\} 3/);
  assert.match(metrics, /aurora_skin_reco_generated_rate 0\.75\b/);
  assert.match(metrics, /aurora_skin_reco_low_confidence_rate 0\.25\b/);
  assert.match(metrics, /aurora_skin_reco_safety_block_rate 0\.25\b/);
  assert.match(metrics, /aurora_skin_reco_timeout_degraded_rate 0\.25\b/);
  assert.match(metrics, /aurora_skin_artifact_created_rate 0\.5\b/);
  assert.match(metrics, /aurora_skin_ingredient_plan_rate 0\.5\b/);
  assert.match(metrics, /aurora_skin_analysis_timeout_degraded_rate 0\.5\b/);
});
