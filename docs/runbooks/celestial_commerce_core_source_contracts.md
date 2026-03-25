# Celestial Commerce Core Source Contract Matrix

This document defines ingress source profiles for the Celestial commerce core.

`source` is not the main architecture layer.
`source` only defines caller origin and default entry policy.
`layer` defines capability ownership.

Pair this document with [Celestial Commerce Core Actual Architecture](./celestial_commerce_core_actual_architecture.md).

For the current implementation shape, see [Celestial Commerce Core Actual Architecture](./celestial_commerce_core_actual_architecture.md).

## Layer Map

### Orchestration

- Aurora Beauty owns shopping orchestration.
- It handles ambiguous user goals, clarification, skincare/category guidance, and cross-layer delegation.

### Decisioning

- Shopping Agent owns discovery and decisioning.
- It handles retrieval planning, decisioning constraints, ranking, compare, shortlist, narrowing, and confidence.

### Execution-facing

- Execution-facing owns commerce resolution.
- It handles exact and near-exact product resolution, merchant resolution, offer resolution, serviceability, and checkout-facing handoff.

## Source Matrix

| Source | Default entry layer | Audience | Contract |
| --- | --- | --- | --- |
| `search` | `execution_facing` | public/direct | stable, override-resistant ingress into execution-facing resolution |
| `shopping_agent` | `decisioning` | tool/delegated | broad commerce decisioning ingress |
| `aurora-bff` | `orchestration` | chat surface | Aurora Beauty orchestration ingress |

## Contract Rules

1. `source` and `layer` must stay separate.
2. `search` remains a public ingress token, not the name of the execution capability module.
3. `shopping_agent` remains the canonical decisioning ingress.
4. `aurora-bff` remains the Aurora orchestration ingress.
5. strict ingredient / shade / concern routing belongs to decisioning plus shared constraints by default.
6. stock / availability / serviceability / shipping / tax / checkout belong to execution-facing by default.

## Drift Signals

Treat these as architecture drift:

- source-specific branching becomes the business control plane
- `server.js` grows new business helper functions
- route helpers accumulate new decision logic instead of calling facades
- decisioning constraints leak into execution-facing resolution by default
- execution-facing starts owning top-layer need understanding
