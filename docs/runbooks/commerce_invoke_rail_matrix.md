# Commerce Invoke Rail Matrix

## Authoritative Commerce Rails

These rails are release or acceptance rails. They must use authenticated `POST /agent/shop/v1/invoke` and must fail when the primary path degrades into fallback.

| Rail | Owner | Endpoint | Notes |
| --- | --- | --- | --- |
| `Celestial Commerce Core Readiness` production smoke | commerce-core | `/agent/shop/v1/invoke` | authoritative readiness signal |
| `Shopping Search Release Gate` deploy verify | shopping-search | `/agent/shop/v1/invoke` | strict invoke-only verify |
| `Shopping Search Release Gate` budget FX preflight | shopping-search | `/agent/shop/v1/invoke` | primary path only |
| `Shopping Search Release Gate` runtime warm | shopping-search | `/agent/shop/v1/invoke` | fails on degraded primary path |
| `Shopping Search Release Gate` skincare smoke | shopping-search | `/agent/shop/v1/invoke` | shared prod live corpus |
| `Celestial staging matrix` live cases | commerce-core | `/agent/shop/v1/invoke` | staging acceptance rail |
| `search_stability_matrix.js` default mode | shared scripts | `/agent/shop/v1/invoke` | `rail_mode=authoritative_commerce` |

## Public Observability Rails

These rails may keep using public `POST /api/gateway`, but only for public-surface observability, legacy comparison, or frontend regression. They must not decide readiness or release.

| Rail | Owner | Endpoint | Notes |
| --- | --- | --- | --- |
| readiness audit public probe section | commerce-core | `/api/gateway` | non-authoritative only |
| LLM infra readiness public probe | infra-readiness | `/api/gateway` | public observability |
| frontend Winona/IPSA live regression | frontend | `/api/gateway` | frontend public contract |
| Aurora runtime public smoke | aurora | Aurora public routes | not a commerce invoke rail |

## Guardrails

- `/agent/gateway` is forbidden across runtime, workflow, fixture, and wrapper files.
- `/api/gateway` is forbidden outside the explicit public-observability allowlist.
- Any authoritative rail must enforce:
  - `primary_path_degraded = false`
  - no `agent_products_error_fallback`
  - no `agent_products_resolver_fallback`
  - no `agent_products_resolver_ref_fallback`
