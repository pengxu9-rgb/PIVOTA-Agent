#!/usr/bin/env node
'use strict';

const os = require('os');
const { createUcpStoreAuditWorker } = require('../src/services/ucpStoreAuditWorker');

function defaultWorkerId() {
  const execution = String(process.env.CLOUD_RUN_EXECUTION || '').trim();
  const task = String(process.env.CLOUD_RUN_TASK_INDEX || '').trim();
  if (execution) return `ucp-crawl-${execution}-${task || '0'}`.slice(0, 255);
  return `ucp-crawl-${os.hostname()}-${process.pid}`.slice(0, 255);
}

async function main() {
  const worker = createUcpStoreAuditWorker({
    workerId: process.env.STORE_AUDIT_UCP_WORKER_ID || defaultWorkerId(),
  });
  const result = await worker.runOnce();
  // Never render endpoints, keys, or receipt bodies in Cloud Run logs.
  console.log(JSON.stringify({ store_audit_ucp_worker: result }));
  if (!result.ok) process.exitCode = 1;
}

main().catch(() => {
  console.error(JSON.stringify({ store_audit_ucp_worker: { ok: false, code: 'worker_unhandled_error' } }));
  process.exitCode = 1;
});
