#!/usr/bin/env node
'use strict';
const os = require('os');
const { createCommerceStoreAuditWorker } = require('../src/services/commerceStoreAuditWorker');

const execution = String(process.env.CLOUD_RUN_EXECUTION || '').trim();
const task = String(process.env.CLOUD_RUN_TASK_INDEX || '').trim();
const workerId = process.env.STORE_AUDIT_COMMERCE_WORKER_ID || (execution ? `commerce-audit-${execution}-${task || '0'}` : `commerce-audit-${os.hostname()}-${process.pid}`);

createCommerceStoreAuditWorker({ workerId: workerId.slice(0, 255) }).runOnce()
  .then((result) => { console.log(JSON.stringify({ store_audit_commerce_worker: { ok: result.ok, code: result.code, verification_status: result.verification_status } })); if (!result.ok) process.exitCode = 1; })
  .catch(() => { console.error(JSON.stringify({ store_audit_commerce_worker: { ok: false, code: 'worker_unhandled_error' } })); process.exitCode = 1; });
