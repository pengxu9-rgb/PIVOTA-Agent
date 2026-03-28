const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function writeSummary(reportRoot, dirName, decision) {
  const dir = path.join(reportRoot, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'summary.json'),
    JSON.stringify(
      {
        decision: {
          decision,
          next_action: 'review',
          blocking_failures: decision === 'NO-GO' ? ['blocked'] : [],
        },
      },
      null,
      2,
    ),
  );
}

describe('assert_celestial_stabilization_decision.js', () => {
  test('fails on NO-GO by default', async () => {
    const repoRoot = path.join(__dirname, '..');
    const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stabilization-report-'));
    const scriptPath = path.join(repoRoot, 'scripts', 'assert_celestial_stabilization_decision.js');
    writeSummary(reportRoot, '20260328_120000', 'NO-GO');

    await expect(
      execFileAsync(process.execPath, [scriptPath, '--report-root', reportRoot], {
        cwd: repoRoot,
        encoding: 'utf8',
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('"decision": "NO-GO"'),
    });
  });

  test('accepts HOLD with fail-on no-go', async () => {
    const repoRoot = path.join(__dirname, '..');
    const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stabilization-report-'));
    const scriptPath = path.join(repoRoot, 'scripts', 'assert_celestial_stabilization_decision.js');
    writeSummary(reportRoot, '20260328_120000', 'HOLD');

    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--report-root', reportRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    const payload = JSON.parse(stdout);
    expect(payload.ok).toBe(true);
    expect(payload.decision).toBe('HOLD');
  });
});
