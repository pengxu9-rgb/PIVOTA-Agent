# Relationship graph: why there is no GitHub workflow here

`relationship-graph-sync-routine.yml` and `relationship-graph-serving-guard-audit.yml` were removed
on 2026-09-09. They did not fail because of a bug in this repo, and they cannot be repaired here.

**Prod Postgres is private-only.** `pivota-pg` has `ipv4Enabled: false`, one RFC1918 address
(`10.25.0.2`), and no authorized networks. A GitHub-hosted runner has no route to it. The
`read ECONNRESET` those runs reported is GitHub's network resetting traffic to a non-routable
address — not a database fault, and not something a retry or a longer timeout fixes.

Both last succeeded **2026-08-25**, the day the Railway `DATABASE_URL` was decommissioned
(`pivota-backend infra/gcp/setup_scheduler.sh`). One sibling workflow,
`external-seed-sentinel-nongrowth`, was migrated to a Cloud Run job the same day. These two were
missed and broke the next morning, then sat red — and then stopped firing — for two weeks.

A dead workflow that still exists is worse than none: it implies coverage that is not there.

## Where the work runs now

| was | now |
|---|---|
| `relationship-graph-sync-routine.yml` | Cloud Run job **`relgraph-sync`**, already live and passing daily (`setup_scheduler.sh`) — this workflow had been redundant since the migration |
| `relationship-graph-serving-guard-audit.yml` | Cloud Run job **`relgraph-health`**, running `npm run relgraph:health-job` |

The serving-guard gate used to live as an inline `node -e` in the workflow YAML, which is why it
could not simply be pointed at a job. It is now `scripts/run-relgraph-health-job.js`, in code, with
tests, and it runs the no-op-run detector in the same pass.

Anything that must read prod Postgres belongs on the Cloud Run path. If you are adding a scheduled
DB check, add a job in `setup_scheduler.sh` — not a workflow here.
