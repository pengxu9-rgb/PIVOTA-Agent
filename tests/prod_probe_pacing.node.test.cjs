'use strict';

// PRODUCTION PROBES ARE PACED. The push-to-main probes send real find_products_multi to
// production, and back to back they held pivota-pg at 0.42-0.46 CPU after every gateway merge
// (2026-10-15). Two things pace them, and both are tested here by running the real scripts:
//   - scripts/search_stability_matrix.js waits SEARCH_MATRIX_DELAY_MS between calls (never before
//     the first);
//   - scripts/wait_for_prod_probe_window.sh holds a probe until the 10:30-11:20 UTC relgraph-sync
//     window is over.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const MATRIX = path.join(REPO, 'scripts', 'search_stability_matrix.js');
const WINDOW = path.join(REPO, 'scripts', 'wait_for_prod_probe_window.sh');

function runMatrix({ cases, args = [], env = {} }) {
  return new Promise((resolve, reject) => {
    const arrivals = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        arrivals.push(Date.now());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: { products: [] } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-pacing-'));
      const queryFile = path.join(dir, 'cases.json');
      fs.writeFileSync(queryFile, JSON.stringify(cases));
      execFile(
        process.execPath,
        [MATRIX, '--base-url', `http://127.0.0.1:${server.address().port}`, '--rounds', '1',
          '--query-file', queryFile, '--out-dir', dir, '--agent-api-key', 'test_key', '--timeout-ms', '5000',
          ...args],
        {
          cwd: REPO,
          env: {
            ...process.env,
            NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
            SEARCH_MATRIX_RAIL_MODE: 'authoritative_commerce',
            SEARCH_MATRIX_DELAY_MS: '',
            ...env,
          },
          timeout: 60000,
        },
        (error, stdout, stderr) => {
          server.close();
          if (error) return reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
          const summary = JSON.parse(stdout).summary;
          resolve({ arrivals, summary });
        },
      );
    });
  });
}

function gaps(arrivals) {
  return arrivals.slice(1).map((t, i) => t - arrivals[i]);
}

const CASES = ['niacinamide serum', 'retinol cream', 'vitamin c serum'];

test('SEARCH_MATRIX_DELAY_MS spaces consecutive calls and is recorded in the summary', async () => {
  const { arrivals, summary } = await runMatrix({ cases: CASES, env: { SEARCH_MATRIX_DELAY_MS: '400' } });
  assert.equal(arrivals.length, CASES.length);
  for (const gap of gaps(arrivals)) assert.ok(gap >= 380, `gap ${gap}ms is shorter than the 400ms delay`);
  assert.equal(summary.delay_ms, 400);
});

test('--delay-ms overrides the environment', async () => {
  const { arrivals, summary } = await runMatrix({
    cases: CASES.slice(0, 2),
    args: ['--delay-ms', '300'],
    env: { SEARCH_MATRIX_DELAY_MS: '0' },
  });
  assert.ok(gaps(arrivals)[0] >= 280, `gap ${gaps(arrivals)[0]}ms is shorter than the 300ms delay`);
  assert.equal(summary.delay_ms, 300);
});

test('no delay unless asked: local and test runs stay back to back', async () => {
  const { arrivals, summary } = await runMatrix({ cases: CASES });
  assert.equal(summary.delay_ms, 0);
  for (const gap of gaps(arrivals)) assert.ok(gap < 300, `unexpected ${gap}ms gap with no delay set`);
});

function runWindow(env) {
  return new Promise((resolve) => {
    execFile('bash', [WINDOW], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: '', PROD_PROBE_WAIT_DRY_RUN: '1', ...env },
      timeout: 10000,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

// 2026-10-15 at a given UTC time, as epoch seconds.
function at(hhmmss) {
  return String(Date.parse(`2026-10-15T${hhmmss}Z`) / 1000);
}

function waitSeconds(stdout) {
  const m = stdout.match(/wait_seconds=(\d+)/);
  return m ? Number(m[1]) : null;
}

test('inside 10:30-11:20 UTC the probe waits until 11:20; outside it does not wait', async () => {
  const cases = [
    ['10:29:59', null],
    ['10:30:00', 50 * 60],
    ['10:47:00', 33 * 60],
    ['11:19:59', 1],
    ['11:20:00', null],
    ['07:46:00', null],
  ];
  for (const [now, expected] of cases) {
    const { code, stdout } = await runWindow({ PROD_PROBE_NOW_EPOCH: at(now) });
    assert.equal(code, 0, `${now}: ${stdout}`);
    assert.equal(waitSeconds(stdout), expected, `${now}: ${stdout}`);
  }
});

test('the deferral is written to the step summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-window-'));
  const summaryFile = path.join(dir, 'summary.md');
  await runWindow({ PROD_PROBE_NOW_EPOCH: at('10:47:00'), GITHUB_STEP_SUMMARY: summaryFile });
  assert.match(fs.readFileSync(summaryFile, 'utf8'), /Prod probe deferred: 10:47:00 UTC is inside .*10:30-11:20.*Waiting 1980s/);
});

test('a window may cross midnight, an empty one disables the wait, a malformed one fails loudly', async () => {
  const crossing = await runWindow({ PROD_PROBE_QUIET_WINDOW_UTC: '23:50-00:10', PROD_PROBE_NOW_EPOCH: at('23:55:00') });
  assert.equal(waitSeconds(crossing.stdout), 15 * 60);
  const after = await runWindow({ PROD_PROBE_QUIET_WINDOW_UTC: '23:50-00:10', PROD_PROBE_NOW_EPOCH: at('00:10:00') });
  assert.equal(waitSeconds(after.stdout), null);
  const disabled = await runWindow({ PROD_PROBE_QUIET_WINDOW_UTC: '', PROD_PROBE_NOW_EPOCH: at('10:47:00') });
  assert.equal(disabled.code, 0);
  assert.equal(waitSeconds(disabled.stdout), null);
  const malformed = await runWindow({ PROD_PROBE_QUIET_WINDOW_UTC: '10:30', PROD_PROBE_NOW_EPOCH: at('10:47:00') });
  assert.equal(malformed.code, 2);
});
