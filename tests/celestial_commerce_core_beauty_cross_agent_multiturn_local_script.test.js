const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

describe('Celestial commerce beauty cross-agent multi-turn local runner', () => {
  test('runs the local multi-turn matrix and keeps follow-up context stable', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'run_celestial_commerce_core_beauty_cross_agent_multiturn_local.js',
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beauty-cross-agent-multiturn-local-'));

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        scriptPath,
        '--out-dir',
        outDir,
        '--rounds',
        '2',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );

    const payload = JSON.parse(String(stdout || '').trim());
    const report = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

    expect(payload.ok).toBe(true);
    expect(report.summary.total_runs).toBe(14);
    expect(report.summary.total_turns).toBe(38);
    expect(report.summary.failed_turns).toBe(0);
    expect(report.summary.failure_buckets).toEqual({});

    const guided = report.runs.find(
      (run) => run.case_id === 'shopping_guided_context_recovery' && run.source === 'shopping_agent',
    );
    expect(guided.turns[0].normalized.mode).toBe('guided_beauty_reco');
    expect(guided.turns[1].normalized.mode).toBe('category_compare');
    expect(guided.turns[2].normalized.mode).toBe('category_compare');

    const nonBeauty = report.runs.find(
      (run) => run.case_id === 'cross_agent_non_beauty_isolation_luggage' && run.source === 'shopping_agent',
    );
    expect(nonBeauty.turns.every((turn) => turn.normalized.beauty_expert_v1 === false)).toBe(true);
  });
});
