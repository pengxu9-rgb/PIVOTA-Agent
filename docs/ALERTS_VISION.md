# Vision Alerts

This document defines alerting rules for Aurora skin-photo analysis availability.

## Metrics

- `vision_calls_total{provider,decision}`
- `vision_fail_total{provider,reason}`
- `vision_latency_ms_bucket{provider,le}`
- `vision_fallback_total{provider,reason}`

## Recommended alerts

1. Configuration errors
- Trigger when `vision_fail_total{reason="VISION_MISSING_KEY"}` or `vision_fail_total{reason="VISION_DISABLED_BY_FLAG"}` keeps increasing for 10+ minutes.
- Action: verify deployment env (`OPENAI_API_KEY`, `AURORA_SKIN_VISION_ENABLED`) and rollback recent config changes.

2. Quota or rate pressure
- Trigger when `vision_fail_total{reason="VISION_RATE_LIMITED"}` or `vision_fail_total{reason="VISION_QUOTA_EXCEEDED"}` spikes above baseline.
- Action: increase quota, reduce traffic burst, or apply backpressure/sampling.

3. Upstream instability
- Trigger when `vision_fail_total{reason="VISION_TIMEOUT"}` or `vision_fail_total{reason="VISION_UPSTREAM_5XX"}` exceeds normal error budget.
- Action: inspect upstream health, network latency, and retry saturation.

4. Bad requests or schema drift
- Trigger when `vision_fail_total{reason="VISION_UPSTREAM_4XX"}` or `vision_fail_total{reason="VISION_SCHEMA_INVALID"}` rises unexpectedly.
- Action: inspect request schema compatibility, input validation, and provider contract changes.

5. Download chain issues
- Trigger when `vision_fail_total{reason="VISION_IMAGE_FETCH_FAILED"}` increases.
- Action: verify signed URL generation/fetch path and image proxy reliability.

## Triage notes

- `decision="fallback"` means we served CV-only findings and did not block the user.
- `decision="skip"` with no vision failure reason is expected for policy-driven skips (for example, no photo requested).
- Never log raw image bytes or reversible biometric artifacts during incident debugging.
