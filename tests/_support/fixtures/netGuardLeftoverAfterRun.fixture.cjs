'use strict';
// Fixture for tests/net_guard.node.test.cjs (jest, --runInBand). Passes, and leaves a fetch on a
// timer long enough to fire after jest has finished reporting the run: in band, jest waits for
// the event loop before it exits, so the attempt happens -- and must still fail the run.

test('passes, and leaves a fetch behind that fires after the run is reported', () => {
  setTimeout(() => {
    fetch('http://192.0.2.9/').catch(() => {});
  }, 1500);
  expect(1).toBe(1);
});
