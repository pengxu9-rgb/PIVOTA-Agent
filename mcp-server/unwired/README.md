# Unwired reference adapters — DO NOT WIRE without review

Everything under `mcp-server/unwired/` is **reference scaffolding that no production code imports.** It is kept
for when the corresponding frontier surface is actually mounted, and quarantined here so it cannot be wired by
mistake. The only live commerce surface today is the gateway's remote `POST /mcp` over
`mcp-server/src/commerceToolSurface.js` + the Safety Kernel canonical executor (see the top-level
[`../README.md`](../README.md) and [`../../docs/agent-checkout/MCP_OAUTH_FRONT_DOOR.md`](../../docs/agent-checkout/MCP_OAUTH_FRONT_DOOR.md)).

Verified 2026-06-21: importers of every module below are `mcp-server/test/*` only — nothing in `src/` or
`safety-kernel/` references them.

## `chatgpt/` — ChatGPT Apps-SDK presentation mappers (NOT a money path)

`acpMapping.js`, `checkoutFlow.js`, `components.js`. Best-effort mappers between the canonical result shape and
a ChatGPT/ACP card presentation (`pivota.acp.best_effort.v1`, provisional until ACP field names are locked).

> **⚠️ Known issue — H2 (must fix before wiring):** `acpMapping.js` (`toAcpCheckout`) copies `acp_state`
> verbatim and duplicates the **entire** canonical quote/order under `extensions.pivota.canonical` with **no
> sanitization**. If the canonical payload or `acp_state` carries secrets (`ap2_mandate`, `payment_token`,
> `confirmation_token`), they would be echoed to the agent. The live MCP surface scrubs every result through
> `safety-kernel/src/protocol/resultSanitizer.js` (`sanitizeResult`); this mapper does not. **Any future
> wiring of the ChatGPT surface must route the mapper output through `sanitizeResult` first**, and
> `chatgpt.test.js` (which currently asserts `acp_state` is *preserved*) must be updated to assert secrets are
> scrubbed.

The production ChatGPT/ACP path, when built, is the kernel's hardened ACP REST adapter
(`safety-kernel/src/protocol/acpRestAdapter.js`) — not these presentation mappers.

## `gemini/` — Gemini function-calling reference adapter (NOT mounted)

`adapter.js`, `functionDeclarations.js`. Maps Gemini function-call tool definitions onto the canonical
commerce tools. No live Gemini/UCP surface is mounted; the canonical UCP profile/verifier live in
`safety-kernel/src/protocol/ucpProfile.js` + `protocolPaymentVerifiers.js` and are reached only via `/mcp`
today.

## Related quarantine (left in place, not moved)

`mcp-server/auth/oauth.js` and `mcp-server/auth/sessionStore.js` are also reference-only and carry quarantine
headers, but stay in `auth/` because the live `auth/userRef.js` shares that directory. Production OAuth on
`/mcp` is `safety-kernel/src/identity/mcpOAuthResourceServer.js` + `src/commerceMcpOAuth.js`. See
[`../auth/README.md`](../auth/README.md).
