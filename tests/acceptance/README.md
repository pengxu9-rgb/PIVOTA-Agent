# Search acceptance set

Answers one question: **does a partner's query return the product it names?** Earlier fixes to the search rules were checked only as "no change from main" over fixture strings, never against that question.

| Piece | Layer | Runs |
|---|---|---|
| `search_acceptance.node.test.cjs` + `cases.json` | The **served** list for each query over 600 prod rows plus the Meitu-reported row. It uses the route's own `rankAndServeBeautyRecallProducts`: contract, effective query, multi-family relaxation, scoring with hard constraints, ranking, dedupe and the serving gate. A safe-empty contract serves nothing. | CI, through `scripts/run_node_test_suites.cjs` |
| `fixtures/eligible_baseline.json` | No-deletion ratchet: no tracked query may serve fewer rows. Untracking a query counts as removing its rows. | CI |
| `scripts/acceptance/live_search_acceptance.cjs` | Deployed gateway, end to end: REST search, hosted UCP `search_catalog`, resolve, and served price against the merchant's `/products/<handle>.json` | By hand after every gateway deploy (the gateway never deploys on merge) |
| `live_runner.node.test.cjs` | Offline tests of the live runner's verdicts | CI |

## Statuses
- `pass` must pass.
- `known_fail` must still **fail**, and needs a `reason` and a `tracked_by`. When a change makes one pass, the suite fails until that change promotes it to `pass`, so every improvement shows up in review.
- Never flip a status or regenerate the baseline just to turn a build green.

## Changing what is served
- Additions are allowed and reported.
- Removals are refused. If a removal is intended, regenerate with a reason, which is logged in the baseline:

```bash
node scripts/acceptance/update_eligible_baseline.cjs --approve-removals "why these rows should stop being served"
```

## Live run

```bash
PIVOTA_API_KEY=... node scripts/acceptance/live_search_acceptance.cjs --out live_report.json
```

The key goes in request headers only. The merchant endpoint is called without it.

## What this layer does not cover
- The offline suite does not run canonical SQL recall, the seed lane, budget/currency filters or paging; the live run covers those.
- Fixture rows carry no `description`, `seed_data` or transaction-hold fields, so rules that read them cannot fire offline.
- The fixture is a snapshot from 2026-09-16. Refresh it deliberately, never to make a case pass.
