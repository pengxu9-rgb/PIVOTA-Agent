const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');
const { buildChatCardsResponse } = require('../src/auroraBff/chatCardsAssembler');
const { isRecommendationLikeText } = require('../src/auroraBff/languageIntentLexicon');
const { shouldKeepTypedRecoRequestOnV1Mainline } = require('../src/auroraBff/recoOwnershipPolicy');

function loadRoutesWithEnv(overrides = {}) {
  const routeModulePath = require.resolve('../src/auroraBff/routes');
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[routeModulePath];
  try {
    return require('../src/auroraBff/routes');
  } finally {
    delete require.cache[routeModulePath];
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('reco contract maps effective_failure_class=none to artifact_missing surface fields', () => {
  const contract = __internal.buildRecoMainlineContract({
    recommendations: [],
    sourceMode: 'rules_only',
    source: 'rules_only',
    entryType: 'chat',
    effectiveFailureClass: 'none',
    failureOrigin: 'none',
    terminalSuccess: false,
    viablePoolStrength: 'empty',
  });

  assert.equal(contract.primary_failure_reason, 'artifact_missing');
  assert.equal(contract.surface_reason, 'artifact_missing');
  assert.equal(contract.products_empty_reason, 'artifact_missing');
  assert.equal(contract.telemetry_failure_reason, null);
  assert.equal(contract.upstream_status, 'artifact_missing');
  assert.equal(contract.failure_class, null);
});

test('reco failure helper collapses none sentinel to artifact_missing fallback', () => {
  const failure = __internal.resolveRecoFailureReasonContract({
    contract: {
      primary_failure_reason: 'none',
      surface_reason: 'none',
      telemetry_failure_reason: 'none',
      upstream_status: 'artifact_missing',
    },
  });

  assert.equal(failure.userFacingReason, 'artifact_missing');
  assert.equal(failure.primaryReason, 'artifact_missing');
  assert.equal(failure.surfaceReason, 'artifact_missing');
  assert.equal(failure.productsEmptyReason, 'artifact_missing');
  assert.equal(failure.telemetryReason, '');
});

test('centralized reco failure mapping also collapses none sentinel to artifact_missing', () => {
  const { __internal: centralInternal } = loadRoutesWithEnv({
    AURORA_BFF_RECO_CENTRALIZED_FAILURE_MAPPING_ENABLED: 'true',
  });
  const contract = centralInternal.buildRecoMainlineContract({
    recommendations: [],
    sourceMode: 'rules_only',
    source: 'rules_only',
    entryType: 'chat',
    effectiveFailureClass: 'none',
    failureOrigin: 'none',
    terminalSuccess: false,
    viablePoolStrength: 'empty',
  });

  assert.equal(contract.primary_failure_reason, 'artifact_missing');
  assert.equal(contract.surface_reason, 'artifact_missing');
  assert.equal(contract.products_empty_reason, 'artifact_missing');
  assert.equal(contract.telemetry_failure_reason, null);
  assert.equal(contract.upstream_status, 'artifact_missing');
  assert.equal(contract.mainline_status, 'severe_parse_or_prompt_failure');
});

test('attachRecoContractMeta strips none sentinel from client-visible reco metadata', () => {
  const payload = __internal.attachRecoContractMeta(
    {
      recommendations: [],
      recommendation_meta: {
        primary_failure_reason: 'none',
        surface_reason: 'none',
        telemetry_failure_reason: 'none',
      },
    },
    {
      primary_failure_reason: 'none',
      surface_reason: 'none',
      telemetry_failure_reason: 'none',
      upstream_status: 'artifact_missing',
      mainline_status: 'severe_parse_or_prompt_failure',
    },
  );

  assert.equal(payload.recommendation_meta.primary_failure_reason, 'artifact_missing');
  assert.equal(payload.recommendation_meta.surface_reason, 'artifact_missing');
  assert.ok(!('telemetry_failure_reason' in payload.recommendation_meta));
  assert.equal(payload.recommendation_meta.upstream_status, 'artifact_missing');
});

test('buildRecoRequestedEventData keeps artifact_missing and never leaks none sentinel', () => {
  const eventData = __internal.buildRecoRequestedEventData({
    payload: {
      recommendations: [],
      recommendation_meta: {
        primary_failure_reason: 'none',
        surface_reason: 'none',
        telemetry_failure_reason: 'none',
        mainline_status: 'severe_parse_or_prompt_failure',
        upstream_status: 'artifact_missing',
      },
    },
    source: 'rules_only',
  });

  assert.equal(eventData.reason, 'artifact_missing');
  assert.equal(eventData.surface_reason, 'artifact_missing');
  assert.ok(!('telemetry_reason' in eventData));
  assert.ok(!('failure_class' in eventData));
});

test('applyRecoContractToRecoRequestedEvents emits artifact_missing instead of none in recos_requested', () => {
  const out = __internal.applyRecoContractToRecoRequestedEvents([], {
    primary_failure_reason: 'none',
    surface_reason: 'none',
    telemetry_failure_reason: 'none',
    upstream_status: 'artifact_missing',
    mainline_status: 'severe_parse_or_prompt_failure',
    source_mode: 'rules_only',
  }, {
    ctx: { request_id: 'req_reco_cleanup', trace_id: 'trace_reco_cleanup' },
    emitIfMissing: true,
    eventData: {
      explicit: true,
      reason: 'none',
      telemetry_reason: 'none',
      source: 'rules_only',
    },
  });

  assert.equal(out.hasRecoRequested, true);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].event_name, 'recos_requested');
  assert.equal(out.events[0].data.reason, 'artifact_missing');
  assert.equal(out.events[0].data.surface_reason, 'artifact_missing');
  assert.ok(!('telemetry_reason' in out.events[0].data));
});

