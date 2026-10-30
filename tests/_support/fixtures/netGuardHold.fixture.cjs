'use strict';
// Fixture for tests/net_guard.node.test.cjs (jest). Offline; keeps the run going long enough to
// be stopped by a signal from outside.

test('holds the run open', async () => {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  expect(1).toBe(1);
}, 60_000);
