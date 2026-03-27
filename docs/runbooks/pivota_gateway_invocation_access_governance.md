# Pivota Gateway Invocation And Access Governance

## Purpose
- Keep `protocol / invocation surface` separate from `source` and `layer`.
- Keep protocol metadata and access governance state out of `ShoppingContext`.
- Enforce agent access control and query governance before layer dispatch.

## Gateway Contract
- `InvocationSurface`: `acp | ucp | ap2 | direct_api | mcp`
- `InvocationProfile`: protocol family, transport, auth, continuation, response mode, capability negotiation
- `InvocationContext`: normalized protocol envelope for gateway-only lifecycle
- `AgentIdentity`: caller identity and trust tier
- `AccessScope`: allowed layer/source, result depth, pagination, variant expansion, checkout ability
- `RateLimitProfile`: rpm, burst, concurrency, daily caps
- `QueryGovernancePolicy`: sweep/fan-out/pagination/result-depth governance

## Hard Rules
- Protocol adapters live only under `src/api/gateway/adapters`.
- Access governance executes before `layerDispatcher` calls a business facade.
- `ShoppingContext` remains business-only and rejects invocation/access metadata.
- `protocol != source`
- `protocol != layer`
- `execution_facing` is a resolution surface, not an export API.

## Default Governance
- Internal callers keep the broadest access, but remain audited.
- Generic MCP and public API agents default to bounded or summary-only access.
- Bulk discovery, merchant sweep, deep pagination, and checkout handoff are denied unless explicitly allowlisted.
- Result depth can be downgraded even when a request is otherwise allowed.

## Current Implementation Notes
- `layerDispatcher` now builds a gateway governance envelope before business dispatch.
- Blocked decisions return early with provenance instead of invoking business handlers.
- Allowed responses are shaped by `responseMapper` to enforce bounded results and governance metadata.
- The readiness report can optionally ingest sampled runtime shadow events via `GATEWAY_GOVERNANCE_SHADOW_SAMPLE_PATH` or `--runtime-sample`.
- Raw gateway logs can be converted into a bounded runtime sample with `node scripts/extract_gateway_governance_shadow_sample.js --input /path/to/gateway.log --out /tmp/gateway_governance_shadow.ndjson`.
- The readiness audit can do that extraction inline when `GATEWAY_GOVERNANCE_LOG_INPUT_PATH` is set.
- Daily governance summary entrypoint: `npm run audit:gateway-governance:daily`
- Default alert thresholds live in `scripts/fixtures/celestial_commerce_gateway_governance_alert_thresholds.json` and only flag anomalies instead of requiring raw-log review.
- UCP / AP2 remain protocol-family stubs with extensible adapters; no fake final spec is assumed.
