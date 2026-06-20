# AI-Readiness — Competitive-Insight Track — Build Scope (directives 1 + 2)

_The audit already MEASURES the competitive landscape (who AI names / routes buyers to
instead). The gap is turning that measurement into ACTION, framed by the merchant's real
win condition (brand vs retailer). Code-grounded on origin/main (backend 89fec135).
Scoped 2026-06-20._

## North-star
Same competitive data, three actionable surfaces:
- **C1 — Channels in Findability + how-to-compete advice.** Surface the retail channels AI
  routes buyers to (the competitors a merchant must watch) in the Findability section, and
  add channel-typed "how to compete" advice — not just name lists.
- **C2 — Two-axis framing by `merchant_type`.** Frame the same signals toward the merchant's
  lever: a **brand** → "improve/differentiate the product + get into channels"; a
  **retailer** → "expand coverage (stock the winners) + win the buy destination."
- **C3 — "Winning products you don't carry."** The novel, defensible insight: match the
  competitor products AI names against the merchant's catalog and surface the winners they
  DON'T stock. A frontier LLM categorically cannot do this (needs the merchant's catalog ×
  the measured winners).

Also feeds the [[E1 enrichment]] loop: C1/C2/C3 are richer grounded-brief input ("enrich to
beat THESE named competitors / cover THESE gaps").

## What EXISTS — reuse, don't rebuild (the data is mostly there)
| Signal | Where (origin/main) | What it carries |
|---|---|---|
| `routed_to_instead` (channels AI routes buyers to) | `agent_center_bd_report_service.py:4412-4452` (`_store_as_destination`), assembled `:9058` | `{host, role, times_cited}`, store excluded, top 8 |
| `cited_not_naming_hosts` ("who AI cites instead") | `_citation_signals :5934` | hosts grounded for the category that did NOT name the merchant |
| `competitor_hosts` (rival storefronts) | `_citation_signals :5995`, `_host_is_competitor :5896` | brand-typed non-first-party cited hosts |
| `cross_product_competitors` | `:9406/9427` (built `:8834/:9490`) | `{host, times_cited}[]` brand-wide |
| `competitor_benchmark` ("Winning today") | `win_plan_builder.py:182` (`_competitor_benchmark`), per losing query `_losing_query_plan :202` | flat list of competitor name strings (brands + product names) |
| per-prompt `cited_evidence` | `sku_opportunity.py:150-184` | verbatim AI excerpt + `cited_hosts` + `competitors_named` |
| `where_you_can_win.skip` (head terms owned) | `build_where_you_can_win :5546` | `owned_by`, `competitors_named[:3]`, evidence excerpt |
| `merchant_type` (brand \| reseller) | `_audit_merchant_vendors :495-520`, on `brand_rollup :9047`; type `lib/types/ai-readiness.ts:886` | the framing key (R0) |
| `citation_role` on every cited host | throughout | editorial / marketplace / independent_retailer / creator / forum — the **advice hook** |
| `derive_brand_aliases` (brand-form matcher) | `services/brand_alias.py:95` | reused from R0/R1 — the catalog-overlap matcher |

**Portal render points:** Findability split `components/audit/MerchantNarrativePanel.tsx:91-167`
(`FindabilityEndorsementSplit` — renders findability + endorsement hosts ONLY); "What AI
names instead" `:169-211` (`WhoAiCitesInsteadBlock`, under "Where you can grow", NOT
Findability); `BuyDestinationPanel page.tsx:2267-2342` (reseller-gated `:2268`); "Winning
today" `WinPlanPanel.tsx:225-289`; `WhereYouCanWinPanel page.tsx:2996-3019`;
`CrossProductCompetitors page.tsx:1201-1227`.

## The gaps (what's actually missing)
1. **Channel lists exist but aren't in Findability.** `cited_not_naming_hosts` /
   `competitor_hosts` are computed but only `findability_hosts` + `endorsement_hosts` render
   in the Findability box; the richest channel list (`routed_to_instead`) is **reseller-only**.
2. **No "how to compete" advice anywhere** — every competitive surface is a name/host list.
   `citation_role` (the natural advice hook) is present and unused for guidance.
3. **No "why they win"** — competitor data is names + the raw verbatim excerpt; never
   structured claims. Probe returns flat brand strings (`deepseek_probe.py:148`).
4. **No catalog-overlap** — competitor product names are NEVER matched against the merchant's
   catalog (grep `catalog_overlap`/`do_you_carry` → nothing). So we can't tell a retailer
   "these winning products you don't carry are where AI sends buyers."

## Build slices

