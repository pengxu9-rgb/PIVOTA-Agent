'use strict';
// Fixture for tests/net_guard.node.test.cjs (node:test). Exercises tests/nock_file_net_guard.cjs:
// a request to a mocked host that no interceptor matched fails its test; one to a host the file
// declares `down` fails fast and is not reported; an unmocked host fails its test.
const test = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');
const { guardFileNetwork } = require('../../nock_file_net_guard.cjs');

guardFileNetwork(test, nock, { down: ['down.example.test'] });

test('a down host fails fast and is not reported', async () => {
  await assert.rejects(fetch('http://down.example.test/x'));
});

test('a mocked host whose interceptors all missed is reported', async () => {
  nock('http://mocked.example.test').get('/expected').reply(200, 'ok');
  await fetch('http://mocked.example.test/other').catch(() => {});
  nock.cleanAll();
});

test('an unmocked host is reported', async () => {
  await fetch('http://unmocked.example.test/y').catch(() => {});
});

test('a matched request passes', async () => {
  nock('http://mocked.example.test').get('/expected').reply(200, 'ok');
  assert.equal(await (await fetch('http://mocked.example.test/expected')).text(), 'ok');
});
