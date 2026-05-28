# Markato Wave53 Miss Nella Component-Ref Dry-Run - 2026-05-28

## Reviewer Decision

Wave53 attempted the next safe move from Wave52: a production read-only dry-run for the 33 Miss Nella component-ref candidates. No production write was performed and no `railway up` command was run.

The production DB dry-run is blocked by access shape, not by mapping quality:

- Local Railway env exposes `DATABASE_URL` with the private host `postgres-xmr6.railway.internal`, which is not resolvable from the local machine.
- A general `railway connect` database shell was not used because it is broader than the authorized narrow read-only dry-run.
- Railway SSH probes against helper services did not provide a usable running execution surface.

## Static Preflight

A local static preflight was run against the committed Wave50 rollup and the Wave52 mapping JSON. This is not a replacement for the production DB dry-run, but it confirms the candidate packet is internally consistent.

| check | result |
| --- | --- |
| candidate mappings | 33 |
| unique ids checked | 53 |
| static ready rows | 33 |
| static blocked rows | 0 |
| host mismatches | 0 |
| missing rollup rows | 0 |

## Current Status

- Read-only helper added and pushed: `7f783f46`
- Production DB dry-run output: not available yet
- Runtime/database writes: 0
- Serving promotions: 0

## Next Safe Options

1. Provide or configure a public read-only production Postgres URL, then run `wave53_read_only_component_ref_dry_run.cjs --read-only` locally.
2. Enable a narrow Railway SSH/exec path on a running service in the private network, then run the same helper server-side.
3. Add a purpose-built no-write production dry-run job/endpoint that performs only the SELECT validation and emits the dry-run report.

## Artifacts

- `wave53_read_only_component_ref_dry_run.cjs`
- `wave53_static_preflight_from_rollup.json`
- `wave53_dry_run_attempt_summary.json`
