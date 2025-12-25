# Layer 1 Freeze Line (Backend, US)

This document defines the backend “freeze line” for Layer1 so downstream layers (Layer2/3) can rely on a stable, derived-only input.

## Scope

- Market: **US only** (`market: "US"`). Non-US inputs are rejected by schema validation.
- Privacy: Layer1 endpoints accept **derived artifacts only** (FaceProfileV0 + SimilarityReportV0). No raw images.
- Determinism: SimilarityReportV0 always contains **exactly 3 reasons** and **exactly 3 adjustments**.
- Safety net: backend enforces a gate policy to prevent low-quality reference photos from entering downstream personalization.

## Layer1BundleV0

Schema: `src/layer1/schemas/layer1BundleV0.js`

Fields:
- `schemaVersion`: `"v0"`
- `market`: `"US"`
- `locale`: `string`
- `preferenceMode`: `"structure" | "vibe" | "ease"`
- `createdAt`: ISO datetime string
- `userFaceProfile`: `FaceProfileV0 | null` (optional; selfie may be missing)
- `refFaceProfile`: `FaceProfileV0`
- `similarityReport`: `SimilarityReportV0`

Invariants:
- `market === "US"`
- `preferenceMode === similarityReport.preferenceMode`
- `similarityReport.reasons.length === 3`
- `similarityReport.adjustments.length === 3`

## Gate Policy (US)

Policy: `src/layer1/policy/usGatePolicy.js`
Thresholds: `src/layer1/policy/usGateThresholds.js`

Outputs:
- `gate: "hard_reject" | "soft_degrade" | "ok"`
- `reasons: string[]`

Hard reject (block downstream):
- Reference FaceProfile quality invalid (`refFaceProfile.quality.valid === false`)
- Reference face border cutoff
- Lighting/sharpness below hard thresholds
- Explicit hard reject reasons in `refFaceProfile.quality.rejectReasons`

Soft degrade (warn but allow):
- Selfie missing
- Selfie borderline pose/occlusion
- SimilarityReport low confidence or warnings present

## Endpoints

### POST `/api/layer1/compatibility`

Input:
- derived FaceProfileV0(s) only
- returns SimilarityReportV0

Safety net:
- Builds a Layer1BundleV0 internally and returns **HTTP 422** with `{ error: "LAYER1_HARD_REJECT" }` if the gate policy hard-rejects the reference photo.

Opt-in storage:
- Only when `optInTraining=true` and `sessionId` is provided.
- Stores derived-only artifacts (FaceProfile samples, SimilarityReport sample, Layer1Bundle sample).

### POST `/api/layer1/bundle/validate`

Input:
- `{ bundle: Layer1BundleV0 }`

Output:
- `{ gate, reasons }`

## Storage (Opt-in Only, US Isolation)

Existing tables:
- `layer1_face_profile_samples_us`
- `layer1_similarity_report_samples_us`

Added table:
- `layer1_bundle_samples_us` (migration `src/db/migrations/006_layer1_bundle_us.sql`)

No raw images are stored; only JSONB derived artifacts.

## CI Gates

Scripts:
- `npm run contract:test` validates fixtures with Zod schemas.
- `npm run eval:layer1:us` runs the US eval harness and enforces invariants/thresholds.
- `npm run ci:layer1` runs: tests + contract:test + eval.

