# Wave117 Dermalogica Continuation Product Intel Closeout - 2026-06-01

## Scope

Audited two Dermalogica continuation rows:

- `ext_539c5068c2d9cc9f5f471093` - biolumin-c night restore serum
- `ext_eca8959862245d5af16ab206` - daily milkfoliant exfoliator

## Reviewer Decision

Published exactly one replacement:

- `ext_eca8959862245d5af16ab206` - daily milkfoliant exfoliator

The other row was already DB-serving-ready in the exact pre-audit and was treated as a stale no-op.

## Validation

Before:

- scanned rows: 2
- action required: 1
- DB serving ready: 1
- public index ready: 1
- blockers: `db_serving_ready` x1, `kb_blocked` x1
- direct high-quality KB: 1
- direct seller-only or limited KB: 1
- public docs: 2

Reviewed report:

- selected rows: 1
- public-ready candidates: 1
- high-quality-ready candidates: 1
- evidence profile: `seller_plus_formula` x1

Publish:

- dry-run rows: 1
- write rows: 1
- skipped rows: 0

After:

- scanned rows: 2
- action required: 0
- DB serving ready: 2
- public index ready: 2
- direct high-quality KB: 2
- public docs with insight summary: 2

No `railway up` was run.
