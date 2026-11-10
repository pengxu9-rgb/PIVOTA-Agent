'use strict';

// src/logger.js writes the `severity` field Cloud Logging reads, beside pino's numeric `level`. Without it every
// gateway line was filed as DEFAULT, whatever its level. Read from a real child process's stdout: pino writes
// through sonic-boom straight to fd 1, so an in-process stdout patch would see nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = `
const logger = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'logger.js'))});
logger.trace({ probe: 'trace' }, 'p');
logger.debug({ probe: 'debug' }, 'p');
logger.info({ probe: 'info' }, 'p');
logger.warn({ probe: 'warn' }, 'p');
logger.error({ probe: 'error' }, 'p');
logger.fatal({ probe: 'fatal' }, 'p');
`;

// Holds every libuv threadpool thread for a moment, so the async fs.write of the first line queues behind them.
const BUSY_THREADPOOL = `
const crypto = require('node:crypto');
for (let i = 0; i < 4; i++) crypto.pbkdf2('x', 'y', 200000, 64, 'sha512', () => {});
`;

function emittedLines(env = {}, prelude = '') {
  const out = execFileSync(process.execPath, ['-e', prelude + SCRIPT], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
}

test('every level carries its Cloud Logging severity, and the numeric level is kept', () => {
  const byProbe = Object.fromEntries(emittedLines({ LOG_LEVEL: 'trace' }).map((l) => [l.probe, l]));
  const expected = {
    trace: [10, 'DEBUG'],
    debug: [20, 'DEBUG'],
    info: [30, 'INFO'],
    warn: [40, 'WARNING'],
    error: [50, 'ERROR'],
    fatal: [60, 'CRITICAL'],
  };
  for (const [probe, [level, severity]] of Object.entries(expected)) {
    assert.ok(byProbe[probe], `expected a ${probe} line`);
    assert.equal(byProbe[probe].level, level, probe);
    assert.equal(byProbe[probe].severity, severity, probe);
  }
});

// Arrival ORDER on stdout is not the contract, and pino does not keep it: its default stdout destination is async,
// and `fatal` calls flushSync(), which writes the queued lines at once and skips one whose async write is still
// in flight. When the libuv threadpool is slow (a loaded CI runner) the info line lands LAST, so the order came out
// ['warn', 'error', 'fatal', 'info'] in CI. What is checked: exactly these levels, once each, and the shape of each.
function assertFilteredAtInfo(lines) {
  assert.deepEqual(lines.map((l) => l.probe).sort(), ['error', 'fatal', 'info', 'warn']);
  for (const line of lines) {
    assert.deepEqual(Object.keys(line).sort(), ['level', 'msg', 'probe', 'severity', 'time'], line.probe);
  }
}

test('LOG_LEVEL still filters, and the line shape is otherwise unchanged', () => {
  assertFilteredAtInfo(emittedLines({ LOG_LEVEL: 'info' }));
});

test('the LOG_LEVEL check holds when fatal\'s flushSync overtakes an in-flight write (a busy threadpool)', () => {
  assertFilteredAtInfo(emittedLines({ LOG_LEVEL: 'info', UV_THREADPOOL_SIZE: '4' }, BUSY_THREADPOOL));
});
