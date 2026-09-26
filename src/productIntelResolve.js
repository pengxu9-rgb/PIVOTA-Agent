// ADR-009: this used to read a product-id PREFIX and return a merchant id — it
// put sourcing information (how a product was discovered) into the seller
// field, and the refs it produced named a shared bucket that joins nothing
// after the re-key onto observed sellers.
//
// It survived the first deletion attempt because it was not decoration: the id
// it returned was a ROUTING TOKEN that carried a seed-shaped request to the
// seed store, whose lookup keys on the product id alone. Retiring it therefore
// needed the route to reach that store WITHOUT a seller first — see
// fetchProductDetailForOffers' seller-less admission and
// resolveProductIntelInvokeContext's seller-less ref in src/server.js. With
// those in place there is nothing left for it to route, so it derives nothing.
//
// The empty return is kept (rather than the function deleted) so its remaining
// callers keep their current shape; removing them is a separate change.
function inferMerchantIdFromProductId() {
  return '';
}

module.exports = {
  inferMerchantIdFromProductId,
};
