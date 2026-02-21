const { extractIntentRuleBased } = require('../src/findProductsMulti/intent');
const { _debug } = require('../src/findProductsMulti/intentLlm');

describe('intent llm hard overrides', () => {
  test('pet leash override resets query_class to category', () => {
    const seed = extractIntentRuleBased('ipsa', [], []);
    const patched = _debug.applyHardOverrides('有没有狗链推荐？', {
      ...seed,
      query_class: 'lookup',
    });

    expect(patched.target_object.type).toBe('pet');
    expect(patched.scenario.name).toBe('pet_harness');
    expect(patched.query_class).toBe('category');
  });

  test('beauty availability cue does not trigger on unrelated query', () => {
    expect(_debug.hasBeautyBrandOrProductSignal('有没有狗链推荐？')).toBe(false);
    expect(_debug.hasBeautyBrandOrProductSignal('ipsa有货吗')).toBe(true);
  });
});
