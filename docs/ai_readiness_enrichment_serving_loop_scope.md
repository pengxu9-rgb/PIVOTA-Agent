# AI-Readiness Scope — Close the enrich → publish → serve → cite loop

**Goal:** Make a measured-thin SKU's audit-driven enrichment actually reach the *served*
Pivota canonical PDP that frontier agents read — so the merchant's owned surface carries
the enriched, intent-targeted copy and can be cited. Today it doesn't: the enrichment is
written but is a dead-end.

Status: **SHIPPED + LOOP VERIFIED LIVE** (2026-06-21, main @ 6c8a4f69). Phase A (#964),
Phase C (#966), R3 quarantine (#963) all deployed; collagen canary proven served via the
live agent PDP endpoint (see "LOOP CLOSED + VERIFIED LIVE" in §2). R5 (wix) + V1 (systemic
non-audit re-score) remain open. Root cause from a holistic agent + live prod DB read.
Code refs are against deployed `origin/main` (line numbers approximate).

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

**R3 — quarantine the review test account WITHOUT unbinding the store** (decision: keep the store
bound so the App Store review can still proceed; just stop `merch_bbd34645bc1950cc` from shadowing
Chydan's canonical). Live blast radius: the review account is a 1:1 shadow — **361/361 of Chydan's
canonical content_keys are duplicated under it, it wins `pick_canonical` for all of them** (lower
`product_key`), it has **0 enrichment of its own**, and **8/8 of Chydan's enrichments are currently
shadowed** (all future ones too). De-conflation hands all 361 back to Chydan.

Mechanism (all confirmed against `origin/main @ 0f1b4782`):
- The existing quarantine/trust machinery is **computed but NOT enforced** at the serving-assembly
  layer. `agent_pdp_view_assembler` loads rows for a content_key filtering **only by `content_key`**
  (`:70-95`); `pick_canonical` (`:249-262`) only respects `group_primary → has_sig → lowest
  product_key`. `catalog_trust_policy` emits `SOURCE_QUARANTINED`/`ROW_TOMBSTONED` block reasons,
  but only `catalog_trust_policy` + `catalog_row_trust_upserter` anti-join the quarantine — the
  serving assembly does not. (Latent finding: quarantine controls silently don't gate the served PDP.)
- **Step 1 (data, reversible):** add a `catalog_source_quarantine` row via
  `source_quarantine.create_quarantine(match_type='merchant_platform',
  match_value='merch_bbd34645bc1950cc:shopify', state='active', reason='App Store review test
  account duplicating Chydan catalog', created_by=...)`. (`match_value` convention =
  `<merchant_id>:<platform>`, `source_quarantine.py:64`.) It's an **opt-in reader anti-join overlay
  that does NOT touch ingestion** (migration 134) — the store stays bound + syncing. **Re-sync
  durable (confirmed):** `catalog_sync` writes `catalog_products`, never `catalog_source_quarantine`,
  so the entry persists across every sync. Reversible: `state='revoked'`.
- **Step 2 (code, surgical):** add the quarantine anti-join to the rows feeding `pick_canonical` —
  use the ready-made `source_quarantine.build_quarantine_anti_join_sql(...)` in the `:70-95` loader,
  and apply at BOTH `pick_canonical` call sites (`:640` assemble_row, `:860` overlay fetch — confirm
  they share the loader or wire both). Keep it surgical (anti-join active source-quarantine only —
  NOT the full `serving_decision`; enforcing all of Layer C1's block reasons at once could drop
  legitimate rows from the 353 currently serving — separate careful change). Recurrence-proof: any
  future quarantined source is auto-excluded.
- **Step 3 (rollout):** `agent_pdp_view` is materialized, so refresh the 361 affected content_keys
  (or let the next catalog_sync/audit do it) for the new canonical pick to take effect.
- Effect: Chydan wins `pick_canonical` for all 361 → overlay fetches Chydan's enrichment → served
  PDP carries Chydan's copy. NOTE: this fixes the **content/ownership** axis only. The collagen also
  needs **Phase A** (it's not `serving_eligible` — no quality snapshot); the other 353 are already
  serving and improve immediately. Caveat: confirm the App Store reviewer isn't actively relying on
  Chydan's store via the review account before quarantining (a real review should use its own store).
- Defense-in-depth (optional): make `_fetch_enrichment_for_canonical` fall back to any merchant on
  the content_key that has enrichment when the canonical pick has none.

**R5 (wix) — ROOT-CAUSED, needs a decision (deferred).** Live: all 20 Chydan wix SKUs have
`content_key = NULL` because **they have no brand** (`brand="(none)"`; titles are present), and
`catalog_identity.make_content_key(brand, title, gtin)` returns null unless BOTH brand and title are
set. So it's not a wix-sync minting bug per se — it's brand-less products hitting the brand-required
key rule. Fix options (each needs a call, none is a safe mechanical patch):
- (a) make `make_content_key` brand-optional (fall back to title[+merchant]) — **risky**: changes
  content_key derivation for ALL platforms → could re-key existing shopify products + break the serve
  cache / cross-merchant de-dup.
- (b) backfill a brand for wix products in the sync (store/merchant name?) — needs a product decision
  on what brand value, and it shows on the served PDP.
- (c) a non-content_key serve path for wix — architectural.
Lower priority (20 SKUs, secondary platform). Recommend a focused follow-up after picking an option.

### Status (2026-06-21)
- **R3** ✅ SHIPPED + verified (#963 code + quarantine row; merch_bbd 0/743 survive; 355/361 cache rows already Chydan). **Closure verified: 0 merch_bbd-owned APV rows remain.**
- **Phase A** (R1/R2/R6) ✅ SHIPPED — PR #964 (main @ 58e8b9c1). V2 validated (collagen real-path score ~71.2 ≥ 65). E1 now scores + recomputes serving-eligibility after enriching.
- **Phase C** (R4) ✅ SHIPPED — PR #966 (cherry-picked onto main @ 6c8a4f69; #965 auto-closed when #964's base branch was deleted). Retry + raised token cap + reason logging.
- **R5** (wix) — root-caused (brand-less → null content_key); deferred, needs an option decision (above).
- **V1 / dormant pipeline** — open: quality-eval newest snapshot 2026-06-05; Phase A fixes the audit-driven re-score, but SKUs changed OUTSIDE an audit still don't re-score. Systemic blanket re-score / un-dormant the nightly = follow-up. (For Chydan the missing-snapshot population turned out to be only 2 SKUs — most already had snapshots.)

### ✅ LOOP CLOSED + VERIFIED LIVE (2026-06-21, collagen canary)
The re-audit is a **no-op** for the collagen: E1 skips already-enriched SKUs (`description_markdown` non-empty), and an audit triggers neither a re-sync nor a backfill. So Phase A only ever fires on *newly*-enriched SKUs. To close the loop on an **already-enriched** SKU, two product-path actions were run on Chydan (user-authorized) via the product's own service functions:
1. **Re-sync** = `refresh_agent_pdp_view_for_content_key(ck, refresh_source=…)` → quarantine anti-join drops merch_bbd → Chydan wins → 878-char enrichment overlays. (1 APV row was still merch_bbd-owned — the collagen.)
2. **Backfill** = `create_quality_backfill_job(merchant_id=CHY, missing_only=True)` + `process_quality_backfill_job(jid)` (job `qbf_82ec455da323429ea675`; 2 scored, 741 skipped, 0 failed) → writes the missing `product_quality_snapshot` → `full_quality_eval` recomputes `serving_eligible`.

**Verified end-to-end** — `GET https://api.pivota.cc/api/agent/pdp/ck_431a34c88abacb0c567575bfb97dcd69` → HTTP 200, returns Chydan's enrichment: brand `NUTRIONE CO., LTD`, the flagged facts ("low molecular weight fish collagen… 1,200 mg… 1,000 Daltons… Halal certified… Vitamin C, Glycine… Hyaluronic Acid, Elastin"), 2 offers **both merchant_name="Chydan"** (zero merch_bbd), price $49.38–$70.17. `index_pipeline_state`: serving_eligible=TRUE, blocker=none, score=71.2.

**Gotcha for next time:** the serving gate reads `content_quality_score` ONLY from `product_quality_snapshot`; a missing snapshot = `low_quality` blocker even when the APV content is perfect. Already-enriched SKUs need the **quality-backfill job** (no UI button; `POST /merchant/products/quality/backfill`, bearer auth) to get a snapshot — Phase A/E1 won't touch them. catalog_sync recomputes serving but does NOT write a snapshot, so a plain re-sync alone won't flip an unscored SKU.

- Minimal set to fix one already-enriched SKU = **APV refresh + quality-backfill** (both product-path). Phase A covers the newly-enriched case automatically going forward.

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
