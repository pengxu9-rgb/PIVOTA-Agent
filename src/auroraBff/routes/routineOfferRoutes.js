const axios = require('axios');

function ensureFunction(name, value) {
  if (typeof value === 'function') return value;
  throw new Error(`aurora routine/offer routes missing dependency: ${name}`);
}

function ensureSchema(name, value) {
  if (value && typeof value.safeParse === 'function') return value;
  throw new Error(`aurora routine/offer routes missing schema: ${name}`);
}

function mountRoutineOfferRoutes(app, deps = {}) {
  const buildRequestContext = ensureFunction('buildRequestContext', deps.buildRequestContext);
  const requireAuroraUid = ensureFunction('requireAuroraUid', deps.requireAuroraUid);
  const buildEnvelope = ensureFunction('buildEnvelope', deps.buildEnvelope);
  const makeAssistantMessage = ensureFunction('makeAssistantMessage', deps.makeAssistantMessage);
  const makeEvent = ensureFunction('makeEvent', deps.makeEvent);
  const simulateConflicts = ensureFunction('simulateConflicts', deps.simulateConflicts);
  const buildHeatmapStepsFromRoutine = ensureFunction(
    'buildHeatmapStepsFromRoutine',
    deps.buildHeatmapStepsFromRoutine,
  );
  const buildConflictHeatmapV1 = ensureFunction('buildConflictHeatmapV1', deps.buildConflictHeatmapV1);
  const applyOfferItemPdpOpenContract = ensureFunction(
    'applyOfferItemPdpOpenContract',
    deps.applyOfferItemPdpOpenContract,
  );
  const mapOfferResolveFailureCode = ensureFunction(
    'mapOfferResolveFailureCode',
    deps.mapOfferResolveFailureCode,
  );
  const summarizeOfferPdpOpen = ensureFunction('summarizeOfferPdpOpen', deps.summarizeOfferPdpOpen);
  const schedulePdpCorePrefetchFromItems = ensureFunction(
    'schedulePdpCorePrefetchFromItems',
    deps.schedulePdpCorePrefetchFromItems,
  );

  const RoutineSimulateRequestSchema = ensureSchema(
    'RoutineSimulateRequestSchema',
    deps.RoutineSimulateRequestSchema,
  );
  const OffersResolveRequestSchema = ensureSchema(
    'OffersResolveRequestSchema',
    deps.OffersResolveRequestSchema,
  );
  const AffiliateOutcomeRequestSchema = ensureSchema(
    'AffiliateOutcomeRequestSchema',
    deps.AffiliateOutcomeRequestSchema,
  );

  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;
  const useAuroraBffMock = deps.USE_AURORA_BFF_MOCK === true;
  const pivotaBackendBaseUrl =
    typeof deps.PIVOTA_BACKEND_BASE_URL === 'string' ? deps.PIVOTA_BACKEND_BASE_URL.trim() : '';
  const conflictHeatmapEnabled = deps.CONFLICT_HEATMAP_V1_ENABLED === true;

  app.post('/v1/routine/simulate', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RoutineSimulateRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'BAD_REQUEST', details: parsed.error.format() },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const routine = parsed.data.routine || {};
      const testProduct = parsed.data.test_product || null;
      const sim = simulateConflicts({ routine, testProduct, language: ctx.lang });
      const heatmapSteps = buildHeatmapStepsFromRoutine(routine, { testProduct });
      const heatmapPayload = conflictHeatmapEnabled
        ? buildConflictHeatmapV1({
            routineSimulation: { safe: sim.safe, conflicts: sim.conflicts, summary: sim.summary },
            routineSteps: heatmapSteps,
          })
        : { schema_version: 'aurora.ui.conflict_heatmap.v1' };

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `sim_${ctx.request_id}`,
            type: 'routine_simulation',
            payload: { safe: sim.safe, conflicts: sim.conflicts, summary: sim.summary },
          },
          {
            card_id: `heatmap_${ctx.request_id}`,
            type: 'conflict_heatmap',
            payload: heatmapPayload,
          },
        ],
        session_patch: {},
        events: [
          makeEvent(ctx, 'simulate_conflict', { safe: sim.safe, conflicts: sim.conflicts.length }),
          ...(conflictHeatmapEnabled
            ? [
                makeEvent(ctx, 'aurora_conflict_heatmap_impression', {
                  schema_version: heatmapPayload.schema_version,
                  state: heatmapPayload.state,
                  num_steps: Array.isArray(heatmapPayload.axes?.rows?.items)
                    ? heatmapPayload.axes.rows.items.length
                    : 0,
                  num_cells_nonzero: Array.isArray(heatmapPayload.cells?.items)
                    ? heatmapPayload.cells.items.length
                    : 0,
                  num_unmapped_conflicts: Array.isArray(heatmapPayload.unmapped_conflicts)
                    ? heatmapPayload.unmapped_conflicts.length
                    : 0,
                  max_severity: Math.max(
                    0,
                    ...((Array.isArray(heatmapPayload.cells?.items)
                      ? heatmapPayload.cells.items
                      : []
                    ).map((c) => Number(c?.severity) || 0)),
                    ...((Array.isArray(heatmapPayload.unmapped_conflicts)
                      ? heatmapPayload.unmapped_conflicts
                      : []
                    ).map((c) => Number(c?.severity) || 0)),
                  ),
                  routine_simulation_safe: Boolean(sim.safe),
                  routine_conflict_count: sim.conflicts.length,
                  trigger_source: ctx.trigger_source,
                }),
              ]
            : []),
        ],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn?.({ err: err.message }, 'routine simulate failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to simulate routine.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'SIMULATE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'SIMULATE_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });

  app.post('/v1/offers/resolve', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = OffersResolveRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'BAD_REQUEST', details: parsed.error.format() },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const market = String(parsed.data.market || 'US').trim() || 'US';
      const items = parsed.data.items;
      const resolved = [];
      const fieldMissing = [];

      for (const item of items) {
        const itemStartedAt = Date.now();
        const itemElapsedMs = () => Math.max(0, Date.now() - itemStartedAt);
        const product = item.product;
        const offer = item.offer;
        const url = offer && (offer.affiliate_url || offer.affiliateUrl || offer.url);

        if (useAuroraBffMock) {
          const nextItem = applyOfferItemPdpOpenContract(
            {
              product: { ...product, image_url: product.image_url || 'https://img.example.com/mock.jpg' },
              offer: {
                ...offer,
                price: typeof offer.price === 'number' && offer.price > 0 ? offer.price : 12.34,
                currency: offer.currency || 'USD',
              },
            },
            { timeToPdpMs: itemElapsedMs() },
          );
          resolved.push(nextItem);
          continue;
        }

        if (!url) {
          resolved.push(applyOfferItemPdpOpenContract(item, { timeToPdpMs: itemElapsedMs() }));
          fieldMissing.push({ field: 'offer.affiliate_url', reason: 'missing_affiliate_url' });
          continue;
        }
        if (!pivotaBackendBaseUrl) {
          resolved.push(applyOfferItemPdpOpenContract(item, { timeToPdpMs: itemElapsedMs() }));
          fieldMissing.push({ field: 'offer.snapshot', reason: 'pivota_backend_not_configured' });
          continue;
        }

        try {
          const resp = await axios.post(
            `${pivotaBackendBaseUrl}/api/offers/external/resolve`,
            { market, url, forceRefresh: false },
            { timeout: 12000, validateStatus: () => true },
          );
          if (resp.status !== 200 || !resp.data || !resp.data.ok || !resp.data.offer) {
            const failReason = mapOfferResolveFailureCode({
              responseBody: resp?.data,
              statusCode: resp?.status,
            });
            resolved.push(
              applyOfferItemPdpOpenContract(item, {
                failReasonCode: failReason,
                resolveAttempted: true,
                timeToPdpMs: itemElapsedMs(),
              }),
            );
            fieldMissing.push({
              field: 'offer.snapshot',
              reason:
                failReason === 'db_error'
                  ? 'external_offer_resolve_db_error'
                  : 'external_offer_resolve_failed',
            });
            continue;
          }

          const snap = resp.data.offer;
          const patchedProduct = { ...product };
          const patchedOffer = { ...offer };

          if (snap.imageUrl) patchedProduct.image_url = snap.imageUrl;
          if (snap.title && !patchedProduct.name) patchedProduct.name = snap.title;
          if (snap.brand && !patchedProduct.brand) patchedProduct.brand = snap.brand;
          if (snap.price && typeof snap.price === 'object') {
            if (typeof snap.price.amount === 'number') patchedOffer.price = snap.price.amount;
            if (typeof snap.price.currency === 'string') patchedOffer.currency = snap.price.currency;
          }
          if (snap.canonicalUrl) patchedOffer.affiliate_url = snap.canonicalUrl;

          resolved.push(
            applyOfferItemPdpOpenContract(
              { ...item, product: patchedProduct, offer: patchedOffer },
              { resolveAttempted: true, timeToPdpMs: itemElapsedMs() },
            ),
          );
        } catch (err) {
          const failReason = mapOfferResolveFailureCode({ error: err });
          resolved.push(
            applyOfferItemPdpOpenContract(item, {
              failReasonCode: failReason,
              resolveAttempted: true,
              timeToPdpMs: itemElapsedMs(),
            }),
          );
          fieldMissing.push({
            field: 'offer.snapshot',
            reason:
              failReason === 'db_error'
                ? 'external_offer_resolve_db_error'
                : 'external_offer_resolve_timeout_or_network',
          });
        }
      }

      const offersPdpMeta = summarizeOfferPdpOpen(resolved);
      schedulePdpCorePrefetchFromItems(resolved, {
        logger,
        reason: 'offers_resolved',
      });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `offers_${ctx.request_id}`,
            type: 'offers_resolved',
            payload: {
              items: resolved,
              market,
              metadata: {
                pdp_open_path_stats: offersPdpMeta.path_stats,
                fail_reason_counts: offersPdpMeta.fail_reason_counts,
                time_to_pdp_ms_stats: offersPdpMeta.time_to_pdp_ms_stats,
              },
            },
            ...(fieldMissing.length ? { field_missing: fieldMissing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [
          makeEvent(ctx, 'offers_resolved', {
            count: resolved.length,
            market,
            pdp_open_path_stats: offersPdpMeta.path_stats,
            fail_reason_counts: offersPdpMeta.fail_reason_counts,
            time_to_pdp_ms_stats: offersPdpMeta.time_to_pdp_ms_stats,
          }),
        ],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn?.({ err: err.message }, 'offers resolve failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to resolve offers.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: { error: 'OFFERS_RESOLVE_FAILED' },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'OFFERS_RESOLVE_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });

  app.post('/v1/affiliate/outcome', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AffiliateOutcomeRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'BAD_REQUEST', details: parsed.error.format() },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [{ card_id: `out_${ctx.request_id}`, type: 'affiliate_outcome', payload: parsed.data }],
        session_patch: {},
        events: [makeEvent(ctx, 'outbound_opened', { outcome: parsed.data.outcome, url: parsed.data.url || null })],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn?.({ err: err.message }, 'affiliate outcome failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to record outcome.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'OUTCOME_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'OUTCOME_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });
}

module.exports = {
  mountRoutineOfferRoutes,
};