### C1 — Channels in Findability + how-to-compete advice
- **Backend:** include `cited_not_naming_hosts` + `routed_to_instead` (each with
  `citation_role`) in the findability section payload; add a `how_to_compete` advice field
  per channel keyed on `citation_role`:
  - editorial / review → "earn a review — pitch them" (the existing outreach play / pitch_draft)
  - marketplace (amazon/walmart/ebay) → "list your product there" (distribution)
  - independent_retailer / competitor storefront → "win the buy-path: get your canonical PDP
    cited; match their offer"
  - creator / forum → "creator partnership / community presence"
  Static role→template mapping is the core; optionally LLM-specialize the copy per channel.
- **Portal:** render channel chips + the per-channel advice in the Findability box
  (`MerchantNarrativePanel.tsx:91`); un-gate `routed_to_instead` for brands (or render
  `cited_not_naming_hosts` there for brands).
- Reuse: all data exists; this is surfacing + a role→advice map. Cheapest slice.

### C2 — Two-axis framing by `merchant_type`
- `merchant_type` already on `brand_rollup` (R0). Mostly **portal**: a presentation switch
  that frames the same competitive signals toward the merchant's lever:
  | Data | **brand** frame (improve product) | **retailer** frame (expand + win channel) |
  |---|---|---|
  | `competitor_benchmark` | "Beat them — match these claims / earn these reviews" | **"Winning products you don't carry — stock them" (C3)** |
  | `routed_to_instead` / `cited_not_naming_hosts` | "Get listed/cited in these channels" | "Win the buy destination" (R3, done) |
  | `where_you_can_win.targets` | "Niches your attributes can own" | "Categories to stock + own the AI buy-path" |
- Today half-built: reseller → `BuyDestinationPanel`, brand → `WinPlanPanel`; neither gets the
  *opposite* axis. C2 wires the right framing per type. **Backend:** ensure both axes' data is
  present on the report for both types (e.g. don't suppress channel data for brands).

### C3 — "Winning products you don't carry" (catalog-overlap) — the novel build
- **Backend:** a new step `winning_products_not_carried`:
  1. Collect competitor names from `competitor_benchmark` / `competitors_named` across losing
     queries, with frequency (how often AI names each).
  2. **Filter generic noise** (ingredient/category terms — "Magnesium", "Probiotics").
     **DEPENDENCY:** this cleaning exists on branch `chore/adr-006` as `d613e363`
     ("drop ingredient/category types from competitors AI named") but is **NOT on main** —
     land it first, or C3 includes the filter.
  3. **Match against the merchant's catalog:** brand-level via `derive_brand_aliases(name)` vs
     the merchant's product vendors/brands (`catalog_products.brand`/vendor); product-level via
     token overlap of the competitor product name vs the merchant's `catalog_products.title`.
  4. Emit the competitor products whose brand-forms + names do NOT match anything in the
     catalog → "winning products you don't carry," ranked by AI-name frequency, with the
     queries they win.
- **Portal:** a new reseller-first panel — "Winning products you don't carry — consider
  stocking these (AI sends buyers to them)."
- Reuse: `derive_brand_aliases` (R0/R1 matcher), the competitor lists, the merchant catalog.
- **Matching precision is the key design risk** — see open decisions.

### C4 (deferred) — "why they win" attributes
- Near-term: have a frontier model extract "why they win" from the existing
  `cited_evidence.excerpt` (already captured, shown raw). Longer-term: extend the probe schema
  (`deepseek_probe.py:148`) to return per-competitor claims. Defer until C1-C3 land.

## Open decisions (need the user)
1. **C3 matching precision:** brand-match only (high precision, misses product-only winners)
   vs brand + product-name token overlap (broader, noisier)? Recommend **brand-match first**
   (reuse `derive_brand_aliases`, high precision), add product-token as a v2.
2. **C3 dependency:** land the competitor-name cleaning (`d613e363`) on main first, or have C3
   self-filter ingredient/category noise? Recommend **land `d613e363` first** (it's the right
   home for that cleaning; C3 then stays focused on the overlap).
3. **Advice generation (C1):** static role→template mapping vs LLM-specialized copy? Recommend
   **static templates first** (deterministic, cheap), LLM-specialize as a v2.
4. **C2:** show only the merchant's-lever axis, or both axes with the lever emphasized?
   Recommend **lever-emphasized, opposite axis secondary**.

## Recommended sequence
1. **C1** (cheapest — data exists; surfacing + a role→advice map; both brand & reseller benefit).
2. **C2** (presentation switch on `merchant_type`; small backend to ensure both axes' data ships).
3. **C3** (the novel build; after the `d613e363` cleaning lands). Highest differentiation —
   the "products you don't carry" insight no DIY-with-a-frontier-model can produce.
4. **C4** deferred.

## Change log
- 2026-06-20 — scope created from the competitive-landscape investigation. Data mostly EXISTS;
  gaps are framing (C1/C2), advice generation (C1, `citation_role` hook), and one novel join
  (C3 catalog-overlap, reusing `derive_brand_aliases`; depends on competitor-name cleaning
  `d613e363` not yet on main). Feeds the E1 enrichment grounded brief.
