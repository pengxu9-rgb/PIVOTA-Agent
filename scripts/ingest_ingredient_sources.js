#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const axios = require('axios');
const {
  SCHEMA_VERSION,
  createCitationHash,
  assertValidIngredientKbV2,
  citationSchema,
} = require('../src/auroraBff/ingredientKbV2/types');
const { detectBannedClaimTerms } = require('../src/auroraBff/ingredientKbV2/claimGuard');

const SUPPORTED_MARKETS = new Set(['EU', 'CN', 'JP', 'US', 'GLOBAL']);
const COSING_DEFAULT_URL =
  'https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-ingredients_en';
const DEFAULT_POLICY_REF_URL = 'https://www.fda.gov/cosmetics/cosmetics-laws-regulations';
const MANIFEST_SCHEMA_VERSION = 'aurora.ingredient_kb_v2.manifest.v1';

const ZH_NAME_MAP = Object.freeze({
  niacinamide: '烟酰胺',
  salicylic_acid: '水杨酸',
  retinol: '视黄醇',
  panthenol: '泛醇',
  ceramide_np: '神经酰胺 NP',
  zinc_pca: 'PCA 锌',
  azelaic_acid: '壬二酸',
  ascorbic_acid: '抗坏血酸',
});

const RISK_PROFILE = Object.freeze({
  retinol: {
    do_not_mix: ['Strong acids', 'Benzoyl peroxide in same routine'],
    risk_flags: ['pregnancy_unknown', 'sensitive'],
    safety_notes: [
      'Use in PM routines and start with low frequency.',
      'Increase only when skin tolerance remains stable.',
    ],
  },
  salicylic_acid: {
    do_not_mix: ['Retinoid in same routine when irritation-prone'],
    risk_flags: ['sensitive'],
    safety_notes: ['Avoid over-exfoliation and monitor dryness.'],
  },
  niacinamide: {
    do_not_mix: [],
    risk_flags: [],
    safety_notes: ['Reduce frequency if persistent flushing appears.'],
  },
});

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/ingest_ingredient_sources.js [options]',
      '',
      'Options:',
      '  --data-dir <path>              default: data/external',
      '  --artifact-path <path>         default: artifacts/ingredient_kb_v2.json',
      '  --manifest-path <path>         default: artifacts/manifest.json',
      '  --sources-report <path>        default: reports/ingredient_kb_sources_report.md',
      '  --claims-audit-report <path>   default: reports/ingredient_kb_claims_audit.md',
      '  --dry-run                      validate and report only; do not write artifacts',
      '  --audit-only                   run audit against existing artifact',
      '  --fetch-live                   fetch SCCS/CIR pages to enrich title/excerpt',
      '  --fail-on-audit                exit non-zero if audit fails',
      '  --timeout-ms <n>               default: 8000',
      '  --help',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const out = {
    dataDir: path.join('data', 'external'),
    artifactPath: path.join('artifacts', 'ingredient_kb_v2.json'),
    manifestPath: path.join('artifacts', 'manifest.json'),
    sourcesReportPath: path.join('reports', 'ingredient_kb_sources_report.md'),
    claimsAuditReportPath: path.join('reports', 'ingredient_kb_claims_audit.md'),
    dryRun: false,
    auditOnly: false,
    fetchLive: false,
    failOnAudit: false,
    timeoutMs: 8000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--audit-only') {
      out.auditOnly = true;
      continue;
    }
    if (arg === '--fetch-live') {
      out.fetchLive = true;
      continue;
    }
    if (arg === '--fail-on-audit') {
      out.failOnAudit = true;
      continue;
    }
    const next = argv[i + 1];
    const take = () => {
      if (typeof next !== 'string') throw new Error(`Missing value for ${arg}`);
      i += 1;
      return next;
    };
    if (arg === '--data-dir') out.dataDir = take();
    else if (arg === '--artifact-path') out.artifactPath = take();
    else if (arg === '--manifest-path') out.manifestPath = take();
    else if (arg === '--sources-report') out.sourcesReportPath = take();
    else if (arg === '--claims-audit-report') out.claimsAuditReportPath = take();
    else if (arg === '--timeout-ms') out.timeoutMs = Math.max(1000, Math.min(20000, Number(take()) || 8000));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeText(filePath, text) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, text, 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function truncate(text, max = 240) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function normalizeIngredientId(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return value;
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
        if (text[i + 1] === '"') {
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
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }

  pushCell();
  pushRow();
  if (inQuotes) throw new Error('Invalid CSV: unterminated quote');
  if (!rows.length) throw new Error('Invalid CSV: empty file');

  const headers = rows[0].map((h) => String(h || '').trim());
  return rows.slice(1).map((line) => {
    const out = {};
    for (let idx = 0; idx < headers.length; idx += 1) out[headers[idx]] = line[idx] || '';
    return out;
  });
}

