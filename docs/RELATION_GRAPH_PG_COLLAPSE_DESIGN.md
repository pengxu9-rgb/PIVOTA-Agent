# Relation Graph Parent-Family Collapse Design

## Executive Summary

This supersedes the V1 `pg_*` collapse design. Production validation disproved `pg_*` as the collapse key: collapsing 5,185 served relation-graph edges by `pg_*` produced 5,185 edges, because `pg_*` is the seller/offer aggregation axis, not the shade/size parent-family axis (`/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:9`, `/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:21`). The relation graph should serve product-product relations at a conservative parent-family key above `pg_*`: `familyKey(name, brand, category/product_type)`, category and brand guarded, with `pg_*` retained only as an optional seller/offer sub-collapse and display-hydration input.

The architecture from V1 remains correct: flag-gated read-time collapse in `src/auroraBff/productRelationshipGraph.js`, aggregation by winning approval tier, self-edge drop, overfetch-before-collapse, and canonical display hydration before `relationshipEdgeToSimilarItem()` emits PDP cards (`src/auroraBff/productRelationshipGraph.js:576`, `src/auroraBff/productRelationshipGraph.js:535`). The new requirement is to apply the same family key at generation time too: reconcile the existing `familyIdentityKey()` with the validated derived key and dedupe anchors plus candidates to family before scoring, so `m * n` shade-pair rows are not emitted or reviewed in the first place (`src/auroraBff/productRelationshipGraphSources.js:975`, `src/auroraBff/productRelationshipGraphSources.js:1194`, `src/auroraBff/productRelationshipGraphSources.js:1231`).

Flag-off behavior must be byte-identical: the current SQL against `product_relationship_edges`, ordering, limit, `mapRowToEdge()` conversion, and downstream card mapping remain untouched when the family-collapse flag is unset (`src/auroraBff/productRelationshipGraph.js:603`, `src/auroraBff/productRelationshipGraph.js:620`, `src/auroraBff/productRelationshipGraph.js:625`; `src/server.js:24025`, `src/server.js:24031`).

## Corrected Identity Model

The production model is three orthogonal axes, not one hierarchy inside `pg_*`:

- Seller listing: `ext_*` / `sig_*`, analogous to a seller offer/SKU. This is where the relation graph is currently keyed: label rows store `anchor_ref` and `candidate_product_ref`, and the unique label identity is `(market, anchor_type, lower(anchor_ref), lower(candidate_product_ref), relation_type)` (`src/db/migrations/046_relationship_candidate_labels.sql:13`, `src/db/migrations/046_relationship_candidate_labels.sql:16`, `src/db/migrations/046_relationship_candidate_labels.sql:60`).
- Offer aggregation: `pg_*` via `product_group_members`, analogous to an Amazon child-ASIN/buy-box surface. Current catalog resolution joins `catalog_products` to `product_group_members` by `(merchant_id, platform, source_product_id)` (`src/services/catalogEntityResolution.js:276`, `src/services/catalogEntityResolution.js:322`), and writers upsert one membership row per `(merchant_id, platform, platform_product_id)` (`scripts/map-and-merge-pdp-entity-resolution.js:431`, `scripts/map-and-merge-pdp-entity-resolution.js:440`; `scripts/sync-external-seeds-to-catalog.cjs:1908`, `scripts/sync-external-seeds-to-catalog.cjs:1917`).
- Variant family: missing today, analogous to Amazon parent ASIN / Google `item_group_id` / Schema.org `ProductGroup`. V2 production validation says `product_family_id` is null on the served set and no shade-agnostic parent identity exists in catalog rows (`/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:30`).

The V1 premise failed because `pg_*` is per shade and seller/offer-oriented: 25 shades of Fenty Pro Filt'r concealer carried 24 distinct `pg_*`, `product_group_members` averaged 1.19 members, and 91% of groups were singletons (`/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:21`). The original `sig_*` family attempt also failed: production verified `pivota_signature_id` as unique per `catalog_products` row, making it listing/shade identity rather than family identity (`/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:27`).

## Identity Resolution Chain (what each id is, and how they map to the family)

This implementation does NOT create a new variant id and does NOT repurpose `sig_*`. It creates ONE
new identity — the parent-family — as a derived, read-time rollup ABOVE the existing ids. Nothing is
written to `catalog_products` or `product_group_members` (both externally owned); no id is stamped.

