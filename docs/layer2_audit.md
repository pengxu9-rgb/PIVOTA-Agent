# Layer2 Audit CLI

`layer2:audit` generates a daily “readiness report” for Layer2 telemetry quality and Phase 1.5 rollout health.

## Command

```bash
npm run layer2:audit -- --date YYYY-MM-DD --market US|JP
```

## Inputs

### Look Replicator events (preferred)

If `LR_EVENTS_JSONL_SINK_DIR` is set, the audit reads:

- `look-replicator-YYYY-MM-DD.jsonl`

Each line is JSON:

```json
{ "event": "lr_adjustments_exposed", "properties": { ... }, "timestamp": "..." }
```

### Outcome samples (optional)

If `DATABASE_URL` is set, the audit queries:

- `outcome_samples_us` or `outcome_samples_jp`

### MVP events (optional)

If `DATABASE_URL` is set, the audit queries `mvp_events` (best-effort).
If not, and `MVP_EVENTS_SINK=file`, it will try to read `mvp_events.jsonl` (or `MVP_EVENTS_JSONL_PATH` if set).

## Outputs

Written to:

- `artifacts/reports/layer2-audit-<market>-<date>.md`
- `artifacts/reports/layer2-audit-<market>-<date>.json`

The JSON file contains raw metrics used to render the Markdown summary.

