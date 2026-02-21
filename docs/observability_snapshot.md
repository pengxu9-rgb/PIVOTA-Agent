# Observability Snapshot: Online Health + Online Quality + Casebook

This document describes how to enable `debug_bundle` for `find_products_multi`, how fields are defined, and how to export 24h/7d snapshot reports.

## 1) Runtime instrumentation

### Response debug gating

`debug_bundle` is appended to response only when **both** conditions are met:

1. debug request flag:
   - header: `X-Debug: 1` (or `true`)
   - or query param: `debug=1` (or `true`)
2. source is allowlisted/private:
   - if `SEARCH_DEBUG_BUNDLE_ALLOWLIST` is set, requester IP must match allowlist
   - otherwise only private/local addresses are allowed

Relevant env:

- `SEARCH_DEBUG_BUNDLE_RESPONSE_ENABLED` (default: `true`)
- `SEARCH_DEBUG_BUNDLE_ALLOWLIST` (comma-separated; supports exact IP and prefix wildcard, e.g. `10.*,192.168.1.10`)

### Structured logging

`find_products_multi debug bundle` is logged in structured JSON:

- always when debug response is allowed
- otherwise by sampling

Sampling env:

- `SEARCH_DEBUG_BUNDLE_LOG_SAMPLE_RATE` (default: `0.01`)

## 2) `debug_bundle` schema

The bundle is emitted by `src/observability/debugBundle.js` with these top-level keys:

- `schema_version`, `build_sha`
- `req_id`, `ts`, `query`, `locale`
- `result_type`: `product_list|clarify|strict_empty`
- `reason_code`
- `latency_ms`: `total|nlu|lexical|vector|behavior|rank`
- `degrade`: `nlu_degraded|vector_skipped|behavior_skipped`
- `nlu`: intent/slots/confidence snapshot
- `rewrite`: expansion mode and rewrite tokens
- `recall`: stage counts and filter drops
- `post`: candidate/post-rank quality stats
- `top_items`: top items summary (`pid/domain/cat/source/final_score`)

Notes:

- If a field is not currently available from live path, value is `null` or `0` (reserved for future fill-in).
- `top_items` is intentionally minimal and does not include user PII.

## 3) Export snapshot reports

### Input format

Exporter reads JSONL logs and extracts bundle from:

- `record.debug_bundle`
- `record.data.debug_bundle`
- or top-level record if it already looks like a bundle

### Run command

```bash
node scripts/export_observability_snapshot.js \
  --input-jsonl /path/to/logs/app.jsonl \
  --windows 24h,7d \
  --sample 1 \
  --out-dir reports/observability_snapshot_latest \
  --casebook-top 50 \
  --k-min 6
```

Equivalent npm script:

```bash
npm run obs:snapshot:export -- \
  --input-jsonl /path/to/logs/app.jsonl \
  --windows 24h,7d \
  --out-dir reports/observability_snapshot_latest
```

### Output structure

For each window (`24h` / `7d`):

- `health.csv`
- `quality.csv`
- `casebook.json`
- `casebook.md`

Root:

- `manifest.json` (input + output index)

## 4) How to interpret reports

### Health (`health.csv`)

By `overall`, `intent`, `domain`, `result_type`, `degrade`:

- request count, p50/p95/p99 latency
- component p95 latency
- timeout/degrade rates
- `product_list_rate`, `clarify_rate`, `strict_empty_rate`
- `external_fill_rate`, `no_candidate_rate`

### Quality (`quality.csv`)

By same dimensions:

- `non_empty_rate`
- `domain_entropy_topk_avg/p95`
- `cross_domain_in_topk_rate`
- `lexical_anchor_ratio_topk`

### Casebook (`casebook.*`)

Three top-query sets:

1. strict-empty frequency
2. quality risk
3. degrade frequency

Each query includes representative `debug_bundle` samples and one-line debug summaries.

## 5) Files changed for this feature

- `src/observability/debugBundle.js`
- `src/server.js`
- `scripts/export_observability_snapshot.js`
- `docs/observability_snapshot.md`
- tests:
  - `tests/observability_debug_bundle.test.js`
  - `tests/export_observability_snapshot.test.js`
