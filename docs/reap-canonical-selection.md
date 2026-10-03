# Canonical selected cart SKU

A selected numeric Shopify variant does not determine a catalog SKU key. Mirror
rows can store an opaque hashed SKU. Fabricating `product_key::v::<id>` can refuse
a valid selected variant even when its stored proof and own offer are valid.

For a new selected cart checkout, call the authenticated read-only UCP vendor
tool `prepare_checkout` with the original create arguments, explicit
`checkout.reap.item_source: cart_link`, and `selected_variant_id`. It returns
`selection` containing the canonical product/SKU, numeric variant, merchant,
market, currency, unit price, quantity and item source. This uses the backend's
stored catalog/proof/own-offer authority. It never opens a purchase, obtains a
provider quote, enrolls a buyer, or calls a storefront.

Record that exact selection in `checkout.reap.selection` before minting and
persisting the original create key/body. The selection is caller-carried data,
not proof authority. Before the first checkout POST, the gateway prepares again
and requires exact agreement with the original selection and the selected PDP
variant's own amount/currency. Changed price, SKU, market, quantity, seller or
source refuses before any checkout POST. A preparation timeout or refusal offers
no alternate checkout route.

`recover_checkout` sends the identical original selection, body and key. With
this witness, it consults no current catalog, variant, price, proof or source
configuration. The backend's owner and immutable request hash decide whether the
original purchase matches. Invalid or missing mappings remain unknown; they do
not authorize another create. Legacy numeric-only recovery retains its exact
historic key derivation and never guesses a new hashed key.

The new witness protocol supports selected `cart_link` only. Unsupported selected
sources refuse before a checkout POST. Existing unselected native checkouts and
the proof-based sole-variant Reap path retain their original behavior. No runtime
pilot or merchant scope is enabled by this source change.

The read-only prepare endpoint accepts positive decimal selectors of at most 20 digits. The recorded witness structural validator permits up to 25 digits for the existing selector shape; this is data, never create authority. A newly selected create always runs the strict 20-digit authoritative preparation and refuses longer selectors before any purchase POST. Recovery does not run preparation or derive a different key.
