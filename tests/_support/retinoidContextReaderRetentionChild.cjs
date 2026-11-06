'use strict';

// WHAT THE RETINOID SAFETY CONTEXT READER RETAINS, measured in a process of its own. Driven by the memory test
// in tests/integration/invoke.retinoid_safety_context_budget.test.js, which runs it as
//   node --expose-gc tests/_support/retinoidContextReaderRetentionChild.cjs
// and reads the one JSON line it prints: { blindMb, readingMb, readerRuns, overLimitRuns }.
//
// WHY A PROCESS OF ITS OWN: in the jest worker, heapUsed after a forced GC also moves with everything else that
// worker holds. On CI shard 4 (2026-11-03) the difference between the arms was 8.07 MB and reproduced locally at
// 5.55 MB, with the reader keeping nothing: the blind arm, measured first, SHRANK by 5.46 MB (old space -4.98 MB,
// large objects -0.68 MB) while the reading arm grew by 0.09 MB. That is state left by earlier tests and files
// being released during the blind arm, plus compiled code and bytecode coming and going (code space moved up to
// 0.8 MB in an arm). None of it is the reader. Here the heap holds this module, the reader and its lexicon.
//
// Each arm builds 30 request bodies the way the gateway's JSON body parser does (JSON.parse of the request text,
// so every turn is a fresh 1 MB string), and drops each one. The blind arm does not call the reader; the
// reading arm passes each body to the real reader, as src/server.js does (retinoidSafetyClassesForRequestContext
// (req.body)). What the reader keeps is the reading arm's growth minus the blind arm's.

require('../agent_readiness_eval/_net_guard.cjs');

const path = require('node:path');

const gc = global.gc;
if (typeof gc !== 'function') throw new Error('run with --expose-gc');

const signal = require(path.join(__dirname, '..', '..', 'src', 'services', 'retinoidSafetySignal'));

const MB = 1024 * 1024;
const TURNS = 30;
const requestBody = (content) =>
  JSON.parse(
    JSON.stringify({
      operation: 'find_products_multi',
      payload: { messages: [{ role: 'user', content }], search: { query: 'serum', page: 1, limit: 10, in_stock_only: true } },
      metadata: { source: 'search' },
    }),
  );
const settle = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};

// Compile the reader and its lexicon on short and long turns before either arm, so neither arm pays for it.
for (let i = 0; i < 5; i += 1) {
  signal.retinoidSafetyClassesForRequestContext(requestBody(`warm ${i} I have oily skin`));
  signal.retinoidSafetyClassesForRequestContext(requestBody(`warm ${i} ${'x'.repeat(MB)}`));
}

const arm = (tag, read) => {
  const runs = [];
  const before = settle();
  for (let i = 0; i < TURNS; i += 1) {
    // A DIFFERENT 1 MB turn every time: a cache keyed by text would keep every one of them.
    const body = requestBody(`${tag} ${i} ${'x'.repeat(MB)}`);
    if (read) runs.push(signal.retinoidSafetyClassesForRequestContext(body).classes.join(','));
  }
  return { mb: (settle() - before) / MB, runs };
};

const blind = arm('blind', false);
const reading = arm('reading', true);
process.stdout.write(
  `${JSON.stringify({
    blindMb: blind.mb,
    readingMb: reading.mb,
    readerRuns: reading.runs.length,
    overLimitRuns: reading.runs.filter((c) => c === signal.OVER_LIMIT_CLASS).length,
  })}\n`,
);
