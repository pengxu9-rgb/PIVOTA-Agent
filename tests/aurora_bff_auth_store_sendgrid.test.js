jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const ORIGINAL_ENV = process.env;

function loadAuthStore(envPatch = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    ...envPatch,
  };

  const axios = require('axios');
  const db = require('../src/db');
  axios.post.mockReset();
  db.query.mockReset();

  const authStore = require('../src/auroraBff/authStore');
  return {
    axios,
    db,
    authStore,
    sendOtpEmail: authStore.__test__.sendOtpEmail,
  };
}

describe('aurora authStore sendOtpEmail', () => {
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('uses SendGrid when configured and sends the expected EN payload', async () => {
    const { axios, sendOtpEmail } = loadAuthStore({
      AURORA_BFF_AUTH_EMAIL_PROVIDER: 'sendgrid',
      SENDGRID_API_KEY: 'sg_test_key',
      AURORA_BFF_AUTH_EMAIL_FROM: 'Aurora <noreply@pivota.ai>',
    });
    axios.post.mockResolvedValueOnce({ status: 202, data: {} });

    const result = await sendOtpEmail({
      email: 'user@example.com',
      code: '123456',
      language: 'EN',
    });

    expect(result).toEqual({ ok: true, provider: 'sendgrid' });
    expect(axios.post).toHaveBeenCalledTimes(1);

    const [url, payload, config] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(config.headers.Authorization).toBe('Bearer sg_test_key');
    expect(payload.personalizations[0].to[0].email).toBe('user@example.com');
    expect(payload.from.email).toBe('noreply@pivota.ai');
    expect(payload.from.name).toBe('Aurora');
    expect(payload.content[0].type).toBe('text/plain');
    expect(payload.subject).toContain('sign-in code');
  });

  test('uses a CN subject when language is CN', async () => {
    const { axios, sendOtpEmail } = loadAuthStore({
      AURORA_BFF_AUTH_EMAIL_PROVIDER: 'sendgrid',
      SENDGRID_API_KEY: 'sg_test_key',
      AURORA_BFF_AUTH_EMAIL_FROM: 'Aurora <noreply@pivota.ai>',
    });
    axios.post.mockResolvedValueOnce({ status: 202, data: {} });

    await sendOtpEmail({
      email: 'user@example.com',
      code: '123456',
      language: 'CN',
    });

    const [, payload] = axios.post.mock.calls[0];
    expect(payload.subject).toContain('验证码');
  });

  test('auto-detects providers in sendgrid > resend > ses order', async () => {
    let loaded = loadAuthStore({
      SENDGRID_API_KEY: 'sg_test_key',
      RESEND_API_KEY: 're_test_key',
      AURORA_BFF_AUTH_EMAIL_FROM: 'Aurora <noreply@pivota.ai>',
    });
    loaded.axios.post.mockResolvedValueOnce({ status: 202, data: {} });
    let result = await loaded.sendOtpEmail({
      email: 'user@example.com',
      code: '123456',
      language: 'EN',
    });
    expect(result.provider).toBe('sendgrid');
    expect(loaded.axios.post.mock.calls[0][0]).toBe('https://api.sendgrid.com/v3/mail/send');

    loaded = loadAuthStore({
      RESEND_API_KEY: 're_test_key',
      AURORA_BFF_AUTH_EMAIL_FROM: 'Aurora <noreply@pivota.ai>',
    });
    loaded.axios.post.mockResolvedValueOnce({ status: 200, data: {} });
    result = await loaded.sendOtpEmail({
      email: 'user@example.com',
      code: '123456',
      language: 'EN',
    });
    expect(result.provider).toBe('resend');
    expect(loaded.axios.post.mock.calls[0][0]).toBe('https://api.resend.com/emails');

    loaded = loadAuthStore({
      AURORA_BFF_AUTH_EMAIL_FROM: 'Aurora <noreply@pivota.ai>',
    });
    result = await loaded.sendOtpEmail({
      email: 'user@example.com',
      code: '123456',
      language: 'EN',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'email_not_configured',
      provider: 'ses',
    });
  });

  test('returns sendgrid email_send_failed when axios.post throws', async () => {
    const { axios, sendOtpEmail } = loadAuthStore({
      AURORA_BFF_AUTH_EMAIL_PROVIDER: 'sendgrid',
      SENDGRID_API_KEY: 'sg_test_key',
      AURORA_BFF_AUTH_EMAIL_FROM: 'Aurora <noreply@pivota.ai>',
    });
    axios.post.mockRejectedValueOnce(new Error('sendgrid down'));

    const result = await sendOtpEmail({
      email: 'user@example.com',
      code: '123456',
      language: 'EN',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'email_send_failed',
      provider: 'sendgrid',
    });
  });

  test('returns sendgrid email_not_configured when the API key is missing', async () => {
    const { axios, sendOtpEmail } = loadAuthStore({
      AURORA_BFF_AUTH_EMAIL_PROVIDER: 'sendgrid',
      AURORA_BFF_AUTH_EMAIL_FROM: 'Aurora <noreply@pivota.ai>',
      SENDGRID_API_KEY: '',
    });

    const result = await sendOtpEmail({
      email: 'user@example.com',
      code: '123456',
      language: 'EN',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'email_not_configured',
      provider: 'sendgrid',
    });
    expect(axios.post).not.toHaveBeenCalled();
  });
});
