const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeGeminiResponseSchema } = require('../src/auroraBff/skinLlmGateway');

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
