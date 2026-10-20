# MCP caller limits: log-based metrics and alert (definitions only, NOT applied)

Source: the WARN lines written by `src/guardrails/mcpCallerLimits.js`. Pino writes JSON to stdout, so Cloud
Run puts each line's fields under `jsonPayload`; every filter keys on `jsonPayload.event`.

| File | What it counts |
|---|---|
| `zombie_metric.yaml` | `mcp_caller_limit_reaped` — an in-flight slot past its max age (flagged, still counted). Any non-zero count at the 600 s default is a bug. |
| `decisions_metric.yaml` | `mcp_caller_limit` would-reject / reject lines, labelled by action, reason, tier, door, limit_split. |
| `store_metric.yaml` | `mcp_caller_limit_store`, `mcp_caller_limit_salt` and `mcp_caller_limit_stale` — shared store / salt unavailable, or the shared snapshot older than 30 s because syncs keep being skipped (limits fall to per-instance shares). Labelled by `code`, which all three lines carry. |
| `zombie_alert_policy.yaml` | Alert: any zombie in 10 minutes. |

Create them (an operator decision, not part of the deploy):

```bash
gcloud logging metrics create mcp_caller_limit_zombies   --config-from-file=zombie_metric.yaml
gcloud logging metrics create mcp_caller_limit_decisions --config-from-file=decisions_metric.yaml
gcloud logging metrics create mcp_caller_limit_store     --config-from-file=store_metric.yaml
gcloud alpha monitoring policies create --policy-from-file=zombie_alert_policy.yaml
```

Add a notification channel to the policy before creating it.
