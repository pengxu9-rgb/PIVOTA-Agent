const { NotifierPermanentError } = require('../notifier');

// Stub: routing-only scaffolding. Real KR-side API integration is a
// separate work item once we have business reg / reseller credentials.
// `isStub: true` is read by notifier.js getNotifier(): if set, the
// dispatcher falls back to the manual-ops adapter rather than calling
// send() and getting a per-booking NotifierPermanentError that marks
// every pending booking permanently failed.
function buildNotifier() {
  return {
    channel: 'kakao_alimtalk_aligo',
    isStub: true,
    async send() {
      throw new NotifierPermanentError('UNCONFIGURED');
    },
  };
}

module.exports = {
  buildNotifier,
};
