# Layer 1 / Sub-engine 2: CompatibilityEngine (US)

This backend (`PIVOTA-Agent`) exposes a **US-only**, deterministic CompatibilityEngine that compares:

- `refFaceProfile` (required; derived FaceProfileV0 from the reference image)
- `userFaceProfile` (optional; derived FaceProfileV0 from the selfie)

It produces `SimilarityReportV0`:

- **Exactly 3 reasons**
- **Exactly 3 adjustments** (one each for `base`, `eye`, `lip`)
- No identity claims and no celebrity/KOL language
- Derived-only inputs/outputs (no raw images)

## Endpoint contract

`POST /api/layer1/compatibility`

Request JSON:

```json
{
  "market": "US",
  "locale": "en",
  "preferenceMode": "structure",
  "userFaceProfile": null,
  "refFaceProfile": { "version": "v0", "market": "US", "source": "reference", "locale": "en", "...": "..." },
  "optInTraining": false,
  "sessionId": "optional-anonymous-session-id"
}
```

Notes:

- `userFaceProfile` may be `null` (selfie skipped).
- If `optInTraining=true`, `sessionId` is required.

Response JSON:

- `SimilarityReportV0`

## Schemas

- `src/layer1/schemas/faceProfileV0.js`
- `src/layer1/schemas/similarityReportV0.js`

## Scoring model (deterministic)

The engine produces:

- `geometryFit` in `0..60`
- `riskPenalty` in `0..25`
- `adaptabilityBonus` in `0..15`

Final:

- `fitScore = clamp(geometryFit - riskPenalty + adaptabilityBonus, 0..100)`

Preference modes adjust weights deterministically:

- `structure`: heavier geometry penalties
- `vibe`: more adaptability emphasis
- `ease`: higher risk penalties + prefers easy adjustments

## Adjustments and reasons

Rules generate candidates from deltas and pick the best per impact area. If signals are weak, safe fallbacks are used.

Implementation:

- `src/layer1/compatibility/us/runCompatibilityEngineUS.js`
- `src/layer1/compatibility/us/computeDeltas.js`
- `src/layer1/compatibility/us/scoreFit.js`
- `src/layer1/compatibility/us/usRules.js`
- `src/layer1/compatibility/us/selectAdjustments.js`
- `src/layer1/compatibility/us/buildReasons.js`

## Derived-only storage (opt-in)

If `optInTraining=true`, the backend stores derived artifacts only:

- FaceProfile samples: `layer1_face_profile_samples_us`
- SimilarityReport samples: `layer1_similarity_report_samples_us`

Migration:

- `src/db/migrations/005_layer1_compatibility_us.sql`

