# Markato Wave52 Miss Nella Canonical Mapping Review - 2026-05-28

## Reviewer Decision

Wave52 reviewed the 53 Miss Nella P2 rows from Wave51's `canonical_parent_or_bundle_mapping_request` lane. The review found parent candidates and blockers, but it did not approve serving promotion or content inheritance.

- Runtime/database writes performed: no
- Railway CLI deployment action performed: no
- Git artifact push expected after review: yes
- Serving promotions approved: 0
- P2 rows reviewed: 53
- Component-ref candidate rows: 33
- Blocked rows: 20

## Decision Counts

| decision | count |
| --- | --- |
| blocked_ambiguous_family_parent | 2 |
| blocked_missing_ready_parent | 15 |
| blocked_parent_not_ready | 3 |
| candidate_component_ref_ready | 33 |

## Mapping Type Counts

| mapping_type | count |
| --- | --- |
| same_shade_pack_to_ready_parent | 16 |
| shade_or_pack_without_ready_parent | 15 |
| wholesale_pack_to_ready_parent | 8 |
| wholesale_accessory_pack_to_ready_parent | 4 |
| add_on_selector_to_ready_parent | 3 |
| blocked_parent_not_ready | 3 |
| family_selector_without_single_parent | 2 |
| add_on_shade_to_ready_parent | 2 |

## Main Finding

The P2 lane is not a source-recovery lane. Most rows are add-on selectors, wholesale/multipack pages, retail display surfaces, or same-shade 3-pack pages. 33 rows have a clear same-brand ready parent and can move to a metadata-only component-ref dry-run if requested. The remaining 20 rows should stay held because the parent is not ready, missing, or ambiguous.

## Parent Summary

| target_parent | target_parent_external_product_id | decision | child_rows |
| --- | --- | --- | --- |
| Lip Balm | ext_cf0f60c66afa3fb09944df4d | candidate_component_ref_ready | 5 |
| Nail Stickers | ext_b575a7ed71f0a4602a68c461 | candidate_component_ref_ready | 4 |
| Blush | ext_33466da0907b256ffc53783b | candidate_component_ref_ready | 3 |
| Eye Shadow | ext_e9e3fba6b05911bba1bfe71e | candidate_component_ref_ready | 3 |
| Blueberry Smoothie nail polish shade |  | blocked_missing_ready_parent | 2 |
| Cheeky Bunny nail polish shade |  | blocked_missing_ready_parent | 2 |
| Croco Dazzle: Sparkly Red Peel Off Nail Polish | ext_8c9db1e831c4be15a42fc407 | candidate_component_ref_ready | 2 |
| Galactic Unicorn: Chrome Purple Peel Off Nail Polish | ext_3efab0751a9f85bbdcb72388 | candidate_component_ref_ready | 2 |
| ‘Cool Like Me’ Roll On Perfume | ext_cfbb0ca2b9d0c7b411793b0b | blocked_parent_not_ready | 1 |
| ‘Sweet Like Me’ Roll On Perfume | ext_6f491538dbf9a790b66cf269 | blocked_parent_not_ready | 1 |
| Alien Poo: Chrome Green Peel Off Nail Polish | ext_5b4820a93b2ff42fde402c6e | candidate_component_ref_ready | 1 |
| Banana Split nail polish shade |  | blocked_missing_ready_parent | 1 |
| Body glitter add-on family |  | blocked_ambiguous_family_parent | 1 |
| Bubble Gum nail polish shade |  | blocked_missing_ready_parent | 1 |
| Butterfly Wings nail polish shade |  | blocked_missing_ready_parent | 1 |

## Blocked Summary

| blocked_decision | count |
| --- | --- |
| blocked_ambiguous_family_parent | 2 |
| blocked_missing_ready_parent | 15 |
| blocked_parent_not_ready | 3 |

Blocked interpretation:

- `blocked_missing_ready_parent`: no ready 4 ml/generic parent exists in the current rollup; request official source evidence or create/review a canonical parent first.
- `blocked_parent_not_ready`: a likely parent exists, but that parent still has source/risk/evidence blockers.
- `blocked_ambiguous_family_parent`: the row is a selector/family surface, not a concrete formula; split into explicit variants or hold.

## Operator Instructions

1. If the team wants a real metadata move, start with `missnella_component_ref_candidate_mapping.json` and run a production dry-run only. Do not write first.
2. Treat the candidate JSON as identity/component mapping only. It does not authorize copying ingredients, directions, or product-intel from parent rows.
3. Keep all child rows non-serving unless a later review explicitly approves pack/offer surfacing.
4. Work `missnella_blocked_parent_requests.csv` separately: missing parents need official source or reviewed canonical parent creation; non-ready parents need their own source/risk review first.

## Artifacts

- `missnella_p2_mapping_decisions.csv`
- `missnella_parent_resolution_summary.csv`
- `missnella_blocked_parent_requests.csv`
- `missnella_component_ref_candidate_mapping.json`
- `wave52_mapping_manifest.json`
