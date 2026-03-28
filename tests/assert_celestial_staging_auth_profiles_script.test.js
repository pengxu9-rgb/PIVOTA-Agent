const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

describe('assert_celestial_staging_auth_profiles.js', () => {
  test('accepts a default staging token for all required profiles', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'assert_celestial_staging_auth_profiles.js');

    const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        STAGING_AUTH_TOKEN: 'ak_live_stage_key',
      },
    });

    const payload = JSON.parse(stdout);
    expect(payload.ok).toBe(true);
    expect(payload.missing_profiles).toEqual([]);
    expect(payload.profiles).toHaveLength(3);
  });

  test('fails when no staging auth profiles are configured', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'assert_celestial_staging_auth_profiles.js');

    await expect(
      execFileAsync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {},
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Missing staging auth profiles:'),
    });
  });
});
