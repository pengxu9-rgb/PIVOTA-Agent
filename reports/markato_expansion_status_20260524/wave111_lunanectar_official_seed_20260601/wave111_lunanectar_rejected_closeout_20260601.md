# Wave111 Luna Nectar Official-Seed Rejected Closeout - 2026-06-01

## Scope

Candidate IDs:

- `ext_31649f8f88272f3a8d522c4d` - Moon Boost Eyebrow and Lash Serum
- `ext_60b9ad953781f0fa6bf4b61e` - Exploration 01 Ampoule Repair Shampoo
- `ext_c10190a05ba9f5bd651d3385` - Exploration 02 Ampoule Hydrating Conditioner

## Reviewer Decision

Rejected. The exact production audit showed all three rows were still KB-blocked, but public serving docs did not build for the slice and the validated replacement builder rejected `ext_31649f8f88272f3a8d522c4d` with `public_sensitive_claim`.

No dry-run publish, write, or post-write audit was run for this wave.

## Readiness Before

- scanned rows: 3
- action required: 3
- DB serving ready: 0
- public index ready: 0
- blocker: `kb_blocked` x3
- lane: `lane_3_kb_rewrite_review` x3
- direct displayable KB: 3
- direct high-quality KB: 0
- identity ready: 3
- public dry-run docs: 0

## Validation Failure

- rejected row: `ext_31649f8f88272f3a8d522c4d`
- issue: `public_sensitive_claim`
- evidence profile: `official_pdp_seed`

## Deployment Note

No `railway up` was run. No production write was performed for this rejected batch.
