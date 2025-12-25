# Contracts (US)

This repo publishes versioned, machine-readable contract artifacts for Layer 1 (US-only) so other repos (e.g. frontend) can validate payloads and responses without importing backend code.

## What gets published

- JSON Schemas:
  - `contracts/us/faceProfileV0.schema.json`
  - `contracts/us/similarityReportV0.schema.json`
- Canonical fixtures (golden samples for CI):
  - `fixtures/contracts/us/faceProfileV0.sample.json`
  - `fixtures/contracts/us/compatibility.request.sample.json`
  - `fixtures/contracts/us/similarityReportV0.sample.json`

## How to update

Run:

- `npm run contract:export`

This regenerates schemas and fixtures deterministically (stable formatting and key ordering) and overwrites the files in-place.

## Versioning policy

- `schemaVersion`:
  - Bumped when the wire schema changes (fields added/removed/renamed or semantics changed).
- `engineVersion`:
  - Bumped when engine behavior changes (weights, thresholds, rules, scoring, copy).
  - Current version is defined in `src/layer1/compatibility/us/config/version.js`.

