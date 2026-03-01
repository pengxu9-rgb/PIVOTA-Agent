# Aurora Gate Policy Audit (Answer-First)

- generated_at_utc: 2026-02-26T03:32:32Z
- scope: auroraBff + chatbox state/reco visibility

## Gate Status

| Gate | Mode | Status | Evidence |
|---|---|---|---|
| startup_fail_closed | advisory(route 503) | implemented | `src/server.js` fail-open default + degraded middleware |
| safety_optional_profile | advisory | implemented | `resolveSafetyGateActionV2` + asked-once persistence |
| safety_hard_block | block (allowlist only) | implemented | `HARD_BLOCK_RULE_ALLOWLIST` in `safetyEngineV1.js` |
| diagnosis_first_profile_gate | advisory | implemented in reco path | `routes.js` around reco branch enqueue advisory |
| artifact_missing_gate | advisory | implemented | `routes.js` reco branch enqueue advisory |
| travel_missing_fields_gate | advisory | implemented | `routes.js` travel missing field advisory |
| fit_check_anchor_gate | advisory | implemented | `routes.js` fit-check gate downgraded |
| budget_gate | advisory | implemented | `routes.js` budget branch no early hard return |
| frontend_state_transition_guard | advisory | implemented | invalid transition now fallback to `IDLE_CHAT` (no 400 hard fail) |
| product_reco_filters | filter_only | implemented | competitor/router + candidate sanitize pipeline |
| kb_quarantine_gate | filter_only | implemented | `routes.js` product_analysis provenance.kb_quarantine |

## Remaining hard-stop behaviors (intentional)

1. `safety_hard_block` with real contraindication allowlist (`P1,P2,P3,P8,L1,M1,M2,M2B`).
2. medical red-flag boundary in reco flow (`safetyBoundary`) returns conservative block card.

## Verification

- Node tests:
  - `tests/aurora_chat_safety_advisory.node.test.cjs` passed
  - `tests/aurora_qa_safety_gate.node.test.cjs` passed
- Jest tests:
  - `tests/aurora_bff.test.js` passed
  - `tests/aurora_competitor_block_router.test.js` passed
  - `tests/aurora_bff_product_intel.test.js` passed
- Frontend vitest:
  - `src/test/recoGate.test.ts` passed
  - `src/test/agent_state_machine.test.ts` passed
  - `src/test/bffchat_product_parse_degrade.test.tsx` passed
  - `src/test/routineCompatibilityFooter.render.test.tsx` passed

## Production smoke note

- `scripts/smoke_aurora_bff_runtime.sh` updated to answer-first assertions.
- Latest production endpoint responded with legacy behavior on reco entry (`diagnosis_gate` only), indicating deployed commit still behind local gate-policy changes.
