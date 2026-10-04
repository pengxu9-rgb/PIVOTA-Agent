# Canonical PDP current own listing money

For an explicitly resolved enrichment canonical product in US/USD, the PDP reads current in-stock offers from the exact public, live, unsuppressed product and its owned SKU. Seller admission uses the same registered official-listing contract as canonical discovery; it does not accept an arbitrary same-product seller or a cached seed price.

The native builder chooses the original default variant before any money projection. Exact stored numeric, Shopify GID and product-bound external IDs can match that variant. A canonical product-grain placeholder funds only the native implicit product variant, not a hydrated numeric variant. No SKU key or variant identity is inferred from a key suffix.

The selected product, exact selected listing offer and visible selected variant use the current eligible offer price. Eligible US/USD offers for one identity must agree. An unpriced unselected sibling keeps its identity, option, visibility and source-quality metadata, but has no displayed price and is marked `current_own_offer_status: unavailable` with nonpurchasable availability. Missing selected money returns HTTP 409 `CURRENT_OWN_OFFER_UNAVAILABLE`; a failed authoritative read returns HTTP 503 `CURRENT_OWN_OFFER_READ_FAILED`. Neither response substitutes seed/APV money or another listing.

The listing's referral route and checkout handoff remain unchanged. Offer prioritization and the best-price marker are recomputed from the projected prices. Noncanonical, other-source and non-US/USD readers retain their existing behavior.

Coverage includes actual owned PostgreSQL admission, native builder identity and metadata, and a loopback-mounted product-page fixture with complete synthetic identity-group tables. These are synthetic tests, not real-provider checkout acceptance. Hosted coverage runs the unit test through the existing Jest shards and the PostgreSQL test through the Canonical SQL + HTTP job.
