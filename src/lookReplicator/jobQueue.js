class JobQueue {
  constructor({ concurrency }) {
    this.concurrency = Math.max(1, Number(concurrency || 1));
    this.running = 0;
    this.queue = [];
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      this.running += 1;

      const run = () => {
        Promise.resolve()
          .then(item.fn)
          .then(item.resolve, item.reject)
          .finally(() => {
            this.running -= 1;
            this._drain();
          });
      };

      // Yield to the event loop so request handlers can flush responses before heavy work runs.
      if (typeof setImmediate === 'function') setImmediate(run);
      else setTimeout(run, 0);
    }
  }
}

module.exports = {
  JobQueue,
};
