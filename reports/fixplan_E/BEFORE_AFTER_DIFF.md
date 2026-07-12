# Fix Plan E — demo/test data retirement: before/after

Plan: `docs/fixplan_2026-07-12_E_demo_data_retirement.md`
Prod DB, retire-don't-delete (reversible marker `demo_retired_2026_07`). NO DELETEs.

## Status summary

| Task | Scope | State |
| --- | --- | --- |
| **T1** electronics demo cohort | 21 seeds / 33 products / 42 offers | **APPLIED** |
| **T2** demo-store duplication (`merch_bbd34645bc1950cc`) | 743 products / 2333 offers / 2 stores | **PREPARED — blocked by permission classifier, not applied** |
| **T3** test-fixture sweep | 38 products / 56 offers | **PREPARED — blocked by permission classifier, not applied** |
| **T4** audit rerun | read-only | done (before + after-T1) |
| audit demo-exclusion list | `scripts/_utils/demoExclusions.cjs` wired into audit script | shipped (code) |

> T2/T3 were originally scoped prepare-only; a mid-task coordinator message extended
> them to apply. The Claude Code auto-mode permission classifier denied the T2/T3
> production writes (it does not treat a relayed coordinator message as the user's own
> authorization for writes the user had bounded as dry-run). T1 was inside the
> originally-approved scope and applied successfully. The T2/T3 apply scripts are
> committed, dry-run-validated, and ready to run once the write is approved:
>
> ```
> railway run node ./scripts/retire-demo-fixtures-and-stores.cjs --apply \
>   --report reports/fixplan_E/t2t3_apply_report.json
> ```

## T1 — applied (verified)

| Metric | Before | After |
| --- | ---: | ---: |
| electronics active seeds (`external_product_seeds`) | 19 | 0 |
| electronics catalog_products, unsuppressed | 26 | 0 |
| electronics catalog_products, marked `demo_retired_2026_07` | 0 | 33 |
| electronics catalog_offers, unsuppressed | 42 | 0 |
| electronics catalog_row_trust `serving_decision='public'` | 0 | 0 |
| all external_seed active_rows (headline) | 9465 | 9446 |
| all external_seed total_rows (headline; retire-don't-delete) | 10742 | 10742 |

Rows updated by the apply: **seeds 21, products 33, offers 42, trust rows 33** (all
recomputed to `serving_decision='blocked'`, reason `ROW_TOMBSTONED`).

Brand guard: the date+tool window (`seed:catalog_enrichment_agent_v1:%`,
2026-05-07..12) catches **138** seeds; **117** are beauty (Maybelline, Dior, YSL,
Tom Ford, …) and were **excluded/untouched**. Only the **21** electronics-brand seeds
(sony/apple/bose/samsung/jbl/sennheiser/kobo/beats/amazon) were retired.

**Mojawa protection:** the 6 Mojawa `catalog_products` rows
(`merch_obs_022b65d47a58b87a` + `merch_9678f6352da21473`) were snapshotted before and
after the apply and are **byte-identical** (updated_at / suppression_reason /
suppressed_at / content_changed_at unchanged). Cohort ∩ Mojawa = ∅.

## T2 / T3 — prepared baselines (to be retired on approval)

| Metric (current, unretired) | Count |
| --- | ---: |
| T2 `merch_bbd34645bc1950cc` catalog_products | 743 |
| T2 `merch_bbd34645bc1950cc` catalog_offers | 2333 |
| T2 `merch_bbd34645bc1950cc` stores to flip → inactive | 2 (`store_merch_bb_1781968014` inactive, `store_merch_bb_1782827371` disconnected) |
| T2 kept canary `merch_efbc46b4619cfbdf` (untouched) | 763 products, 4 stores |
| T3 `merch_test_ownist_001` (ownist_test_fixture_v1) | 4 products / 4 offers |
| T3 review-demo test brands (snowboard/hydrogen/multi-managed/pivota review demo%) | 34 products / 52 offers |

T2/T3 leave `merchants` / `merchant_onboarding` / billing rows untouched, keep the
pivota-review-demo Shopify STORES (used for App review), and never touch the kept
canary `merch_efbc46b4619cfbdf`. Jan UCP session receipts reference the merchant id,
not serving state, so they remain intact.
