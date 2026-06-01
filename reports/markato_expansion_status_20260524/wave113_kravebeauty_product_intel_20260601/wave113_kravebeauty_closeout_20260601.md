# Wave113 KraveBeauty Product Intel Closeout - 2026-06-01

## Scope

Candidate IDs:

- `ext_593de56f9237926b73ba43ef` - Jumbo Great Barrier Relief
- `ext_5ffe1c0b5195b36d2bdcffa9` - Oil La La
- `ext_8bfea10f1af2ab628a5ad6ba` - Duo Oil La La

## Reviewer Decision

Published exactly two replacements:

- `ext_8bfea10f1af2ab628a5ad6ba` - Duo Oil La La
- `ext_593de56f9237926b73ba43ef` - Jumbo Great Barrier Relief

The initial three-row build rejected `ext_5ffe1c0b5195b36d2bdcffa9` with `public_sensitive_claim`. That row was filtered out and remains held. The two remaining rows then passed replacement validation and were published.

## Validation Artifacts

- Candidate manifest: `wave113_kravebeauty_candidate_ids.txt`
- Exact readiness audit before: `readiness_before/`
- Filtered validated report: `kravebeauty_product_intel_report.json`
- Publish dry-run: `kravebeauty_publish_dry_run.json`
- Publish write: `kravebeauty_publish_apply.json`
- Exact readiness audit after write: `readiness_after_product_intel/`

## Before

- scanned rows: 3
- action required: 3
- DB serving ready: 0
- public index ready: 0
- blocker: `kb_blocked` x3
- lane: `lane_3_kb_rewrite_review` x3
- direct displayable KB: 3
- direct high-quality KB: 0
- identity ready: 3
- public docs with insight summary: 0

## Product-Intel Review

Accepted:

- selected rows: 2
- public-ready candidates: 2
- high-quality-ready candidates: 2
- evidence profile: `official_pdp_seed` x2

Rejected/held:

- `ext_5ffe1c0b5195b36d2bdcffa9` - validator issue `public_sensitive_claim`

Publish validation:

- dry-run rows: 2
- dry-run entries: 2
- write rows: 2
- write entries: 2
- skipped rows: 0

## After

- scanned rows: 3
- action required: 1
- DB serving ready: 2
- public index ready: 2
- blockers: `db_serving_ready` x2, `kb_blocked` x1
- lanes: `ready_no_action` x2, `lane_3_kb_rewrite_review` x1
- direct high-quality KB: 2
- public docs with insight summary: 2

## Deployment Note

No `railway up` was run. Production writes were limited to the two reviewed KraveBeauty product-intel KB entries listed above.