### Role of each id under this design

| Id | Level | Role under this design | Created? |
|---|---|---|---|
| `ext_*` | seller listing | source lineage; resolves up to family. Stays the stored edge ref. | existing, unchanged |
| `sig_*` (`pivota_signature_id`) | seller listing / shade | **per-listing/shade identity only** — lineage + last-resort singleton fallback. **NOT a family key** (this is the corrected role; the original `sig`-as-family design failed because `sig` is UNIQUE per `catalog_products` row). Unchanged for checkout/commerce. | existing, unchanged |
| `pg_*` (`product_group_id`) | variant/shade, seller-aggregated | offer/buy-box aggregation; used only as a within-family seller sub-collapse and display-representative input. NOT the family key. | existing, unchanged |
| **`familyKey`** | **parent family (shade/size-agnostic)** | **the collapse + serving key** — one per product, groups all its shade/size variants. Derived at read time; reused via TTL cache; not stored. | **NEW (derived)** |

### Resolution flow (read-time, never stamped)

```text
ext_*  (stored edge ref)     ─┐
sig_*  (internal listing id)  ─┼─►  catalog_products row  ─►  (brand, title, category/product_type)  ─►  familyKey
pg_*   (internal buy-box id)  ─┘        resolve (join)                    derive (read-time)
```

- `ext_<hash>` → strip the `product:` prefix → matches `catalog_products.source_product_id`
  (validated 95.5% resolve on the served set); read its `brand`/`title`/`category` and derive `familyKey`.
- `sig_*` → matches `cp.pivota_signature_id`; `pg_*` → via `product_group_members`
  (`src/services/catalogEntityResolution.js:276`, `src/services/catalogEntityResolution.js:322`).
  Both reach the same catalog row → the SAME `familyKey`.
- Because `familyKey` is computed from the resolved row's CONTENT, any external or internal id that
  points at the same product lands on the same family. Honors the repo principle: identity is resolved
  at read time, never stamped (`docs/SIG_EXT_FRONT_FACING_FIX.md:10`).
- Refs that do not resolve to a catalog row (~4.5%) fall back to their own normalized ref — a clean
  singleton family, no false merge.

### Hierarchy

```text
familyKey (parent / product, shade+size-agnostic)   ← NEW derived; relations are served HERE
  └─ pg_*  (variant / shade, aggregated across sellers)
       └─ sig_* / ext_*  (one seller's listing)
```

### Forward-compatibility

The batch resolver computes `family_key = product_family_id || derived_familyKey || fallback_ref`
(`family_key_source` records which). When the platform mints a first-class `product_family_id`
(Deliverable 2), it becomes the top line — the derived key is bypassed for those rows — with zero
serving-layer rework.

## Current Graph Choke Points

Generation is listing-keyed today:

- `normalizeProductCandidateSnapshot()` chooses row/product external ids, SKU ids, product keys, canonical product refs, URL, or text as the raw product ref (`src/auroraBff/productRelationshipGraphSources.js:389`, `src/auroraBff/productRelationshipGraphSources.js:407`, `src/auroraBff/productRelationshipGraphSources.js:555`).
- Source loading already dedupes the combined product pool through `dedupeNormalizedProducts()` (`src/auroraBff/productRelationshipGraphSources.js:1458`, `src/auroraBff/productRelationshipGraphSources.js:1471`), and `dedupeNormalizedProducts()` uses `familyIdentityKey()` (`src/auroraBff/productRelationshipGraphSources.js:1194`, `src/auroraBff/productRelationshipGraphSources.js:1199`).
- `buildCandidatesByAnchorFromSources()` still normalizes anchors and products, builds a raw candidate pool, skips only intersecting listing identities, scores each candidate, and only then merges by family (`src/auroraBff/productRelationshipGraphSources.js:1216`, `src/auroraBff/productRelationshipGraphSources.js:1231`, `src/auroraBff/productRelationshipGraphSources.js:1237`, `src/auroraBff/productRelationshipGraphSources.js:1242`, `src/auroraBff/productRelationshipGraphSources.js:1266`).
- `buildProductRelationshipGraphDryRun()` dedupes per anchor by explicit `product_family_id`/`variant_of` or candidate ref, and the final edge identity is still listing-pair based (`src/auroraBff/productRelationshipGraphBuilder.js:1215`, `src/auroraBff/productRelationshipGraphBuilder.js:1222`, `src/auroraBff/productRelationshipGraphBuilder.js:1167`, `src/auroraBff/productRelationshipGraphBuilder.js:1177`).

