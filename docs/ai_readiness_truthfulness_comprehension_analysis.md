# AI-Readiness — Truthfulness & Comprehension Analysis (from live eyeball)

_Deep analysis triggered by the merchant's live-eyeball findings on the Chydan test
store, 2026-06-18. The structural redesign (Steps 1-5) made the page navigable; this
is the next, more fundamental layer — is the page TRUTHFUL, and is it COMPREHENSIBLE?
Code-grounded (deployed main: backend c603de53, portal 0f776dc). Analysis, not fixes._

## Meta-finding
Two failures the structural work didn't touch:
1. **The audit asserts claims it cannot substantiate** — it tells a test store it "earns
   independent recommendations" it does not have. A trust-destroyer.
2. **It shows data without the vocabulary or scale to read it** — bare numbers, undefined
   core terms.
Navigable ≠ truthful ≠ comprehensible. These are the deeper layer.

---

## P0 — THE AUDIT MAKES FALSE ENDORSEMENT/FINDABILITY CLAIMS (trust-breaking)
Maps to merchant findings #2, #3, #4 ("Chydan is independently recommended…", "earns
independent category recommendation from youtube/reddit/goodhousekeeping…", "findable…
listed across [retailers]"). The merchant's instinct — "kind of impossible for a test
store" — is **correct**. These are false positives.

**Root cause (one function):** `_citation_signals`
(`agent_center_bd_report_service.py:5844-5891`) buckets every cited host by its **role
only** — editorial/creator/forum → "endorsement", retailer/marketplace → "findability" —
and **never checks whether that host actually cited the MERCHANT**. The fields that would
make the distinction — `cites_exact_sku` / `cites_near_variant` — are computed and stored
on every host row (`:5991-92`, exposed `:6088-89`) but are **never read** by this function.

So the claims fire on "this host was a grounding source when the AI answered a category
query" — about the *category or competitors* — and relabel it as "this host recommends
YOU":
- **"earns independent category recommendation from {hosts}"** (`merchant_narrative_builder.py:292-296`)
  → `endorsement_category_hosts` = endorsement-role host that appeared on any `axis="category"`
  probe. No merchant-named check. **DEFINITELY CONFLATED** (worst — names specific hosts).
- **"independently recommended for the category … the channel is working for you"**
  (`merchant_narrative_builder.py:189-193`) → same `independently_recommended_for_category`
  flag. **DEFINITELY CONFLATED.**
- **"findable … listed across {retailers}"** (`merchant_narrative_builder.py:222-225`) →
  `findability_hosts` = retailer-role grounding sources. "Listed across" asserts distribution
  that isn't verified (no check Chydan's SKU is on those retailers). **OVERSTATED/CONFLATED.**
