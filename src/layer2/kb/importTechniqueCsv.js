const fs = require('node:fs');
const path = require('node:path');

const { TechniqueCardV0Schema } = require('../schemas/techniqueCardV0');
const { loadTriggerKeysLatest, isTriggerKeyAllowed } = require('../dicts/triggerKeys');
const { loadRolesLatest, buildRoleNormalizer } = require('../dicts/roles');

function assertNever(x) {
  throw new Error(`Unexpected value: ${x}`);
}

function stableStringify(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function parseCsvString(csvText) {
  const text = String(csvText ?? '');
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let inQuotes = false;

  const pushCell = () => {
    row.push(cell);
    cell = '';
  };

  const pushRow = () => {
    // Ignore trailing empty row.
    if (row.length === 1 && row[0] === '') {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ',') {
      pushCell();
      i += 1;
      continue;
    }

    if (ch === '\n') {
      pushCell();
      pushRow();
      i += 1;
      continue;
    }

    if (ch === '\r') {
      // Ignore CR (CRLF handled when seeing LF).
      i += 1;
      continue;
    }

    cell += ch;
    i += 1;
  }

  pushCell();
  pushRow();

  if (inQuotes) {
    throw new Error('Invalid CSV: unterminated quote');
  }

  if (rows.length === 0) {
    throw new Error('Invalid CSV: empty file');
  }

  const headers = rows[0].map((h) => String(h ?? '').trim());
  const dataRows = rows.slice(1);

  const objects = dataRows.map((r) => {
    const obj = {};
    for (let col = 0; col < headers.length; col += 1) {
      const key = headers[col] ?? '';
      obj[key] = r[col] ?? '';
    }
    return obj;
  });

  return { headers, rows: objects };
}

function parseBooleanOrNumberOrString(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseInList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map(parseBooleanOrNumberOrString);
}

function parseBetween(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('between requires a value');

  const parts = s.includes('..') ? s.split('..') : s.split(',');
  if (parts.length !== 2) throw new Error('between value must be "min..max" or "min,max"');

  const min = Number(String(parts[0]).trim());
  const max = Number(String(parts[1]).trim());
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('between min/max must be numbers');
  return { min, max };
}

function parseConditionDsl(expr) {
  const s = String(expr ?? '').trim();
  if (!s) return null;

  const m = s.match(/^(\S+)\s+(eq|neq|lt|lte|gt|gte|in|between|exists)(?:\s+(.*))?$/);
  if (!m) {
    throw new Error(`Invalid trigger condition: "${s}" (expected: "key op value")`);
  }

  const key = m[1];
  const op = m[2];
  const valueRaw = (m[3] ?? '').trim();

  switch (op) {
    case 'exists':
      return { key, op };
    case 'between': {
      const { min, max } = parseBetween(valueRaw);
      return { key, op, min, max };
    }
    case 'in': {
      const list = parseInList(valueRaw);
      if (list.length === 0) throw new Error('in requires a non-empty comma list');
      return { key, op, value: list };
    }
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const v = parseBooleanOrNumberOrString(valueRaw);
      if (v === '') throw new Error(`${op} requires a value`);
      return { key, op, value: v };
    }
    default:
      return assertNever(op);
  }
}

function parseTriggerCell(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return [];

  const out = [];
  for (const part of s.split(';')) {
    const expr = part.trim();
    if (!expr) continue;
    const cond = parseConditionDsl(expr);
    if (!cond) continue;
    out.push(cond);
  }
  return out;
}

function stripLanguagePreferenceModeConditions(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return [];

  // This repo uses `preferenceMode` for "structure|vibe|ease". Some content CSVs
  // include `preferenceMode eq en/zh` as a language gate; we intentionally strip
  // those so language routing is handled by the `-en` / `-zh` id suffix resolver.
  const forbidden = new Set(['en', 'zh', 'ja']);

  return conditions.filter((c) => {
    if (!c || c.key !== 'preferenceMode') return true;

    if (c.op === 'eq' || c.op === 'neq') {
      return typeof c.value !== 'string' || !forbidden.has(c.value);
    }

    if (c.op === 'in') {
      if (!Array.isArray(c.value)) return true;
      return !c.value.some((v) => typeof v === 'string' && forbidden.has(v));
    }

    return true;
  });
}

function parseTagsCell(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return [];

  const delimiter = s.includes(';') ? ';' : ',';
  return s
    .split(delimiter)
    .map((t) => t.trim())
    .filter(Boolean);
}

function normalizeReviewStatusTag(reviewStatusRaw) {
  const s = String(reviewStatusRaw ?? '').trim();
  if (!s) return null;
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!slug) return null;
  return `reviewStatus:${slug}`;
}

