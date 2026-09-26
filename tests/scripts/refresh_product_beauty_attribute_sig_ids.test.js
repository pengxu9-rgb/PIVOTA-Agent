const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONFIRM_TOKEN,
  parseArgs,
  readAffectedManifest,
  run,
} = require('../../scripts/refresh-product-beauty-attribute-sig-ids');

describe('refresh-product-beauty-attribute-sig-ids', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('reads affected product manifests', () => {
    const file = path.join(os.tmpdir(), `affected-pba-${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        external_product_ids: ['ext_a'],
        sig_ids: ['sig_a'],
        rows: [
          {
            external_product_id: 'ext_b',
            pivota_signature_id: 'sig_b',
          },
        ],
      }),
      'utf8',
    );

    expect(readAffectedManifest(file)).toEqual({
      externalProductIds: ['ext_a', 'ext_b'],
      sigIds: ['sig_a', 'sig_b'],
    });
  });

  test('parseArgs is dry-run by default and protects apply mode', () => {
    expect(parseArgs(['--external-product-ids', 'ext_a,ext_b'])).toMatchObject({
      apply: false,
      externalProductIds: ['ext_a', 'ext_b'],
    });

    expect(() => parseArgs(['--external-product-ids', 'ext_a', '--apply'])).toThrow(/Refusing PBA sig refresh/);

    expect(
      parseArgs(['--external-product-ids', 'ext_a', '--apply', '--confirm', CONFIRM_TOKEN]),
    ).toMatchObject({
      apply: true,
      externalProductIds: ['ext_a'],
    });
  });

  test('run delegates to refresh helper inputs and writes report', async () => {
    const out = path.join(os.tmpdir(), `pba-refresh-${Date.now()}.json`);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          product_key: 'ext_a',
          old_sig_id: null,
          new_sig_id: 'sig_a',
        },
      ],
    }));

    const report = await run(['--external-product-ids', 'ext_a', '--sig-ids', 'sig_a', '--out', out], { queryFn });

    expect(report).toMatchObject({
      dry_run: true,
      external_product_id_filter_count: 1,
      sig_id_filter_count: 1,
      matched_count: 1,
    });
    expect(fs.existsSync(out)).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  // The 2026-08-16T10:37Z production tick: the affected-products selector
  // honestly returned zero rows, and the routine died at its first step.
  describe('an affected-products manifest with no ids', () => {
    let manifest;
    beforeEach(() => {
      manifest = path.join(os.tmpdir(), `affected-pba-empty-${Date.now()}.json`);
      fs.writeFileSync(manifest, JSON.stringify({ rows: [], external_product_ids: [], sig_ids: [] }), 'utf8');
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    test('still refuses by default (a filterless refresh would be catalog-wide)', async () => {
      const queryFn = jest.fn(async () => ({ rows: [] }));

      await expect(run(['--affected-products-file', manifest], { queryFn })).rejects.toMatchObject({
        code: 'MISSING_PBA_SIG_REFRESH_FILTER',
      });
      expect(queryFn).not.toHaveBeenCalled();
    });

    test('--allow-empty-filter records a no-op report and never queries', async () => {
      const out = path.join(os.tmpdir(), `pba-refresh-empty-${Date.now()}.json`);
      const queryFn = jest.fn(async () => ({ rows: [] }));

      const report = await run(
        ['--affected-products-file', manifest, '--allow-empty-filter', '--out', out],
        { queryFn },
      );

      expect(report).toMatchObject({
        dry_run: true,
        skipped: true,
        skip_reason: 'empty_filter',
        external_product_id_filter_count: 0,
        sig_id_filter_count: 0,
        matched_count: 0,
        updated_count: 0,
        rows: [],
      });
      expect(queryFn).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({ skipped: true, skip_reason: 'empty_filter' });
    });

    test('--allow-empty-filter does not swallow other failures', async () => {
      const queryFn = jest.fn(async () => {
        throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      });

      await expect(
        run(['--external-product-ids', 'ext_a', '--allow-empty-filter'], { queryFn }),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });

    test('--allow-empty-filter changes nothing when the manifest has ids', async () => {
      const queryFn = jest.fn(async () => ({ rows: [] }));

      const report = await run(['--external-product-ids', 'ext_a', '--allow-empty-filter'], { queryFn });

      expect(report.skipped).toBeUndefined();
      expect(queryFn).toHaveBeenCalledTimes(1);
    });
  });
});
