# AI-Readiness Scope — Close the enrich → publish → serve → cite loop

**Goal:** Make a measured-thin SKU's audit-driven enrichment actually reach the *served*
Pivota canonical PDP that frontier agents read — so the merchant's owned surface carries
the enriched, intent-targeted copy and can be cited. Today it doesn't: the enrichment is
written but is a dead-end.

Status: **SCOPED** (no code yet). Root cause from a holistic agent + live prod DB read,
2026-06-21. Code refs are against deployed `origin/main @ 0f1b4782` (line numbers approximate).

> **Decision baked in:** `merch_bbd34645bc1950cc` (shopify-review@pivota.cc) is the **App
> Store review test account** that connected the *same* Shopify store as Chydan, duplicating
> the catalog. So R3's fix is **de-conflation** (exclude test/review merchants from canonical
> ownership), not multi-merchant canonical semantics.

---

## 1. The shape of the problem — two orthogonal axes, six root issues

Serving is NOT off catalog-wide (353/361 Chydan content_keys are `serving_eligible`). The
collagen is an **outlier blocked on BOTH axes simultaneously** — and the loop needs both
working for any thin SKU.

### Axis 1 — SERVING (`serving_eligible` won't flip)
- **R1 — enrich never writes a `product_quality_snapshot`; the gate reads only that table.**
  `index_pipeline_state_service.py:~502-515` pulls `content_quality_score` *exclusively* from
  `product_quality_snapshot`; `:~269-275` sets `low_quality` / "no quality snapshot found" when
  it's null. `full_quality_eval` (`product_quality_service.py:~832`) is called ONLY by
  product_quality_routes, `product_quality_backfill_service:~127`, `product_enrichment_pipeline:~221`,
  `external_seed_servability:~94` — **not** E1 (`canonical_pdp_enrichment.py`) or catalog_sync.
  Live: collagen has **0** snapshot rows; newest non-seed snapshot for any real merchant =
  **2026-06-05** → the quality-eval pipeline is **dormant for real merchants**. `nightly_index_health_job`
  READS snapshots, never creates them. Scope: 19/763 Chydan SKUs have no snapshot.
- **R2 — enrich never re-scores existing snapshots (the worse half).** Even SKUs with a stale
  snapshot keep their old low score. Live: 6 blocked CKs at score 56–57 (<65); two enriched
  2026-06-20 still read 57 from a 2026-06-05 snapshot. This is the dominant catalog-wide failure
  mode — "enrich does nothing for serving."
- **R6 — E1 doesn't recompute eligibility after publishing.** `canonical_pdp_enrichment.py:~561-572`
  refreshes the view but never calls `recompute_serving_eligibility` (catalog_sync does, `:~1490`).
  Latency/consistency gap; matters once R1/R2 land.

### Axis 2 — CONTENT (served copy is catalog text, not the enrichment)
- **R3 — the overlay is fetched for the wrong merchant on shared content_keys.**
  `agent_pdp_view_assembler._fetch_enrichment_for_canonical:~849-877` calls `pick_canonical(products)`
  (`:~249-262`, tiebreak primary → has-sig → **lowest `product_key` ASC**) then
  `get_enrichment(canonical.merchant_id, …)`. The collagen's content_key is shared by Chydan
  (has the enrichment) and the **review test account** `merch_bbd…` (no enrichment); `merch_bbd`
  sorts lower → overlay fetches it → 0 rows → `assemble_row:~659-664` falls back to catalog text.
  Live: **Chydan wins canonical for 0/361 shared content_keys** — catalog-wide leak (even
  `serving_eligible=TRUE` CKs serve catalog copy). Root: the duplicate catalog from the review account.
- **R5 — wix SKUs have `content_key = NULL` → publish skipped.** E1 publishes only `if content_key:`
  (`canonical_pdp_enrichment.py:~562-565`); the whole IPS/APV/serve layer is content_key-keyed.
  Live: 20/20 Chydan wix SKUs have null content_key → never serve.

### Upstream of everything
- **R4 — E1 Gemini generation fails ~55%.** `_generate_enrichment:~424-459` /
  `_parse_enrichment_response:~373-421`: `gemini-2.5-flash` (`:~70`) + `google_search` tool (`:~437`,
  required for grounding) + `maxOutputTokens=2048` (`:~435`), single attempt. Grounded responses
  wrap JSON in prose/citations or get truncated by thinking tokens → None. Live: 11 failed / 9
  enriched across Chydan runs (both platforms). No copy → nothing to publish or score.

### Dependency map
```
R4 (no copy ~55%) ─────────────────────────────────────────────┐
                                                                ▼
ENRICH ─┬─ SERVE axis:  R1 (no snapshot) + R2 (no re-score) ─→ serving_eligible can't flip ─→ R6 latency
        └─ CONTENT axis: R3 (overlay→review acct) + R5 (wix null CK) ─→ served copy = catalog / no publish
```
- R1/R2 gate **serving**; R3/R5 gate whether the served copy is the **enrichment**. Both axes must
  work. Collagen is blocked on **R1/R2 AND R3**.

---

## 2. Fix plan (phased by dependency)

