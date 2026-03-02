const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeGeminiResponseSchema,
  classifyGeminiError,
  toStatusCode,
} = require('../src/auroraBff/skinLlmGateway');

test('skin llm gateway: sanitizeGeminiResponseSchema removes additionalProperties recursively', () => {
  const sourceSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      features: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            observation: { type: 'string' },
            confidence: { type: 'string' },
          },
        },
      },
      nested: {
        type: 'object',
        properties: {
          child: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { key: { type: 'string' } },
            },
          },
        },
      },
    },
  };

  const sanitized = sanitizeGeminiResponseSchema(sourceSchema);
  const asText = JSON.stringify(sanitized);
  assert.equal(asText.includes('additionalProperties'), false);
  assert.equal(sanitized.type, 'object');
  assert.equal(sanitized.properties.features.type, 'array');
  assert.equal(sanitized.properties.features.items.type, 'object');
  assert.equal(sanitized.properties.nested.properties.child.items.type, 'object');
});

test('skin llm gateway: message-only status is parsed and classified as UPSTREAM_4XX', () => {
  const err = new Error(
    'got status: 400 Bad Request. {"error":{"code":400,"status":"INVALID_ARGUMENT","message":"Unknown name \\"additionalProperties\\""}}',
  );
  err.code = undefined;

  assert.equal(toStatusCode(err), 400);

  const out = classifyGeminiError(err);
  assert.equal(out.reason, 'UPSTREAM_4XX');
  assert.equal(out.upstream_status_code, 400);
  assert.equal(out.error_evidence.reason_normalized, 'VISION_UPSTREAM_4XX');
  assert.equal(out.error_evidence.http_status, 400);
  assert.equal(typeof out.error_evidence.provider_error_message, 'string');
  assert.ok(out.error_evidence.provider_error_message.toLowerCase().includes('additionalproperties'));
});
