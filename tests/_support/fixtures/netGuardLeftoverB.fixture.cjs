'use strict';
// Fixture for tests/net_guard.node.test.cjs (jest). Offline, and slow enough that a timer the
// previous file left behind fires while this file runs. It must stay GREEN.

test('stays offline while another file leaks', async () => {
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(1).toBe(1);
});
