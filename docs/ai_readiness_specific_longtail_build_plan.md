# AI-Readiness — Win the Specific Long-Tail (flip the center of gravity)

_Build plan & tracker. Stop spending ~60% of every audit's credits proving GENERAL-prompt losses a
longtail merchant can't avoid; spend them on the SPECIFIC stacked long-tail the merchant can actually
win — and guide the merchant to the winnable niches the engine already computes. Created 2026-06-18._

## North-star (anti-drift anchor)
A medium/longtail merchant **structurally loses** general head prompts ("best collagen") — flagships +
retailers own them. They **win** specific, multi-attribute long-tail ("vegan low-molecular collagen
sticks, no sugar, before bed") where they're a genuine match and competition is thin. The audit must
make **winning the specific long-tail its center of gravity** — measure it, surface it, and guide the
merchant to it — not re-confirm the general loss. If a change spends credits on prompts the open-lane
gate is designed to reject, it's drift.

## The problem (code-grounded 2026-06-18)
The machinery to win the long-tail **already exists and the scoring is precisely tuned for it** — it's
starved and off-center:
- **Sidewalk lane** (`services/sku_sidewalk.py:generate_sidewalk_query_specs`) builds depth-4 attribute
  stacks (the exact specific prompts a niche merchant can win), ranked by intent_weight × stack depth.
- **`_is_open_lane`** (`sku_opportunity.py:1243`) **excludes head terms outright** and requires
  `attribute_fit ≥ 0.70` — which **only** the stacked sidewalk prompts clear. The gate is the inverse of
  where general prompts land.
- **BUT the budget is inverted the wrong way:** only **~35–43%** of the ~40 prompts/SKU are specific
  (sidewalk hard-capped at 16); the **majority** are general head/branded/superlative prompts the gate
  rejects by design. So the audit "spends ~60% of its credits proving losses it could predict and
  starves the only lane that produces a win" → `where_you_can_win.targets` comes back near-empty.
- **Custom prompts are a passive, billed empty box** (10 slots): no guidance, no suggestions, and they
  don't feed the win logic. The engine COMPUTES the merchant's winnable niches and never offers them back.
- **The framing is already right** (targets = "niche you can own" vs skip = "stop fighting"); the win
  column is starved, not mis-designed.

## What EXISTS — reuse, don't rebuild
- `generate_sidewalk_query_specs` (depth-4 stacks) + `_sidewalk_query_records_for_sku` (the 16-cap).
- `_build_per_sku_audit_query_records` / `_budgeted_wedge_query_records` / `_sidewalk_budget` (the budget).
- `_is_open_lane` / `_attribute_fit` (already reward specific).
- `build_where_you_can_win` → `targets` (the computed winnable niches) — the suggestion source.
- `build_custom_prompt_results` (custom-prompt scorer) + the 10-slot custom-prompt input UI.

## Locked design decisions
- **Credit-neutral inversion.** Same `prompts_per_sku`; reallocate from general → specific. No bigger bill.
- **Keep a THIN diagnostic spine** — 2 head + 2 navigational + 2 trust — so the report can still honestly
  show "yes, you lose the head term, as expected for a niche brand." Don't delete the loss-diagnostic.
- **Specific stacked = the majority** of the budget; lift the 16-sidewalk cap for rich catalogs.
- **Suggest, don't just ask.** Feed the engine's own top open-lane / sidewalk candidates back as
  *suggested* custom prompts; elicit the merchant's real customer-questions/differentiators (the edge).
- **Honesty preserved** — thin SKUs under-fill with real queries (no junk); axis tags intact.

## Guardrails
- Assert prompts/SKU after inversion ≤ today's (credit-neutral); log the general/specific split.
- Never drop the 2 diagnostic head terms (the honest "expected loss" anchor).
- Don't break the coarse `axis` tags / per-intent breakdown (additive).
- Thin SKU (sparse attribute graph) → fewer real prompts, never synthetic padding.

## Progress tracker
| ID | Step | Surface | Status | PR |
|----|------|---------|--------|----|
| 1 | ✅ **Invert the probe budget** — specific stacked (sidewalk) becomes the MAJORITY; thin 2-head + 2-nav + 2-trust diagnostic spine; lift the 16-sidewalk cap. Credit-neutral. | backend | ✅ done | #936 (tests) + #937 (source) |
| 2 | ✅ **Suggested prompts** — expose the engine's top open-lane/sidewalk candidates as `suggested_prompts` on the report (the winnable niches, computed, currently un-surfaced) | backend | ✅ done | #938 |
| 3 | ✅ **Guided custom-prompt UI** — show "test these niches you can own" suggestions + a 1-click add; reframe the box from passive to guided (elicit the merchant's specific differentiators) | portal | ✅ done | #84 |
| 4 | (Later) **Feed custom prompts into the win logic** — merchant-supplied specific prompts can become open-lane targets, not just a parallel lighter surface | backend | ⏸ | — |

## Acceptance & verification
- **Step 1:** a 40-prompt audit runs a MAJORITY of specific stacked prompts (≥ ~60% sidewalk/attribute),
  keeps exactly 2 head + a thin branded spine, total ≤ prompts_per_sku (credit-neutral), thin SKUs
  under-fill without junk. Verify: dump query_records for a rich SKU → specific-majority split.
- **Step 2:** the report carries `suggested_prompts` = the top computed winnable niches (the sidewalk
  candidates that scored well but weren't probed / the open-lane targets).
- **Step 3:** the custom-prompt box shows suggested specific prompts the merchant can 1-click add; the
  empty box is never just blank for a SKU with computed candidates.

## Change log
- 2026-06-18 (a) — plan created from the "compete-on-general-where-longtail-loses" critique. Confirmed:
  the win-the-specific machinery + scoring exist; the budget starves it (~60% general) and custom prompts
  are passive. Highest leverage = invert the budget (credit-neutral) + surface the engine's own winnable
  niches as suggested prompts. Connects to the query-axis plan (Step 8 merchant-knowledge intake).
- 2026-06-18 (b) — Step 1 shipped. PROCESS NOTE: #936's commit dropped the source file (git-add miss) — only tests merged (main stayed green by luck: the test SKU is supply-capped at 16 either way). Caught it (verified inversion absent on main), re-shipped the source via #937 with staged-file verification + the inversion unit test as the real guard. Lesson: `git show --stat HEAD` / `git diff --cached --name-only` before pushing a multi-file change.
- 2026-06-18 (c) — Step 2 BUILT (PR #938, awaiting your merge). `_suggested_prompts_for_sku` + `build_suggested_prompts` surface the engine's computed-but-unprobed attribute-stacked niches as `brand_rollup.suggested_prompts` (deduped, ranked, capped 12); disjoint from where_you_can_win.targets by construction; thin SKU -> [] (no padding). 6 new tests + 33 related pass locally. NOTE: CI couldn't run (GitHub Actions billing block — jobs never started, not a code failure). Merge is a prod deploy → left for user to approve.
- 2026-06-18 (d) — Step 2 MERGED (#938, main 015ab162) + deploying. User approved the merge (CI billing-blocked, verified locally). Next: Step 3 (portal guided custom-prompt UI) consumes brand_rollup.suggested_prompts.
- 2026-06-18 (e) — Step 2 DEPLOY CONFIRMED (api.pivota.cc/version=015ab162; note the field is `version`, not `commit_sha`). Step 3 BUILT (portal PR #84): SuggestedPromptsPanel (Zone 2) + addSuggestedPrompts (1-click inject into the 10-slot prompts box, deduped, cap-aware, scrolls back); types SuggestedPrompt(s) + brand_rollup.suggested_prompts. TS clean on touched files (repo build ignores pre-existing errors). Awaiting user merge + Vercel prod deploy.
- 2026-06-18 (f) — Step 3 MERGED (portal #84, main 35716ae) + DEPLOYED to Vercel prod (build Ready). The full win-the-specific-long-tail loop is shipped end-to-end: invert budget (live) -> surface computed-but-unprobed niches (live) -> 1-click test them (live). Only Step 4 (feed custom prompts into open-lane win logic) remains, parked. NEXT: run a fresh real-catalog audit to eyeball suggested_prompts rendering against live data.
