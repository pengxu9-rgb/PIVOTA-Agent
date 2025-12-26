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

      Promise.resolve()
        .then(item.fn)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.running -= 1;
          this._drain();
        });
    }
  }
}

module.exports = {
  JobQueue,
};

