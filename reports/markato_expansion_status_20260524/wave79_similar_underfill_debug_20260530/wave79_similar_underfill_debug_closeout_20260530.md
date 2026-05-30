# Wave79 Similar-Underfill Debug Closeout

Date: 2026-05-30
Market: US
Scope: read-only production debug probe for the six Wave77/Wave78 DB-ready rows that failed strict PDP quality on `similar_underfill`.

## Reviewer Decision

The strict failures are not caused by public visibility filtering, card-highlight filtering, PDP-quality suppression, vertical mismatch, or brand-authority suppression.

The blocker is upstream candidate scarcity/confidence:

- COCONUT MATTER lip rows produce 2-3 visible candidates but stay below the strict minimum.
- Delicate Daisys body oil produces 0 visible candidates.
- 786 Sorrento produces 0 visible candidates because candidates are filtered by confidence and the base category is still broad `beauty`.
- 786 Cuticle Oil and Soy Remover produce 0 visible candidates; their categories are specific, but same-family inventory is sparse.

No production writes were performed in this wave.

## Probe

Artifact:

- `find_similar_debug.json`

Probe shape:

- Operation: `find_similar_products`
- Merchant: `external_seed`
- Limit: 6
- Options: debug, no cache, cache bypass

## Results

| External product ID | Product family | Visible similar | Similar status | Candidate signal | Main blocker |
| --- | --- | ---: | --- | --- | --- |
| `ext_c840771410198f627d75673a` | COCONUT MATTER tinted lip balm | 3 | underfilled | 3 candidates, 6 filtered by confidence | below strict minimum |
| `ext_8982e4384c3bd70a5718c899` | COCONUT MATTER clear lip care | 2 | underfilled | 2 candidates, 7 filtered by confidence | below strict minimum |
| `ext_b344f028268229b02a16d0cb` | Delicate Daisys body oil | 0 | empty | 0 candidates, 1 filtered by confidence | category/family inventory scarcity |
| `ext_55b774d3c57906a77a7167f0` | 786 breathable nail polish | 0 | empty | 0 candidates, 16 filtered by confidence | broad base category `beauty` suppresses confidence |
| `ext_87a0af88b9bd23b8f2123d1b` | 786 cuticle oil | 0 | empty | 0 candidates, 0 filtered by confidence | specific family inventory scarcity |
| `ext_e86ee213b542fbb671e0804e` | 786 nail polish remover | 0 | empty | 0 candidates, 0 filtered by confidence | specific family inventory scarcity |

## Filter Evidence

Across all six debug probes:

- `public_external_id_filtered_count=0`
- `card_highlight_filtered_count=0`
- `card_highlight_missing_count=0`
- `card_image_missing_count=0`
- `filters.by_vertical=0`
- `filters.by_external_brand_authority=0`
- `filters.by_pdp_quality=0`

That rules out the usual downstream public-card filters.

## Interpretation

The next productive work is not another broad source-gap sweep. It should be a focused similar-coverage repair:

1. Patch the broad 786 Sorrento category from generic `beauty` to source-backed nail polish taxonomy, then rerun strict similar.
2. For 786 Cuticle Oil and Soy Remover, add or recover more source-backed nail-care family inventory, or explicitly decide that sparse utility products should be similar-exempt.
3. For COCONUT MATTER lip rows, inspect confidence filtering; enough low-confidence candidates exist, but the engine is not admitting enough high/medium candidates.
4. For Delicate Daisys body oil, expand/recover body oil and after-sun body-care candidates before expecting strict similar to pass.

The first low-risk write candidate is Sorrento category repair because the official title is `Sorrento - Breathable Nail Polish` and current production still has only broad catalog category `Beauty Product` / path `beauty`.

