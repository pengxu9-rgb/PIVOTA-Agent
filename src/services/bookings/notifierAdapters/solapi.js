const { NotifierPermanentError } = require('../notifier');

function buildNotifier() {
  return {
    channel: 'kakao_alimtalk_solapi',
    async send() {
      throw new NotifierPermanentError('UNCONFIGURED');
    },
  };
}

module.exports = {
  buildNotifier,
};
