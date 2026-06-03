# Production Readiness Review: PDP Relation Graph Buildout

Review date: 2026-06-03  
Worktree: `/tmp/relgraph-review` at `75f366c515c7fba7fad1a09faa5627cd86875ad9`  
Scope: merged PRs #1604, #1605, #1606, #1607; runtime flags default off.

Verdict: **GO-WITH-CONDITIONS** for controlled dogfood/internal rollout. Keep public/broad production enablement blocked until the conditions in Part 1 and the data risks in Part 3 are addressed or explicitly accepted.

## Part 1: Production-Readiness Review

### 1. Flag Discipline

**Default-off status is mostly correct for online serving.**

- The curated relationship graph master flag is default off: `RELATIONSHIP_GRAPH_SERVING_ENABLED` is true only when `AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED === "true"` (`src/server.js:24209`-`src/server.js:24215`). `fetchRelationshipGraphSimilarItems()` returns `[]` immediately when it is off (`src/server.js:24313`-`src/server.js:24315`), and `fetchSimilarProductsDeduped()` only calls the curated graph fetcher behind that flag (`src/server.js:24339`-`src/server.js:24344`).
- The read-time family-collapse flag is default off: `isRelationshipGraphFamilyCollapseEnabled()` only accepts `AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED=true` or the alias `AURORA_BFF_RELATIONSHIP_GRAPH_PG_COLLAPSE_ENABLED=true` (`src/auroraBff/productRelationshipGraph.js:26`-`src/auroraBff/productRelationshipGraph.js:61`). When off, `listApprovedRelationshipEdgesForAnchor()` returns the uncollapsed fetcher directly (`src/auroraBff/productRelationshipGraph.js:1115`-`src/auroraBff/productRelationshipGraph.js:1135`). The test asserts byte-identical SQL, params, and rows with both collapse env vars deleted (`tests/product_relationship_graph.test.js:370`-`tests/product_relationship_graph.test.js:411`).
- The PDP similar family dedupe flag is default off: `SIMILAR_FAMILY_DEDUPE_ENABLED` is true only when `AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED === "true"` (`src/server.js:24214`-`src/server.js:24215`). When off, `fetchSimilarProductsDeduped()` skips the catalog resolver and uses either existing recall items or merchant/product-id dedupe only (`src/server.js:24346`-`src/server.js:24358`). Tests show the non-curated path returns both shade variants with the flag off and collapses them when the flag is on (`tests/find_similar_products_mainline_wrapper.test.js:145`-`tests/find_similar_products_mainline_wrapper.test.js:157`, `tests/find_similar_products_mainline_wrapper.test.js:160`-`tests/find_similar_products_mainline_wrapper.test.js:213`).
- `relationshipEdgeToSimilarItem()` explicitly preserves raw-edge product id/url/price precedence unless a collapsed edge carries collapse-specific fields (`src/auroraBff/productRelationshipGraph.js:966`-`src/auroraBff/productRelationshipGraph.js:1036`).

**Conditions / flag issues:**

- The master graph flag gates the curated relationship graph path, but it does **not** gate the non-curated similar family dedupe/recall resolver. If `AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED=true`, `resolveSimilarFamilyDedupeContext()` can run even while `AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED=false` (`src/server.js:24347`-`src/server.js:24355`). That is safe because its own flag is default off, but if the intended policy is "master flag gates all relation-graph-derived family logic," add an explicit master guard.
- PR #1605's structured-variant shade stripping has no independent online flag. It is only reached online when a family-dedupe path is enabled, but generation paths use the shared `familyIdentityKey()` unconditionally (`src/auroraBff/productRelationshipGraphSources.js:1168`-`src/auroraBff/productRelationshipGraphSources.js:1197`, `src/auroraBff/productRelationshipGraphSources.js:1250`-`src/auroraBff/productRelationshipGraphSources.js:1272`). Offline generation is therefore not byte-identical if operators rerun candidate generation with all runtime flags off (`src/auroraBff/productRelationshipGraphSources.js:1583`-`src/auroraBff/productRelationshipGraphSources.js:1627`, `src/auroraBff/productRelationshipGraphBuilder.js:1221`-`src/auroraBff/productRelationshipGraphBuilder.js:1233`).

