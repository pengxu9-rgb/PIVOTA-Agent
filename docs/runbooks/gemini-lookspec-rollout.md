# Gemini LookSpec Rollout (staging/manual)

This runbook enables a controlled rollout of Gemini-based LookSpec extraction for:
- **Reference (target) image** → LookSpecV0
- **Selfie (user) image** → LookSpecV0 → `similarityReport.lookDiff.*` → Layer2 activity slots

Design goals:
- Default production behavior is unchanged (flags default OFF).
- CI/Jest never calls the network (tests mock Gemini modules).
- Fail-closed: if Gemini fails/missing key, the pipeline falls back or produces no `lookDiff`, so Layer2 macro slots do not emit.

## Flags (default OFF)

**Selfie path**
- `LAYER2_ENABLE_SELFIE_LOOKSPEC=1` (enables selfie lookSpec / lookDiff plumbing)
- `LAYER1_ENABLE_GEMINI_SELFIE_LOOKSPEC=1` (use Gemini for selfie lookSpec when selfie image is present)

**Reference path**
- `LAYER1_ENABLE_GEMINI_REFERENCE_LOOKSPEC=1` (use Gemini for reference lookSpec; fail-closed fallback to existing `extractLookSpec`)

**Layer2 selection**
- `LAYER2_ENABLE_TRIGGER_MATCHING=1`
- `LAYER2_ENABLE_EXTENDED_AREAS=1` (if you want extended areas surfaced)
- Slots (if desired):
  - `LAYER2_ENABLE_EYE_ACTIVITY_SLOT=1`
  - `LAYER2_ENABLE_BASE_ACTIVITY_SLOT=1`
  - `LAYER2_ENABLE_LIP_ACTIVITY_SLOT=1`

## Required env

- `GEMINI_API_KEY` (required for any real Gemini call)
- Optional:
  - `GEMINI_MODEL` (default: `gemini-2.5-flash`)
  - `GEMINI_TIMEOUT_MS` (default: `20000`)
  - `GEMINI_MAX_RETRIES` (default: `1`)
  - `GEMINI_RETRY_BASE_DELAY_MS` (default: `200`)

## Debug (default OFF)

- `LAYER1_SELFIE_DEBUG=1` or `GEMINI_DEBUG=1`
  - Enables a single-line summary in `telemetrySample.gemini` paths and minimal Gemini debug logs.

## Staging: real-image e2e

Use local images (paths on disk). This script is **manual-only** and not used by CI.

```bash
REFERENCE_IMAGE_PATH=/absolute/path/to/reference.jpg \
SELFIE_IMAGE_PATH=/absolute/path/to/selfie.jpg \
GEMINI_API_KEY=... \
npm run staging:gemini:e2e
```

The script prints:
- `lookDiffSource` (`telemetrySample.gemini.lookDiffSource`)
- `needsChange` summary by area
- `macroIds` extracted from final `result.techniqueRefs`
- warning counts and any “scary warnings” (missing cards, mismatches, language fallback, etc.)

## Observability (minimal)

`runLookReplicatePipeline(...)` attaches Gemini counters to `telemetrySample` (not `result`):

- `telemetrySample.gemini.reference.{okCount,failCount,lastErrorCode,latencyMs}`
- `telemetrySample.gemini.selfie.{okCount,failCount,lastErrorCode,latencyMs}`
- `telemetrySample.gemini.lookDiffSource`

These fields are for internal inspection only; they do not change the user-facing API response shape.

## Rollout plan (suggested)

1) Enable reference-only (safe fallback):
   - `LAYER1_ENABLE_GEMINI_REFERENCE_LOOKSPEC=1`
2) Enable selfie lookDiff generation (still safe; fail-closed):
   - `LAYER2_ENABLE_SELFIE_LOOKSPEC=1`
   - `LAYER1_ENABLE_GEMINI_SELFIE_LOOKSPEC=1`
3) Enable trigger-matching / slots gradually:
   - `LAYER2_ENABLE_TRIGGER_MATCHING=1`
   - `LAYER2_ENABLE_EYE_ACTIVITY_SLOT=1` then base/lip, then extended areas

## Rollback

Disable any of the above flags. No revert needed:
- Turn off Gemini: `LAYER1_ENABLE_GEMINI_REFERENCE_LOOKSPEC=0` and/or `LAYER1_ENABLE_GEMINI_SELFIE_LOOKSPEC=0`
- Turn off selfie diff: `LAYER2_ENABLE_SELFIE_LOOKSPEC=0`
- Turn off slot selection: `LAYER2_ENABLE_TRIGGER_MATCHING=0` and/or slot flags

