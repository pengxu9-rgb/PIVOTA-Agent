/**
 * Credential resolution for the Vertex transport seam.
 *
 * The live token mint needs GCP, but which credential SOURCE the seam accepts —
 * and what it reports when one is present but unusable — is the part that took
 * Gemini audit probes down on 2026-07-21, and it is checkable here.
 */

const ENV_KEYS = [
  'VERTEX_AI_ENABLED',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'K_SERVICE',
  'GAE_SERVICE',
  'GCE_METADATA_HOST',
];

const VALID_SA = {
  type: 'service_account',
  project_id: 'proj-from-key',
  client_email: 'sa@proj-from-key.iam.gserviceaccount.com',
};

function loadSeam(env) {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  jest.resetModules();
  const seam = require('../src/llm/vertexGemini');
  seam.resetCredentialsCache();
  return seam;
}

describe('vertexGemini credential source', () => {
  const saved = {};
  let errSpy;

  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });

  beforeEach(() => {
    // The seam logs an unusable credential once; keep it out of test output
    // while still allowing assertions on it.
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => errSpy.mockRestore());

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('flag off passes the API key through untouched', () => {
    const seam = loadSeam({ VERTEX_AI_ENABLED: 'false' });
    expect(seam.geminiClientOptions('ak-test')).toEqual({ apiKey: 'ak-test' });
    expect(seam.credentialsAvailable('ak-test')).toBe(true);
    expect(seam.credentialsAvailable('')).toBe(false);
  });

  test('inline credential JSON is handed to the SDK as key material', () => {
    // google-auth-library's ADC resolution reads GOOGLE_APPLICATION_CREDENTIALS
    // as a FILE PATH, which is unusable on a host that can only supply env
    // vars — so the JSON has to travel via googleAuthOptions instead. This is
    // the path audit probes construct through, and the one that was missing it.
    const seam = loadSeam({
      VERTEX_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'proj-from-key',
      GOOGLE_CLOUD_LOCATION: 'global',
      GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify(VALID_SA),
    });

    const options = seam.geminiClientOptions('ak-ignored');
    expect(options.vertexai).toBe(true);
    expect(options.project).toBe('proj-from-key');
    expect(options.location).toBe('global');
    expect(options.googleAuthOptions).toEqual({ credentials: VALID_SA });
    // The Vertex endpoint has no API-key auth; leaking one through would
    // silently re-target billing at the AI Studio key.
    expect(options.apiKey).toBeUndefined();
    expect(seam.credentialsAvailable('ak-ignored')).toBe(true);
  });

  describe('host pinning', () => {
    // @google/genai@0.7.0 derives `${location}-aiplatform.googleapis.com` with
    // no case for "global" — which is the configured location. Asserting on
    // our own options object would prove nothing about where the SDK actually
    // points, so these drive the real constructor and read the resolved URL.
    function resolvedBaseUrl(options) {
      const { GoogleGenAI } = require('@google/genai');
      const ai = new GoogleGenAI(options);
      const client = ai.apiClient || ai.api_client;
      return client.clientOptions.httpOptions.baseUrl;
    }

    test('location=global reaches the real Vertex host, not global-*', () => {
      const seam = loadSeam({
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'proj-from-key',
        GOOGLE_CLOUD_LOCATION: 'global',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify(VALID_SA),
      });
      const url = resolvedBaseUrl(seam.geminiClientOptions('ak-ignored'));
      expect(url).toBe('https://aiplatform.googleapis.com/');
      // The unpinned value: a host that answers 404 where the real one 401s.
      expect(url).not.toContain('global-aiplatform');
    });

    test('a regional location keeps its regional host', () => {
      const seam = loadSeam({
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'proj-from-key',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify(VALID_SA),
      });
      expect(resolvedBaseUrl(seam.geminiClientOptions('ak-ignored'))).toBe(
        'https://us-central1-aiplatform.googleapis.com/',
      );
    });

    test('pinning the host leaves apiVersion and auth mode intact', () => {
      const seam = loadSeam({
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'proj-from-key',
        GOOGLE_CLOUD_LOCATION: 'global',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify(VALID_SA),
      });
      const { GoogleGenAI } = require('@google/genai');
      const ai = new GoogleGenAI(seam.geminiClientOptions('ak-ignored'));
      const client = ai.apiClient || ai.api_client;
      expect(client.clientOptions.httpOptions.apiVersion).toBeTruthy();
      // Vertex has no API-key auth; a surviving key would re-target billing.
      expect(client.clientOptions.apiKey).toBeUndefined();
    });

    test('the SDK and REST transports agree on the host', () => {
      // They disagreed: REST special-cased global, the SDK did not.
      for (const location of ['global', 'us-central1', 'europe-west4']) {
        const seam = loadSeam({
          VERTEX_AI_ENABLED: 'true',
          GOOGLE_CLOUD_PROJECT: 'proj-from-key',
          GOOGLE_CLOUD_LOCATION: location,
          GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify(VALID_SA),
        });
        const sdkHost = resolvedBaseUrl(seam.geminiClientOptions('ak')).replace(/\/+$/, '');
        const restHost = new URL(
          seam.embedTarget({ model: 'text-embedding-004', texts: ['x'], apiKey: 'ak' }).url,
        ).origin;
        expect(sdkHost).toBe(restHost);
      }
    });
  });

  test('a service-account key without an explicit type is still accepted', () => {
    // GoogleAuth.fromJSON falls through to JWT.fromJSON, which validates only
    // client_email/private_key and never reads `type` — so this resolves today
    // and must not be narrowed away.
    const seam = loadSeam({
      VERTEX_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'proj-from-key',
      GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
        client_email: 'sa@proj-from-key.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
      }),
    });
    expect(seam.credentialsAvailable('ak-ignored')).toBe(true);
    expect(seam.geminiClientOptions('ak-ignored').googleAuthOptions).toBeTruthy();
  });

  test.each([
    'authorized_user',
    'external_account',
    'external_account_authorized_user',
    'impersonated_service_account',
  ])('%s credentials are accepted', (type) => {
    const seam = loadSeam({
      VERTEX_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'proj-from-key',
      GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({ type }),
    });
    expect(seam.credentialsAvailable('ak-ignored')).toBe(true);
  });

  test('a credential from another project warns about billing', () => {
    // Requests bill the configured project while quota is checked against the
    // credential's, so a mismatch spends from a project nobody is watching.
    const seam = loadSeam({
      VERTEX_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'proj-configured',
      GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
        ...VALID_SA,
        project_id: 'proj-somewhere-else',
      }),
    });
    seam.geminiClientOptions('ak-ignored');
    seam.geminiClientOptions('ak-ignored');
    expect(errSpy).toHaveBeenCalledTimes(1);
    const msg = String(errSpy.mock.calls[0][0]);
    expect(msg).toMatch(/proj-somewhere-else/);
    expect(msg).toMatch(/proj-configured/);
  });

  test('a matching credential project stays quiet', () => {
    const seam = loadSeam({
      VERTEX_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'proj-from-key',
      GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify(VALID_SA),
    });
    seam.geminiClientOptions('ak-ignored');
    expect(errSpy).not.toHaveBeenCalled();
  });

  test('no inline JSON still yields plain ADC options', () => {
    // On GCE/Cloud Run the metadata server is a legitimate credential source,
    // so absence of the env var must not be treated as misconfiguration.
    const seam = loadSeam({
      VERTEX_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'proj-metadata',
      K_SERVICE: 'some-cloud-run-service',
    });

    const options = seam.geminiClientOptions('ak-ignored');
    expect(options.vertexai).toBe(true);
    expect(options.googleAuthOptions).toBeUndefined();
    expect(seam.credentialsAvailable('ak-ignored')).toBe(true);
  });

  describe('a credential that is present but unusable', () => {
    // Each of these parses or reads as "configured" to a naive check, and each
    // resolves to no usable key material. Presence was the old test, and it is
    // exactly what waved callers through into the outage.
    const cases = [
      ['unparseable', '{not json', /is not valid JSON/],
      ['JSON null', 'null', /is not a JSON object/],
      ['JSON number', '42', /is not a JSON object/],
      ['JSON array', '[{"type":"service_account"}]', /is not a JSON object/],
      ['double-encoded string', JSON.stringify(JSON.stringify(VALID_SA)), /is not a JSON object/],
      ['object without type', JSON.stringify({ project_id: 'p' }), /not a credential object/],
      ['object with blank type', JSON.stringify({ type: '   ' }), /not a credential object/],
    ];

    test.each(cases)('%s: guard reports unavailable', (_label, raw) => {
      const seam = loadSeam({
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'proj-broken',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: raw,
      });
      // The whole point: callers gate on this and degrade cleanly, instead of
      // constructing a client that is guaranteed to fail at the transport.
      expect(seam.credentialsAvailable('ak-ignored')).toBe(false);
    });

    test.each(cases)('%s: construction throws a named error', (_label, raw, pattern) => {
      const seam = loadSeam({
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'proj-broken',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: raw,
      });
      expect(() => seam.geminiClientOptions('ak-ignored')).toThrow(pattern);
    });

    test.each(cases)('%s: never falls through to bare ADC', (_label, raw) => {
      // Omitting googleAuthOptions would let google-auth-library resolve bare
      // ADC, find nothing, and reproduce the outage silently. Throwing is what
      // keeps that from happening — a returned options object here would mean
      // the credential was quietly dropped.
      const seam = loadSeam({
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'proj-broken',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: raw,
      });
      let returned = null;
      try {
        returned = seam.geminiClientOptions('ak-ignored');
      } catch {
        /* expected */
      }
      expect(returned).toBeNull();
    });

    test('the reason is logged once, since most callers discard it', () => {
      // Four of the seven construction sites catch without logging, so the
      // named error would otherwise never reach an operator.
      const seam = loadSeam({
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'proj-broken',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: '{not json',
      });
      seam.credentialsAvailable('ak-ignored');
      seam.credentialsAvailable('ak-ignored');
      try {
        seam.geminiClientOptions('ak-ignored');
      } catch {
        /* expected */
      }
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0][0])).toMatch(/vertexGemini/);
    });

    test('missingCredentialMessage names the real problem', () => {
      // "Set GOOGLE_APPLICATION_CREDENTIALS_JSON" is actively misleading when
      // it IS set and merely unusable.
      const seam = loadSeam({
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'proj-broken',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: '{not json',
      });
      expect(seam.missingCredentialMessage()).toMatch(/is not valid JSON/);
    });

    test('does not vouch for other credential sources', () => {
      // A value that is set but broken looks configured to whoever reads the
      // env; it must not make credentialSourceConfigured() answer true.
      const seam = loadSeam({
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'proj-broken',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: 'null',
        K_SERVICE: 'some-cloud-run-service',
      });
      expect(seam.credentialSourceConfigured()).toBe(false);
    });

    test('token mint records the failure instead of escaping raw', async () => {
      // The parse used to sit outside accessToken()'s try, so a malformed
      // value threw a bare SyntaxError, left adcProbe null, and
      // credentialsAvailable() kept answering true for the life of the process.
      const seam = loadSeam({
        VERTEX_AI_ENABLED: 'true',
        GOOGLE_CLOUD_PROJECT: 'proj-broken',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: '{not json',
      });
      await expect(seam.accessToken()).rejects.toThrow(/is not valid JSON/);
      expect(seam.credentialsAvailable('ak-ignored')).toBe(false);
    });
  });
});