function splitPipes(value) {
  return String(value || '')
    .split('|')
    .map((token) => token.trim())
    .filter(Boolean);
}

function splitMarkets(value) {
  const markets = splitPipes(value).map((token) => token.toUpperCase());
  const valid = markets.filter((token) => SUPPORTED_MARKETS.has(token));
  return valid.length ? valid : ['EU', 'CN', 'JP', 'US'];
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function sha256File(filePath) {
  return sha256Hex(fs.readFileSync(filePath));
}

function fileMtimeIso(filePath) {
  const stats = fs.statSync(filePath);
  return new Date(stats.mtimeMs || Date.now()).toISOString();
}

function parseHtmlTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return truncate(match[1].replace(/\s+/g, ' '), 240);
}

function parseHtmlExcerpt(html) {
  const stripped = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(stripped, 240);
}

async function fetchCitationMetadata(url, timeoutMs) {
  const response = await axios.get(url, {
    timeout: timeoutMs,
    maxRedirects: 3,
    validateStatus: () => true,
    responseType: 'text',
    headers: {
      'User-Agent': 'AuroraIngredientKbIngest/1.0 (+https://aurora.pivota.cc)',
    },
  });
  if (response.status >= 400) {
    return {
      ok: false,
      status: response.status,
      error: `HTTP_${response.status}`,
      title: '',
      excerpt: '',
    };
  }
  const body = typeof response.data === 'string' ? response.data : String(response.data || '');
  return {
    ok: true,
    status: response.status,
    error: null,
    title: parseHtmlTitle(body),
    excerpt: parseHtmlExcerpt(body),
  };
}

function makeCitation({
  sourceUrl,
  docTitle,
  publisher,
  publishedAt,
  retrievedAt,
  excerpt,
  licenseHint,
}) {
  const normalized = {
    source_url: String(sourceUrl || '').trim(),
    doc_title: truncate(docTitle || 'Untitled source', 240),
    publisher: truncate(publisher || 'Unknown publisher', 160),
    published_at: toIsoOrNull(publishedAt),
    retrieved_at: toIsoOrNull(retrievedAt) || nowIso(),
    excerpt: truncate(excerpt || docTitle || 'Reference summary', 240),
    hash: '',
    license_hint: licenseHint ? truncate(licenseHint, 200) : null,
  };
  normalized.hash = createCitationHash([
    normalized.source_url,
    normalized.doc_title,
    normalized.publisher,
    normalized.published_at || '',
    normalized.excerpt,
  ]);
  return citationSchema.parse(normalized);
}

