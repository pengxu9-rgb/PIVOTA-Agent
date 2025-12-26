# Layer2 US Adjustments: Rules‑First + Facts‑Locked Rephrase

This document describes the **US-only** Layer2 adjustment system.

Goal:
- Produce **EXACTLY 3 adjustments**: one each for `base`, `eye`, `lip`.
- Use a deterministic rule engine to generate **AdjustmentSkeletonV0**.
- Use LLM only to **rephrase** the skeleton into user-facing text without adding facts.
- If LLM violates constraints, fall back to deterministic rendering.

## Inputs

- `userFaceProfile?: FaceProfileV0|null`
- `refFaceProfile: FaceProfileV0`
- `similarityReport?: SimilarityReportV0|null`
- `lookSpec: LookSpecV0`
- `preferenceMode: "structure"|"vibe"|"ease"`

Market constraint:
- Only `market === "US"` is supported.

## AdjustmentSkeletonV0

Schema: `src/layer2/schemas/adjustmentSkeletonV0.ts`

Each skeleton includes:
- `impactArea`: `base|eye|lip`
- `ruleId`: stable string identifier
- `severity`: `0..1`
- `confidence`: `high|medium|low`
- `becauseFacts[]`: factual statements derived from inputs
- `doActions[]`: atomic imperative actions (no brand mentions)
- `whyMechanism[]`: short causal explanations
- `evidenceKeys[]`: non-empty list of input keys used
- optional `safetyNotes[]`, `tags[]`

## Rule selection

Implementation:
- Rules list: `src/layer2/personalization/rules/usAdjustmentRules.ts`
- Runner: `src/layer2/personalization/rules/runAdjustmentRulesUS.ts`

Strategy:
- Evaluate rules per `impactArea`.
- If multiple match:
  - `preferenceMode === "ease"` → choose **lowest difficulty**
  - otherwise → choose **highest severity** (deterministic tie-break by `ruleId`)
- If none match → apply area fallback rule.

### PreferenceMode impact

- `ease`: prefers simpler, lower-effort variants (e.g., shorter liner, lighter steps).
- `structure|vibe`: chooses the most severe/impactful match.

## US rule catalog (minimum set)

### Eye rules

- `EYE_LINER_DIRECTION_ADAPT`
  - Trigger: significant `eyeTiltDeg` mismatch (user vs ref or similarity topDeltas severity).
  - Output: shorter wing, slightly more horizontal angle, controlled liner.
- `EYE_TIGHTLINE_AND_SMUDGE`
  - Trigger: low `eyeOpennessRatio` + reference intent suggests liner emphasis.
  - Output: tightline + smudge outer corner, keep liner thin.
- Fallback: `EYE_FALLBACK_SAFE_CONTROL`
  - Output: thin liner on outer third, short wing.

### Base rules

- `BASE_THIN_LAYERS_TARGET_GLOW`
  - Trigger: `lookSpec.breakdown.base.finish` contains `dewy|glow|radiant`.
  - Output: thin base + targeted glow, strategic setting.
- `BASE_BUILD_COVERAGE_SPOT`
  - Trigger: `lookSpec.breakdown.base.coverage` contains `full|high|medium-full`.
  - Output: build thin passes, spot conceal, strategic set.
- Fallback: `BASE_FALLBACK_THIN_LAYER`
  - Output: thin base layer, spot-correct.

### Lip rules

- `LIP_GLOSS_CENTER_GRADIENT`
  - Trigger: `lookSpec` finish is glossy; stronger match if user lip fullness is low.
  - Output: center-focused gloss, soft line, close shade family.
- `LIP_SOFT_EDGE_BLUR`
  - Trigger: lip intent suggests soft/diffused OR finish satin/matte.
  - Output: blur edges, stronger center, match finish.
- Fallback: `LIP_FALLBACK_FINISH_FOCUS`
  - Output: match finish, close shade family, blot to adjust intensity.

## Facts‑locked LLM rephrase

Implementation:
- Prompt: `src/layer2/prompts/adjustments_rephrase_en.txt`
- Code: `src/layer2/personalization/rephraseAdjustments.ts`

Inputs to LLM:
- ONLY the 3 skeletons (plus locale/market).

Output (JSON):
```json
{
  "adjustments": [
    {"impactArea":"base|eye|lip","ruleId":"...","title":"...","because":"...","do":"...","why":"...","confidence":"...","evidence":["..."]}
  ]
}
```

Hard constraints:
- Exactly 3, one per impact area.
- `evidence` must be a **subset** of skeleton `evidenceKeys` (and non-empty).
- `ruleId` must match skeleton.

### Validator + deterministic fallback

We reject LLM output if:
- Identity/celebrity language appears (e.g. “look like”, “celebrity”).
- New numeric claims appear that aren’t present in skeleton JSON.
- A conservative forbidden-traits list appears that wasn’t present in skeleton text.
- Evidence is empty or not a subset of `evidenceKeys`.

On rejection, we render deterministically from the skeleton (no LLM).
