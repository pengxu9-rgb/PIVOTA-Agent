# ADR-020: Unify internal and external recall lanes; internal vs external becomes offer source

**Status:** Proposed
**Date:** 2026-07-30
**Deciders:** Peng (product/eng), pivota-backend owner (internal lane is their HTTP surface)
**Builds on:** ADR-007 (citable index vs commerce overlay), ADR-009
(seller-of-record identity; "gate on platform, not `merchant_id='external_seed'`"),
ADR-010 (canonical product identity — `content_key` spine, resolver-owned),
ADR-012 (catalog convergence: reconcilers, not pokes) — all in
`pivota-backend/docs/adr/` — and `docs/COMMERCE_INDEX_CONVERGENCE_AND_PUBLISH_PLAN.md`
(approved 2026-06-25), whose Part A already committed the Node gateway as the
single agent-facing recall engine. This ADR extends that decision **within**
the gateway: Part A unified gateway-vs-backend; this unifies the gateway's own
internal/external lanes. Numbered in the shared `pivota-backend/docs/adr/`
sequence (next free after ADR-019); lives in this repo because the affected
code does.

> **Identity-key note (per ADR-010, which this ADR defers to):** the row-level
> identity spine is **`content_key`** (PRIMARY KEY of `agent_pdp_view`);
> `pivota_signature_id` is the per-merchant, write-once **public citation
> handle**; `product_group_id` is internal grouping. Where this document says
> "sig-keyed", read it as shorthand for "canonical identity per ADR-010's
> resolver, with sig as the public handle" — recall unification does not
> re-decide the identity grain.

## Context

