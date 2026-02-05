const { extractJsonObject, extractJsonObjectByKeys } = require('../src/auroraBff/jsonExtract');

test('extractJsonObjectByKeys: picks the JSON object with required keys (ignores earlier profile echo)', () => {
  const text =
    'profile={"skinType":"oily","sensitivity":"low"}\n' +
    'meta={"lang":"EN"}\n\n' +
    '{"assessment":{"verdict":"Suitable"},"evidence":{"science":{"key_ingredients":["Niacinamide"]},"social_signals":{},"expert_notes":[]},"confidence":0.8,"missing_info":[]}\n';

  const first = extractJsonObject(text);
  expect(Boolean(first && first.skinType)).toBe(true);

  const picked = extractJsonObjectByKeys(text, ['assessment', 'evidence']);
  expect(Boolean(picked && picked.assessment && picked.evidence)).toBe(true);
  expect(picked.assessment.verdict).toBe('Suitable');
});

test('extractJsonObjectByKeys: returns null when no object matches keys', () => {
  const text = 'hello {"a":1} world {"b":2}';
  expect(extractJsonObjectByKeys(text, ['assessment'])).toBe(null);
});
