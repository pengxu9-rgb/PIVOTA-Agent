# find_products_multi actives — Phase 2 scope

**Status:** scope only (no code). **Date:** 2026-06-15. Builds on Phase 1
(`docs/find_products_multi_actives_recall_design.md`, shipped + live behind
`PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED`, pilot rank 38→5).

Phase 1 fixed the **ranking** miss for category-bearing queries ("soy firming cream")
in the agent's mainline ranker. Phase 2 covers what Phase 1 deliberately left:
(1) the **recall** miss for queries that don't resolve a category (bare
"soy isoflavones", "adenosine") where the product never enters the candidate pool;
(2) making it work **catalog-wide**, not just for the pilot; and (3) the merchant
ask — let an operator **see which prompts their product can compete on** and
**test an arbitrary prompt** against Pivota's own recall+rank.

## Confirmed starting state (from code recon)

- **Canonical recall is title/brand-only on both sides** — `_fetch_canonical_search_rows`
  (pivota-backend `services/pivot_query_service.py:810`) and its agent mirror
  `canonicalCatalogSearch.js:337` match `title/brand/merchant/source_product_id`
  (+ category_path / SKU vertical fields). Neither matches actives.
- **External-seed lane has drifted.** The backend recall branch (#904,
  `external_seed_search.py:80 _build_text_match_clause`) now matches
  `derived.recall.{retrieval_title,retrieval_summary,ingredient_tokens,alias_tokens}`,
  but the **agent mirror `server.js:15792` matches only retrieval_title/summary/
  brand_name/category — NOT ingredient_tokens/alias_tokens.**
- **The recall trigram indexes don't exist.** `idx_external_product_seeds_recall_*_trgm`
  appears only in a code comment (`external_seed_search.py:91`); no migration creates
  them. The recall-token LIKEs currently run unindexed (or lean on the whole-blob
  `idx_external_product_seeds_active_seed_data_trgm`, `db/migrations/068`).
- **`catalog_products` has no actives/keywords column** — only `product_payload JSONB`
  (+ `tags JSONB`, `db/migrations/075`). Actives live in `catalog_skus.ingredient_ids`
  + `beauty_sku_ingredients` (`db/migrations/058`).
- **No writer authors `derived.recall.{ingredient_tokens,alias_tokens,retrieval_summary}`**
  anywhere in pivota-backend — they're only read by `external_seed_search` / the mirror
  / backfill scripts. They come from an upstream force-fill not in the repo, so they are
  **sparse**. ← critical-path risk.
- **Merchant surfaces exist** but none tests Pivota's own recall: operator diagnostics
  `GET /api/admin/search-diagnostics` (`server.js:35461`) and `POST
  /api/admin/catalog-serving/search` (supports `shadow_mode`, `server.js:36226`), both
  `requireAdmin` (static `X-ADMIN-KEY`). Merchant API is OAuth role-gated
  (`pivota-backend/.../merchant_api_extensions.py`, role `merchant`). Portal
  `pivota-merchants-portal/app/dashboard/agent-center/ai-readiness` already lets
  operators enter **custom prompts** — but audits **third-party** AI visibility
  (Gemini/DeepSeek), not Pivota recall. Dossier `pivota.agent_product_context.v1`
  (`pdpProductIntel.js`, `pivotaInsightsQuality.js`) emits `best_for` but no search terms.
- Product identity for an operator: `resolveCatalogProductRefFromPivotaSignature`
  (`server.js:5501`) by `pivota_signature_id` / `content_key`.

## Workstreams

### WS1 — Author the actives (foundation; unblocks WS2 + WS3B)
The "no writer" gap is the real blocker: a searchable field is worthless if its source
is empty. Author a normalized **actives/concepts** set per product, grounded from INCI /
`catalog_skus.ingredient_ids` / `beauty_sku_ingredients`, into
`derived.recall.{ingredient_tokens,alias_tokens}` (+ a friendly `concepts` list:
actives + benefits + origin). Home: the **dossier authoring engine**
(`pdpProductIntel.js` / `pivotaInsightsQuality.js`) — it already grounds product facts
and emits `agent_product_context.v1`; extend it to also emit recall/suggested terms.
Share the concept taxonomy with Phase 1's `BEAUTY_ACTIVE_CONCEPTS` (extract to a shared
module so authoring and matching can't drift).
- Deliverables: authoring step + backfill (pilot → category → catalog-wide); coverage
  metric (% beauty products with ≥1 authored active).
- Risk: grounding quality; INCI parsing; alias mapping (glycine soja → soy). Reuse the
  Phase-1 alias surface forms.

### WS2 — Make actives searchable in recall (the original Phase 2)
- **WS2a — searchable field on `catalog_products`.** DECISION NEEDED: dedicated
  generated/materialized text column `recall_actives_text` (clean for trigram GIN) vs a
  `product_payload` JSON path (no migration, but JSON `#>>` is awkward to index). Recommend
  a column. Backfill via the mirror script (`scripts/mirror_external_seeds_to_catalog_products.py`).
