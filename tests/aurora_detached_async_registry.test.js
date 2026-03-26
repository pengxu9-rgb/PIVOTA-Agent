const {
  scheduleDetachedAsyncJob,
  flushDetachedAsyncJobs,
  __internal,
} = require('../src/auroraBff/detachedAsyncRegistry');

describe('aurora detached async registry', () => {
  afterEach(() => {
    __internal.resetDetachedAsyncJobs();
  });

  test('flushDetachedAsyncJobs waits for detached setImmediate jobs', async () => {
    const seen = [];
    scheduleDetachedAsyncJob(async () => {
      seen.push('started');
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push('finished');
    });

    const out = await flushDetachedAsyncJobs({ timeoutMs: 1000 });
    expect(out).toEqual({ timed_out: false, remaining_jobs: 0 });
    expect(seen).toEqual(['started', 'finished']);
    expect(__internal.activeDetachedAsyncJobs.size).toBe(0);
  });
});
