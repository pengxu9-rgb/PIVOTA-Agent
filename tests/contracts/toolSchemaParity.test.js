const fs = require('fs');
const path = require('path');

const { OperationEnum } = require('../../src/schema');
const {
  PUBLIC_TOOL_OPERATIONS,
  RUNTIME_OPERATIONS,
  PUBLIC_AFTER_SALES_ACTIONS,
  CANONICAL_TO_LEGACY_OPERATION,
  CANONICAL_V2_OPERATIONS,
} = require('../../src/commerce/operationCatalog');

const toolSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../docs/tool-schema.json'), 'utf8'),
);

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = [];
  for (const value of values) {
    if (seen.has(value)) duplicates.push(value);
    seen.add(value);
  }
  return duplicates;
}

describe('tool schema parity', () => {
  test('public tool schema enum matches public tool operations source of truth', () => {
    expect(toolSchema.parameters.properties.operation.enum).toEqual(PUBLIC_TOOL_OPERATIONS);
  });

  test('runtime operation enum matches runtime operations source of truth', () => {
    expect(OperationEnum.options).toEqual(RUNTIME_OPERATIONS);
  });

  test('public tool operations remain a unique subset of runtime operations', () => {
    expect(findDuplicates(PUBLIC_TOOL_OPERATIONS)).toEqual([]);
    expect(findDuplicates(RUNTIME_OPERATIONS)).toEqual([]);

    const runtimeOps = new Set(RUNTIME_OPERATIONS);
    for (const operation of PUBLIC_TOOL_OPERATIONS) {
      expect(runtimeOps.has(operation)).toBe(true);
    }
  });

  test('public after-sales actions match the documented schema', () => {
    expect(
      toolSchema.parameters.properties.payload.properties.status.properties.requested_action.enum,
    ).toEqual(PUBLIC_AFTER_SALES_ACTIONS);
  });

  test('canonical v2 operations map only to supported runtime operations', () => {
    expect(CANONICAL_V2_OPERATIONS).toEqual(Object.keys(CANONICAL_TO_LEGACY_OPERATION));

    const runtimeOps = new Set(RUNTIME_OPERATIONS);
    for (const legacyOperation of Object.values(CANONICAL_TO_LEGACY_OPERATION)) {
      expect(runtimeOps.has(legacyOperation)).toBe(true);
    }
  });
});
