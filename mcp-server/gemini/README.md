# Pivota Gemini Function-Calling Adapter

This directory contains the Gemini surface for Pivota's canonical safe-checkout
tools. It translates the MCP commerce surface's checkout-session tools into
Gemini `functionDeclarations`, then executes Gemini `functionCall` parts through
the same canonical commerce executor used by MCP/ACP/UCP.

The adapter does not duplicate commerce validation. It reuses:

- `mcp-server/src/commerceToolSurface.js` for canonical safe-checkout tool
  definitions and argument allow-listing.
- `safety-kernel/src/protocol/canonicalExecutor.js` for quote-first checkout,
  payment-authorization verification, idempotency, ownership, and charge-once.
- The host's verified session context for `user_ref` and `acp_session_id`.

## Registering Functions With `@google/genai`

```js
import { GoogleGenAI } from "@google/genai";

import {
  GEMINI_FUNCTION_DECLARATIONS
} from "./mcp-server/gemini/functionDeclarations.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const response = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents,
  config: {
    tools: [
      {
        functionDeclarations: GEMINI_FUNCTION_DECLARATIONS
      }
    ]
  }
});
```

The declarations use Gemini's OpenAPI-subset schema dialect: JSON Schema types
are converted to uppercase strings, and unsupported `additionalProperties` and
`oneOf` keys are stripped.

## Function-Call Loop

When Gemini returns a function call, pass the part to
`geminiCallToCommerceTool(...)` with a composed canonical commerce surface, then
return the resulting Gemini `functionResponse` part:

```js
import {
  geminiCallToCommerceTool
} from "./mcp-server/gemini/adapter.js";

const functionCall = response.functionCalls?.[0];

const functionResponsePart = await geminiCallToCommerceTool(
  functionCall,
  commerceSurface,
  { user_ref: verifiedUserRef, acp_session_id: verifiedSessionId }
);
```

The adapter surfaces commerce-surface response fields verbatim,
including `requires_action` payloads such as redirect URLs, QR codes, and
instructions. The Gemini host must not fabricate payment URLs, transaction IDs,
or payment statuses.

## Identity And `user_ref`

The host app must verify the user's OAuth/OIDC claims or session before calling
the adapter. Pass the verified `{ user_ref, acp_session_id }` as the
`sessionContext`. Model-supplied identity fields in Gemini args are ignored by
the commerce surface.

Checkout writes such as `create_checkout_session` and
`complete_checkout_session` reject calls without a trusted `user_ref` and
`acp_session_id`. Read-only catalog calls may proceed without user authority if
the host policy allows that.

## UCP/AP2 Readiness

Payment authorization data remains opaque to the Gemini adapter and is verified
inside the canonical executor against the authoritative checkout-session total,
currency, merchant, and buyer. Future UCP/AP2-specific presentation can sit above
this adapter without changing the canonical commerce surface.