### 2. Fail-Closed / Resilience

**PDP breakage risk is low; additive modules degrade.**

- Curated graph serving is wrapped in `try/catch`; failures log and return `[]`, so the PDP can continue without curated graph cards (`src/server.js:24313`-`src/server.js:24329`).
- The collapse resolver/collapse block catches resolver or collapse errors and falls back to raw uncollapsed edges sliced to the requested limit (`src/auroraBff/productRelationshipGraph.js:1168`-`src/auroraBff/productRelationshipGraph.js:1189`). The test covers this exact resolver-failure fallback (`tests/product_relationship_graph.test.js:537`-`tests/product_relationship_graph.test.js:578`).
- The recall/similar catalog resolver catches errors, emits `aurora_bff_similar_family_resolution_failed`, and falls back to title-based family dedupe (`src/server.js:24269`-`src/server.js:24310`).
- `get_pdp_v2` treats similar as non-blocking/additive: the similar promise is budgeted/deferred (`src/server.js:37045`-`src/server.js:37119`), optional modules are awaited with `Promise.allSettled()` (`src/server.js:37123`-`src/server.js:37128`), and the `similar` module can return `empty`, `deferred`, or missing data without failing the PDP (`src/server.js:38260`-`src/server.js:38303`). `resolvePdpSimilarWithBudget()` converts first-paint timeouts into a deferred envelope (`src/server.js:14001`-`src/server.js:14018`).

**Condition: sibling expansion should degrade to base refs on any transient DB error.**  
`expandAnchorRefsWithGroupSiblings()` catches only missing DB/table errors and otherwise throws (`src/auroraBff/productRelationshipGraph.js:1219`-`src/auroraBff/productRelationshipGraph.js:1262`). Because `listApprovedRelationshipEdgesForAnchor()` calls it before the resolver/collapse fallback (`src/auroraBff/productRelationshipGraph.js:1145`-`src/auroraBff/productRelationshipGraph.js:1156`), a transient `product_group_members` error suppresses curated graph cards rather than serving base-ref uncollapsed edges. The PDP still does not break because the server catches it, but flag-on collapse can be worse than flag-off graph serving for that request.

### 3. Performance

**Query count estimate per PDP when `include=similar`:**

- Master graph off, similar dedupe off: no new relation-graph DB calls.
- Master graph on, family collapse off: one `product_relationship_edges` query per graph-backed PDP similar request (`src/auroraBff/productRelationshipGraph.js:1057`-`src/auroraBff/productRelationshipGraph.js:1107`).
- Master graph on, family collapse on: one sibling-expansion query for `ext_*` anchors (`src/auroraBff/productRelationshipGraph.js:1219`-`src/auroraBff/productRelationshipGraph.js:1262`), one overfetch edge query capped at 500 (`src/auroraBff/productRelationshipGraph.js:1137`-`src/auroraBff/productRelationshipGraph.js:1156`), and one batched resolver query over all anchor/candidate refs (`src/auroraBff/productRelationshipGraph.js:1158`-`src/auroraBff/productRelationshipGraph.js:1175`).
- Similar family dedupe on: one batched resolver call over anchor + combined curated/recall items (`src/server.js:24248`-`src/server.js:24261`, `src/server.js:24269`-`src/server.js:24290`).

**Batching, caching, bounds:**

