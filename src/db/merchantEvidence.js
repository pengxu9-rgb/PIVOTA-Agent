'use strict';

// Phase 2b serving half: read substantiated MERCHANT evidence (the general
// cross-vertical `product_evidence` store written by the pivota-backend intake —
// lab/cert/third-party claims, NOT INCI-derived) so the get_pdp_v2 product_intel
// bundle can publish citable claims for non-beauty products (and beauty products
// that carry merchant lab evidence). Shared Postgres: this gateway reads the same
// `product_evidence` table the backend writes.
//
// Best-effort by contract: serving must NEVER fail because the evidence store is
// absent, empty, or non-Postgres — every error path returns []. Substantiation is
// filtered here (the serve gate); the public-safe FTC/grade filter is applied
// downstream by pivotaInsightsQuality.filterPublicSafeClaims.

const { query } = require('./index');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Substantiated merchant evidence claims for a product, in the
 * pivotaInsightsQuality evidence_claims shape
 * ({claim_text, source_ref, source_type, evidence_grade, substantiation_status}).
 *
 * @param {string} productKey  catalog product_key (the key the 2b intake writes).
 * @returns {Promise<Array<object>>} substantiated claims, or [] on any miss/error.
 */
async function fetchSubstantiatedMerchantEvidenceClaims(productKey, { geoCode = 'default' } = {}) {
  if (!productKey || typeof productKey !== 'string') return [];
  try {
    const res = await query(
      `SELECT claims
         FROM product_evidence
        WHERE product_key = $1
          AND geo_code = $2
          AND claims IS NOT NULL
        LIMIT 1`,
      [productKey, geoCode],
    );
    const row = Array.isArray(res?.rows) ? res.rows[0] : null;
    if (!row) return [];
    let claims = row.claims;
    if (typeof claims === 'string') {
      try {
        claims = JSON.parse(claims);
      } catch {
        return [];
      }
    }
    return asArray(claims).filter(
      (c) =>
        c &&
        typeof c === 'object' &&
        String(c.claim_text || '').trim() &&
        String(c.substantiation_status || '').toLowerCase() === 'substantiated',
    );
  } catch {
    return [];
  }
}

module.exports = { fetchSubstantiatedMerchantEvidenceClaims };
