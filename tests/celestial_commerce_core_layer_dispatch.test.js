const baseline = require('../scripts/fixtures/celestial_commerce_core_milestone0_baseline.json');
const { describeTaskType } = require('../src/modules/contracts/taskType');
const { resolveSourceProfile } = require('../src/api/gateway/sourceProfiles');
const {
  buildCommerceLayerDispatchPlan,
  dispatchCommerceLayer,
} = require('../src/api/gateway/layerDispatcher');

describe('Celestial commerce core layer dispatch', () => {
  test('exact_product task type explicitly documents near_exact_resolution semantics', () => {
    const description = describeTaskType('exact_product');
    expect(description.task_type).toBe('exact_product');
    expect(description.note).toMatch(/near_exact_resolution/i);
  });

  test.each(baseline)('$id resolves source profile and default entry layer', (spec) => {
    const profile = resolveSourceProfile(spec.source);
    expect(profile).toBeTruthy();
    expect(profile.source).toBeTruthy();

    const plan = buildCommerceLayerDispatchPlan({
      source: spec.source,
      task_type: spec.task_type,
    });
    expect(plan.entry_layer).toBe(spec.expected_entry_layer);
    expect(plan.task_type).toBe(spec.task_type);
  });

  test.each(baseline)('$id dispatches to the expected facade skeleton', async (spec) => {
    const result = await dispatchCommerceLayer({
      source: spec.source,
      task_type: spec.task_type,
      context: {
        vertical: 'beauty',
        category: 'skincare',
        raw_user_goal: spec.id,
      },
      messages:
        spec.expected_entry_layer === 'orchestration'
          ? [{ role: 'user', content: 'help me shop' }]
          : [],
    });
    expect(result.layer).toBe(spec.expected_entry_layer);
    expect(result.status).toBe(spec.expected_status);
  });
});
