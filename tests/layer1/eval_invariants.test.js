const { assertInvariants } = require('../../src/eval/layer1/us/invariants');

describe('Layer1 eval invariants', () => {
  test('rejects identity language', () => {
    const sample = { id: 'x', market: 'US' };
    const report = {
      market: 'US',
      reasons: [{ title: 'ok', copy: 'ok', evidence: ['e'] }, { title: 'ok', copy: 'ok', evidence: ['e'] }, { title: 'ok', copy: 'ok', evidence: ['e'] }],
      adjustments: [
        { impactArea: 'base', title: 'ok', because: 'ok', do: 'ok', confidence: 'high', evidence: ['e'] },
        { impactArea: 'eye', title: 'ok', because: 'ok', do: 'ok', confidence: 'high', evidence: ['e'] },
        { impactArea: 'lip', title: 'ok', because: 'You look like someone', do: 'ok', confidence: 'high', evidence: ['e'] },
      ],
    };
    expect(() => assertInvariants(sample, report)).toThrow(/Identity language/);
  });
});