test('buildConfidenceNoticeCardPayload filters none rationale tokens', () => {
  const payload = __internal.buildConfidenceNoticeCardPayload({
    language: 'EN',
    reason: 'artifact_missing',
    confidence: {
      score: 0,
      level: 'low',
      rationale: ['none', 'artifact_missing'],
    },
    actions: ['retry_recommendations'],
  });

  assert.equal(payload.reason, 'artifact_missing');
  assert.deepEqual(payload.confidence.rationale, ['artifact_missing']);
});

test('confidence notices do not expose fallback or internal planner wording', () => {
  const timeoutPayload = __internal.buildConfidenceNoticeCardPayload({
    language: 'EN',
    reason: 'upstream_timeout_primary_role',
    confidence: { score: 0.3, level: 'low', rationale: ['upstream_timeout_primary_role'] },
  });
  const plannerPayload = __internal.buildConfidenceNoticeCardPayload({
    language: 'EN',
    reason: 'planner_untrusted',
    confidence: { score: 0.3, level: 'low', rationale: ['planner_untrusted'] },
  });
  const noRecallPayload = __internal.buildConfidenceNoticeCardPayload({
    language: 'EN',
    reason: 'no_recall_from_planned_sources',
    confidence: { score: 0.3, level: 'low', rationale: ['no_recall_from_planned_sources'] },
  });

  assert.doesNotMatch(timeoutPayload.message, /retrieval chain|fallback|non-primary|\bmost\b/i);
  assert.doesNotMatch(plannerPayload.message, /owner|fallback|semantic planner/i);
  assert.doesNotMatch(noRecallPayload.message, /care framework|mainline|authority-grounded|fallback/i);
});

test('travel gear shopping is isolated from travel skincare env routing', () => {
  assert.equal(
    __internal.looksLikeTravelGearShoppingRequest('I need a carry-on suitcase under $200 for a work trip.'),
    true,
  );
  assert.equal(
    __internal.looksLikeWeatherOrEnvironmentQuestion('I need a carry-on suitcase under $200 for a work trip.'),
    false,
  );
  assert.equal(
    __internal.looksLikeWeatherOrEnvironmentQuestion('I fly from Seattle to Seoul next Monday; how should I adjust skincare for the weather?'),
    true,
  );
});

