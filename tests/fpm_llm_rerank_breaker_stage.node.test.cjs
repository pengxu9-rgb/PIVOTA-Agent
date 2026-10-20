'use strict';

// A rerank skipped by its model breaker must stay visible where a failing rerank always was: the llm_rerank
// entry of fpm_stage_breakdown keeps error:true and says breaker_open:true. Without this, opening the breaker
// would make the failure baseline vanish from the stage telemetry the moment it started saving round trips.
//
// Also pins that the breaker's WARN carries its own `severity: "WARNING"` (a field on that one log call), and that
// no other gateway line gains a `severity` field: the gateway logger writes only pino's numeric level, and this
// PR does not change how any other line is classified.
//
// Read from a real child process's stdout, as tests/fpm_stage_attribution.node.test.cjs does: pino writes
// straight to fd 1, so an in-process stdout patch sees nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PROBE = path.join(__dirname, 'fixtures', 'fpm_rerank_breaker_probe.cjs');

function runProbe(mode) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      mode ? [PROBE, mode] : [PROBE],
      { cwd: path.join(__dirname, '..'), timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`probe failed: ${err.message} ${stderr}`));
        resolve(stdout || '');
      },
    );
  });
}

function jsonLines(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // not a log line
    }
  }
  return out;
}

function rerankStage(lines) {
  for (const line of lines) {
    if (!Array.isArray(line.fpm_stage_breakdown)) continue;
    const stage = line.fpm_stage_breakdown.find((s) => s.stage === 'llm_rerank');
    if (stage) return stage;
  }
  return null;
}

test('an open rerank breaker leaves error:true and breaker_open:true on the llm_rerank stage', async () => {
  const stage = rerankStage(jsonLines(await runProbe()));
  assert.ok(stage, 'expected an llm_rerank stage in fpm_stage_breakdown');
  assert.equal(stage.applied, false);
  assert.equal(stage.error, true);
  assert.equal(stage.breaker_open, true);
});

test('control: with the breaker closed the same request records no breaker_open', async () => {
  const stage = rerankStage(jsonLines(await runProbe('closed')));
  assert.ok(stage, 'expected an llm_rerank stage in fpm_stage_breakdown');
  assert.equal(stage.breaker_open, undefined);
});

test('the breaker WARN carries severity WARNING; no other line carries a severity field', async () => {
  const lines = jsonLines(await runProbe());
  const warn = lines.find((l) => l.event === 'llm_model_breaker_open');
  assert.ok(warn, 'expected the breaker-open WARN');
  assert.equal(warn.severity, 'WARNING');
  assert.equal(warn.level, 40);
  const others = lines.filter((l) => l.event !== 'llm_model_breaker_open');
  assert.ok(others.some((l) => l.level === 30), 'expected info lines to compare against');
  const withSeverity = others.filter((l) => Object.prototype.hasOwnProperty.call(l, 'severity'));
  assert.deepEqual(withSeverity.map((l) => l.msg), [], 'no other gateway line may carry a severity field');
});
