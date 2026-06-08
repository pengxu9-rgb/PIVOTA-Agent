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
});
