const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  collectSeedIdsFromValue,
  readSeedIdFile,
} = require('../../scripts/correct-external-product-seeds');

describe('correct-external-product-seeds helpers', () => {
  test('collects seed ids from audit payloads', () => {
    const payload = {
      summary: { flagged_rows: 2 },
      findings: [
        { seed_id: 'eps_one' },
        { seed_id: 'eps_two' },
      ],
    };

    expect(collectSeedIdsFromValue(payload)).toEqual(['eps_one', 'eps_two']);
  });

  test('reads seed ids from jsonl audit output', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-id-file-'));
    const filePath = path.join(tempDir, 'audit.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ seed_id: 'eps_alpha' }),
        JSON.stringify({ seed_id: 'eps_beta' }),
        JSON.stringify({ seed_id: 'eps_alpha' }),
      ].join('\n'),
      'utf8',
    );

    expect(readSeedIdFile(filePath)).toEqual(['eps_alpha', 'eps_beta']);
  });
});
