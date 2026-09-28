#!/usr/bin/env node
// READ-ONLY census: how many dupe / competitive_alternative candidates in the stored relationship
// graph serve more anchors than the fan-in cap, for live rows (human_approved / ai_approved, not
// expired) and for live + queued rows (generated / review_ready). Prints JSON; writes nothing.
//
//   node scripts/report-relationship-fan-in-census.js [--market US] [--cap 8] [--top 10] [--out path]

const fs = require('node:fs');
const path = require('node:path');
const { closePool, query } = require('../src/db');
const { DEFAULT_MAX_ANCHORS_PER_CANDIDATE, loadFanInCensus } = require('../src/auroraBff/relationshipFanIn');

function argValue(argv, name) {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  return !value || value.startsWith('--') ? null : value;
}

async function run(argv = process.argv.slice(2), { queryFn = query } = {}) {
  const census = await loadFanInCensus({
    market: argValue(argv, 'market') || 'US',
    cap: Number(argValue(argv, 'cap')) || DEFAULT_MAX_ANCHORS_PER_CANDIDATE,
    top: Math.max(1, Math.min(100, Number(argValue(argv, 'top')) || 10)),
    queryFn,
  });
  const out = argValue(argv, 'out');
  if (out) {
    const resolved = path.isAbsolute(out) ? out : path.join(process.cwd(), out);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(census, null, 2)}\n`, 'utf8');
  }
  return census;
}

if (require.main === module) {
  run()
    .then((census) => { process.stdout.write(`${JSON.stringify(census, null, 2)}\n`); })
    .catch((err) => { process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`); process.exitCode = 1; })
    .finally(() => closePool().catch(() => {}));
}

module.exports = { run };
