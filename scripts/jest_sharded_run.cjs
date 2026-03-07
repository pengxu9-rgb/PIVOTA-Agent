#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const jestBin = path.join(repoRoot, 'node_modules', '.bin', 'jest');
const shardCount = Math.max(1, Number(process.env.JEST_SHARD_COUNT || 4));
const testTimeoutMs = Math.max(1000, Number(process.env.JEST_TEST_TIMEOUT_MS || 15000));

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
}

const listResult = spawnSync(
  process.execPath,
  [jestBin, '--listTests'],
  {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  },
);

if (listResult.status !== 0) {
  process.stdout.write(listResult.stdout || '');
  process.stderr.write(listResult.stderr || '');
  process.exit(listResult.status || 1);
}

const allTests = String(listResult.stdout || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (!allTests.length) {
  console.error('[jest-sharded-run] No test files discovered.');
  process.exit(1);
}

const effectiveShardCount = Math.min(shardCount, allTests.length);
const shards = Array.from({ length: effectiveShardCount }, () => []);

for (let index = 0; index < allTests.length; index += 1) {
  shards[index % effectiveShardCount].push(allTests[index]);
}

for (let index = 0; index < shards.length; index += 1) {
  const shardTests = shards[index];
  const shardLabel = `${index + 1}/${shards.length}`;

  console.log(
    `[jest-sharded-run] Running shard ${shardLabel} with ${shardTests.length} test files (timeout=${testTimeoutMs}ms)`,
  );

  const result = runNode([
    jestBin,
    '--watchman=false',
    '--runInBand',
    `--testTimeout=${testTimeoutMs}`,
    '--runTestsByPath',
    ...shardTests,
  ]);

  if (result.error) {
    console.error(`[jest-sharded-run] Shard ${shardLabel} failed to start:`, result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log('[jest-sharded-run] All shards passed.');
