#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function getDefaultBaseUrl(env = process.env) {
  const harvesterBaseUrl = String(env.INGREDIENT_HARVESTER_BASE_URL || '').trim().replace(/\/+$/g, '');
  if (harvesterBaseUrl) return harvesterBaseUrl;

  const catalogBaseUrl = String(env.CATALOG_INTELLIGENCE_BASE_URL || '').trim().replace(/\/+$/g, '');
  if (catalogBaseUrl) return `${catalogBaseUrl}/api/ingredient-harvester`;

  return 'http://localhost:3001/api/ingredient-harvester';
}

function normalizeBaseUrl(raw, env = process.env) {
  const trimmed = String(raw || '').trim().replace(/\/+$/g, '');
  return trimmed || getDefaultBaseUrl(env);
}

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function assertOk(res) {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  throw new Error(`Harvester API error ${res.status}: ${text || res.statusText}`);
}

async function uploadCsv(csvPath, baseUrl) {
  const filePath = path.resolve(csvPath);
  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([fileBuffer]), path.basename(filePath));
  const res = await fetch(`${baseUrl}/v1/imports`, { method: 'POST', body: form });
  await assertOk(res);
  return res.json();
}

async function listRows({ importId, status, q, limit, offset }, baseUrl) {
  const url = new URL(`${baseUrl}/v1/imports/${encodeURIComponent(importId)}/rows`);
  if (status) url.searchParams.set('status', status);
  if (q) url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  const res = await fetch(url, { cache: 'no-store' });
  await assertOk(res);
  return res.json();
}

async function startTask({ importId, rowIds, force }, baseUrl) {
  const res = await fetch(`${baseUrl}/v1/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ import_id: importId, row_ids: rowIds?.length ? rowIds : null, force: Boolean(force) }),
  });
  await assertOk(res);
  return res.json();
}

async function getTaskProgress(taskId, baseUrl) {
  const res = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store' });
  await assertOk(res);
  return res.json();
}

async function auditImport({ importId, rowIds, applyCorrections, stage }, baseUrl) {
  const res = await fetch(`${baseUrl}/v1/imports/${encodeURIComponent(importId)}/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      row_ids: rowIds?.length ? rowIds : [],
      apply_corrections: Boolean(applyCorrections),
      stage: String(stage || 'initial'),
    }),
  });
  await assertOk(res);
  return res.json();
}

async function waitForTask({ taskId, intervalMs, timeoutMs }, baseUrl) {
  const startedAt = Date.now();
  while (true) {
    const progress = await getTaskProgress(taskId, baseUrl);
    if (progress.status !== 'RUNNING') return progress;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for task ${taskId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function exportUrl(importId, format, baseUrl, mode = 'default') {
  const url = new URL(`${baseUrl}/v1/exports/${encodeURIComponent(importId)}`);
  url.searchParams.set('format', format);
  url.searchParams.set('mode', mode);
  return url.toString();
}

async function main() {
  const [command] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const baseUrl = normalizeBaseUrl(argValue('base-url') || argValue('baseUrl'));

  if (!command) {
    throw new Error('Usage: node scripts/ingredient-harvester-batch.js <upload|list|start|progress|wait|audit|export-url> [options]');
  }

  if (command === 'upload') {
    const csvPath = argValue('csv');
    if (!csvPath) throw new Error('--csv is required for upload');
    process.stdout.write(`${JSON.stringify(await uploadCsv(csvPath, baseUrl), null, 2)}\n`);
    return;
  }

  if (command === 'list') {
    const importId = argValue('import-id') || argValue('importId');
    if (!importId) throw new Error('--import-id is required for list');
    process.stdout.write(
      `${JSON.stringify(
        await listRows(
          {
            importId,
            status: argValue('status') || undefined,
            q: argValue('q') || undefined,
            limit: Math.max(1, Number(argValue('limit') || 100)),
            offset: Math.max(0, Number(argValue('offset') || 0)),
          },
          baseUrl,
        ),
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === 'start') {
    const importId = argValue('import-id') || argValue('importId');
    if (!importId) throw new Error('--import-id is required for start');
    const rowIds = process.argv
      .flatMap((arg, index) => (arg === '--row-id' || arg === '--rowId' ? [process.argv[index + 1]] : []))
      .filter(Boolean);
    process.stdout.write(`${JSON.stringify(await startTask({ importId, rowIds, force: hasFlag('force') }, baseUrl), null, 2)}\n`);
    return;
  }

  if (command === 'progress') {
    const taskId = argValue('task-id') || argValue('taskId');
    if (!taskId) throw new Error('--task-id is required for progress');
    process.stdout.write(`${JSON.stringify(await getTaskProgress(taskId, baseUrl), null, 2)}\n`);
    return;
  }

  if (command === 'wait') {
    const taskId = argValue('task-id') || argValue('taskId');
    if (!taskId) throw new Error('--task-id is required for wait');
    process.stdout.write(
      `${JSON.stringify(
        await waitForTask(
          {
            taskId,
            intervalMs: Math.max(500, Number(argValue('interval-ms') || 1500)),
            timeoutMs: Math.max(5_000, Number(argValue('timeout-ms') || 300_000)),
          },
          baseUrl,
        ),
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === 'audit') {
    const importId = argValue('import-id') || argValue('importId');
    if (!importId) throw new Error('--import-id is required for audit');
    const rowIds = process.argv
      .flatMap((arg, index) => (arg === '--row-id' || arg === '--rowId' ? [process.argv[index + 1]] : []))
      .filter(Boolean);
    process.stdout.write(
      `${JSON.stringify(
        await auditImport(
          {
            importId,
            rowIds,
            applyCorrections: hasFlag('apply-corrections') || hasFlag('applyCorrections'),
            stage: argValue('stage') || 'initial',
          },
          baseUrl,
        ),
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === 'export-url') {
    const importId = argValue('import-id') || argValue('importId');
    if (!importId) throw new Error('--import-id is required for export-url');
    const format = (argValue('format') || 'csv').toLowerCase();
    const mode = (argValue('mode') || 'default').toLowerCase();
    process.stdout.write(`${JSON.stringify({ url: exportUrl(importId, format, baseUrl, mode) }, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  getDefaultBaseUrl,
  uploadCsv,
  listRows,
  startTask,
  getTaskProgress,
  waitForTask,
  auditImport,
  exportUrl,
};