- Resolver batching is good: `resolveRelationshipGraphRefsToCanonicalEntities()` normalizes unique inputs, checks cache, and issues a single `unnest($1::text[])` query for cache misses (`src/services/catalogEntityResolution.js:473`-`src/services/catalogEntityResolution.js:519`).
- Resolver caching is on by default, with a 10-minute TTL unless overridden; cache can be disabled with `AURORA_BFF_RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_ENABLED=false` (`src/services/catalogEntityResolution.js:13`-`src/services/catalogEntityResolution.js:26`).
- Bounds are present: graph edge limit is clamped to 1..500 (`src/auroraBff/productRelationshipGraph.js:1072`-`src/auroraBff/productRelationshipGraph.js:1077`), collapse overfetch uses 500 and then slices to the requested limit (`src/auroraBff/productRelationshipGraph.js:1149`-`src/auroraBff/productRelationshipGraph.js:1156`, `src/auroraBff/productRelationshipGraph.js:876`-`src/auroraBff/productRelationshipGraph.js:878`), curated similar fetch clamps to 120 (`src/server.js:24318`-`src/server.js:24323`), and PDP similar display/candidate limits default to 12/60 and cap at 24/60 unless env raises them up to 60/120 (`src/server.js:2879`-`src/server.js:2890`, `src/server.js:3939`-`src/server.js:3952`).
- Similar first-paint budget is capped at 1.2s and can defer (`src/server.js:2850`-`src/server.js:2858`, `src/server.js:14001`-`src/server.js:14018`). In-flight coalescing prevents duplicate similar work for the same cache key (`src/server.js:24385`-`src/server.js:24398`).

**Hot-path risks:**

- Sibling expansion is not cached. The code comment explicitly says a versioned group-membership cache is a follow-up (`src/auroraBff/productRelationshipGraph.js:1217`-`src/auroraBff/productRelationshipGraph.js:1218`).
- With current prod data, per-anchor served edge counts are thin enough for the cap: max 22 edges/anchor, p90 8, avg 3.44. That makes current rollout latency risk moderate, but the code path is prepared for 500-row overfetch if data grows.

### 4. Correctness / False-Merge Risk

**Current family key behavior:**

- Explicit family ids win first (`product_family_id`, `product_line_id`, `variant_of`), then derived key `family:v1:<brand>::<shade/size-stripped-title>::<category/product_type>`, then url/ref fallback (`src/auroraBff/productRelationshipGraphSources.js:1250`-`src/auroraBff/productRelationshipGraphSources.js:1272`).
- Structured variant stripping only uses allowed labels and blocks blocked labels (`src/auroraBff/productRelationshipGraphSources.js:1168`-`src/auroraBff/productRelationshipGraphSources.js:1179`), then strips the structured variant phrase from title if enough title remains (`src/auroraBff/productRelationshipGraphSources.js:1182`-`src/auroraBff/productRelationshipGraphSources.js:1197`). Size and recognized terminal shade suffix stripping follow (`src/auroraBff/productRelationshipGraphSources.js:1199`-`src/auroraBff/productRelationshipGraphSources.js:1220`).
- Category guards block derived-key merges when both sides have conflicting categories, but allow merging when either category guard is blank (`src/auroraBff/productRelationshipGraphSources.js:1274`-`src/auroraBff/productRelationshipGraphSources.js:1301`).

**Residual risk:**

- False merge: same brand + same base title can merge across genuinely different products if category/product_type is missing on one side, because compatible derived keys allow blank category guards (`src/auroraBff/productRelationshipGraphSources.js:1295`-`src/auroraBff/productRelationshipGraphSources.js:1301`).
- False split: named variants not in the lexicon, products whose structured variant fields are missing, inconsistent brand/title text, and sets/refills/minis can remain split. Prod supports this concern: only 39 of 1,651 matched served refs had `variant_title` (2.36%); 475 had `variant_detail_label` (28.77%); no explicit product-family payload ids were present in the checked payload fields.
- Monitoring exists for collapse volume and unresolved/fallback refs (`src/auroraBff/productRelationshipGraph.js:1190`-`src/auroraBff/productRelationshipGraph.js:1204`) and for similar resolver failures (`src/server.js:24291`-`src/server.js:24300`). The collapsed edge provenance also stores `collapsed_edge_count` and representative ids (`src/auroraBff/productRelationshipGraph.js:790`-`src/auroraBff/productRelationshipGraph.js:802`).