function stableStringify(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function fallbackPolicyCitation(market, retrievedAt) {
  const summaryByMarket = {
    EU: 'EU cosmetic ingredient communication should stay within cosmetic scope.',
    CN: 'CN cosmetics claims should remain cosmetic and supported by evidence.',
    JP: 'JP cosmetics claims should avoid medical treatment framing.',
    US: 'US cosmetics language should avoid disease treatment implications.',
  };
  return makeCitation({
    sourceUrl: DEFAULT_POLICY_REF_URL,
    docTitle: `${market} Cosmetic Claims Policy (fallback)`,
    publisher: 'Aurora Internal Compliance',
    publishedAt: null,
    retrievedAt,
    excerpt: summaryByMarket[market] || summaryByMarket.US,
    licenseHint: 'Internal policy synthesis from public references',
  });
}

function loadPolicyDocs(policiesDir, retrievedAt) {
  const out = { EU: [], CN: [], JP: [], US: [] };
  if (!fs.existsSync(policiesDir)) return out;
  const files = fs
    .readdirSync(policiesDir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort();
  for (const name of files) {
    const filePath = path.join(policiesDir, name);
    const row = readJson(filePath);
    const market = String(row.market || '').trim().toUpperCase();
    if (!SUPPORTED_MARKETS.has(market) || market === 'GLOBAL') continue;
    out[market].push(
      makeCitation({
        sourceUrl: row.source_url,
        docTitle: row.doc_title,
        publisher: row.publisher,
        publishedAt: row.published_at,
        retrievedAt,
        excerpt: row.summary || row.excerpt || row.doc_title,
        licenseHint: row.license_hint,
      }),
    );
  }
  for (const market of ['EU', 'CN', 'JP', 'US']) {
    if (!out[market].length) out[market].push(fallbackPolicyCitation(market, retrievedAt));
  }
  return out;
}

function dedupeCitations(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const key = `${row.hash || ''}::${row.source_url || ''}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function makeCosingCitation({ inciName, ingredientId, retrievedAt }) {
  return makeCitation({
    sourceUrl: COSING_DEFAULT_URL,
    docTitle: `CosIng snapshot: ${inciName}`,
    publisher: 'European Commission CosIng',
    publishedAt: null,
    retrievedAt,
    excerpt: `CosIng snapshot row for ${ingredientId || inciName}.`,
    licenseHint: 'Public database metadata',
  });
}

function makeRiskProfile(ingredientId) {
  return RISK_PROFILE[ingredientId] || { do_not_mix: [], risk_flags: [], safety_notes: [] };
}

function computeEvidenceGrade({ hasSccs, hasCir }) {
  if (hasSccs && hasCir) return 'A';
  if (hasSccs || hasCir) return 'B';
  return 'C';
}

function buildClaimsForIngredient({ ingredientId, functions, marketScope, citations, evidenceGrade }) {
  const claims = [];
  const seen = new Set();
  const selectedFunctions = functions.slice(0, 3);
  for (let i = 0; i < selectedFunctions.length; i += 1) {
    const fn = selectedFunctions[i];
    const text = truncate(`Supports cosmetic ${fn.replace(/[_-]+/g, ' ')} outcomes.`);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    claims.push({
      claim_id: `${ingredientId}_claim_${String(i + 1).padStart(2, '0')}`,
      claim_text: text,
      evidence_grade: evidenceGrade,
      market_scope: marketScope,
      citations: citations.slice(0, 4),
      risk_flags: makeRiskProfile(ingredientId).risk_flags,
    });
  }
  if (!claims.length) {
    claims.push({
      claim_id: `${ingredientId}_claim_01`,
      claim_text: 'Supports cosmetic skin comfort.',
      evidence_grade: evidenceGrade,
      market_scope: marketScope,
      citations: citations.slice(0, 4),
      risk_flags: makeRiskProfile(ingredientId).risk_flags,
    });
  }
  return claims;
}

function buildSafetyNotes({ ingredientId, restrictions, marketScope, citations, evidenceGrade }) {
  const notes = [];
  const profile = makeRiskProfile(ingredientId);
  const normalizedRestrictions = restrictions.slice(0, 3);
  for (let i = 0; i < normalizedRestrictions.length; i += 1) {
    notes.push({
      note_id: `${ingredientId}_safety_${String(i + 1).padStart(2, '0')}`,
      note_text: truncate(normalizedRestrictions[i]),
      evidence_grade: evidenceGrade,
      market_scope: marketScope,
      citations: citations.slice(0, 4),
      risk_flags: profile.risk_flags,
    });
  }
  for (let i = 0; i < profile.safety_notes.length; i += 1) {
    notes.push({
      note_id: `${ingredientId}_safety_profile_${String(i + 1).padStart(2, '0')}`,
      note_text: truncate(profile.safety_notes[i]),
      evidence_grade: evidenceGrade,
      market_scope: marketScope,
      citations: citations.slice(0, 4),
      risk_flags: profile.risk_flags,
    });
  }
  return notes.slice(0, 5);
}

function countRecords(obj) {
  if (Array.isArray(obj)) return obj.length;
  if (obj && typeof obj === 'object') return Object.values(obj).reduce((acc, value) => acc + countRecords(value), 0);
  return 0;
}

function collectManifestEntry({ source, filePath, recordCount, licenseHint }) {
  return {
    source,
    license_hint: licenseHint || null,
    retrieved_at: fileMtimeIso(filePath),
    sha256: sha256File(filePath),
    file_path: filePath,
    record_count: recordCount,
  };
}

function summarizeDataset(dataset) {
  const ingredients = Array.isArray(dataset.ingredients) ? dataset.ingredients : [];
  const claimCount = ingredients.reduce((acc, row) => acc + (Array.isArray(row.claims) ? row.claims.length : 0), 0);
  const safetyCount = ingredients.reduce((acc, row) => acc + (Array.isArray(row.safety_notes) ? row.safety_notes.length : 0), 0);
  const citationCount = ingredients.reduce((acc, row) => {
    const fromClaims = (row.claims || []).reduce((n, c) => n + ((c.citations || []).length || 0), 0);
    const fromSafety = (row.safety_notes || []).reduce((n, c) => n + ((c.citations || []).length || 0), 0);
    return acc + fromClaims + fromSafety;
  }, 0);
  return {
    ingredientCount: ingredients.length,
    claimCount,
    safetyCount,
    citationCount,
  };
}

function diffSummary(current, previous) {
  if (!previous) {
    return {
      ingredientDelta: current.ingredientCount,
      claimDelta: current.claimCount,
      safetyDelta: current.safetyCount,
      citationDelta: current.citationCount,
    };
  }
  return {
    ingredientDelta: current.ingredientCount - previous.ingredientCount,
    claimDelta: current.claimCount - previous.claimCount,
    safetyDelta: current.safetyCount - previous.safetyCount,
    citationDelta: current.citationCount - previous.citationCount,
  };
}

function auditDataset(dataset) {
  const violations = [];
  const citationErrors = [];

  const inspectText = (text, context) => {
    const hits = detectBannedClaimTerms(text);
    if (hits.length) {
      violations.push({
        context,
        text: String(text || ''),
        hits,
      });
    }
  };

  const checkCitation = (citation, context) => {
    const parsed = citationSchema.safeParse(citation);
    if (!parsed.success) {
      citationErrors.push({
        context,
        issue: parsed.error.issues[0] ? parsed.error.issues[0].message : 'invalid citation',
      });
    }
  };

  const ingredients = Array.isArray(dataset.ingredients) ? dataset.ingredients : [];
  for (const ingredient of ingredients) {
    const ingredientId = ingredient.ingredient_id;
    for (const claim of ingredient.claims || []) {
      inspectText(claim.claim_text, `claim:${ingredientId}:${claim.claim_id}`);
      if (!Array.isArray(claim.citations) || !claim.citations.length) {
        citationErrors.push({
          context: `claim:${ingredientId}:${claim.claim_id}`,
          issue: 'missing citations',
        });
      }
      for (const citation of claim.citations || []) checkCitation(citation, `claim:${ingredientId}:${claim.claim_id}`);
    }
    for (const note of ingredient.safety_notes || []) {
      inspectText(note.note_text, `safety_note:${ingredientId}:${note.note_id}`);
      if (!Array.isArray(note.citations) || !note.citations.length) {
        citationErrors.push({
          context: `safety_note:${ingredientId}:${note.note_id}`,
          issue: 'missing citations',
        });
      }
      for (const citation of note.citations || []) checkCitation(citation, `safety_note:${ingredientId}:${note.note_id}`);
    }
  }

  for (const market of ['EU', 'CN', 'JP', 'US']) {
    const policyCitations = dataset.market_policy_docs && Array.isArray(dataset.market_policy_docs[market])
      ? dataset.market_policy_docs[market]
      : [];
    if (!policyCitations.length) {
      citationErrors.push({ context: `market_policy:${market}`, issue: 'missing policy citation' });
    }
    for (const citation of policyCitations) checkCitation(citation, `market_policy:${market}`);
  }

  return {
    pass: violations.length === 0 && citationErrors.length === 0,
    violations,
    citationErrors,
  };
}

function renderSourcesReport({
  now,
  dryRun,
  dataDir,
  sourceEntries,
  fetchDiagnostics,
  currentSummary,
  previousSummary,
  diff,
  artifactPath,
}) {
  const lines = [];
  lines.push('# Ingredient KB Sources Report');
  lines.push('');
  lines.push(`- generated_at: ${now}`);
  lines.push(`- data_dir: \`${dataDir}\``);
  lines.push(`- dry_run: ${dryRun ? 'true' : 'false'}`);
  lines.push(`- artifact_path: \`${artifactPath}\``);
  lines.push('');

  lines.push('## Source Manifest');
  lines.push('');
  lines.push('| source | file_path | record_count | sha256 | retrieved_at | license_hint |');
  lines.push('| --- | --- | ---: | --- | --- | --- |');
  for (const row of sourceEntries) {
    lines.push(
      `| ${row.source} | \`${row.file_path}\` | ${row.record_count} | \`${row.sha256.slice(0, 16)}…\` | ${row.retrieved_at} | ${row.license_hint || 'n/a'} |`,
    );
  }
  lines.push('');

  lines.push('## Dataset Summary');
  lines.push('');
  lines.push(`- ingredient_count: ${currentSummary.ingredientCount}`);
  lines.push(`- claim_count: ${currentSummary.claimCount}`);
  lines.push(`- safety_note_count: ${currentSummary.safetyCount}`);
  lines.push(`- citation_count: ${currentSummary.citationCount}`);
  if (previousSummary) {
    lines.push(`- previous_ingredient_count: ${previousSummary.ingredientCount}`);
    lines.push(`- previous_claim_count: ${previousSummary.claimCount}`);
    lines.push(`- previous_safety_note_count: ${previousSummary.safetyCount}`);
    lines.push(`- previous_citation_count: ${previousSummary.citationCount}`);
  }
  lines.push(`- ingredient_delta: ${diff.ingredientDelta >= 0 ? '+' : ''}${diff.ingredientDelta}`);
  lines.push(`- claim_delta: ${diff.claimDelta >= 0 ? '+' : ''}${diff.claimDelta}`);
  lines.push(`- safety_note_delta: ${diff.safetyDelta >= 0 ? '+' : ''}${diff.safetyDelta}`);
  lines.push(`- citation_delta: ${diff.citationDelta >= 0 ? '+' : ''}${diff.citationDelta}`);
  lines.push('');

  lines.push('## Live Fetch Diagnostics');
  lines.push('');
  if (!fetchDiagnostics.length) {
    lines.push('_No live fetch diagnostics (run with `--fetch-live` to populate)._');
    lines.push('');
  } else {
    lines.push('| ingredient_id | source | url | status | note |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of fetchDiagnostics) {
      lines.push(
        `| ${row.ingredient_id} | ${row.source} | \`${row.url}\` | ${row.status} | ${row.note || 'n/a'} |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function renderClaimsAuditReport({ now, audit }) {
  const lines = [];
  lines.push('# Ingredient KB Claims Audit');
  lines.push('');
  lines.push(`- generated_at: ${now}`);
  lines.push(`- pass: ${audit.pass ? 'true' : 'false'}`);
  lines.push(`- banned_claim_violations: ${audit.violations.length}`);
  lines.push(`- citation_errors: ${audit.citationErrors.length}`);
  lines.push('');

  lines.push('## Banned Claim Violations');
  lines.push('');
  if (!audit.violations.length) {
    lines.push('_No banned-claim violations detected._');
    lines.push('');
  } else {
    lines.push('| context | text | hits |');
    lines.push('| --- | --- | --- |');
    for (const row of audit.violations.slice(0, 200)) {
      lines.push(`| ${row.context} | ${truncate(row.text, 180)} | ${row.hits.map((h) => `\`${h}\``).join(', ')} |`);
    }
    lines.push('');
  }

  lines.push('## Citation Completeness Errors');
  lines.push('');
  if (!audit.citationErrors.length) {
    lines.push('_No citation completeness errors detected._');
    lines.push('');
  } else {
    lines.push('| context | issue |');
    lines.push('| --- | --- |');
    for (const row of audit.citationErrors.slice(0, 300)) {
      lines.push(`| ${row.context} | ${row.issue} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function maybeEnrichSourceCitation(baseRow, { fetchLive, timeoutMs }) {
  if (!fetchLive) return { citation: baseRow, diagnostic: null };
  try {
    const fetched = await fetchCitationMetadata(baseRow.source_url, timeoutMs);
    if (!fetched.ok) {
      return {
        citation: baseRow,
        diagnostic: {
          status: 'MISSING',
          note: fetched.error || 'fetch_failed',
        },
      };
    }
    const citation = {
      ...baseRow,
      doc_title: fetched.title || baseRow.doc_title,
      excerpt: fetched.excerpt || baseRow.excerpt,
    };
    return {
      citation,
      diagnostic: {
        status: 'OK',
        note: `HTTP_${fetched.status || 200}`,
      },
    };
  } catch (error) {
    return {
      citation: baseRow,
      diagnostic: {
        status: 'MISSING',
        note: String(error && error.message ? error.message : error),
      },
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const now = nowIso();
  const artifactPath = path.resolve(args.artifactPath);
  const manifestPath = path.resolve(args.manifestPath);
  const sourcesReportPath = path.resolve(args.sourcesReportPath);
  const claimsAuditReportPath = path.resolve(args.claimsAuditReportPath);

  if (args.auditOnly) {
    const dataset = assertValidIngredientKbV2(readJson(artifactPath));
    const audit = auditDataset(dataset);
    writeText(claimsAuditReportPath, renderClaimsAuditReport({ now, audit }));
    console.log(claimsAuditReportPath);
    if (args.failOnAudit && !audit.pass) process.exit(1);
    return;
  }

  const dataDir = path.resolve(args.dataDir);
  const cosingDir = path.join(dataDir, 'cosing');
  const sccsPath = path.join(dataDir, 'sccs', 'seed_mapping.json');
  const cirPath = path.join(dataDir, 'cir', 'seed_mapping.json');
  const policiesDir = path.join(dataDir, 'policies');

  const cosingFile = fs
    .readdirSync(cosingDir)
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .sort()[0];
  if (!cosingFile) throw new Error(`No CosIng snapshot CSV found in ${cosingDir}`);
  const cosingPath = path.join(cosingDir, cosingFile);

  const cosingRows = parseCsvString(fs.readFileSync(cosingPath, 'utf8'));
  const sccsMap = fs.existsSync(sccsPath) ? readJson(sccsPath) : {};
  const cirMap = fs.existsSync(cirPath) ? readJson(cirPath) : {};
  const policyDocs = loadPolicyDocs(policiesDir, now);

  const manifests = [];
  manifests.push(
    collectManifestEntry({
      source: 'cosing_snapshot',
      filePath: cosingPath,
      recordCount: cosingRows.length,
      licenseHint: 'Public database metadata',
    }),
  );
  if (fs.existsSync(sccsPath)) {
    manifests.push(
      collectManifestEntry({
        source: 'sccs_seed_mapping',
        filePath: sccsPath,
        recordCount: countRecords(sccsMap),
        licenseHint: 'Public institutional index',
      }),
    );
  }
  if (fs.existsSync(cirPath)) {
    manifests.push(
      collectManifestEntry({
        source: 'cir_seed_mapping',
        filePath: cirPath,
        recordCount: countRecords(cirMap),
        licenseHint: 'Public report index',
      }),
    );
  }
  if (fs.existsSync(policiesDir)) {
    const policyFiles = fs
      .readdirSync(policiesDir)
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .sort();
    for (const name of policyFiles) {
      const filePath = path.join(policiesDir, name);
      const row = readJson(filePath);
      manifests.push(
        collectManifestEntry({
          source: `policy_${String(row.market || 'unknown').toLowerCase()}`,
          filePath,
          recordCount: 1,
          licenseHint: row.license_hint || 'Public regulatory document',
        }),
      );
    }
  }

  const fetchDiagnostics = [];
  const ingredients = [];
  for (const row of cosingRows) {
    const ingredientId = normalizeIngredientId(row.ingredient_id || row.inci_name);
    if (!ingredientId) continue;
    const inciName = truncate(row.inci_name || row.ingredient_id || ingredientId, 240);
    const functions = splitPipes(row.functions);
    const restrictions = splitPipes(row.restrictions);
    const marketScope = splitMarkets(row.market_scope);
    const retrievedAt = now;

    const cosingCitation = makeCosingCitation({
      inciName,
      ingredientId,
      retrievedAt,
    });

    const sccsRaw = Array.isArray(sccsMap[ingredientId]) ? sccsMap[ingredientId] : [];
    const cirRaw = Array.isArray(cirMap[ingredientId]) ? cirMap[ingredientId] : [];

    const sccsCitations = [];
    for (const rawSource of sccsRaw) {
      const base = makeCitation({
        sourceUrl: rawSource.source_url,
        docTitle: rawSource.doc_title,
        publisher: rawSource.publisher || 'European Commission SCCS',
        publishedAt: rawSource.published_at,
        retrievedAt,
        excerpt: rawSource.excerpt || rawSource.doc_title,
        licenseHint: rawSource.license_hint,
      });
      const enriched = await maybeEnrichSourceCitation(base, {
        fetchLive: args.fetchLive,
        timeoutMs: args.timeoutMs,
      });
      sccsCitations.push(
        makeCitation({
          sourceUrl: enriched.citation.source_url,
          docTitle: enriched.citation.doc_title,
          publisher: enriched.citation.publisher,
          publishedAt: enriched.citation.published_at,
          retrievedAt: enriched.citation.retrieved_at,
          excerpt: enriched.citation.excerpt,
          licenseHint: enriched.citation.license_hint,
        }),
      );
      if (enriched.diagnostic) {
        fetchDiagnostics.push({
          ingredient_id: ingredientId,
          source: 'sccs',
          url: base.source_url,
          status: enriched.diagnostic.status,
          note: enriched.diagnostic.note,
        });
      }
    }

    const cirCitations = [];
    for (const rawSource of cirRaw) {
      const base = makeCitation({
        sourceUrl: rawSource.source_url,
        docTitle: rawSource.doc_title,
        publisher: rawSource.publisher || 'Cosmetic Ingredient Review',
        publishedAt: rawSource.published_at,
        retrievedAt,
        excerpt: rawSource.excerpt || rawSource.doc_title,
        licenseHint: rawSource.license_hint,
      });
      const enriched = await maybeEnrichSourceCitation(base, {
        fetchLive: args.fetchLive,
        timeoutMs: args.timeoutMs,
      });
      cirCitations.push(
        makeCitation({
          sourceUrl: enriched.citation.source_url,
          docTitle: enriched.citation.doc_title,
          publisher: enriched.citation.publisher,
          publishedAt: enriched.citation.published_at,
          retrievedAt: enriched.citation.retrieved_at,
          excerpt: enriched.citation.excerpt,
          licenseHint: enriched.citation.license_hint,
        }),
      );
      if (enriched.diagnostic) {
        fetchDiagnostics.push({
          ingredient_id: ingredientId,
          source: 'cir',
          url: base.source_url,
          status: enriched.diagnostic.status,
          note: enriched.diagnostic.note,
        });
      }
    }

    const citations = dedupeCitations([cosingCitation, ...sccsCitations, ...cirCitations]);
    const evidenceGrade = computeEvidenceGrade({
      hasSccs: sccsCitations.length > 0,
      hasCir: cirCitations.length > 0,
    });
    const profile = makeRiskProfile(ingredientId);

    const ingredient = {
      ingredient_id: ingredientId,
      inci_name: inciName,
      zh_name: ZH_NAME_MAP[ingredientId] || null,
      aliases: [],
      identifiers: {
        cosing_id: row.cosing_id ? String(row.cosing_id).trim() : null,
        cas_no: row.cas_no ? String(row.cas_no).trim() : null,
        ec_no: row.ec_no ? String(row.ec_no).trim() : null,
      },
      functions,
      restrictions,
      evidence_grade: evidenceGrade,
      market_scope: marketScope,
      claims: buildClaimsForIngredient({
        ingredientId,
        functions,
        marketScope,
        citations,
        evidenceGrade,
      }),
      safety_notes: buildSafetyNotes({
        ingredientId,
        restrictions,
        marketScope,
        citations,
        evidenceGrade,
      }),
      do_not_mix: profile.do_not_mix,
      manifest_refs: manifests.map((entry) => entry.source),
    };
    ingredients.push(ingredient);
  }

  const dataset = assertValidIngredientKbV2({
    schema_version: SCHEMA_VERSION,
    generated_at: now,
    ingredients,
    manifests,
    market_policy_docs: policyDocs,
  });

  const audit = auditDataset(dataset);
  const previousDataset = fs.existsSync(artifactPath)
    ? (() => {
      try {
        return assertValidIngredientKbV2(readJson(artifactPath));
      } catch {
        return null;
      }
    })()
    : null;
  const currentSummary = summarizeDataset(dataset);
  const previousSummary = previousDataset ? summarizeDataset(previousDataset) : null;
  const diff = diffSummary(currentSummary, previousSummary);

  const sourceReport = renderSourcesReport({
    now,
    dryRun: args.dryRun,
    dataDir,
    sourceEntries: manifests,
    fetchDiagnostics,
    currentSummary,
    previousSummary,
    diff,
    artifactPath,
  });
  const claimsAuditReport = renderClaimsAuditReport({ now, audit });

  writeText(sourcesReportPath, sourceReport);
  writeText(claimsAuditReportPath, claimsAuditReport);

  if (!args.dryRun) {
    writeText(artifactPath, stableStringify(dataset));
    writeText(
      manifestPath,
      stableStringify({
        schema_version: MANIFEST_SCHEMA_VERSION,
        generated_at: now,
        artifact_path: artifactPath,
        entries: manifests,
      }),
    );
  }

  console.log(sourcesReportPath);
  console.log(claimsAuditReportPath);
  if (!args.dryRun) {
    console.log(artifactPath);
    console.log(manifestPath);
  }

  if (args.failOnAudit && !audit.pass) process.exit(1);
}

main().catch((error) => {
  console.error(`[ingest_ingredient_sources] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
