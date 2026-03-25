function normalizeCatalogSurface(surface = {}) {
  return {
    ...(surface && typeof surface === 'object' ? surface : {}),
  };
}

module.exports = {
  normalizeCatalogSurface,
};