### Phase C — Generation reliability (R4) · independent quick win, do first
Harden `_generate_enrichment` + `_parse_enrichment_response`:
- Retry (≥2 attempts) on None/non-200/timeout.
- Raise `maxOutputTokens` (2048 → ~4096) so thinking tokens don't truncate the JSON.
- Robust JSON extraction: locate the outermost `{…}` even when wrapped in prose/citations
  (not just fence-stripping); relax the hard `<200` reject to a warning + keep shorter valid copy.
- Log the real failure class (status/excerpt) into evidence so the failure split stops collapsing
  to one opaque string.
Target: lift yield from ~45% toward ~90%. Pure executor change + unit tests.

### Phase A — Serving (R1 + R2 + R6) · the "enrich actually flips serving" fix
After `upsert_enrichment`, E1 must:
1. Call `full_quality_eval` for the enriched SKU **with the enrichment overlay** (mirror
   `product_enrichment_pipeline:~221`) → writes/refreshes `product_quality_snapshot`.
2. Call `recompute_serving_eligibility` (mirror catalog_sync `:~1490`) after the APV refresh.
- Reuse-don't-rebuild: `full_quality_eval`, `build_quality_payload(product, enrichment)`,
  `recompute_serving_eligibility` all exist; E1 just isn't calling them.
- **Systemic companion:** the pipeline is dormant — add/confirm a scheduled blanket re-score (or
  un-gate the nightly) so SKUs changed outside an audit also re-score. (Gated on V1 below.)
- **Blocked on V2 (below):** Phase A only closes the loop if the enrichment actually scores ≥65.

### Phase B — Content correctness (R3 + R5)
- **R3 (de-conflate the review account):** the review/test merchant must not own or shadow a real
  merchant's canonical PDP.
  - Primary: exclude test/review merchants from `pick_canonical` candidacy and from the
    catalog/serving layer (check for an existing test/account-type flag; reuse the
    source-quarantine machinery if applicable — `pivota-backend-source-quarantine` branch / R0-R3
    de-conflation precedent). Then Chydan wins its own canonical → overlay fetches its enrichment.
  - Defense-in-depth (do regardless): make `_fetch_enrichment_for_canonical` fall back to **any
    merchant on the content_key that has enrichment** when the canonical pick has none — so a
    future enrichment-owner≠canonical-pick case can't silently drop the overlay.
  - One-time: quarantine/remove the review account's duplicate catalog rows for Chydan's store.
- **R5 (wix):** give wix SKUs a content_key (preferred — unifies them into the serve layer) or a
  non-content_key publish path. Lower priority (20 SKUs); confirm wix content_key minting is just
  missing vs intentionally deferred.

### Sequencing
**C** (independent) → **A** (after V2) → **B** (R3 first, then R5). Minimal set to fix the
collagen = **A + R3**. Minimal set to fix the common thin-SKU case = **A** alone.

---

## 3. Open validations to resolve before/while building
- **V1 — Are the quality/index-health crons actually firing in prod?** The 2026-06-05 snapshot
  ceiling implies dormant, but that needs **Railway scheduler logs** (outside the DB) to confirm.
  Determines whether Phase A's systemic companion is "un-dormant the nightly" vs "the nightly runs
  but never scores — add a re-score step."
- **V2 — Would the collagen's enrichment score ≥65 if re-scored?** Validate by running the scoring
  logic in isolation (`build_quality_payload(product, enrichment)` → score) **without persisting a
  snapshot** (read-only). If it doesn't clear 65, Phase A also needs scoring/enrichment tuning, not
  just a re-score trigger. **Do this first — it gates Phase A's viability.**
- **V3 — wix content_key:** is it intentionally null (wix not yet in the canonical program) or a
  minting gap? Confirm before R5.

---

## 4. Test + verification plan (local; CI billing-blocked)
- Phase C: unit tests for retry, token budget, prose-wrapped-JSON extraction, short-but-valid copy.
- Phase A: unit test that E1 invokes `full_quality_eval` + `recompute_serving_eligibility` for each
  enriched SKU; assert evidence records the new score + eligibility.
- Phase B/R3: test that test/review merchants are excluded from `pick_canonical`; test the overlay
  falls back to the enrichment-bearing merchant.
- **Live proof (the real loop):** after deploy, re-audit the collagen → confirm via live DB
  (read-only `railway run`): `product_quality_snapshot` row exists with score ≥65 →
  `index_pipeline_state.serving_eligible = TRUE` → `agent_pdp_view.description` = the enrichment (not
  catalog) → `agent_pdp_v1` serves it. (Account/DB caveats: use `DATABASE_PUBLIC_URL`;
  `product_enrichment` has no `content_quality_score` col; `agent_pdp_view` has no `updated_at` col;
  always confirm the portal sidebar shows peng@chydan.com before trusting Chydan data.)

## 5. Risks
- **V2 fails** (enrichment doesn't clear 65) → Phase A insufficient; scoring needs tuning. Validate first.
- **De-conflating the review account** could affect App Store review setup — confirm the review
  account doesn't need its own served PDPs before excluding it.
- **Re-scoring at enrich time** adds latency/cost to E1; keep it bounded (only the enriched SKUs, ≤5/run).
- **Catalog_sync ordering** — confirm a later catalog_sync doesn't re-block a SKU E1 just flipped
  (it recomputes eligibility from the snapshot, so should be fine once the snapshot exists).
