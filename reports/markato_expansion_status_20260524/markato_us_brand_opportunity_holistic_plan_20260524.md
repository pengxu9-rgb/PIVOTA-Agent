# Markato US Brand Opportunity Holistic Plan - 2026-05-24

## Scope

This is a planning artifact for the Markato US brand collaboration opportunity workstream. It uses the existing Wave5 production/audit artifacts only. No additional production write, Railway deploy, public-index enablement, or seller-only fallback is implied here.

Primary source artifacts:

- `wave5_quality_closeout_20260524.md`
- `wave5_live_pdp_after_absolute_berry_structured_inci/live_pdp_modules_25_ext.json`
- `wave5_commerce_public_dry_run_summary.json`
- `markato_coverage_summary.json`
- `markato_next_wave_candidates.csv`

## What We Are Building

The work has moved beyond one-off SKU cleanup. We are building an operator pipeline that turns Markato brand opportunities into reliable Pivota commerce/product-intel surfaces:

1. Brand/domain opportunity inventory: rank Markato brands by US availability, official DTC signal, category risk, and product signal depth.
2. External seed and identity pipeline: create curated official-DTC manifests, insert only reviewed publishable products, and sync serving/index identity state.
3. Live PDP quality gate: verify public PDP modules for gallery, variant clarity, insights, reviews, ingredients, how-to, and product-kind-specific requirements.
4. Public commerce/product-intel layer: dry-run public commerce docs with insight summaries, while keeping strict public index readiness gated by reviewed KB/Pivota Insights state.
5. Evidence guardrails: keep official source truth separate from seller-only or inferred content; block force-filled INCI; treat accessories/tools differently from formula products.

## Current State

### Wave5 Closeout

| Domain | Live PDP scanned | Strict ready | Thin | Main blocker | Public docs dry-run |
| --- | ---: | ---: | ---: | --- | ---: |
| `joujoubotanicals.com` | 11 | 10 | 1 | Cactus Nectar missing source-backed full INCI | 11/11 |
| `activedrip.com` | 8 | 0 | 8 | All missing source-backed full INCI | 8/8 |
| `coconutmatter.com` | 6 | 1 | 5 | Missing source-backed INCI and how-to | 6/7, with Hand Balm held |
| Total | 25 | 11 | 14 | 14 missing ingredients, 5 also missing how-to | 25/26 source rows |

Wave5 public docs can be built for 25 live identity rows, but strict live PDP readiness is 11/25. This is acceptable as a quality baseline because all thin rows are blocked by explicit missing official-source fields, not by weak insights, seller-only insight fallback, forced ingredients, or live 404/state drift.

### Wave5 Ready Assets

Ready strict PDP rows:

- JouJou: `ABSOLUTE BERRY Bio Retinol Face Oil`, `PLUM MELT Exosome Amino Cleanser`, `ISLAND GIRL Summer Oil`, `JUICY DREAM Lip Velvet Oil`, `APHRODITE Body Oil`, `FLORAL FILTER Face Mask`, `MARSHMALLOW ROSE Balancing Moisturizer`, `LA CREME MAGIQUE Rich Cream`, `Velvet Skincare Headband`, `CHARM Beauty Case`
- Coconut Matter: `2-in-1 Konjac Body Sponge`

Thin-but-public-doc-capable rows should remain public-doc dry-run candidates, not strict public-index-ready candidates, until source-backed ingredient/how-to gaps are resolved or explicitly held as partner data requests.

### Markato Opportunity Inventory

Coverage summary:

- 94 audited brand-domain records.
- 32 records already have active US seeds.
- 62 records are not seeded yet.
- 36 P0/P1 official DTC records are next-wave candidates.
- Current Markato-domain pool: 1,655 active US seed rows, 1,485 live identity rows, 167 review-hold identity rows.

Recommended next-wave signals from the inventory:

- Broad opportunity list: MASAMI, Herbalore, NOVOS, Therapy Notebooks, Lhamour.
- Small beauty wave list: Lhamour, Aetas, KHUS KHUS, DAEBY, Seresilk.

