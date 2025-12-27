const { parseConditionDsl, parseTriggerCell, buildTechniqueCardFromCsvRow, stableStringify } = require('../../src/layer2/kb/importTechniqueCsv');

describe('kb CSV import helpers', () => {
  test('parseConditionDsl supports all ops', () => {
    expect(parseConditionDsl('userFaceProfile.geometry.eyeTiltDeg lt 0')).toEqual({
      key: 'userFaceProfile.geometry.eyeTiltDeg',
      op: 'lt',
      value: 0,
    });

    expect(parseConditionDsl('lookSpec.breakdown.base.finish eq dewy')).toEqual({
      key: 'lookSpec.breakdown.base.finish',
      op: 'eq',
      value: 'dewy',
    });

    expect(parseConditionDsl('preferenceMode in structure,ease')).toEqual({
      key: 'preferenceMode',
      op: 'in',
      value: ['structure', 'ease'],
    });

    expect(parseConditionDsl('similarityReport.delta between -10..10')).toEqual({
      key: 'similarityReport.delta',
      op: 'between',
      min: -10,
      max: 10,
    });

    expect(parseConditionDsl('userFaceProfile.quality.hasSelfie eq true')).toEqual({
      key: 'userFaceProfile.quality.hasSelfie',
      op: 'eq',
      value: true,
    });

    expect(parseConditionDsl('refFaceProfile.categorical.eyeType exists')).toEqual({
      key: 'refFaceProfile.categorical.eyeType',
      op: 'exists',
    });
  });

  test('parseTriggerCell splits on semicolons', () => {
    expect(parseTriggerCell('a eq 1; b exists ; c in x,y')).toEqual([
      { key: 'a', op: 'eq', value: 1 },
      { key: 'b', op: 'exists' },
      { key: 'c', op: 'in', value: ['x', 'y'] },
    ]);
  });

  test('buildTechniqueCardFromCsvRow validates trigger keys and normalizes roles', () => {
    const card = buildTechniqueCardFromCsvRow(
      {
        id: 'T_TEST_IMPORT',
        market: 'US',
        area: 'eye',
        difficulty: 'easy',
        trigger_all: 'lookSpec.breakdown.eye.intent eq cat_eye; userFaceProfile.geometry.eyeTiltDeg lt 0',
        trigger_any: 'preferenceMode eq ease',
        trigger_none: 'similarityReport.eyeTiltDelta gt 10',
        title: 'Test liner control',
        step1: 'Start liner from the outer third.',
        step2: 'Keep the wing shorter.',
        why1: 'Helps match the intended liner direction with less risk.',
        productRoleHint1: 'thin felt-tip liner',
        tags: 'kb_import,test',
      },
      { market: 'US' },
    );

    expect(card.market).toBe('US');
    expect(card.id).toBe('T_TEST_IMPORT');
    expect(card.productRoleHints).toEqual(['thin_felt_tip_liner']);
    expect(card.tags).toEqual(['kb_import', 'test']);
    expect(card.triggers.all).toHaveLength(2);
    expect(card.actionTemplate.steps).toHaveLength(2);

    expect(stableStringify(card)).toMatchInlineSnapshot(`
"{
  "schemaVersion": "v0",
  "market": "US",
  "id": "T_TEST_IMPORT",
  "area": "eye",
  "difficulty": "easy",
  "triggers": {
    "all": [
      {
        "key": "lookSpec.breakdown.eye.intent",
        "op": "eq",
        "value": "cat_eye"
      },
      {
        "key": "userFaceProfile.geometry.eyeTiltDeg",
        "op": "lt",
        "value": 0
      }
    ],
    "any": [
      {
        "key": "preferenceMode",
        "op": "eq",
        "value": "ease"
      }
    ],
    "none": [
      {
        "key": "similarityReport.eyeTiltDelta",
        "op": "gt",
        "value": 10
      }
    ]
  },
  "actionTemplate": {
    "title": "Test liner control",
    "steps": [
      "Start liner from the outer third.",
      "Keep the wing shorter."
    ]
  },
  "rationaleTemplate": [
    "Helps match the intended liner direction with less risk."
  ],
  "productRoleHints": [
    "thin_felt_tip_liner"
  ],
  "tags": [
    "kb_import",
    "test"
  ]
}
"
`);
  });

  test('buildTechniqueCardFromCsvRow rejects disallowed trigger key', () => {
    expect(() =>
      buildTechniqueCardFromCsvRow(
        {
          id: 'T_TEST_BAD_TRIGGER',
          market: 'US',
          area: 'eye',
          difficulty: 'easy',
          trigger_all: 'process.env.SECRET exists',
          title: 'Bad',
          step1: 'A.',
          step2: 'B.',
          why1: 'C.',
        },
        { market: 'US' },
      ),
    ).toThrow(/Trigger key not allowed/);
  });

  test('buildTechniqueCardFromCsvRow rejects unknown product role', () => {
    expect(() =>
      buildTechniqueCardFromCsvRow(
        {
          id: 'T_TEST_BAD_ROLE',
          market: 'US',
          area: 'base',
          difficulty: 'easy',
          title: 'Bad',
          step1: 'A.',
          step2: 'B.',
          why1: 'C.',
          productRoleHint1: 'alien wand',
        },
        { market: 'US' },
      ),
    ).toThrow(/Unknown productRoleHint1/);
  });
});
