const types = require('./types');
const claimGuard = require('./claimGuard');
const merge = require('./merge');
const resolve = require('./resolve');

module.exports = {
  ...types,
  ...claimGuard,
  ...merge,
  ...resolve,
};