- **WS2b — match it in BOTH canonical lanes** (`pivot_query_service.py:810` +
  `canonicalCatalogSearch.js:337`) and **finish the external-seed mirror** — add
  `ingredient_tokens`/`alias_tokens` to the agent's `server.js:15792` to match the backend
  recall branch (fixes the existing drift).
- **WS2c — tokenize the query for recall.** `buildBeautyExternalSeedRecallPatterns`
  (`server.js:15150`) pushes only the whole phrase; add per-active-token patterns using the
  shared concept extractor (so "soy isoflavones" → `%soy%`/`%isoflavone%`, not just the
  whole phrase). This is the co-equal fix to a searchable field.
- **WS2d — indexes.** Ship `db/migrations/NNN_external_seed_recall_trgm.sql` (the four
  named `idx_..._recall_*_trgm`) + a trigram GIN on the new `catalog_products` actives
  column. Perf-test (multi-term ILIKE on these tables is the team's dominant cost; bound
  token count, index every matched expression).
- **Mirror discipline:** agent ↔ backend canonical lanes and external-seed lanes must stay
  identical; this WS closes the current drift, don't reopen it.
- **Gating:** reuse / extend a flag (e.g. `PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED`),
  default off, shadow-mode first.

### WS3 — Merchant "test a prompt / suggested compete prompts" tool
- **WS3a — Test a prompt (quick win).** A merchant-scoped endpoint that runs the live
  recall+rank for a given prompt and returns *the merchant's own product's* rank +
  **explainability** — reuse Phase 1's `active_match` telemetry (currently internal:
  `{count, keys, bonus}`) plus `search_trace`/`source_breakdown` (already emitted under
  `ROUTE_DEBUG_ENABLED`, `server.js:606`). Engine: reuse `search-diagnostics` /
  `catalog-serving shadow_mode`, but **re-gate from `requireAdmin` (X-ADMIN-KEY) to
  merchant-scoped OAuth** (`get_current_merchant`) and **scope the response to the
  merchant's product position** — do NOT return competitor internals beyond
  rank/visibility. Surface in portal `agent-center` next to the existing custom-prompts UI.
- **WS3b — Suggested compete prompts.** From a product's authored actives/concepts/
  category/benefits (WS1), synthesize a ranked list of prompts it's eligible to compete on,
  each annotated with its current rank (via the WS3a engine). Reuse `BEAUTY_ACTIVE_CONCEPTS`
  reversed (product actives → query concepts → prompt templates). Persist into
  `agent_product_context.v1` (new `suggested_prompts` field) or compute on demand.
- **Privacy/abuse:** an arbitrary-prompt tool against the live ranker can leak competitor
  rankings / enable scraping. Scope output to the merchant's own position + their
  explainability; rate-limit; never return full competitor lists.

## Sequencing (recommended)
1. **WS3a (test-a-prompt)** — fastest merchant value, low risk, reuses existing diagnostics
   + Phase-1 explainability; validates the whole loop is observable. (No dependency on WS1/2.)
2. **WS1 (authoring)** — foundation; unblocks WS2 content and WS3b suggestions.
3. **WS2 (recall + index + tokenize + mirror)** — the heavy, high-blast-radius backend
   change; do it once WS1 gives it content to index. Shadow-mode → perf-test → canary.
4. **WS3b (suggested prompts)** — depends on WS1's authored concepts.

## Open decisions (need product/eng calls)
- WS2a: dedicated `catalog_products` column vs `product_payload` JSON path.
- WS3 gating: merchant self-serve OAuth (new endpoint + role) vs operator-only first.
- WS3 privacy posture: how much competitive context (rank only? top-N? "what would lift me"?).
- WS1 authoring trigger: dossier-pipeline-on-write vs batch backfill vs both.
- Scope: beauty-only (matches Phase 1) vs generalize the concept registry to other verticals.

## Cross-repo touch map
| Concern | Agent (PIVOTA-Agent) | Backend (pivota-backend) | Portal (pivota-merchants-portal) |
|---|---|---|---|
| Authoring (WS1) | `pdpProductIntel.js`, `pivotaInsightsQuality.js` | dossier/grounding services + backfill scripts | — |
| Canonical recall (WS2) | `canonicalCatalogSearch.js:337` | `pivot_query_service.py:810` | — |
| External-seed recall (WS2) | `server.js:15150/15792` | `external_seed_search.py:80` | — |
| Index (WS2d) | — | `db/migrations/NNN_*_recall_trgm.sql` | — |
| Test-prompt API (WS3a) | reuse `server.js:35461/36226`, re-gate | or new `/merchant/*` route | `agent-center` page |
| Suggested prompts (WS3b) | `agent_product_context.v1` builder | dossier emit | `agent-center` page |
