# Search Architecture Cleanup

Date: 2026-04-07

## Goal

Collapse the current search stack into a small number of explicit lanes.

The current system mixes:

- product distinctions
- source-specific policy
- rollout guards
- recovery/supplement behavior
- legacy compatibility

That mixture is now causing wrong-path routing, hidden ownership changes, and timeout amplification.

## Current Live Surfaces

- `/v1/chat`
- `/agent/v1/products/search`
- `/api/gateway`
- `/v1/reco/generate`

## Current Active Route Families

### 1. Chat entry

- `shouldDelegateV1ChatToV2`
- `beautyChatMainlineEntry`
- `legacyChatRecoRouteEntry`
- `directRecoGenerateHandler`

Problem:
Beauty-owned chat can still be shaped by chat-level routing decisions before retrieval ownership is fixed.

### 2. Direct search entry

- `handleAgentProductsSearchViaInvoke`
- `prepareAgentProductsSearchRoute`
- `maybeHandleAgentProductsSearchRouteFastpaths`
- `resolveLegacyBeautyCacheOwnerBypass`

Problem:
The same discovery request can be pushed onto different upstream paths by source/flag booleans rather than by a stable search contract.

### 3. Primary retrieval paths

- `strictBeautyDirectSearch -> {PIVOTA_API_BASE}/agent/v1/products/search`
- `useStableCrossMerchantAgentSearch -> {searchInvokeBase}/agent/v1/products/search`
- default invoke search -> `{route.path}` which resolves to `/agent/v2/products/search`
- strict commerce invoke -> `/agent/shop/v1/invoke`

Problem:
These are currently separate path families, not one retrieval lane with clear mode selection.

### 4. Supplement and recovery paths

- resolver-first
- semantic-owner query pack retries
- secondary retry
- second-stage expansion
- exact-title external-seed rescue
- external-seed supplement
- cache replacement / cache override

Problem:
Several of these no longer behave like supplements. They can effectively change ownership or hide the real primary failure stage.

### 5. Legacy compatibility

- `legacyChatReco*`
- `legacyReco*`
- `directRecoGenerateHandler`

Problem:
This is a valid compatibility boundary, but it must stay outside beauty-owned mainline execution.

## Observed Failure Pattern

Broad and narrow beauty discovery requests are currently failing in the same place:

- `oil control sunscreen`
- `niacinamide oil control serum`
- `lightweight moisturizer oily skin`
- broad oily beauty discovery

Observed behavior:

- primary retrieval fails before meaningful selection work
- search falls into `invoke_primary_unusable`
- timeout retry inflates wall-clock latency and hides the original budget
- later semantic/support queries often never get a fair chance to run

This indicates a primary retrieval path failure, not a fallback packaging problem.

## Target Architecture

Only four lanes should remain.

### Lane A: Resolver

Purpose:
Exact lookup, entity resolve, stable alias, title/product anchors.

Rules:

- only for anchored queries
- returns resolved target or fail-closed
- does not own broad discovery

### Lane B: Discovery Mainline

Purpose:
Beauty/direct/chat/gateway shared discovery path.

Required flow:

`planner -> semantic contract -> primary retrieval -> deterministic selection -> response authority`

Rules:

- planner may be LLM or deterministic
- planner only emits structured contract
- planner does not choose a separate retrieval chain
- source affects policy, not ownership

### Lane C: Supplement

Purpose:
Coverage repair and secondary enrichment only.

Allowed modules:

- external-seed supplement
- coverage supplement
- exact-title rescue

Rules:

- may not change primary owner
- may not hide primary failure stage
- may only run after primary retrieval result is known

### Lane D: Legacy Quarantine

Purpose:
Compatibility only.

Allowed scope:

- non-beauty legacy reco compatibility
- `/v1/reco/generate`

Rules:

- beauty-owned requests must never enter this lane
- compatibility code must not influence discovery-mainline ownership

## Keep / Migrate / Delete

### Keep

- `beautyChatMainlineEntry`
- semantic contract and authority modules
- `findProductsInvokeSemanticOwner*`
- `findProductsSearch*`
- response authority / normalization modules

These should become the shared Discovery Mainline.

### Migrate

- resolver-first
- external-seed supplement
- exact-title rescue
- cache replacement rules

These should move under explicit Supplement or Resolver ownership.

### Quarantine

- `legacyChatReco*`
- `legacyReco*`
- `directRecoGenerateHandler`

These remain only for compatibility until their public surfaces are retired.