test('beauty concern asks with broader concern language stay recommendation-like', () => {
  const prompts = [
    'I sleep late a lot and my skin looks dull. What should I add?',
    'I have blackheads and clogged pores around my nose. What should I use first?',
    'I started adapalene and now my skin is peeling. What should I use tonight?',
    'My face gets red and stings after cleansing. What product should I use?',
  ];

  for (const message of prompts) {
    assert.equal(isRecommendationLikeText(message), true, message);
    assert.equal(
      shouldKeepTypedRecoRequestOnV1Mainline({ message }),
      true,
      `mainline ownership failed for: ${message}`,
    );
  }
});

test('local external seed support search has a bounded timeout', async () => {
  const result = await __internal.searchLocalExternalSeedProducts({
    query: 'barrier moisturizer sensitive skin',
    limit: 3,
    role: { rank: 2, preferred_step: 'moisturizer' },
    queryTimeoutMs: 25,
    queryFn: () => new Promise(() => {}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
  assert.equal(result.local_external_seed_search_timed_out, true);
});

test('local external seed primary search does not treat null timeout as zero', async () => {
  const startedAt = Date.now();
  const result = await __internal.searchLocalExternalSeedProducts({
    query: 'spf fluid oily skin',
    limit: 3,
    role: { rank: 1, preferred_step: 'sunscreen' },
    queryTimeoutMs: null,
    queryFn: () => new Promise(() => {}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
  assert.equal(result.local_external_seed_search_timed_out, true);
  assert.ok(Date.now() - startedAt >= 750);
  assert.ok(Number(result.local_external_seed_search_timeout_ms) >= 800);
});

test('alternatives visible authority filter hides unresolved rows once grounded rows exist', () => {
  const result = __internal.filterRecoAlternativesVisibleAuthorityRows([
    {
      candidate_origin: 'pool',
      grounding_status: 'catalog_verified',
      product: {
        product_id: 'grounded_1',
        merchant_id: 'merchant_1',
        name: 'Grounded Serum',
        brand: 'Grounded Brand',
      },
      reasons: ['Comparable serum role with catalog identity.'],
      tradeoff_notes: ['Compare texture and price before swapping.'],
    },
    {
      candidate_origin: 'open_world',
      grounding_status: 'name_only',
      product: { name: 'Unresolved Serum', brand: 'Unresolved Brand' },
      reasons: ['Same treatment step as the anchor.'],
      tradeoff_notes: ['Key formula details still need verification before comparing actives or finish.'],
    },
  ], { minGrounded: 2 });

  assert.equal(result.alternatives.length, 1);
  assert.equal(result.alternatives[0].product.product_id, 'grounded_1');
  assert.equal(result.hidden_unresolved_count, 1);
  assert.equal(result.visible_authority_only_filter_applied, true);
});

test('open-world conservative copy does not expose old weak fallback phrases', () => {
  const row = __internal.sanitizeOpenWorldAlternativeVisibleCopy(
    {
      candidate_origin: 'open_world',
      grounding_status: 'name_only',
      product: {
        name: 'Candidate Serum',
        brand: 'Candidate Brand',
        category: 'serum',
      },
    },
    { targetSignals: { usageRole: 'treatment_serum' }, mode: 'name_only' },
  );

  const visibleCopy = [
    ...row.reasons,
    ...row.tradeoff_notes,
  ].join(' ');

  assert.doesNotMatch(visibleCopy, /Same .* step as the anchor/i);
  assert.doesNotMatch(visibleCopy, /distinct option for this compare/i);
  assert.doesNotMatch(visibleCopy, /Key formula details still need verification/i);
  assert.match(visibleCopy, /Tentative treatment serum match/i);
  assert.match(visibleCopy, /not confirmed here/i);
});

test('chatCardsAssembler sanitizes derived ops experiment events from envelope events', () => {
  const out = buildChatCardsResponse({
    envelope: {
      request_id: 'req_chatcards_cleanup',
      trace_id: 'trace_chatcards_cleanup',
      assistant_message: { role: 'assistant', content: 'test' },
      cards: [
        {
          card_id: 'conf_cleanup',
          type: 'confidence_notice',
          payload: {
            reason: 'artifact_missing',
          },
        },
      ],
      suggested_chips: [],
      session_patch: {},
      events: [
        {
          event_name: 'recos_requested',
          data: {
            explicit: true,
            source: 'rules_only',
            reason: 'none',
            telemetry_reason: 'none',
            surface_reason: 'none',
            products_empty_reason: 'none',
            failure_class: 'none',
            effective_failure_class: 'none',
            failure_origin: 'none',
            upstream_status: 'artifact_missing',
          },
        },
      ],
    },
    ctx: {
      request_id: 'req_chatcards_cleanup',
      trace_id: 'trace_chatcards_cleanup',
      lang: 'EN',
      ui_lang: 'EN',
      match_lang: 'EN',
    },
    intent: 'recommend_products',
    intentConfidence: 1,
    entities: [],
    safetyDecision: null,
    threadOps: [],
  });

  const recoEvent = Array.isArray(out.ops?.experiment_events)
    ? out.ops.experiment_events.find((evt) => evt && evt.event_type === 'recos_requested')
    : null;

  assert.ok(recoEvent);
  assert.equal(recoEvent.event_data.reason, 'artifact_missing');
  assert.equal(recoEvent.event_data.surface_reason, 'artifact_missing');
  assert.ok(!('telemetry_reason' in recoEvent.event_data));
  assert.ok(!('products_empty_reason' in recoEvent.event_data));
  assert.ok(!('failure_class' in recoEvent.event_data));
  assert.ok(!('effective_failure_class' in recoEvent.event_data));
  assert.ok(!('failure_origin' in recoEvent.event_data));
});

test('chatCardsAssembler sanitizes session patch experiment events before exposing ops mirror', () => {
  const out = buildChatCardsResponse({
    envelope: {
      request_id: 'req_chatcards_patch_cleanup',
      trace_id: 'trace_chatcards_patch_cleanup',
      assistant_message: { role: 'assistant', content: 'test' },
      cards: [
        {
          card_id: 'conf_patch_cleanup',
          type: 'confidence_notice',
          payload: {
            reason: 'artifact_missing',
          },
        },
      ],
      suggested_chips: [],
      session_patch: {
        experiment_events: [
          {
            event_type: 'recos_requested',
            event_data: {
              reason: 'none',
              telemetry_reason: 'none',
              surface_reason: 'none',
              products_empty_reason: 'none',
              failure_class: 'none',
              effective_failure_class: 'none',
              failure_origin: 'none',
              upstream_status: 'artifact_missing',
            },
          },
        ],
      },
      events: [],
    },
    ctx: {
      request_id: 'req_chatcards_patch_cleanup',
      trace_id: 'trace_chatcards_patch_cleanup',
      lang: 'EN',
      ui_lang: 'EN',
      match_lang: 'EN',
    },
    intent: 'recommend_products',
    intentConfidence: 1,
    entities: [],
    safetyDecision: null,
    threadOps: [],
  });

  const recoEvent = Array.isArray(out.ops?.experiment_events)
    ? out.ops.experiment_events.find((evt) => evt && evt.event_type === 'recos_requested')
    : null;

  assert.ok(recoEvent);
  assert.equal(recoEvent.event_data.reason, 'artifact_missing');
  assert.equal(recoEvent.event_data.surface_reason, 'artifact_missing');
  assert.ok(!('telemetry_reason' in recoEvent.event_data));
  assert.ok(!('products_empty_reason' in recoEvent.event_data));
  assert.ok(!('failure_class' in recoEvent.event_data));
  assert.ok(!('effective_failure_class' in recoEvent.event_data));
  assert.ok(!('failure_origin' in recoEvent.event_data));
});
