const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveGeminiEffectiveTimeoutMs,
  resolveReportAttemptTimeoutMs,
  sanitizeGeminiResponseSchema,
  shouldRetryReportAttempt,
} = require('../src/auroraBff/skinLlmGateway');

test('skin llm gateway: schema sanitizer preserves object property names such as title', () => {
  const raw = {
    type: 'object',
    title: 'metadata title should be stripped',
    description: 'metadata description should be stripped',
    properties: {
      title: { type: 'string', maxLength: 120, description: 'real title field' },
      url: { type: 'string', maxLength: 300 },
    },
    required: ['title', 'url'],
  };

  const sanitized = sanitizeGeminiResponseSchema(raw);
  assert.equal(Boolean(sanitized.title), false);
  assert.equal(Boolean(sanitized.description), false);
  assert.equal(Boolean(sanitized.properties && sanitized.properties.title), true);
  assert.equal(sanitized.properties.title.type, 'string');
  assert.deepEqual(sanitized.required, ['title', 'url']);
});

test('skin llm gateway: explicit timeout is honored instead of inflating to inferred structured timeout', () => {
  const explicit = resolveGeminiEffectiveTimeoutMs({ timeoutMs: 900, maxOutputTokens: 1800 });
  assert.equal(explicit, 900);
});

test('skin llm gateway: report attempt timeout plan leaves headroom for retry within total budget', () => {
  assert.equal(resolveReportAttemptTimeoutMs({ totalTimeoutMs: 3000, attempt: 1, previousElapsedMs: 0 }), 2100);
  assert.equal(resolveReportAttemptTimeoutMs({ totalTimeoutMs: 3000, attempt: 2, previousElapsedMs: 2100 }), 900);
});

test('skin llm gateway: recoverable first failure does not qualify for report retry', () => {
  assert.equal(
    shouldRetryReportAttempt({
      failureReason: 'UPSTREAM_SCHEMA_INVALID',
      totalTimeoutMs: 3000,
      firstAttemptLatencyMs: 1200,
    }),
    false,
  );
  assert.equal(
    shouldRetryReportAttempt({
      failureReason: 'SEMANTIC_INVALID',
      totalTimeoutMs: 3000,
      firstAttemptLatencyMs: 1200,
    }),
    true,
  );
  assert.equal(
    shouldRetryReportAttempt({
      failureReason: 'SEMANTIC_INVALID',
      totalTimeoutMs: 1500,
      firstAttemptLatencyMs: 1000,
    }),
    false,
  );
});
