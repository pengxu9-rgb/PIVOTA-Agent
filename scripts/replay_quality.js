#!/usr/bin/env node

const path = require('path');

const {
  DEFAULT_FIXTURES_DIR,
  runReplayFromDir,
} = require('../src/auroraBff/tools/replayRunner');

function parseArgs(argv) {
  const out = {
    fixturesDir: DEFAULT_FIXTURES_DIR,
    onlyNames: [],
    quiet: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;

    if (token === '--quiet') {
      out.quiet = true;
      continue;
    }
    if (token === '--json') {
      out.json = true;
      continue;
    }

    if (token.startsWith('--fixtures-dir=')) {
      out.fixturesDir = path.resolve(token.split('=')[1]);
      continue;
    }
    if (token === '--fixtures-dir' && argv[i + 1]) {
      out.fixturesDir = path.resolve(String(argv[i + 1]));
      i += 1;
      continue;
    }

    if (token.startsWith('--only=')) {
      const raw = token.split('=')[1];
      out.onlyNames = String(raw)
        .split(',')
        .map((x) => String(x || '').trim())
        .filter(Boolean);
      continue;
    }
    if (token === '--only' && argv[i + 1]) {
      out.onlyNames = String(argv[i + 1])
        .split(',')
        .map((x) => String(x || '').trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
  }

  return out;
}

function toBreakdownLine(result) {
  const rows = Array.isArray(result && result.quality && result.quality.breakdown)
    ? result.quality.breakdown
    : [];
  return rows
    .map((row) => {
      const id = String(row && row.id || 'unknown');
      const score = Number(row && row.score || 0);
      const max = Number(row && row.max_score || 0);
      const reason = String(row && row.reason || 'ok');
      if (row && row.passed) return `${id}:${score}/${max}`;
      return `${id}:${score}/${max}(!${reason})`;
    })
    .join(', ');
}

function printReport(report, options) {
  const summary = report.summary || {};
  const total = Number(summary.total || 0);
  const passed = Number(summary.passed || 0);
  const failed = Number(summary.failed || 0);
  const avg = Number(summary.avg_score || 0);

  console.log(`Replay Quality Summary: total=${total} pass=${passed} fail=${failed} avg_score=${avg.toFixed(2)}`);

  const results = Array.isArray(report.results) ? report.results : [];
  for (const result of results) {
    const marker = result.pass ? 'PASS' : 'FAIL';
    const score = Number(result && result.quality && result.quality.total_score || 0);
    const nextState = String(result && result.envelope && result.envelope.session_patch && result.envelope.session_patch.next_state || '');
    console.log(`[${marker}] ${result.name} score=${score} next_state=${nextState}`);

    if (!options.quiet) {
      const line = toBreakdownLine(result);
      console.log(`  breakdown: ${line}`);
    }

    if (!result.pass) {
      const failures = Array.isArray(result.failures) ? result.failures : [];
      for (const failure of failures) {
        const rule = String(failure && failure.rule || 'unknown');
        const expected = JSON.stringify(failure && failure.expected);
        const actual = JSON.stringify(failure && failure.actual);
        console.log(`  - ${rule}: expected=${expected} actual=${actual}`);
      }
    }
  }

  const topRules = Array.isArray(summary.top_failing_rules) ? summary.top_failing_rules : [];
  if (topRules.length > 0) {
    console.log('Top failing rules:');
    for (const row of topRules.slice(0, 10)) {
      console.log(`  - ${row.rule}: ${row.count}`);
    }
  }

  const topQuality = Array.isArray(summary.top_failing_quality_checks)
    ? summary.top_failing_quality_checks
    : [];
  if (topQuality.length > 0) {
    console.log('Top failing quality checks:');
    for (const row of topQuality.slice(0, 10)) {
      console.log(`  - ${row.rule}: ${row.count}`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = runReplayFromDir({
    fixturesDir: options.fixturesDir,
    onlyNames: options.onlyNames,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, options);
  }

  const failed = Number(report && report.summary && report.summary.failed || 0);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
