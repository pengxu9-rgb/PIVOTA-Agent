'use strict';

// The value of this seam is that flag-OFF is byte-identical to what the call
// sites did before, and flag-ON produces well-formed Vertex targets. Both are
// checkable without credentials; the live Vertex round trip is not.

// Minting a token is the only step that needs real credentials; stub the
// library so the rest of the target-building path runs for real.
jest.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getAccessToken() {
      return 'tok-123';
    }
  },
}));

const vertexGemini = require('../../src/llm/vertexGemini');

const PROJECT = 'project-f165a637-145f-4de2-89d';

function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

const OFF = { VERTEX_AI_ENABLED: 'false', GOOGLE_CLOUD_PROJECT: PROJECT };
const ON = { VERTEX_AI_ENABLED: 'true', GOOGLE_CLOUD_PROJECT: PROJECT, GOOGLE_CLOUD_LOCATION: 'us-central1' };

describe('vertexGemini.restTarget — flag off (AI Studio)', () => {
  it('builds the v1beta generateContent URL and authenticates by header', async () => {
    const t = await withEnv(OFF, () => vertexGemini.restTarget({ model: 'gemini-2.5-flash', apiKey: 'ak-test' }));
    expect(t.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(t.headers['x-goog-api-key']).toBe('ak-test');
    expect(t.headers.authorization).toBeUndefined();
  });

  it('never puts the api key in the URL', async () => {
    const t = await withEnv(OFF, () => vertexGemini.restTarget({ model: 'gemini-2.5-flash', apiKey: 'ak-secret' }));
    expect(t.url).not.toContain('ak-secret');
    expect(t.url).not.toContain('key=');
  });

  it('honours a GEMINI_BASE_URL override and an explicit api version', async () => {
    const t = await withEnv(OFF, () =>
      vertexGemini.restTarget({ model: 'm', apiKey: 'k', baseUrl: 'https://proxy.example/', apiVersion: 'v1' }),
    );
    expect(t.url).toBe('https://proxy.example/v1/models/m:generateContent');
  });

  it('builds the SSE streaming URL', async () => {
    const t = await withEnv(OFF, () => vertexGemini.restTarget({ model: 'm', apiKey: 'k', stream: true }));
    expect(t.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse');
  });
});

describe('vertexGemini.restTarget — flag on (Vertex)', () => {
  it('builds a regional publisher URL on v1 and a bearer header', async () => {
    const t = await withEnv(ON, () => vertexGemini.restTarget({ model: 'gemini-2.5-flash', apiKey: 'ignored' }));
    expect(t.url).toBe(
      `https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJECT}` +
        '/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent',
    );
    expect(t.headers['x-goog-api-key']).toBeUndefined();
    expect(t.headers.authorization).toMatch(/^Bearer /);
  });

  it('drops the region prefix for the global endpoint', async () => {
    const t = await withEnv({ ...ON, GOOGLE_CLOUD_LOCATION: 'global' }, () =>
      vertexGemini.restTarget({ model: 'm', apiKey: 'x' }),
    );
    expect(t.url.startsWith('https://aiplatform.googleapis.com/v1/')).toBe(true);
    expect(t.url).toContain('/locations/global/');
  });

  it('ignores the AI Studio base-url override rather than producing a hybrid URL', async () => {
    const t = await withEnv(ON, () =>
      vertexGemini.restTarget({ model: 'm', apiKey: 'x', baseUrl: 'https://proxy.example' }),
    );
    expect(t.url).not.toContain('proxy.example');
  });
});

describe('vertexGemini.embedTarget', () => {
  it('flag off, single text: embedContent shape', () => {
    const t = withEnv(OFF, () => vertexGemini.embedTarget({ model: 'text-embedding-004', texts: ['a'], apiKey: 'k' }));
    expect(t.url).toContain(':embedContent');
    expect(t.body).toEqual({ content: { parts: [{ text: 'a' }] } });
    expect(t.parse({ embedding: { values: [1, 2] } })).toEqual([[1, 2]]);
  });

  it('flag off, many texts: batchEmbedContents shape', () => {
    const t = withEnv(OFF, () =>
      vertexGemini.embedTarget({ model: 'text-embedding-004', texts: ['a', 'b'], apiKey: 'k' }),
    );
    expect(t.url).toContain(':batchEmbedContents');
    expect(t.body.requests).toHaveLength(2);
    expect(t.parse({ embeddings: [{ values: [1] }, { values: [2] }] })).toEqual([[1], [2]]);
  });

  it('flag on: collapses both onto :predict with instances', () => {
    const t = withEnv(ON, () =>
      vertexGemini.embedTarget({ model: 'text-embedding-004', texts: ['a', 'b'], apiKey: 'k' }),
    );
    expect(t.url).toContain(':predict');
    expect(t.needsBearer).toBe(true);
    expect(t.body).toEqual({ instances: [{ content: 'a' }, { content: 'b' }] });
    expect(t.parse({ predictions: [{ embeddings: { values: [1] } }, { embeddings: { values: [2] } }] })).toEqual([
      [1],
      [2],
    ]);
  });
});

describe('vertexGemini OpenAI-compat surface', () => {
  it('flag off passes the fallback base url and leaves the model alone', () => {
    withEnv(OFF, () => {
      expect(vertexGemini.openAiCompatBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
        'https://generativelanguage.googleapis.com/v1beta/openai',
      );
      expect(vertexGemini.openAiCompatModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    });
  });

  it('flag on uses the openapi endpoint and namespaces the model', () => {
    withEnv(ON, () => {
      expect(vertexGemini.openAiCompatBaseUrl('ignored')).toBe(
        `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}` +
          '/locations/us-central1/endpoints/openapi',
      );
      expect(vertexGemini.openAiCompatModel('gemini-2.5-flash')).toBe('google/gemini-2.5-flash');
      expect(vertexGemini.openAiCompatModel('google/gemini-2.5-flash')).toBe('google/gemini-2.5-flash');
    });
  });
});

describe('vertexGemini.vertexModelName', () => {
  it('is a no-op when the flag is off', () => {
    withEnv(OFF, () => {
      expect(vertexGemini.vertexModelName('gemini-3.1-flash-image-preview')).toBe(
        'gemini-3.1-flash-image-preview',
      );
      expect(vertexGemini.vertexModelName('gemini-2.5-flash')).toBe('gemini-2.5-flash');
    });
  });

  // Probed live: every AI Studio "-image-preview" id 404s on Vertex in both
  // us-central1 and global; gemini-2.5-flash-image is the one that serves.
  it('maps AI Studio image-preview ids onto the Vertex image model', () => {
    withEnv(ON, () => {
      expect(vertexGemini.vertexModelName('gemini-3.1-flash-image-preview')).toBe(
        'gemini-2.5-flash-image',
      );
      expect(vertexGemini.vertexModelName('gemini-2.5-flash-image-preview')).toBe(
        'gemini-2.5-flash-image',
      );
      expect(vertexGemini.vertexModelName('imagen-3.0-generate-002')).toBe('gemini-2.5-flash-image');
    });
  });

  it('leaves non-image and already-Vertex ids alone', () => {
    withEnv(ON, () => {
      expect(vertexGemini.vertexModelName('gemini-2.5-flash')).toBe('gemini-2.5-flash');
      expect(vertexGemini.vertexModelName('gemini-3-flash-preview')).toBe('gemini-3-flash-preview');
      expect(vertexGemini.vertexModelName('gemini-2.5-flash-image')).toBe('gemini-2.5-flash-image');
    });
  });

  it('strips a models/ prefix and tolerates empty input', () => {
    withEnv(ON, () => {
      expect(vertexGemini.vertexModelName('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
      expect(vertexGemini.vertexModelName('')).toBe('');
    });
  });

  it('applies through restTarget so REST callers get the mapped id', async () => {
    const t = await withEnv(ON, () =>
      vertexGemini.restTarget({ model: 'gemini-3.1-flash-image-preview', apiKey: '' }),
    );
    expect(t.url).toContain('/models/gemini-2.5-flash-image:generateContent');
    expect(t.url).not.toContain('image-preview');
  });
});

describe('vertexGemini.missingCredentialMessage', () => {
  it('names the API key when the flag is off', () => {
    withEnv(OFF, () => expect(vertexGemini.missingCredentialMessage()).toMatch(/GEMINI_API_KEY/));
  });

  // Regression: under Vertex the old text pointed at GEMINI_API_KEY, a variable
  // the code deliberately ignores in that mode. It cost real debugging time.
  it('does NOT blame GEMINI_API_KEY when running on Vertex', () => {
    withEnv(ON, () => {
      const msg = vertexGemini.missingCredentialMessage();
      expect(msg).not.toMatch(/GEMINI_API_KEY/);
      expect(msg).toMatch(/GOOGLE_APPLICATION_CREDENTIALS_JSON/);
    });
  });

  it('calls out a missing project specifically', () => {
    withEnv({ ...ON, GOOGLE_CLOUD_PROJECT: '' }, () =>
      expect(vertexGemini.missingCredentialMessage()).toMatch(/GOOGLE_CLOUD_PROJECT/),
    );
  });
});

describe('vertexGemini.credentialsAvailable', () => {
  beforeEach(() => vertexGemini.resetCredentialsCache());

  it('flag off gates on the api key', () => {
    withEnv(OFF, () => {
      expect(vertexGemini.credentialsAvailable('k')).toBe(true);
      expect(vertexGemini.credentialsAvailable('')).toBe(false);
    });
  });

  it('flag on still requires a project', () => {
    withEnv({ ...ON, GOOGLE_CLOUD_PROJECT: '' }, () =>
      expect(vertexGemini.credentialsAvailable('k')).toBe(false),
    );
  });

  // Regression: staging had VERTEX_AI_ENABLED=true and a project set, but no
  // credential of any kind. This returned true, so callers sailed past their
  // guard and the token mint threw mid-request instead of degrading.
  it('fails closed when the flag is on but NO credential is configured', () => {
    withEnv({ ...ON, GOOGLE_APPLICATION_CREDENTIALS: '', GOOGLE_APPLICATION_CREDENTIALS_JSON: '' }, () =>
      expect(vertexGemini.credentialsAvailable('')).toBe(false),
    );
  });

  it('accepts inline key material via GOOGLE_APPLICATION_CREDENTIALS_JSON', () => {
    withEnv({ ...ON, GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}' }, () =>
      expect(vertexGemini.credentialsAvailable('')).toBe(true),
    );
  });

  it('accepts a credentials file path', () => {
    withEnv({ ...ON, GOOGLE_APPLICATION_CREDENTIALS: '/var/run/sa.json' }, () =>
      expect(vertexGemini.credentialsAvailable('')).toBe(true),
    );
  });

  it('trusts a metadata-server runtime marker', () => {
    withEnv({ ...ON, K_SERVICE: 'some-cloud-run-service' }, () =>
      expect(vertexGemini.credentialsAvailable('')).toBe(true),
    );
  });
});
