# Relationship graph recommendation utility

The 2026-10-01 supplied run census reports 135 approvals on 45 anchors (44 newly covered), minimum confidence 0.900 and 93 family-variant guard blocks. Those counters describe approvals and coverage, not whether a shopper gained a useful choice. The supplied 30-pair sample contains 18 clear variants, four complement opportunities, seven distinct-line alternative opportunities and one unresolved blusher pair. The user's approximately 70% estimate applies to the full 135; it is not a measurement from this sample.

## Relation inference and approval

| Pair | Stored relation for new candidates | Approval requirements |
|---|---|---|
| A lower-priced close substitute | `dupe` | Matching job/form/target area, fresh same-currency prices, plus verified current-pair curated dupe evidence or substantial overlapping INCI; human review before serving |
| A distinct product-line substitute or comparable option | `competitive_alternative` | Concrete supplied facts for the same job/step/area and useful differences; same-brand distinct lines are allowed |
| A product used alongside the anchor | `related_product` | A distinct routine role/area or explicit current-pair usage evidence; same brand/line/routine alone is insufficient |
| A need-specific option | `niche_specialist` | The existing need/evidence gates and a grounded explanation of specialization |
| Another shade, size, scent/flavour or decorative style of the same product/collection | No new recommendation candidate | Variant selection belongs to product options, not recommendation coverage |

Inference generates review candidates; it does not prove recommendation utility. The v4 reviewer returns `relationship_kind` (`dupe`, `substitute`, `alternative`, `complement`, `variant`, `none`), exact anchor/candidate fact quotes and an exact consumer-copy contract for the claimed kind. Shopper summaries, tradeoffs and watchouts are generated from conservative fixed text; the verified source quotes carry product-specific differences. Model-authored clinical, safety, strength or performance prose is not accepted for those fields, and the apply boundary repeats this check. Deterministic checks reject absent/invented quotes, semantic lane mismatches, structurally incompatible alternatives, title/category-only dupes and same-step products mislabeled as complements. Structural substitutes cannot pass as complements even when one or both role names are unresolved. Unresolved roles require supplied affirmative counterpart-specific pairing instructions. Negative current-pair instructions reject the complement even alongside a positive note; positive and negative references both require the exact counterpart rather than a longer SPF/product name; own-product mentions and a different product or variant do not establish a pair. A generic or own-title-only pairing note does not establish a current pair. Confidence cannot bypass these checks. Unsupported equivalence remains a limitation even when INCI overlaps.

Approval updates only a still-`generated` label, preserving relation identity and protected approvals. Reviewed `why_candidate`, tradeoffs and watchouts are stored with the v4 provenance and travel through SimilarItem, the final PDP recommendation projection (including canonical hydration), and agent Signals. Prices keep their existing market/currency gates.

## Variant policy expansion

`relationshipPairPolicy.isSameFamilyVariant` is shared by source filtering, the builder and AI serving guards. It interprets explicit shade/style/scent options together with product roles and formula markers. Unknown jobs cannot establish variants even with matching option numbers. Product-bearing comma/dash/pipe tails retain their substantive names and formats rather than collapsing to a shared collection. Application tools retain their actual brush/sponge/applicator/puff job and cosmetic target rather than inheriting the product they apply; cleansing cream retains its cleansing step. Magnetic, self/pre-applied adhesive/no-glue and required-glue attachment modalities remain meaningful lash/nail choices even after a style separator. Emulsion versus eye cream, essence versus ampoule, powder Matte/Glow finishes, mascara waterproof/washable formulations, SPF/strength/formulation differences and distinct named product-line heads remain separate. A shared product-line id alone does not establish variants. The original `sameProductListingTitle` / `isSameProductAcrossListingsOrSizes` title-rule functions are unchanged, including their documented one-sided-tail residual.

This deliberately changes the earlier style policy: same-line Falscara pipe-separated styles are now variants. On the earlier 29 supplied pairs, the original same-product reason still detects 25/29; the full guard now suppresses 28/29 because the three Falscara style pairs are also suppressed. Rouge Artist For Ever Matte versus Rouge Artist For Ever remains distinct. Human-approved edges remain outside AI suppression.

Duplicate listings/sizes are rejected during new inference and guarded on both AI related/alternative lanes. This prevents removing the same-brand alternative prohibition from creating duplicate coverage.

## Candidate opportunities and quality metrics

The bounded candidate selector reserves up to half its slots for evidenced cross-brand substitute opportunities when such products exist in the loaded source pool. It shares the builder's job/form/target-area admission rules, spreads the reserved slots across candidate brands and never treats brand variety as approval evidence. Incompatible high-scoring face/body or format pairs cannot consume the reserved lane. Complement candidates remain in the ordinary lane. Source table scans, limits and the uncovered-priority flag-off SQL remain unchanged; this does not establish recall across the entire catalog or remedy brands absent from the bounded source pool.

Review JSON and routine/ledger JSON now carry useful approvals by kind, semantic rejections, variant rejections, candidate/approved brand distribution and cross-brand approval counts. Builder JSON includes proposed brand distribution and variant rejection counts. The existing actual-write counters, serving progress, eligible error denominator, review-error gate, bounded serving scan and advisory-lock retry behavior retain their meanings.

## Offline evidence and validation

Run `node scripts/eval-relationship-recommendation-utility.js`. It reads only committed sanitized fixtures; it performs no database, model or network call. Measured title-policy replay:

- 18/18 clear variants blocked, with zero suppression of the 12 retained pairs.
- Four complement and seven alternative opportunities retained; the Cotton Mix Blusher 11g / Cotton Blusher 4g pair remains unresolved.
- Earlier 29-pair replay: original same-product reason 25, combined policy 28.

Titles and prior rationales are truncated. This measures deterministic variant detection, not live LLM approval precision, production coverage or cross-brand yield. Generic semantic regressions also cover roles, strengths/SPF, invented facts, false complement claims, mismatched alternative structures, current-pair curated dupe evidence, missing INCI and candidate crowding. A local PostgreSQL test builds/persists/reviews a same-brand distinct-line alternative, reads it through the `competitive_alternative` SQL filter and projects the reviewed rationale into an alternative Signal.

## Existing data and dupe access

No production actions are part of this change. Existing AI variants will be filtered when this code is deployed; an operator can later review a dry-run serving-guard audit and separately approve targeted retirement. Existing mislabeled alternatives do not automatically move from `related_product` into the alternatives tool: review those pairs, generate the correctly typed candidate and retire the obsolete AI label under the existing operator review workflow. Do not mutate relation identity or overwrite protected human labels to perform that remediation.

The agent `get_alternatives` path serves approved dupes only for explicit dupe intent (`include_dupes`); human approval is still required by the serving view/guard and the data-exposure contract. Verified current-pair KB evidence can generate a dupe proposal without INCI; candidate-level KB provenance or a curated comparable cannot. `--allow-dupe-ai-approval` permits an explicitly audited AI labeling operation but does not remove the AI-dupe serving quarantine. Broader dupe availability needs a reviewed human queue and evidence/performance validation, not a confidence threshold or a new automatic flag.
