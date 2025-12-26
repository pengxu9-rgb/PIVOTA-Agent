# Layer 2/3 Contracts (US-first) — v0

This document defines the **wire contracts** for Layer 2/3 outputs consumed by `look-replicate-share`.
These are **US-only** (`market: "US"`).

No engines are implemented in this step; this is schema-only.

---

## Global requirements (all v0 schemas)

Every schema includes:

- `schemaVersion`: `"v0"`
- `market`: `"US"`
- `locale`: `"en" | "ja" | string` (non-empty string)
- Engine versions (deterministic constants):
  - `layer2EngineVersion`: `"l2-us-0.1.0"`
  - `layer3EngineVersion`: `"l3-us-0.1.0"`
  - `orchestratorVersion`: `"orchestrator-us-0.1.0"`

US-only enforcement:

- Any non-US market must be rejected at API boundaries (400/422).

---

## 1) `LookSpecV0`

File: `src/layer2/schemas/lookSpecV0.ts`

Purpose: structured interpretation of the reference look that downstream steps/kit can follow.

Shape (high-level):

- `lookTitle?`: string
- `styleTags`: string[]
- `breakdown`:
  - `base`: `{ intent, finish, coverage, keyNotes[], evidence[] }`
  - `eye`: `{ ... }`
  - `lip`: `{ ... }`
- `warnings?`: string[]

---

## 2) `StepPlanV0`

File: `src/layer2/schemas/stepPlanV0.ts`

Purpose: a single tutorial step item. The final result contains **8–12** steps total.

Fields:

- `stepId`: string
- `order`: number (0+)
- `impactArea`: `"base" | "eye" | "lip"`
- `title`: string
- `instruction`: string
- `tips`: string[]
- `cautions`: string[]
- `fitConditions`: string[]
- `evidence`: string[]

---

## 3) `ProductAttributesV0`

File: `src/layer3/schemas/productAttributesV0.ts`

Purpose: a product card for kit selection (best/dupe).

Fields:

- `skuId`: string
- `name`: string
- `brand`: string
- `price`: `{ currency, amount }`
- `imageUrl?`: url
- `productUrl?`: url
- `availability`: `"in_stock" | "out_of_stock" | "unknown"`
- `whyThis`: string
- `evidence`: string[]

---

## 4) `KitPlanV0`

File: `src/layer3/schemas/kitPlanV0.ts`

Purpose: kit plan grouped by impact area, providing a best + dupe option per area.

Fields:

- `kit`:
  - `base`: `{ best: ProductAttributesV0, dupe: ProductAttributesV0 }`
  - `eye`: `{ ... }`
  - `lip`: `{ ... }`
- `warnings?`: string[]

---

## 5) `LookReplicateResultV0` (Unified)

File: `src/schemas/lookReplicateResultV0.ts`

Purpose: the single result payload returned to frontend after processing.

Required fields:

- `breakdown`: `{ base, eye, lip }` (same shape as `LookSpecV0.breakdown`)
- `adjustments`: **EXACTLY 3 items**:
  - Must include exactly one per `impactArea` (`base`, `eye`, `lip`)
  - Item fields: `{ impactArea, title, because, do, why, evidence[], confidence }`
- `steps`: **8–12** `StepPlanV0` items
- `kit`: `KitPlanV0`
- `warnings?`: string[]
- `share?`: `{ shareId, canonicalUrl? }`

Invariants:

- No celebrity/identity strings or claims.
- Deterministic output for the same inputs (engines will be deterministic by default).