Serving is also listing-keyed until card conversion:

- `buildAnchorRefsFromProduct()` emits product id/SKU id, `sig_*`, `ext_*`, URL, and brand/name text refs (`src/auroraBff/productRelationshipGraph.js:432`, `src/auroraBff/productRelationshipGraph.js:441`, `src/auroraBff/productRelationshipGraph.js:445`, `src/auroraBff/productRelationshipGraph.js:451`, `src/auroraBff/productRelationshipGraph.js:460`).
- `listApprovedRelationshipEdgesForAnchor()` lowercases supplied refs, queries `product_relationship_edges`, filters approved/fresh beauty rows, orders by score/update time, and returns `mapRowToEdge()` rows (`src/auroraBff/productRelationshipGraph.js:584`, `src/auroraBff/productRelationshipGraph.js:603`, `src/auroraBff/productRelationshipGraph.js:611`, `src/auroraBff/productRelationshipGraph.js:616`, `src/auroraBff/productRelationshipGraph.js:620`, `src/auroraBff/productRelationshipGraph.js:625`).
- `fetchRelationshipGraphSimilarItems()` calls that fetcher and maps each raw edge directly through `relationshipEdgeToSimilarItem()`; server dedupe happens later by merchant/product id and cannot know shade-family identity (`src/server.js:24020`, `src/server.js:24025`, `src/server.js:24031`, `src/server.js:24054`).

## Parent-Family Key Specification

`familyIdentityKey()` in `src/auroraBff/productRelationshipGraphSources.js` is the source of truth to extend. Do not add a parallel family-key implementation. The current function already checks explicit family metadata before falling back to raw brand/name text, URL, and ref (`src/auroraBff/productRelationshipGraphSources.js:975`, `src/auroraBff/productRelationshipGraphSources.js:977`, `src/auroraBff/productRelationshipGraphSources.js:986`, `src/auroraBff/productRelationshipGraphSources.js:989`). Replace the raw text fallback with a conservative derived parent-family key:

```js
family:v1:<normalized_brand>::<shade_size_stripped_title>::<category_guard>
```

Rules:

- Prefer a real first-class `product_family_id` / `productFamilyId` / `product_line_id` / `variant_of` when present; that path already exists (`src/auroraBff/productRelationshipGraphSources.js:977`). The derived key is only the bridge while a catalog parent id is missing.
- Merge on `brand` + conservatively shade/size-stripped `title`. **Do NOT require category to merge.** Production check: only 33% of served products (552/1,653) carry a non-empty `category`/`product_type` in `catalog_products`; 67% are NULL — including the headline Fenty Pro Filt'r concealer (43 shades) and Soft'lit foundation (50 shades) families that MUST collapse. A category-required rule would fall those ~two-thirds back to per-listing refs and forfeit most of the collapse. The PRIMARY false-merge defense is conservative stripping (below), not category.
- Category/product_type is a **secondary block-on-conflict guard, not a merge prerequisite**: when BOTH sides have a non-empty `category` (or `product_type`) and they DIFFER, do not merge — this catches cross-category lookalikes like `Murad Essential-C Cleanser` vs `Murad Essential-C Overnight Barrier Repair Cream` where category is present. When category is missing on either side, merge on `brand` + stripped `title` anyway; this is safe because conservative stripping keeps `Cleanser`/`Cream`/etc. in the title, so genuinely different products retain different keys even without a category signal. The normalizer already extracts category from `product.category`/`product.product_type`/`product.productType` and returns `category`/`category_taxonomy` (`src/auroraBff/productRelationshipGraphSources.js:454`, `src/auroraBff/productRelationshipGraphSources.js:461`, `src/auroraBff/productRelationshipGraphSources.js:468`, `src/auroraBff/productRelationshipGraphSources.js:558`, `src/auroraBff/productRelationshipGraphSources.js:563`); preserve `product_type` too when present.
- Brand must match after normalization. Never merge across brands; production validation found brand-mix false merges in the crude key (`/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:57`).
- Strip only recognized shade/size patterns. Do not strip arbitrary trailing words — this conservative stripping is what makes the missing-category merge safe.

