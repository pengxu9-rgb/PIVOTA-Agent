const test = require('node:test');
const assert = require('node:assert/strict');

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const routes = require('../src/auroraBff/routes');
  return {
    moduleId,
    __internal: routes.__internal || {},
  };
}

test('nightly gate: quick-profile lightweight patch remains available', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    assert.equal(typeof __internal.extractQuickProfileLightweightPatch, 'function');
    assert.deepEqual(
      __internal.extractQuickProfileLightweightPatch({
        skin_feel: 'combination',
        goal_primary: 'breakouts',
        sensitivity_flag: 'yes',
      }),
      {
        skinType: 'combination',
        goals: ['acne'],
        sensitivity: 'high',
      },
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('nightly gate: nested request-context quick-profile mapping remains available', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    assert.equal(typeof __internal.extractProfilePatchFromRequestContextPayload, 'function');
    assert.deepEqual(
      __internal.extractProfilePatchFromRequestContextPayload({
        context: {
          skin_feel: 'oily',
          goal_primary: 'antiaging',
          sensitivity_flag: 'unsure',
        },
      }),
      {
        skinType: 'oily',
        goals: ['wrinkles'],
        sensitivity: 'unknown',
      },
    );
  } finally {
    delete require.cache[moduleId];
  }
});
