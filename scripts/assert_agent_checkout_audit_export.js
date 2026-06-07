#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !String(next).startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_error) {
    return null;
  }
}

function unwrapRailwayRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const message = String(record.message || '').trim();
  if (!message || !message.startsWith('{')) return record;
  const parsed = parseJsonLine(message);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return record;
  return { ...record, ...parsed, message };
}

function collectAuditEvents(inputPath) {
  const raw = fs.readFileSync(inputPath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter(Boolean)
    .map(unwrapRailwayRecord)
    .filter((record) => record && record.event === 'agent_checkout_audit')
    .map((record) => record.audit)
    .filter((audit) => audit && typeof audit === 'object' && !Array.isArray(audit));
}

function stringify(value) {
  return JSON.stringify(value || {});
}

function assertNoSensitiveAuditFields(audits) {
  const sensitive = [
    /pan/i,
    /card_number/i,
    /ap2_state/i,
    /raw[_-]?token/i,
    /payment[_-]?token/i,
    /confirmation[_-]?token/i,
    /client_secret/i,
    /email/i,
    /shipping/i,
    /address/i,
  ];
  const blob = stringify(audits);
  return sensitive.filter((rx) => rx.test(blob)).map(String);
}

function requireValue(args, key) {
  const value = String(args[key] || '').trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(requireValue(args, 'input'));
  const quoteId = requireValue(args, 'quote-id');
  const orderId = requireValue(args, 'order-id');
  const userRef = requireValue(args, 'user-ref');
  const idempotencyKey = String(args['idempotency-key'] || '').trim();

  const audits = collectAuditEvents(inputPath);
  const quoteEvent = audits.find(
    (audit) =>
      audit.event === 'quote_issued' &&
      audit.operation === 'preview_quote' &&
      audit.quote_id === quoteId &&
      audit.user_ref === userRef,
  );
  const orderEvent = audits.find(
    (audit) =>
      audit.event === 'order_created' &&
      audit.operation === 'create_order' &&
      audit.order_id === orderId &&
      audit.user_ref === userRef &&
      (!idempotencyKey || audit.idempotency_key === idempotencyKey),
  );
  const sensitive_hits = assertNoSensitiveAuditFields(audits);
  const payload = {
    input_path: inputPath,
    audit_events: audits.length,
    quote_issued_found: Boolean(quoteEvent),
    order_created_found: Boolean(orderEvent),
    sensitive_hits,
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  if (!quoteEvent) throw new Error('missing expected quote_issued audit event');
  if (!orderEvent) throw new Error('missing expected order_created audit event');
  if (sensitive_hits.length > 0) {
    throw new Error(`sensitive audit fields found: ${sensitive_hits.join(', ')}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  unwrapRailwayRecord,
  collectAuditEvents,
  assertNoSensitiveAuditFields,
};
