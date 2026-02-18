#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {
    in: '',
    outJson: '',
    outMd: '',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--in') out.in = String(argv[++i] || '');
    else if (arg === '--out-json') out.outJson = String(argv[++i] || '');
    else if (arg === '--out-md') out.outMd = String(argv[++i] || '');
  }
  return out;
}

function readJsonLines(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function pickProps(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.event_name === 'reco_interleave_click') return row;
  if (row.event_name && row.properties && typeof row.properties === 'object') {
    return {
      event_name: row.event_name,
      ...row.properties,
    };
  }
  if (row.properties && typeof row.properties === 'object' && row.properties.event_name === 'reco_interleave_click') {
    return row.properties;
  }
  return null;
}

function bucketKey(props) {
  const block = String(props.block || 'unknown').trim().toLowerCase();
  const category = String(props.category_bucket || 'unknown').trim().toLowerCase();
  const priceBand = String(props.price_band || 'unknown').trim().toLowerCase();
  return `${block}|${category}|${priceBand}`;
}

function ensureStat(map, key) {
  if (!map.has(key)) {
    map.set(key, {
      block: key.split('|')[0],
      category_bucket: key.split('|')[1],
      price_band: key.split('|')[2],
      interleave_wins_A: 0,
      interleave_wins_B: 0,
      interleave_ties: 0,
      total: 0,
    });
  }
  return map.get(key);
}

function toMarkdown(rows, summary) {
  const lines = [];
  lines.push('# Reco Interleave Winrate Report');
  lines.push('');
  lines.push(`- total_clicks: ${summary.total_clicks}`);
  lines.push(`- interleave_wins_A: ${summary.interleave_wins_A}`);
  lines.push(`- interleave_wins_B: ${summary.interleave_wins_B}`);
  lines.push(`- interleave_ties: ${summary.interleave_ties}`);
  lines.push('');
  lines.push('| block | category_bucket | price_band | wins_A | wins_B | ties | total |');
  lines.push('|---|---|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    lines.push(
      `| ${row.block} | ${row.category_bucket} | ${row.price_band} | ${row.interleave_wins_A} | ${row.interleave_wins_B} | ${row.interleave_ties} | ${row.total} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.in) {
    console.error('Usage: node scripts/reco_interleave_winrate.js --in <events.jsonl> [--out-json <path>] [--out-md <path>]');
    process.exit(2);
  }

  const rows = readJsonLines(path.resolve(args.in));
  const bucketStats = new Map();
  const summary = {
    total_clicks: 0,
    interleave_wins_A: 0,
    interleave_wins_B: 0,
    interleave_ties: 0,
  };

  for (const row of rows) {
    const props = pickProps(row);
    if (!props || String(props.event_name || '') !== 'reco_interleave_click') continue;
    const attribution = String(props.attribution || 'both').trim();
    const key = bucketKey(props);
    const stat = ensureStat(bucketStats, key);
    stat.total += 1;
    summary.total_clicks += 1;

    if (attribution === 'A') {
      stat.interleave_wins_A += 1;
      summary.interleave_wins_A += 1;
    } else if (attribution === 'B') {
      stat.interleave_wins_B += 1;
      summary.interleave_wins_B += 1;
    } else {
      stat.interleave_ties += 1;
      summary.interleave_ties += 1;
    }
  }

  const by_bucket = Array.from(bucketStats.values()).sort((a, b) => b.total - a.total);
  const output = { summary, by_bucket };

  if (args.outJson) {
    const outPath = path.resolve(args.outJson);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  }

  const md = toMarkdown(by_bucket, summary);
  if (args.outMd) {
    const outPath = path.resolve(args.outMd);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, md, 'utf8');
  }

  if (!args.outJson && !args.outMd) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }
}

main();