### Delete

Delete edges, not only files.

First class deletions:

- source-specific hidden ownership switches
- source/flag-based alternate primary retrieval chains
- beauty-owned handoff from mainline into legacy compatibility
- timeout retry amplification on the same dead discovery query

## Module Mapping

This is the working map for cleanup. The mapping is intentionally lane-based:
files stay if they still provide the lane responsibility, and edges are deleted
when they let a lower-priority lane take ownership.

### Resolver Lane

Keep, but constrain to anchored lookup only:

- `findProductsSearchSemantics`
- `findProductsIngredientIntentDirect*`
- exact-title resolver helpers
- brand/entity detection helpers

Allowed responsibilities:

- exact lookup
- alias/title resolution
- ingredient-intent direct lookup
- fail-closed resolver response

Not allowed:

- broad discovery ownership
- post-exception owner switching
- silently replacing a failed discovery owner

### Discovery Mainline Lane

Keep as the shared beauty discovery owner:

- `beautyChatMainlineEntry`
- `beautyChatMainlineEnvelope`
- `beautySearchAuthority`
- `beautySearchContractAuthority`
- `beautySearchSourceAuthority`
- `findProductsSearchRouteEntry`
- `findProductsSearchContracts`
- `findProductsInvoke*`
- `findProductsResponseNormalization`
- `strictFindProductsResponseNormalization`
- `findProductsSearchTelemetry`

Allowed responsibilities:

- chat/direct/gateway ownership resolution
- LLM chat planner contract
- deterministic semantic contract execution
- primary retrieval lane selection
- deterministic selection authority
- response envelope and metadata authority

Not allowed:

- source-based primary owner switching
- fallback owner switching
- legacy route handoff for beauty-owned requests
- direct/gateway natural-language reply generation

### Supplement Lane

Migrate under explicit supplement ownership:

- external-seed supplement
- external coverage supplement
- framework support supplement
- exact-title external-seed rescue
- external rescue after pure-cache invalid hit
- second-stage expansion

Allowed responsibilities:

- coverage repair after the primary retrieval result is known
- support-role recall
- other-options enrichment
- traceable exact-title rescue when contract permits resolver behavior

Not allowed:

- changing `primary_lane`
- hiding `primary_failure_stage`
- filling primary slots with bundle-like or cross-role-only evidence
- retrying the same dead primary query until wall-clock latency is inflated

### Legacy Quarantine Lane

Keep for compatibility only:

- `legacyChatReco*`
- `legacyReco*`
- `directRecoGenerateHandler`
- `/v1/reco/generate`

Allowed responsibilities:

- non-beauty legacy chat recommendation compatibility
- direct legacy reco generation API

Not allowed:

- handling beauty-owned `/v1/chat`
- contributing semantic contracts to beauty discovery
- affecting primary retrieval lane selection
- affecting beauty selection/ranking authority

## First Implementation Slice

The first code slice introduces explicit internal contracts without removing public surfaces.

New contract objects:

- `ChatIntentContract`
- `SearchRequestContract`
- `SearchExecutionPlan`
- `SearchExecutionTrace`

The first slice wires these into:

- `/v1/chat` ownership before v2 delegation
- `/agent/v1/products/search` direct route metadata
- `find_products_multi` primary lane resolution
- beauty search response metadata and search stage ledger

The first slice also changes failure behavior:

- beauty discovery disables same-primary timeout retry amplification
- primary exceptions expose `primary_failure_stage`
- hidden resolver/invoke fallback is disabled for locked beauty mainline
- `owner_switch_count` is expected to stay `0`

Still deferred:

- moving all supplement implementations into a dedicated directory
- deleting legacy compatibility files
- deleting old source-profile helper branches after traffic proves stable
- enabling LLM direct/gateway rerank authority

## First Cleanup Slice

The first cleanup slice should not change public contracts.

It should do exactly this:

1. Make beauty discovery choose one primary retrieval lane.
2. Make source affect policy only.
3. Keep supplement paths supplemental only.
4. Keep legacy compatibility completely outside beauty-owned execution.
5. Expose initial timeout, retry count, and actual failing stage in metadata.

## Exit Criteria

The architecture cleanup is not done until all are true:

- one beauty discovery query always maps to one retrieval lane
- source no longer silently changes primary ownership
- supplements cannot become primary owners
- legacy compatibility never handles beauty-owned search
- route metadata shows the true failing stage without retry amplification hiding it
