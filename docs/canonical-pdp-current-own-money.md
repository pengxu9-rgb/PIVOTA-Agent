# Canonical PDP current own listing money

For an explicitly resolved enrichment canonical product in US/USD, the PDP reads current in-stock offers from the exact public, live, unsuppressed product and its owned SKU. Seller admission uses the same registered official-listing contract as canonical discovery; it does not accept an arbitrary same-product seller or a cached seed price.

The native builder chooses the original default variant before any money projection. Exact stored numeric, Shopify GID and product-bound external IDs can match that variant. A canonical product-grain placeholder funds only the native implicit product variant, not a hydrated numeric variant. No SKU key or variant identity is inferred from a key suffix.

The selected product, exact selected listing offer and visible selected variant use the current eligible offer price. Eligible US/USD offers for one identity must agree. An unpriced unselected sibling keeps its identity, option, visibility and source-quality metadata, but has no displayed price and is marked `current_own_offer_status: unavailable` with nonpurchasable availability.

Missing money is a gap, not a page failure. When the selected product or variant has no eligible current own money (`CURRENT_OWN_OFFER_UNAVAILABLE`: no admitted row, the selected variant unfunded, or the selected offer's SKU unfunded), or the authoritative read fails or exceeds its stage budget (`CURRENT_OWN_OFFER_READ_FAILED`, logged as `pdp_current_own_money_read_failed`), `get_pdp_v2` still returns 200 with its content modules, and the selected listing is unpriced and not purchasable:

- the product carries no `price`/`price_amount`/`priceAmount`/`current_price`/`currentPrice`, `payment_pricing` or `promotion_lines`, and `availability.in_stock` is false with no stock count; there is no `price_promo` module;
- every product and selector variant is `current_own_offer_status: unavailable`, unpriced, without `payment_pricing`/`promotion_lines`, and not in stock with no stock count (a product-grain listing's implicit variant too);
- the exact selected listing offer (same merchant and product id) has no price, `current_own_offer_status: unavailable`, `inventory.in_stock: false` and unavailable variants, so it sorts last and is never `best_price_offer_id`. It is the `default_offer_id`, because the card is that listing. Its referral route is not changed. A same-merchant twin listing can share its offer id (`buildOfferId` has no listing discriminator), so on this path only the withheld offer's id gets the suffix `__current_own_unavailable`, and neither marker can resolve to the twin;
- the card stays the selected listing. No offer prices or re-sellers it: not another seller's and not the same seller's twin listing (`hydrateCanonicalPdpPayloadFromOffers` with `withholdCardMoney`);
- all other listings' offers stay in the offers module, unchanged, with their own attribution and money, and can still be bought through their own routes;
- `metadata.current_own_offer_status: unavailable` and `metadata.current_own_offer_reason_code` say why. They describe the selected own listing, not the page or the other sellers' offers.

Nothing on this path substitutes seed/APV money or another listing's money for the selected listing. The read budget is `PDP_CURRENT_OWN_MONEY_READ_BUDGET_MS` (default 1500 ms, minimum 100). Past it the PDP degrades. The budget bounds latency, not pool pressure: the abandoned query keeps its connection until the database statement timeout.

`get_product` is not gated by current own money (unchanged since #2362). The MCP lane's expected-money check compares against `get_product`, so the backend `price_changed` check is the remaining guard there.

The listing's referral route and checkout handoff remain unchanged. Offer prioritization and the best-price marker are recomputed from the projected prices. Noncanonical, other-source and non-US/USD readers retain their existing behavior.

Coverage includes actual owned PostgreSQL admission, native builder identity and metadata, and a loopback-mounted product-page fixture with complete synthetic identity-group tables. These are synthetic tests, not real-provider checkout acceptance. Hosted coverage runs the unit test through the existing Jest shards and the PostgreSQL test through the Canonical SQL + HTTP job.
