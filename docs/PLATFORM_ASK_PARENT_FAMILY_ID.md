# Platform Ask: First-Class Parent-Family Identity

## Decision Needed

Add a stable, assigned-once `product_family_id` / `item_group_id` to the catalog. This is the parent-ASIN layer above `pg_*`: one family groups shade/size variants and contains many `pg_*` offer-aggregation nodes.

## Why This Is Needed

The relation graph currently has no durable parent-family identity. Production validation found three orthogonal axes:

| Axis | Pivota id | Amazon analog | Groups by |
|---|---|---|---|
| Seller listing | `ext_*` / `sig_*` | Seller offer/SKU | Source listing |
| Offer aggregation | `pg_*` / `product_group_members` | Child ASIN / buy-box | Seller/offer |
| Variant family | missing | Parent ASIN | Shade/size variants |

`sig_*` cannot be the family key: production verified `pivota_signature_id` is unique per `catalog_products` row, so it is per-listing/per-shade. `pg_*` cannot be the family key either: production collapse by `pg_*` changed 5,185 served relation edges to 5,185, and `product_group_members` is 91% singleton with only about 10% of multi-member groups spanning more than one seller. In practice, `pg_*` is orthogonal seller/offer aggregation, not parent family.

Evidence: the V2 production review documents the failed `pg_*` and `sig_*` axes (`/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:21`, `/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:27`); current graph labels are still listing-pair keyed (`src/db/migrations/046_relationship_candidate_labels.sql:60`), while current catalog resolution treats `product_group_members` as an offer/listing membership join (`src/services/catalogEntityResolution.js:276`, `src/services/catalogEntityResolution.js:322`).

The result is variant flooding. One conceptual relationship, such as Fenty Pro Filt'r concealer to Soft'lit foundation, can serve as hundreds of shade x shade edges. A derived `familyKey(name, brand, category)` bridge can reduce this now, but it is title-derived and therefore vulnerable to merchant title/category volatility.

## Requirement

Create a first-class catalog parent identity:

- Field: `product_family_id` or `item_group_id`.
- Semantics: stable parent-family id for shade/size/color/variant siblings; groups multiple `pg_*` nodes.
- Assignment: assigned once and never reused for another product family.
- Population: use source-feed parentage where available, such as merchant parent product ids, marketplace parent ASIN, Google `item_group_id`, Shopify product id over variant id, or equivalent. When source parentage is missing, seed the value from the validated derived `familyKey(name, brand, category/product_type)` and allow review/correction.
- Guardrails: never merge across brand or category/product_type without explicit source parentage.

## Industry Precedent

This is the standard commerce identity layer: Amazon parent ASIN groups child ASIN variants; Google Merchant Center uses `item_group_id` for variants and recommends assigning it once and not changing it; Schema.org models the same concept as `ProductGroup`. Recommendation and merchandising systems such as Algolia, Adobe, Dotdigital, and Fresh Relevance commonly dedupe variants to a parent key before training or serving recommendations.

## Relation Graph Impact

The current graph fix will use a derived `familyKey` at generation and read time. Once `product_family_id` lands, the serving layer swaps the key source from derived to real with no architecture change:

```text
family_key = product_family_id || derived_familyKey || fallback_ref
bucket = (market, anchor_type, family_key_anchor, family_key_candidate, relation_type)
```

No relation-label rewrite is required. Existing rows can remain listing-pair keyed; read-time resolution will prefer the real parent id and collapse rows into the same family buckets.

## Other Surfaces That Benefit

- PDP variant pickers: one stable parent groups shade/size variants without relying on title regexes.
- Product deduplication: prevent duplicate cards and duplicate PDPs across seller/listing rows.
- Recommendations: train and serve at parent-family level, avoiding variant flooding.
- Search and merchandising: facet/variant rollups become stable across merchants and feeds.
- Catalog QA: false splits/merges become auditable parent-id corrections instead of repeated title-key patching.
