import { commerceToolDefinitions } from "../src/commerceToolSurface.js";

const TYPE_MAP = Object.freeze({
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  object: "OBJECT",
  array: "ARRAY"
});

const STRIPPED_SCHEMA_KEYS = new Set([
  "$schema",
  "additionalProperties",
  "oneOf"
]);

export const GEMINI_FUNCTION_DECLARATIONS = Object.freeze(
  commerceToolDefinitions.map(({ name, description, inputSchema }) =>
    Object.freeze({
      name,
      description,
      parameters: toGeminiSchema(inputSchema)
    })
  )
);

export function toGeminiSchema(jsonSchema) {
  if (Array.isArray(jsonSchema)) {
    return jsonSchema.map((item) => toGeminiSchema(item));
  }

  if (!isPlainObject(jsonSchema)) {
    return jsonSchema;
  }

  const output = {};
  for (const [key, value] of Object.entries(jsonSchema)) {
    if (STRIPPED_SCHEMA_KEYS.has(key)) {
      continue;
    }

    if (key === "type") {
      output.type = convertType(value);
      continue;
    }

    output[key] = toGeminiSchema(value);
  }

  return output;
}

function convertType(type) {
  if (Array.isArray(type)) {
    return type.map((item) => convertType(item));
  }

  if (typeof type !== "string") {
    return type;
  }

  return TYPE_MAP[type.toLowerCase()] ?? type.toUpperCase();
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