Pivota's product recall was designed around a two-population model: *internal*
products (merchant inventory served by pivota-backend) and *external* products
(seeded from official/retail pages, served from the agent's own DB). Strategy has
shifted: every product is identified by its catalog signature
(`pivota_signature_id`, "sig"), the commerce index is searched by sig identity,
and "internal vs external" is no longer a product distinction — it is a
difference in **offer source** on the same product.

The codebase has not caught up. The internal/external split is encoded in
*control flow* at every layer of recall:

- **Recall plans** (`src/auroraBff/recoRecallPlanner.js`) emit source-scoped
  *stages* (`source_scope: 'internal' | 'external_seed'`) with ordering
  semantics — internal first, external as fallback via
  `if_no_primary_viable_or_transient_only`.
- **Two transports per scope**: `searchPivotaBackendProducts` (HTTP to
  pivota-backend `/agent/v1/products/search`, `allowExternalSeed: false`,
  `externalSeedStrategy: 'legacy'`) vs `searchLocalExternalSeedProducts`
  (local DB).
- **Three executors** each re-implement the stage walk: the stage-policy path
  (`collectRecoCandidatesFromRecallPlan`), the live chat lane
  (`collectRecoCandidatesFromQueryLevels`), and the exact-product grounding
  loop inline in `resolveCatalogProductForProductInput`.
- **Post-hoc adjudication between lanes**: `choosePreferredExternalSeedCandidate`,
  `retrieval_source` filtering, per-lane dedupe.

The cost became concrete in the **2026-07-29 latency incident**: pivota-backend's
internal lane serves only from `products_cache`, which holds no real inventory,
so every internal-scope recall call was a guaranteed-empty ~1s HTTP round trip.
Fixing it required **three separate PRs** (#1863, #1864, #1865) installing the
same env kill-switch (`AURORA_RECO_INTERNAL_RECALL_LANE_MODE`, default disabled)
in three executors — direct evidence that lane identity lives in code paths, not
data. Meanwhile prod recall is effectively **external-only today**: the unified
model is not a risky bet on an unproven lane; it is an accurate description of
current serving reality.

The split is also already a **hybrid in disguise**: `canonicalCatalogSearch`
(the "catalog" lane) consults `external_product_seeds` up to three times per
request via EXISTS subqueries (market pass-through, brand match, unavailability
exclusion), while the seed lane serves *graduated* rows through dedicated
attached-seed indexes (migration 035) — and the brand fastpath now *requires*
graduation (`attached_product_key IS NOT NULL` + serving-eligible catalog
join). Neither lane is what its name claims; unification is partly a matter of
admitting this.

Crucially, the **identity layer already exists**:
`src/services/catalogEntityResolution.js` groups catalog rows by
`pivota_signature_id` with `source_kind: 'canonical_catalog'` and
`source_tier: 'brand' | 'merchant'`, and the external-seed pipeline already
converges on sig identity (`align-external-seed-identity-to-catalog-sig`,
`sync-external-seeds-to-catalog`, the IPS graduation flow). What remains split
is **recall** (which lane do we query) and **offers** (where does purchase
intent go).

### Forces

- Latency: every source-scoped stage is a serial retrieval wave; empty lanes
  cost full timeouts before productive lanes run.
- Consistency: three executors × N stages must agree on skip/preference
  semantics; today they drift (hence three gate PRs).
- Trust: quality gates (skincare guard, quarantine, synthetic-review
  quarantine, `CATALOG_ROW_TRUST_CONTRACT.md`) are applied per-lane; a unified
  index must not weaken them.
- Coordination: the internal lane is pivota-backend's surface; retiring it as a
  *recall* dependency is an agent-side decision, but re-feeding internal
  inventory as *offers* needs backend alignment.

## Decision

Treat internal and external products as **equal at the identity and recall
layers, distinct only at the offer layer**:

1. **Identity** — one canonical product node per ADR-010's resolver
   (`content_key` spine, `product_group_id` grouping, sig as public handle).
   Internal rows and external seeds resolving to the same canonical identity
   are the same product. (Already the direction of travel; becomes the primary
   model, not a reconciliation afterthought.)
2. **Recall** — one commerce-index search per query against the sig-keyed
   index. No `source_scope` stages, no per-lane transports, no inter-lane
   preference logic, no kill-switch.
3. **Offers** — internal inventory and external destination URLs become offer
   rows on the product, each carrying `source`, trust tier, and purchasability.
   "Prefer internal when purchasable" becomes offer-selection *policy* —
   cheap, testable, and free when one source is empty.

## Options Considered

### Option A: Status quo — source-scoped lanes + env kill-switch

| Dimension | Assessment |
|-----------|------------|
| Complexity | High (3 executors × stage machinery × 3 gates) |
| Cost | Ongoing: every recall change lands N times; empty lanes burn latency unless gated |
| Scalability | Poor — each new source (retailer feeds, partner catalogs) adds a lane and more stage logic |
| Team familiarity | High (it's what exists) |

**Pros:** No migration; kill-switch already restores the lane if backend fixes inventory.
**Cons:** The #1863/#1864/#1865 pattern repeats for every future source; lane preference is untestable control flow; identity duplication persists at serving time.

### Option B (chosen): Unified sig-keyed index; internal/external as offer source

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium during migration, Low after (one lane, one policy module) |
| Cost | One-time migration (4 phases below); deletes ~3 gates + stage machinery |
| Scalability | Good — new sources are new offer rows + index ingest, zero recall changes |
| Team familiarity | Medium — sig model already in use in pipeline scripts |

**Pros:** Single recall call per query (strictly less latency than the gated status quo); preference/trust become data-driven policy; kill-switch and stage ledgers deletable; matches actual strategy.
**Cons:** Sig collision quality becomes load-bearing (a collision is now a user-visible data bug, not a lane-preference call); trust gates must be re-homed before lane deletion; consumers of `retrieval_source` in PDP/serving contracts need a compatibility story.

### Option C: Keep two lanes, fan out concurrently, merge by sig

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium (merge layer added, lanes kept) |
| Cost | Lower migration cost; permanent double-query cost |
| Scalability | Poor — still a lane per source |
| Team familiarity | High |

**Pros:** No index/ingest work; kills the serial-stage latency problem.
**Cons:** Keeps dual transports and per-lane gates; sig merge happens per-request instead of at ingest; doesn't deliver the strategy, just hides the seams.

## Trade-off Analysis

The real choice is **where the internal/external distinction lives**: in control
flow (A, C) or in data (B). Control flow scattered the same concern across three
executors and required three synchronized patches for one incident; data puts it
in one offer-policy module with unit tests. Option B's genuine risk — sig
quality — is not avoided by A or C; it is merely masked by lane preference
(today a bad sig association silently loses to lane ordering instead of
surfacing as a fixable data defect). Recall unification is *mostly* plumbing,
but two verified behavior deltas must be shadow-compared, not assumed away:
`retrieval_source`-conditioned scoring (`routes.js:78806` grants `catalog` rows
a 0.06 vs 0.03 bonus, and several external-seed authority gates key on the
value), and the catalog lane's rank/market semantics (`+200` for
`pdp_scope='multi_merchant_canonical'` is the dominant rank term, and the
market filter *exempts* that same scope — which the sync stamps on every
graduated row, making the filter a no-op for exactly the migrating
population).

## Consequences

**Easier:**
- Recall latency: one index query per query-level; no empty-lane waves, no
  gates, no skip ledgers.
- Adding sources (retail feeds, partner catalogs): ingest + offer rows only.
- Reasoning about preference: offer-selection policy is a pure function of
  offer rows.

**Harder / new obligations:**
- Sig assignment quality gates at ingest (collision detection, review queues) —
  currently pipeline-script concerns become serving invariants.
- Trust gates must be expressed as row/offer predicates
  (`CATALOG_ROW_TRUST_CONTRACT.md` alignment) before per-lane gates are removed.
- pivota-backend coordination: internal inventory re-enters via offer ingest,
  not via restoring `/agent/internal/products/search` recall.

**Revisit:**
- `AURORA_RECO_INTERNAL_RECALL_LANE_MODE` and the stage-scope machinery are
  deleted at the end of migration — until then the flag remains the rollback
  posture.
- `retrieval_source` in serving contracts: keep emitting during migration
  (derived from winning offer source), deprecate after consumers migrate.

## Migration (each phase independently shippable)

0. [ ] **Ground truth + parity harness:** all work is derived from and verified
   against `origin/main` (local checkouts drift). Build an offline
   recall-parity harness replaying a query corpus through both lanes; use it to
   enumerate the *actual* recall gaps before committing projection scope. This
   is the same instrument the convergence plan's step A4 specifies for
   gateway-vs-backend parity — reuse its golden corpus
   (`pivota-agent-ui/scripts/eval_corpus_recall_v1.jsonl`) rather than minting
   a new one.
   (Adversarial review 2026-07-30 falsified an earlier premise here: graduation
   does **not** downgrade recall — attached seeds have dedicated indexes and
   the brand fastpath requires them. The real gap is that search still runs
   against the raw seeds table with per-request catalog joins.)
1. [ ] **Index completeness:** project the seed recall doc **plus market/tool
   scoping, availability, and brand-alias state** into `catalog_products` — per
   ADR-012, as a **convergent reconciler with a drift metric**, not a sync-time
   poke — so no per-request `external_product_seeds` join survives. New
   trgm indexes go in with `CREATE INDEX CONCURRENTLY` (live serving table).
   Recalibrate `rank_score` (the `+200 multi_merchant_canonical` term currently
   outranks external over internal systematically) and fix the market-filter
   exemption for that scope. Add sig-collision detection to ingest with a
   review queue.
2. [ ] **Single-lane recall:** extract one search interface — it must carry
   role/step/target-context, not just `{query, market, limit}`, or the
   executors cannot reach parity. Cut over executors one at a time behind
   `AURORA_RECO_UNIFIED_RECALL_MODE`: **stage-policy path first** (simplest,
   already flag-gated), chat query-levels second, the grounding loop **last**
   (most bespoke semantics: run_if skips, strict-filter picking, inter-lane
   adjudication). Keep emitting `retrieval_source` derived from row provenance
   — but treat this as a **behavior change with its own shadow comparison**,
   not a compatibility no-op (scoring and authority gates key on it).
3. [ ] **Offer layer:** define `offer_source` (`internal_merchant |
   external_referral`) and an explicit `purchasable` field (today inferred
   from URL shape per call site); reconcile `purchase_route`'s zod enum with
   `pdpBuilder`'s wider informal vocabulary — noting most offer schemas are
   `.strict()`, so "additive" fields need a schema audit first. Converge
   grouping keys on sig with an **explicit backfill** (the sync deliberately
   preserves legacy `product_group_id`s, and `pg:pid:` fallbacks are still
   minted at multiple server.js sites). Formalize `offersPriority` as the
   single preference module with parity tests.
4. [ ] **Deletion:** remove `source_scope` stages, dual transports,
   `AURORA_RECO_INTERNAL_RECALL_LANE_MODE`, and per-lane gates once trust-gate
   parity and preference parity tests are green in prod shadow. Note the trust
   gate is a **cross-repo dependency**: `catalog_row_trust` is defined by a
   pivota-backend migration and its rollout (replacing
   `index_pipeline_state.serving_eligible`) must complete first — backend
   commitment required, which is why they are a decider on this ADR.

**Invariants needing tests before phase 4:** sig uniqueness per product line;
trust-gate parity (no row served post-migration that a per-lane gate would have
blocked); offer-preference semantics (internal-purchasable beats external at
equal trust); market/tool scoping parity (no cross-market seed resurfaces);
seeds-table independence (zero per-request `external_product_seeds` joins in
the unified lane); recall latency budget (p95 single-lane ≤ current gated
path).

## Related

- `pivota-backend/docs/adr/` ADR-007, ADR-009, ADR-010, ADR-012 — see header;
  ADR-009 in particular already mandates gating on `platform`, not the legacy
  `merchant_id='external_seed'`, which Phase 3's `offer_source` derivation must
  follow.
- `docs/COMMERCE_INDEX_CONVERGENCE_AND_PUBLISH_PLAN.md` — Part A (gateway as
  the single recall engine) is the parent decision; its A4 parity harness and
  `eval_corpus_recall_*` corpus are reused in Phase 0.
- PRs #1863 / #1864 / #1865 — the kill-switch triplet motivating this ADR.
- Adversarial plan review (2026-07-30) — corrected the graduation-recall
  premise, surfaced the market-filter/rank-score interactions, the
  `retrieval_source` behavior deltas, and the cross-repo trust-gate
  dependency folded into the migration above.
- `docs/CATALOG_ROW_TRUST_CONTRACT.md` — trust predicates to re-home at the
  offer layer.
- `docs/services_provider_integrations_design.md` — same motif in the services
  domain: source becomes a data column (`capability`) dispatched by policy, not
  parallel code paths. (Note: it reserves migration number `049`, which is now
  taken by `049_index_pipeline_state_readiness_tier.sql` — renumber on
  implementation.)
