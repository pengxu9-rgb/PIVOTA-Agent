# MCP caller limits: log-based metrics and alert (definitions only, NOT applied)

Source: the WARN lines written by `src/guardrails/mcpCallerLimits.js`. Pino writes JSON to stdout, so Cloud
Run puts each line's fields under `jsonPayload`; every filter keys on `jsonPayload.event`.

| File | What it counts |
|---|---|
| `zombie_metric.yaml` | `mcp_caller_limit_reaped` — an in-flight slot past its max age (flagged, still counted). Any non-zero count at the 600 s default is a bug. |
| `decisions_metric.yaml` | `mcp_caller_limit` would-reject / reject lines, labelled by action, reason, tier, door, limit_split. |
| `store_metric.yaml` | `mcp_caller_limit_store`, `mcp_caller_limit_salt` and `mcp_caller_limit_stale` — shared store / salt unavailable, or the shared snapshot older than 30 s because syncs keep being skipped (limits fall to per-instance shares). Labelled by `code`, which all three lines carry. |
| `zombie_alert_policy.yaml` | Alert: any zombie in 10 minutes. |
| `shed_alert_policy.yaml` | Alert: enforce-mode SHEDDING (`action=reject`, reason `shed`, `tier_concurrency` or `tier_rate`: the 503s) in every 5 minutes for 10 minutes. The tool error-rate alert never counts a shed call (`outcome=shed`, `error_class=capacity`), so this is the only page for a saturated database. |
| `store_alert_policy.yaml` | Alert: store, salt or stale lines in every 5 minutes for 15 minutes: the limits have been on per-instance shares that long. |

## What a shed 503 covers

Three reasons answer 503, all written before dispatch (`firstViolation`):

- `shed`: the database pool has waiters at or above the threshold. Anonymous callers shed at
  `MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING`; every other limited caller, unregistered OAuth clients included, at
  `MCP_CALLER_LIMITS_SHED_PARTNER_POOL_WAITING`.
- `tier_concurrency` / `tier_rate`: a tier is full on this instance, or has spent its requests per minute. There
  are two tiers: anonymous, and **unregistered OAuth clients** (an OAuth client with no override of its own,
  `policyFor`; its line says `tier=partner`, `oauth_unregistered=true`).
- The tier rate is shared across instances. While the store is down, its snapshot is stale, or the key has
  not been synced yet, it drops to **the per-instance share** (limit / `MCP_CALLER_LIMITS_EXPECTED_INSTANCES`,
  `effectiveLimit`), so a store outage alone can raise `tier_rate` 503s (`limit_split=true`). Expect the store
  alert alongside.

The per-caller `rate` and `concurrency` refusals answer 429 and are not shedding. They are cut to the
per-instance share in the same fallback.

Create them (an operator decision, not part of the deploy):

```bash
gcloud logging metrics create mcp_caller_limit_zombies   --config-from-file=zombie_metric.yaml
gcloud logging metrics create mcp_caller_limit_decisions --config-from-file=decisions_metric.yaml
gcloud logging metrics create mcp_caller_limit_store     --config-from-file=store_metric.yaml
gcloud alpha monitoring policies create --policy-from-file=zombie_alert_policy.yaml
gcloud alpha monitoring policies create --policy-from-file=shed_alert_policy.yaml
gcloud alpha monitoring policies create --policy-from-file=store_alert_policy.yaml
```

Create the metrics first; a policy on a metric that does not exist yet is refused. Add a notification channel
to each policy before creating it. The shed policy fires only in enforce mode: in observe mode nothing is
refused (`action=would_reject`). The store policy fires in observe mode too, since syncs run whenever the limits
are on. With the limits off, neither metric gets a line.