Recognized strip patterns:

- Numeric shade codes at terminal separator boundaries: ` - #150`, ` - 150`, ` - 5.5`, ` - 310N`, ` - 120 warm`, or equivalent `-` / `--` / em-dash separators.
- Named shade segments only when the terminal segment follows an explicit separator and every token is in a maintained shade lexicon or comes from structured variant fields such as `shade`, `shade_name`, `color`, `variant_title`, or equivalent source metadata. Examples that should merge: `Pro Filt'r Instant Retouch Concealer - #150`, `Pro Filt'r Instant Retouch Concealer - 150`, and `Pro Filt'r Instant Retouch Concealer - Banana`.
- Size/net-content suffixes at the end of the title: `30 ml`, `1 fl oz`, `0.5 oz`, `50 g`, and slash pairs such as `1.7 oz / 50 ml`.

Explicit non-strips:

- Do not remove generic terminal product words such as `cleanser`, `cream`, `serum`, `foundation`, `concealer`, `mask`, `set`, or `refill` unless the product source explicitly marks that segment as a variant/shade/size. This is the over-strip failure mode: `Murad Essential-C Cleanser` and `Murad Essential-C Overnight Barrier Repair Cream` must not merge (`/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:59`).
- Do not strip arbitrary trailing `[a-z][a-z' ]+` the way the validated prototype did for exploration; that was intentionally crude and is unsafe for production (`/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:49`, `/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:64`).

Stability risk: derived keys are title-based. Merchant title edits, renamed shades, category retagging, and brand normalization changes can split or merge families. That is acceptable as a flagged bridge because false-splits are safer than false-merges, but it is the reason Deliverable 2 asks for a stable assigned-once parent id.

## Generation-Time Dedupe

Generation must stop emitting shade cross-products before review. Read-time collapse fixes existing approved rows, but generation-time family dedupe reduces future review volume and prevents new `m * n` shade pair rows from entering `relationship_candidate_labels`.

Touchpoints:

- `src/auroraBff/productRelationshipGraphSources.js:975`: extend `familyIdentityKey()` with the derived parent-family key above.
- `src/auroraBff/productRelationshipGraphSources.js:1194`: keep `dedupeNormalizedProducts()` but make its key the robust family key. This keeps `loadProductRelationshipGraphSourceInputs()` family-deduped before `buildInputsFromDb()` slices anchors (`src/auroraBff/productRelationshipGraphSources.js:1471`; `scripts/build-product-relationship-graph.js:335`, `scripts/build-product-relationship-graph.js:337`).
- `src/auroraBff/productRelationshipGraphSources.js:1216`: dedupe `normalizedAnchors` to family, not listing ref, so one shade family produces one anchor representative.
- `src/auroraBff/productRelationshipGraphSources.js:1231`: dedupe `rawPool` by `familyIdentityKey()` before `scoreCandidateForAnchor()` runs at `src/auroraBff/productRelationshipGraphSources.js:1242`. Also skip candidates whose family key equals the anchor family key before scoring, not only exact listing identity at `src/auroraBff/productRelationshipGraphSources.js:1237`.
- `src/auroraBff/productRelationshipGraphSources.js:1435`, `src/auroraBff/productRelationshipGraphSources.js:1445`, and `src/auroraBff/productRelationshipGraphSources.js:1448`: transitive recall must use the same family key so second-hop candidates do not reintroduce shade duplicates.
- `src/auroraBff/productRelationshipGraphBuilder.js:1215`: replace the builder's local `product_family_id || variant_of || product_ref` candidate dedupe with the shared `familyIdentityKey()` or a normalized family key passed through candidate metadata. The current builder-level fallback to `candidateNorm.product_ref` cannot collapse shade families.

Implementation shape:

