# Wave9 Source Recovery Closeout - 2026-05-25

## Scope

Continue expanding Markato US cooperation merchant coverage while preserving PDP content quality. This pass used direct official PDP/source recovery instead of broad domain scanning.

## Result

- Brands reviewed: 10
- Direct probe files: 10
- Production DB apply ready: 0
- Production DB apply decision: hold
- Railway deploy command used: none
- Push/deploy path: git push only, if this report is committed

No candidate should be applied to production DB yet. The main reason is not catalog capacity; it is source-backed quality. LIME is the only group with commerce-pass probes, but its extracted descriptions are empty or size-only, which would create thin public PDPs.

## Brand Decisions

| Brand | Decision | Why |
| --- | --- | --- |
| OILUJ | Engineering recovery candidate | Official Weebly PDPs have USD and product pages, but source validation still classifies the page as channel_or_retailer and requires multi-offer validation. |
| Bonjour La Vie | Market hold | Official English PDP remains EUR/Italy commerce, not US/USD. |
| Merindah Botanicals | Market hold | Official PDP content extracts, but commerce facts are AUD and fail US market switch. |
| NIMBUS CO | Market hold | Official PDP content extracts, but commerce facts are AUD and fail US market switch. |
| MANISANTE | Market hold | English storefront remains EUR/Italy or Europe-oriented; no confirmed US/USD commerce path. |
| KHUS KHUS | Engineering recovery candidate | Official US/USD PDPs exist, but current extractor returns product_schema_missing. |
| Apiceuticals | Engineering recovery candidate | Official shop appears US-shippable and USD-selectable, but current extractor returns product_schema_missing. |
| Pairfum | Access hold | Official PDP path remains Cloudflare/access gated; tested URL is travel-size and not a clean first coverage candidate. |
| LIME | Engineering recovery candidate | Official English Cafe24 PDPs pass commerce facts, but extracted descriptions are empty or size-only. |
| Lazy Society | Policy hold | Strict brand domain is Korean/KRW; official-linked Cafe24 English/USD subdomain needs policy acceptance before use. |

## Probe Evidence

- `probes/oiluj-life-oil-sandalwood.json`: USD and in stock, but held by `missing_multi_offer_merge_candidate` and `channel_or_retailer` source validation.
- `probes/bonjour-hydra-comfort-cream.json`: EUR/Italy market hold and empty extracted description.
- `probes/merindah-luxurious-face-cream.json`: content present, but AUD market hold.
- `probes/nimbus-face-oil.json`: content present, but AUD market hold.
- `probes/khus-khus-c-drops-serum.json`: `product_schema_missing`.
- `probes/apiceuticals-propowax-shampoo.json`: `product_schema_missing`.
- `probes/pairfum-ginger-elemi-vetiver.json`: Cloudflare/access hold.
- `probes/lime-giga-white-tone-up-cream.json`: commerce pass, but empty description.
- `probes/lime-oil-gel-eye-patch.json`: commerce pass, but empty description.
- `probes/lime-v-collagen-ample-cushion.json`: commerce pass, but description is only `20g`.

## Recommended Next Sequence

1. Add WooCommerce-style official PDP extraction for KHUS KHUS and Apiceuticals.
2. Repair OILUJ Weebly official source validation only if add-to-cart, fulfillment context, availability, and PDP copy can be parsed reliably.
3. Add Cafe24 detail-content extraction for LIME and keep a hard hold on empty or size-only descriptions.
4. Keep Bonjour La Vie, MANISANTE, Merindah Botanicals, NIMBUS CO, Pairfum, and Lazy Society out of production DB until their market, access, or policy blockers are resolved.
5. After extractor/source fixes, re-run seed dry-runs, seed-content audit, production DB apply only for source-backed rows, then live PDP audit.

## Quality Gate

This wave intentionally did not use seller-only fallback, external mirror fallback, or force-filled content. The current safe answer is to expand coverage through extractor fixes first, not by applying low-context rows.
