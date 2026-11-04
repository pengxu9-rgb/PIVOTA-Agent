'use strict';

// The request get_product_detail's unscoped hop sends to this gateway's own get_pdp_v2 (src/server.js
// `case 'get_product_detail'`). The agent's declared market rides along as `payload.market`: get_pdp_v2 reads the
// buyer's serving currency from it (servingCurrencyGuard.servingCurrencyFor), so without it an SG agent's SGD page
// would be judged as a US one and its price withheld.
//
// The MCP get_product executor (safety-kernel canonicalExecutor) keeps `market` OUT of the detail payload, so the
// upstream request stays byte-identical, and hands it to the upstream beside it: `declaredMarket`. A payload that
// carries its own `market` (a direct invoke caller) is the fallback.
function marketOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function unscopedDetailPdpRequest(productId, payload, declaredMarket) {
  const market = marketOf(declaredMarket) || marketOf(payload?.market);
  return {
    operation: 'get_pdp_v2',
    payload: { product_ref: { product_id: productId }, include: ['product_overview'], ...(market ? { market } : {}) },
  };
}

module.exports = { unscopedDetailPdpRequest };
