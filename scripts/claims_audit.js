#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

const { buildPhotoModulesCard } = require('../src/auroraBff/photoModulesV1');
const { validateRenderedText } = require('../src/auroraBff/claimsTemplates/validate');
const { detectBannedClaimTerms } = require('../src/auroraBff/ingredientKbV2/claimGuard');

function parseArgs(argv) {
  const out = {
    out: path.join('reports', 'claims_audit.md'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const next = argv[i + 1];
      if (!next) throw new Error('Missing value for --out');
      out.out = next;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  console.log('Usage: node scripts/claims_audit.js [--out reports/claims_audit.md]');
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function makeAnalysisFixture() {
  return {
    photo_findings: [
      {
        finding_id: 'audit_redness',
        issue_type: 'redness',
        severity: 3,
        confidence: 0.88,
        geometry: {
          bbox: { x: 0.12, y: 0.28, w: 0.35, h: 0.24 },
        },
      },
      {
        finding_id: 'audit_shine',
        issue_type: 'shine',
        severity: 2,
        confidence: 0.81,
        geometry: {
          bbox: { x: 0.45, y: 0.31, w: 0.2, h: 0.22 },
        },
      },
      {
        finding_id: 'audit_texture',
        issue_type: 'texture',
        severity: 2,
        confidence: 0.8,
        geometry: {
          bbox: { x: 0.2, y: 0.62, w: 0.48, h: 0.22 },
        },
      },
      {
        finding_id: 'audit_tone',
        issue_type: 'tone',
        severity: 2,
        confidence: 0.79,
        geometry: {
          bbox: { x: 0.18, y: 0.2, w: 0.58, h: 0.45 },
        },
      },
      {
        finding_id: 'audit_acne',
        issue_type: 'acne',
        severity: 2,
        confidence: 0.75,
        geometry: {
          bbox: { x: 0.34, y: 0.55, w: 0.28, h: 0.24 },
        },
      },
    ],
  };
}

function makeDiagnosisInternalFixture() {
  return {
    orig_size_px: { w: 1080, h: 1440 },
    skin_bbox_norm: { x0: 0.17, y0: 0.12, x1: 0.83, y1: 0.92 },
    face_crop_margin_scale: 1.18,
  };
}

function buildCases() {
  return [
    { case_id: 'US_EN_PASS', market: 'US', language: 'EN', quality: 'pass' },
    { case_id: 'EU_EN_PASS', market: 'EU', language: 'EN', quality: 'pass' },
    { case_id: 'US_CN_PASS', market: 'US', language: 'CN', quality: 'pass' },
    { case_id: 'EU_EN_DEGRADED', market: 'EU', language: 'EN', quality: 'degraded' },
  ];
}

function pushViolation(violations, payload) {
  violations.push({
    case_id: payload.case_id,
    path: payload.path,
    reason: payload.reason,
    detail: payload.detail || '',
  });
}

function auditField({ caseId, pathLabel, text, templateKey, violations }) {
  const value = String(text || '').trim();
  const key = String(templateKey || '').trim();
  if (!value) return;
  if (!key) {
    pushViolation(violations, {
      case_id: caseId,
      path: pathLabel,
      reason: 'missing_template_key',
      detail: value.slice(0, 120),
    });
    return;
  }

  const validation = validateRenderedText({ text: value, templateKey: key });
  if (!validation.ok) {
    pushViolation(violations, {
      case_id: caseId,
      path: pathLabel,
      reason: validation.reason || 'validation_failed',
      detail: Array.isArray(validation.violations) ? validation.violations.join(';') : '',
    });
    return;
  }

  const bannedHits = detectBannedClaimTerms(value);
  if (bannedHits.length) {
    pushViolation(violations, {
      case_id: caseId,
      path: pathLabel,
      reason: 'banned_terms',
      detail: bannedHits.join(';'),
    });
  }
}

function runAudit() {
  const results = [];
  const violations = [];

  for (const testCase of buildCases()) {
    const built = buildPhotoModulesCard({
      requestId: `claims_audit_${testCase.case_id}`,
      analysis: makeAnalysisFixture(),
      usedPhotos: true,
      photoQuality: { grade: testCase.quality, reasons: [] },
      photoNotice: 'claims audit',
      diagnosisInternal: makeDiagnosisInternalFixture(),
      profileSummary: {
        region: testCase.market,
        barrierStatus: testCase.quality === 'degraded' ? 'impaired' : 'healthy',
        sensitivity: testCase.quality === 'degraded' ? 'high' : 'low',
      },
      language: testCase.language,
      ingredientRecEnabled: true,
      productRecEnabled: true,
      productRecMinCitations: 1,
      productRecMinEvidenceGrade: 'B',
      productRecRepairOnlyWhenDegraded: true,
      internalTestMode: true,
    });
    if (!built || !built.card || !built.card.payload) {
      pushViolation(violations, {
        case_id: testCase.case_id,
        path: 'payload',
        reason: 'payload_missing',
      });
      continue;
    }
    const payload = built.card.payload;
    const modules = Array.isArray(payload.modules) ? payload.modules : [];
    let issueFields = 0;
    let actionFields = 0;
    let productFields = 0;
    for (const module of modules) {
      const moduleId = String(module && module.module_id ? module.module_id : 'unknown');
      const issues = Array.isArray(module && module.issues) ? module.issues : [];
      const actions = Array.isArray(module && module.actions) ? module.actions : [];
      const products = Array.isArray(module && module.products) ? module.products : [];
      for (let idx = 0; idx < issues.length; idx += 1) {
        const issue = issues[idx];
        issueFields += 1;
        auditField({
          caseId: testCase.case_id,
          pathLabel: `modules[${moduleId}].issues[${idx}].explanation_short`,
          text: issue && issue.explanation_short,
          templateKey: issue && issue.explanation_template_key,
          violations,
        });
      }
      for (let idx = 0; idx < actions.length; idx += 1) {
        const action = actions[idx];
        actionFields += 1;
        auditField({
          caseId: testCase.case_id,
          pathLabel: `modules[${moduleId}].actions[${idx}].why`,
          text: action && action.why,
          templateKey: action && action.why_template_key,
          violations,
        });
      }
      for (let idx = 0; idx < products.length; idx += 1) {
        const product = products[idx];
        productFields += 1;
        auditField({
          caseId: testCase.case_id,
          pathLabel: `modules[${moduleId}].products[${idx}].why_match`,
          text: product && product.why_match,
          templateKey: product && product.why_match_template_key,
          violations,
        });
      }
    }
    results.push({
      case_id: testCase.case_id,
      market: testCase.market,
      language: testCase.language,
      quality: testCase.quality,
      modules: modules.length,
      issue_fields: issueFields,
      action_fields: actionFields,
      product_fields: productFields,
    });
  }

  return { results, violations };
}

function buildMarkdown({ results, violations }) {
  const lines = [];
  lines.push('# Claims Audit Report');
  lines.push('');
  lines.push(`Generated at (UTC): ${nowIso()}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- cases: ${results.length}`);
  lines.push(`- violations: ${violations.length}`);
  lines.push(
    `- status: ${violations.length === 0 ? 'PASS' : 'FAIL'}`,
  );
  lines.push('');
  lines.push('## Case Stats');
  lines.push('');
  lines.push('| case_id | market | language | quality | modules | issue_fields | action_fields | product_fields |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of results) {
    lines.push(
      `| ${row.case_id} | ${row.market} | ${row.language} | ${row.quality} | ${row.modules} | ${row.issue_fields} | ${row.action_fields} | ${row.product_fields} |`,
    );
  }
  lines.push('');
  lines.push('## Violations');
  lines.push('');
  if (!violations.length) {
    lines.push('_No violations found._');
  } else {
    lines.push('| case_id | path | reason | detail |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of violations) {
      lines.push(
        `| ${row.case_id} | ${row.path} | ${row.reason} | ${String(row.detail || '').replace(/\|/g, '\\|')} |`,
      );
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const { results, violations } = runAudit();
  const markdown = buildMarkdown({ results, violations });
  ensureParentDir(args.out);
  fs.writeFileSync(args.out, markdown, 'utf8');
  console.log(path.resolve(args.out));
  if (violations.length) {
    process.exitCode = 1;
  }
}

main();
