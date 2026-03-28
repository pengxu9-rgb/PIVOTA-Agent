const path = require('path');
const { execFileSync } = require('child_process');

describe('commerce invoke rail inventory', () => {
  test('forbids non-allowlisted public gateway literals and any agent gateway literal', () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'verify_commerce_invoke_rails.js');
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const payload = JSON.parse(String(stdout || '').trim());

    expect(payload.ok).toBe(true);
    expect(payload.violations).toEqual([]);
    expect(payload.authoritative_file_count).toBeGreaterThan(0);
  });
});
