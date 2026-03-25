# Celestial Commerce Core Source Contract Matrix

This document defines the stable source-layer contract for Pivota's commerce core.

These source tokens are not just runtime params. They are the primary layer boundary between:

- public search
- shopping execution
- Aurora chat orchestration
- the broader Celestial engine

## Layer Map

### L0: `search`

- Audience: public search surfaces, deploy verification, stable smoke, deterministic external consumers.
- Default retrieval semantics:
  - internal-first
  - stable cache-first
  - do not widen into external discovery just because a caller passes a strategy override
- Allowed downstream behavior:
  - `find_products_multi`
  - strict paths still allowed when runtime contract requires them
- Disallowed behavior:
  - caller-driven widening through `external_seed_strategy`
  - bypassing a healthy internal cache hit in order to force unified relevance
- Ownership:
  - release stability
  - public contract determinism
  - deployment verification

### L1: `shopping_agent`

- Audience: shopping tool execution, user-to-commerce task completion.
- Default retrieval semantics:
  - broad commerce search
  - internal base + external supplement
  - strict ingredient / strict shade / constraint-aware search when query requires it
- Responsibilities:
  - prompt understanding
  - clarify only when needed
  - query rewrite / loop-break
  - merchant/product search invocation
  - tool-call continuity
- Ownership:
  - commerce task completion quality
  - product discovery completeness
  - search-to-order continuity

### L2: `aurora-bff`

- Audience: Aurora chat, skill orchestration, card rendering, user memory.
- Default retrieval semantics:
  - align with `shopping_agent` for commerce retrieval
  - orchestration differences allowed
  - search semantics drift is not allowed without an explicit contract update
- Responsibilities:
  - intent routing
  - prompt contract enforcement
  - skill orchestration
  - downstream commerce handoff
  - response shaping for chat/cards
- Ownership:
  - conversation-level orchestration
  - skill-to-search contract integrity
  - fallback/degrade behavior

### L3: Celestial Engine

- Audience: internal engine layer, not a direct public source token.
- Definition:
  - shared commerce/search policy
  - downstream backend/ACP integration
  - policy, gates, provenance, observability
  - future category engines
- Responsibilities:
  - shared retrieval policy
  - shared fallback policy
  - contract governance
  - release gates

## Source Matrix

| Source | Layer | Audience | Retrieval contract | Fallback owner |
| --- | --- | --- | --- | --- |
| `search` | L0 | public/stable | internal-first, cache-stable, override-resistant | server/runtime contract |
| `shopping_agent` | L1 | shopping execution | broad commerce search, internal base + external supplement | shopping agent tool runtime |
| `aurora-bff` | L2 | chat orchestration | same commerce retrieval semantics as L1, with BFF orchestration on top | aurora-bff orchestrator |

## Contract Rules

1. `search` is the stable public search surface.
   It is allowed to be narrower than L1/L2.

2. `shopping_agent` is the canonical commerce retrieval contract.
   New commerce search semantics should land here first.

3. `aurora-bff` should reuse L1 commerce retrieval semantics.
   Differences are allowed in orchestration, cards, and memory, not in basic retrieval meaning.

4. If we need a future public broad-search surface, add a new explicit source contract.
   Do not overload `search`.

## Drift Signals

Treat these as contract drift, not normal implementation detail:

- the same commerce query means different retrieval semantics in `shopping_agent` vs `aurora-bff`
- `search` can be widened by caller-supplied external strategies
- L1 query decomposition lives only in prompts with no testable runtime helpers
- L2 search routing depends on hidden env wiring with no explicit contract coverage
