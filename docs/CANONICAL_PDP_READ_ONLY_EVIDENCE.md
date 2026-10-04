# Canonical PDP evidence without current purchase eligibility

`get_pdp_v2` accepts `payload.options.allow_read_only: true` for clients displaying
product evidence. The option is a strict boolean and does not bypass identity,
serving eligibility, seller, variant, currency or current-own-offer checks.

When the selected canonical listing resolves and its evidence is available, but
the current-own-money gate returns `CURRENT_OWN_OFFER_UNAVAILABLE`, an opted-in
client receives HTTP 200 and the ordinary public evidence modules. PR2365
legacy requests without this option retain their unpriced, nonpurchasable200
page and reason metadata. For explicit evidence clients, a money read failure
returns HTTP503 `CURRENT_OWN_OFFER_READ_FAILED`; it is not treated as unavailable
inventory or a successful read. The upstream1500ms read-stage budget remains
in force; a late money result never grants proof.

The read-only response includes this object at `metadata.commerce`,
`modules[canonical].data.commerce`, and the canonical `pdp_payload.commerce`:

```json
{
  "state": "unavailable",
  "read_only": true,
  "purchase_eligible": false,
  "reason_code": "CURRENT_OWN_OFFER_UNAVAILABLE"
}
```

The selected product and its variants have no prices, savings assertions,
inventory assertions or purchase destinations. Unknown availability is `{}`;
it is not labelled out of stock. Product purchase eligibility is false,
`commerce_mode` is `read_only`, and actions are empty. Requested offers have
status `unavailable`, no offers and no default/best offer. No sibling seller is
selected as a replacement. Responses are `Cache-Control: private, no-store`.
Independent Similar products keep their own existing evidence/offer gates.

For opted-in calls that pass the existing current-own-money gate, the same
three commerce locations carry `state: "ready"`, `read_only: false`,
`purchase_eligible: true`, and `reason_code: "CURRENT_OWN_OFFER_VERIFIED"`.
This proof includes `product_ref: {merchant_id, product_id}` for the exact
resolved listing and `selected_variant_id` matching the displayed selected
variant. The final seller, source product, selected variant and displayed money
must still match the gated tuple after optional offer hydration. No positive
proof is emitted for legacy or other lanes that never ran this gate. Opted-in
verified responses are also private and non-cacheable; a cached proof must not
be treated as a current verification.

Clients must treat canonical product content and selected seller commerce as
different references. The deployed search cards explicitly advertise a
`pivota_signature_id` and a matching canonical `/products/{sig}` URL, while
their `merchant_id` is an offer seller such as `agent_seed::retailer::…`.
Canonical evidence is requested using the advertised signature. A seller-pinned
purchase/detail operation keeps its seller reference. Dropping an arbitrary
seller restriction from a purchase request is not supported by this option.

## Live evidence and test scope

Fresh public responses captured on 2026-10-04 reproduce these independent
failures on deployed gateway `a4fa137b60b1`:

- Full Cream signature: HTTP 409, request `c0f12020-4d2d-484b-83b2-34b524ca3c32`;
  its search-card seller scope: HTTP 404, request `cbecab88-e0d0-4bdd-998c-6e0f0f6cdad4`
- Missha mist signature: HTTP 409, request `5131a3bb-2372-458e-b993-2fcd6cb858dc`;
  its search-card seller scope: HTTP 404, request `bcb6e6bb-9503-4341-b010-737caf2da3ec`
- Bee Pollen moisturizer signature: HTTP 409, request `44553a4c-bd35-4cfb-a715-ceab5c93face`

`tests/fixtures/canonical-offer-live-20261004` retains the actual public search
cards and full public PDP receipts, including requests, statuses and request
IDs. These are public response fixtures, not private catalog table exports.
The integrated route suite constructs only the persistence envelope around
those captured identities/content, then exercises the real Express route,
current-own-money reader and PDP builders. It checks opt-in read-only behavior,
legacy unpriced200, explicit read-failure503, wrong currency, mismatched variant, conflicting
money, unrelated pinned seller, non-gated legacy lanes and valid current-own
product/variant money controls. Positive fixtures use explicitly constructed
control money, not a claimed live purchase price.

Run fixture-only Nock suites with Node 20. Clear `HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY`, `NO_PROXY` (including lowercase forms), the corresponding
`npm_config_*proxy` variables, and `NODE_USE_ENV_PROXY` only for the test process.
The production/public-probe network environment is not changed. Node 24 with
environment proxy rewriting produced identical baseline/candidate `Invalid URL`
and unmatched-review failures; the supported fixture setup passed all seven
targeted suites.

This change does not establish that the live product is purchasable, repair
catalog data, or claim production acceptance before deployment and a fresh
end-to-end check.

### Bounded commerce verification

Ready receipts carry `verified_at` and `expires_at` (UTC ISO8601), with a maximum 60-second window. `verified_at` records completion of the existing current-own-offer database read. It does not assert when the retailer updated its source or repair missing ingestion freshness. All three envelopes must agree on times, tuple and exact verified variant money. A future, expired, malformed or inconsistent receipt cannot enable a purchase action. The UI checks age again at dispatch and after retailer confirmation; timers only update presentation. Expired cached responses retain content-only SSR evidence and require a new core read. Optional enrichment cannot grant commerce.

Unknown canonical source/platform combinations return evidence-only200 for explicit opt-in. Legacy callers without this option keep their existing contract and never gain a new proof. The identified legacy combinations `external_seed/external_product_seeds_mirror_v1` and `shopify/shopify_sync_v1` / `shopify/shopify_products_sync` retain their existing commerce gates. These legacy paths do not gain a new own-money receipt. Enrichment canonical requests outside the supported money gate do not fall through into legacy eligibility.

Client consumers bind proof-bearing responses to the requested canonical/product/seller tuple before mapping main PDP, Similar and product-line results. A self-consistent response for another product cannot become the requested page. Seller variant proof uses unique exact raw IDs, explicit own currency/money and consistent option axes; an offer's default price is not used for another option.


### Integration with upstream PR2365

The source baseline includes the current own-money gap repair at `b15f8334686591816d0ce7185b05985a40980174`. Legacy200 unpriced fallback,1500ms read budget, selected-offer ID collision protection, same-merchant-twin ordering, and suppression of card money hydration from another listing remain intact. This additive explicit evidence contract provides its own503 read-failure boundary and clears unknown stock assertions at the final public projection. Unknown producer/platform combinations remain distinct from an identified legacy lane. The PostgreSQL authority test is not run without its private test database; fixture suites do not imply production schema/data validation.

The Shopify producer spelling `shopify_products_sync` is established in `src/services/contentKey.js` (production observations) and the upstream `external_seed_product_detail_fetch` internal-self-offer cases. Missing source labels do not become positive evidence authority: explicit opt-in still returns read-only. No-option legacy callers retain their existing source semantics and receive no new ready receipt.
