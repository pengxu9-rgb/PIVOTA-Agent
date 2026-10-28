'use strict';

// The stored product the get_product door test serves as get_pdp_v2's canonical module
// (tests/_support/getProductDoorsChild.cjs). Its own module so the door test can check its shape without
// starting the child's servers.
//
// The real lane's stock shape (src/pdpBuilder.js buildPdpPayload): an availability OBJECT on the product and on
// each variant, and no top-level in_stock (the detail normalizer leaves it undefined). The door test pins this
// shape against buildPdpPayload itself.
function storedProduct(productId, store, variantId) {
  return {
    product_id: productId,
    title: 'Tint',
    brand: { name: 'Brand T' },
    description: 'A lip tint.',
    price: { current: { amount: 25, currency: 'USD' } },
    availability: { in_stock: true, available_quantity: 4 },
    destination_url: `https://${store}/products/tint`,
    default_variant_id: variantId,
    variants: [{ variant_id: variantId, title: 'Rose', price: { current: { amount: 25, currency: 'USD' } }, availability: { in_stock: true, available_quantity: 4 } }],
  };
}

module.exports = { storedProduct };
