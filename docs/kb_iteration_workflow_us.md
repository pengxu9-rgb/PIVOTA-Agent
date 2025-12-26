# KB Iteration Workflow (US)

This doc describes the US-only, derived-only workflow for improving the Layer2 Technique KB using real outcome signals from Look Replicate jobs.

## What we collect (derived-only)

Backend stores **one** `OutcomeSampleUS` record per `jobId` in Postgres (`outcome_samples_us`).

Signals are merged over time:
- Explicit rating (1–5): “How close did it match?”
- Optional issue tags: `base|eye|lip|other`
- Behavioral proxies:
  - `share`
  - `add_to_cart`
  - `checkout_start`
  - `checkout_success`
- Quality flags (derived by backend at job completion):
  - `lookSpecLowConfidence`
  - `anyAdjustmentLowConfidence`
  - `anyFallbackUsed`
- Technique + rule attribution (derived by backend at job completion):
  - `usedTechniques` (from `adjustments[].techniqueRefs`)
  - `usedRules` (from `adjustments[].ruleId`)
- Context fingerprint (bucketized, non-identifying):
  - face categorical buckets (faceShape/eyeType/lipType)
  - a few LookSpec buckets (baseFinish/lipFinish + vibe tags)

## Privacy + opt-in policy

- We do **not** store raw images.
- `sessionId` (if provided) is **never** stored as raw.
- By default we store **no** session identifier.
  - If you want to store a session hash, either:
    - set `TELEMETRY_STORE_SESSION_HASH=true`, or
    - send `payload.optIn=true` and configure `TELEMETRY_SESSION_SALT`.

## API: ingest outcome events

`POST /api/telemetry/outcome`

Body schema: `src/telemetry/schemas/outcomeEventV0.ts`

Examples:

```json
{
  "schemaVersion": "v0",
  "market": "US",
  "jobId": "00000000-0000-0000-0000-000000000001",
  "eventType": "rating",
  "payload": { "rating": 5 },
  "createdAt": "2025-12-26T00:00:00.000Z"
}
```

```json
{
  "schemaVersion": "v0",
  "market": "US",
  "jobId": "00000000-0000-0000-0000-000000000001",
  "eventType": "issue_tags",
  "payload": { "issueTags": ["eye"] },
  "createdAt": "2025-12-26T00:00:10.000Z"
}
```

## Analyzer

Run:

```bash
npm run kb:analyze:us
```

Outputs:
- `artifacts/kb/us/kb_health_summary.json`
- `artifacts/kb/us/kb_health_report.md`
- `artifacts/kb/us/kb_gap_candidates.jsonl`

Fixture mode (no DB required):

```bash
npm run kb:analyze:us -- --fixture=tests/fixtures/kb/us/outcome_samples.jsonl
```

## Replay harness (no LLM)

Replay uses derived-only `replayContext.adjustmentSkeletons` stored in the sample to re-run **KB rendering** against the latest KB.

Purpose:
- detect if KB updates would remove “missing technique card” fallbacks
- compare techniqueRefs that would be used after KB update

## Weekly cadence (recommended)

1) Run analyzer (last 7d / last 30d)
2) Identify top gap candidates (by `priority`)
3) Inspect dominant rules + techniques for each cluster
4) Add or refine TechniqueCard(s) (US KB)
5) Re-run analyzer and replay to validate the KB change reduces fallback usage

