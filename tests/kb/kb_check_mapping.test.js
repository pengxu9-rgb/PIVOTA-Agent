const { computeIntentTechniqueMappingReport } = require('../../src/layer2/kb/checkIntentTechniqueMapping');

describe('kb mapping check', () => {
  test('reports missing technique ids, ignores placeholders', () => {
    const intentsDict = {
      schemaVersion: 'v0',
      placeholders: ['T_PLACEHOLDER_OK'],
      intents: [
        {
          id: 'I_1',
          area: 'eye',
          markets: {
            US: { techniqueIds: ['T_OK', 'T_MISSING'] },
            JP: { techniqueIds: ['T_OK', 'T_PLACEHOLDER_OK', 'T_MISSING_JP'] },
          },
        },
        {
          id: 'I_2',
          area: 'lip',
          markets: {
            US: { techniqueIds: ['T_OK', 'T_MISSING_2', 'T_MISSING_2'] },
            JP: { techniqueIds: ['T_OK'] },
          },
        },
      ],
    };

    const report = computeIntentTechniqueMappingReport({
      market: 'JP',
      intentsDict,
      techniqueIds: new Set(['T_OK']),
    });

    expect(report.market).toBe('JP');
    expect(report.totalIntents).toBe(2);
    expect(report.placeholderCount).toBe(1);
    expect(report.kbCardCount).toBe(1);
    expect(report.missingNonPlaceholderRefs).toBe(1);
    expect(report.missingByIntent.get('I_1')).toEqual(['T_MISSING_JP']);
    expect(report.missingByIntent.get('I_2')).toBeUndefined();

    expect(report.missingIntentsRanked).toEqual([
      { intentId: 'I_1', missingCount: 1, missingTechniqueIds: ['T_MISSING_JP'] },
    ]);
  });

  test('ranks intents by unique missing ids', () => {
    const intentsDict = {
      schemaVersion: 'v0',
      placeholders: [],
      intents: [
        {
          id: 'A',
          area: 'base',
          markets: { US: { techniqueIds: ['T_X', 'T_Y'] }, JP: { techniqueIds: ['T_X'] } },
        },
        {
          id: 'B',
          area: 'eye',
          markets: { US: { techniqueIds: ['T_X', 'T_Y', 'T_Z'] }, JP: { techniqueIds: ['T_X'] } },
        },
      ],
    };

    const report = computeIntentTechniqueMappingReport({
      market: 'US',
      intentsDict,
      techniqueIds: new Set(['T_X']),
    });

    expect(report.missingNonPlaceholderRefs).toBe(3);
    expect(report.missingIntentsRanked).toEqual([
      { intentId: 'B', missingCount: 2, missingTechniqueIds: ['T_Y', 'T_Z'] },
      { intentId: 'A', missingCount: 1, missingTechniqueIds: ['T_Y'] },
    ]);
  });
});
