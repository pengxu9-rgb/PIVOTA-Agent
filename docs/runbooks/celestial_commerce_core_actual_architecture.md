# Celestial Commerce Core Actual Architecture

This document captures the currently implemented logical architecture after the early commerce-core refactor skeleton landed.

It is intentionally a logical module diagram, not a physical deployment diagram.

## Current Refactor Target

```text
Users / External Callers
├─ Public consumers
│  └─ ingress source=search
├─ LLM tools / delegated agents
│  └─ ingress source=shopping_agent
└─ Aurora Beauty surfaces
   └─ ingress source=aurora-bff

+--------------------------------------------------------------------------------+
| Ingress / Gateway                                                              |
|--------------------------------------------------------------------------------|
| auth · source profile · request normalization · tracing · budgets · provenance |
| readiness hooks · layer dispatch                                               |
+-----------------------------------+--------------------------------------------+
                                    |
                                    v
+--------------------------------------------------------------------------------+
| Source Profiles Registry                                                       |
|--------------------------------------------------------------------------------|
| source=search         -> default entry layer: execution_facing                 |
| source=shopping_agent -> default entry layer: decisioning                      |
| source=aurora-bff     -> default entry layer: orchestration                    |
+-----------------------------------+--------------------------------------------+
                                    |
                                    v
+--------------------------------------------------------------------------------+
| Shared ShoppingContext                                                         |
|--------------------------------------------------------------------------------|
| normalized need · constraints · category/vertical hints · candidate refs       |
| merchant/product hints · compare state · handoff state references              |
+-------------------------+---------------------------+--------------------------+
                          |                           |
                          v                           v
+-------------------------------+   +-------------------------------+   +-------------------------------+
| Aurora Beauty                 |   | Shopping Agent               |   | Execution-facing              |
| Orchestration                 |   | Discovery & decisioning      |   | Commerce resolution           |
|-------------------------------|   |------------------------------|   |-------------------------------|
| need intake                   |   | candidate retrieval          |   | exact / near-exact resolve    |
| clarify / guidance            |   | decisioning constraints      |   | merchant resolution           |
| skincare/category steering    |   | ranking / compare            |   | offer / variant resolution    |
| conversation progress state   |   | shortlist / narrowing        |   | serviceability                |
| delegate lower layers         |   | confidence / rationale       |   | shipping/tax handoff          |
|                               |   | candidate state ownership    |   | checkout/payment handoff      |
+---------------+---------------+   +---------------+--------------+   +---------------+---------------+
                |                                   |                                  |
                +-------------------+---------------+------------------+---------------+
                                    |                                  |
                                    v                                  v
+--------------------------------------------------------------------------------+
| Shared Capabilities                                                            |
|--------------------------------------------------------------------------------|
| retrieval · catalog normalization · constraints primitives · ranking primitives|
+-----------------------------------+--------------------------------------------+
                                    |
                                    v
+--------------------------------------------------------------------------------+
| Governance / Readiness / Provenance                                            |
|--------------------------------------------------------------------------------|
| contract registry · source/layer policy · smoke · audit · release gates        |
| build/version surface · runtime traces · drift detection                       |
+-----------------------------------+--------------------------------------------+
                                    |
                                    v
+--------------------------------------------------------------------------------+
| Infra / Data Surfaces                                                          |
|--------------------------------------------------------------------------------|
| pivota-backend agent_shop_gateway · pivota-acp                                 |
| internal products / products_cache                                             |
| external_product_seeds                                                         |
| pci_kb.sku_ingredients                                                         |
| catalog-intelligence / harvester                                               |
+--------------------------------------------------------------------------------+
```

## Layer Rules

- `source` is ingress-only.
- `layer` is capability ownership.
- Gateway does not own business state.
- `ShoppingContext` only carries cross-layer handoff fields.
- Decisioning constraints and execution constraints must stay separate.

## Current Stable Behavior

- `source=search` remains the public, stable ingress profile.
- `source=shopping_agent` remains the broad commerce ingress profile.
- `source=aurora-bff` remains the Aurora orchestration ingress profile.
- Public search still ignores caller-supplied widening overrides.
- Broad commerce retrieval on `shopping_agent` and `aurora-bff` still uses internal base plus external supplement.
- Strict ingredient/constraint routing remains shared infrastructure, but its primary narrowing semantics now belong to decisioning rather than execution-facing ownership.

## Near-Exact Resolution Note

`exact_product` currently covers:

- fully exact product intent
- near-exact execution-facing intent that still needs merchant / offer / variant resolution

We do not split `near_exact_resolution` into a separate enum in milestone0.
