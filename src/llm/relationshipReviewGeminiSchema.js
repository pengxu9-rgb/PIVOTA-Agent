'use strict';

const { relationshipReviewNativeSchema } = require('./relationshipReviewNativeSchema');

// Vertex responseSchema supports a subset of JSON Schema. First inspect the
// unchanged required-only source schema using the same fail-closed adapter as
// OpenAI, then project supported constraints. The full local Zod validator still
// enforces string lengths, trimming and additionalProperties after every call.
function relationshipReviewGeminiSchema(schema) {
  const project = node => {
    const out = { type: node.type.toUpperCase() };
    for (const key of ['enum', 'minimum', 'maximum', 'minItems', 'maxItems']) {
      if (Object.hasOwn(node, key)) out[key] = node[key];
    }
    if (node.type === 'object') {
      out.properties = Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, project(child)]));
      out.required = [...node.required];
      out.propertyOrdering = Object.keys(node.properties);
    } else if (node.type === 'array') out.items = project(node.items);
    return out;
  };
  return project(relationshipReviewNativeSchema(schema));
}

module.exports = { relationshipReviewGeminiSchema };
