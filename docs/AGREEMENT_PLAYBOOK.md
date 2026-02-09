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

- Overview: `verify_calls_total`, `verify_fail_total`, `average_agreement`, `hard_case_rate`
- Breakdown by `issue_type`
- Breakdown by `quality_grade` (`pass` / `degraded`)
- Top 20 hard cases (hashes only, no image content)

### Privacy rules

- Do not include raw image bytes, URLs, EXIF, or user identifiers.
- Hard-case rows in report must stay hashed (`request_id_hash`, `asset_id_hash`).
