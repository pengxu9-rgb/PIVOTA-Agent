'use strict';

const { z } = require('zod');

// This is a small, fail-closed converter for the required-only relgraph review
// schemas, not a general Zod adapter. Local Zod parsing remains authoritative.
const TRIM_CHECK = String(z.string().trim()._zod.def.checks[0]._zod.def.tx);
const ALLOWED_CHECKS = {
  string:new Set(['min_length', 'max_length', 'length_equals']),
  array:new Set(['min_length', 'max_length', 'length_equals']),
  number:new Set(['greater_than', 'less_than']),
};

function inspectZod(schema, path = '$') {
  const def = schema?._zod?.def;
  if (!def || !['object', 'array', 'string', 'number', 'enum', 'boolean'].includes(def.type) || def.coerce) {
    throw new Error(`Unsupported native review schema type at ${path}`);
  }
  for (const check of def.checks || []) {
    const rule = check._zod?.def;
    if (rule?.check === 'overwrite' && def.type === 'string' && String(rule.tx) === TRIM_CHECK) continue;
    if (!ALLOWED_CHECKS[def.type]?.has(rule?.check)) throw new Error(`Unsupported native review schema check at ${path}`);
    const bound = rule.minimum ?? rule.maximum ?? rule.length ?? rule.value;
    if (!Number.isFinite(bound) || (def.type !== 'number' && (!Number.isSafeInteger(bound) || bound < 0))) {
      throw new Error(`Invalid native review source bound at ${path}`);
    }
  }
  if (def.type === 'object') {
    for (const [key, child] of Object.entries(def.shape)) inspectZod(child, `${path}.${key}`);
  } else if (def.type === 'array') inspectZod(def.element, `${path}[]`);
}

function convert(node, path = '$') {
  const allowed = new Set(['type', 'description', 'title', 'enum', 'properties', 'required',
    'additionalProperties', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength']);
  for (const key of Object.keys(node)) {
    if (key === '$schema' && path === '$') continue; // Generated dialect annotation, not a constraint.
    if (!allowed.has(key)) throw new Error(`Unsupported native review schema keyword ${key} at ${path}`);
  }
  const result = {...node};
  delete result.$schema;
  if (!['object', 'array', 'string', 'number', 'boolean'].includes(node.type)) {
    throw new Error(`Unsupported native review JSON type at ${path}`);
  }
  for (const key of ['minimum', 'maximum']) {
    if (Object.hasOwn(node, key) && (node.type !== 'number' || !Number.isFinite(node[key]))) {
      throw new Error(`Invalid native review numeric bound at ${path}`);
    }
  }
  for (const key of ['minItems', 'maxItems']) {
    if (Object.hasOwn(node, key) && (node.type !== 'array' || !Number.isSafeInteger(node[key]) || node[key] < 0)) {
      throw new Error(`Invalid native review array bound at ${path}`);
    }
  }
  if ((node.minimum != null && node.maximum != null && node.minimum > node.maximum) ||
      (node.minItems != null && node.maxItems != null && node.minItems > node.maxItems)) {
    throw new Error(`Contradictory native review bounds at ${path}`);
  }
  if (node.enum && node.enum.some(value => typeof value !== 'string' && !Number.isFinite(value))) {
    throw new Error(`Unsupported native review enum at ${path}`);
  }
  if (node.type === 'object') {
    if (node.additionalProperties !== false || !node.properties || !Array.isArray(node.required) ||
        Object.keys(node.properties).some(key => !node.required.includes(key)) ||
        node.required.some(key => !Object.hasOwn(node.properties, key))) {
      throw new Error(`Native review schema requires every object property at ${path}`);
    }
    result.properties = Object.fromEntries(Object.entries(node.properties).map(([key, child]) =>
      [key, convert(child, `${path}.${key}`)]));
  } else if (node.type === 'array') {
    result.items = convert(node.items, `${path}[]`);
  } else if (node.type === 'string' && (!node.enum || node.minLength != null || node.maxLength != null)) {
    const min = node.minLength ?? 0;
    const max = node.maxLength;
    if (!Number.isSafeInteger(min) || min < 0 || !Number.isSafeInteger(max) || max < min) {
      throw new Error(`Native review schema requires finite string bounds at ${path}`);
    }
    // Preserve Zod's exact native length keywords. The full reviewer/auditor
    // schemas pass compatibility preflight on both pinned OpenAI models with
    // these bounds; replacing them with lookahead patterns exhausted output
    // tokens without producing text. Local parsing remains authoritative.
  }
  return result;
}

function relationshipReviewNativeSchema(schema) {
  inspectZod(schema);
  const generated = z.toJSONSchema(schema);
  if (generated.type !== 'object') throw new Error('Native review schema must be a root object');
  return convert(generated);
}

module.exports = { relationshipReviewNativeSchema };
