# Agreement Playbook

## Daily Verify Report

Use the daily report to track verifier health from `model_outputs.ndjson` and `agreement_samples.ndjson`.

### Default run

```bash
make verify-daily
```

By default this reads:

- input dir: `tmp/diag_pseudo_label_factory` (expects `manifest.json`, `model_outputs.ndjson`, `agreement_samples.ndjson`)
- hard cases: `tmp/diag_verify/hard_cases.ndjson`
- output dir: `reports`

### Custom date / paths

```bash
make verify-daily VERIFY_REPORT_DATE=2026-02-09
make verify-daily VERIFY_IN=tmp/diag_pseudo_label_factory VERIFY_OUT=reports
```

You can also run the script directly:

```bash
node scripts/report_verify_daily.js --in tmp/diag_pseudo_label_factory --out reports --date 2026-02-09
```

### Output artifacts

- `reports/verify_daily_YYYYMMDD.md`
- `reports/verify_daily_YYYYMMDD.json`

The markdown includes:

- Overview: `verify_calls_total`, `verify_fail_total`, `average_agreement`, `hard_case_rate`, `latency_p50_ms`, `latency_p95_ms`, `calls_skipped_by_budget_guard`
- Breakdown by `issue_type`
- Breakdown by `quality_grade` (`pass` / `degraded`)
- `verify_fail_by_reason` table (`TIMEOUT`, `RATE_LIMIT`, `QUOTA`, `UPSTREAM_4XX`, `UPSTREAM_5XX`, `SCHEMA_INVALID`, `IMAGE_FETCH_FAILED`, `UNKNOWN`)
- `eligible_buckets` observation section (future vote candidates; still shadow-only)
- Top 20 hard cases (hashes only, no image content)

## Reliability Buckets

Build bucketed reliability stats from `model_outputs + agreement_samples + gold_labels`:

```bash
make reliability-table
```

Optional date filtering:

```bash
make reliability-table RELIABILITY_DATE=2026-02-09
```

Direct script usage:

```bash
node scripts/build_reliability_table.js --in tmp/diag_pseudo_label_factory --out reports/reliability/reliability.json --date 2026-02-09
```

The output `reliability.json` groups by:

- `issue_type`
- `quality_grade`
- `lighting_bucket`
- `tone_bucket`

Each bucket includes `verify_fail_rate`, agreement stats, gold support, and `eligible_for_vote`.
Runtime remains shadow-only unless vote is explicitly enabled by `DIAG_VERIFY_ENABLE_VOTE=true`.

### Privacy rules

- Do not include raw image bytes, URLs, EXIF, or user identifiers.
- Hard-case rows in report must stay hashed (`request_id_hash`, `asset_id_hash`).