The small beauty lane is lower regulatory risk. Wellness/supplement brands may still be useful for partnerships, but need a stricter claims policy and likely should not be mixed into the next beauty quality wave.

## Interpretation

Wave5 proved the pipeline can recover live state, produce public commerce docs, and prevent low-quality content from leaking into strict PDP readiness. The remaining work is no longer primarily code remediation. It is evidence acquisition and partner-facing packaging.

The most important distinction now:

- Public doc dry-run readiness: useful for partnership demos and internal review packets.
- Strict live PDP readiness: requires source-backed formula/how-to completeness, or a product-kind rule that makes those modules not applicable.
- Public index readiness: should remain blocked until KB/Pivota Insights review is complete.

## Recommended Next Steps

### 1. Freeze Wave5 as the Quality Baseline

Do this before starting another large apply lane:

- Keep the Wave5 closeout artifact as the canonical handoff.
- Run the same targeted tests if code changes are going to be committed or published.
- Keep `Hand Balm` on identity hold unless exact official source identity resolves cleanly.
- Do not relax seller-only, force-fill, or benefit-only ingredient guards.

### 2. Build a Wave5 Partner Opportunity Packet

Create a brand-facing/internal opportunity packet from the existing production artifacts:

- One section per brand: JouJou, Active Drip, Coconut Matter.
- Include public-doc-capable SKU count, strict-ready SKU count, current holds, and exact data asks.
- For Active Drip, frame the 8 thin rows as "official INCI needed to unlock strict PDP readiness"; do not present marketing active-ingredient copy as full INCI.
- For Coconut Matter, separate formula gaps from accessory/tool treatment; Konjac sponge is now a positive example of correct product-kind handling.

This packet is the bridge from technical readiness to brand-collaboration sales/support material.

### 3. Run Source-Backed Gap Recovery for the 14 Thin Rows

Treat the 14 thin rows as a data-recovery lane, not a fallback-generation lane:

- Active Drip: 8 official INCI checks.
- Coconut Matter: 5 official INCI plus how-to checks.
- JouJou: 1 Cactus Nectar full INCI check.

Output should be a compact gap sheet with product ID, product URL, missing fields, evidence status, and one of: `apply_source_backed_patch`, `partner_data_request`, or `keep_thin`.

### 4. Resolve Coconut Matter Hand Balm Identity Hold Separately

Do not fold this into generic content patching. The issue is identity/canonicalization, not PDP content quality.

Recommended handling:

- Re-check canonical official PDP versus upsell/duplicate URL evidence.
- If exact identity resolves, apply a narrow reviewed identity patch and resync.
- If not, keep `identity_review_required` and list it as a partner/source-data ask.

### 5. Choose Wave6 With Two Lanes

Use separate goals instead of one mixed wave:

- Low-risk beauty quality wave: Lhamour, DAEBY, Aetas, KHUS KHUS, Seresilk. Start with extractor diagnostics because some first-pass manifests or dry-runs returned zero planned rows.
- Strategic opportunity wave: MASAMI as the P0 high-signal haircare candidate. Treat it as a focused pilot because the inventory shows high product signal volume and bot/captcha/homepage limitations.

Avoid mixing wellness/supplement candidates such as Herbalore or NOVOS into the next quality wave unless the claims policy and evidence gates are explicitly scoped.

## Suggested Execution Order

1. Create the Wave5 partner opportunity packet.
2. Produce the 14-row official-source gap sheet.
3. Attempt only source-backed patches found by that gap sheet, then resync and rerun live PDP audit.
4. Resolve or keep-hold Coconut Matter Hand Balm.
5. Run Wave6 extractor diagnostics for the low-risk beauty lane.
6. Pick one Wave6 apply subset only after dry-run rows are valid and review holds are understood.

## Guardrails To Preserve

- No `railway up`.
- No seller-only fallback for public/strict readiness.
- No force-filled or benefit-only ingredient text.
- No public index enablement for newly inserted SKUs before KB/Pivota Insights review.
- Regulated wellness/supplement products stay in a separate claims-reviewed lane.
