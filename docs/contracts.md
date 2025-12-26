# Contracts (US)

This repo publishes versioned, machine-readable contract artifacts for Layer 1 and Layer 2/3 (US-only) so other repos (e.g. frontend) can validate payloads and responses without importing backend code.

## What gets published

- JSON Schemas:
  - `contracts/us/faceProfileV0.schema.json`
  - `contracts/us/similarityReportV0.schema.json`
  - `contracts/us/layer1BundleV0.schema.json`
  - `contracts/us/lookSpecV0.schema.json`
  - `contracts/us/stepPlanV0.schema.json`
  - `contracts/us/kitPlanV0.schema.json`
  - `contracts/us/lookReplicateResultV0.schema.json`
- Canonical fixtures (golden samples for CI):
  - `fixtures/contracts/us/faceProfileV0.sample.json`
  - `fixtures/contracts/us/compatibility.request.sample.json`
  - `fixtures/contracts/us/similarityReportV0.sample.json`
  - `fixtures/contracts/us/layer1BundleV0.sample.json`
  - `fixtures/contracts/us/lookSpecV0.sample.json`
  - `fixtures/contracts/us/kitPlanV0.sample.json`
  - `fixtures/contracts/us/lookResultV0.sample.json`
- Deterministic manifest (integrity + completeness):
  - `contracts/us/manifest.json` (sha256 for every contract file)

## How to update

Run:

- `npm run contract:export`
- `npm run contract:export:l2l3` (Layer2/3 only)

This regenerates schemas, fixtures, and the manifest deterministically (stable formatting and key ordering) and overwrites the files in-place.

## Smoke checks

- `npm run contract:test`
- `npm run eval:layer2_3:us` (fast contract/invariants smoke)

## Manifest

`contracts/us/manifest.json` is intended for cross-repo sync verification (e.g. frontend can copy `contracts/` + `fixtures/` and then verify sha256s).

- `generatedAt` is intentionally fixed to keep diffs stable.
- `refHint` is best-effort:
  - If `git` is available at export time, it records the current commit SHA.
  - Otherwise it is `"unknown"`.
- `files[]` lists repo-relative paths and sha256 over file bytes (the manifest does not include itself).

## Versioning policy

- `schemaVersion`:
  - Bumped when the wire schema changes (fields added/removed/renamed or semantics changed).
- `engineVersion`:
  - Bumped when engine behavior changes (weights, thresholds, rules, scoring, copy).
  - Current version is defined in `src/layer1/compatibility/us/config/version.js`.
