const { NotifierPermanentError } = require('../notifier');

// Stub: routing-only scaffolding. See aligo.js for the isStub contract.
function buildNotifier() {
  return {
    channel: 'kakao_alimtalk_sens',
    isStub: true,
    async send() {
      throw new NotifierPermanentError('UNCONFIGURED');
    },
  };
}

module.exports = {
  buildNotifier,
};