1. Normalize products and anchors.
2. Compute `anchor_family_key`.
3. Build a candidate pool merged by `familyIdentityKey()` before scoring. Use the existing `mergeDuplicateCandidate()` behavior to retain stronger evidence and source refs (`src/auroraBff/productRelationshipGraphSources.js:1180`, `src/auroraBff/productRelationshipGraphSources.js:1184`, `src/auroraBff/productRelationshipGraphSources.js:1185`).
4. Skip `candidate_family_key === anchor_family_key`.
5. Score one representative per candidate family.
6. Emit at most one edge per `(anchor_family_key, candidate_family_key, relation_type)` candidate path. The stored edge can still carry representative listing refs for compatibility; the family key belongs in provenance/debug until a first-class catalog id exists.

This generation pass is advisory and forward-looking. It must not rewrite existing approved labels; read-time collapse remains required because stored rows are listing-pair keyed (`src/db/migrations/046_relationship_candidate_labels.sql:60`).

## Read-Time Serving Collapse

Use `listApprovedRelationshipEdgesForAnchor()` as the flag chokepoint (`src/auroraBff/productRelationshipGraph.js:576`). Keep the current implementation as `listApprovedRelationshipEdgesForAnchorUncollapsed()` and return it directly when the flag is off.

Flag:

- Preferred new name: `AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED`.
- Backward-compatible accepted name: `AURORA_BFF_RELATIONSHIP_GRAPH_PG_COLLAPSE_ENABLED`, because V1 may already have rollout plumbing.
- Default: off. When off, execute the exact current SQL, params, ordering, limit, and row mapping (`src/auroraBff/productRelationshipGraph.js:603`, `src/auroraBff/productRelationshipGraph.js:620`, `src/auroraBff/productRelationshipGraph.js:625`).

Flag-on order:

1. Build base refs via `buildAnchorRefsFromProduct()` (`src/auroraBff/productRelationshipGraph.js:432`).
2. Apply the PR #1597 sibling-expansion hook when present. In this checkout that helper is not present, so implementation off `origin/main` should wire it before the fetch as specified in V2 (`/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:78`).
3. Overfetch approved rows from the existing view. Do not collapse after the current requested limit, or a page can fetch 24 shade rows and collapse them into one card. Keep the current hard cap of 500 (`src/auroraBff/productRelationshipGraph.js:595`).
4. Batch resolve every unique anchor/candidate ref to family context.
5. Drop same-family product-product self edges.
6. Aggregate into family buckets.
7. Sort collapsed edges and return the requested limit.

Batch resolver output should include:

```js
{
  input_ref,
  normalized_ref,
  family_key,            // first-class product_family_id when present, else derived familyKey, else fallback ref
  family_key_source,     // product_family_id | derived_family_key | fallback_ref
  offer_group_id,        // pg_* when product_group_members has it; sub-collapse/display only
  pivota_signature_id,   // sig_* when catalog_products has it; not a family key
  brand,
  title,
  category,
  product_type,
  display_snapshot,
  display_snapshot_source,
}
```

Resolution should reuse the current catalog join and active-source semantics: `catalog_products` joined to `product_group_members` on `(merchant_id, platform, source_product_id)` (`src/services/catalogEntityResolution.js:276`, `src/services/catalogEntityResolution.js:322`), active source filtering (`src/services/catalogEntityResolution.js:281`; `src/services/activeCatalogSourceSql.js:44`), and primary/published ordering (`src/services/catalogEntityResolution.js:334`). The resolver may use `pg_*` to collapse multiple seller/listing rows into one candidate display representative inside a family bucket, but the served relation bucket is family-level, not `pg_*`-level.

Bucket key:

```text
(market, anchor_type, familyKey_anchor, familyKey_candidate, relation_type)
```

For `anchor_type !== 'product'`, keep existing need-anchor behavior. Need anchors are not shade variants; only candidate display hydration may use family context.

## Aggregation Rules

Use deterministic V1 aggregation per family bucket.

Representative edge ranking:

1. Label tier: `human_approved` before `ai_approved`.
2. Evidence grade: A > B > C > D, matching `evidenceGradeRank()` (`src/auroraBff/productRelationshipGraph.js:197`).
3. `score_total` descending.
4. `last_verified_at` descending.
5. `updated_at` descending.
6. Stable `id` ascending.

