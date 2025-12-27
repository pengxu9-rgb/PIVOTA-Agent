const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(relPath) {
  const full = path.join(__dirname, '..', '..', relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

describe('Contract manifest (US)', () => {
  test('manifest lists existing files with matching sha256', () => {
    const manifest = readJson('contracts/us/manifest.json');

    expect(typeof manifest).toBe('object');
    expect(typeof manifest.generatedAt).toBe('string');
    expect(typeof manifest.refHint).toBe('string');
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files.length).toBeGreaterThan(0);

    for (const entry of manifest.files) {
      expect(typeof entry.path).toBe('string');
      expect(typeof entry.sha256).toBe('string');
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);

      const fullPath = path.join(__dirname, '..', '..', entry.path);
      expect(fs.existsSync(fullPath)).toBe(true);

      const bytes = fs.readFileSync(fullPath);
      expect(sha256Hex(bytes)).toBe(entry.sha256);
    }
  });
});
