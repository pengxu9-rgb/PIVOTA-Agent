'use strict';
// The loopback-only guard's run log and report format, with no side effects: the guard
// (netGuard.cjs) writes the log, and the runners that must NOT install the guard in their own
// process -- the jest reporter, scripts/run_node_test_suites.cjs -- read it, and the latter hands
// the guard to its suites with withGuardPreload.
//
// NETGUARD_RUN_DIR holds one JSONL file per process and thread. Each blocked attempt is a row
// {id, kind, target, origin, inChild, testPath, argv, stack}; a test that failed on an attempt appends
// {reported: id}. What is left unreported at the end of a run escaped every test.

const fs = require('node:fs');
const path = require('node:path');

const RUN_DIR_ENV = 'NETGUARD_RUN_DIR';
const GUARD_PATH = path.join(__dirname, 'netGuard.cjs');
// The test file a child process works for, so its attempts name that file.
const ORIGIN_ENV = 'NETGUARD_ORIGIN';

// `--require=<the guard>` appended to a NODE_OPTIONS value, once. NODE_OPTIONS splits on
// whitespace, so a checkout path containing a space cannot be carried; that is refused loudly
// rather than silently running children unguarded.
function withGuardPreload(nodeOptions) {
  const preload = `--require=${GUARD_PATH}`;
  if (/\s/.test(GUARD_PATH)) {
    throw new Error(`[netGuard] cannot preload from a path with whitespace: ${GUARD_PATH}`);
  }
  const existing = String(nodeOptions || '').trim();
  return existing.includes(preload) ? existing : [existing, preload].filter(Boolean).join(' ');
}

function readRunLog(dir) {
  const attempts = [];
  const reported = new Set();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch (_) {
    return [];
  }
  for (const name of names) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (row.reported) reported.add(row.reported);
      else attempts.push(row);
    }
  }
  return attempts.filter((a) => !reported.has(a.id));
}

function formatViolations(list) {
  const lines = [
    `[netGuard] ${list.length} outbound network attempt(s) blocked. Tests may only reach loopback.`,
  ];
  list.forEach((v, i) => {
    const where = [
      v.origin ? `started by ${v.origin}` : null,
      v.testPath && (!v.origin || !v.testPath.startsWith(v.origin)) ? `during ${v.testPath}` : null,
      v.inChild ? `in a child process or worker${v.argv ? `: ${v.argv}` : ''}` : null,
    ].filter(Boolean);
    lines.push(`  ${i + 1}. ${v.kind} -> ${v.target}${where.length ? `  (${where.join('; ')})` : ''}`);
    // `| ` keeps jest from mistaking these for its own stack frames and filtering them out.
    if (v.stack) lines.push(v.stack.split('\n').map((l) => `       | ${l}`).join('\n'));
  });
  lines.push(
    'Fix: mock the call (nock / msw without passthrough / dependency injection), or make the test ' +
      'an opt-in integration test skipped unless an env var is set. TEST_ALLOW_NETWORK=1 turns the ' +
      'guard off for a local run (never in CI).',
  );
  return lines.join('\n');
}

module.exports = { RUN_DIR_ENV, ORIGIN_ENV, GUARD_PATH, withGuardPreload, readRunLog, formatViolations };
