/**
 * Credential source selection for the Vertex transport seam.
 *
 * The live token mint needs GCP, but which credential SOURCE the seam hands to
 * `new GoogleGenAI(...)` is the part that took Gemini audit probes down on
 * 2026-07-21, and it is checkable here.
 */

const ENV_KEYS = [
  'VERTEX_AI_ENABLED',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
];

function loadSeam(env) {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  jest.resetModules();
  return require('../src/llm/vertexGemini');
}

describe('vertexGemini credential source', () => {
  const saved = {};

  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('flag off passes the API key through untouched', () => {
    const seam = loadSeam({ VERTEX_AI_ENABLED: 'false' });
    expect(seam.geminiClientOptions('ak-test')).toEqual({ apiKey: 'ak-test' });
  });

  test('inline credential JSON is handed to the SDK as key material', () => {
    // google-auth-library's ADC resolution reads GOOGLE_APPLICATION_CREDENTIALS
    // as a FILE PATH, which is unusable on a host that can only supply env
    // vars — so the JSON has to travel via googleAuthOptions instead.
    const info = { type: 'service_account', project_id: 'proj-from-key' };
    const seam = loadSeam({
      VERTEX_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'proj-from-key',
      GOOGLE_CLOUD_LOCATION: 'global',
      GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify(info),
    });

    const options = seam.geminiClientOptions('ak-ignored');
    expect(options.vertexai).toBe(true);
    expect(options.project).toBe('proj-from-key');
    expect(options.location).toBe('global');
    expect(options.googleAuthOptions).toEqual({ credentials: info });
    // The Vertex endpoint has no API-key auth; leaking one through would
    // silently re-target billing at the AI Studio key.
    expect(options.apiKey).toBeUndefined();
  });

  test('no inline JSON still yields plain ADC options', () => {
    // On GCE/Cloud Run the metadata server is a legitimate credential source,
    // so absence of the env var must not be treated as misconfiguration.
    const seam = loadSeam({
      VERTEX_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'proj-metadata',
      GOOGLE_APPLICATION_CREDENTIALS_JSON: undefined,
    });

    const options = seam.geminiClientOptions('ak-ignored');
    expect(options.vertexai).toBe(true);
    expect(options.googleAuthOptions).toBeUndefined();
  });

  test('unparseable JSON throws a named error rather than degrading silently', () => {
    const seam = loadSeam({
      VERTEX_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'proj-broken',
      GOOGLE_APPLICATION_CREDENTIALS_JSON: '{not json',
    });

    expect(() => seam.geminiClientOptions('ak-ignored')).toThrow(
      /GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON/
    );
  });
});
