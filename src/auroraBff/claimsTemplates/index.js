const en = require('./templates.en');
const zh = require('./templates.zh');
const validate = require('./validate');
const render = require('./render');

module.exports = {
  ...en,
  ...zh,
  ...validate,
  ...render,
};
