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
const { isIP } = require('node:net');

// Keep in sync with MERCHANT_EVIDENCE_SOURCE_TYPES in backend claim_safety.py.
// Before per-claim verification, merchants could assign themselves these grades.
const MERCHANT_EVIDENCE_SOURCE_TYPES = new Set([
  'merchant_lab_report', 'third_party_test', 'certification',
  'third_party_review', 'editorial_press', 'merchant_positioning',
]);
const REVIEW_SOURCE_TYPES = new Set([
  ...Array.from(MERCHANT_EVIDENCE_SOURCE_TYPES).filter((type) => type !== 'merchant_positioning'),
  'brand_statement', 'retailer_listing',
]);
const REVIEW_GRADES = new Set(['a', 'b', 'c']);

function projectReviewedMerchantClaim(claim) {
  if (claim.review_status !== 'verified' || !REVIEW_GRADES.has(claim.evidence_grade) ||
      !REVIEW_SOURCE_TYPES.has(claim.review_source_type) ||
      typeof claim.reviewed_by !== 'string' || !claim.reviewed_by.trim() ||
      typeof claim.review_source_url !== 'string') return null;
  try {
    const url = new URL(claim.review_source_url);
    if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password || url.hash) return null;
    const host = url.hostname.replace(/\.$/, '');
    if (isIP(host) || /\.(?:local|internal|localhost)$/i.test(host) || /[\s\\]/.test(claim.review_source_url) ||
        [...url.searchParams.keys()].some((key) => /token|password|secret|authorization|api.?key/i.test(key))) return null;
    return {
      claim_text: String(claim.claim_text),
      source_type: claim.review_source_type,
      source_ref: claim.review_source_url,
      source_refs: [claim.review_source_url],
      evidence_grade: claim.evidence_grade,
      substantiation_status: 'substantiated',
    };
  } catch {
    return null;
  }
}

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
async function fetchSubstantiatedMerchantEvidenceClaims(productKey, { geoCode = 'default', staffReviewedOnly = false } = {}) {
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
    return asArray(claims).flatMap((claim) => {
      if (!claim || typeof claim !== 'object' || !String(claim.claim_text || '').trim() ||
          String(claim.substantiation_status || '').trim().toLowerCase() !== 'substantiated') return [];
      if (!MERCHANT_EVIDENCE_SOURCE_TYPES.has(String(claim.source_type || '').trim().toLowerCase())) {
        return staffReviewedOnly ? [] : [claim];
      }
      const reviewed = projectReviewedMerchantClaim(claim);
      return reviewed ? [reviewed] : [];
    });
  } catch {
    return [];
  }
}

module.exports = { fetchSubstantiatedMerchantEvidenceClaims };