**Condition:** add rollout dashboards/alerts for top per-anchor drop ratios, `fallback_ref_count`, `unresolved_ref_count`, `aurora_bff_similar_family_resolution_failed`, and sampled false-merge QA. There is no dedicated metric that can prove a merge was semantically correct.

### 5. Edge Cases

- Standalone/singleton products are safe: no `ext_*` refs means no sibling query; missing group siblings return the original ref list (`src/auroraBff/productRelationshipGraph.js:1215`-`src/auroraBff/productRelationshipGraph.js:1227`).
- Unresolved refs are safe: fallback resolution uses snapshot-derived family when possible and otherwise `ref:<normalized-ref>` (`src/auroraBff/productRelationshipGraph.js:595`-`src/auroraBff/productRelationshipGraph.js:612`; resolver fallback fills every unresolved input, `src/services/catalogEntityResolution.js:658`-`src/services/catalogEntityResolution.js:667`).
- Self-family drops are correct in the collapse function when anchor and candidate family keys are compatible (`src/auroraBff/productRelationshipGraph.js:846`-`src/auroraBff/productRelationshipGraph.js:854`). Tests cover same-family shade drops and sibling-expanded anchor drops (`tests/product_relationship_graph.test.js:580`-`tests/product_relationship_graph.test.js:619`, `tests/product_relationship_graph.test.js:621`-`tests/product_relationship_graph.test.js:678`).
- Curated-vs-recall ordering is intentional: curated graph items are prepended before recall items, dedupe keeps first occurrence, and the merged list slices to `k` only when curated items exist (`src/server.js:24346`-`src/server.js:24364`).
- Similar family dedupe drops items in the anchor family and falls back to merchant/product-id keys when no family key exists (`src/server.js:26092`-`src/server.js:26129`).

### 6. Rollout Safety

Recommended sequence:

1. Keep all flags false for broad prod while shipped code bakes:
   - `AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED=false`
   - `AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED=false`
   - `AURORA_BFF_RELATIONSHIP_GRAPH_PG_COLLAPSE_ENABLED=false`
   - `AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED=false`
2. Close or explicitly accept the conditions:
   - Add master-flag guard around similar family dedupe if master must gate all family logic.
   - Make sibling expansion degrade to base refs on any transient DB error.
   - Decide whether prod's `ai_approved` served-view behavior is intentional, and if yes, add `label_state` to the view/select so collapse can rank human over AI.
   - Add dashboards for collapse ratio, top anchor reductions, resolver fallback/unresolved counts, similar deferrals, DB latency, and missing/empty similar rates.
3. Enable `AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED=true` for internal/dogfood traffic first. Monitor `aurora_bff_similar_family_resolution_failed`, similar underfill/empty/deferred rates, and card diversity.
4. Enable `AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED=true` while master remains off. This is a no-op for curated graph serving but validates config propagation.
5. Enable `AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED=true` only for dogfood/internal traffic. Monitor `relationship_graph_curated_count`, `relationship_graph_served_count` (`src/server.js:24360`-`src/server.js:24370`), collapse metrics (`src/auroraBff/productRelationshipGraph.js:1190`-`src/auroraBff/productRelationshipGraph.js:1204`), PDP route health, similar deferred rate, and DB query latency.
6. Rollback is simple: turn off `AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED` to remove curated graph serving; turn off `AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED` to remove recall family dedupe; turn off `AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED` to serve raw graph edges if the master remains on.