Current local schema exposes `label_state` in `relationship_candidate_labels` but the serving view projects only human-approved rows as `review_status = 'approved'` (`src/db/migrations/046_relationship_candidate_labels.sql:26`, `src/db/migrations/046_relationship_candidate_labels.sql:76`, `src/db/migrations/046_relationship_candidate_labels.sql:81`). Current local code also lacks `ai_approved` in `LABEL_STATES` (`src/auroraBff/productRelationshipGraph.js:740`). If the target branch/deployed schema includes `ai_approved`, the flag-on query can read from `relationship_candidate_labels` directly to preserve tier precedence. If not, treat view rows as `human_approved`.

Fields:

- `score_total`: maximum score among rows in the winning label tier, rounded through the same normalization path as `coerceRelationshipEdge()` (`src/auroraBff/productRelationshipGraph.js:289`). Do not sum or boost by member count; shade multiplicity is the bug.
- `evidence_grade`: best grade in the winning label tier.
- `expires_at`: latest expiry in the winning label tier. Inputs are already fresh because serving SQL requires `last_verified_at IS NOT NULL` and `expires_at > now()` (`src/auroraBff/productRelationshipGraph.js:616`, `src/auroraBff/productRelationshipGraph.js:618`).
- `last_verified_at` and `updated_at`: latest values in the winning label tier.
- `source_refs`: merge, dedupe, and cap using existing `normalizeSourceRefs()` semantics and the existing cap of 16 (`src/auroraBff/productRelationshipGraph.js:128`, `src/auroraBff/productRelationshipGraph.js:148`).
- `display_label`, `category_taxonomy`, `use_case`, `score_breakdown`, `price_evidence`, `why_candidate`, `tradeoffs`, and `watchouts`: use the representative edge. Do not concatenate shade-specific rationales.

Attach debug-only provenance:

```js
provenance.relationship_family_collapse = {
  version: 1,
  anchor_family_key,
  candidate_family_key,
  anchor_offer_group_id,
  candidate_offer_group_id,
  collapsed_edge_count,
  representative_edge_id,
  score_total_max,
  evidence_grade_best,
};
```

## Self-Edge Drop

Drop product-product rows after family resolution and before aggregation when both sides resolve to the same family:

```js
edge.anchor_type === 'product' &&
anchorFamilyKey &&
candidateFamilyKey &&
anchorFamilyKey === candidateFamilyKey
```

This is stronger than the V1 same-`pg_*` drop. It removes shade-of-same-product pairings, same-family refills/variants, and sibling-expanded anchor rows whose candidate is the queried product family. The generator currently skips only intersecting listing identities (`src/auroraBff/productRelationshipGraphSources.js:1237`), so read-time same-family self-edge drop is still required.

## Display Hydration

Serve a shade-agnostic family card, not an arbitrary shade row.

Touchpoints:

- Collapse helper attaches `candidate_family_key`, `candidate_offer_group_id`, `candidate_display_snapshot`, and representative canonical id/url fields to the collapsed edge before card conversion.
- `relationshipEdgeToSimilarItem()` should prefer `edge.candidate_display_snapshot` and family/canonical id fields before falling back to `candidate_snapshot` and `candidate_product_ref` (`src/auroraBff/productRelationshipGraph.js:535`, `src/auroraBff/productRelationshipGraph.js:538`, `src/auroraBff/productRelationshipGraph.js:542`).
- Current card output uses the candidate snapshot/ref as `product_id` and `external_product_id` (`src/auroraBff/productRelationshipGraph.js:557`, `src/auroraBff/productRelationshipGraph.js:558`). With PR #1599, front-facing id/url should come from the canonical entity/public URL path; until a real family id exists, use the best representative variant URL/id but keep dedupe and ranking at `family_key`.

Representative display selection:

1. First-class `product_family_id` canonical representative when available.
2. Primary `product_group_members` member within the candidate family when `pg_*` is available.
3. Published/validated catalog row by resolver ordering (`src/services/catalogEntityResolution.js:334`).
4. Representative edge's candidate snapshot.
5. Existing candidate ref fallback.

Do not display the queried shade or the arbitrary highest-score shade if a family representative exists. That reintroduces the variant arbitrariness the collapse is meant to remove.

## Phased Implementation Plan

### Phase 0: Tests and fixtures, flag off

Touchpoints: `tests/product_relationship_graph_sources.test.js`, `tests/product_relationship_graph_builder.test.js`, `tests/product_relationship_graph.test.js`, and resolver tests if a batch resolver lands under `src/services/catalogEntityResolution.js`.

