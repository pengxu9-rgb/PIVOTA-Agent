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

The create body carries the storefront id as `variant_id`, never the witness's
SKU: the backend resolves it by the same rule `/purchases/prepare` used, so the
witness and the purchase agree on variant and price whichever SKU spells it. A
SKU named in the body would be refused for a sole variant priced only on its
`::canonical` placeholder beside an unpriced real SKU, which preparation reaches
through the backend's no-key path.

`recover_checkout` sends the original selection, body and key. A witness attempt
created before creates sent `variant_id` carried the witness's SKU as
`variant_key`, so recovery probes `variant_id` first and then that SKU, exactly
as for a numeric-only attempt below. With this witness, it consults no current
catalog, variant, price, proof or source configuration. The backend's owner and immutable request hash decide whether the
original purchase matches. Invalid or missing mappings remain unknown; they do
not authorize another create.

## Numeric-only selection (no witness)

A selected `cart_link` create without `checkout.reap.selection` still runs the
same strict preparation (price, quantity, seller and market must agree), but its
body carries the storefront id as `variant_id` and no `variant_key`. The backend
resolves the id to its own SKU and requires the proven variant to be that id
(pivota-backend#2605); its fingerprint holds `variant_id:<n>`, the id as sent.
The gateway never spells a key itself: the catalog writes one variant as
`::sku_<hash>`, `::v:<n>`, `::v::<n>` or `::v:retailer-<hash>`.

Recovery and resume of a numeric-only attempt cannot know which gateway created
it, so in the cart-link key namespace they probe the two spellings an attempt
may carry under one idempotency key: `variant_id` first, then the historic
`<product_key>::v::<id>` (mirror) or `::v:<id>` key sent before this change.
The backend stored one fingerprint per key, so at most one spelling matches;
the other answers `idempotency_conflict` and is passed over. No match under
either spelling, or a conflict with no match, stays unknown. The matched body
is the one a resume continues with. A witness attempt probes `variant_id`, then
the witness's own SKU (never a guessed key). The variant-lane namespace probes
exactly one spelling, as before. A selector over 20 digits was
never prepared, so only its historic key is probed.

**Deploy gate.** A backend without #2605 ignores `variant_id` and can open a
cart for another variant at the same price. Deploy this gateway change only
after #2605 serves 100% of `web`, and never roll the backend below it while
this change is live.

The new witness protocol supports selected `cart_link` only. Unsupported selected
sources refuse before a checkout POST. Existing unselected native checkouts and
the proof-based sole-variant Reap path retain their original behavior. No runtime
pilot or merchant scope is enabled by this source change.

The read-only prepare endpoint accepts positive decimal selectors of at most 20 digits. The recorded witness structural validator permits up to 25 digits for the existing selector shape; this is data, never create authority. A newly selected create always runs the strict 20-digit authoritative preparation and refuses longer selectors before any purchase POST. Recovery does not run preparation or derive a different key.