- The competitor escape hatch only catches `brand`-typed storefronts — editorial/forum hosts
  that discuss a *competitor* are NOT excluded (the code's own docstring concedes this).
- **The honest-looking copy makes it worse:** the panel says "the only honest 'AI recommends
  you' signal" (`MerchantNarrativePanel.tsx:144`) while the data behind it is role-only.
- Per-SKU cards inherit the same flag (`merchant_narrative_builder.py:352-354`).

**Why it slipped past:** a prior fix (#933) added `cites_exact_sku`/`cites_near_variant` to
matrix rows for the OUTREACH re-verify oracle — but never wired them into `_citation_signals`,
so the NARRATIVE claims stayed role-only. (See [[ai-readiness-outreach-loop]] gotcha.)

**Fix direction (data already exists, narrow surface):** gate every endorsement/findability
signal in `_citation_signals` on `cites_exact_sku OR cites_near_variant` (endorsement = an
endorsement-role host that ACTUALLY named the merchant's SKU; findability = the merchant's
own/marketplace listing that names the SKU). When a host is cited but doesn't name the
merchant, it belongs in "who AI cites INSTEAD of you" (the honest framing the page already
has) — not in "recommends you". Reframe "listed across" → only where the SKU is actually
found. This is the audit's stated cited-vs-retrieved discipline applied where it was missing.

---

## P1 — NUMBERS WITHOUT MEANING (comprehension)
Maps to findings #1 ("Median across 2 products · Identity 93 · Content 52 …" — meaningless)
and #2-first ("by question type" — what do these mean? product or store findable?).

**Root cause:** numbers are rendered bare; the vocabulary to read them exists in the codebase
but is applied unevenly and the core terms are never defined in merchant-facing copy.
- **Brand median strip** (`page.tsx:3210-3232`): shows `Identity 93` etc. with **no /100 scale,
  no band word** (the band is computed then used only to COLOR the digit — `:3221,3225` — the
  word "Needs work"/"Not yet visible" is discarded), **no "what this measures"**. "Citation ·
  outcome" — "outcome" is never defined. The decoder (`ScoreLegend`, bands 85+/70-84/40-69/<40)
  lives inside `PerSkuCardList` — *screens below* the strip the merchant hits first.
- **Per-SKU `DimensionCell`** (`:3605-3646`) CAN show a band label + meaning sub-line + an ⓘ
  "what this measures" tooltip — but those fields (`band_label`, `meaning`, `question`) are
  **optional and empty in practice**, so it degrades to number + one-word band.
- **CitationByIntentPanel** ("Where AI cites you — by question type"): the one panel that
  glosses its ratio ("how often AI names you"), but it **hides the green/amber thresholds**,
  never disambiguates the merchant's #2 question (is it the PRODUCT, the BRAND, or the STORE as
  a channel that's "cited"? through WHAT?), and is **often null/absent** entirely.
- **Core terms never defined in rendered copy:** *cited / citation / citation rate / findable /
  recommended / outcome* — all load-bearing, all undefined (some defined only in code comments
  or in one panel that doesn't propagate).

**Fix direction:** define the core terms once, in plain language, where the numbers live; put
the scale + band word on the brand strip (not just color); move/duplicate the legend above the
first numbers; populate (or stop depending on) the per-dimension meaning/tooltip; on
citation-by-intent, say plainly "of the N '{type}' questions we tested, AI named your store/
product in M" + what to do.

---

## P1 — ACTION PLAN STILL HAS DUPLICATES (finding #6)
**Root cause: three dedup/match mechanisms disagree on product_key.** Only reconciliation
normalizes the two formats; dedup + supersession compare RAW strings:
| Mechanism | product_key handling |
|---|---|
| `dedupe_pending_tasks` (`db/merchant_tasks.py:651`) | **raw** `.lower()` |
| cross-audit supersession (`task_queue_service.py:581,596,604`) | **raw**, strict `!=` |
| reconciliation (`task_queue_service.py:699-700` via `_product_id_variants`) | **normalized** (shared `sig_<hex>`) |
So the very URL-form-vs-catalog-form mismatch reconciliation was built to bridge slips straight
through the dedup. Plus surviving classes: (2) the same generic brand-style action repeated per
SKU with per-product title suffixes (distinct by design, reads as dupes); (3) title drift /
suffixed-vs-unsuffixed; (4) new `sku_enrichment` "Fill the gaps on {SKU}" coexisting with legacy
per-product tasks for the same SKU (different lever+title → never collapse); (5) per-SKU bridge
keys on `product_key or sku_key` while the legacy walk keys on `product_key or merchant_pdp_url`.

**Fix direction:** make ALL THREE mechanisms share `_product_id_variants` for product identity;
collapse the "same generic action across N SKUs" class (either one brand-level task, or group
per-product tasks under the action); align the key-source fallback.

---

## P2 — "IN PROGRESS" IS AMBIGUOUS (finding #7 — "running for what?")
**Root cause:** `in_progress` is a **manual ownership flag** — set only when the merchant clicks
"Start" OR a Pivota BD employee takes the task (`routes/.../update_merchant_task` +
`bd_update_task`). **Nothing is running**; no agent is assigned (this task has no
`assigned_to_agent`). But the UI shows a **spinning loader** (`MerchantTaskQueuePanel.tsx:535-536`)
that universally reads "active work", with no actor attribution, in the "you act" lane —
contradicting itself. **Fix direction:** drop the spinner for `in_progress`; label it
"Started — owned by you" (or by Pivota when BD-owned); don't imply background execution.

---

## P2 — "WHAT AI NAMES INSTEAD" — meaning OK, action missing (finding #5)
It glosses "what it is" passably ("products/brands AI mentions for these queries — not all are
competitors") but the "how do I improve" is a **separate, conditional** component
(`WinPlanSummaryCallout`, only when `win_plan_summary` present), and the `times_named` frequency
is dropped. **Fix direction:** co-locate the action ("get cited in the independent hosts / win
the niche — see How to win below"); show the frequency so "names instead" is rankable. This is
also the HONEST counterpart to the P0 false claims: these are who AI recommends *instead of you*.

---

## PRODUCT Q — operator / custom follow-up tests (finding #8)
The custom-prompt box already lets a merchant run arbitrary prompts; the Step-5 RetestPanel
pre-fills losing queries. The open question: should Pivota **BD operators** run follow-up tests
on a merchant's behalf? The BD task route already exists. Decision needed — not a bug.

## Recommended priority
1. **P0 false endorsement/findability claims** — fix first; it breaks the audit's core promise
   and the data to fix it already exists.
2. **P1 comprehension** (define terms + numbers-with-meaning) and **P1 dedup unification** (share
   `_product_id_variants`) — both high-impact, bounded.
3. **P2** in-progress spinner + "names instead" action co-location.
4. Product Q on operator follow-tests.
