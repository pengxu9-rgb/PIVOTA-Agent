# PR-4 sourcing-filter measurement gate

**Date:** 2026-07-10. Required by `docs/openai_apps_v1_plan.md` §5: measure what fraction of top-query
results survive the first-party/brand-official filter **before** enabling it, so we don't trade one review
risk (fair competition) for another (thin/demo-quality results). Threshold to proceed: **≥ ~60% survival**.

## Method

Classified real prod `find_products_multi` responses (agent.pivota.cc/api/gateway) with the PR-4 filter
(`mcp-server/src/publicReadSourcing.js`, `filterFirstPartyRows`): a row is excluded if its destination host
is a known reseller/marketplace (or `offer_type:'retailer'`). Survival = kept / raw.

## Result

| query | raw | kept | dropped | survival |
|---|---|---|---|---|
| niacinamide serum | 50 | 43 | 7 | 86% |
| lipstick | 49 | 38 | 11 | 78% |
| niacinamide serum for dark spots (live) | 56 | 49 | 7 | 88% |
| **weighted total (2 captured)** | **99** | **81** | **18** | **81.8%** |

**Dropped-by-host: `{ "ulta.com": 18 }` — 100% of exclusions are ulta.com**, the exact reseller the audit
flagged (§3.6). No brand-official host (jumiso.us, roundlab.com, anua.com, fentybeauty.com, …) was dropped.

## Verdict

**Proceed — enable the filter by default** (`PUBLIC_READ_FIRST_PARTY_ONLY` defaults ON). Survival ~78–88% is
comfortably above the 60% floor, and the only thing removed is the flagged reseller. The remaining catalog is
brand-official / first-party, which is what the app should surface.

## Limitations (tracked)

- The filter is a curated reseller-host **denylist**, so a reseller host not yet on the list would pass. The
  list is env-extendable (`PUBLIC_READ_RESELLER_HOSTS`) and drops are logged (`public_read sourcing filter`),
  never silent (§5 "no silent caps").
- Only 2–3 queries measured (the gateway is slow at 50-result depth). Re-run across a wider query set during
  the PR-7 dark-launch sweep; the signal (drops == ulta only) is consistent enough to enable now.
