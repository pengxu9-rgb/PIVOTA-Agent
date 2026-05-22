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

function getNotifier() {
  const provider = cleanEnv(process.env.SERVICES_BOOKING_KAKAO_PROVIDER).toLowerCase();
  const providerConfig = PROVIDERS[provider];

  if (!provider || !providerConfig || !getProviderApiKey(providerConfig)) {
    return buildManualOpsNotifier();
  }

  const adapter = require(providerConfig.modulePath);
  if (typeof adapter.buildNotifier === 'function') {
    return adapter.buildNotifier({ apiKey: getProviderApiKey(providerConfig), channel: providerConfig.channel });
  }
  return adapter;
}

module.exports = {
  NotifierPermanentError,
  NotifierTransientError,
  buildManualOpsNotifier,
  getNotifier,
};