function buildTechniqueCardFromCsvRow(row, options) {
  const market = String(options.market ?? '').toUpperCase();
  if (market !== 'US' && market !== 'JP') throw new Error(`Invalid market "${options.market}"`);

  const triggerKeyDict = options.triggerKeyDict ?? loadTriggerKeysLatest();
  const rolesDict = options.rolesDict ?? loadRolesLatest();
  const roleNormalizer = options.roleNormalizer ?? buildRoleNormalizer(rolesDict);

  const id = String(row.id ?? '').trim();
  const rowMarket = String(row.market ?? '').trim().toUpperCase();
  const area = String(row.area ?? '').trim();
  const difficulty = String(row.difficulty ?? '').trim();
  const title = String(row.title ?? '').trim();

  if (!id) throw new Error('Missing id');
  if (rowMarket && rowMarket !== market) throw new Error(`Row market "${rowMarket}" does not match --market "${market}"`);
  if (!area) throw new Error('Missing area');
  if (!difficulty) throw new Error('Missing difficulty');
  if (!title) throw new Error('Missing title');

  const triggerAll = stripLanguagePreferenceModeConditions(parseTriggerCell(row.trigger_all));
  const triggerAny = stripLanguagePreferenceModeConditions(parseTriggerCell(row.trigger_any));
  const triggerNone = stripLanguagePreferenceModeConditions(parseTriggerCell(row.trigger_none));
  const allConditions = [...triggerAll, ...triggerAny, ...triggerNone];

  for (const c of allConditions) {
    if (!isTriggerKeyAllowed(c.key, triggerKeyDict)) {
      throw new Error(`Trigger key not allowed: "${c.key}"`);
    }
  }

  const steps = [];
  for (let i = 1; i <= 6; i += 1) {
    const raw = String(row[`step${i}`] ?? '').trim();
    if (!raw) continue;
    if (raw.length > 120) throw new Error(`step${i} too long (${raw.length} > 120)`);
    steps.push(raw);
  }
  if (steps.length < 2 || steps.length > 6) {
    throw new Error(`Expected 2–6 steps, got ${steps.length}`);
  }

  const whys = [];
  for (let i = 1; i <= 3; i += 1) {
    const raw = String(row[`why${i}`] ?? '').trim();
    if (!raw) continue;
    whys.push(raw);
  }
  if (whys.length === 0) throw new Error('Expected at least 1 rationale (why1..why3)');

  const roleHints = [];
  for (let i = 1; i <= 5; i += 1) {
    const raw = String(row[`productRoleHint${i}`] ?? '').trim();
    if (!raw) continue;
    const normalized = roleNormalizer.normalizeRoleHint(raw);
    if (!normalized) throw new Error(`Unknown productRoleHint${i}: "${raw}"`);
    roleHints.push(normalized);
  }

  const sourceId = String(row.sourceId ?? '').trim();
  const sourcePointer = String(row.sourcePointer ?? '').trim();
  const tags = parseTagsCell(row.tags);
  const reviewStatusTag = normalizeReviewStatusTag(row.reviewStatus);
  const tagsFinal = [];
  if (reviewStatusTag) tagsFinal.push(reviewStatusTag);
  for (const t of tags) {
    if (!tagsFinal.includes(t)) tagsFinal.push(t);
  }

  // Construct in stable key order for deterministic JSON output.
  const card = {
    schemaVersion: 'v0',
    market,
    id,
    area,
    difficulty,
    triggers: {
      ...(triggerAll.length ? { all: triggerAll } : {}),
      ...(triggerAny.length ? { any: triggerAny } : {}),
      ...(triggerNone.length ? { none: triggerNone } : {}),
    },
    actionTemplate: {
      title,
      steps,
    },
    rationaleTemplate: whys,
    ...(roleHints.length ? { productRoleHints: roleHints } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(sourcePointer ? { sourcePointer } : {}),
    ...(tagsFinal.length ? { tags: tagsFinal } : {}),
  };

  const parsed = TechniqueCardV0Schema.safeParse(card);
  if (!parsed.success) {
    const zodMsg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`TechniqueCardV0 validation failed: ${zodMsg}`);
  }

  return parsed.data;
}

function writeTechniqueCardJsonFile(outDir, card) {
  const filePath = path.join(outDir, `${card.id}.json`);
  fs.writeFileSync(filePath, stableStringify(card), 'utf8');
  return filePath;
}

module.exports = {
  parseCsvString,
  parseConditionDsl,
  parseTriggerCell,
  buildTechniqueCardFromCsvRow,
  writeTechniqueCardJsonFile,
  stableStringify,
};
