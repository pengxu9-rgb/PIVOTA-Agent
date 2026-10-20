'use strict';
// Fixture for tests/net_guard.node.test.cjs. NOT a test of its own: jest's testMatch
// does not see `.fixture.cjs`, so it runs only when that suite points jest at it.
//
// The first test does what 347 green tests did on 2026-10-20: reach for the network, catch the
// failure, carry on. It must come out RED. The second one stays offline and must stay green.

test('swallows a failed fetch and asserts only on the fallback', async () => {
  const body = await fetch('https://netguard-selftest.example.test/').then((r) => r.text(), () => 'fallback');
  expect(body).toBe('fallback');
});

test('stays offline', () => {
  expect(1 + 1).toBe(2);
});

test('a node child spawned by a jest test is guarded too, and sees no provider keys', () => {
  const { spawnSync } = require('node:child_process');
  expect(process.env.GEMINI_API_KEY).toBeUndefined();
  const r = spawnSync(process.execPath, ['-e', [
    "require('node:net').connect(80, '192.0.2.1').on('error', () => {});",
    'process.stdout.write(String(process.env.GEMINI_API_KEY || "none"));',
  ].join('')], { encoding: 'utf8' });
  expect(r.stdout).toBe('none');
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/\[netGuard\] 1 outbound network attempt\(s\) blocked/);
});
