'use strict';

// 'external_seed' is a SOURCING bucket, not a seller (ADR-009: the id/marker says how a product was
// SOURCED, never who sells it). Rows mirrored from external seeds carry it in merchant_id, the
// serving projections advertise it on every seed product, and get_product's schema REQUIRES a
// merchant_id — so a well-behaved agent echoes the sentinel straight back as a SCOPE. A
// merchant-scoped lookup for a merchant that does not exist answers PRODUCT_NOT_FOUND →
// NO_MERCHANT_OFFER for products the unscoped sig lane serves fine.
//
// Live repro 2026-08-27 (sig_2c7636bb109fc25526b6bd799a5f08a9, reco rank-1 for the acne need):
// the public PDP answered 200 and the bare-id verifyPrice loopback resolved it, while
// get_product{merchant_id:'external_seed', product_id:<same sig>} answered NO_MERCHANT_OFFER.
//
// The fix is at INTAKE, in one shared predicate, so every op that treats merchant_id as a scope
// asks the same question — a guard on one path does not cover the bypass paths.
function isSourcingSentinelMerchantId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'external_seed' || normalized === 'external seed';
}

module.exports = { isSourcingSentinelMerchantId };
