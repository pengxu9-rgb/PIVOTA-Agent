# Aurora Stability Audit (2026-02-25)

## Scope
- Service: `PIVOTA-Agent-hotfix`
- Focus: crash-to-502/CORS chain on Aurora routes
- Code branches:
  - Backend: `hotfix/aurora-chat-analyze-crash-guard-20260225`
  - Frontend: `hotfix/chatbox-gateway-unavailable-ux-20260225`

## P0 Fixes Applied
1. Restored missing symbol in backend route flow:
   - `sanitizeProductAnalysisEnvelopeForResponse(...)` re-added in `src/auroraBff/routes.js`.
2. Fixed undefined variable in chat path:
   - `requestMessage` defined at `/v1/chat` handler scope and set from resolved `message`.
3. Added fail-safe envelope guards:
   - `sendChatEnvelope(...)` now `try/catch` and returns structured `503` envelope on internal fatal.
   - `sendProductAnalyzeEnvelope(...)` now `try/catch` and returns structured `503` envelope on internal fatal.
4. Frontend user-facing degradation:
   - `/v1/chat` and product deep-scan failures now map `503` to friendly unavailable text.
   - Network/CORS failures map to gateway-unreachable text.
   - New analytics event: `aurora_gateway_unavailable`.

## Static Audit
- Conflict markers scan:
  - Backend: no `<<<<<<<`, `=======`, `>>>>>>>` markers in `src/auroraBff`, `src/server.js`, `tests`.
  - Frontend: no conflict markers in `src/pages`, `src/lib`, `src/test`.
- Modified files only (this P0 patch set):
  - Backend: `src/auroraBff/routes.js`
  - Frontend:
    - `src/pages/BffChat.tsx`
    - `src/lib/auroraAnalytics.ts`
    - `src/test/bffchat_gateway_unavailable.test.tsx`

## Runtime Smoke (Local)
Checked with in-process HTTP server and Aurora UID headers.

| Endpoint | Status | Notes |
|---|---:|---|
| `GET /health` | 200 | service alive |
| `GET /v1/session/bootstrap` | 200 | envelope returned |
| `POST /v1/chat` | 200 | no crash/restart |
| `POST /v1/product/parse` | 200 | no crash/restart |
| `POST /v1/product/analyze` | 200 | no crash/restart |
| `POST /v1/dupe/compare` | 200 | no crash/restart |
| `POST /v1/dupe/suggest` | 200 | no crash/restart |
| `POST /v1/reco/generate` | 400 | expected bad request in minimal probe |

## Validation Commands Executed
- Backend syntax: `node -c src/auroraBff/routes.js`
- Backend runtime smoke: ad-hoc Node probe against local app server
- Frontend type check: `npm run typecheck`

## Gaps / Next Actions
1. Local dependency gap prevented full automated tests:
   - Backend jest deps not installed (`supertest` missing in local env).
   - Frontend vitest binary missing in local env.
2. Recommended CI/PR gates:
   - Run backend: `jest --runInBand tests/aurora_bff.test.js tests/aurora_bff_product_intel.test.js`
   - Run frontend: `vitest run src/test/bffchat_gateway_unavailable.test.tsx src/test/bffchat_product_parse_degrade.test.tsx`
3. Production verification after merge:
   - Confirm no `x-railway-fallback: true` on `/v1/chat` and `/v1/product/analyze`.
   - Verify browser no longer sees `502 + CORS blocked` combination.
