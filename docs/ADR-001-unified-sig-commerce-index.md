# ADR-001: Unify internal and external products under the sig-keyed commerce index

**Status:** Proposed
**Date:** 2026-07-30
**Deciders:** Peng (product/eng), pivota-backend owner (internal lane is their HTTP surface)

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

1. **Identity** — one product node per sig. Internal rows and external seeds
   sharing a sig are the same product. (Already the direction of travel;
   becomes the primary model, not a reconciliation afterthought.)
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
surfacing as a fixable data defect). Since recall is already external-only in
production, B's recall unification changes *plumbing*, not serving behavior; the
behavioral change is confined to the offer layer, which is additive.

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

1. [ ] **Index completeness:** make sig-identified, external-backed products
   first-class rows in the serving index (graduation pipeline already feeds it);
   add sig-collision detection to ingest with a review queue.
2. [ ] **Single-lane recall:** collapse the three executors to one index search
   path; keep emitting `retrieval_source`/ledger fields derived from offer data
   for contract compatibility. Gate behind an env flag mirroring the
   kill-switch pattern for rollback.
3. [ ] **Offer layer:** model internal inventory and external destinations as
   offer rows with source/trust/purchasability; move
   `choosePreferredExternalSeedCandidate` semantics into an offer-selection
   policy module with unit tests (preference parity tests against current
   behavior).
4. [ ] **Deletion:** remove `source_scope` stages, dual transports,
   `AURORA_RECO_INTERNAL_RECALL_LANE_MODE`, and per-lane gates once trust-gate
   parity and preference parity tests are green in prod shadow.

**Invariants needing tests before phase 4:** sig uniqueness per product line;
trust-gate parity (no row served post-migration that a per-lane gate would have
blocked); offer-preference semantics (internal-purchasable beats external at
equal trust); recall latency budget (p95 single-lane ≤ current gated path).

## Related

- PRs #1863 / #1864 / #1865 — the kill-switch triplet motivating this ADR.
- `docs/CATALOG_ROW_TRUST_CONTRACT.md` — trust predicates to re-home at the
  offer layer.
- `docs/services_provider_integrations_design.md` — same motif in the services
  domain: source becomes a data column (`capability`) dispatched by policy, not
  parallel code paths. (Note: it reserves migration number `049`, which is now
  taken by `049_index_pipeline_state_readiness_tier.sql` — renumber on
  implementation.)
