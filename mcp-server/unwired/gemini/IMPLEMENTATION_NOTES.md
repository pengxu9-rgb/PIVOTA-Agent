# Gemini Adapter Implementation Notes

## Files

- `functionDeclarations.js` derives Gemini `functionDeclarations` from the
  canonical safe-checkout tool definitions exported by
  `mcp-server/src/commerceToolSurface.js`.
- `adapter.js` maps Gemini `functionCall` parts to the canonical commerce
  surface via `geminiCallToCommerceTool(...)`. The older
  `geminiCallToInvoke(...)` helper remains for legacy invoke compatibility.
- `README.md` documents host-app wiring with `@google/genai`, the function-call
  loop, and OAuth-derived `user_ref` flow.
- `mcp-server/test/gemini.test.js` covers schema down-conversion and adapter
  safety behavior offline with `node --test`.

## Schema Down-Conversion

Gemini function declarations use an OpenAPI-subset schema dialect, so
`toGeminiSchema(...)` makes a small, mechanical conversion:

- Lowercase JSON Schema primitive types become uppercase Gemini types:
  `STRING`, `NUMBER`, `INTEGER`, `BOOLEAN`, `OBJECT`, and `ARRAY`.
- Nested `properties`, `items`, and arrays are converted recursively.
- `additionalProperties` is stripped because Gemini does not accept that JSON
  Schema keyword in function declarations.
- `oneOf` is stripped instead of widened locally, because the canonical Pivota
  schema and safety layer remain the source of truth.
- Other descriptive and validation metadata, such as `description`, `enum`,
  `required`, `minimum`, `maximum`, and `minLength`, is preserved.

## Host-App Call Sites

A Gemini host app calls this layer in three places:

1. Register `GEMINI_FUNCTION_DECLARATIONS` under
   `tools[].functionDeclarations` when calling `models.generateContent`.
2. Convert returned Gemini `functionCall` parts with
   `geminiCallToCommerceTool(functionCall, commerceSurface, sessionContext)`.
   The commerce surface strips model-supplied identity/money fields and routes
   to the canonical executor.
3. Send the returned `functionResponse` part back to Gemini in the next model
   turn.

Payment `requires_action` payloads are never synthesized by this adapter. They are
returned exactly as the Pivota backend produced them.
