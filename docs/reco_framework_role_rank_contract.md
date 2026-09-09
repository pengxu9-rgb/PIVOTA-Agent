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
It reads `rank` before `role_rank`/`roleRank`, which the two inline bodies it replaced did not —
harmless today (planner entries carry one spelling or the other, never both) and worth knowing.
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

**This table is NOT the whole inventory.** A `grep` for rank-vs-1 comparisons in `routes.js` finds
roughly thirteen sites asking this question. The ones below are the ones examined so far; six more
are known and unswept, listed underneath.

| site | status |
|---|---|
| `searchLocalExternalSeedProducts` query budget | fixed in #2157 and pinned by `tests/recall_primary_role_budget.test.js`, but it still re-derives the rule inline rather than calling the helper — and reads only `role.role_id`/`role.rank`, so for `{ roleId: <primary>, rank: 11 }` it and the pool cap now DISAGREE. Route it. |
| `resolveLocalExternalSeedSupportRankPoolCap` (both call sites) | fixed here, pinned by `tests/recall_primary_role_identity.test.js` |
| `isBeautyMainlinePrimaryRoleQuery` | routed through the helper. NOT behaviour-preserving: the inline body was case-sensitive; see the note at the call site |
| the stable-alias authority branch (`routes.js` ~:25576) | routed through the helper. Same case-sensitivity change; also drops a dead `args.roleRank` fallback |
| `localIsPrimaryRole` (`routes.js` ~:25490) | **NOT swept** — a second, case-sensitive copy of the rule inside the same function as the stable-alias branch, 90 lines apart. They now disagree in a case-mismatched lane. It gates the sunscreen query timeout cap (2200 vs 900 ms) |
| `buildLocalExternalSeedPrimaryFinishFitQueryStage` + the nested `support_category_fit_broad` stage | **NOT swept.** Both ARE reachable from a test — an earlier version of this doc said otherwise and was wrong. Swept separately because the precise-stage swap is not a pure widening and the broad-stage swap REMOVES stages from a spaced-rank primary |

### Known and unswept

| site | what it decides |
|---|---|
| `buildLocalExternalSeedRoleSearchPhrases` (~`:8843`) | how many role search phrases are built |
| `shouldUseLeanLocalExternalSeedPatternPack` (~`:8871`) | **the SQL pattern pack.** Measured on this branch: the acne primary at rank 1 gets 8 patterns, at rank 11 gets **1**. This site is in the same call as the pool cap and has a much larger effect than the cap does — the pool was widened while the rows entering it are still retrieved with an eighth of the query surface |
| `~:21247`, `~:27706`, `~:29929` | `query_step_strength`, which is sent upstream as a search parameter |
| `~:27240` | support-role viability relaxation |

## If you add a sixth site

Call the helper, and add a case to `tests/recall_primary_role_identity.test.js` that fails when
the call site is reverted to a rank comparison. A test that only checks the helper in isolation
does not stop the next half-sweep — that is precisely what happened after #2157.
