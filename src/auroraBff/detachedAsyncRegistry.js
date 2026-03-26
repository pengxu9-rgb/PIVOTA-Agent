const activeDetachedAsyncJobs = new Set();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function scheduleDetachedAsyncJob(fn) {
  if (typeof fn !== 'function') {
    return Promise.resolve();
  }

  const job = Promise.resolve()
    .then(() => new Promise((resolve) => setImmediate(resolve)))
    .then(() => fn());

  activeDetachedAsyncJobs.add(job);
  job.finally(() => {
    activeDetachedAsyncJobs.delete(job);
  });
  return job;
}

async function flushDetachedAsyncJobs({ timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 10_000);

  while (activeDetachedAsyncJobs.size > 0) {
    const pendingJobs = Array.from(activeDetachedAsyncJobs);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return {
        timed_out: true,
        remaining_jobs: activeDetachedAsyncJobs.size,
      };
    }
    await Promise.race([Promise.allSettled(pendingJobs), delay(remainingMs)]);
  }

  return {
    timed_out: false,
    remaining_jobs: 0,
  };
}

function resetDetachedAsyncJobs() {
  activeDetachedAsyncJobs.clear();
}

module.exports = {
  scheduleDetachedAsyncJob,
  flushDetachedAsyncJobs,
  __internal: {
    activeDetachedAsyncJobs,
    resetDetachedAsyncJobs,
  },
};
