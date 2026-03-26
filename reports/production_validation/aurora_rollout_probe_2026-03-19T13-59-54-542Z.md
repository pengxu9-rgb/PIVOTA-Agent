# Aurora Rollout Probe

- generated_at_utc: 2026-03-19T13:59:54.542Z
- base: https://pivota-agent-production.up.railway.app
- endpoint: /v1/chat
- samples: 6
- report_json: reports/production_validation/aurora_rollout_probe_2026-03-19T13-59-54-542Z.json

## Summary

- total_requests: 6
- success_200: 6
- non_200_count: 0
- parse_error_count: 0
- meta_null_count: 0
- mismatch_count: 0
- bucket_out_of_range_count: 0
- recovered_after_retry_count: 0

## Variant Split

| variant | count | pct |
| --- | ---: | ---: |
| v2_weather | 6 | 100% |

## Alert Checks

| id | severity | triggered | value | threshold | note |
| --- | --- | --- | --- | --- | --- |
| meta_missing | high | no | 0 | > 0 | meta must always be present |
| header_meta_mismatch | high | no | 0 | > 0 | header/meta drift detected |
| bucket_out_of_range | high | no | 0 | > 0 | bucket must stay in [0,99] |
| elevated_failures | high | no | 0 (recent_failure_runs=0) | >=2 runs with non_200_or_parse_error in 10m | transient CDN failures need 2-run confirmation |
| infra_flake_single_run | warn | no | 0 | > 0 on single run (no page) | expected for intermittent CDN/WAF noise |