The relationship graph is still a pre-launch pilot. The runbook requires 200 anchors, at least 70% anchors with one approved alternative, at least 100 approved niche-specialist edges, human top-3 accept rate at least 85%, unsupported-claim audit zero, and runtime exclusion of expired/stale edges (`docs/runbooks/product_relationship_graph_v1_pilot.md:88`-`docs/runbooks/product_relationship_graph_v1_pilot.md:107`). Current served data has 1,508 anchors but zero `niche_specialist` served edges, so the runbook acceptance criteria are not met as written.

## Part 2: Current PDP Structure

`get_pdp_v2` starts at `src/server.js:35694`. It is module-based and returns:

- `canonical` (required): canonical product identity, PDP payload, content/commerce provenance, product group and identity metadata (`src/server.js:37664`-`src/server.js:37690`).
- Optional `variant_selector` (`src/server.js:37692`-`src/server.js:37705`).
- Optional `offers`, built from product-group members or self-offer fallback (`src/server.js:37732`-`src/server.js:38003`).
- Optional `product_intel` (`src/server.js:38006`-`src/server.js:38067`).
- Optional formula/content modules: `active_ingredients`, `ingredients_inci`, `how_to_use`, `product_overview`, `product_facts`, `supplemental_details`, `product_details` (`src/server.js:38078`-`src/server.js:38177`).
- Optional `reviews_preview` (`src/server.js:38179`-`src/server.js:38187`).
- Optional `bundle_composition` (`src/server.js:38190`-`src/server.js:38258`).
- Optional `similar` (`src/server.js:38260`-`src/server.js:38303`).

The final payload returns `status`, `pdp_version`, `subject`, `modules`, `missing`, and metadata including `similar_status`, identity resolution, identity graph, PDP provenance, route health, and module health (`src/server.js:38320`-`src/server.js:38429`).

### Serving Eligibility Gate

`get_pdp_v2` defaults to strict serving eligibility: `shouldRequirePdpServingEligible()` returns true unless a test-only bypass applies (`src/server.js:6375`-`src/server.js:6405`). The gate is enforced after canonical product resolution (`src/server.js:36629`-`src/server.js:36699`).

The DB eligibility query resolves by `content_key`, `pivota_signature_id`, or merchant/product id; it joins `index_pipeline_state` and active `external_product_seeds` for external-seed mirrors (`src/server.js:6804`-`src/server.js:6877`). The normalized row exposes `serving_eligible`, readiness tier, blocker fields, quality score, and active external seed source match (`src/server.js:6407`-`src/server.js:6431`). The identity-listing path also requires approved/live, non-review-required `pdp_identity_listing` rows and, for external seeds, active seed + live catalog row + `index_pipeline_state.serving_eligible=true` (`src/server.js:4997`-`src/server.js:5045`; same predicate helper in `src/services/pdpIdentityGraph.js:203`-`src/services/pdpIdentityGraph.js:221`).

### Identity Model

- `ext_*`: external-seed product ids; graph anchors are stored as `product:ext_*`. `buildAnchorRefsFromProduct()` emits product id, bare id, external/source id, url, and text refs so sig/canonical PDPs can still hit ext-backed graph edges (`src/auroraBff/productRelationshipGraph.js:461`-`src/auroraBff/productRelationshipGraph.js:489`).
- `sig_*`: Pivota signature ids; `get_pdp_v2` resolves sig routes through catalog signature lookup (`src/server.js:35919`-`src/server.js:36010`).
- `pg_*` / product-group ids: durable public canonical entity when available; `canonical_entity_id` prefers internal product group id with sig fallback (`src/services/catalogEntityResolution.js:441`-`src/services/catalogEntityResolution.js:448`).
- Derived family: runtime-only family key from explicit family id or brand + stripped title + category guard (`src/auroraBff/productRelationshipGraphSources.js:1250`-`src/auroraBff/productRelationshipGraphSources.js:1272`).

### Similar-Items Path

