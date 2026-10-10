'use strict';

// THE STORED FOLD READ (PIVOTA-Agent #2404; pivota-backend #2549). With CANONICAL_CATALOG_STORED_NAME_NORM
// on, the canonical search reads catalog_products.own_name_norm / name_norm instead of folding the row's
// own name per row per query. The invariant pinned here: the statement built with the flag ON is the
// statement built with it OFF with exactly three substitutions -- the own-name expression read through
// `coalesce(p.own_name_norm, <expression>)`, the set-exclusion expression through
// `coalesce(p.name_norm, <expression>)`, and the carrier CTE's per-row fold replaced by `np.name_norm`
// -- and the SAME binds in the SAME order. Everything else (category predicate, rank, limits, the
// isCarrier / BitmapOr structure of #2314) is byte-identical. The two texts the fold is read from are
// equal by the backend's trigger, which is pinned there against this module's expression.

const { fetchCanonicalChainRows } = require('../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');
const quality = require('../src/services/canonicalSearchQualitySql');
const probe = require('../src/services/storedNameNormProbe');

const FLAG = quality.STORED_NAME_NORM_FLAG;
const ORIGINAL = process.env[FLAG];
afterEach(() => { if (ORIGINAL === undefined) delete process.env[FLAG]; else process.env[FLAG] = ORIGINAL; });
beforeEach(() => { process.env.SEARCH_NAME_EVIDENCE_ADMISSION = 'on'; probe._resetForTest(); });

async function statement(rawQuery, flag) {
  if (flag === undefined) delete process.env[FLAG]; else process.env[FLAG] = flag;
  const contract = buildSearchQualityContract({ rawQuery });
  let result = null;
  await fetchCanonicalChainRows({
    query: rawQuery, searchQualityContract: contract, brandFilter: contract.hard_constraints.brand,
    categoryPathPrefix: contract.hard_constraints.category_path_prefix, categoryMode: 'category_browse',
    deps: { query: async (sql, params) => {
      // The fold-drift probe (stored_name_norm_probe.test.js owns its own cases): here the database's
      // function matches identitySql, so the flag's verdict is the flag's.
      if (sql.includes(`${probe.FUNCTION_NAME}(s)`)) return { rows: [{ n: probe.SAMPLES.length, same: probe.SAMPLES.length }] };
      result = { sql, params }; return { rows: [] };
    } },
  });
  return result;
}

const OWN = quality.identitySql(quality.OWN_NAME_INPUTS_SQL);
const CARRIER = quality.identitySql(quality.CARRIER_NAME_INPUTS_SQL);
const NP_COLUMNS = "concat_ws(' ', np.title, np.product_type)";
const NP_RAW = `lower(translate(replace(replace(${NP_COLUMNS}, '·', ''), '•', ''), '${quality.IDENTITY_ACCENTED}', '${quality.IDENTITY_FOLDED}'))`;
const NP_FOLD = quality.identitySql(NP_COLUMNS);

// Both statements mapped onto one canonical text: the OFF side's per-row folds and the ON side's
// column reads both become the same markers. Equal canonical texts = the flag changed nothing else.
function canonical(sql) {
  return sql
    .split(`coalesce(p.own_name_norm, ${OWN})`).join('«OWN»').split(OWN).join('«OWN»')
    .split(`coalesce(p.name_norm, ${CARRIER})`).join('«CARRIER»').split(CARRIER).join('«CARRIER»')
    .split(NP_RAW).join('«NP»').split(NP_FOLD).join('«NP»')
    .split('np.name_norm').join('«NP»');
}

const SAMPLE = [
  'barrier moisturizer',          // category_browse (the slow one on prod)
  'beauty skincare serum',        // category_browse
  'niacinamide serum',
  'vitamin c serum',
  'lip gloss',
  'nail polish',
  'Stila Stay All Day lipstick',  // brand + anchor
  'Metal Serum Gloss',            // name-evidence admits
];

describe('CANONICAL_CATALOG_STORED_NAME_NORM: the flag, read per call', () => {
  test('on for 1/true/on/yes (any case, padded); off by default and for anything else', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' ON ', 'True']) expect(quality.storedNameNormEnabled({ [FLAG]: v })).toBe(true);
    for (const v of ['0', 'false', 'off', '', undefined, 'enabled', 'y']) expect(quality.storedNameNormEnabled({ [FLAG]: v })).toBe(false);
    expect(quality.storedNameNormEnabled({})).toBe(false);
  });
});

describe('the no-change invariant over the sample', () => {
  for (const q of SAMPLE) {
    test(`"${q}": ON differs from OFF only by where the fold is read from, with identical binds`, async () => {
      const off = await statement(q, undefined);
      const on = await statement(q, 'on');
      expect(off && on).toBeTruthy();
      // Byte-identical binds, same order: the predicates, patterns and limits are the same statement.
      expect(on.params).toEqual(off.params);
      // OFF never names the columns; ON reads them.
      expect(off.sql).not.toMatch(/own_name_norm|\bname_norm\b/);
      expect(on.sql).toContain(`coalesce(p.own_name_norm, ${OWN})`);
      expect(on.sql).not.toContain(`(${OWN} ~`); // no bare per-row own-name fold left on the ON side
      // And once both are mapped onto the same markers, nothing else differs.
      expect(canonical(on.sql)).toBe(canonical(off.sql));
    });
  }

  test('the carrier CTE on the ON side reads the stored column directly (an index condition), never a coalesce', async () => {
    const on = await statement('barrier moisturizer', 'on');
    const cte = on.sql.slice(on.sql.indexOf('name_evidence_carriers AS MATERIALIZED'), on.sql.indexOf('), matched_products') > 0 ? on.sql.indexOf('), matched_products') : on.sql.indexOf('candidate_products AS'));
    expect(cte).toMatch(/np\.name_norm LIKE \$\d+ AND np\.name_norm LIKE \$\d+ THEN np\.name_norm ~ \$\d+/);
    expect(cte).not.toMatch(/coalesce\((np|p)\./); // the keys aggregate's coalesce stays; no column fallback here
    expect(cte).not.toContain('translate(');
    // The admitted arm is still the primary-key index condition from #2314.
    expect(on.sql).toContain('p.product_key = ANY((SELECT keys FROM name_evidence_carriers)::text[])');
  });

  test('the multi-product set exclusion reads coalesce(p.name_norm, ...) on the ON side', async () => {
    const on = await statement('barrier moisturizer', 'on');
    expect(on.sql).toContain(`NOT (coalesce(p.name_norm, ${CARRIER}) ~ $`);
  });

  test('with the flag off the statement is byte-identical to the statement before the flag existed (no column, no coalesce)', async () => {
    for (const q of SAMPLE) {
      const off = await statement(q, undefined);
      expect(off.sql).not.toContain('coalesce(p.own_name_norm');
      expect(off.sql).not.toContain('coalesce(p.name_norm');
      expect(off.sql).not.toContain('name_norm');
      const explicitOff = await statement(q, 'off');
      expect(explicitOff.sql).toBe(off.sql);
      expect(explicitOff.params).toEqual(off.params);
    }
  });
});
