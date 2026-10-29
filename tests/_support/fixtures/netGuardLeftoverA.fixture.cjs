'use strict';
// Fixture for tests/net_guard.node.test.cjs (jest; not matched by testMatch). Passes, and leaves
// a fetch on a timer that fires after this file's last test -- in the next file of the worker, or
// after the worker's last file. The run must still fail, naming THIS file, with a stack that
// leads back here (this file's sandbox is torn down by the time the timer fires).

test('passes, and leaves a request behind on a timer', () => {
  setTimeout(() => {
    require('node:http').get('http://192.0.2.7/').on('error', () => {});
  }, 200);
  expect(1).toBe(1);
});