`get_pdp_v2` requests similar only when `include` contains `similar`, `recommendations`, or `all` (`src/server.js:35856`-`src/server.js:35890`). It builds bounded fetch args (`src/server.js:4109`-`src/server.js:4171`), runs similar in parallel with reviews and within a first-paint/background budget (`src/server.js:37045`-`src/server.js:37128`), then emits the `similar` module (`src/server.js:38260`-`src/server.js:38303`).

Inside `fetchSimilarProductsDeduped()`:

1. Dynamic recall runs through `recommendPdpProducts(args)` (`src/server.js:24332`-`src/server.js:24336`).
2. If the master graph flag is on, curated graph items are fetched with `fetchRelationshipGraphSimilarItems()` (`src/server.js:24339`-`src/server.js:24344`).
3. Curated items are prepended to recall items (`src/server.js:24346`).
4. If `AURORA_BFF_SIMILAR_FAMILY_DEDUPE_ENABLED` is on, the code resolves anchor + item refs and dedupes by family (`src/server.js:24347`-`src/server.js:24355`). If off, it uses merchant/product-id dedupe only when curated items exist (`src/server.js:24354`-`src/server.js:24358`).
5. Curated wins on collisions and the final list slices to `k` when curated exists (`src/server.js:24360`-`src/server.js:24364`).

## Part 3: Relation-Graph Data Status

Source: read-only prod queries against Railway project `Pivota Infra`, service `Postgres-xMr6`, using `DATABASE_PUBLIC_URL`. I began transactions as `BEGIN READ ONLY` and did not print connection secrets. Counts below are from 2026-06-03 UTC.

### Label Store

`relationship_candidate_labels` total: **29,723** rows.

| label_state | rows |
| --- | ---: |
| generated | 18,044 |
| prefilter_rejected | 5,711 |
| ai_approved | 4,827 |
| human_rejected | 673 |
| human_approved | 358 |
| needs_evidence | 110 |

### Served View

Runtime-eligible served edge filter used the BFF serving predicates: `anchor_type='product'`, `vertical='beauty'`, `review_status='approved'`, `last_verified_at IS NOT NULL`, `expires_at > now()`.

- Served edges: **5,185**
- Distinct anchor refs: **1,508**
- Distinct candidate refs: **598**
- Distinct anchor/candidate ref pairs: **5,185**
- Last verified range: **2026-05-25T07:20:49.884Z** to **2026-06-02T04:05:52.844Z**
- Expiry range: **2026-07-17T04:05:45.753Z** to **2026-08-24T00:18:25.269Z**

By relation type:

| relation_type | edges | anchors |
| --- | ---: | ---: |
| related_product | 2,806 | 866 |
| competitive_alternative | 2,379 | 978 |

No `dupe` or `niche_specialist` edges are currently served.

Joined served edges by `relationship_candidate_labels.label_state`:

| label_state | served edges |
| --- | ---: |
| ai_approved | 4,827 |
| human_approved | 358 |

Data-risk note: local migration 046 says the runtime view should expose only `human_approved` rows (`src/db/migrations/046_relationship_candidate_labels.sql:68`-`src/db/migrations/046_relationship_candidate_labels.sql:82`), while prod currently serves `ai_approved` too. Local code also does not accept `ai_approved` in `LABEL_STATES` (`src/auroraBff/productRelationshipGraph.js:1373`-`src/auroraBff/productRelationshipGraph.js:1380`) and does not select `label_state` from the served view (`src/auroraBff/productRelationshipGraph.js:1086`-`src/auroraBff/productRelationshipGraph.js:1091`). If serving AI-approved edges is intentional, add a migration and include `label_state` in the BFF select so collapse ranking can prefer human-approved over AI-approved; otherwise prod view/data is drifted from repo expectations.

### Coverage / Concentration

Catalog snapshot:

