# Layer 1 Eval Harness (US)

This repo includes an offline eval harness for the US CompatibilityEngine.

It is intended to run in CI and fail fast if any invariants are violated.

## Run

```bash
npm run eval:layer1:us
```

## Dataset format

File:

- `data/eval/us/layer1_samples.jsonl`

Each line is one JSON object (no images, derived-only):

```json
{
  "id": "s01",
  "market": "US",
  "locale": "en",
  "preferenceMode": "structure",
  "userFaceProfile": null,
  "refFaceProfile": { "version": "v0", "market": "US", "source": "reference", "locale": "en", "...": "..." },
  "labels": {}
}
```

## Outputs

The harness writes:

- `artifacts/eval/layer1_us_summary.json`
- `artifacts/eval/layer1_us_summary.md`
- `artifacts/eval/layer1_us_rows.json`

## Invariants (hard fails)

For every sample:

- report market must be `US`
- exactly 3 reasons
- exactly 3 adjustments, covering `base`, `eye`, `lip`
- no identity/celebrity language (checked by regex allowlist)
- deterministic output (same input twice -> identical output)

Implementation:

- `src/eval/layer1/us/runEval.js`

