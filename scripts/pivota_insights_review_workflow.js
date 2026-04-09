#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function parseArgs(argv) {
  const out = {
    command: '',
    cases: '',
    report: '',
    review: '',
    outDir: '',
    manualOverrides: 'scripts/fixtures/product_intel_manual_overrides.json',
    model: process.env.PRODUCT_INTEL_PILOT_GEMINI_MODEL || 'gemini-3-pro-preview',
    skipGemini: false,
    write: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (!out.command && !token.startsWith('--')) {
      out.command = token;
      continue;
    }
    if (token === '--cases' && next) {
      out.cases = next;
      i += 1;
    } else if (token === '--report' && next) {
      out.report = next;
      i += 1;
    } else if (token === '--review' && next) {
      out.review = next;
      i += 1;
    } else if (token === '--out-dir' && next) {
      out.outDir = next;
      i += 1;
    } else if (token === '--manual-overrides' && next) {
      out.manualOverrides = next;
      i += 1;
    } else if (token === '--model' && next) {
      out.model = next;
      i += 1;
    } else if (token === '--skip-gemini') {
      out.skipGemini = true;
    } else if (token === '--write') {
      out.write = true;
    }
  }

  if (!out.command) out.command = 'init';
  return out;
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function displayPath(rootDir, targetPath) {
  const absolute = resolvePath(rootDir, targetPath);
  const relative = path.relative(rootDir, absolute);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return relative || '.';
  }
  return absolute;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, value);
}

function toSentence(text) {
  const clean = asString(text).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (/[.!?]$/.test(clean)) return clean;
  return `${clean}.`;
}

function compactCardIntroCandidate(text, maxChars = 140) {
  const clean = toSentence(text);
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  const trimmed = clean.slice(0, maxChars);
  const boundary = trimmed.lastIndexOf(' ');
  const compact = boundary >= Math.floor(maxChars * 0.65) ? trimmed.slice(0, boundary) : trimmed;
  return `${compact.trim()}…`;
}

function buildSearchCardCompactCandidate(core) {
  const headline = asString(core?.what_it_is?.headline);
  const body = asString(core?.what_it_is?.body).toLowerCase();
  const firstHighlight = asString(core?.why_it_stands_out?.[0]?.headline).toLowerCase();
  let candidate = headline
    .replace(/\s+/g, ' ')
    .replace(/\bmoisturizer with spf\b/i, 'SPF moisturizer')
    .trim();

  if (/^treatment serum$/i.test(candidate) && /\bmulti-active\b/.test(firstHighlight || body)) {
    candidate = 'Multi-active serum';
  } else if (/^brightening serum$/i.test(candidate) && /\bamla\b/.test(body)) {
    candidate = 'Amla brightening serum';
  } else if (/^brightening moisturizer$/i.test(candidate) && /\bniacinamide\b/.test(body)) {
    candidate = 'Vitamin C + niacinamide cream';
  } else if (/^night cream$/i.test(candidate) && /\boatmeal\b/.test(body)) {
    candidate = 'Oatmeal night cream';
  } else if (/^treatment lotion$/i.test(candidate) && /\b2%\s*niacinamide\b/.test(body)) {
    candidate = '2% niacinamide lotion';
  } else if (/^color-correcting eye treatment stick$/i.test(candidate)) {
    candidate = 'Color-correcting eye stick';
  } else if (/^brightening moisturizer$/i.test(candidate) && /\bgel-cream\b/.test(body)) {
    candidate = 'Vitamin C gel-cream';
  }

  if (!candidate && /spf\s*30/.test(body) && /moisturi[sz]er/.test(body)) {
    candidate = 'SPF 30 moisturizer';
  }
  if (!candidate && /brighten/.test(body) && /serum/.test(body)) {
    candidate = 'Brightening serum';
  }
  if (!candidate && /moisturi[sz]er/.test(body)) {
    candidate = 'Moisturizer';
  }
  if (!candidate && /eye/.test(body)) {
    candidate = 'Eye treatment';
  }

  if (candidate.length > 44) {
    const trimmed = candidate.slice(0, 44);
    const boundary = trimmed.lastIndexOf(' ');
    candidate = boundary >= 20 ? trimmed.slice(0, boundary).trim() : trimmed.trim();
  }
  return candidate;
}