Add unit fixtures for:

- Derived `familyIdentityKey()` shade merges and false-merge guards.
- Flag-off byte-identical `listApprovedRelationshipEdgesForAnchor()` SQL and row order, extending the existing provenance test (`tests/product_relationship_graph.test.js:299`).
- Builder/source family dedupe, extending the existing explicit `product_family_id` tests (`tests/product_relationship_graph_sources.test.js:217`, `tests/product_relationship_graph_builder.test.js:37`).

No behavior change.

### Phase 1: Robust family key

Touchpoints: `src/auroraBff/productRelationshipGraphSources.js:975`, `src/auroraBff/productRelationshipGraphSources.js:1194`, `src/auroraBff/productRelationshipGraphSources.js:1458`.

Ship:

- `familyIdentityKey()` with explicit family id first, then derived `family:v1:<brand>::<title>::<category/product_type>`, then fallback ref.
- Recognized shade/size stripping only.
- Category/product-type guard and missing-guard fallback.
- Export/internal test hooks remain under `__internal.familyIdentityKey` (`src/auroraBff/productRelationshipGraphSources.js:1516`, `src/auroraBff/productRelationshipGraphSources.js:1521`).

### Phase 2: Generation pre-score family dedupe

Touchpoints: `scripts/build-product-relationship-graph.js:319`, `scripts/build-product-relationship-graph.js:337`, `scripts/build-product-relationship-graph.js:340`; `src/auroraBff/productRelationshipGraphSources.js:1216`, `src/auroraBff/productRelationshipGraphSources.js:1231`, `src/auroraBff/productRelationshipGraphSources.js:1242`; `src/auroraBff/productRelationshipGraphBuilder.js:1215`.

Ship:

- Dedupe anchors to family before anchor slicing/scoring.
- Dedupe raw candidates to family before scoring.
- Skip same-family anchor/candidate before scoring.
- Preserve representative listing refs and snapshots for backward-compatible label storage.

### Phase 3: Read-time resolver and collapse helper, not wired

Touchpoints: `src/auroraBff/productRelationshipGraph.js`, optionally `src/services/catalogEntityResolution.js`.

Ship:

- Batch resolver returning family context plus display snapshot.
- Pure `collapseApprovedRelationshipEdgesToFamilies(edges, { resolutionMap, limit })`.
- Aggregation, same-family self-edge drop, singleton fallback, and metrics counters.

No serving behavior change until flag-on branch is wired.

### Phase 4: Flag-on serving branch

Touchpoints: `src/auroraBff/productRelationshipGraph.js:576`; `src/server.js:24020` only if debug metadata needs to be surfaced.

Ship:

- Default-off family-collapse flag.
- Overfetch raw approved rows, batch resolve, collapse to family buckets, return requested limit.
- Metrics: raw edge count, collapsed edge count, dropped self-edge count, unresolved ref count, derived-family count, fallback-ref count, display snapshot source, and flag state.

### Phase 5: Canonical display hydration

Touchpoints: `src/auroraBff/productRelationshipGraph.js:535`, `src/server.js:24031`, and PR #1599 canonical id/url path.

Ship:

- `relationshipEdgeToSimilarItem()` prefers family display snapshot and canonical id/url fields.
- Existing ext/snapshot fallback remains for unresolved singleton rows.

## Test Plan

Family-key unit tests:

- Shade-strip must merge: Fenty `Pro Filt'r Instant Retouch Concealer - #150`, `- 150`, and `- Banana` with same brand/category produce the same family key.
- Size-strip must merge: same brand/category/title with `30 ml`, `1 fl oz`, and equivalent terminal size suffixes produce the same family key.
- Category block-on-conflict: identical brand/title base with two DIFFERENT non-empty `category`/`product_type` values must NOT merge (returns different keys).
- Missing-category still merges: shade variants with the SAME brand/stripped-title and NULL category (e.g. the Fenty concealer/foundation families, which are null-category in prod) MUST still collapse to one family key — category absence does not block the merge.
- Over-strip must not merge: `Murad Essential-C Cleanser` and `Murad Essential-C Overnight Barrier Repair Cream` do not share a family key even when category is NULL (conservative stripping keeps `Cleanser`/`Cream`, so titles differ).
- Generic trailing words must not strip: `Cream`, `Cleanser`, `Foundation`, `Serum`, and `Refill` remain in the title unless source metadata marks them as shade/size.
- Missing brand or title falls back to ref and does not merge unrelated products.

