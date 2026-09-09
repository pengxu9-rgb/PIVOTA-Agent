# Framework role rank: what it means, and what it must never be used for

**Status:** current. Written 2026-09-09 after the same misreading of `rank` shipped twice.

## The contract

A concern framework is a list of roles. Exactly one is the **primary** — the step the buyer
actually asked about. The rest are **support** — the steps that pair with it.

Which one is primary is carried by **`targetContext.primary_role_id`**, matched against
`role.role_id`. That is the contract.

`role.rank` is an **ordering hint for presentation**. It is *not* a primary/support flag, and
its numbering is not part of any contract:

| producer | ranks it emits |
|---|---|
| `recommendationSharedStack.js:408,425,442,458,624` | `oil_control_treatment` **10**, `acne_clogged_pore_treatment` **11**, `lightweight_moisturizer` **20**, `daily_sunscreen` **30**, `hydrating_mask_support` **100** |
| `concernPlannerNormalizer.js:1013` | `{ rank: 1 }` for a request-narrowed primary |
| `recoRecallPlanner.js:422,436` | primary defaults to **1**; `:63` defaults to **99** |

So both spaced and sequential ranks reach the same code, from different planners, for the same
kind of role. **`rank === 1` does not mean primary and `rank > 1` does not mean support.**

## The rule, in one place

`isPrimaryFrameworkRole(role, targetContext, { primaryRoleId })` in `src/auroraBff/routes.js`.
Identity first; rank only as a fallback for lanes that carry no `primary_role_id`; an **absent**
rank reads as primary, because a role nobody ranked is not evidence of support. Both ids are
lowercased — the prior-reco continuation lane carries a differently-cased primary id.

**Use it. Do not re-derive this test at a call site.**

## Why the file exists

`roleRank > 1` was the primary/support test at five sites. #2157 fixed one — the query budget,
where the acne primary was getting the support tier's 1600 ms against a query costing
1720–1800 ms. The end-to-end probe went 0/6 → 6/6 and the fix looked complete.

It was not. Measured on the tree before this change, with `primary_role_id` set and the primary
at rank 11: the surfacing ranker received a pool of **12** where the same role at rank 1 got
**24**, half of it dropped by the support cap. It never changed how many products came back —
the caller's limit governs that — so nothing downstream looked wrong.

## Sites

| site | status |
|---|---|
| `searchLocalExternalSeedProducts` query budget | fixed in #2157, pinned by `tests/recall_primary_role_budget.test.js` |
| `resolveLocalExternalSeedSupportRankPoolCap` | fixed here, pinned by `tests/recall_primary_role_identity.test.js` |
| `isBeautyMainlinePrimaryRoleQuery` | already identity-first; routed through the helper so there is one definition |
| the stable-alias authority branch (`routes.js` ~:25530) | already identity-first; routed through the helper |
| `buildLocalExternalSeedPrimaryFinishFitQueryStage` + the `support_category_fit_broad` stage nested in its result | **NOT swept.** Neither could be driven from a test — the builder returns null before reaching the predicate for every input tried, and the ladder is gated on `leanSql` — so neither the defect nor a fix can be demonstrated. The precise-stage swap is also not a pure widening (a rank-1 role that is not the named primary would lose the stage), and the broad-stage swap REMOVES a stage from the primary. Reachability study first. |

## If you add a sixth site

Call the helper, and add a case to `tests/recall_primary_role_identity.test.js` that fails when
the call site is reverted to a rank comparison. A test that only checks the helper in isolation
does not stop the next half-sweep — that is precisely what happened after #2157.
