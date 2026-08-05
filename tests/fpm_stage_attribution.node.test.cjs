'use strict';

// fpm_stage_breakdown is the only tool for asking "where did a search's seconds go", and it had a hole.
// Measured on prod 2026-08-05: requests that ran the FULL pipeline were 99% attributed (gap 15ms), but
// requests that exited EARLY reported only context_build and left 1.8-2.7s — 93-99% of their latency —
// with nothing to attribute it to. Two causes: the region before the first recorded stage was invisible by
// construction, and the beauty direct-recall lanes can answer a request outright without recording a stage.
//
// An instrumentation change that silently fails to fire is worthless AND indistinguishable from success, so
// these tests read the telemetry the server really emits. That means a child process: pino writes through
// sonic-boom straight to fd 1, so patching process.stdout.write in-process captures nothing (verified).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PROBE = path.join(__dirname, 'fixtures', 'fpm_stage_probe.cjs');

function runProbe(query) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [PROBE, query],
      { cwd: path.join(__dirname, '..'), timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`probe failed: ${err.message} ${stderr}`));
        resolve(stdout || '');
      },
    );
  });
}

function stagesFrom(stdout) {
  for (const line of stdout.split('\n')) {
    if (!line.includes('fpm_stage_breakdown')) continue;
    let payload = null;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    const breakdown = payload && payload.fpm_stage_breakdown;
    if (Array.isArray(breakdown) && breakdown.length) return breakdown;
  }
  return null;
}

test('the region before the first stage is attributed, not silently absorbed into latency', async () => {
  const stages = stagesFrom(await runProbe('attribution probe running shoes'));
  assert.ok(stages, 'expected an fpm_stage_breakdown to be emitted');
  const names = stages.map((s) => s.stage);
  assert.ok(
    names.includes('route_entry'),
    `route_entry must be recorded or everything before context_build is unattributable; saw ${names.join(', ')}`,
  );
  const routeEntry = stages.find((s) => s.stage === 'route_entry');
  assert.equal(typeof routeEntry.latency_ms, 'number');
  assert.ok(routeEntry.latency_ms >= 0);
});

test('route_entry leads the serial stages, so nothing precedes it unmeasured', async () => {
  const stages = stagesFrom(await runProbe('attribution ordering probe'));
  assert.ok(stages, 'expected an fpm_stage_breakdown to be emitted');
  // citable_supplement is a floating promise appended whenever it resolves, and is explicitly off_path, so
  // it is excluded from the ordering claim.
  const ordered = stages.filter((s) => !s.off_path).map((s) => s.stage);
  assert.equal(ordered[0], 'route_entry', `route_entry must lead the serial stages; saw ${ordered.join(', ')}`);
});
