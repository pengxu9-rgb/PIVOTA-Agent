const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

describe('verify_release_source.sh', () => {
  const repoRoot = path.join(__dirname, '..');
  const scriptPath = path.join(repoRoot, 'scripts', 'verify_release_source.sh');

  test('allows workflow_dispatch on a feature branch', async () => {
    const { stdout } = await execFileAsync('bash', [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF_NAME: 'codex/discovery-acceptance-fixes',
        ALLOWED_BRANCH_REGEX: '^main$',
      },
    });

    expect(stdout).toContain('release-source-check ok');
    expect(stdout).toContain('event_name=workflow_dispatch');
    expect(stdout).toContain('branch=codex/discovery-acceptance-fixes');
  });

  test('allows pull_request merge refs without enforcing main branch', async () => {
    const { stdout } = await execFileAsync('bash', [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF_NAME: '406/merge',
        ALLOWED_BRANCH_REGEX: '^main$',
      },
    });

    expect(stdout).toContain('release-source-check ok');
    expect(stdout).toContain('event_name=pull_request');
    expect(stdout).toContain('branch=406/merge');
  });

  test('fails push events on disallowed branches', async () => {
    await expect(
      execFileAsync('bash', [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF_NAME: 'codex/discovery-acceptance-fixes',
          ALLOWED_BRANCH_REGEX: '^main$',
        },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('release-source-check failed: branch not allowed for release event'),
    });
  });

  test('allows push events on main when branch matches', async () => {
    const { stdout } = await execFileAsync('bash', [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF_NAME: 'main',
        ALLOWED_BRANCH_REGEX: '^main$',
      },
    });

    expect(stdout).toContain('release-source-check ok');
    expect(stdout).toContain('event_name=push');
    expect(stdout).toContain('branch=main');
  });
});
