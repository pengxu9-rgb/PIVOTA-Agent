'use strict';

/**
 * Resolve a Gemini API key for a specific Aurora feature.
 *
 * Fallback chain: feature-specific -> AURORA_SKIN_GEMINI_API_KEY -> GEMINI_API_KEY -> GOOGLE_API_KEY
 *
 * @param {string} featureEnvVar  e.g. 'AURORA_DIAG_GEMINI_API_KEY'
 * @returns {string} trimmed key or empty string
 */
function resolveAuroraGeminiKey(featureEnvVar) {
  const candidates = [
    process.env[featureEnvVar],
    process.env.AURORA_SKIN_GEMINI_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return '';
}

module.exports = { resolveAuroraGeminiKey };
