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

function emittedLines(env = {}) {
  const out = execFileSync(process.execPath, ['-e', SCRIPT], {
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

test('LOG_LEVEL still filters, and the line shape is otherwise unchanged', () => {
  const lines = emittedLines({ LOG_LEVEL: 'info' });
  assert.deepEqual(lines.map((l) => l.probe), ['info', 'warn', 'error', 'fatal']);
  const info = lines[0];
  assert.deepEqual(Object.keys(info).sort(), ['level', 'msg', 'probe', 'severity', 'time']);
});