function buildCaseLookup(casesPayload) {
  const rows = Array.isArray(casesPayload)
    ? casesPayload
    : Array.isArray(casesPayload?.rows)
      ? casesPayload.rows
      : Array.isArray(casesPayload?.cases)
        ? casesPayload.cases
        : [];
  const map = new Map();
  for (const row of rows) {
    map.set(asString(row.case_id || row.id), row);
  }
  return map;
}

function buildReviewRows(compareReport, casesPayload) {
  const rows = Array.isArray(compareReport?.rows) ? compareReport.rows : [];
  const caseLookup = buildCaseLookup(casesPayload);

  return rows.map((row) => {
    const caseId = asString(row.case_id);
    const source = caseLookup.get(caseId) || {};
    const product = source.product || {};
    const selectedBundle = row?.selected?.bundle || {};
    const core = selectedBundle.product_intel_core || {};
    const highlights = Array.isArray(core.why_it_stands_out) ? core.why_it_stands_out : [];
    const firstBadge = Array.isArray(selectedBundle.market_signal_badges)
      ? selectedBundle.market_signal_badges.find((item) => asString(item?.badge_label))
      : null;
    return {
      case_id: caseId,
      product_id: asString(selectedBundle?.canonical_product_ref?.product_id || product.product_id),
      merchant_id: asString(selectedBundle?.canonical_product_ref?.merchant_id || product.merchant_id),
      brand: asString(product.brand),
      title: asString(product.title || product.name),
      selected_mode: asString(row?.selected?.selected_mode || 'baseline_only'),
      evidence_profile: asString(selectedBundle?.evidence_profile || ''),
      quality_state: asString(selectedBundle?.quality_state || ''),
      what_it_is: {
        headline: asString(core?.what_it_is?.headline),
        body: asString(core?.what_it_is?.body),
      },
      why_it_stands_out: highlights.map((item) => ({
        headline: asString(item?.headline),
        body: asString(item?.body),
      })),
      search_card_proof_badge_candidate: asString(firstBadge?.badge_label),
      search_card_compact_candidate: buildSearchCardCompactCandidate(core),
      search_card_intro_candidate: compactCardIntroCandidate(core?.what_it_is?.body, 96),
      search_card_title_guidance:
        'For compact cards, prefer a normalized title that exposes brand + product type + core function + critical attribute order; avoid creative-only naming.',
      review_status: 'pending',
      review_notes: '',
      reviewer: '',
      updated_at: null,
    };
  });
}

