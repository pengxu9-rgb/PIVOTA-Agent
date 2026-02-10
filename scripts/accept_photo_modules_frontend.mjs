#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.resolve(rootDir, '../pivota-aurora-chatbox');
const reportDir = path.join(rootDir, 'reports');
const reportFile = path.join(reportDir, 'photo_modules_frontend_acceptance.md');
const startedAtUtc = new Date().toISOString();

const assertions = [
  'PhotoModulesCard renders base/highlight canvas layers',
  'Module/issue interaction updates highlight scope',
  'Schema-fail payload is downgraded safely without runtime crash',
];

const command = [
  'npm',
  '--prefix',
  frontendDir,
  'run',
  'test',
  '--',
  'src/test/photoModules.acceptance.test.tsx',
];

const writeReport = ({ result, stdout, stderr, note = '' }) => {
  fs.mkdirSync(reportDir, { recursive: true });
  const lines = [
    '# Photo Modules Frontend Acceptance',
    '',
    `- started_at_utc: ${startedAtUtc}`,
    `- frontend_dir: \`${frontendDir}\``,
    `- command: \`${command.join(' ')}\``,
    `- result: **${result}**`,
    note ? `- note: ${note}` : null,
    '',
    '## Assertions',
    '',
    ...assertions.map((item) => `- ${item}`),
    '',
    '## Stdout',
    '',
    '```text',
    (stdout || '').trim() || '(empty)',
    '```',
    '',
    '## Stderr',
    '',
    '```text',
    (stderr || '').trim() || '(empty)',
    '```',
    '',
  ].filter(Boolean);
  fs.writeFileSync(reportFile, lines.join('\n'));
};

if (!fs.existsSync(frontendDir)) {
  writeReport({
    result: 'FAIL',
    stdout: '',
    stderr: '',
    note: `frontend directory not found: ${frontendDir}`,
  });
  console.error(`Frontend directory not found: ${frontendDir}`);
  process.exit(1);
}

const output = spawnSync(command[0], command.slice(1), {
  cwd: rootDir,
  encoding: 'utf8',
});

const status = Number.isInteger(output.status) ? output.status : 1;
const result = status === 0 ? 'PASS' : 'FAIL';
writeReport({
  result,
  stdout: output.stdout ?? '',
  stderr: output.stderr ?? '',
});

console.log(`Wrote ${reportFile}`);
process.exit(status);
