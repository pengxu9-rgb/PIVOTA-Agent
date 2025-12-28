#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { query } = require('../src/db');
const {
  createAuditAccumulator,
  consumeLookReplicatorEvent,
  finalizeAudit,
  renderMarkdown,
  resolveLookReplicatorEventsPath,
  streamJsonlFile,
  normalizeMarket,
  isValidIsoDateKey,
} = require('../src/layer2/audit/layer2Audit');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split('=', 2);
    if (inline !== undefined) out[k] = inline;
    else out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function dayWindowUtc(dateKey) {
  const start = new Date(`${dateKey}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function tryLoadOutcomeStats({ market, dateKey, acc }) {
  if (!process.env.DATABASE_URL) return null;
  const table = market === 'JP' ? 'outcome_samples_jp' : 'outcome_samples_us';
  const { startIso, endIso } = dayWindowUtc(dateKey);
  try {
    const res = await query(
      `SELECT COUNT(*)::int AS rows, AVG(rating)::float AS avg_rating FROM ${table} WHERE created_at >= $1 AND created_at < $2`,
      [startIso, endIso],
    );
    acc.input.outcomesFromDb = true;
    const row = res.rows?.[0] || {};
    return { rows: row.rows ?? 0, avgRating: row.avg_rating ?? null };
  } catch (err) {
    acc.warnings.push(`Outcomes DB read failed: ${err?.message || String(err)}`);
    return null;
  }
}

async function tryLoadMvpEventStats({ dateKey, acc }) {
  const { startIso, endIso } = dayWindowUtc(dateKey);

  if (process.env.DATABASE_URL) {
    try {
      // Best-effort: table might not exist in this service's DB.
      const res = await query(
        `SELECT event_type, COUNT(*)::int AS n FROM mvp_events WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY 1`,
        [startIso, endIso],
      );
      acc.input.mvpEventsFromDb = true;
      const byType = {};
      let rows = 0;
      for (const r of res.rows || []) {
        byType[String(r.event_type)] = Number(r.n) || 0;
        rows += Number(r.n) || 0;
      }
      return { rows, byType };
    } catch (err) {
      acc.warnings.push(`MVP events DB read skipped: ${err?.message || String(err)}`);
    }
  }

  if (String(process.env.MVP_EVENTS_SINK || '').trim() === 'file') {
    const filePath = process.env.MVP_EVENTS_JSONL_PATH
      ? path.resolve(process.env.MVP_EVENTS_JSONL_PATH)
      : path.resolve(process.cwd(), 'mvp_events.jsonl');
    if (fs.existsSync(filePath)) {
      const byType = {};
      let rows = 0;
      await streamJsonlFile(filePath, async (row) => {
        const ts = row?.occurred_at || row?.occurredAt;
        const t = Date.parse(ts);
        if (!Number.isFinite(t)) return;
        if (t < Date.parse(startIso) || t >= Date.parse(endIso)) return;
        const et = String(row?.event_type || row?.eventType || 'unknown');
        byType[et] = (byType[et] || 0) + 1;
        rows += 1;
      });
      acc.input.mvpEventsFromFile = true;
      return { rows, byType };
    }
  }

  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dateKey = args.date || args.d;
  const market = normalizeMarket(args.market || args.m);

  if (!isValidIsoDateKey(dateKey)) {
    console.error('Usage: npm run layer2:audit -- --date YYYY-MM-DD --market US|JP');
    process.exit(2);
  }

  const acc = createAuditAccumulator({ date: dateKey, market });

  const eventsDir = process.env.LR_EVENTS_JSONL_SINK_DIR;
  const eventsPath = resolveLookReplicatorEventsPath({ date: dateKey, dir: eventsDir });
  acc.input.eventsJsonlPath = eventsPath;
  if (!eventsDir) acc.warnings.push('LR_EVENTS_JSONL_SINK_DIR not set; events JSONL will be skipped.');
  if (eventsDir && !eventsPath) acc.warnings.push(`No events file found for ${dateKey} under LR_EVENTS_JSONL_SINK_DIR.`);

  if (eventsPath) {
    await streamJsonlFile(eventsPath, async (row) => {
      consumeLookReplicatorEvent(acc, row);
    });
  }

  acc.outcomeStats = await tryLoadOutcomeStats({ market, dateKey, acc });
  acc.mvpEventStats = await tryLoadMvpEventStats({ dateKey, acc });

  const report = finalizeAudit(acc);
  const md = renderMarkdown(report);

  const outDir = path.resolve(process.cwd(), 'artifacts', 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const base = `layer2-audit-${market}-${dateKey}`;
  const jsonPath = path.join(outDir, `${base}.json`);
  const mdPath = path.join(outDir, `${base}.md`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, md);

  console.log(`[layer2-audit] wrote ${path.relative(process.cwd(), mdPath)}`);
  console.log(`[layer2-audit] wrote ${path.relative(process.cwd(), jsonPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