function renderReviewMarkdown(reviewDoc) {
  const rows = Array.isArray(reviewDoc?.rows) ? reviewDoc.rows : [];
  const lines = [
    '# Pivota Insights Review Packet',
    '',
    `Generated: ${reviewDoc?.meta?.generated_at || ''}`,
    `Cases: ${rows.length}`,
    `Model: ${reviewDoc?.meta?.model || ''}`,
    '',
    '## Review Gate',
    '',
    '- Only publish rows marked `pass`.',
    '- Mark `rewrite` if `What it is` or `Why it stands out` is generic, abstract, inflated, or still sounds like seller copy.',
    '- Use `search_card_compact_candidate` for tight grid cards; reserve `search_card_intro_candidate` for wider list/detail surfaces.',
    '- `search_card_proof_badge_candidate` should only appear when it is backed by hard evidence such as ratings, editorial tags, or reviewed source counts.',
    '- Prefer normalized title copy over raw merchant `Overview` when the surface is compact.',
    '',
  ];

  for (const row of rows) {
    lines.push(`## ${row.brand} ${row.title}`.trim());
    lines.push('');
    lines.push(`- case_id: \`${row.case_id}\``);
    lines.push(`- status: \`${row.review_status}\``);
    lines.push(`- selected_mode: \`${row.selected_mode}\``);
    lines.push(`- evidence_profile: \`${row.evidence_profile}\``);
    lines.push(`- quality_state: \`${row.quality_state}\``);
    lines.push(`- what_it_is: ${row.what_it_is.body}`);
    lines.push('- why_it_stands_out:');
    for (const item of row.why_it_stands_out || []) {
      lines.push(`  - ${item.headline}: ${item.body}`);
    }
    lines.push(`- search_card_proof_badge_candidate: ${row.search_card_proof_badge_candidate || '(none)'}`);
    lines.push(`- search_card_compact_candidate: ${row.search_card_compact_candidate}`);
    lines.push(`- search_card_intro_candidate: ${row.search_card_intro_candidate}`);
    lines.push(`- review_notes: ${row.review_notes || '(fill me in)'}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function assertAllReviewRowsPassed(reviewDoc) {
  const rows = Array.isArray(reviewDoc?.rows) ? reviewDoc.rows : [];
  const blocked = rows.filter((row) => asString(row.review_status).toLowerCase() !== 'pass');
  if (blocked.length) {
    const err = new Error(
      `review_not_ready:${blocked.map((row) => `${row.case_id}:${row.review_status || 'pending'}`).join(',')}`,
    );
    err.code = 'REVIEW_NOT_READY';
    err.blocked = blocked.map((row) => ({
      case_id: row.case_id,
      review_status: row.review_status || 'pending',
    }));
    throw err;
  }
  return rows.map((row) => row.case_id);
}

function runCompareWorkflow(rootDir, args) {
  if (!args.cases) throw new Error('--cases is required for init');
  const generatedAt = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolvePath(rootDir, args.outDir || `reports/pivota_insights_review_${generatedAt}`);
  const compareJson = path.join(outDir, 'compare.json');
  const compareMarkdown = path.join(outDir, 'compare.md');
  const reviewJson = path.join(outDir, 'review.json');
  const reviewMarkdown = path.join(outDir, 'review.md');
  const compareScript = path.join(rootDir, 'scripts', 'product_intel_pilot_compare.js');

  const compareArgs = [
    compareScript,
    '--cases',
    resolvePath(rootDir, args.cases),
    '--out',
    compareJson,
    '--markdown',
    compareMarkdown,
    '--manual-overrides',
    resolvePath(rootDir, args.manualOverrides),
    '--model',
    args.model,
  ];
  if (args.skipGemini) compareArgs.push('--skip-gemini');

  const result = spawnSync(process.execPath, compareArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error('compare_failed');
  }

  const compareReport = readJson(compareJson);
  const casesPayload = readJson(resolvePath(rootDir, args.cases));
  const reviewDoc = {
    meta: {
      generated_at: new Date().toISOString(),
      compare_report: displayPath(rootDir, compareJson),
      compare_markdown: displayPath(rootDir, compareMarkdown),
      cases_path: displayPath(rootDir, args.cases),
      manual_overrides_path: displayPath(rootDir, args.manualOverrides),
      model: args.model,
      publish_gate: 'all rows must be pass',
      search_card_policy: 'prefer normalized card intro from What it is over raw Overview copy',
    },
    rows: buildReviewRows(compareReport, casesPayload),
  };

  writeJson(reviewJson, reviewDoc);
  writeText(reviewMarkdown, renderReviewMarkdown(reviewDoc));
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      compare_json: compareJson,
      compare_markdown: compareMarkdown,
      review_json: reviewJson,
      review_markdown: reviewMarkdown,
    })}\n`,
  );
}

function runPublishWorkflow(rootDir, args) {
  if (!args.report) throw new Error('--report is required for publish');
  if (!args.review) throw new Error('--review is required for publish');
  const reportPath = resolvePath(rootDir, args.report);
  const reviewPath = resolvePath(rootDir, args.review);
  const reviewDoc = readJson(reviewPath);
  const caseIds = assertAllReviewRowsPassed(reviewDoc);
  const publishScript = path.join(rootDir, 'scripts', 'publish_product_intel_pilot_to_kb.js');

  const publishArgs = [
    publishScript,
    '--report',
    reportPath,
    '--case-ids',
    caseIds.join(','),
  ];
  if (args.write) publishArgs.push('--write');

  const result = spawnSync(process.execPath, publishArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error('publish_failed');
  }
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const args = parseArgs(process.argv);
  if (args.command === 'init') {
    runCompareWorkflow(rootDir, args);
    return;
  }
  if (args.command === 'publish') {
    runPublishWorkflow(rootDir, args);
    return;
  }
  throw new Error(`unknown_command:${args.command}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  assertAllReviewRowsPassed,
  buildReviewRows,
  buildSearchCardCompactCandidate,
  compactCardIntroCandidate,
  displayPath,
  parseArgs,
  renderReviewMarkdown,
};
