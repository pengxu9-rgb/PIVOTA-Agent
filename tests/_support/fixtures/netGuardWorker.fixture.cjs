'use strict';
// Fixture for tests/net_guard.node.test.cjs (jest). Under jest the guard is installed from
// setupFiles, not from the worker process's startup flags, so a worker thread that inherits
// those flags -- no execArgv, an eval'd script, SHARE_ENV -- would start without it. Each worker
// swallows its blocked connect and reports the error code; the tests pass, the run must not.
const { Worker, SHARE_ENV } = require('node:worker_threads');

const workers = [];
afterAll(() => Promise.all(workers.map((w) => w.terminate())));

function connectFromWorker(ip, options) {
  const code = `require('node:net').connect(80, '${ip}').on('error', (e) => require('node:worker_threads').parentPort.postMessage(e.code))`;
  const worker = new Worker(code, { eval: true, ...options });
  workers.push(worker);
  return new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

test('a worker with inherited flags is guarded', async () => {
  expect(await connectFromWorker('192.0.2.20')).toBe('ERR_TEST_NETWORK_BLOCKED');
}, 3000);

test('a worker sharing this thread\'s env is guarded', async () => {
  expect(await connectFromWorker('192.0.2.27', { env: SHARE_ENV })).toBe('ERR_TEST_NETWORK_BLOCKED');
}, 3000);
