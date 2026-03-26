const { createChatCatalogAvailabilityRuntime } = require('../src/auroraBff/chatCatalogAvailabilityRuntime');

function buildHarness(overrides = {}) {
  const summarizeChatProfileForContext = jest.fn((profile) => (
    profile ? { skinType: profile.skinType || null, region: profile.region || null } : null
  ));
  const logger = {
    info: jest.fn(),
  };
  const runtime = createChatCatalogAvailabilityRuntime({
    logger,
    AURORA_CATALOG_DOMAIN_GUARD_V1_ENABLED: true,
    detectCatalogAvailabilityIntent: jest.fn((message) => (
      /winona/i.test(String(message || ''))
        ? { brand_id: 'brand_winona', brand_name: 'Winona', matched_alias: 'Winona', reason: 'brand_name' }
        : null
    )),
    shouldAllowCatalogAvailabilityShortCircuit: jest.fn(() => true),
    detectCatalogAvailabilityShortCircuitBlockReason: jest.fn(() => ''),
    recordCatalogAvailabilityShortCircuit: jest.fn(),
    buildAvailabilityCatalogQuery: jest.fn(() => 'Winona serum'),
    isSpecificAvailabilityQuery: jest.fn(() => true),
    buildBrandPlaceholderProduct: jest.fn(({ brandId, brandName }) => ({
      product_id: `placeholder_${brandId}`,
      merchant_id: 'placeholder_mid',
      name: brandName,
    })),
    PIVOTA_BACKEND_BASE_URL: 'https://pivota.test',
    searchPivotaBackendProducts: jest.fn(async () => ({
      ok: true,
      products: [{ product_id: 'prod_1', merchant_id: 'm_1', name: 'Winona Serum' }],
      reason: null,
    })),
    CATALOG_AVAIL_SEARCH_TIMEOUT_MS: 800,
    CATALOG_AVAIL_RESOLVE_FALLBACK_ENABLED: true,
    CATALOG_AVAIL_RESOLVE_FALLBACK_ON_TRANSIENT: true,
    resolveAvailabilityProductByQuery: jest.fn(async () => ({
      ok: true,
      product: { product_id: 'prod_resolve', merchant_id: 'm_resolve', name: 'Resolved Serum' },
      resolve_reason_code: 'resolver_hit',
    })),
    RECO_PDP_STRICT_INTERNAL_FIRST: true,
    resolveAvailabilityProductByLocalResolver: jest.fn(async () => ({
      ok: true,
      product: { product_id: 'prod_local', merchant_id: 'm_local', name: 'Local Serum' },
      resolve_reason_code: 'local_hit',
    })),
    isSkincareCatalogProduct: jest.fn(() => true),
    recordCatalogPoisonBlock: jest.fn(),
    applyOfferItemPdpOpenContract: jest.fn(({ product }) => ({
      product_id: product.product_id,
      metadata: { pdp_open_path: 'internal' },
      pdp_open: { product_ref: { product_id: product.product_id, merchant_id: product.merchant_id } },
    })),
    summarizeOfferPdpOpen: jest.fn(() => ({
      path_stats: { internal: 1 },
      fail_reason_counts: {},
      time_to_pdp_ms_stats: { min: 0, max: 0 },
    })),
    applyCommerceMedicalClaimGuard: jest.fn((text) => text),
    stateChangeAllowed: jest.fn(() => true),
    recordSessionPatchProfileEmitted: jest.fn(),
    ...overrides,
  });

  const buildEnvelope = jest.fn((_ctx, payload) => payload);
  const makeChatAssistantMessage = jest.fn((content) => ({ content }));
  const makeEvent = jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, data: eventData }));

  return {
    runtime,
    logger,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
    summarizeChatProfileForContext,
  };
}

describe('aurora chat catalog availability runtime', () => {
  test('returns search-backed availability envelope with commerce cards', async () => {
    const { runtime, buildEnvelope, makeChatAssistantMessage, makeEvent, summarizeChatProfileForContext } = buildHarness();

    const envelope = await runtime.maybeBuildCatalogAvailabilityEnvelope({
      ctx: { request_id: 'req_1', lang: 'EN', trigger_source: 'text' },
      message: 'Do you have Winona serum in stock?',
      profile: { skinType: 'oily', region: 'us' },
      appliedProfilePatch: { skinType: 'oily' },
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      summarizeChatProfileForContext,
    });

    expect(buildEnvelope).toHaveBeenCalled();
    expect(makeChatAssistantMessage).toHaveBeenCalled();
    expect(envelope.cards.map((card) => card.type)).toEqual(['product_parse', 'offers_resolved']);
    expect(envelope.session_patch).toEqual({
      profile: { skinType: 'oily', region: 'us' },
    });
    expect(envelope.events).toEqual([
      {
        event_name: 'catalog_availability_shortcircuit',
        data: expect.objectContaining({
          brand_id: 'brand_winona',
          ok: true,
          resolved_via: 'products_search',
          specific_query: true,
        }),
      },
    ]);
  });

  test('falls back to resolve path on transient search miss', async () => {
    const searchPivotaBackendProducts = jest.fn(async () => ({
      ok: false,
      products: [],
      reason: 'upstream_timeout',
    }));
    const resolveAvailabilityProductByQuery = jest.fn(async () => ({
      ok: true,
      product: { product_id: 'prod_resolve', merchant_id: 'm_resolve', name: 'Resolved Serum' },
      resolve_reason_code: 'resolver_hit',
    }));
    const { runtime, buildEnvelope, makeChatAssistantMessage, makeEvent, summarizeChatProfileForContext } = buildHarness({
      searchPivotaBackendProducts,
      resolveAvailabilityProductByQuery,
    });

    const envelope = await runtime.maybeBuildCatalogAvailabilityEnvelope({
      ctx: { request_id: 'req_2', lang: 'EN', trigger_source: 'text' },
      message: 'Winona serum availability?',
      profile: { skinType: 'oily' },
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      summarizeChatProfileForContext,
    });

    expect(searchPivotaBackendProducts).toHaveBeenCalled();
    expect(resolveAvailabilityProductByQuery).toHaveBeenCalled();
    expect(envelope.events[0]).toEqual({
      event_name: 'catalog_availability_shortcircuit',
      data: expect.objectContaining({
        catalog_reason: 'upstream_timeout',
        resolved_via: 'products_resolve',
      }),
    });
  });

  test('returns null when domain guard blocks the short-circuit', async () => {
    const logger = { info: jest.fn() };
    const { runtime, buildEnvelope, makeChatAssistantMessage, makeEvent, summarizeChatProfileForContext } = buildHarness({
      logger,
      shouldAllowCatalogAvailabilityShortCircuit: jest.fn(() => false),
      detectCatalogAvailabilityShortCircuitBlockReason: jest.fn(() => 'ingredient_intent'),
    });

    const envelope = await runtime.maybeBuildCatalogAvailabilityEnvelope({
      ctx: { request_id: 'req_3', trace_id: 'trace_3', lang: 'EN', trigger_source: 'text' },
      message: 'Can I use retinol and do you have Winona?',
      profile: { skinType: 'oily' },
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      summarizeChatProfileForContext,
    });

    expect(envelope).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      {
        request_id: 'req_3',
        trace_id: 'trace_3',
        catalog_availability_shortcircuit_block_reason: 'ingredient_intent',
      },
      'aurora bff: catalog availability short-circuit blocked',
    );
  });
});
