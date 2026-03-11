'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

describe('dupeKbStore purgeDupeKbEntriesByContractVersion', () => {
  let tempDir;
  let kbPath;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-kb-store-'));
    kbPath = path.join(tempDir, 'dupe_kb.jsonl');
    process.env.AURORA_DUPE_KB_PATH = kbPath;
  });

  afterEach(() => {
    delete process.env.AURORA_DUPE_KB_PATH;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  });

  test('purges old-contract and malformed entries from db, mem cache, and file fallback', async () => {
    const { query } = require('../src/db');
    query.mockReset();
    const {
      getDupeKbEntry,
      purgeDupeKbEntriesByContractVersion,
      __resetDupeKbStateForTest,
    } = require('../src/auroraBff/dupeKbStore');
    __resetDupeKbStateForTest();

    const oldEntry = {
      kb_key: 'text:ordinary-old',
      original: { brand: 'The Ordinary', name: 'Niacinamide 10% + Zinc 1%' },
      dupes: [],
      comparables: [],
      verified: true,
      source_meta: { contract_version: 'dupe_suggest_v5' },
    };
    const malformedEntry = {
      kb_key: 'text:ordinary-malformed',
      original: { brand: 'The Ordinary', name: 'Niacinamide 10% + Zinc 1%' },
      dupes: [],
      comparables: [],
      verified: true,
      source_meta: null,
    };
    const currentEntry = {
      kb_key: 'text:ordinary-current',
      original: { brand: 'Good Molecules', name: 'Niacinamide Serum' },
      dupes: [],
      comparables: [],
      verified: true,
      source_meta: { contract_version: 'dupe_suggest_v9' },
    };

    fs.writeFileSync(
      kbPath,
      `${JSON.stringify(oldEntry)}\n${JSON.stringify(malformedEntry)}\n${JSON.stringify(currentEntry)}\n`,
      'utf8',
    );

    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });

    await getDupeKbEntry('text:ordinary-old');
    await getDupeKbEntry('text:ordinary-current');

    const result = await purgeDupeKbEntriesByContractVersion('dupe_suggest_v9');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM aurora_dupe_kb'),
      ['dupe_suggest_v9'],
    );
    expect(result).toEqual({
      db_deleted: 2,
      mem_deleted: 1,
      file_deleted: 2,
    });

    const persistedLines = fs.readFileSync(kbPath, 'utf8').trim().split(/\r?\n/);
    expect(persistedLines).toHaveLength(1);
    expect(JSON.parse(persistedLines[0]).kb_key).toBe('text:ordinary-current');

    await expect(getDupeKbEntry('text:ordinary-old')).resolves.toBeNull();
    await expect(getDupeKbEntry('text:ordinary-malformed')).resolves.toBeNull();
    await expect(getDupeKbEntry('text:ordinary-current')).resolves.toEqual(expect.objectContaining({
      kb_key: 'text:ordinary-current',
    }));
  });
});