Generation tests:

- `buildCandidatesByAnchorFromSources()` scores one candidate per family when raw products contain many shades.
- Same-family anchor/candidate is skipped before scoring.
- `buildProductRelationshipGraphDryRun()` emits one review edge for shade-family duplicates, extending the existing explicit-family test (`tests/product_relationship_graph_builder.test.js:37`).
- Transitive recall uses the same family key and does not re-add direct family duplicates (`src/auroraBff/productRelationshipGraphSources.js:1435`, `src/auroraBff/productRelationshipGraphSources.js:1445`).

Flag-off byte-identical tests:

- With both collapse flags unset/false, `listApprovedRelationshipEdgesForAnchor()` calls the same SQL and returns the same row order/fields as today (`src/auroraBff/productRelationshipGraph.js:603`, `src/auroraBff/productRelationshipGraph.js:620`, `src/auroraBff/productRelationshipGraph.js:625`).
- Server PDP path still maps raw edges through `relationshipEdgeToSimilarItem()` (`src/server.js:24031`).

Flag-on collapse tests:

- Ten shade-level rows for the same `(anchor_family, candidate_family, relation_type)` return one collapsed edge.
- Two distinct candidate families return two collapsed edges even if raw top rows are dominated by one shade pair.
- Overfetch test proves raw limit is greater than requested serving limit under flag-on mode.
- Aggregation uses max score in winning label tier, human over AI, latest expiry, best grade, and merged/capped source refs.

Self-edge tests:

- `product:ext_a_145 -> product:ext_a_150` with same derived family is dropped.
- Sibling-expanded anchor row whose candidate resolves to the queried family is dropped.

Singleton fallback tests:

- No catalog match/no family guard keeps the original edge under fallback ref.
- `sig_*` and `pg_*` are not treated as primary family keys; they are fallback/sub-collapse only unless a real family id exists.

Display tests:

- Collapsed candidate card uses the family representative snapshot, not an arbitrary shade title.
- Missing display hydration falls back to existing `candidate_snapshot` behavior.

## Rollout and Rollback

Rollout:

1. Merge with `AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED=false`.
2. Run unit/snapshot tests.
3. Enable in staging.
4. Validate known shade-heavy anchors from the production finding: Fenty Pro Filt'r concealer, Soft'lit foundation, Bright Fix, Match Stix. Expect one product-family card per conceptual relation, not shade cross-products (`/tmp/codex_review/DEEPDIVE_CONTEXT.md:14`).
5. Compare raw vs collapsed counters. Do not use V1's 3,596 `pg_*` expectation; V2 proved `pg_*` collapse is zero. Use family-key counters instead (`/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:9`, `/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:57`).
6. Enable production behind the same flag.

Rollback:

```sh
AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED=false
AURORA_BFF_RELATIONSHIP_GRAPH_PG_COLLAPSE_ENABLED=false
```

No DB writes are part of the serving fix. No `relationship_candidate_labels`, `catalog_products`, or `product_group_members` rows are rewritten. The flag-off branch restores the old view query and row-to-card path immediately.

## Risks and Open Questions

- Derived title volatility can split or merge families after merchant title/category edits. This is why the platform needs a first-class parent id.
- False-merge risk is more damaging than false-split. Keep strip rules conservative and category/brand guarded.
- Current local schema does not include `ai_approved` in `LABEL_STATES` or the serving view (`src/auroraBff/productRelationshipGraph.js:740`; `src/db/migrations/046_relationship_candidate_labels.sql:81`). Confirm the deployed branch before writing label-tier SQL.
- PR #1597 sibling expansion and PR #1599 canonical public id/url are cited in the context but not present in this checkout (`/tmp/codex_review/DEEPDIVE_CONTEXT_V2.md:108`). Implement off `origin/main` as requested.
- Family display hydration needs a policy for choosing the representative variant when no first-class family record exists. Use resolver ordering and track `display_snapshot_source`.
- Generation dedupe will reduce review volume but cannot repair already-approved listing-pair rows. Read-time collapse remains mandatory.
