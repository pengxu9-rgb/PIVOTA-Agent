# Layer 2/3 Architecture (US-only) — Design Doc (No Implementation)

This document captures **repo recon** + a **proposed production architecture** for:

- **Layer 2**: `LookSpecV0` + `StepsV0`
- **Layer 3**: `KitV0` + `DupeV0`

Scope: **design only**. No feature work is implemented in this step.

---

## 0) Repo Recon (Current State)

### Server framework

- **Express** server in `src/server.js`.
- Entrypoint in `package.json` (`main`: `src/server.js`, scripts `start`, `dev`).

### Current “Look Replicator” endpoints (jobs / share / uploads)

Mounted by `mountLookReplicatorRoutes(app, ...)` in `src/server.js`.

- `POST /uploads/signed-url`
  - Returns S3-compatible PUT signed URL + public URL.
  - Auth: optional `LOOK_REPLICATOR_API_KEY` (Bearer or `X-API-Key`).
  - Implementation: `src/lookReplicator/storage.js`
- `POST /look-jobs`
  - Creates a job and returns `{ jobId }`.
  - Current behavior: schedules **mock progress** and writes a **mock result** on completion.
  - Implementation: `src/lookReplicator/index.js`, `src/lookReplicator/store.js`, `src/lookReplicator/mockResult.js`
- `GET /look-jobs/:jobId`
  - Poll job status + result snapshot.
- `GET /shares/:shareId`
  - Fetches a share view (currently shareId == jobId).

### Current Layer 1 endpoints (US-only)

Mounted by `mountLayer1CompatibilityRoutes` and `mountLayer1BundleRoutes` in `src/server.js`.

- `POST /api/layer1/compatibility`
  - Input: derived `FaceProfileV0` only (no images).
  - Output: `SimilarityReportV0` (deterministic).
  - Server safety net: builds `Layer1BundleV0` and runs `evaluateLayer1Gate` (hard reject returns 422).
  - Code: `src/layer1/routes/layer1Compatibility.js`
- `POST /api/layer1/bundle/validate`
  - Input: `{ bundle: Layer1BundleV0 }`, output: `{ gate, reasons }`
  - Code: `src/layer1/routes/layer1BundleValidate.js`

### Catalog / recommendation / commerce endpoints

- `POST /agent/shop/v1/invoke`
  - Gateway-style operation router (find, quote, order, payment, etc).
  - Code: `src/server.js`, request schema in `src/schema.js`
- `POST /recommend`
  - Recommendation endpoint (uses `src/recommend/*`)
- Creator category APIs:
  - `GET /creator/:creatorId/categories`
  - `GET /creator/:creatorId/categories/:categorySlug/products`
- Promotions admin APIs under `/api/merchant/promotions*` (admin-key guarded)

### Database layer

- Uses **node-postgres** (`pg`) via a shared pool: `src/db/index.js`
- Migrations: raw `.sql` files in `src/db/migrations/*`, run via `src/db/migrate.js` and CLI `src/db/cli.js`.
- Relevant tables already present:
  - `look_replicator_jobs` (stores job state + image URLs + `result_json`)
  - `layer1_face_profile_samples_us`, `layer1_similarity_report_samples_us`, `layer1_bundle_samples_us`
  - taxonomy + products cache embedding tables

### Storage layer (images)

