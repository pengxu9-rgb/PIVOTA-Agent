'use strict';

/**
 * Centralized feature flags and configuration for the dupe pipeline.
 *
 * Instead of scattering process.env reads across routes.js, all dupe-related
 * flags are resolved once here and exported as a frozen object.
 */

const _envBool = (envKey, fallback = false) => {
  const raw = String(process.env[envKey] || (fallback ? 'true' : 'false'))
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
};

const dupeFlags = Object.freeze({
  AURORA_DECISION_BASE_URL: String(process.env.AURORA_DECISION_BASE_URL || '').replace(/\/$/, ''),

  DUPE_KB_ASYNC_BACKFILL_ENABLED: _envBool('AURORA_BFF_DUPE_KB_ASYNC_BACKFILL', true),

  AURORA_DUPE_SUGGEST_SANITIZE_V1: _envBool('AURORA_DUPE_SUGGEST_SANITIZE_V1', true),

  AURORA_BFF_USE_EXTRACTED_DUPE_ROUTES: _envBool('AURORA_BFF_USE_EXTRACTED_DUPE_ROUTES', true),
});

module.exports = { dupeFlags };
