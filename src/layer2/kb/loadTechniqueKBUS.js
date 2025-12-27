const { loadTechniqueKB } = require('./loadTechniqueKB');

function loadTechniqueKBUS() {
  return loadTechniqueKB('US');
}

module.exports = {
  loadTechniqueKBUS,
};
