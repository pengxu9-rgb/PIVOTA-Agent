#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const frontendAnalyticsPath = path.resolve(rootDir, '../pivota-aurora-chatbox/src/lib/auroraAnalytics.ts');
const reportDir = path.join(rootDir, 'reports');
const reportFile = path.join(reportDir, 'analytics_audit.md');
const startedAtUtc = new Date().toISOString();

const forbiddenExact = new Set([
  'image',
  'image_url',
  'photo_url',
  'image_bytes',
  'photo_bytes',
  'base64',
  'face_crop',
  'bbox_px',
  'regions',
  'region',
  'polygon',
  'heatmap',
  'coord_space',
  'coords',
  'points',
  'x',
  'y',
  'w',
  'h',
  'overlay_url',
]);

const allowedExact = new Set([
  'heatmap_state',
]);

const hasForbiddenPattern = (key) => {
  const lower = String(key || '').trim().toLowerCase();
  if (!lower) return null;
  if (allowedExact.has(lower)) return null;
  if (forbiddenExact.has(lower)) return 'forbidden_exact';
  if (lower.includes('base64')) return 'contains_base64';
  if (lower.includes('bytes')) return 'contains_bytes';
  if (lower.includes('bbox')) return 'contains_bbox';
  if (lower.includes('coord')) return 'contains_coord';
  if (lower.includes('polygon')) return 'contains_polygon';
  if (lower.includes('heatmap')) return 'contains_heatmap';
  if (lower.includes('face_crop')) return 'contains_face_crop';
  if (lower.includes('regions') || lower === 'region') return 'contains_regions';
  if (lower.endsWith('_url') && !lower.endsWith('_hash')) return 'url_not_hashed';
  if ((lower.startsWith('image_') || lower.startsWith('photo_')) && !lower.endsWith('_hash')) return 'image_or_photo_field';
  return null;
};

const writeReport = ({ scanned, violations, note }) => {
  fs.mkdirSync(reportDir, { recursive: true });
  const lines = [
    '# Analytics Payload Audit',
    '',
    `- started_at_utc: ${startedAtUtc}`,
    `- source_file: \`${frontendAnalyticsPath}\``,
    `- scanned_emitters: ${scanned}`,
    `- violations: ${violations.length}`,
    note ? `- note: ${note}` : null,
    '',
    '## Guardrails',
    '',
    '- No image bytes/base64/raw photo URL in event payload',
    '- No face crop pixel bbox in event payload',
    '- No regions/geometry coordinates in event payload',
    '',
    '## Violations',
    '',
  ].filter(Boolean);

  if (!violations.length) {
    lines.push('No violations found.');
  } else {
    lines.push('| emitter | event_name | field | reason |');
    lines.push('| --- | --- | --- | --- |');
    for (const violation of violations) {
      lines.push(
        `| ${violation.emitter} | ${violation.eventName} | ${violation.field} | ${violation.reason} |`,
      );
    }
  }

  lines.push('');
  fs.writeFileSync(reportFile, lines.join('\n'));
};

if (!fs.existsSync(frontendAnalyticsPath)) {
  writeReport({
    scanned: 0,
    violations: [],
    note: 'frontend analytics file not found',
  });
  console.error(`Missing file: ${frontendAnalyticsPath}`);
  process.exit(1);
}

const source = fs.readFileSync(frontendAnalyticsPath, 'utf8');
const emitters = [];
const pattern =
  /export const\s+(\w+)\s*=\s*\(\s*ctx:\s*AnalyticsContext,\s*props:\s*\{([\s\S]*?)\}\s*(?:&\s*Record<[\s\S]*?>)?\s*,?\s*\)\s*=>\s*emitWithContext\('([^']+)'/g;

let match;
while ((match = pattern.exec(source)) !== null) {
  const emitterName = match[1];
  const propsBlock = match[2];
  const eventName = match[3];
  const fieldMatches = propsBlock.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/gm);
  const fields = [];
  const seen = new Set();
  for (const fieldMatch of fieldMatches) {
    const field = fieldMatch[1];
    if (seen.has(field)) continue;
    seen.add(field);
    fields.push(field);
  }
  emitters.push({ emitterName, eventName, fields });
}

const violations = [];
for (const emitter of emitters) {
  for (const field of emitter.fields) {
    const reason = hasForbiddenPattern(field);
    if (!reason) continue;
    violations.push({
      emitter: emitter.emitterName,
      eventName: emitter.eventName,
      field,
      reason,
    });
  }
}

writeReport({
  scanned: emitters.length,
  violations,
});

console.log(`Wrote ${reportFile}`);
if (violations.length) {
  console.error('Analytics payload audit failed with forbidden fields.');
  process.exit(1);
}
