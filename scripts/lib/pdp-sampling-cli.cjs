'use strict';

function parseCommonArgs(argv = process.argv.slice(2)) {
  const out = {
    help: false,
    json: false,
    csv: false,
    limit: 100,
    positional: [],
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--csv') out.csv = true;
    else if (arg === '--limit') {
      const raw = argv[idx + 1];
      idx += 1;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--limit requires a positive integer');
      }
      out.limit = Math.trunc(parsed);
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.slice('--limit='.length));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--limit requires a positive integer');
      }
      out.limit = Math.trunc(parsed);
    } else {
      out.positional.push(arg);
    }
  }
  if (out.json && out.csv) {
    throw new Error('choose only one of --json or --csv');
  }
  return out;
}

function usage(scriptName, description) {
  return [
    `Usage: node scripts/${scriptName} [--limit N] [--json] [--csv]`,
    '',
    description,
    '',
    'Reads from DATABASE_URL_PUBLIC only. Writes nothing.',
  ].join('\n');
}

function stringifyCell(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toCsv(rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  const escape = (value) => {
    const raw = stringifyCell(value);
    return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => escape(row[column])).join(',')),
  ].join('\n');
}

function toTable(rows) {
  if (!rows.length) return '(no rows)';
  const columns = Object.keys(rows[0]);
  const widths = columns.map((column) => {
    const values = rows.map((row) => stringifyCell(row[column]));
    return Math.min(80, Math.max(column.length, ...values.map((value) => value.length)));
  });
  const render = (values) =>
    values
      .map((value, idx) => {
        const raw = stringifyCell(value);
        const clipped = raw.length > widths[idx] ? `${raw.slice(0, widths[idx] - 1)}…` : raw;
        return clipped.padEnd(widths[idx], ' ');
      })
      .join('  ');
  return [
    render(columns),
    render(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => render(columns.map((column) => row[column]))),
  ].join('\n');
}

function printRows(rows, args) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else if (args.csv) {
    process.stdout.write(`${toCsv(rows)}\n`);
  } else {
    process.stdout.write(`${toTable(rows)}\n`);
  }
}

module.exports = {
  parseCommonArgs,
  printRows,
  toCsv,
  toTable,
  usage,
};
