'use strict';

const { applyDupeCompareQualityGate } = require('../qualityGates/dupeCompareGate');
const { buildProductInputText } = require('../mappers/dupeSuggestMapper');

/**
 * Execute the dupe_compare orchestration.
 *
 * This usecase extracts the core compare flow from routes.js and delegates
 * the heavy inner logic (parseOne, compareQuery, deep-scan fallback) to
 * an injected `executeCompareInner` service.  This lets routes.js become thin
 * while the inner logic can be migrated incrementally.
 *
 * @param {object} options
 * @param {object} options.ctx
 * @param {object} options.input          – validated DupeCompareRequestSchema output
 * @param {object} options.services       – { resolveIdentity, getProfileForIdentity, getRecentSkinLogsForIdentity,
 *                                            summarizeProfileForContext, executeCompareInner }
 * @param {object} [options.logger]
 *
 * executeCompareInner(ctx, { originalInput, dupeInput, originalObj, dupeObj, originalUrl, dupeUrl, profileSummary, recentLogs, logger })
 *   → { payload, field_missing }   (final dupe_compare payload BEFORE quality gate)
 *
 * Returns: { ok, payload, field_missing, event_kind, quality_gated }
 */
async function executeDupeCompare({ ctx, input, services, logger }) {
  const {
    resolveIdentity,
    getProfileForIdentity,
    getRecentSkinLogsForIdentity,
    summarizeProfileForContext,
    executeCompareInner,
  } = services;

  const originalInput = buildProductInputText(input.original, input.original_url);
  const dupeInput = buildProductInputText(input.dupe, input.dupe_url);

  if (!originalInput || !dupeInput) {
    const missingFields = [];
    if (!originalInput) missingFields.push('original');
    if (!dupeInput) missingFields.push('dupe');
    return {
      ok: false,
      status_code: 400,
      error_code: 'BAD_REQUEST',
      error_details: missingFields.length === 1 ? `${missingFields[0]} is required` : 'original and dupe are required',
      payload: null,
      event_kind: 'error',
    };
  }

  const identity = await resolveIdentity();
  const profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }).catch(() => null);
  const recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7).catch(() => []);
  const profileSummary = summarizeProfileForContext(profile);

  const innerResult = await executeCompareInner(ctx, {
    originalInput,
    dupeInput,
    originalObj: input.original || null,
    dupeObj: input.dupe || null,
    originalUrl: input.original_url || null,
    dupeUrl: input.dupe_url || null,
    profileSummary,
    recentLogs,
    logger,
  });

  // Apply quality gate
  const gateResult = applyDupeCompareQualityGate(innerResult.payload, { lang: ctx.lang });
  const finalPayload = gateResult.payload;
  if (gateResult.gated) {
    logger?.info(
      { event: 'dupe_compare_quality_gate', request_id: ctx.request_id, reason: gateResult.reason },
      'aurora bff: dupe_compare quality gate enforced',
    );
  }

  return {
    ok: true,
    payload: finalPayload,
    field_missing: innerResult.field_missing || [],
    event_kind: 'value_moment',
    quality_gated: gateResult.gated,
  };
}

module.exports = { executeDupeCompare };
