# K-beauty grounded-evidence rollout — prod run

*2026-06-30. Turns the proven rollout ([pivota-backend #1095](../../pivota-backend))
into full coverage. The script extracts already-crawled `inci_list` → INCI → substantiated
claims → served at Pivota canonical URLs. No LLM, no crawl. Resumable + non-destructive.*

Script: `pivota-backend/scripts/rollout_grounded_evidence.py`.

## Prereq — deploy `main`
The rollout depends on **#1093** (agent_pdp_view auto-refresh on enrich) + **#1095** (the
script). Both are merged to `main`; deploy the backend so prod runs them. Without #1093,
claims persist but don't reach the served view.

## Run it IN prod (fast, internal DB — not locally)
Locally the run is ~9s/product over the public proxy (a 60-item batch times out at 9 min).
Inside the prod service it uses the internal DB and is fast. `railway ssh` into the backend
service (or a Railway one-off command), then:

```bash
# Dry-run first (counts products + category backfill; no writes):
python -m scripts.rollout_grounded_evidence --limit 400

# Real run — K-beauty, resumable, with the category_kind backfill:
python -m scripts.rollout_grounded_evidence --apply --backfill-category --limit 400 --batch-size 25
```
- `--limit 400` covers the ~352 K-beauty products that have `inci_list` in one pass.
- **Resumable**: it skips products that already have `raw_inci`, so re-running continues
  safely (e.g. if a run is interrupted). Just run it again.
- Expected yield ~58% (only *substantiated* claims surface; cleansers/patches have fewer
  recognized actives).

## Verify

```sql
-- coverage: K-beauty products now serving grounded claims (was ~0 pre-rollout)
SELECT count(*) AS kbeauty_serving_claims
FROM agent_pdp_view
WHERE evidence_profile IS NOT NULL
  AND jsonb_typeof(evidence_profile) = 'object'
  AND jsonb_array_length(evidence_profile -> 'claims') > 0
  AND brand ~* '(cosrx|round lab|anua|beauty of joseon|skin1004|tirtir|torriden|medicube|isntree|mixsoon|biodance)';

-- yield: INCI ingested vs claims served
SELECT
  (SELECT count(DISTINCT product_key) FROM beauty_sku_ingredients
     WHERE coalesce(raw_inci,'')<>'' AND source_system='pdp_crawl') AS products_with_inci,
  (SELECT count(*) FROM agent_pdp_view
     WHERE jsonb_typeof(evidence_profile)='object'
       AND jsonb_array_length(evidence_profile->'claims')>0)         AS products_serving_claims;

-- spot-check what a calling agent receives for one product
SELECT brand, title, pivota_signature_id,
       jsonb_array_length(evidence_profile->'claims') AS n_claims,
       evidence_profile->'claims'->0->>'claim_text'   AS example_claim
FROM agent_pdp_view
WHERE evidence_profile IS NOT NULL
  AND jsonb_typeof(evidence_profile)='object'
  AND jsonb_array_length(evidence_profile->'claims')>0
  AND brand ILIKE '%cosrx%'
LIMIT 5;
```
A calling agent reaches these at `https://agent.pivota.cc/products/{pivota_signature_id}`.

## After K-beauty
```bash
# other verticals — same script, different brand regex:
python -m scripts.rollout_grounded_evidence --apply --brand '(the ordinary|cerave|paula.s choice|...)' --limit 400
```
Then the long tail: the ~31% of K-beauty missing `inci_list` needs a fresh PDP crawl
(`scripts/onboard_external_brand_from_crawl` / `crawled_inci_ingest`) — separate, later.

## Safety
- **Dry-run by default**; writes only under `--apply`.
- **Non-destructive**: INCI upsert is gated by ADR-001 source precedence (`skipped_outranked`
  if a higher-authority source exists); evidence persist is fill-only-when-empty.
- **Resumable**; no rollback needed. `--backfill-category` sets null→`skincare` only for the
  brand set (assumed skincare) — omit it if auditing category first.

## Convergence
The same enrichment also deposits into `citation_observations` (the BD matrix), so this run
advances both the frontier-citation and BD-channel north stars at once.
