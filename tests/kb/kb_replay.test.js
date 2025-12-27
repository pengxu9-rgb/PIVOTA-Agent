const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractMissingTechniqueIds, replayFromAdjustmentSkeletons } = require('../../src/kb/replay/replayLayer2');

describe('kb:replay', () => {
  test('extractMissingTechniqueIds dedupes and sorts', () => {
    expect(
      extractMissingTechniqueIds([
        'Missing technique card: T_X (area=eye).',
        'Missing technique card: T_A (area=base).',
        'Missing technique card: T_X (area=lip).',
        'Other warning',
      ]),
    ).toEqual(['T_A', 'T_X']);
  });

  test('replayFromAdjustmentSkeletons flags missing technique ids deterministically', () => {
    const skeletons = [
      {
        schemaVersion: 'v0',
        market: 'US',
        impactArea: 'base',
        ruleId: 'BASE_THIN_LAYERS_TARGET_GLOW',
        severity: 0.5,
        confidence: 'high',
        becauseFacts: ['Reference base finish targets glow.'],
        doActionIds: ['T_BASE_THIN_LAYER'],
        doActions: [],
        whyMechanism: ['Thin layers help match finish.'],
        evidenceKeys: ['lookSpec.breakdown.base.finish'],
      },
      {
        schemaVersion: 'v0',
        market: 'US',
        impactArea: 'eye',
        ruleId: 'EYE_LINER_DIRECTION_ADAPT',
        severity: 0.6,
        confidence: 'medium',
        becauseFacts: ['Eye direction differs slightly.'],
        doActionIds: ['T_DOES_NOT_EXIST', 'T_EYE_LINER_THIN_LINE'],
        doActions: [],
        whyMechanism: ['Adjusting direction reduces mismatch.'],
        evidenceKeys: ['lookSpec.breakdown.eye.intent'],
      },
      {
        schemaVersion: 'v0',
        market: 'US',
        impactArea: 'lip',
        ruleId: 'LIP_MATCH_FINISH_FOCUS',
        severity: 0.4,
        confidence: 'low',
        becauseFacts: ['Finish is more reliable than shape.'],
        doActionIds: ['T_LIP_MATCH_FINISH'],
        doActions: [],
        whyMechanism: ['Finish is more reliable than shape.'],
        evidenceKeys: ['fallback:lip'],
      },
    ];

    const out = replayFromAdjustmentSkeletons({ market: 'US', locale: 'en', skeletons });
    expect(out.ok).toBe(true);
    expect(out.kbFallbackUsed).toBe(true);
    expect(out.missingTechniqueIds).toEqual(['T_DOES_NOT_EXIST']);
    expect(out.adjustments).toHaveLength(3);
    expect(out.steps).toHaveLength(8);
  });

  test('cli writes replay_report.md', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const candidatesPath = path.join(repoRoot, 'tests', 'fixtures', 'kb', 'us', 'kb_gap_candidates.jsonl');
    const samplesPath = path.join(repoRoot, 'tests', 'fixtures', 'kb', 'us', 'outcome_samples.jsonl');

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivota-kb-replay-'));
    childProcess.execFileSync(
      'node',
      [
        path.join(repoRoot, 'src', 'kb', 'runReplayKB.js'),
        '--market=US',
        `--input=${candidatesPath}`,
        `--samples=${samplesPath}`,
        `--outDir=${outDir}`,
        '--sample=2',
      ],
      { cwd: repoRoot, stdio: 'pipe' },
    );

    const reportPath = path.join(outDir, 'replay_report.md');
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = fs.readFileSync(reportPath, 'utf8');
    expect(report).toContain('# Layer2 KB Replay Report (US)');
    expect(report).toContain('- processed: 2');
  });
});