- Uses **S3-compatible** storage via AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`):
  - Signed PUT URL generation in `src/lookReplicator/storage.js`
  - Env: `LOOK_REPLICATOR_S3_*` and `LOOK_REPLICATOR_PUBLIC_ASSET_BASE_URL`

### Logging / telemetry

- JSON logging via **pino** in `src/logger.js`
- Global request logging middleware in `src/server.js` logs `{ method, path, status, duration_ms }`
- Recommendation session state optionally uses Redis (`REDIS_URL` / `REDIS_HOST`) in `src/recommend/session.js`.

---

## 1) Target Product Flow (US-only)

### End-to-end UX flow (existing shape)

1) Frontend uploads:
   - Reference image (required)
   - Selfie image (optional)
2) Create job
3) Poll until completed
4) Show result
5) Share result

### Proposed Layer 2/3 pipeline integration

At job completion, the backend should return a single **result bundle** containing:

- Layer 1: `Layer1BundleV0` (derived only, no images)
- Layer 2: `LookSpecV0` + `StepsV0`
- Layer 3: `KitV0` + `DupeV0` (or `KitV0` with best/dupe slots)

---

## 2) Proposed Architecture (Production-grade)

### Core decision: async job processing

Current implementation uses `setTimeout` to simulate progress and writes a mock result.

For production we should move to:

- **Job record** persisted immediately (already exists: `look_replicator_jobs`)
- **Async worker** (separate process) or a background queue:
  - Option A: Postgres-backed queue (simple, fewer deps)
  - Option B: Redis queue (BullMQ) if Redis is guaranteed in prod
  - Option C: Railway worker service + polling

The API server becomes a thin controller:

- Create job → enqueue work → return `jobId`
- Poll job → read DB → return status/result

### Layer 2: LookSpec + Steps

**Inputs**

- `market: "US"`
- `referenceImageAsset`: S3 key / signed GET URL (short-lived)
- `Layer1BundleV0` (if available): derived user/ref face profiles + similarity report
- Optional user preferences (e.g. finish preference) as structured fields

**Outputs**

- `LookSpecV0`:
  - A structured representation of the reference look (no identity claims).
  - Example fields (to be finalized in schema): `finish`, `coverage`, `colorStory`, `emphasisAreas`, `linerDirection`, etc.
- `StepsV0`:
  - A deterministic tutorial plan, **exactly 3 sections** (base/eye/lip), each broken into **3 steps** plus cautions/fit conditions.
  - Personalized using Layer 1 adjustments (when available).

### Layer 3: Kit + Dupe

**Inputs**

- `LookSpecV0`
- `StepsV0`
- Optional constraints:
  - budget caps
  - brand exclusions
  - availability constraints

**Outputs**

- `KitV0`: recommended SKUs grouped by impact area (base/eye/lip)
  - Each slot includes:
    - `best` (best match)
    - `dupe` (lower-cost alternative)
    - evidence/why (deterministic)
- `DupeV0` may be folded into `KitV0` (recommended for simpler contracts).

**Catalog integration**

Layer 3 should reuse existing catalog/search infrastructure:

- `products_cache` (+ embedding recall) where available
- Promotions enrichment (`promotionStore`)
- Existing operation gateway (`/agent/shop/v1/invoke`) when needed for live price/availability

---

## 3) Data Contracts (Frontend-facing)

These are *proposed* new schemas to be added under `src/layer2/schemas/*` and `src/layer3/schemas/*`,
and included in job result payloads.

### Job contracts (server API)

Recommended new contracts (versioned):

- `LookJobCreateRequestV1` (US-only)
  - `market: "US"`
  - `locale`
  - `referenceImage`: `{ assetKey }` (preferred) or `referenceImageUrl` (legacy)
  - `selfieImage`: optional
  - `layer1Bundle`: optional (derived only)
  - `preferenceMode`: `"structure"|"vibe"|"ease"`
  - `optInTraining?`, `sessionId?`

- `LookJobStatusResponseV1`
  - `jobId`, `status`, `progress`, `createdAt`, `updatedAt`
  - `result?` (only present when completed)
  - `warnings?`, `error?`

- `LookShareResponseV1`
  - `shareId`, `jobId`, `createdAt`, `expiresAt?`
  - `result`

### Result contracts (layer outputs)

- `Layer1BundleV0` (already exists)
- `LookSpecV0` (new; US-only)
- `StepsV0` (new; US-only)
- `KitV0` (new; US-only)

**Important invariant**: outputs must contain **no celebrity/identity claims** and avoid any protected-attribute inference.

---

## 4) US Isolation Strategy

Hard requirements for Layer 2/3:

- Reject any non-US market inputs at the API boundary (`market !== "US"` → 400/422).
- Keep datasets partition-ready for JP later:
  - Prefer **separate tables** per market for derived outputs:
    - `layer2_look_spec_samples_us`, `layer2_steps_samples_us`, `layer3_kit_samples_us`
  - Or keep a `market` column with strict `CHECK (market = 'US')` and index partition strategy.
- Storage isolation:
  - Use S3 keys prefixed with `look-replicator/us/...` (or `market=US/` prefix) for short-lived assets.

---

## 5) Privacy Strategy

### Images

Goal: keep images **short-lived**.

- Store only **object keys** in DB (not public URLs) where possible.
- Serve via:
  - signed GET URLs generated on demand, or
  - private bucket + CDN with strict TTL.
- Add a retention policy (bucket lifecycle rule) to expire raw images (e.g. 7–30 days).

### Derived artifacts

Store derived outputs long-lived:

- `Layer1BundleV0`
- `LookSpecV0`, `StepsV0`
- `KitV0` / kit selection evidence

### Training opt-in

Only store training samples when `optInTraining=true` and `sessionId` is present:

- Store derived JSON only.
- Do not store raw images or image URLs in training tables.

---

## 6) TODO File/Module List (Next Implementation Step)

No implementation in this step; this is the proposed minimal file list.

### Schemas

- `src/layer2/schemas/lookSpecV0.js`
- `src/layer2/schemas/stepsV0.js`
- `src/layer3/schemas/kitV0.js`
- `src/lookReplicator/schemasV1.js` (or version existing `schemas.js` to US-only V1)

### Engines

- `src/layer2/us/runLookSpecEngineUS.js` (deterministic; no LLM by default unless explicitly approved later)
- `src/layer2/us/runStepsEngineUS.js`
- `src/layer3/us/runKitEngineUS.js`

### Routes

- `src/layer2/routes/layer2LookSpec.js` (optional direct call)
- `src/layer3/routes/layer3Kit.js` (optional direct call)
- Extend job flow:
  - `src/lookReplicator/index.js` (accept `market: "US"` only, include Layer1 bundle in job create, return new result shapes)

### Storage + migrations

- `src/layer2/storage/*US.js` + migration `007_layer2_us.sql`
- `src/layer3/storage/*US.js` + migration `008_layer3_us.sql`
- Consider adding object-key storage fields to `look_replicator_jobs` (migration) to avoid storing public URLs.

### Worker / queue (one option)

- `src/workers/lookReplicatorWorker.js`
- `src/queue/*` (minimal queue abstraction)

### CI / contracts / eval

- `contracts/us/*` additions for new schemas
- `fixtures/contracts/us/*` golden fixtures
- Extend `scripts/export-contracts-us.js` to include new schemas + fixtures + manifest entries
- `tests/layer2/*`, `tests/layer3/*` invariant tests

---

## 7) Open Questions (To Resolve Before Coding)

1) Should Layer 2/3 be strictly deterministic rules (preferred) or allow LLM assistance behind a flag?
2) Which queue model is acceptable on Railway (Postgres polling vs Redis/BullMQ vs worker service)?
3) What is the intended retention window for uploaded images and share pages?
4) Do we keep `look_replicator_jobs` multi-market, or split to `look_replicator_jobs_us` now?

