const logger = require('../../logger');

const PROVIDERS = Object.freeze({
  aligo: {
    channel: 'kakao_alimtalk_aligo',
    modulePath: './notifierAdapters/aligo',
    apiKeyEnv: 'SERVICES_BOOKING_ALIGO_API_KEY',
  },
  solapi: {
    channel: 'kakao_alimtalk_solapi',
    modulePath: './notifierAdapters/solapi',
    apiKeyEnv: 'SERVICES_BOOKING_SOLAPI_API_KEY',
  },
  naver_cloud_sens: {
    channel: 'kakao_alimtalk_sens',
    modulePath: './notifierAdapters/sens',
    apiKeyEnv: 'SERVICES_BOOKING_SENS_API_KEY',
  },
});

class NotifierTransientError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'NotifierTransientError';
    this.code = code || 'TRANSIENT_ERROR';
  }
}

class NotifierPermanentError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'NotifierPermanentError';
    this.code = code || 'PERMANENT_ERROR';
  }
}

function cleanEnv(value) {
  return String(value || '').trim();
}

function getProviderApiKey(providerConfig) {
  return cleanEnv(process.env.SERVICES_BOOKING_KAKAO_API_KEY || process.env[providerConfig.apiKeyEnv]);
}

function buildManualOpsNotifier() {
  return {
    channel: 'manual_ops',
    async send(payload) {
      logger.info(
        {
          booking_id: payload?.booking_id || null,
          provider_id: payload?.provider?.provider_id || null,
          provider_display_name: payload?.provider?.display_name || null,
          provider_phone: payload?.provider?.phone || null,
          provider_kakao_id: payload?.provider?.kakao_id || null,
          provider_email: payload?.provider?.email || null,
          listing_title: payload?.listing?.title || null,
          requested_slot: payload?.requested_slot || null,
          alternate_slots: payload?.alternate_slots || [],
          contact_email: payload?.contact_email || null,
          contact_phone: payload?.contact_phone || null,
        },
        'Service booking queued for manual KakaoTalk provider notification',
      );
      return { ok: true, vendor_message_id: null, channel: 'manual_ops' };
    },
  };
}

// Module-level guard so the "stub-detected, falling back to manual-ops"
// warning is emitted at most once per process — getNotifier() is called
// per booking sweep and the warning would otherwise spam logs.
let _stubFallbackWarned = false;

function getNotifier() {
  const provider = cleanEnv(process.env.SERVICES_BOOKING_KAKAO_PROVIDER).toLowerCase();
  const providerConfig = PROVIDERS[provider];

  if (!provider || !providerConfig || !getProviderApiKey(providerConfig)) {
    return buildManualOpsNotifier();
  }

  const adapter = require(providerConfig.modulePath);
  const candidate = typeof adapter.buildNotifier === 'function'
    ? adapter.buildNotifier({ apiKey: getProviderApiKey(providerConfig), channel: providerConfig.channel })
    : adapter;

  // Stub guard: if SERVICES_BOOKING_KAKAO_PROVIDER and the API key are both
  // set but the selected adapter is still a stub (isStub: true), don't route
  // real bookings through it — the stub throws NotifierPermanentError and
  // would mark every pending booking permanently failed. Fall back to
  // manual_ops so ops staff can handle delivery while the real adapter ships.
  if (candidate && candidate.isStub === true) {
    if (!_stubFallbackWarned) {
      logger.warn(
        { configured_provider: provider, channel: providerConfig.channel },
        'SERVICES_BOOKING_KAKAO_PROVIDER selects an unimplemented stub adapter; '
          + 'falling back to manual_ops. Implement the real adapter or unset the env var.',
      );
      _stubFallbackWarned = true;
    }
    return buildManualOpsNotifier();
  }

  return candidate;
}

// Test-only — lets the test suite reset the stub-fallback warning latch.
function _resetStubFallbackWarning() {
  _stubFallbackWarned = false;
}

module.exports = {
  NotifierPermanentError,
  NotifierTransientError,
  buildManualOpsNotifier,
  getNotifier,
  __test: { _resetStubFallbackWarning },
};