- `catalog_products`: **7,164**
- Distinct `content_key`: **6,063**
- Live catalog products: **7,101**
- Published catalog products: **2,669**
- Rows with `pivota_signature_id`: **6,927**
- External-seed mirror products: **6,386**
- `index_pipeline_state`: **6,060** rows; **3,982** serving-eligible
- `external_product_seeds`: **6,795** rows; **6,385** active
- Live external-seed catalog products: **6,323**

Coverage by served anchor refs:

- **1,508** served anchor refs = **21.05%** of all `catalog_products`
- **21.24%** of live catalog products
- **23.85%** of live external-seed catalog products
- **37.87%** of serving-eligible index rows

Concentration:

- Avg edges/anchor: **3.44**
- p50: **2**
- p90: **8**
- max: **22**
- Top anchors have 18-22 edges each; current graph is broad-ish but still thin per anchor.

### Collapse Impact

Approximation: batched scalar resolution by served `source_product_id` and repo `familyIdentityKey()`. I avoided hydrating full edge snapshots because full JSON hydration timed out in prod read-only checks; only **2 of 1,653** served refs failed scalar catalog resolution, so this is a close approximation.

- Unique served refs: **1,653**
- Resolved unique refs: **1,651** (**99.88%**)
- Resolved anchor refs: **1,506 / 1,508** (**99.87%**)
- Fallback refs: **2**
- Derived family refs: **1,651**
- Explicit product-family ids in checked payload fields: **0**
- Refs with `variant_title`: **39 / 1,651** (**2.36%**)
- Refs with `variant_detail_label`: **475 / 1,651** (**28.77%**)

Collapse estimate:

- Raw served edges: **5,185**
- Global family-pair buckets: **3,416** (**65.88%** of raw)
- Per-anchor serving total: **5,185 raw -> 4,420 collapsed** (**85.25%** of raw)
- Anchors with any reduction: **137 / 1,508** (**9.08%**)
- Largest reduction: `product:ext_7bac80d00f1f149743824dee`, **22 raw -> 1 collapsed**
- Global self-family drops: **1**

Interpretation: global dedupe is substantial because many anchors point at the same candidate families, while per-anchor user-visible reduction is moderate and concentrated in a small set of anchors.

### Data Risks

- **Pilot acceptance not met as written:** current served data has zero `niche_specialist` edges, while the runbook requires at least 100 approved niche-specialist edges before dogfood readiness (`docs/runbooks/product_relationship_graph_v1_pilot.md:92`-`docs/runbooks/product_relationship_graph_v1_pilot.md:95`).
- **Prod view/migration drift:** served view includes 4,827 `ai_approved` edges and 358 `human_approved` edges, while local migration/code still describes human-approved runtime serving.
- **Expiry concentration:** **4,827** served edges expire within 45 days. No served edges expire within 30 days, but this needs an alert before dogfood traffic depends on the graph.
- **US-only:** all 5,185 served edges are `US`; no non-US market coverage.
- **Relation mix:** only `related_product` and `competitive_alternative` are served; no `dupe`/`niche_specialist`.
- **Family-key health:** resolver hit rate is excellent, but explicit family ids are absent and structured `variant_title` coverage is low. Most collapse confidence comes from derived title/brand/category keys, not durable family metadata.
- **Potential bulk validation gap:** prod provenance text matched "bulk" on 1 served edge; low count, but keep checking after data refreshes.

## Final Verdict

**GO-WITH-CONDITIONS.**

The shipped code is safe to remain merged because the online paths are default-off and PDP-serving failures degrade additively. Controlled dogfood can proceed after closing or accepting the listed conditions. I would not enable broad/public relationship-graph serving until:

1. Prod served-view `ai_approved` behavior is reconciled with repo migrations/code, and `label_state` is surfaced if AI-approved edges remain served.
2. Sibling expansion fails back to base refs on transient DB errors.
3. Monitoring exists for collapse ratio, resolver failures/fallbacks, PDP similar deferrals, top anchor reductions, and edge expiry.
4. Pilot acceptance criteria are updated or met, especially the missing `niche_specialist` served edges.
