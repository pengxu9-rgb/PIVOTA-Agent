const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeGeminiResponseSchema,
  classifyGeminiError,
  buildGeminiModelLadder,
  isGeminiModelUnavailableError,
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

test('skin llm gateway: buildGeminiModelLadder keeps order and deduplicates', () => {
  const ladder = buildGeminiModelLadder({
    primaryModel: 'gemini-3-pro',
    fallbackModel: 'gemini-2.0-flash',
    envOverride: 'gemini-3-pro, gemini-2.0-flash, gemini-3-pro',
  });
  assert.deepEqual(ladder, ['gemini-3-pro', 'gemini-2.0-flash']);
});

test('skin llm gateway: model-unavailable 4xx is recognized for ladder fallback', () => {
  const err = new Error('got status: 404 Not Found. model gemini-3-pro is not available for API version v1');
  const classified = classifyGeminiError(err);
  assert.equal(classified.reason, 'UPSTREAM_4XX');
  assert.equal(isGeminiModelUnavailableError(err, classified), true);

  const timeoutErr = new Error('request timeout');
  timeoutErr.code = 'GEMINI_TIMEOUT';
  const timeoutClassified = classifyGeminiError(timeoutErr);
  assert.equal(isGeminiModelUnavailableError(timeoutErr, timeoutClassified), false);
});
