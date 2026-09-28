const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  loadAuroraKbV0,
  clearAuroraKbV0Cache,
} = require('../src/auroraBff/kbV0/loader');

function sha256Text(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function writeKbDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-kb-v0-loader-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function makeManifest(filesMap) {
  const files = Object.entries(filesMap)
    .filter(([name]) => name !== 'kb_v0_manifest.json')
    .map(([filename, content]) => ({
      filename,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256Text(content),
    }));
  return JSON.stringify(
    {
      kb_version: 'test-kb-v0',
      generated_utc: new Date().toISOString(),
      files,
    },
    null,
    2,
  );
}

function baseKbFiles() {
  const conceptDictionary = JSON.stringify(
    {
      kb_version: 'v0-test',
      concepts: [
        {
          concept_id: 'RETINOID',
          labels: { en: 'Retinoid', zh: '维A类' },
          synonyms_en: ['retinoid'],
          synonyms_zh: ['维A'],
          inci_aliases: ['Retinol'],
          regex_hints: { en: ['\\bretinoid\\b'], zh: ['维A'] },
        },
        {
          concept_id: 'RETINOID',
          labels: { en: 'Retinoids', zh: '维A' },
          synonyms_en: ['retinol'],
          synonyms_zh: ['A醇'],
          inci_aliases: ['Retinal'],
          regex_hints: { en: ['\\bretinol\\b'], zh: ['A醇'] },
        },
      ],
    },
    null,
    2,
  );

  const ingredientOntology = JSON.stringify(
    {
      kb_version: 'v0-test',
      ingredients: [
        {
          ingredient_id: 'retinol',
          inci: 'Retinol',
          common_names: { en: ['retinol'], zh: ['A醇'] },
          classes: ['RETINOID', 'MISSING_CLASS'],
          attributes: ['active'],
          contraindication_tags: ['pregnancy_avoid'],
        },
      ],
    },
    null,
    2,
  );

  const safetyRules = JSON.stringify(
    {
      kb_version: 'v0-test',
      rules: [
        {
          rule_id: 'TEST_RULE',
          category: 'pregnancy',
          trigger: {
            concepts_any: ['RETINOID'],
            concepts_any_2: ['MISSING_CONCEPT_B'],
            required_context_missing: ['product_anchor'],
            life_stage: { pregnancy_status: ['pregnant'] },
          },
          decision: {
            block_level: 'WARN',
            required_fields: ['pregnancy_status'],
            blocked_concepts: ['MISSING_CONCEPT_A'],
            safe_alternatives_concepts: ['RETINOID'],
            template_id: 'tmpl_test',
          },
          rationale: 'test rationale',
        },
      ],
      templates: [{ template_id: 'tmpl_test', text_en: 'test template en', text_zh: 'test template zh' }],
    },
    null,
    2,
  );

  const interactionRules = JSON.stringify(
    {
      kb_version: 'v0-test',
      interactions: [
        {
          interaction_id: 'RETINOID_X_MISSING',
          concept_a: 'RETINOID',
          concept_b: 'MISSING_CONCEPT_C',
          risk_level: 'high',
          recommended_action: 'avoid_same_night',
          notes: 'test interaction',
        },
      ],
    },
    null,
    2,
  );

  const climateNormals = JSON.stringify(
    {
      kb_version: 'v0-test',
      regions: [
        {
          region_id: 'test_region',
          labels: { en: 'Test region', zh: '测试地区' },
          hemisphere: 'north',
          archetype: 'temperate_continental',
          month_profiles: [
            { month: 1, uv_level: 'low', humidity: 'dry', temp_swing: 'high', wind: 'medium', pollution: 'low' },
            { month: 4, uv_level: 'medium', humidity: 'balanced', temp_swing: 'medium', wind: 'low', pollution: 'medium' },
            { month: 7, uv_level: 'high', humidity: 'humid', temp_swing: 'low', wind: 'high', pollution: 'high' },
            { month: 10, uv_level: 'medium', humidity: 'balanced', temp_swing: 'medium', wind: 'medium', pollution: 'low' },
          ],
        },
      ],
    },
    null,
    2,
  );

  const files = {
    'concept_dictionary.v0.json': conceptDictionary,
    'ingredient_ontology.v0.json': ingredientOntology,
    'safety_rules.v0.json': safetyRules,
    'interaction_rules.v0.json': interactionRules,
    'climate_normals.v0.json': climateNormals,
  };
  files['kb_v0_manifest.json'] = makeManifest(files);
  return files;
}

function withEnvPatch(patch, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(patch || {})) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('kb v0 loader: manifest check + duplicate merge + synthetic concept fix', () => {
  clearAuroraKbV0Cache();
  const files = baseKbFiles();
  const kbDir = writeKbDir(files);
  const out = loadAuroraKbV0({ kbDir, forceReload: true });

  assert.equal(out.ok, true);
  assert.equal(out.manifest && out.manifest.ok, true);
  assert.ok(Array.isArray(out.diagnostics && out.diagnostics.duplicate_concept_ids));
  assert.ok(out.diagnostics.duplicate_concept_ids.includes('RETINOID'));

  const retinoid = out.concepts_by_id.RETINOID;
  assert.ok(retinoid);
  assert.ok(Array.isArray(retinoid.synonyms_en));
  assert.ok(retinoid.synonyms_en.includes('retinoid'));
  assert.ok(retinoid.synonyms_en.includes('retinol'));

  assert.ok(out.concepts_by_id.MISSING_CLASS);
  assert.equal(out.concepts_by_id.MISSING_CLASS.synthetic_missing_concept, true);
  assert.ok(out.concepts_by_id.MISSING_CONCEPT_A);
  assert.equal(out.concepts_by_id.MISSING_CONCEPT_A.synthetic_missing_concept, true);
  assert.ok(out.concepts_by_id.MISSING_CONCEPT_C);
  assert.equal(out.concepts_by_id.MISSING_CONCEPT_C.synthetic_missing_concept, true);
});

test('kb v0 loader: keeps serving with manifest errors', () => {
  clearAuroraKbV0Cache();
  const files = baseKbFiles();
  const kbDir = writeKbDir(files);

  const conceptPath = path.join(kbDir, 'concept_dictionary.v0.json');
  const brokenConcept = JSON.stringify(
    {
      kb_version: 'v0-test',
      concepts: [],
    },
    null,
    2,
  );
  fs.writeFileSync(conceptPath, brokenConcept, 'utf8');

  withEnvPatch({ AURORA_KB_FAIL_MODE: 'open' }, () => {
    const out = loadAuroraKbV0({ kbDir, forceReload: true });
    assert.equal(out.ok, true);
    assert.equal(out.fail_mode, 'open');
    assert.ok(Array.isArray(out.diagnostics && out.diagnostics.manifest_errors));
    assert.ok(out.diagnostics.manifest_errors.length > 0);
  });
});

test('kb v0 loader: fail mode closed throws for manifest errors', () => {
  clearAuroraKbV0Cache();
  const files = baseKbFiles();
  const kbDir = writeKbDir(files);

  const conceptPath = path.join(kbDir, 'concept_dictionary.v0.json');
  fs.writeFileSync(
    conceptPath,
    JSON.stringify({ kb_version: 'v0-test', concepts: [] }, null, 2),
    'utf8',
  );

  withEnvPatch({ AURORA_KB_FAIL_MODE: 'closed' }, () => {
    assert.throws(
      () => loadAuroraKbV0({ kbDir, forceReload: true }),
      /AURORA_KB_FAIL_MODE=closed|manifest validation failed/i,
    );
  });
});

test('kb v0 loader: fail mode closed throws for missing required file', () => {
  clearAuroraKbV0Cache();
  const files = baseKbFiles();
  delete files['interaction_rules.v0.json'];
  const kbDir = writeKbDir(files);

  withEnvPatch({ AURORA_KB_FAIL_MODE: 'closed' }, () => {
    assert.throws(
      () => loadAuroraKbV0({ kbDir, forceReload: true }),
      /missing required kb file|missing_file/i,
    );
  });
});

test('kb v0 loader: cache reuse and refresh by mtime/signature', async () => {
  clearAuroraKbV0Cache();
  const files = baseKbFiles();
  const kbDir = writeKbDir(files);

  const first = loadAuroraKbV0({ kbDir, forceReload: true });
  const second = loadAuroraKbV0({ kbDir });
  assert.equal(first, second);

  await new Promise((resolve) => setTimeout(resolve, 15));
  const conceptPath = path.join(kbDir, 'concept_dictionary.v0.json');
  const changedConcept = JSON.stringify(
    {
      kb_version: 'v0-test',
      concepts: [
        {
          concept_id: 'RETINOID',
          labels: { en: 'Retinoid', zh: '维A类' },
          synonyms_en: ['retinoid', 'retinoid_changed'],
          synonyms_zh: ['维A'],
          inci_aliases: ['Retinol'],
          regex_hints: { en: ['\\bretinoid\\b'], zh: ['维A'] },
        },
      ],
    },
    null,
    2,
  );
  fs.writeFileSync(conceptPath, changedConcept, 'utf8');

  const refreshed = loadAuroraKbV0({ kbDir });
  assert.notEqual(refreshed, first);
  assert.ok(refreshed.concepts_by_id.RETINOID.synonyms_en.includes('retinoid_changed'));
});

// The substring stage matches against whitespace-STRIPPED text, so before this was anchored a bare `includes`
// read across the gap between two words: "a damaged barrier" compacts to "adamagedbarrier", which contains
// ADAPALENE's real synonym "ADA". That made /v1/chat answer "what ingredient is best for a damaged barrier?"
// with a retinol lookup report. These run against the SHIPPED concept dictionary, not a fixture, because the
// defect is in how real 3-5 char synonyms (ADA, AHA, PIE, SLS, age, wax) meet real user sentences.
test('concept matcher: a single-word ASCII synonym never matches across a word gap or mid-word', () => {
  const { collectConceptIdsFromText } = require('../src/auroraBff/kbV0/conceptMatcher');
  const ids = (text) => collectConceptIdsFromText({ text, language: 'EN', max: 32, includeSubstring: true });

  // "a da|maged" — the junction only exists once the space is stripped.
  assert.equal(ids('a damaged barrier').includes('ADAPALENE'), false);
  assert.equal(ids('what ingredient is best for a damaged barrier?').includes('ADAPALENE'), false);
  assert.equal(ids('go ahead and use it twice a week').includes('ADAPALENE'), false);
  // "dam-age-d" — same class, mid-word rather than cross-word.
  assert.equal(ids('a damaged barrier').includes('AGE_BAND'), false);
  assert.equal(ids('a gentle cleanser please').includes('AGE_BAND'), false);

  // The concept the sentence actually names must survive.
  assert.equal(ids('a damaged barrier').includes('BARRIER_COMPROMISED'), true);
});

test('concept matcher: anchoring keeps the matches the substring stage exists for', () => {
  const { collectConceptIdsFromText } = require('../src/auroraBff/kbV0/conceptMatcher');
  const ids = (text) => collectConceptIdsFromText({ text, language: 'EN', max: 32, includeSubstring: true });

  // Standing on its own, the short synonym is still the concept.
  assert.equal(ids('is ADA safe?').includes('ADAPALENE'), true);
  assert.equal(ids('AHA and BHA together').includes('AHA'), true);
  // Glued to what FOLLOWS it: the boundary regex cannot see this, which is why the substring stage is here.
  assert.equal(ids('niacinamide5%').includes('NIACINAMIDE'), true);
  // Glued to what PRECEDES it: the boundary regex accepts a non-alphanumeric neighbour and claims these.
  assert.equal(ids('0.3%retinol').includes('RETINOL'), true);
  // A term that contains whitespace is what compaction is for, so it still matches the compacted text.
  assert.equal(ids('vitamincserum').includes('VITAMIN_C'), true);
});
