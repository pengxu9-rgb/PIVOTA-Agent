'use strict';

// The request get_product_detail's unscoped hop sends to this gateway's own get_pdp_v2 (src/server.js
// `case 'get_product_detail'`). The agent's declared market rides along as `payload.market`: get_pdp_v2 reads the
// buyer's serving currency from it (servingCurrencyGuard.servingCurrencyFor), so without it an SG agent's SGD page
// would be judged as a US one and its price withheld.
function unscopedDetailPdpRequest(productId, payload) {
  const market = typeof payload?.market === 'string' && payload.market.trim() ? payload.market.trim() : null;
  return {
    operation: 'get_pdp_v2',
    payload: { product_ref: { product_id: productId }, include: ['product_overview'], ...(market ? { market } : {}) },
  };
}

module.exports = { unscopedDetailPdpRequest };
